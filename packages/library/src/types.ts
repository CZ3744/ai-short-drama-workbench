/**
 * Asset type definitions for the library package.
 *
 * NOTE: P11 (packages/drama) will canonicalise these types.
 * Until P11 ships we define them here; once P11 lands this file
 * should re-export from packages/drama instead.
 */

export type AssetKind = "image" | "video" | "audio" | "doc";

export interface AssetSource {
  type: "provider" | "upload" | "derived";
  provider_id?: string;
  generation_id?: string;
  scene_id?: string;
}

export interface AssetMeta {
  width?: number;
  height?: number;
  duration_sec?: number;
}

export interface Asset {
  id: string;                        // ULID
  kind: AssetKind;
  mime: string;
  ext: string;                       // e.g. ".png", ".mp4"
  tags: string[];                    // at least one ownership tag
  source: AssetSource;
  meta?: AssetMeta;
  file_path: string;                 // relative to series assets root
  sha256: string;                    // hex, 64 chars
  file_size_bytes: number;
  created_at: string;                // ISO 8601
  deleted_at?: string | null;        // tombstone marker
}

/** JSONL operation types */
export interface JsonlAddOp {
  op: "add";
  at: string;
  schema_version: number;
  asset: Asset;
}

export interface JsonlTombstoneOp {
  op: "tombstone";
  at: string;
  schema_version: number;
  id: string;
}

export interface JsonlRetagOp {
  op: "retag";
  at: string;
  schema_version: number;
  id: string;
  tags: string[];
}

export type JsonlOp = JsonlAddOp | JsonlTombstoneOp | JsonlRetagOp;

/** Full snapshot format for index.json */
export interface IndexSnapshot {
  schema_version: number;
  generated_at: string;
  assets: Record<string, Asset>;
  sha256_to_id: Record<string, string>;
}

/** Stats returned by AssetStore.stats() */
export interface AssetStats {
  images: number;
  videos: number;
  audio: number;
  docs: number;
  bytes_total: number;
  dedup_hit_rate: number;
}

/** Filter options for AssetStore.list() */
export interface AssetFilter {
  kind?: AssetKind;
  tags?: string[];         // match ANY
  tags_all?: string[];     // match ALL
  provider_id?: string;
  generation_id?: string;
  since?: string;          // ISO 8601
  limit?: number;
  offset?: number;
}

/** Add params for AssetStore.add() */
export interface AddAssetParams {
  buffer: Buffer;
  kind: AssetKind;
  mime: string;
  suggestedExt?: string;
  tags: string[];
  source: AssetSource;
  meta?: AssetMeta;
}
