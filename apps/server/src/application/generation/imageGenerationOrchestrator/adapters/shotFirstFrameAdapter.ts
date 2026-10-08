/**
 * shot_first_frame adapter — 把首帧抽卡的单张结果写进 shot.generations / active_generations.
 *
 * Wave 4-A (2026-05-16): 升级支持 jobs/orchestrator 主流量调用 — 通过
 * `request.generation_extras` 透传 quality_scores / prompt_version / request_payload_digest /
 * cost_cny / negative_prompt / submitted_at 等业务后处理字段, 与原 orchestrator 内联
 * `generation` 对象的字段完整对齐, 不再有"轻量 endpoint 写少几个字段"的回归.
 *
 * 当前调用入口:
 *   - jobs/orchestrator.ts createRealShotTaskRunner (image path, 主流量)
 *   - 轻量 endpoint (shotStageController / shotController flat) 仍可零成本接入,
 *     不传 generation_extras 即可, adapter 走最小写入路径.
 *
 * 实现要点:
 *   1. _shared.persistImageBuffer 落 vault + asset
 *   2. 拼 ShotGeneration 对象 (含 extras 字段) → 追加进 shot.generations + active_generations
 *   3. 不做 ffprobe / quality scoring / continuity check (那是 orchestrator caller 的活)
 *   4. status 流转: status=generated, picked=false. orchestrator caller 自己再做 SSE 推送
 *      和后处理(CLIP评分 / 连续性检查 / 末帧抽取等).
 */

import { persistImageBuffer, buildImageUrl } from "./_shared";
import { readShot, appendGeneration } from "../../../../api/v2/seriesStore";
import type { ShotGeneration, ShotData } from "../../../../../../../packages/drama/src/types";
import type { ImageTargetAdapter, PersistedImage } from "../types";

export const shotFirstFrameAdapter: ImageTargetAdapter = {
  async persist({ image, target, provider_id, request, batch_index }): Promise<PersistedImage> {
    if (!target.target_id) throw new Error("shot_first_frame adapter 需要 target.target_id (shotId)");
    const epId = typeof target.meta?.episode_id === "string" ? target.meta.episode_id : undefined;
    if (!epId) throw new Error("shot_first_frame adapter 需要 target.meta.episode_id");

    const extras = request.generation_extras;
    const tags = [
      `shot:${target.target_id}`,
      `episode:${epId}`,
      "shot_first_frame",
      `provider:${provider_id}`,
      ...(request.extra_tags ?? []),
    ];

    const { vault, asset, abs_path } = await persistImageBuffer({
      image,
      series_slug: target.series_slug,
      filename_prefix: `shot_first_frame_${target.target_id}`,
      vault_context: {
        kind: "shot_first_frame",
        series_slug: target.series_slug,
        shot_id: target.target_id,
      },
      tags,
      provider_id,
      cost_cny: extras?.cost_cny,
      batch_index,
    });

    const generationId = extras?.generation_id ?? `gen_${Date.now()}_${crypto.randomUUID().slice(0, 12)}`;
    const nowIso = new Date().toISOString();
    const generation: ShotGeneration = {
      generation_id: generationId,
      type: "first_frame",
      provider: provider_id,
      asset_id: asset.asset_id,
      vault_id: vault.vault_id,
      path: abs_path,
      created_at: extras?.submitted_at ?? nowIso,
      status: "done",
      picked: false,
      seed: image.seed,
      prompt: request.prompt,
      prompt_used: extras?.prompt_used ?? request.prompt,
      prompt_final: extras?.prompt_final ?? request.prompt,
      width: image.width,
      height: image.height,
      bytes: image.buffer.length,
      // Wave 4-A: 业务后处理字段(orchestrator 主流量填, 轻量 endpoint 留 undefined)
      quality_scores: extras?.quality_scores,
      prompt_version: extras?.prompt_version,
      provider_job_id: extras?.provider_job_id,
      provider_file_id: extras?.provider_file_id,
      model_id: extras?.model_id ?? provider_id,
      request_payload_digest: extras?.request_payload_digest,
      negative_prompt: extras?.negative_prompt,
      duration_sec_requested: extras?.duration_sec_requested,
      duration_sec_actual: extras?.duration_sec_actual,
      fps: extras?.fps,
      cost_cny: extras?.cost_cny,
      submitted_at: extras?.submitted_at,
      completed_at: extras?.completed_at ?? nowIso,
      downloaded_at: extras?.downloaded_at ?? nowIso,
    };

    // 2026-07-09 audit C10 — 原子追加: read+append+write 收进 shotRepo.appendGeneration 的
    // 同一把 withWriteLock, 消除"同镜两个并发首帧各自锁外读同一基线 → 后写覆盖先写丢候选图"竞态.
    const extraPatch: Partial<ShotData> = {};
    if (extras?.last_frame_vault_id) {
      extraPatch.last_frame_vault_id = extras.last_frame_vault_id;
    }
    if (extras?.first_frame_from_prev) {
      extraPatch.first_frame_from_prev = true;
    }
    const updatedShot = await appendGeneration(target.series_slug, epId, target.target_id, generation, {
      status: "generated",
      extraPatch,
    });
    if (!updatedShot) {
      throw Object.assign(new Error(`shot ${target.target_id} 不存在`), { status: 404, code: "NotFound" });
    }

    return {
      image_id: generationId,
      asset_id: asset.asset_id,
      vault_id: vault.vault_id,
      url: buildImageUrl({ series_slug: target.series_slug, vault_id: vault.vault_id }),
      width: image.width,
      height: image.height,
      seed: image.seed,
      mime: image.mime || "image/png",
      provider_id,
      prompt_snapshot: extras?.prompt_final ?? request.prompt,
      abs_path,
    };
  },

  async readState(target): Promise<unknown> {
    if (!target.target_id) return undefined;
    const epId = typeof target.meta?.episode_id === "string" ? target.meta.episode_id : undefined;
    if (!epId) return undefined;
    return await readShot(target.series_slug, epId, target.target_id);
  },
};
