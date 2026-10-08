/**
 * scene_ref adapter — 把生成结果追加到 scene.ref_image_ids.
 *
 * 调用入口: POST /api/v2/generate/image (target.kind="scene_ref").
 * Wave P (2026-05-20): sceneController /generate-refs legacy route 已删, 全走统一端点.
 * 对称 characterRefAdapter, 只换 repo.
 */

import { persistImageBuffer, buildImageUrl } from "./_shared";
import { readScene, updateScene } from "../../../../repositories/sceneRepo";
import type { ImageTargetAdapter, PersistedImage } from "../types";

export const sceneRefAdapter: ImageTargetAdapter = {
  async persist({ image, target, provider_id, request, batch_index }): Promise<PersistedImage> {
    if (!target.target_id) throw new Error("scene_ref adapter 需要 target.target_id (sceneId)");

    const tags = [
      `scene:${target.target_id}`,
      "ref_image",
      `provider:${provider_id}`,
      ...(request.extra_tags ?? []),
    ];

    const { vault, asset } = await persistImageBuffer({
      image,
      series_slug: target.series_slug,
      filename_prefix: `ref_${target.target_id}`,
      vault_context: {
        kind: "scene_ref",
        series_slug: target.series_slug,
        scene_id: target.target_id,
      },
      tags,
      provider_id,
      batch_index,
    });

    const scene = await readScene(target.series_slug, target.target_id);
    if (!scene) {
      throw Object.assign(new Error(`scene ${target.target_id} 不存在`), { status: 404, code: "NotFound" });
    }
    const updated = await updateScene(target.series_slug, target.target_id, {
      ref_image_ids: [...(scene.ref_image_ids ?? []), asset.asset_id],
      ref_image_meta: {
        ...(scene.ref_image_meta ?? {}),
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
      throw Object.assign(new Error(`scene ${target.target_id} 更新失败`), { status: 500 });
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
    return await readScene(target.series_slug, target.target_id);
  },
};
