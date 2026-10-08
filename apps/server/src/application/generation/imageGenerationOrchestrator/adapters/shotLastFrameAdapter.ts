/**
 * shot_last_frame adapter — 把外部生成的尾帧图绑到 shot.last_frame_vault_id.
 *
 * Phase 1 范围说明: orchestrator 视频生成完成后会用 ffmpeg 抽尾帧写 shot.last_frame_vault_id,
 * 那条路径自带 ffmpeg 抽帧逻辑, 不走本 adapter. 本 adapter 服务"用户手动用 AI 再画一张
 * 尾帧"等罕见场景, Wave 2 会规划具体调用点.
 *
 * 实现:
 *   1. _shared.persistImageBuffer 落 vault + asset
 *   2. updateShot 把 vault_id 写到 shot.last_frame_vault_id
 */

import { persistImageBuffer, buildImageUrl } from "./_shared";
import { readShot, updateShot } from "../../../../api/v2/seriesStore";
import type { ImageTargetAdapter, PersistedImage } from "../types";

export const shotLastFrameAdapter: ImageTargetAdapter = {
  async persist({ image, target, provider_id, request, batch_index }): Promise<PersistedImage> {
    if (!target.target_id) throw new Error("shot_last_frame adapter 需要 target.target_id (shotId)");
    const epId = typeof target.meta?.episode_id === "string" ? target.meta.episode_id : undefined;
    if (!epId) throw new Error("shot_last_frame adapter 需要 target.meta.episode_id");

    const tags = [
      `shot:${target.target_id}`,
      `episode:${epId}`,
      "last_frame_of",
      `provider:${provider_id}`,
      ...(request.extra_tags ?? []),
    ];

    const { vault, asset } = await persistImageBuffer({
      image,
      series_slug: target.series_slug,
      filename_prefix: `shot_last_frame_${target.target_id}`,
      vault_context: {
        kind: "last_frame_of",
        series_slug: target.series_slug,
        shot_id: target.target_id,
      },
      tags,
      provider_id,
      batch_index,
    });

    const currentShot = await readShot(target.series_slug, epId, target.target_id);
    if (!currentShot) {
      throw Object.assign(new Error(`shot ${target.target_id} 不存在`), { status: 404, code: "NotFound" });
    }
    await updateShot(target.series_slug, epId, target.target_id, {
      last_frame_vault_id: vault.vault_id,
    });

    return {
      image_id: vault.vault_id,
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
    const epId = typeof target.meta?.episode_id === "string" ? target.meta.episode_id : undefined;
    if (!epId) return undefined;
    return await readShot(target.series_slug, epId, target.target_id);
  },
};
