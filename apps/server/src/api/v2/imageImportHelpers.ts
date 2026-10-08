// 通用"用户手动导入外部生图"逻辑。给 character / scene / shot first-frame
// 共享同一个 import 入口,避免重复 base64→buffer→vault→asset 的拼装。
//
// 2026-05-14 (per PM B1): 解耦各 image-step 的"手动导入"功能,统一走这个 helper。

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { DATA_ROOT, ensureDir } from "../../../../../packages/core/src/index";
import { saveToVault } from "../../../../../packages/library/src/assetVault";
import { addAsset } from "./seriesStore";

export interface ImportImagePayload {
  image_base64: string;
  mime?: string;
  filename?: string;
}

export interface ImportImageResult {
  asset_id: string;
  vault_id: string;
  bytes: number;
  filename: string;
}

/** Decode a base64 image (with or without data: prefix). Throws on garbage. */
export function decodeBase64Image(input: string): Buffer {
  if (typeof input !== "string" || input.length < 32) {
    throw new Error("image_base64 缺失或太短");
  }
  const cleaned = input.replace(/^data:[^,]+,/, "");
  return Buffer.from(cleaned, "base64");
}

/** Best-effort mime detection (only used when caller didn't supply one). */
export function sniffMime(buf: Buffer, hintFilename = ""): string {
  const lower = hintFilename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (buf.length >= 8) {
    const head = buf.subarray(0, 8).toString("hex");
    if (head.startsWith("89504e47")) return "image/png";
    if (head.startsWith("ffd8ff")) return "image/jpeg";
    if (head.startsWith("47494638")) return "image/gif";
    if (head.startsWith("52494646")) return "image/webp";
  }
  return "image/png";
}

/**
 * Save an imported image into the vault + create an asset record for the
 * given series. Returns the new asset_id + vault_id.
 *
 * Per PM 2026-05-14: no mime/size validation — single-user local app, user
 * trusts the file they're importing.
 */
export async function importImageToSeries(args: {
  slug: string;
  payload: ImportImagePayload;
  context: Record<string, unknown>;
  tags: string[];
  providerId?: string;
}): Promise<ImportImageResult> {
  const buf = decodeBase64Image(args.payload.image_base64);
  const mime = args.payload.mime || sniffMime(buf, args.payload.filename ?? "");
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
  const filename = `imported_${Date.now()}_${crypto.randomUUID().slice(0, 6)}.${ext}`;

  // Vault
  const vaultEntry = await saveToVault({
    buffer: buf,
    kind: "image",
    mime,
    context: { kind: "user_upload", series_slug: args.slug, ...args.context },
    provider_id: args.providerId ?? "manual_import",
    width: 0,
    height: 0,
    tags: [...args.tags, "manual_import"],
  });

  // Asset record (so it shows up in candidate pool / asset list)
  const assetsDir = path.join(DATA_ROOT, "series", args.slug, "assets", "images");
  await ensureDir(assetsDir);
  await fs.writeFile(path.join(assetsDir, filename), buf);
  const asset = await addAsset(args.slug, {
    series_slug: args.slug,
    kind: "image",
    tags: [...args.tags, "manual_import"],
    path: `assets/images/${filename}`,
    filename,
    mime,
    size_bytes: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  });

  return {
    asset_id: asset.asset_id,
    vault_id: vaultEntry.vault_id,
    bytes: buf.length,
    filename,
  };
}
