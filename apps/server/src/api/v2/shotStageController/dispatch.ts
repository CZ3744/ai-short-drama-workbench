/**
 * shotStageController dispatch helpers.
 *
 * scoped (`/series/:slug/episodes/:epId/shots/:sid/...`) 与 flat
 * (`/shots/:sid/...`) 两套 endpoint 共享 95% 实现逻辑,只在路径解析方式不同:
 *   - scoped: slug/epId/sid 直接从 req.params 拿;readScopedShot
 *   - flat:   先 locateShotById(sid) 反查 → readShotById(sid)
 *
 * 这里抽出 `dispatchFirstFrameGenerate` 与 `dispatchVideoGenerate`,
 * 两套 endpoint 都调它,不复制实现。
 *
 * caller 负责把 path-resolved ctx 喂进来,helper 自己不再 readShot。
 */

import type { Request, Response, NextFunction } from "express";
import {
  readSeries,
  type ShotData,
} from "../seriesStore";
import {
  createPendingJob,
  updatePendingJob,
  failPendingJob,
} from "../../../jobs/pendingJobs";
import { orchestrator } from "../../../jobs/orchestrator";
import { appendFailure } from "../../../repositories/failureRepo";
import { scrubForClient } from "../../../../../../packages/core/src/logger";
import { providerIdFromModelRef, videoInstanceIdFromModelRef } from "../../../application/generation/modelRef";
import { getVideoModelInstance } from "../../../../../../packages/core/src/videoModelInstances";
import { mapChannelToProviderId } from "../../../application/generation/videoGenerationService";
import {
  compileShotImagePrompt,
  compileShotVideoPrompt,
} from "../../../application/generation/shotPromptCompiler";
import { buildShotPromptInput } from "../../../application/generation/shotPromptInput";
import {
  assertProviderSelectedOrErr,
  err,
  extractSourceVideoFirstFrameForRegen,
  resolveFirstFrameOverrideFromInput,
  resolveMentionsToAssetIds,
} from "./shared";

/**
 * scoped 与 flat 两类 endpoint 都把自身解析出来的 (slug, epId, shotId, shot)
 * 喂给本 ctx,helper 自己不再 readShot/locateShotById。这样 helper 保持纯。
 */
export type DispatchCtx = {
  slug: string;
  epId: string;
  shotId: string;
  shot: ShotData;
  req: Request;
  res: Response;
  next: NextFunction;
  /**
   * 是否在 dispatch 失败时 fire-and-forget 写 failures.jsonl。
   * flat endpoint 历史上做这个兜底,scoped endpoint 不做 — 保留旧行为。
   */
  appendFailureOnError?: boolean;
};

/**
 * 共享首帧生成 dispatch — 见 scoped 路径 895-958 与 flat 路径 960-1032 原实现。
 */
