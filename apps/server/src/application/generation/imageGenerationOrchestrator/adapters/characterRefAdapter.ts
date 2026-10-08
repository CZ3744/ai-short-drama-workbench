/**
 * character_ref adapter — 把生成结果追加到 character.ref_image_ids.
 *
 * 调用入口: POST /api/v2/generate/image (target.kind="character_ref").
 * Wave P (2026-05-20): characterController /generate-refs legacy route 已删, 全走统一端点.
 *
 * 实现:
 *   1. _shared.persistImageBuffer 写盘 + saveToVault + addAsset (含 character_id 标签)
 *   2. updateCharacter ref_image_ids 追加 asset_id
 *
 * 与 elementAdapter 的差别: element 走 elementController.helpers 的统一通道(支持新旧
 * repo 适配), character_ref 直接走 characterRepo.updateCharacter.
 */

import { persistImageBuffer, buildImageUrl } from "./_shared";
import { readCharacter, updateCharacter } from "../../../../repositories/characterRepo";
import type { ImageTargetAdapter, PersistedImage } from "../types";

export const characterRefAdapter: ImageTargetAdapter = {
  async persist({ image, target, provider_id, request, batch_index }): Promise<PersistedImage> {
    if (!target.target_id) throw new Error("character_ref adapter 需要 target.target_id (charId)");

    const tags = [
      `character:${target.target_id}`,
      "ref_image",
      `provider:${provider_id}`,
      ...(request.extra_tags ?? []),
    ];

    const { vault, asset } = await persistImageBuffer({
      image,
      series_slug: target.series_slug,
      filename_prefix: `ref_${target.target_id}`,
      vault_context: {
        kind: "character_ref",
        series_slug: target.series_slug,
        character_id: target.target_id,
      },
      tags,
      provider_id,
      batch_index,
    });

    // 把 asset_id 追加到 character.ref_image_ids，同时写 ref_image_meta 字典保存 prompt_snapshot 等
    const char = await readCharacter(target.series_slug, target.target_id);
    if (!char) {
      throw Object.assign(new Error(`character ${target.target_id} 不存在`), { status: 404, code: "NotFound" });
    }
    const updated = await updateCharacter(target.series_slug, target.target_id, {
      ref_image_ids: [...(char.ref_image_ids ?? []), asset.asset_id],
      ref_image_meta: {
        ...(char.ref_image_meta ?? {}),
        [asset.asset_id]: {
          prompt_snapshot: request.prompt,
          provider_id,
          seed: image.seed,
          origin: (typeof target.meta?.i2i_base_image_id === "string") ? "i2i" : "generated",
          based_on_image_id: typeof target.meta?.i2i_base_image_id === "string"
            ? target.meta.i2i_base_image_id
            : undefined,
          created_at: new Date().toISOString(),
        },
      },
    });
    if (!updated) {
      throw Object.assign(new Error(`character ${target.target_id} 更新失败`), { status: 500 });
    }

    return {
      image_id: asset.asset_id,
      asset_id: asset.asset_id,
      vault_id: vault.vault_id,
      url: buildImageUrl({ series_slug: target.series_slug, vault_id: vault.vault_id }),
      width: image.width,
      height: image.height,
      seed: image.seed,
      mime: image.mime || "image/png",
      provider_id,
      prompt_snapshot: request.prompt,
    };
  },

  async readState(target): Promise<unknown> {
    if (!target.target_id) return undefined;
    return await readCharacter(target.series_slug, target.target_id);
  },
};
