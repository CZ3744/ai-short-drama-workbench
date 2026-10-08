/**
 * Adapter 共用 helper — 把"写文件 + saveToVault + addAsset"流程收敛.
 *
 * 几乎每个 adapter 都要做的事:
 *   1. 决定 series-relative asset 路径 + filename
 *   2. 写 buffer 到磁盘 (series/<slug>/assets/images/<filename>)
 *   3. saveToVault (sha-256 dedup, 写 vault 索引)
 *   4. addAsset (series 内 asset_index)
 *
 * 每个 adapter 拿到 { asset, vaultEntry } 后再自己更新业务对象(shot.generations,
 * element.images, character.ref_image_ids 等). adapter 本身 ≤ 50 行.
 */

import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { DATA_ROOT, ensureDir } from "../../../../../../../packages/core/src/index";
import { saveToVault, type VaultEntry } from "../../../../../../../packages/library/src/assetVault";
import { addAsset, type AssetEntry } from "../../../../repositories/assetRepo";
import type { GeneratedImage } from "../../../../../../../packages/providers/src/core/types";

export interface VaultContextInput {
  /** vault 内部 kind 枚举(VaultContext.kind) */
  kind:
    | "library_ref"
    | "shot_first_frame"
    | "shot_video"
    | "variant"
    | "inpaint"
    | "rough_cut"
    | "user_upload"
    | "last_frame_of"
    | "mood_board"
    | "character_ref"
    | "scene_ref";
  series_slug: string;
  character_id?: string;
  scene_id?: string;
  shot_id?: string;
  user_note?: string;
  imported_from?: string;
  parent_vault_id?: string;
}

export interface PersistImageInput {
  image: GeneratedImage;
  series_slug: string;
  /** 文件名前缀 (区分用途: "element" / "ref_${charId}" / "shot_${shotId}" 等) */
  filename_prefix: string;
  /** vault context (业务对象引用 + 来源标记) */
  vault_context: VaultContextInput;
  /** vault + asset 通用 tags */
  tags: string[];
  /** provider 信息 */
  provider_id: string;
  cost_cny?: number;
  /** asset_id 后缀(可选, 避免同批次同毫秒文件冲突) */
  batch_index?: number;
}

export interface PersistImageOutput {
  vault: VaultEntry;
  asset: AssetEntry;
  abs_path: string;
}

/**
 * 写 buffer + saveToVault + addAsset 三件套. adapter 拿 { vault, asset } 后自己写业务对象.
 *
 * 任一步抛异常直接传递, 不 silent 吞掉. caller 不需要再传 try/catch.
 */
export async function persistImageBuffer(input: PersistImageInput): Promise<PersistImageOutput> {
  const { image, series_slug, filename_prefix, vault_context, tags, provider_id, cost_cny, batch_index } = input;
  if (!image.buffer || image.buffer.byteLength === 0) {
    throw Object.assign(new Error("图像生成没有返回数据,provider 返回了 0 字节,请重试或换模型"), {
      status: 502,
      code: "EmptyImageBuffer",
    });
  }

  const mime = image.mime || "image/png";
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const idx = batch_index ?? 0;
  const filename = `${filename_prefix}_${Date.now()}_${idx}_${crypto.randomUUID().slice(0, 6)}.${ext}`;
  const assetPath = `assets/images/${filename}`;

  const assetsDir = path.join(DATA_ROOT, "series", series_slug, "assets", "images");
  await ensureDir(assetsDir);
  const absPath = path.join(assetsDir, filename);
  await fs.writeFile(absPath, image.buffer);

  const vault = await saveToVault({
    buffer: image.buffer,
    kind: "image",
    mime,
    context: {
      kind: vault_context.kind,
      series_slug: vault_context.series_slug,
      character_id: vault_context.character_id,
      scene_id: vault_context.scene_id,
      shot_id: vault_context.shot_id,
      user_note: vault_context.user_note,
      imported_from: vault_context.imported_from,
      parent_vault_id: vault_context.parent_vault_id,
    },
    provider_id,
    cost_cny,
    width: image.width || 1024,
    height: image.height || 1024,
    tags,
  });

  const asset = await addAsset(series_slug, {
    series_slug,
    kind: "image",
    tags,
    path: assetPath,
    filename,
    mime,
    size_bytes: image.buffer.length,
    sha256: crypto.createHash("sha256").update(image.buffer).digest("hex"),
  });

  return { vault, asset, abs_path: absPath };
}

/** 拼前端用 url. asset_id 缺时 fallback 到 vault. 两个都没就抛 — 视为内部错误. */
export function buildImageUrl(args: { series_slug: string; asset_path?: string; vault_id?: string }): string {
  if (args.vault_id) return `/api/v2/vault/${args.vault_id}/raw`;
  if (args.asset_path) return `/api/v2/series/${args.series_slug}/${args.asset_path.replace(/\\/g, "/")}`;
  throw new Error("internal: buildImageUrl 缺 vault_id 和 asset_path");
}