export async function dispatchFirstFrameGenerate(ctx: DispatchCtx): Promise<void> {
  const { slug, epId, shotId, shot, req, res, next, appendFailureOnError } = ctx;
  let attemptId: string | undefined;
  try {
    const {
      count = 4, model, seed, ref_image_ids,
      prompt_override: bodyPromptOverride,
      user_extra_instruction,
      // 2026-05-27 audit Agent#1 P0 #6: 之前前端 generateImageAsync 传了 i2i_base_image_id
      // 字段, 后端 dispatchFirstFrameGenerate 完全没读, 用户在 RegenModal 整图重抽时
      // 模型完全没看到原图作 i2i, 等于纯文生重抽. 现在接收 + push 到 mergedRefIds 首位
      // (跟 regen-from-reject 路径同款做法).
      i2i_base_image_id,
      // 2026-05-28 P0#13: 接收前端 RegenModal / PromptReviewModal 可手动改的负向提示词 + 分辨率,
      // 透传 orchestrator → createRealShotTaskRunner. 之前完全没透传, 用户改了等于没改.
      negative_prompt,
      width,
      height,
    } = req.body ?? {};
    // W7: 校验必须显式选了 image provider,否则 400(避免 silent fallback 到 local_card_image)
    if (await assertProviderSelectedOrErr(res, "image", typeof model === "string" ? model : null, shot.image_model_ref ?? null, slug)) return;

    const trimmedOverride = typeof bodyPromptOverride === "string" ? bodyPromptOverride.trim() : "";
    const userExtra = typeof user_extra_instruction === "string" ? user_extra_instruction.trim() : "";

    let finalPromptOverride: string | undefined;
    if (trimmedOverride) {
      finalPromptOverride = trimmedOverride;
    } else if (userExtra) {
      const compilerInput = await buildShotPromptInput(slug, shot, { user_extra: userExtra });
      finalPromptOverride = compileShotImagePrompt(compilerInput).full_prompt;
    }

    const job = createPendingJob("shot.firstframe.generate", {
      sid: shotId, slug, epId, count, model, seed, ref_image_ids,
      compiled: !!finalPromptOverride && !trimmedOverride,
    });
    attemptId = job.attempt_id;
    updatePendingJob(job.attempt_id, { status: "running", progress: 0.2, eta_s: 6 });
    // B5: forward the full model_ref so adapters can override cfg.model_id.
    // provider_override remains populated for backward-compat callers.
    const fullModelRef = typeof model === "string" && model ? model : shot.image_model_ref ?? undefined;
    // 2026-05-17 严格做法: 扫 shot 所有 textarea 文本里的 @ mention token, 解析对应 image asset_id 传 orchestrator
    const mentionRefs = await resolveMentionsToAssetIds(slug, shot.action, shot.dialogue, shot.voiceover, shot.notes, shot.prompt_img, shot.prompt_vid, userExtra);
    // 2026-05-26 Fix 5 — 用户在 PromptReviewModal 勾选的 ref_image_ids 必须透传 orchestrator
    // (铁律 #2 可干预性 — 用户勾选即 truth, 不允许服务端 silent 丢弃)
    const userPickedRefIds: string[] = Array.isArray(ref_image_ids)
      ? ref_image_ids.filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
      : [];
    // 2026-05-27 audit P0 #6: i2i_base_image_id 放首位作 i2i 基底
    const i2iBase = typeof i2i_base_image_id === "string" && i2i_base_image_id ? [i2i_base_image_id] : [];
    const mergedRefIds = Array.from(new Set([...i2iBase, ...userPickedRefIds, ...mentionRefs.assetIds]));
    const result = await orchestrator.orchestrate({
      series_slug: slug,
      episode_id: epId,
      action: "generate_first_frames",
      count_per_shot: Math.max(1, Number(count) || 1),
      provider_override: providerIdFromModelRef(fullModelRef),
      model_ref_override: fullModelRef,
      seed_override: typeof seed === "number" ? seed : undefined,
      prompt_override: finalPromptOverride,
      only_shot_ids: [shotId],
      requestId: req.requestId,
      attempt_id: job.attempt_id,
      reference_asset_ids_extra: mergedRefIds.length > 0 ? mergedRefIds : undefined,
      // 2026-05-28 P0#13: 透传 negative_prompt / width / height
      negative_prompt_override: typeof negative_prompt === "string" && negative_prompt.trim() ? negative_prompt.trim() : undefined,
      width_override: typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : undefined,
      height_override: typeof height === "number" && Number.isFinite(height) && height > 0 ? Math.floor(height) : undefined,
    });
    res.json({
      ok: true,
      attempt_id: job.attempt_id,
      job_id: result.job_id,
      tasks: result.tasks,
      estimated_cost_cny: (Number(count) || 4) * 1.0,
      estimated_duration_s: 6,
      // 2026-05-27 — @ mention 找不到的 token 透给前端 toast 提示, 不再 silent skip
      skipped_mentions: mentionRefs.skippedTokens.length > 0 ? mentionRefs.skippedTokens : undefined,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (attemptId) failPendingJob(attemptId, { code: "DispatchFailed", message: errMsg });
    if (appendFailureOnError) {
      // T4: 持久化失败记录到 failures.jsonl（fire-and-forget, 不影响主流程）
      appendFailure(undefined, {
        shot_id: String(req.params.sid),
        code: "DispatchFailed",
        message: scrubForClient(errMsg),
        attempt_id: attemptId,
        kind: "first_frame",
      }).catch(() => {});
    }
    next(e);
  }
}

/**
 * 共享视频生成 dispatch — 见 scoped 路径 1214-1283 与 flat 路径 1285-1368 原实现。
 *
 * 注意 scoped / flat 两者在 prompt 兜底分支有 1 处微小差异:
 *   - scoped: `if (trimmedMotion || userExtra)` 内含 frame_anchors 上下文。
 *             无独立 `else if (trimmedMotion)` 分支。
 *   - flat:   同上 + 末尾多 `else if (trimmedMotion)` → finalPromptOverride = trimmedMotion;
 *
 * 因为 `(trimmedMotion || userExtra)` 必含 `trimmedMotion`,scoped 走的是 compiler
 * 路径(`trimmedMotion` 作 user_extra 喂 compileShotVideoPrompt);flat 在该分支也走
 * compiler。flat 末尾的 `else if (trimmedMotion)` 实际不可达(前一分支已捕获)。
 * 统一为 scoped 写法即可,不损失任何路径。
 */
export async function dispatchVideoGenerate(ctx: DispatchCtx): Promise<void> {
  const { slug, epId, shotId, shot, req, res, next, appendFailureOnError } = ctx;
  let attemptId: string | undefined;
  try {
    const {
      // 2026-07-10 audit P2-7: 去掉 duration_s 的 `= 5` 默认 —— 那个默认会让"未传 duration_s
      // 的 caller"被强行按 5s 生成/估价,覆盖掉 shot.duration_sec(比如某镜设了 8s)。改为不带
      // 默认,下面校验后为 undefined 时,orchestrator 回退 shot.duration_sec || 5(与 dry-run 同源)。
      motion_prompt, duration_s, model, first_frame_id,
      // 2026-07-10 audit P2-7: camera_move / pace 从 body 解构里删除 —— 它们过去只被塞进
      // pendingJob meta,从不进 orchestrate,也没有任何 caller 在传;运镜/节奏信息本就通过持久
      // 字段 shot.camera_movement / shot.pace 经 shotPromptInput→shotPromptCompiler 进入提示词。
      // 留着是"骗人的接口"(用户以为改了会生效,实则丢弃),故移除。
      prompt_override: bodyPromptOverride,
      user_extra_instruction,
      source_video_generation_id,
      ref_image_ids,
      // 2026-05-28 P0#13: 视频 dispatch 也接 negative_prompt / width / height
      negative_prompt,
      width,
      height,
    } = req.body ?? {};
    // W7: 校验必须显式选了 video provider,否则 400(避免 silent fallback 到 local_mock_video)
    if (await assertProviderSelectedOrErr(res, "video", typeof model === "string" ? model : null, shot.video_model_ref ?? null, slug)) return;

    // 2026-07-10 audit P2-7: 校验 body duration_s(正有限数才认),作为 orchestrate 的时长 override。
    //   - 有效正数 → durationSecOverride,透传 orchestrate(真正发给 provider 用它,与 dry-run 估价同源)
    //   - 缺失/非法 → undefined,orchestrator 回退 shot.duration_sec || 5(与 videoDryRun.ts:147 一致)
    // resolvedDurationSec 仅用于 pendingJob meta / eta 展示,如实反映真正会用的时长。
    const durationSecOverride =
      typeof duration_s === "number" && Number.isFinite(duration_s) && duration_s > 0
        ? duration_s
        : undefined;
    const resolvedDurationSec = durationSecOverride ?? (shot.duration_sec || 5);

    // 兼容 — 旧 caller 至少传 motion_prompt 或 prompt_override 任一. 否则用 shot 兜底
    const trimmedOverride = typeof bodyPromptOverride === "string" ? bodyPromptOverride.trim() : "";
    const trimmedMotion = typeof motion_prompt === "string" ? motion_prompt.trim() : "";
    const userExtra = typeof user_extra_instruction === "string" ? user_extra_instruction.trim() : "";

    let finalPromptOverride: string | undefined;
    if (trimmedOverride) {
      finalPromptOverride = trimmedOverride;
    } else if (trimmedMotion || userExtra) {
      // 用 compiler 拼出 full_prompt — motion_prompt 视为额外的用户文本一起喂
      const anchors = shot.frame_anchors ?? [];
      // 2026-05-27 fix — has_first_frame_ref 必须看 picked_first_frame_generation_id.
      //   原来只看 frame_anchors / first_frame_id / source_video_generation_id; 90% 用户
      //   旅程 (生完首帧 → 挑一张 → 生视频) 走的就是 picked, orchestrator 已经把图发给
      //   i2v provider, 但 preamble 文字写"无首帧参考" → 模型被互相打架的指令误导.
      const hasPickedFirstFrame = !!shot.picked_first_frame_generation_id;
      const compilerInput = await buildShotPromptInput(slug, shot, {
        user_extra: [trimmedMotion, userExtra].filter(Boolean).join("\n"),
        has_first_frame_ref: anchors.some((a) => a.role === "first") || !!first_frame_id || !!source_video_generation_id || hasPickedFirstFrame,
        has_end_frame_ref: anchors.some((a) => a.role === "end"),
      });
      finalPromptOverride = compileShotVideoPrompt(compilerInput).full_prompt;
    }

    const sourceVideoFramePath = await extractSourceVideoFirstFrameForRegen(slug, shotId, shot, source_video_generation_id);
    const firstFrameOverride = sourceVideoFramePath ?? resolveFirstFrameOverrideFromInput(shot, first_frame_id);

    const job = createPendingJob("shot.video.generate", {
      // 2026-07-10 audit P2-7: duration_s 记真正会用的时长(resolvedDurationSec),不再记原始 body 值,
      // camera_move / pace 已从 body 移除(它们从不进 orchestrate)。
      sid: shotId, slug, epId, motion_prompt: trimmedMotion, duration_s: resolvedDurationSec, model, first_frame_id,
      source_video_generation_id: typeof source_video_generation_id === "string" ? source_video_generation_id : undefined,
      compiled: !!finalPromptOverride && !trimmedOverride,
    });
    attemptId = job.attempt_id;
    updatePendingJob(job.attempt_id, { status: "running", progress: 0.2, eta_s: resolvedDurationSec });
    // B5: full model_ref overrides cfg.model_id at the adapter level.
    const fullVideoModelRef = typeof model === "string" && model ? model : shot.video_model_ref ?? undefined;

    // 2026-05-27 P0 — 视频 model_ref ModelPicker 路径用 3 段 colon: "instance:<vmi_id>:<model_override>"
    // dispatch 之前直接 providerIdFromModelRef 取首段 "instance" 给 orchestrator, registry 找不到 →
    // "No video provider registered for id 'instance'". 现在 unwrap instance, 拿 channel 再 map 成真
    // provider_id (zhipu_cogvideox 等).
    const videoInstanceId = videoInstanceIdFromModelRef(fullVideoModelRef);
    let resolvedVideoProviderId = providerIdFromModelRef(fullVideoModelRef);
    if (videoInstanceId) {
      const inst = getVideoModelInstance(videoInstanceId);
      if (inst) {
        resolvedVideoProviderId = mapChannelToProviderId(inst.channel);
      }
    }
    // 2026-05-17 严格做法: 视频生成也扫 mention token, 跟 firstframe 同 helper
    const mentionRefs = await resolveMentionsToAssetIds(slug, shot.action, shot.dialogue, shot.voiceover, shot.notes, shot.prompt_img, shot.prompt_vid, trimmedMotion, userExtra);
    // 2026-05-26 Fix 5 — 用户在 PromptReviewModal 勾选的 ref_image_ids 必须透传 orchestrator
    const userPickedRefIds: string[] = Array.isArray(ref_image_ids)
      ? ref_image_ids.filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
      : [];
    const mergedRefIds = Array.from(new Set([...userPickedRefIds, ...mentionRefs.assetIds]));
    const result = await orchestrator.orchestrate({
      series_slug: slug,
      episode_id: epId,
      action: "generate_videos",
      count_per_shot: Math.max(1, Number(req.body?.count) || 1),
      provider_override: resolvedVideoProviderId,
      model_ref_override: fullVideoModelRef,
      prompt_override: finalPromptOverride,
      seed_override: typeof req.body?.seed === "number" ? req.body.seed : undefined,
      only_shot_ids: [shotId],
      requestId: req.requestId,
      attempt_id: job.attempt_id,
      reference_asset_ids_extra: mergedRefIds.length > 0 ? mergedRefIds : undefined,
      first_frame_asset_id_override: firstFrameOverride,
      // 2026-05-28 P0#13: 透传 negative_prompt / width / height
      negative_prompt_override: typeof negative_prompt === "string" && negative_prompt.trim() ? negative_prompt.trim() : undefined,
      width_override: typeof width === "number" && Number.isFinite(width) && width > 0 ? Math.floor(width) : undefined,
      height_override: typeof height === "number" && Number.isFinite(height) && height > 0 ? Math.floor(height) : undefined,
      // 2026-07-10 audit P2-7: 透传校验后的 body duration_s,让真正发给 provider 的时长与
      // dry-run 估价 + 确认弹窗展示的"时长: Xs"是同一个值、同一条数据通路。
      duration_sec_override: durationSecOverride,
    });
    res.json({
      ok: true,
      attempt_id: job.attempt_id,
      job_id: result.job_id,
      tasks: result.tasks,
      // 2026-05-27 — @ mention 找不到的 token 透给前端 toast 提示, 不再 silent skip
      skipped_mentions: mentionRefs.skippedTokens.length > 0 ? mentionRefs.skippedTokens : undefined,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    if (attemptId) failPendingJob(attemptId, { code: "DispatchFailed", message: errMsg });
    if (appendFailureOnError) {
      // T4: 持久化失败记录到 failures.jsonl（fire-and-forget, 不影响主流程）
      appendFailure(undefined, {
        shot_id: String(req.params.sid),
        code: "DispatchFailed",
        message: scrubForClient(errMsg),
        attempt_id: attemptId,
        kind: "video",
      }).catch(() => {});
    }
    next(e);
  }
}
