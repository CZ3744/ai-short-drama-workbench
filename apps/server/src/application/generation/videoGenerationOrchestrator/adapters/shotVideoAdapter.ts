/**
 * shotVideoAdapter — 把视频生成结果绑到 shot.generations (type=video).
 *
 * Wave 4-A (2026-05-16): 升级支持 jobs/orchestrator 主流量调用. 通过
 * `request.generation_extras` 透传 ffprobe 实测尺寸 / cost_cny / submitted_at / 末帧 vault
 * 等业务后处理字段, 与原 orchestrator 内联 generation 对象的字段完整对齐.
 *
 * 当前调用入口:
 *   - jobs/orchestrator.ts createRealShotTaskRunner (video path, 主流量)
 *
 * 实现要点:
 *   1. 把视频 buffer 写到 outputs/series/<slug>/episodes/<ep>/assets/<gen>.mp4
 *      (路径与原 orchestrator 一致, 不动 compose/render 期望)
 *   2. saveToVault (kind=video) + addAsset (kind=video)
 *   3. 拼 ShotGeneration (type=video) 含 extras 字段, 追加到 shot.generations
 *   4. 如果 extras.last_frame_vault_id 存在(orchestrator 已 ffmpeg 抽末帧), 一并写到 shot
 *
 * 不做的事(留给 caller orchestrator):
 *   - ffprobe 校验(失败 → throw, 由 orchestrator decide retry)
 *   - ffmpeg 抽末帧(orchestrator 在拿到 PersistedVideo.abs_path 后自己跑)
 *   - SSE 推送
 *   - CLIP 评分
 *   - 真实视频锁 release
 */

import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { saveToVault } from "../../../../../../../packages/library/src/assetVault";
import { addAsset } from "../../../../repositories/assetRepo";
import { readShot, appendGeneration } from "../../../../api/v2/seriesStore";
import type { ShotGeneration, ShotData } from "../../../../../../../packages/drama/src/types";
import type { VideoTargetAdapter, PersistedVideo } from "../types";

export const shotVideoAdapter: VideoTargetAdapter = {
  async persist({ video, target, provider_id, request }): Promise<PersistedVideo> {
    if (!target.target_id) throw new Error("shot_video adapter 需要 target.target_id (shotId)");
    const epId = typeof target.meta?.episode_id === "string" ? target.meta.episode_id : undefined;
    if (!epId) throw new Error("shot_video adapter 需要 target.meta.episode_id");

    const extras = request.generation_extras;
    const mime = video.mime || "video/mp4";
    const generationId = extras?.generation_id ?? `gen_${Date.now()}_${crypto.randomUUID().slice(0, 12)}`;
    const filename = `${generationId}.mp4`;
    const outputDir = path.join(process.cwd(), "outputs", "series", target.series_slug, "episodes", epId, "assets");
    await fs.mkdir(outputDir, { recursive: true });
    const absPath = path.join(outputDir, filename);
    await fs.writeFile(absPath, video.buffer);

    const tags = [
      `shot:${target.target_id}`,
      `episode:${epId}`,
      "shot_video",
      `provider:${provider_id}`,
      ...(request.extra_tags ?? []),
    ];

    const vault = await saveToVault({
      buffer: video.buffer,
      kind: "video",
      mime,
      context: {
        kind: "shot_video",
        series_slug: target.series_slug,
        shot_id: target.target_id,
      },
      provider_id,
      cost_cny: extras?.cost_cny,
      width: video.width,
      height: video.height,
      duration_sec: extras?.duration_sec_actual ?? video.duration_sec,
      tags,
    });

    const asset = await addAsset(target.series_slug, {
      series_slug: target.series_slug,
      kind: "video",
      tags,
      path: absPath,
      filename,
      mime,
      size_bytes: video.buffer.length,
      sha256: crypto.createHash("sha256").update(video.buffer).digest("hex"),
    });

    const nowIso = new Date().toISOString();
    const generation: ShotGeneration = {
      generation_id: generationId,
      type: "video",
      provider: provider_id,
      asset_id: asset.asset_id,
      vault_id: vault.vault_id,
      path: absPath,
      created_at: extras?.submitted_at ?? nowIso,
      status: "done",
      picked: false,
      seed: request.seed,
      prompt: request.prompt,
      prompt_used: extras?.prompt_used ?? request.prompt,
      prompt_final: extras?.prompt_final ?? request.prompt,
      width: video.width,
      height: video.height,
      duration_sec_actual: extras?.duration_sec_actual ?? video.duration_sec,
      duration_sec_requested: extras?.duration_sec_requested ?? request.duration_sec,
      bytes: video.buffer.length,
      // Wave 4-A extras 透传
      prompt_version: extras?.prompt_version,
      provider_job_id: extras?.provider_job_id,
      provider_file_id: extras?.provider_file_id,
      model_id: extras?.model_id ?? provider_id,
      request_payload_digest: extras?.request_payload_digest,
      negative_prompt: extras?.negative_prompt,
      fps: extras?.fps,
      cost_cny: extras?.cost_cny,
      submitted_at: extras?.submitted_at,
      completed_at: extras?.completed_at ?? nowIso,
      downloaded_at: extras?.downloaded_at ?? nowIso,
    };

    // 2026-07-09 audit C10/C11 补漏 — 原子追加: 之前 readShot(锁外)+updateShot(绝对 generations
    // 数组). 同镜两个并发视频落盘(count_per_shot≥2 / 用户重抽)各自锁外读到同一基线, 各自拼
    // [...baseline, genX] 再整段 updateShot → 后写覆盖先写, 把已真实生成并扣费的候选视频冲掉.
    // 收进 shotRepo.appendGeneration 的同一把 withWriteLock(锁内重读 generations 再 append),
    // 与 shotFirstFrameAdapter 已迁移做法一致. last_frame_vault_id 走 extraPatch, status 走 opts.status.
    const extraPatch: Partial<ShotData> = {};
    if (extras?.last_frame_vault_id) {
      extraPatch.last_frame_vault_id = extras.last_frame_vault_id;
    }
    const updatedShot = await appendGeneration(target.series_slug, epId, target.target_id, generation, {
      status: "generated",
      extraPatch,
    });
    if (!updatedShot) {
      throw Object.assign(new Error(`shot ${target.target_id} 不存在`), { status: 404, code: "NotFound" });
    }

    return {
      generation_id: generationId,
      asset_id: asset.asset_id,
      vault_id: vault.vault_id,
      url: `/api/v2/vault/${vault.vault_id}/raw`,
      width: video.width,
      height: video.height,
      duration_sec: extras?.duration_sec_actual ?? video.duration_sec,
      mime,
      provider_id,
      prompt_snapshot: extras?.prompt_final ?? request.prompt,
      abs_path: absPath,
    };
  },

  async readState(target): Promise<unknown> {
    if (!target.target_id) return undefined;
    const epId = typeof target.meta?.episode_id === "string" ? target.meta.episode_id : undefined;
    if (!epId) return undefined;
    return await readShot(target.series_slug, epId, target.target_id);
  },
};
