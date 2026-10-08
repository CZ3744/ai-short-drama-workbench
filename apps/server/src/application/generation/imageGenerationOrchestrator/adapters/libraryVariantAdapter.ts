/**
 * library_variant adapter — global library / series variant 路径下的"生图到 vault".
 *
 * 调用入口:
 *   - POST /api/v2/generate/image (target.kind="library_variant") — 统一入口
 *   - libraryController POST /library/characters/:id/variants (auto-pack)
 *   - libraryController POST /library/scenes/:id/variants (auto-pack)
 *   - characterController POST /series/:slug/characters/:charId/variants/auto-pack
 *   - sceneController POST /series/:slug/scenes/:sceneId/variants/auto-pack
 *
 * Wave P (2026-05-20): libraryController /generate-refs legacy routes 删除 — 全走统一端点.
 *
 * 业务实体写入(createCharacterVariant 等)由调用方自己负责; adapter 只统一 saveToVault + 标签.
 *
 * 注意: variant 不写 series 内 asset_index — 它是 vault 资产, 由 globalLibrary 的
 * meta.json / variants[].source_vault_id 关联.
 */

import { saveToVault } from "../../../../../../../packages/library/src/assetVault";
import type { ImageTargetAdapter, PersistedImage } from "../types";

export const libraryVariantAdapter: ImageTargetAdapter = {
  async persist({ image, target, provider_id, request }): Promise<PersistedImage> {
    const mime = image.mime || "image/png";
    const tags = [
      "library_variant",
      `provider:${provider_id}`,
      ...(target.target_id ? [`library:${target.target_id}`] : []),
      ...(typeof target.meta?.category === "string" ? [`category:${target.meta.category}`] : []),
      ...(request.extra_tags ?? []),
    ];

    const vault = await saveToVault({
      buffer: image.buffer,
      kind: "image",
      mime,
      context: {
        kind: typeof target.meta?.vault_context_kind === "string"
          && ["library_ref", "variant"].includes(target.meta.vault_context_kind)
          ? target.meta.vault_context_kind as "library_ref" | "variant"
          : "library_ref",
        series_slug: target.series_slug,
        character_id: typeof target.meta?.character_id === "string" ? target.meta.character_id : undefined,
        scene_id: typeof target.meta?.scene_id === "string" ? target.meta.scene_id : undefined,
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
      url: `/api/v2/vault/${vault.vault_id}/raw`,
      width: image.width,
      height: image.height,
      seed: image.seed,
      mime,
      provider_id,
      prompt_snapshot: request.prompt,
    };
  },

  async readState(): Promise<undefined> {
    return undefined;
  },
};
