import fs from "node:fs/promises";
import path from "node:path";
import { ulid } from "ulid";
import type {
  Asset, AssetFilter, AssetKind, AssetStats,
  AddAssetParams,
} from "./types.js";
import { sha256, sha256Prefix } from "./dedupe.js";
import { appendOp, loadIndex, writeSnapshot } from "./jsonlIndex.js";
import {
  thumbnailImage, thumbnailVideo, thumbnailAudioPlaceholder,
} from "./thumbnail.js";

const KIND_DIR: Record<AssetKind, string> = {
  image: "images",
  video: "videos",
  audio: "audio",
  doc: "docs",
};

const KIND_EXT_DEFAULTS: Record<AssetKind, string> = {
  image: ".png",
  video: ".mp4",
  audio: ".m4a",
  doc: ".pdf",
};

export class AssetStore {
  /** Absolute path: data/series/<slug>/assets */
  readonly assetsRoot: string;

  private _assetsById = new Map<string, Asset>();
  private _sha256ToId = new Map<string, string>();
  private _loaded = false;
  private _dedupHits = 0;
  private _dedupMisses = 0;

  constructor(seriesSlug: string, dataRoot?: string) {
    const root = dataRoot ?? path.resolve(process.cwd(), "data");
    this.assetsRoot = path.join(root, "series", seriesSlug, "assets");
  }

  // ── initialisation ──────────────────────────────────────────────────────

  private async _ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    await fs.mkdir(this.assetsRoot, { recursive: true });
    const { assetsById, sha256ToId } = await loadIndex(this.assetsRoot);
    this._assetsById = assetsById;
    this._sha256ToId = sha256ToId;
    this._loaded = true;
  }

  // ── core CRUD ───────────────────────────────────────────────────────────

  async add(params: AddAssetParams): Promise<Asset> {
    await this._ensureLoaded();

    const hash = sha256(params.buffer);
    const existingId = this._sha256ToId.get(hash);
    if (existingId) {
      const existing = this._assetsById.get(existingId);
      if (existing && !existing.deleted_at) {
        this._dedupHits++;
        return existing;
      }
    }
    this._dedupMisses++;

    const id = ulid();
    const ext = params.suggestedExt ?? KIND_EXT_DEFAULTS[params.kind];
    const fileName = `${sha256Prefix(hash)}_${id}${ext}`;
    const relDir = KIND_DIR[params.kind];
    const relPath = `${relDir}/${fileName}`;
    const absPath = path.join(this.assetsRoot, relPath);

    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, params.buffer);

    const asset: Asset = {
      id,
      kind: params.kind,
      mime: params.mime,
      ext,
      tags: [...params.tags],
      source: { ...params.source },
      meta: params.meta ? { ...params.meta } : undefined,
      file_path: relPath,
      sha256: hash,
      file_size_bytes: params.buffer.length,
      created_at: new Date().toISOString(),
      deleted_at: null,
    };

    this._assetsById.set(id, asset);
    this._sha256ToId.set(hash, id);

    const op = { op: "add" as const, at: asset.created_at, asset };
    await appendOp(path.join(this.assetsRoot, "index.jsonl"), op);

    return asset;
  }

  async get(id: string): Promise<Asset | null> {
    await this._ensureLoaded();
    const asset = this._assetsById.get(id);
    if (!asset || asset.deleted_at) return null;
    return asset;
  }

  async list(filter?: AssetFilter): Promise<Asset[]> {
    await this._ensureLoaded();
    let results = Array.from(this._assetsById.values()).filter((a) => !a.deleted_at);

    if (filter?.kind) {
      results = results.filter((a) => a.kind === filter.kind);
    }
    if (filter?.tags?.length) {
      const set = new Set(filter.tags);
      results = results.filter((a) => a.tags.some((t) => set.has(t)));
    }
    if (filter?.tags_all?.length) {
      results = results.filter((a) => filter.tags_all!.every((t) => a.tags.includes(t)));
    }
    if (filter?.provider_id) {
      results = results.filter((a) => a.source.provider_id === filter.provider_id);
    }
    if (filter?.generation_id) {
      results = results.filter((a) => a.source.generation_id === filter.generation_id);
    }
    if (filter?.since) {
      results = results.filter((a) => a.created_at >= filter.since!);
    }

    // Sort by created_at descending (newest first)
    results.sort((a, b) => b.created_at.localeCompare(a.created_at));

    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  async delete(id: string, opts?: { force?: boolean }): Promise<void> {
    await this._ensureLoaded();
    const asset = this._assetsById.get(id);
    if (!asset) throw new Error(`Asset not found: ${id}`);
    if (asset.deleted_at && !opts?.force) return; // already soft-deleted

    const now = new Date().toISOString();
    asset.deleted_at = now;
    this._assetsById.set(id, asset);

    const op = { op: "tombstone" as const, at: now, id };
    await appendOp(path.join(this.assetsRoot, "index.jsonl"), op);
  }

  async thumbnail(id: string, size: 64 | 256): Promise<string> {
    await this._ensureLoaded();
    const asset = this._assetsById.get(id);
    if (!asset || asset.deleted_at) throw new Error(`Asset not found: ${id}`);

    const srcPath = path.join(this.assetsRoot, asset.file_path);
    const thumbRoot = path.join(this.assetsRoot, "thumbnails");

    switch (asset.kind) {
      case "image":
        return thumbnailImage(srcPath, thumbRoot, size);
      case "video":
        return thumbnailVideo(srcPath, thumbRoot, size);
      case "audio":
        return thumbnailAudioPlaceholder(thumbRoot, size);
      case "doc":
        // Documents get the same placeholder as audio for now
        return thumbnailAudioPlaceholder(thumbRoot, size);
    }
  }

  async stats(): Promise<AssetStats> {
    await this._ensureLoaded();
    const active = Array.from(this._assetsById.values()).filter((a) => !a.deleted_at);
    const counts = { images: 0, videos: 0, audio: 0, docs: 0 };
    let bytes = 0;
    for (const a of active) {
      switch (a.kind) {
        case "image": counts.images++; break;
        case "video": counts.videos++; break;
        case "audio": counts.audio++; break;
        case "doc": counts.docs++; break;
      }
      bytes += a.file_size_bytes;
    }
    const total = this._dedupHits + this._dedupMisses;
    return {
      ...counts,
      bytes_total: bytes,
      dedup_hit_rate: total > 0 ? this._dedupHits / total : 0,
    };
  }

  // ── accessors for maintenance / tests ───────────────────────────────────

  get assetsById(): ReadonlyMap<string, Asset> { return this._assetsById; }
  get sha256ToId(): ReadonlyMap<string, string> { return this._sha256ToId; }
}
