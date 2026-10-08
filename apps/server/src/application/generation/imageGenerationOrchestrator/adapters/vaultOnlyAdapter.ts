/**
 * vault_only adapter — 不写任何业务对象, 只走 vault (sha-256 dedup).
 *
 * 用途:
 *   - imageController POST /api/v2/images/generate (raw API, 调用方自己保存)
 *   - vaultController POST /api/v2/vault/:id/remix (variant 入 vault)
 *   - vaultController POST /api/v2/vault/:id/inpaint (inpaint 入 vault)
 *   - episodeUseCases generate cover (封面入 vault)
 *
 * 注意: raw API 实际上**不写文件 + 不入 asset**, 只返回 data_url. 因此该 adapter
 * 同样不写 asset_index — 调用方决定要不要持久化.
 */

import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { DATA_ROOT, ensureDir } from "../../../../../../../packages/core/src/index";
import { saveToVault } from "../../../../../../../packages/library/src/assetVault";
import type { ImageTargetAdapter, PersistedImage } from "../types";

function isContextKind(k: unknown): k is import("../../../../../../../packages/library/src/assetVault").VaultContext["kind"] {
  return typeof k === "string" && [
    "library_ref", "shot_first_frame", "shot_video", "variant", "inpaint",
    "rough_cut", "user_upload", "last_frame_of", "mood_board", "character_ref", "scene_ref",
  ].includes(k);
}

export const vaultOnlyAdapter: ImageTargetAdapter = {
  async persist({ image, target, provider_id, request, batch_index }): Promise<PersistedImage> {
    const ctxKind = isContextKind(target.meta?.vault_context_kind)
      ? target.meta.vault_context_kind as import("../../../../../../../packages/library/src/assetVault").VaultContext["kind"]
      : "variant";
    const mime = image.mime || "image/png";
    const tags = Array.from(new Set([
      ...(request.extra_tags ?? []),
      `provider:${provider_id}`,
      "vault_only",
    ]));

    // 写入业务路径 (caller 想要的话可读, vault entry 已经是 source of truth)
    const writeFile = target.meta?.write_to_assets === true;
    let assetUrlPath: string | undefined;
    if (writeFile) {
      const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
      const filename = `vaultonly_${Date.now()}_${batch_index}_${crypto.randomUUID().slice(0, 6)}.${ext}`;
      const dir = path.join(DATA_ROOT, "series", target.series_slug, "assets", "images");
      await ensureDir(dir);
      await fs.writeFile(path.join(dir, filename), image.buffer);
      assetUrlPath = `assets/images/${filename}`;
    }

    const vault = await saveToVault({
      buffer: image.buffer,
      kind: "image",
      mime,
      context: {
        kind: ctxKind,
        series_slug: target.series_slug,
        character_id: typeof target.meta?.character_id === "string" ? target.meta.character_id : undefined,
        scene_id: typeof target.meta?.scene_id === "string" ? target.meta.scene_id : undefined,
        shot_id: typeof target.meta?.shot_id === "string" ? target.meta.shot_id : undefined,
        parent_vault_id: typeof target.meta?.parent_vault_id === "string" ? target.meta.parent_vault_id : undefined,
        user_note: typeof target.meta?.user_note === "string" ? target.meta.user_note : undefined,
      },
      provider_id,
      width: image.width || 1024,
      height: image.height || 1024,
      tags,
    });

    return {
      image_id: vault.vault_id,
      vault_id: vault.vault_id,
      url: assetUrlPath
        ? `/api/v2/series/${target.series_slug}/${assetUrlPath}`
        : `/api/v2/vault/${vault.vault_id}/raw`,
      mime,
      width: image.width,
      height: image.height,
      seed: image.seed,
      provider_id,
      prompt_snapshot: request.prompt,
    };
  },

  async readState(): Promise<undefined> {
    return undefined;
  },
};
