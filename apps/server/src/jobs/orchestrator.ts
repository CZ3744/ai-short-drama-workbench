/**
 * JobOrchestrator — Splits high-level actions into TaskQueue sub-tasks
 *
 * Responsibilities:
 * - "generate all first frames for an episode" → one task per shot
 * - "generate all videos for an episode" → one task per shot
 * - Each sub-task: compilePrompt → provider.generate → AssetStore → shot.generations → ledger
 * - All sub-tasks via P20 TaskQueue
 * - job_id groups sub-tasks; GET /tasks?job_id=... lists all
 * - Auto-retry on ProviderError.retriable
 * - Enforces series.defaults limits (max_parallel_tasks, max_retake_per_shot, max_video_seconds_per_job)
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ulid } from "ulid";
import { ProviderError, BudgetExceededError } from "../../../../packages/providers/src/core/errors";
import { loadAllInflight } from "../../../../packages/providers/src/core/inflightStore";
import { budgetGuard } from "../../../../packages/providers/src/core/budgetGuard";
import { TaskQueue, type Task } from "../../../../packages/providers/src/core/queue";
import { getPreset } from "../../../../packages/core/src/presets";
import type { ProviderContext, ImageGenerateRequest } from "../../../../packages/providers/src/core/types";
import type { ProviderRegistry } from "../../../../packages/providers/src/core/registry";
import { sseBroker } from "../api/v2/sseBroker";
import {
  createTaskRecord,
  updateTaskRecord,
  getTask,
  readSeries,
  readShot,
  readCharacter,
  readScene,
  updateShot,
  addAsset,
  listShots,
  getMoodBoardRefImages,
  type ShotData,
  type ShotGeneration,
  type SeriesData,
} from "../api/v2/seriesStore";
import { saveToVault, getVaultEntry, getVaultAbsolutePath, updateVaultEntry } from "../../../../packages/library/src/assetVault";
import { scoreImage } from "../../../../packages/providers/src/quality/clipScorer";
import { runProcess } from "../../../../packages/render/src/process";
import { checkContinuity } from "../../../../packages/providers/src/quality/continuityChecker";
import { precheckPrompt } from "../../../../packages/providers/src/quality/promptPrecheck";
import { postGenCheck } from "../../../../packages/providers/src/quality/postGenCheck";
import { loggerSync, logProviderCall } from "../../../../packages/core/src/logger";
import { getConfigValue } from "../../../../packages/core/src/localSettings";
import { resolveRenderSpec } from "../../../../packages/core/src/renderSpec";
import { DATA_ROOT, outputsRoot } from "../../../../packages/core/src/paths";
import { buildReferenceSet } from "../../../../packages/drama/src/consistency/referenceSet";
import { validateVideoFile } from "../../../../packages/render/src/ffprobe";
import { completePendingJob, failPendingJob, updatePendingJob } from "./pendingJobs";
import { generateImagesWithProvider } from "../application/generation/imageGenerationService";
import { generateVideoWithProvider } from "../application/generation/videoGenerationService";
import { modelIdFromModelRef, providerIdFromModelRef } from "../application/generation/modelRef";
// 2026-05-19 Wave O Entity-first: AutoPipeline 路径需要走 compileShotImagePrompt /
// compileShotVideoPrompt 拼完整自包含 prompt (含 scene/character/element 描述),
// 而不是简陋字符串拼接 shot.prompt_img. ShotStage 单镜路径已经走 compiler 通过
// prompt_override 传过来; orchestrator 自己也要会拼 (兜底 AutoPipeline 路径).
import { buildShotPromptInput } from "../application/generation/shotPromptInput";
import { compileShotImagePrompt, compileShotVideoPrompt } from "../application/generation/shotPromptCompiler";
// 2026-05-26 Fix 4 — prompt_img/vid_nodes 是真理源, 转 short text 兜底 (含 @ 标注)
import { nodesToShortText } from "../../../../packages/drama/src/shotText";
// Wave 4-A (2026-05-16): jobs/orchestrator 主流量改用统一 TargetAdapter 模式落盘 + 写 shot,
// 不再自己重写 writeFile + addAsset + saveToVault + updateShot. 业务后处理(ffprobe / CLIP /
// 末帧抽取 / SSE)仍由 orchestrator 自己持有.
import { getAdapterFor as getImageAdapterFor } from "../application/generation/imageGenerationOrchestrator/registry";
import { getVideoAdapterFor } from "../application/generation/videoGenerationOrchestrator/registry";
import type { ShotGenerationExtras } from "../application/generation/imageGenerationOrchestrator/types";
import type { VideoGenerationExtras } from "../application/generation/videoGenerationOrchestrator/types";
import { readElement, resolveTypicalImages } from "../repositories/elementRepo";
// 2026-07-09 audit C11: 失败分支的 shot.generations 原子追加 (不污染 active_generations),
// 见 shotRepo.appendFailedGeneration 的说明. updateShot(绝对数组) 在同镜并发下会丢已扣费候选.
import { appendFailedGeneration } from "../repositories/shotRepo";
// 2026-05-19 Wave O Entity-first Case B: character/scene 也是用户视角的素材,
// reference_overrides 对它们也应生效. readAnyElement 把 character/scene/element
// 统一成 ElementData 视图, 让 6.4 节 override 处理三类一致.
import { readAnyElement } from "../api/v2/elementController.helpers";
// 2026-05-26 Fix 7 — Cast/IP 跨剧 character/scene fallback. orchestrator 主路径 (entity 预检 +
// 6.4 节 element refs) 走 readEffectiveElement, 没 series-local 时 fallback cast member.
import { readEffectiveElement } from "../application/cast/effectiveElements";
import { ProviderNotSelectedError } from "./errors";
// 2026-05-27 P0-V1 — 真实视频并发锁. 之前 acquire/release 全仓库 0 调用 (死代码),
// 双 tab 同时点视频会双扣费 + 锁状态磁盘永不写入. 现在 orchestrate 视频路径接入.
import { acquireRealVideoLock, releaseRealVideoLock, getRealVideoLockHolder, isRealVideoProvider } from "../../../../packages/core/src/realVideoLock";
// X1-3/X1-4 (A5-5/A6-4): 图像付费 provider 判定 (预算冻结 + 估价 fail-closed), 与 isRealVideoProvider 对称
import { isRealPaidImageProvider } from "../../../../packages/providers/src/core/realPaidImageProviders";
// 2026-05-27 P0-V3 — 视频失败写 FailureCenter, 让用户在 /cockpit/failures 看到
import { appendFailure } from "../repositories/failureRepo";

// ─── Types ──────────────────────────────────────────────────────

export interface OrchestrateOptions {
  series_slug: string;
  episode_id: string;
  action: "generate_first_frames" | "generate_videos";
  count_per_shot: number;
  /** Optional attempt id used by the unified jobs queue to track this dispatch. */
  attempt_id?: string;
  /**
   * Legacy provider id override (e.g. "chatgpt_codex_image"). Selects the
   * provider instance. Kept for backwards compatibility with older callers.
   */
  provider_override?: string;
  /**
   * B5: full ModelPicker model_ref (e.g. "chatgpt_codex_image:gpt-image-2").
   * When set, the orchestrator routes this through imageGenerationService
   * so the colon-suffix model id flows into request.model_id and overrides
   * the adapter's default cfg.model_id. Provider id selection takes priority
   * over `provider_override` when both are set.
   */
  model_ref_override?: string;
  prompt_override?: string;
  seed_override?: number;
  only_shot_ids?: string[];
  requestId?: string;
  /**
   * 2026-05-17 严格做法: caller(controller)从 prompt 文本里解析 @ mention token 后,
   * 把对应的 image asset_id 通过此字段传入. orchestrator 在读 shot.reference_asset_ids
   * 后 merge 这些 extra ids 一起注入 reference_images 给生图模型.
   * 不持久化到 shot — 只本次生成生效, 避免污染 shot 数据.
   */
  reference_asset_ids_extra?: string[];
  /**
   * 单次视频生成可显式指定首帧参考资源。用于“用此视频微调”先从源视频抽帧，
   * 再复用现有 i2v 管线，不污染 shot 的首帧锚点。
   */
  first_frame_asset_id_override?: string;
  /**
   * 2026-05-28 P0#13: dispatch 层用户在 RegenModal / PromptReviewModal 可手动改
   * negative_prompt / 分辨率, 之前完全没透传 orchestrator → 模型永远拿 shot.negative_prompt
   * + renderSpec.width/height. 这里加 override 字段, 单次生成生效, 不污染 shot 数据.
   */
  negative_prompt_override?: string;
  width_override?: number;
  height_override?: number;
  /**
   * 2026-07-10 audit P2-7 — 视频生成时长 override(秒)。
   * 之前前端把 duration_s 发进 body,dry-run 用它估价 + 确认弹窗展示"时长: Xs",
   * 但 dispatch 只写进 pendingJob meta 没透传到这里 → 真正发给 provider 的时长永远是
   * shot.duration_sec || 5(仅靠 ShotStage 主路径先 ensureSaved 把 draft.duration_sec
   * 存进 shot 才偶然自洽)。现在把校验后的 body duration_s 透传到 orchestrate,让
   * "确认弹窗展示/估价所用时长" == "发给 provider 的时长"(同一条数据通路,不再是哑字段)。
   * 单次生成生效,不持久化到 shot。无 override 时回退 shot.duration_sec || 5(旧行为)。
   */
  duration_sec_override?: number;
}

export interface OrchestrateResult {
  job_id: string;
  task_count: number;
  shot_count: number;
  /** S9: 因 RETAKE_LIMIT 被跳过的 shot 数量 */
  skipped: number;
  tasks: Array<{ task_id: string; shot_id: string; status: string }>;
}

// ─── Provider resolution ────────────────────────────────────────

/**
 * W7 (2026-05-15) — 硬熔断:必须显式给定 provider。
 * 不再 silent fallback 到 `local_card_image` / `local_mock_video`(假数据违反质量红线#1)。
 * 优先级:override > series.defaults.{image|video}_provider_id。两者都空 → throw。
 *
 * 路由层(shotStageController / shotController / batch)在调 orchestrate() 之前
 * 必须保证 provider_override 非空,否则上层应直接返回 HTTP 400(toC 人话)。
 * 本函数作为"最后一道防线"在 orchestrate() 入口被调一次做 fail-fast 预校验,
 * 之后每个 task 创建时也会再调一次保持一致。
 */
function resolveProviderId(
  action: "generate_first_frames" | "generate_videos",
  override: string | undefined,
  defaults: { image_provider_id?: string | null; video_provider_id?: string | null }
): string {
  if (override) return override;
  const fromDefaults = action === "generate_first_frames"
    ? defaults.image_provider_id
    : defaults.video_provider_id;
  if (fromDefaults) return fromDefaults;
  throw new ProviderNotSelectedError(action);
}

function resolveShotPrompt(
  action: "generate_first_frames" | "generate_videos",
  shot: ShotData,
  override?: string,
): string {
  const trimmedOverride = override?.trim();
  if (trimmedOverride) return trimmedOverride;
  // 2026-05-26 Fix 4 — *_nodes 真理源转 short text (含 @ 角色:林深 / @林深.img:asset_xxx);
  // plain text 字段是 derived, 已丢 @ 标注. compiler / provider 看到含 @ 字符串能识别 entity 引用.
  const promptVidNodes = nodesToShortText(shot.prompt_vid_nodes).trim();
  const promptImgNodes = nodesToShortText(shot.prompt_img_nodes).trim();
  const actionNodes = nodesToShortText(shot.action_nodes).trim();
  if (action === "generate_videos") {
    return promptVidNodes || shot.prompt_vid
      || promptImgNodes || shot.prompt_img
      || actionNodes || shot.action || "";
  }
  return promptImgNodes || shot.prompt_img
    || promptVidNodes || shot.prompt_vid
    || actionNodes || shot.action || "";
}

function resolveShotSeed(
  action: "generate_first_frames" | "generate_videos",
  shot: ShotData,
  override?: number,
): number | undefined {
  if (override != null) return override;
  if (action === "generate_videos") {
    const picked = shot.generations?.find((g) => g.generation_id === shot.picked_first_frame_generation_id);
    if (picked?.seed != null) return picked.seed;
  }
  return undefined;
}

function buildRequestDigest(payload: Record<string, unknown>): string {
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

/**
 * 2026-05-26 Fix 3 — 把"分镜引用的 element 五类主图 / typical pool"收集成 asset_id 列表.
 *
 * 图像路径 (6.4 节) 和 视频路径 (生成视频时) 都要用统一 element refs, 否则视频跨镜
 * 角色/服装变体丢失 ("老张穿西装在第3镜变 T恤").
 *
 * 优先级 (跟 6.4 节同款):
 *   1. shot.reference_overrides 显式 → 仅推这 1 张
 *   2. typical pool (is_typical=true 全部) → Fix 6
 *   3. fallback primary_image_id / images[0]
 *
 * Cast/IP fallback (Fix 7): readAnyElement 失败 → readEffectiveElement (cast member).
 */
/**
 * 2026-05-27 架构收敛 — 单一 entity-first element reference 收集器, 视频路径 + 图像
 * 路径 6.4 节都调它.
 *
 * 之前架构有三份独立实现 (视频路径自己写一份, 图像 6.4 节内联一份, UI collector 又
 * 一份), 加新字段时容易漏改其中一两份导致"实发图 vs UI 显示 vs prompt 文字段"不
 * 同步 (前段时间发现的 4 张图但 prompt 写'未附参考图' bug 就是这种).
 *
 * 现在视频+图像两条 orchestrator 真发图路径共用本函数 (单一返 shape).
 * UI collector (implicitReferenceCollector.ts) 输出 shape 不同, 暂保留独立但底层
 * 共享 resolveTypicalImages + readAnyElement 等 helper.
 *
 * 收集顺序 (跟前端 SuggestedReference 一致):
 *   character_ids → wardrobe (shot.wardrobe_id 显式 > character 默认) → character.prop_ids
 *     → scene_id → shot.element_ids → shot.prop_ids
 *
 * 每个 element 选图优先级:
 *   1. shot.reference_overrides 显式 → 仅推这 1 张
 *   2. typical pool (is_typical=true 全部) — 用户标 N 张"老张笑/哭/西服"全进
 *   3. fallback primary_image_id → images[0]
 *
 * multi 张时 weight 摊薄 (max(0.4, 0.82/N)) 避免单 element 抢占整池.
 */
async function collectElementReferenceImages(
  series_slug: string,
  shot: ShotData,
): Promise<Array<{ asset_id: string; weight: number }>> {
  const overrideMap = new Map(
    (shot.reference_overrides ?? []).map((o) => [o.element_id, o.image_id]),
  );

  // 收集所有要 resolve 的 element_id (顺序对去重后的图发送顺序有意义)
  const compositionExtraIds: string[] = [];
  for (const charId of shot.character_ids ?? []) {
    const char = await readCharacter(series_slug, charId).catch(() => null);
    if (!char) continue;
    const wardrobeId =
      (shot.wardrobe_id && shot.wardrobe_id.trim()) ||
      char.wardrobe_element_ids?.[0];
    if (wardrobeId) compositionExtraIds.push(wardrobeId);
    for (const pid of char.prop_element_ids ?? []) compositionExtraIds.push(pid);
  }
  for (const pid of shot.prop_ids ?? []) compositionExtraIds.push(pid);

  const elementRefIds = Array.from(new Set([
    ...(shot.character_ids ?? []),
    ...(shot.scene_id ? [shot.scene_id] : []),
    ...(shot.element_ids ?? []),
    ...compositionExtraIds,
  ]));

  const out: Array<{ asset_id: string; weight: number }> = [];
  for (const elementId of elementRefIds) {
    let element = await readAnyElement(series_slug, elementId).catch(() => null);
    if (!element) {
      element = await readEffectiveElement(series_slug, elementId).catch(() => null);
    }
    if (!element) continue;

    // 选图: override 优先 > typical pool > primary fallback
    const overrideImageId = overrideMap.get(elementId);
    let chosenImages: typeof element.images = [];
    if (overrideImageId) {
      const c = element.images.find(
        (img) => img.image_id === overrideImageId || img.asset_id === overrideImageId,
      );
      if (c) chosenImages = [c];
      else {
        loggerSync().warn(
          `[orchestrator] Shot ${shot.id}: reference_overrides 指定 element=${elementId} image=${overrideImageId} 但在 element.images 找不到, fallback typical pool`,
        );
      }
    }
    if (chosenImages.length === 0) {
      const typical = resolveTypicalImages(element);
      if (typical.length > 0) {
        chosenImages = typical;
      } else {
        const p = element.images.find((img) => img.image_id === element.primary_image_id)
          ?? element.images[0];
        if (p) chosenImages = [p];
      }
    }

    const perImageWeight = chosenImages.length > 1 ? Math.max(0.4, 0.82 / chosenImages.length) : 0.82;
    let pushedCount = 0;
    for (const chosen of chosenImages) {
      const refId = chosen?.vault_id ?? chosen?.asset_id;
      if (refId) {
        out.push({ asset_id: refId, weight: perImageWeight });
        pushedCount++;
      }
    }
    if (pushedCount === 0 && (element.image_briefs?.length ?? 0) === 0) {
      loggerSync().info(
        `[orchestrator] Shot ${shot.id}: element=${elementId} 还无图 (placeholder 素材), 走 prompt-only 降级`,
      );
    }
  }
  return out;
}

// ─── Cost estimation ─────────────────────────────────────────────

/** B3: 调用 provider.estimateCost 获取单次任务成本(CNY), 失败/无实现返 0 */
function estimateTaskCost(
  registry: ProviderRegistry,
  providerId: string,
  action: "generate_first_frames" | "generate_videos",
  shot: ShotData,
  durationSecOverride?: number,
): number {
  try {
    const renderSpec = resolveRenderSpec(shot.aspect_ratio);
    if (action === "generate_videos") {
      const vp = registry.getVideo(providerId);
      if (!vp.estimateCost) return 0;
      const est = vp.estimateCost({
        prompt: "",
        // 2026-07-10 audit P2-7: 预算 preflight 估价用的时长必须与真正发给 provider 的时长同源
        // (dispatch 透传的 body duration_s override 优先),否则确认弹窗按 5s 估 ¥3、真按 10s 扣 ¥6。
        duration_sec: durationSecOverride ?? (shot.duration_sec || 5),
        aspect_ratio: renderSpec.aspect_ratio,
      });
      return est.cny;
    } else {
      const ip = registry.getImage(providerId);
      if (!ip.estimateCost) return 0;
      const est = ip.estimateCost({
        prompt: "",
        width: renderSpec.width,
        height: renderSpec.height,
        count: 1,
      });
      return est.cny;
    }
  } catch (err) {
    // X1-3 (A5-5): 估价失败不再一律静默 return 0 绕过预算 preflight。
    // "估算失败"属基础设施/契约问题 (provider.estimateCost 抛异常 = 输入形状未覆盖的 bug),
    // 若静默返 0 → queue.enqueue 的 `costEst>0` 门判假 → budgetGuard.preflight 整段跳过, 用户
    // 已超预算时这一笔付费生成不被硬熔断拦截。故:
    //   - 真实付费 provider → fail-closed: 抛 toC 友好错误, 该镜任务不入队 (保护预算);
    //   - mock / 本地免费 provider → 放行 + warn (估价 0 不影响, 本就不扣费)。
    const realPaid = action === "generate_videos"
      ? isRealVideoProvider(providerId)
      : isRealPaidImageProvider(providerId);
    if (realPaid) {
      throw new BudgetExceededError(
        "无法估算本次生成费用，已停止以保护预算。请稍后重试，或到设置里换用其他模型 / 调整该分镜的模型选择。",
      );
    }
    loggerSync().warn(
      `[orchestrator] estimateTaskCost 失败 (免费/本地 provider ${providerId}, 放行 costEstimate=0): ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

// ─── Limit checking ─────────────────────────────────────────────

function checkLimits(series: SeriesData, shotCount: number, action: string): void {
  const defaults = series.defaults;

  if (action === "generate_videos") {
    const maxSeconds = defaults.max_video_seconds_per_job ?? 300;
    const estimatedSeconds = shotCount * 5; // rough estimate: 5s per shot
    if (estimatedSeconds > maxSeconds) {
      throw Object.assign(
        new Error(`max_video_seconds_per_job exceeded: requested ~${estimatedSeconds}s, limit ${maxSeconds}s`),
        { status: 429 }
      );
    }
  }
}

// ─── Task runner factory ────────────────────────────────────────

/**
 * Real task runner — calls ProviderRegistry to generate first-frame / video,
 * writes the result buffer to disk, records an asset, and updates the shot.
 */
function createRealShotTaskRunner(
  registry: ProviderRegistry,
  series: SeriesData,
  shot: ShotData,
  action: "generate_first_frames" | "generate_videos",
  series_slug: string,
  epId: string,
  options: Pick<OrchestrateOptions, "prompt_override" | "seed_override" | "model_ref_override" | "reference_asset_ids_extra" | "first_frame_asset_id_override" | "negative_prompt_override" | "width_override" | "height_override" | "duration_sec_override"> = {},
) {
  return async (task: { id: string; provider_id?: string; meta: Record<string, any> }, ctx: ProviderContext): Promise<any> => { // intentional: ProviderResponse polymorphic
    const startMs = Date.now();
    // W7-real-fix (2026-05-15): queueTask.meta 不含 provider_id(只 top-level 有),
    // 上一波 W7 只在旧 mock fallback 路径修了 task.provider_id || task.meta?.provider_id,
    // 但忘了在 createRealShotTaskRunner 同步修 —— 这就是用户"卡住"的真根因:
    // task.meta.provider_id 是 undefined → resolveProviderId 进 defaults → null → throw ProviderNotSelectedError
    const providerId = resolveProviderId(action, task.provider_id || task.meta?.provider_id, series.defaults);
    // B5: extract model id (colon-suffix) from model_ref_override so adapters
    // can override their cfg.model_id default per generation.
    const modelIdOverride = modelIdFromModelRef(options.model_ref_override);
    const generationId = `gen_${Date.now()}_${crypto.randomUUID().slice(0, 12)}`;
    const submittedAt = new Date().toISOString();

    // W7-decouple (2026-05-15): 业务路径不再直接 `registry.getVideo/getImage(...)`
    // 选 provider；改成走 generateImagesWithProvider / generateVideoWithProvider。
    // 这里仅保留 fail-fast 健康自检:provider 不存在的话直接 throw,避免后面铺一堆
    // setup 代码再炸。两个 service 内部也会再调一次 registry,这只是 preflight。
    const videoProvider = action === "generate_videos"
      ? registry.getVideo(providerId)
      : undefined;
    if (action !== "generate_videos") {
      registry.getImage(providerId);
    }

    // Build request from shot fields (used only by requestPayload digest below;
    // file writing / vault / asset persistence moved to TargetAdapter in Wave 4-A).
    const kind = action === "generate_videos" ? "video" as const : "image" as const;

    // P180 A5: 从 series.defaults 解析 aspect_ratio,去硬编码
    // 2026-05-27 P1-V1 — shot.aspect_ratio 优先于 series.defaults. 之前只读 series 默认,
    // 用户在某镜改成 9:16 → dry-run 显示 9:16 但真出来 16:9 (用户原话"为什么我改了不
    // 起作用"). 视频路径 dryRun (videoDryRun.ts:146) 已经用的是 shot 优先, 这里跟它对齐.
    const renderSpec = resolveRenderSpec(shot.aspect_ratio || series.defaults.aspect_ratio);

    // 2026-05-19 Wave O Entity-first: 优先级
    //   1. caller 传了 prompt_override (ShotStage 单镜路径已经预编译) → 用它
    //   2. 否则 (AutoPipeline 路径):
    //      2a. 用户在 ShotStage 改过 shot.prompt_img / shot.prompt_vid → 优先用 (铁律 #2)
    //          — 2026-05-26 Fix 2 用户原话: AutoPipeline 必须尊重用户在 ShotStage 改过的画面描述,
    //            不能 silent 用 compiler 重拼覆盖
    //      2b. 否则 → 用 compileShotImagePrompt/Video 拼含 scene/character/element 描述的自包含 prompt
    //   3. compiler 异常 → 回退 shot.prompt_img / shot.prompt_vid 简陋字符串
    //
    // 修复用户报告: "按照系统提示词导入的分镜,画面描述里依旧没有解析@发生的地点.
    //   这样就会导致生成的分镜图和场景图一毛钱关系没有". 真因是 AutoPipeline 走的
    //   是简陋路径, prompt 没场景/角色描述, ChatGPT 拿到 reference_images 但没文本
    //   锚定 → 背景跟"茶水间代表图"对不上.
    let promptText = resolveShotPrompt(action, shot, options.prompt_override);
    // 2026-05-26 Fix 2 + 4 — _nodes 真理源也要检测 (有 @ 标注), 不能只看 plain text 字段
    const userEditedPrompt = action === "generate_videos"
      ? (nodesToShortText(shot.prompt_vid_nodes).trim() || shot.prompt_vid?.trim() || "")
      : (nodesToShortText(shot.prompt_img_nodes).trim() || shot.prompt_img?.trim() || "");
    if (!options.prompt_override?.trim() && !userEditedPrompt) {
      try {
        const compilerInput = await buildShotPromptInput(series_slug, shot);
        const compiled = action === "generate_videos"
          ? compileShotVideoPrompt(compilerInput)
          : compileShotImagePrompt(compilerInput);
        if (compiled.full_prompt && compiled.full_prompt.length > 0) {
          promptText = compiled.full_prompt;
          loggerSync().info(
            `[orchestrator] Shot ${shot.id}: prompt 走 ${action === "generate_videos" ? "compileShotVideoPrompt" : "compileShotImagePrompt"} ` +
              `(含 ${compilerInput.characters?.length ?? 0} 角色, ${compilerInput.scene ? "1" : "0"} 场景, ${compilerInput.elements?.length ?? 0} 素材)`,
          );
        }
      } catch (compileErr) {
        // 兜底: compiler 异常 → 保留 resolveShotPrompt 拿到的简陋字符串, 不阻塞
        const msg = compileErr instanceof Error ? compileErr.message : String(compileErr);
        loggerSync().warn(
          `[orchestrator] Shot ${shot.id}: compileShot${action === "generate_videos" ? "Video" : "Image"}Prompt 失败, 回退 shot.prompt_${action === "generate_videos" ? "vid" : "img"}: ${msg}`,
        );
        sseBroker.emit({
          type: "task.warning",
          task_id: task.id,
          job_id: task.meta?.job_id ?? "",
          data: {
            message: `分镜 ${shot.index} 提示词编译降级：部分素材信息未能拼入，生图可能缺少参考`,
            detail: msg,
          },
          at: new Date().toISOString(),
        });
      }
    } else if (userEditedPrompt && !options.prompt_override?.trim()) {
      loggerSync().info(
        `[orchestrator] Shot ${shot.id}: 使用用户编辑的 shot.prompt_${action === "generate_videos" ? "vid" : "img"} (AutoPipeline 尊重用户改动, 不走 compiler 重拼)`,
      );
    }
    const seedOverride = resolveShotSeed(action, shot, options.seed_override);
    // 2026-07-10 audit P2-7: dispatch 透传的 body duration_s override 优先,与 dry-run 估价 +
    // 确认弹窗展示同源(videoDryRun.ts:147 `Number(input.duration_s) || shot.duration_sec || 5`)。
    // 无 override 时保持旧兜底 shot.duration_sec || 5。
    const durationSec = options.duration_sec_override ?? (shot.duration_sec || 5);

    // ── B2: Compute request payload digest ──
    let finalPromptText = promptText;
    let finalSeed: number | undefined = seedOverride;
    // 2026-05-28 P0#13: dispatch 传过来的 override 优先 (RegenModal 用户改 negative_prompt /
    // 分辨率), 之前完全没透传 → 用户改了等于没改.
    const effectiveNegativePrompt = options.negative_prompt_override ?? shot.negative_prompt;
    const effectiveWidth = options.width_override ?? renderSpec.width;
    const effectiveHeight = options.height_override ?? renderSpec.height;
    let requestPayload: Record<string, unknown> = {
      provider: providerId,
      kind,
      prompt: finalPromptText,
      negative_prompt: effectiveNegativePrompt,
      duration_sec: durationSec,
      aspect_ratio: renderSpec.aspect_ratio,
      width: effectiveWidth,
      height: effectiveHeight,
      fps: renderSpec.fps,
      seed: finalSeed,
    };
    let request_payload_digest = buildRequestDigest(requestPayload);

    /** B2: Result dimensions captured from provider response */
    let resultWidth: number | undefined;
    let resultHeight: number | undefined;
    let resultDurationSec: number | undefined;
    let resultFps: number | undefined; // 2026-05-17: provider 实测 fps (本地 AnimateDiff 8fps, 非 renderSpec.fps 写死的 24)
    let resultCostCny: number | undefined;
    let resultCostCurrency: "CNY" | "USD" | undefined;

    // 2026-07-09 audit C3: 钱一旦从 provider 花出去(拿到 res.cost)就必须记账, 绝不能被后续
    // 可能 throw 的 ffprobe 校验挡在记账之前. 否则视频路径校验失败时 recordCharge 永不执行 →
    // budgetGuard 日账恒为 0, 预算硬熔断(§9.7)被架空, 且失败还被队列重试重复扣费而账本全 0.
    // 幂等: 记一次后置 flag, 尾部块再调只是空跑, 避免视频路径先记后又双记.
    let chargeRecorded = false;
    const recordActualCharge = () => {
      if (chargeRecorded) return;
      chargeRecorded = true;
      if (resultCostCny && resultCostCny > 0) {
        try {
          // T3: pass original currency for audit, CNY amount already converted above
          budgetGuard.recordCharge(resultCostCny, task.meta.job_id, providerId, resultCostCurrency ?? "CNY");
          const currencyNote = resultCostCurrency === "USD" ? " (original USD, converted to CNY)" : "";
          loggerSync().info(`[orchestrator] Shot ${shot.id}: recorded charge ¥${resultCostCny.toFixed(4)} to provider ${providerId}${currencyNote}`);
        } catch (err) {
          loggerSync().warn(`[orchestrator] Shot ${shot.id}: budgetGuard.recordCharge failed:`, err instanceof Error ? err.message : err);
        }
      }
    };

    let buffer: Buffer;
    let resultMime: string;
    /** Wave 3B: prompt prefix for prev last frame continuity */
    let promptPrefix = "";
    /** B2: Quality scores from postGenCheck (images only) */
    let qualityScores: import("../../../../packages/providers/src/quality/postGenCheck").QualityScores | undefined;

    try {
        // ── B2: Prompt pre-check (non-blocking, warning only) ──
        const effectivePrompt = promptText;
        try {
          const precheckResult = precheckPrompt(effectivePrompt);
          if (!precheckResult.pass || precheckResult.issues.length > 0) {
            const issueSummary = precheckResult.issues.map(i => `[${i.type}] ${i.message}`).join("; ");
            loggerSync().warn(`[orchestrator] Shot ${shot.id}: prompt precheck — ${issueSummary} (score=${precheckResult.score.toFixed(2)})`);
            if (precheckResult.fixedPrompt) {
              loggerSync().info(`[orchestrator] Shot ${shot.id}: suggested fixed prompt: "${precheckResult.fixedPrompt.slice(0, 100)}..."`);
            }
          }
        } catch (err) {
          loggerSync().warn(`[orchestrator] Shot ${shot.id}: precheck failed (non-blocking):`, err instanceof Error ? err.message : err);
        }

        if (action === "generate_videos") {
          const videoMode = videoProvider?.mode ?? "t2v";

          // Provider mode is the source of truth. T2V providers must not be blocked
          // by missing first-frame anchors; I2V providers still require one.
          let firstFrameAssetId: string | undefined =
            typeof options.first_frame_asset_id_override === "string" && options.first_frame_asset_id_override.trim()
              ? options.first_frame_asset_id_override.trim()
              : undefined;
          const pickedFfId = shot.picked_first_frame_generation_id;
          if (!firstFrameAssetId && pickedFfId) {
            const allGens = shot.generations ?? [];
            const ffGen = allGens.find(g => g.generation_id === pickedFfId);
            firstFrameAssetId = ffGen?.vault_id || ffGen?.asset_id;
            // 2026-05-27 P1-V3 — 提前显式校验: 用户挑了首帧但那张已失败/已废
            // (没 vault_id/asset_id), 之前 firstFrameAssetId 静默成 undefined,
            // 真打到 i2v provider 才在远端 throw "first_frame required" 报错难懂.
            // 现在显式提示用户重新挑首帧.
            if (!firstFrameAssetId && ffGen) {
              throw Object.assign(
                new Error(`您挑选的首帧没有可用图 (generation ${pickedFfId} 状态=${ffGen.status ?? "unknown"}, 已失败或已废), 请回分镜创作页重新挑首帧`),
                { code: "PICKED_FIRST_FRAME_UNUSABLE", retriable: false }
              );
            }
          }
          if (videoMode === "i2v") {
            if (!firstFrameAssetId) {
              throw Object.assign(
                new Error(`视频 i2v 模式需要首帧参考,但 shot ${shot.id} 未挑选首帧`),
                { code: "MISSING_FIRST_FRAME", retriable: false }
              );
            }
          } else {
            // 2026-05-27 P1-V2 — t2v provider 收到用户挑了 picked 首帧, 但 provider mode=t2v
            // 不会用 → silent 丢. 之前用户切换 Kling(i2v)→MiniMax(t2v) 后第一反应"为什么我
            // 挑的首帧没用上", 无任何提示. 现在 sseBroker 发 task.warning 给前端 toast.
            const isOpenClawLocal = typeof providerId === "string" && providerId.startsWith("local_animatediff");
            if (firstFrameAssetId && !isOpenClawLocal) {
              loggerSync().info(
                `[orchestrator] Shot ${shot.id}: provider ${providerId} (mode=t2v) 不支持首帧参考, 已挑的 picked 首帧将被忽略`,
              );
              sseBroker.emit({
                type: "task.warning",
                task_id: task.id,
                job_id: task.meta?.job_id ?? "",
                data: {
                  shot_id: shot.id,
                  message: `分镜 ${shot.index}: 你选的模型是文生视频 (t2v), 已挑首帧不会用上. 想用首帧请换 Kling / 即梦 / OpenClaw 本地等 i2v 模型.`,
                },
                at: new Date().toISOString(),
              });
            }
          }
          // 2026-05-26 Fix 3 — 视频路径必须 union 五类 element 主图 (character/scene/element/wardrobe/prop),
          // 否则跨镜服装/角色变体丢失. 跟图像路径 6.4 节同款 (含 typical pool 多图 + override 单图 + cast fallback).
          //
          // 视频 mode 行为:
          //   - ref2v: 全部 element refs + first_frame + shot.reference_asset_ids + extra (老逻辑)
          //   - i2v:   仅 first_frame (官方语义), 但 OpenClaw AnimateDiff 双模也认 first_frame=i2v
          //   - t2v:   原本不传 reference, 但 element refs (角色/场景主图) 也要透传给支持的 provider
          const elementRefs = await collectElementReferenceImages(series_slug, shot);
          const elementRefAssetIds = elementRefs.map((r) => r.asset_id);

          // 2026-05-26 audit #3 (a) — 中间关键帧 (frame_anchors role="key") vault_id 加入 refs.
          // 之前 first/end anchor 走专属 first_frame/last_frame 字段, key 中间关键帧 vault_id 只用
          // 在文字提示词的 reference_images_layout 里 (告诉 LLM "这是第 N 秒关键帧"),
          // 但实际图没作为 reference 传给 video provider, 浪费用户标注. 现一起 push 进 refVideoAssetIds.
          const keyFrameAssetIds: string[] = (() => {
            const anchors = shot.frame_anchors;
            if (!anchors || anchors.length === 0) return [];
            return anchors
              .filter(a => a.role === "key")
              .map(a => a.vault_id || a.asset_id)
              .filter((id): id is string => !!id);
          })();
          const refVideoAssetIds = Array.from(new Set([
            ...(videoMode === "ref2v" && firstFrameAssetId ? [firstFrameAssetId] : []),
            ...(videoMode !== "i2v" ? elementRefAssetIds : []), // i2v 严格只走 first_frame, 不掺 element refs
            ...(videoMode !== "i2v" ? keyFrameAssetIds : []),   // 中间关键帧同上, i2v 严格只走 first_frame
            ...(shot.reference_asset_ids ?? []),
            ...(options.reference_asset_ids_extra ?? []),
          ]));
          if (elementRefAssetIds.length > 0 && videoMode !== "i2v") {
            loggerSync().info(
              `[orchestrator] Shot ${shot.id}: video path attached ${elementRefAssetIds.length} element refs (typical pool + cast fallback)`,
            );
          }
          if (keyFrameAssetIds.length > 0 && videoMode !== "i2v") {
            loggerSync().info(
              `[orchestrator] Shot ${shot.id}: video path attached ${keyFrameAssetIds.length} middle key-frame ref(s)`,
            );
          }

          // 2026-05-26 audit #3 (b) — character.locked_seed fallback 给视频路径.
          // 之前 finalSeed 仅来自 picked 首帧 seed (resolveShotSeed), picked 首帧没 seed 时 video provider
          // 拿到 undefined → 随机 seed → 跨镜同一角色脸型差异显著. 现 fallback 到 character.locked_seed:
          // 视频路径跟图像路径 (line 946: finalSeed = seedOverride ?? lockedSeed) 一致.
          if (finalSeed === undefined && shot.character_ids && shot.character_ids.length > 0) {
            for (const charId of shot.character_ids) {
              const char = await readCharacter(series_slug, charId).catch(() => null);
              if (char?.locked_seed !== undefined && char.locked_seed !== null) {
                finalSeed = char.locked_seed;
                loggerSync().info(
                  `[orchestrator] Shot ${shot.id}: video path picked character "${charId}" locked_seed=${finalSeed} as fallback`,
                );
                break;
              }
            }
          }

          requestPayload = {
            provider: providerId,
            kind,
            video_mode: videoMode,
            prompt: finalPromptText,
            negative_prompt: effectiveNegativePrompt,
            duration_sec: durationSec,
            aspect_ratio: renderSpec.aspect_ratio,
            first_frame_asset_id: firstFrameAssetId,
            reference_image_ids: refVideoAssetIds,
            seed: finalSeed,
          };
          request_payload_digest = buildRequestDigest(requestPayload);

          // W7-decouple: 走共享 service,不再直接 vp.generate。Service 内部处理
          // model_ref 拆分 / reference 图解析 / ProviderContext 生成 / registry 选 provider。
          //
          // 2026-05-18: OpenClaw 本地 AnimateDiff 双模特例.
          //   provider.mode = "t2v" (单值字段表达不了双模), 但 provider 内部 latent
          //   injection 支持: 有 first_frame 走 i2v, 无 first_frame 走 t2v.
          //   这里如果是 OpenClaw 本地 provider 且用户有 picked 首帧, 即使 mode="t2v"
          //   也透传 first_frame 给 provider, 让它走 i2v 路径.
          const isOpenClawLocalVideo = typeof providerId === "string" && providerId.startsWith("local_animatediff");
          // 2026-05-27 — zhipu_cogvideox 也支持双模 (有 image_url 跑 i2v, 无跑 t2v),
          // 跟 OpenClaw local 一样 mode 字段说 "t2v" 但内部按 first_frame 判断.
          // 让 orchestrator 把 first_frame 永远透传给这两类 provider, provider 内部
          // 决定要不要用. 之前用户挑了 picked first frame 但 zhipu_cogvideox 的
          // mode="t2v" → orchestrator silent 丢 → 智谱拿不到图, 跨镜一致性失效.
          const isZhipuCogVideo = providerId === "zhipu_cogvideox";
          const passFirstFrameToProvider = (videoMode === "i2v" || isOpenClawLocalVideo || isZhipuCogVideo) && !!firstFrameAssetId;

          // 2026-05-21 X-1: 取 shot.frame_anchors 里 role="end" 的 anchor 作尾帧
          const lastFrameAssetId: string | undefined = (() => {
            const anchors = shot.frame_anchors;
            const endAnchor = anchors?.find(a => a.role === "end");
            return endAnchor?.vault_id || endAnchor?.asset_id || undefined;
          })();

          const res = await generateVideoWithProvider(
            {
              provider_id: providerId,
              model_ref: options.model_ref_override,
              prompt: finalPromptText,
              negative_prompt: effectiveNegativePrompt,
              duration_sec: durationSec,
              aspect_ratio: renderSpec.aspect_ratio,
              first_frame: passFirstFrameToProvider ? { asset_id: firstFrameAssetId } : undefined,
              last_frame: lastFrameAssetId ? { asset_id: lastFrameAssetId } : undefined,
              reference_images: refVideoAssetIds.length > 0
                ? refVideoAssetIds.map((asset_id) => ({ asset_id }))
                : undefined,
              seed: finalSeed,
              series_slug,
              job_id: task.meta?.job_id,
              // 2026-05-27 P0-V2 — 视频预算 preflight 接入. 之前 orchestrator 漏传
              // estimated_cost_cny 给 service, 注释"orchestrator 已 preflight"是误导
              // (orchestrator 全文 0 处 preflight). 现在透传 task.meta.cost_estimate_cny,
              // service preflight 拦截超日预算的 task → 用户设的预算上限真生效, 不会
              // 视频跑 5 镜花到 ¥50 后续 20 镜继续扣 ¥200+.
              estimated_cost_cny: typeof task.meta?.cost_estimate_cny === "number"
                ? task.meta.cost_estimate_cny
                : undefined,
              // 2026-05-21 V-5: orchestrator 自己已 recordCharge (orchestrator.ts:917), service 跳过避免双重计费
              skip_budget_record: true,
              extras: { shot_id: shot.id, episode_id: epId },
            },
            { registry, ctx },
          );
          buffer = res.video.buffer;
          resultMime = res.video.mime;
          logProviderCall({
            requestId: task.meta?.requestId,
            providerId,
            kind: "video",
            durationMs: Date.now() - startMs,
            success: true,
            meta: { shot_id: shot.id, generationId, seed: finalSeed },
          }).catch((e) => { console.warn("[orchestrator] logProviderCall failed:", (e as Error)?.message ?? e); });
          // ── B2: Capture result dimensions from video provider ──
          resultWidth = res.video.width;
          resultHeight = res.video.height;
          resultDurationSec = res.video.duration_sec;
          resultFps = res.video.fps; // 2026-05-17: provider 真实 fps (Lightning/v1-5-2 是 8, 不再写死 24)
          // T3: handle both CNY and USD cost currencies
          if (res.cost) {
            if (res.cost.currency === "USD") {
              const rate = Number(getConfigValue("USD_CNY_RATE", "7.2")) || 7.2;
              resultCostCny = res.cost.amount * rate;
              resultCostCurrency = "USD";
            } else {
              resultCostCny = res.cost.amount;
              resultCostCurrency = res.cost.currency;
            }
          }

          // 2026-07-09 audit C3: 钱已花 → 先记账再做可能 throw 的 ffprobe 校验 (幂等, 尾部块跳过).
          recordActualCharge();

          // ── B1: ffprobe 真视频校验 ──
          {
            // XT-T3 (2026-07-22): process.cwd() 换成 packages/core/src/paths.ts 的 outputsRoot —
            // outputsRoot 用模块自身文件位置 path.resolve(here, "../../..") 算出真实 repoRoot, 不受
            // 进程启动时 cwd 影响 (npm run 脚本 / test runner / IDE 调试配置的 cwd 可能不同, process.cwd()
            // 不保证等于 repoRoot)。跟 apps/server/src/repositories/assetRepo.ts 等既有用法同源。
            const tmpDir = path.join(outputsRoot, "tmp");
            await fs.mkdir(tmpDir, { recursive: true });
            const tmpId = ulid();
            const tmpPath = path.join(tmpDir, `${tmpId}.mp4`);
            await fs.writeFile(tmpPath, buffer);

            const validation = await validateVideoFile(tmpPath, renderSpec.aspect_ratio);

            if (!validation.ok) {
              // 校验失败: 临时文件转存 <DATA_ROOT>/failed_debug/
              // XT-T3 (2026-07-22): 之前 path.join(process.cwd(), "data", "failed_debug") 没跟上
              // 2026-05-27 DATA_ROOT 外部化重构 —— "data/" 目录已经搬到 DATA_ROOT (默认走
              // VIDEO_GENERATE_DATA_ROOT env, 本仓指向 repoRoot 外部的 video-generate-data/),
              // 旧写法会在 repoRoot 内部新建一个从没人看的空壳 data/failed_debug/, 用户诊断校验失败
              // 时去真正的 DATA_ROOT 目录根本找不到调试视频。改用 DATA_ROOT 跟其余仓库代码同源。
              const failedDebugDir = path.join(DATA_ROOT, "failed_debug");
              await fs.mkdir(failedDebugDir, { recursive: true });
              const failedPath = path.join(failedDebugDir, `${tmpId}.mp4`);
              try { await fs.rename(tmpPath, failedPath); } catch { /* rename failed */ }
              loggerSync().error(
                `[orchestrator] Shot ${shot.id}: ffprobe validation FAILED — ${validation.errors.join("; ")} (saved to ${failedPath})`,
              );

              throw new ProviderError({
                message: `ffprobe 视频校验失败: ${validation.errors.join("; ")}`,
                code: "invalid_output",
                provider_id: providerId,
                // 2026-07-09 audit C3: 确定性校验失败(比例/分辨率/时长不符, provider 每次都出同样
                // 结果)重试纯烧钱且账本已在上方记过, 只放大扣费 → retriable:false. 仅"无 video
                // stream"(疑似下载截断/瞬时损坏, has_video_stream=false)保留队列有限重试.
                retriable: !validation.probe.has_video_stream,
              });
            }

            // 校验通过: 以 ffprobe 实测值为准, 覆盖 provider 自报值
            if (validation.probe.duration_sec > 0) {
              resultDurationSec = validation.probe.duration_sec;
              loggerSync().info(
                `[orchestrator] Shot ${shot.id}: ffprobe duration=${validation.probe.duration_sec.toFixed(2)}s`,
              );
            }
            if (validation.probe.width > 0 && validation.probe.height > 0) {
              resultWidth = validation.probe.width;
              resultHeight = validation.probe.height;
              loggerSync().info(
                `[orchestrator] Shot ${shot.id}: ffprobe resolution=${validation.probe.width}x${validation.probe.height}`,
              );
            }

            // 清理临时文件
            try { await fs.unlink(tmpPath); } catch { /* ignore */ }
          }
        } else {
      // ── Wave 2E: 风格板 + 一致性三件套 — buildReferenceSet 统一组装参考图 ──

      // 2026-05-19 Wave O Case B: 先把 reference_overrides 取出来,
      // 让 character/scene/element 三类都按"有 override 时跳过默认路径, 单独走 6.4 节"逻辑.
      //
      // 2026-05-20 单图主图语义 (用户当面纠正):
      //   "同时输出多张图片那视频模型能明白吗, 到底用哪张每个地方只用特定的一张, 没选的话默认主图"
      //
      // 这意味着 character/scene 也只用 1 张图 — 而不再走 buildReferenceSet 把
      // reference_image_set 全部入列. 全部走 6.4 节统一 element 流: 默认主图 + override 单图.
      //
      // 因此把 overrideMap 视为"显式 override 选第 N 张", 没 override 用 primary.
      // character/scene/element 三类完全统一, buildReferenceSet 仅保留给 mood_board (风格板).
      const overrideMap = new Map(
        (shot.reference_overrides ?? []).map((o) => [o.element_id, o.image_id]),
      );

      // 2026-05-20 P1 audit Bug 6: 收集 entity 不可解析 (脏数据 / 占位未建) 的 missing 上报.
      // 之前 readCharacter/readScene 返 null 时 silent skip, 用户看不到为什么角色像变了个人.
      const entityMissing: Array<{
        source_type: "character" | "scene";
        source_id: string;
        source_label: string;
        vault_id: string;
        reason: "entity_not_resolvable";
      }> = [];

      // 2026-05-20 单图主图语义: character/scene/element 统一走 6.4 节 (默认主图 + override 单图).
      // 不再走 buildReferenceSet 把 reference_image_set 全部入列 — 那会让模型混乱.
      //
      // 1./2. 节仅做 entity 可解析性预检 + 收 locked_seed (后续 video provider 用),
      //       不再 push 任何图入 referenceImages.
      let lockedSeed: number | undefined;
      if (shot.character_ids && shot.character_ids.length > 0) {
        for (const charId of shot.character_ids) {
          const char = await readCharacter(series_slug, charId);
          if (char) {
            if (lockedSeed === undefined && char.locked_seed !== undefined) {
              lockedSeed = char.locked_seed;
            }
          } else {
            // 2026-05-26 Fix 7 — series-local 没找到时, 走 cast member fallback 不算 missing
            const eff = await readEffectiveElement(series_slug, charId).catch(() => null);
            if (!eff) {
              entityMissing.push({
                source_type: "character",
                source_id: charId,
                source_label: charId,
                vault_id: "",
                reason: "entity_not_resolvable",
              });
            }
          }
        }
      }
      if (shot.scene_id) {
        const scene = await readScene(series_slug, shot.scene_id);
        if (!scene) {
          // 2026-05-26 Fix 7 — cast member fallback for scene
          const eff = await readEffectiveElement(series_slug, shot.scene_id).catch(() => null);
          if (!eff) {
            entityMissing.push({
              source_type: "scene",
              source_id: shot.scene_id,
              source_label: shot.scene_id,
              vault_id: "",
              reason: "entity_not_resolvable",
            });
          }
        }
      }

      // 3. 读取风格板前 3 张
      let moodBoardRefs: Array<{ vault_id: string; abs_path: string; weight: number; note: string }> = [];
      try {
        moodBoardRefs = await getMoodBoardRefImages(series_slug, 3);
      } catch (err) {
        loggerSync().warn(`[orchestrator] Shot ${shot.id}: failed to get mood board refs:`, err instanceof Error ? err.message : err);
      }

      // 4. 检查 provider 的参考图能力
      const preset = getPreset("image_provider", providerId);
      const supportsRef = preset?.supports_reference_image !== false;
      const supportsMultiRef = preset?.supports_multi_reference === true;

      // 5. vault_id → 文件绝对路径 解析器
      // 2026-05-20 P1 红线 #1: 返回结构化 { ok, reason } 而非 null, 让 buildReferenceSet
      // 能 push 到 missing[] 给前端显式上报, 取代旧 silent skip 行为
      const vaultResolver = async (vaultId: string): Promise<
        | string
        | { ok: false; reason: "vault_not_found" | "file_missing" | "resolve_failed" }
      > => {
        let vaultEntry: Awaited<ReturnType<typeof getVaultEntry>>;
        try {
          vaultEntry = await getVaultEntry(vaultId);
        } catch {
          return { ok: false, reason: "resolve_failed" };
        }
        if (!vaultEntry) return { ok: false, reason: "vault_not_found" };
        const absPath = getVaultAbsolutePath(vaultEntry);
        try {
          await fs.access(absPath);
          return absPath;
        } catch {
          return { ok: false, reason: "file_missing" };
        }
      };

      // 6. 仅风格板 (mood_board) 走 buildReferenceSet — character/scene 已统一到 6.4 节单图.
      // 2026-05-20 修正: 不再传 characters / scene 给 buildReferenceSet,
      // 因为 character/scene 改走 6.4 节单图主图语义.
      const refSet = await buildReferenceSet({
        characters: [],
        scene: null,
        moodBoardRefs,
        supportsMultiReference: supportsMultiRef,
        resolveVaultPath: vaultResolver,
      });

      const referenceImages = [...refSet.images]; // 浅拷贝, 仅含 mood_board 图

      loggerSync().info(
        `[orchestrator] Shot ${shot.id}: built mood_board reference set — total=${refSet.summary.mood_board_refs}${lockedSeed !== undefined ? `, locked_seed=${lockedSeed}` : ""}`
      );

      // 2026-05-20 P1 红线 #1 + 铁律 0 Entity-first: 把参考图解析失败明确上报给前端,
      // 不再 silent skip. 前端 GlobalQueuePanel / ShotStagePage 监听 references.missing
      // event 后 toast "X 张参考图未找到, 影响视觉一致性" — 让用户看到为什么这次角色像变了个人.
      const allMissing = [...refSet.missing, ...entityMissing];
      if (allMissing.length > 0) {
        loggerSync().warn(
          `[orchestrator] Shot ${shot.id}: ${allMissing.length} reference(s) missing — ${allMissing.map(m => `${m.source_type}:${m.source_label}(${m.reason})`).join(", ")}`
        );
        sseBroker.broadcast(
          "references.missing",
          {
            series_slug,
            episode_id: epId,
            shot_id: shot.id,
            missing: allMissing,
          },
          task.meta?.job_id,
        );
      }

      if (!supportsMultiRef && refSet.summary.total > 1) {
        loggerSync().info(
          `[orchestrator] Provider "${providerId}" supports_multi_reference=false, using only primary image from each source (${refSet.summary.total} sources trimmed)`
        );
      }

      // 6.4. Unified Element references — character/scene/element/wardrobe/prop 五类统一单图语义.
      // 2026-05-27 架构收敛 — 之前这里和视频路径 collectElementReferenceImages 各写一份
      // (差几乎 0 字), 改一处忘改另一处的隐患. 现在两条 orchestrator 真发图路径共用
      // 同一个函数. (UI collector implicitReferenceCollector.ts 输出 shape 不同保留独立.)
      const unifiedRefs = await collectElementReferenceImages(series_slug, shot);
      for (const ref of unifiedRefs) {
        referenceImages.push(ref);
      }
      if (unifiedRefs.length > 0) {
        loggerSync().info(
          `[orchestrator] Shot ${shot.id}: attached ${unifiedRefs.length} unified element reference(s)` +
            (overrideMap.size > 0 ? ` (with ${overrideMap.size} override(s))` : ""),
        );
      }

      // 6.5. Shot-level references uploaded/connected in the stage UI.
      // These are intentionally passed as IDs here; the raw image generation
      // service resolves vault IDs / series asset IDs / absolute paths to files.
      // 2026-05-17 严格做法: merge caller 解析 @ mention token 提取的 extra ids (不持久化)
      const manualRefIds = Array.from(new Set([
        ...(shot.reference_asset_ids ?? []),
        ...(options.reference_asset_ids_extra ?? []),
      ]));
      for (const refId of manualRefIds) {
        referenceImages.push({ asset_id: refId, weight: 0.75 });
      }
      if (manualRefIds.length > 0) {
        const extraCount = options.reference_asset_ids_extra?.length ?? 0;
        loggerSync().info(`[orchestrator] Shot ${shot.id}: attached ${manualRefIds.length} shot reference image(s)${extraCount > 0 ? ` (incl. ${extraCount} from @ mention)` : ""}`);
      }

      // 7. Wave 3B: 使用上一镜末帧作为参考 ──
      promptPrefix = "";
      if (shot.use_prev_last_frame && shot.index > 1) {
        try {
          const allShots = await listShots(series_slug, epId);
          const prevShot = allShots.find(s => s.index === shot.index - 1);
          if (prevShot?.last_frame_vault_id) {
            const vaultEntry = await getVaultEntry(prevShot.last_frame_vault_id);
            if (vaultEntry) {
              const absPath = getVaultAbsolutePath(vaultEntry);
              try {
                await fs.access(absPath);
                referenceImages.push({ asset_id: absPath, weight: 0.9 });
                promptPrefix = "基于上一镜末帧画面连续构图。";
                loggerSync().info(`[orchestrator] Shot ${shot.id}: using prev shot ${prevShot.id} last frame as reference (vault: ${prevShot.last_frame_vault_id})`);
              } catch {
                loggerSync().warn(`[orchestrator] Shot ${shot.id}: prev shot last frame file not found: ${absPath}`);
              }
            }
          }
        } catch (err) {
          loggerSync().warn(`[orchestrator] Shot ${shot.id}: failed to look up prev last frame:`, err instanceof Error ? err.message : err);
        }
      }

      // 8. 风格权重提示 (基于 moodBoardRefs)
      const highWeightRefs = moodBoardRefs.filter(r => r.weight >= 0.7);
      const lowWeightRefs = moodBoardRefs.filter(r => r.weight < 0.7);
      if (highWeightRefs.length > 0) {
        promptPrefix = (promptPrefix ? promptPrefix + " " : "") + "风格强参考（权重高）。";
      } else if (lowWeightRefs.length > 0) {
        promptPrefix = (promptPrefix ? promptPrefix + " " : "") + "仅色调参考（权重低）。";
      }

      // 9. Provider 不支持参考图 → 仅 log, 不传 reference_images
      if (referenceImages.length > 0 && !supportsRef) {
        loggerSync().warn(
          `[orchestrator] Provider "${providerId}" does not support reference images (supports_reference_image=${preset?.supports_reference_image ?? "undefined"}), generating without reference_images. Consider switching to a provider that supports it (e.g. openrouter_gemini_image).`
        );
      }

      // 10. 构建 generateInput (含 locked_seed)
      finalPromptText = promptPrefix ? promptPrefix + " " + promptText : promptText;
      finalSeed = seedOverride ?? lockedSeed;
      const generateInput: ImageGenerateRequest = {
        prompt: finalPromptText,
        negative_prompt: effectiveNegativePrompt,
        width: effectiveWidth,
        height: effectiveHeight,
        count: 1,
        seed: finalSeed,
        extras: { shot_id: shot.id, episode_id: epId },
      };
      requestPayload = {
        provider: providerId,
        kind,
        prompt: generateInput.prompt,
        negative_prompt: effectiveNegativePrompt,
        width: effectiveWidth,
        height: effectiveHeight,
        count: 1,
        seed: finalSeed,
        reference_image_ids: referenceImages.map((r) => r.asset_id),
      };
      request_payload_digest = buildRequestDigest(requestPayload);

      if (referenceImages.length > 0 && supportsRef) {
        generateInput.reference_images = referenceImages;
        loggerSync().info(
          `[orchestrator] Generating with ${referenceImages.length} reference image(s): ${referenceImages.map((r) => r.asset_id.slice(-40)).join(", ")}`
        );
      }

      // Wave 2E: 传递 locked_seed 给 provider
      if (finalSeed !== undefined) {
        loggerSync().info(`[orchestrator] Shot ${shot.id}: using seed=${finalSeed}`);
      }

      const res = await generateImagesWithProvider(
        {
          provider_id: providerId,
          // B5: forward full ModelPicker ref so the service can split it into
          // provider_id + model_id and pass model_id to the adapter.
          model_ref: options.model_ref_override,
          ...generateInput,
          series_slug,
          strict_reference_images: false,
          // 2026-05-21 V-5: orchestrator 自己已 recordCharge (orchestrator.ts:917), service 跳过避免双重计费
          skip_budget_record: true,
        },
        { registry, ctx },
      );
      buffer = res.images[0].buffer;
      resultMime = res.images[0].mime;
      logProviderCall({
        requestId: task.meta?.requestId,
        providerId,
        kind: "image",
        durationMs: Date.now() - startMs,
        success: true,
        meta: { shot_id: shot.id, generationId, seed: finalSeed },
      }).catch((e) => { console.warn("[orchestrator] logProviderCall failed:", (e as Error)?.message ?? e); });
      // ── B2: Capture result dimensions from image provider ──
      resultWidth = res.images[0].width;
      resultHeight = res.images[0].height;
      // T3: handle both CNY and USD cost currencies
      if (res.cost) {
        if (res.cost.currency === "USD") {
          const rate = Number(getConfigValue("USD_CNY_RATE", "7.2")) || 7.2;
          resultCostCny = res.cost.amount * rate;
          resultCostCurrency = "USD";
        } else {
          resultCostCny = res.cost.amount;
          resultCostCurrency = res.cost.currency;
        }
      }

      // ── B2: Post-generation quality check + retry on low quality ──
      const retryOnLowQuality = series.defaults.retry_on_low_quality !== false; // default true
      try {
        qualityScores = await postGenCheck(buffer, {
          prompt: finalPromptText,
          character_ids: shot.character_ids,
        });
        // 2026-05-18: 任一维度可能 undefined (未评分). 日志只显示有值的, 不强制 toFixed.
        const fmt = (n: number | undefined) => (typeof n === "number" ? n.toFixed(2) : "n/a");
        loggerSync().info(
          `[orchestrator] Shot ${shot.id}: quality scores — composition=${fmt(qualityScores.composition)}, sharpness=${fmt(qualityScores.sharpness)}, alignment=${fmt(qualityScores.prompt_alignment)}, subject=${fmt(qualityScores.subject_completeness)}`
        );

        // 2026-05-18: 阈值检查只看真分 (number), 未评分维度跳过. 没任何真分 → 跳过阈值重抽逻辑.
        const QUALITY_THRESHOLD = 0.35;
        const numericScores: number[] = [
          qualityScores.composition,
          qualityScores.sharpness,
          qualityScores.prompt_alignment,
          qualityScores.subject_completeness,
        ].filter((v): v is number => typeof v === "number");
        const minScore = numericScores.length > 0 ? Math.min(...numericScores) : 1;
        if (numericScores.length > 0 && minScore < QUALITY_THRESHOLD && retryOnLowQuality) {
          loggerSync().warn(
            `[orchestrator] Shot ${shot.id}: quality too low (min=${minScore.toFixed(2)} < ${QUALITY_THRESHOLD}), retrying once...`
          );
          // Retry generation once
          const retryRes = await generateImagesWithProvider(
            {
              provider_id: providerId,
              // B5: also forward model_ref on retry path.
              model_ref: options.model_ref_override,
              ...generateInput,
              series_slug,
              strict_reference_images: false,
              // 2026-05-21 V-5: orchestrator 自己 recordCharge, service 跳过避免双重计费
              skip_budget_record: true,
            },
            { registry, ctx },
          );
          // 2026-07-09 audit C19: 低质重试的第二次生成同样真实扣费 — 无论最终是否采用都得按
          // 真实成本记账, 否则 budgetGuard 只记第一次, 日/单作业预算硬熔断按低于真实花费的口径
          // 放行 → 实际超预算. 币种换算与首次成本一致 (USD→CNY 用 USD_CNY_RATE).
          if (retryRes.cost && retryRes.cost.amount > 0) {
            const retryCurrency: "CNY" | "USD" = retryRes.cost.currency === "USD" ? "USD" : "CNY";
            const retryCny = retryCurrency === "USD"
              ? retryRes.cost.amount * (Number(getConfigValue("USD_CNY_RATE", "7.2")) || 7.2)
              : retryRes.cost.amount;
            try {
              budgetGuard.recordCharge(retryCny, task.meta.job_id, providerId, retryCurrency);
              loggerSync().info(`[orchestrator] Shot ${shot.id}: recorded retry charge ¥${retryCny.toFixed(4)} to provider ${providerId}`);
            } catch (err) {
              loggerSync().warn(`[orchestrator] Shot ${shot.id}: budgetGuard.recordCharge (retry) failed:`, err instanceof Error ? err.message : err);
            }
          }
          const retryScores = await postGenCheck(retryRes.images[0].buffer, {
            prompt: finalPromptText,
            character_ids: shot.character_ids,
          });
          const retryNumeric: number[] = [
            retryScores.composition,
            retryScores.sharpness,
            retryScores.prompt_alignment,
            retryScores.subject_completeness,
          ].filter((v): v is number => typeof v === "number");
          const retryMin = retryNumeric.length > 0 ? Math.min(...retryNumeric) : 1;
          // Use retry result if it's better, otherwise keep original
          if (retryMin > minScore) {
            buffer = retryRes.images[0].buffer;
            resultMime = retryRes.images[0].mime;
            qualityScores = retryScores;
            loggerSync().info(
              `[orchestrator] Shot ${shot.id}: retry improved quality (min=${retryMin.toFixed(2)} > ${minScore.toFixed(2)}), using retry result`
            );
          } else {
            loggerSync().info(
              `[orchestrator] Shot ${shot.id}: retry did not improve quality, keeping original`
            );
          }
        }
      } catch (err) {
        loggerSync().warn(`[orchestrator] Shot ${shot.id}: postGenCheck failed (non-blocking):`, err instanceof Error ? err.message : err);
      }
    }

    // ── M1: Record actual charge after successful generation ──
    // 2026-07-09 audit C3: 视频路径已在 ffprobe 校验前记过账(钱已花, 不能被校验 throw 挡住),
    // 这里幂等空跑; 图片路径在此首次记账 (postGenCheck 非阻塞, 走到这里说明生成成功).
    recordActualCharge();

    // C4: 记录当前 prompt 版本号
    const promptVersions = action === "generate_first_frames"
      ? (shot.prompt_img_versions ?? [])
      : (shot.prompt_vid_versions ?? []);
    const currentPromptVersion = promptVersions.length > 0
      ? promptVersions[promptVersions.length - 1].version
      : undefined;

    // ── Wave 4-A (2026-05-16): 统一 TargetAdapter 落盘 ─────────────────
    // 不再自己重写 writeFile + addAsset + saveToVault + 更新 shot.generations.
    // adapter 持有完整的"写文件 + 写 vault + 写 asset + 写 shot.generations"流程,
    // 通过 generation_extras 接收 orchestrator 做完业务后处理的额外字段(quality_scores /
    // prompt_version / request_payload_digest / cost_cny / submitted_at / 末帧 vault 等).
    // 路径(outputs/series/<slug>/episodes/<ep>/assets/<gen>.<ext>) 与原 orchestrator 一致,
    // compose/render/export 等下游期望不变.
    const completedAt = new Date().toISOString();
    const downloadedAt = completedAt;
    const finalPromptFinal = promptPrefix ? promptPrefix + " " + promptText : promptText;
    let generation: ShotGeneration;
    let persistedAbsPath: string | undefined;
    let persistedVaultId: string | undefined;

    if (action === "generate_videos") {
      const videoExtras: VideoGenerationExtras = {
        generation_id: generationId,
        prompt_version: currentPromptVersion,
        provider_job_id: task.meta?.provider_job_id,
        provider_file_id: task.meta?.provider_file_id,
        model_id: providerId,
        request_payload_digest,
        prompt_final: finalPromptFinal,
        prompt_used: finalPromptText,
        negative_prompt: shot.negative_prompt,
        duration_sec_requested: durationSec,
        duration_sec_actual: resultDurationSec,
        // 2026-05-17: provider 实测 fps 优先 (本地 AnimateDiff 是 8); 没返就 fallback series renderSpec
        fps: resultFps ?? renderSpec.fps,
        cost_cny: resultCostCny,
        submitted_at: submittedAt,
        completed_at: completedAt,
        downloaded_at: downloadedAt,
      };
      const videoAdapter = getVideoAdapterFor("shot_video");
      const persistedVideo = await videoAdapter.persist({
        video: {
          buffer,
          mime: resultMime,
          width: resultWidth,
          height: resultHeight,
          duration_sec: resultDurationSec ?? durationSec,
        },
        target: {
          kind: "shot_video",
          series_slug,
          target_id: shot.id,
          meta: { episode_id: epId },
        },
        provider_id: providerId,
        request: {
          prompt: finalPromptText,
          provider_id: providerId,
          model_ref: options.model_ref_override,
          duration_sec: durationSec,
          aspect_ratio: renderSpec.aspect_ratio,
          seed: finalSeed,
          job_id: task.meta?.job_id,
          task_id: task.id,
          target: {
            kind: "shot_video",
            series_slug,
            target_id: shot.id,
            meta: { episode_id: epId },
          },
          generation_extras: videoExtras,
        },
      });
      persistedAbsPath = persistedVideo.abs_path;
      persistedVaultId = persistedVideo.vault_id;
    } else {
      const imageExtras: ShotGenerationExtras = {
        generation_id: generationId,
        quality_scores: qualityScores,
        prompt_version: currentPromptVersion,
        provider_job_id: task.meta?.provider_job_id,
        provider_file_id: task.meta?.provider_file_id,
        model_id: providerId,
        request_payload_digest,
        prompt_final: finalPromptFinal,
        prompt_used: finalPromptText,
        negative_prompt: shot.negative_prompt,
        duration_sec_requested: durationSec,
        fps: renderSpec.fps,
        cost_cny: resultCostCny,
        submitted_at: submittedAt,
        completed_at: completedAt,
        downloaded_at: downloadedAt,
        first_frame_from_prev: !!promptPrefix,
      };
      const imageAdapter = getImageAdapterFor("shot_first_frame");
      const persistedImage = await imageAdapter.persist({
        image: {
          buffer,
          mime: resultMime,
          width: resultWidth,
          height: resultHeight,
          seed: finalSeed,
        },
        target: {
          kind: "shot_first_frame",
          series_slug,
          target_id: shot.id,
          meta: { episode_id: epId },
        },
        provider_id: providerId,
        request: {
          prompt: finalPromptText,
          provider_id: providerId,
          model_ref: options.model_ref_override,
          width: renderSpec.width,
          height: renderSpec.height,
          seed: finalSeed,
          job_id: task.meta?.job_id,
          task_id: task.id,
          target: {
            kind: "shot_first_frame",
            series_slug,
            target_id: shot.id,
            meta: { episode_id: epId },
          },
          generation_extras: imageExtras,
        },
        batch_index: 0,
      });
      persistedAbsPath = persistedImage.abs_path;
      persistedVaultId = persistedImage.vault_id;
    }

    // ── B2: Store quality scores in vault entry (adapter 不写, vault 元数据需要单独更新) ──
    if (persistedVaultId && qualityScores) {
      try {
        await updateVaultEntry(persistedVaultId, { quality_scores: qualityScores });
      } catch (err) {
        loggerSync().warn(`[orchestrator] Failed to store quality_scores in vault ${persistedVaultId}:`, err instanceof Error ? err.message : err);
      }
    }

    // ── Wave 3B: 视频生成成功后抽末帧存入 vault ──
    // 必须在 adapter 写完文件后才能跑 ffmpeg, 然后再 patch shot.last_frame_vault_id.
    if (action === "generate_videos" && persistedAbsPath) {
      try {
        const outputDir = path.dirname(persistedAbsPath);
        const lastFrameFilename = `${generationId}_lastframe.png`;
        const lastFramePath = path.join(outputDir, lastFrameFilename);
        const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
        // B6: use runProcess (spawn + 64KB ring + timeout) — no shell-string injection
        const ffResult = await runProcess(
          ffmpegPath,
          ["-sseof", "-0.1", "-i", persistedAbsPath, "-vframes", "1", "-y", lastFramePath],
          { timeoutMs: 30_000 },
        );
        if (ffResult.code !== 0) {
          throw new Error(`ffmpeg last-frame extraction failed (exit ${ffResult.code}): ${ffResult.stderr.slice(-500)}`);
        }
        try {
          await fs.access(lastFramePath);
          const lastFrameBuffer = await fs.readFile(lastFramePath);
          const vaultEntry = await saveToVault({
            buffer: lastFrameBuffer,
            kind: "image",
            mime: "image/png",
            context: {
              kind: "last_frame_of",
              series_slug,
              shot_id: shot.id,
            },
            provider_id: providerId,
            width: renderSpec.width,
            height: renderSpec.height,
          });
          await updateShot(series_slug, epId, shot.id, { last_frame_vault_id: vaultEntry.vault_id });
          loggerSync().info(`[orchestrator] Shot ${shot.id}: last frame extracted -> vault ${vaultEntry.vault_id}`);
        } catch {
          // last frame file not accessible after ffmpeg — silently skip
        }
      } catch (err) {
        loggerSync().warn(`[orchestrator] Shot ${shot.id}: failed to extract last frame:`, err instanceof Error ? err.message : err);
      }
    }

    // 重读 shot 的最新 generation 记录(adapter 刚刚 append 进去). orchestrator 上游
    // SSE / CLIP 评分 / 失败兜底等代码用这个 generation 对象, 字段需要齐全.
    {
      const fresh = await readShot(series_slug, epId, shot.id);
      const matched = fresh?.generations?.find((g) => g.generation_id === generationId);
      generation = matched ?? {
        // 兜底: adapter 落盘成功但 readShot 读不到(极端竞态), 拼一份 minimal 记录回给 caller
        generation_id: generationId,
        type: action === "generate_first_frames" ? "first_frame" : "video",
        provider: providerId,
        created_at: submittedAt,
        status: "done",
        picked: false,
        prompt: finalPromptText,
        prompt_used: finalPromptText,
        bytes: buffer.length,
      };
    }

    return generation;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const errorCode = (err instanceof ProviderError ? err.code : undefined) ?? "unknown";
        loggerSync().error(`[orchestrator] Shot ${shot.id}: generation failed — ${errorCode}: ${errorMsg}`, err);

        logProviderCall({
          requestId: task.meta?.requestId,
          providerId,
          kind: action === "generate_videos" ? "video" : "image",
          durationMs: Date.now() - startMs,
          success: false,
          error: errorMsg,
          meta: { shot_id: shot.id, seed: finalSeed },
        }).catch((e) => { console.warn("[orchestrator] logProviderCall failed:", (e as Error)?.message ?? e); });

        // B2: Build failed generation record with available fields
        const failedGeneration: ShotGeneration = {
          generation_id: generationId,
          type: action === "generate_first_frames" ? "first_frame" : "video",
          provider: providerId,
          created_at: submittedAt,
          status: "failed",
          error: errorMsg,
          seed: finalSeed,
          prompt: finalPromptText,
          prompt_used: finalPromptText,
          request_payload_digest,
          prompt_final: finalPromptText,
          negative_prompt: shot.negative_prompt,
          duration_sec_requested: durationSec,
          width: renderSpec.width,
          height: renderSpec.height,
          fps: renderSpec.fps,
          submitted_at: submittedAt,
          completed_at: new Date().toISOString(),
          error_code: errorCode,
          error_message: errorMsg,
          model_id: providerId,
        };

        // Update shot with failed generation record
        // 2026-07-09 audit C11: 原来 readShot(锁外) → updateShot(绝对 generations 数组) 会在同镜
        // 并发(count_per_shot≥2: 本 runner 失败落盘时, 并发的成功 runner 刚经 appendGeneration
        // 原子 append 出一张已扣费候选)竞态覆盖, 把成功候选冲掉. 改走 appendFailedGeneration
        // 锁内重读再拼: 原子, 且失败记录只进 generations 不污染 active_generations (S7).
        try {
          await appendFailedGeneration(series_slug, epId, shot.id, failedGeneration, {
            at: new Date().toISOString(),
            stage: action === "generate_first_frames" ? "image" : "video",
            error: errorMsg,
          });
        } catch (updateErr) {
          loggerSync().error(`[orchestrator] Failed to update shot ${shot.id} on error:`, updateErr);
        }

        throw err;
      }
    };
}

// ─── Orchestrator ───────────────────────────────────────────────

export class JobOrchestrator {
  private _queue: TaskQueue;
  private _defaultRetries: number;
  private _registry: ProviderRegistry | null;

  constructor(opts?: { max_parallel?: number; default_retries?: number; registry?: ProviderRegistry }) {
    const maxParallel = opts?.max_parallel ?? 3;
    this._defaultRetries = opts?.default_retries ?? 2;
    this._registry = opts?.registry ?? null;

    this._queue = new TaskQueue({
      max_parallel: maxParallel,
      default_retries: this._defaultRetries,
      default_timeout_ms: 900_000, // P180 A7: video-friendly default (15min), individual tasks override per preset
      on_progress: (taskId, status, meta) => {
        if (status === "running") {
          updateTaskRecord(taskId, { status: "running" });
          sseBroker.emit({
            type: "task.running",
            job_id: meta?.job_id ?? "",
            task_id: taskId,
            data: { shot_id: meta?.shot_id },
            at: new Date().toISOString(),
          });
        }
      },
    });
  }

  /** Inject the provider registry (call after construction). */
  setRegistry(registry: ProviderRegistry): void {
    this._registry = registry;
  }

  /**
   * Abort all tasks belonging to a job_id.
   */
  abortJob(jobId: string): void {
    this._queue.abortJob(jobId);
  }

  /**
   * P180 A6 + S1: 真正 abort 单个 task。
   * - 调 TaskQueue.abort (AbortController)
   * - 若 provider 支持 cancel, 尝试取消远端任务
   * - 标记 status + 返回 cancel_result
   */
  async abortTask(taskId: string): Promise<{ ok: boolean; status: string; cancel_result?: string; reason?: string }> {
    const taskRecord = getTask(taskId);
    if (!taskRecord) {
      return { ok: false, status: "not_found", reason: "任务不存在" };
    }

    if (taskRecord.status === "done" || taskRecord.status === "failed") {
      return { ok: false, status: "terminal", reason: "任务已终态" };
    }

    const providerId = taskRecord.meta?.provider_id as string | undefined;

    // S1: 从 task meta 或 inflightStore 查找 provider_job_id
    let providerJobId = taskRecord.meta?.provider_job_id as string | undefined;
    if (!providerJobId && providerId) {
      try {
        const allInflight = await loadAllInflight();
        const match = allInflight.find(
          r => r.provider_id === providerId && r.context?.shot_id === taskId
        );
        if (match) providerJobId = match.provider_job_id;
      } catch { /* inflight lookup best-effort */ }
    }

    // 1. Abort local queue task (AbortController)
    this._queue.abort(taskId);

    // 2. S1: 尝试调 provider.cancel 取消远端任务
    let cancelResult: string = "aborted_local";
    if (providerId && providerJobId && this._registry) {
      try {
        const vp = this._registry.getVideo(providerId);
        if (vp.cancel) {
          const providerCtx: ProviderContext = {
            series_slug: (taskRecord.meta?.series_slug as string) || "",
            job_id: taskRecord.job_id,
            task_id: taskId,
            log: (level, msg, meta) => loggerSync()[level](`[abortTask] ${msg}`, meta),
            signal: new AbortController().signal,
          };
          const result = await vp.cancel(providerJobId, providerCtx);
          if (result === "cancelled") {
            cancelResult = "provider_cancelled";
          } else if (result === "unsupported") {
            cancelResult = "provider_cancel_unsupported";
          } else {
            cancelResult = "provider_cancel_failed";
          }
        } else {
          cancelResult = "provider_cancel_unsupported";
        }
      } catch {
        cancelResult = "provider_cancel_failed";
      }
    }

    // 3. Update task record status
    updateTaskRecord(taskId, { status: "failed", error: "aborted by user" });

    sseBroker.emit({
      type: "task.failed",
      job_id: taskRecord.job_id,
      task_id: taskId,
      data: { error: "aborted by user", cancel_result: cancelResult },
      at: new Date().toISOString(),
    });

    return { ok: true, status: cancelResult, cancel_result: cancelResult };
  }

  /** Expose queue stats for diagnostics / cockpit page */
  queueStats(): { queued: number; running: number; done: number; failed: number } {
    return this._queue.stats();
  }

  /**
   * Orchestrate generation for all shots in an episode.
   * Creates a job_id, enqueues sub-tasks, returns immediately with task info.
   */
  async orchestrate(opts: OrchestrateOptions): Promise<OrchestrateResult> {
    // Step 1: 目标解析 — 根据 action 类型加载 series, 划 shots, 检查 limits, 生成 job_id
    const targets = await this._resolveTargets(opts);

    // Step 2: reference 准备 — 按 shot 级 retake limit 检查, 确定每 shot 实际生成张数
    const prepped = this._prepareReferences(
      targets.filteredShots, targets.series, targets.action, targets.count_per_shot,
    );

    // Step 3: task payload 鏋勫缓 鈥?createTaskRecord + SSE + queueTask + runner
    const { taskDefs, tasks } = this._buildTaskPayloads(
      targets.series, prepped, opts, targets.job_id,
    );

    // Step 4: task 鍏ラ槦 鈥?鍐欏叆 TaskQueue + 瑙﹀彂 runner + 璺熻釜鍥炶皟 + 杩炵画妫€鏌?+ 瀹屾垚
    return this._enqueueTasks(
      taskDefs, tasks, targets.series, opts, targets.job_id, targets.filteredShots.length,
    );
  }

  /** Step 1: 鐩爣瑙ｆ瀽 鈥?鏍规嵁 action 绫诲瀷鍔犺浇 series, 鍒?shots, 妫€鏌?limits, 鐢熸垚 job_id */
  private async _resolveTargets(opts: OrchestrateOptions) {
    const { series_slug, episode_id, action, count_per_shot } = opts;
    // B5: if model_ref_override is set, its provider id takes priority over
    // the legacy `provider_override` field. Otherwise fall back to caller-
    // provided provider_override (kept for back-compat). The full model_ref
    // is forwarded through to createRealShotTaskRunner so adapters get
    // request.model_id.
    // 2026-05-27 P0 修 ?? 顺序反了 — caller 传的 provider_override 应优先 (它已经把
    // "instance:vmi_xxx:..." unwrap 成真 provider_id 比如 zhipu_cogvideox), 之前
    // providerIdFromModelRef 取首段 "instance" 是 truthy → 覆盖了 caller 的真值 →
    // registry.getVideo("instance") 报错 No video provider registered.
    // 额外:即使 caller 没传, 内置检测 "instance:" prefix 自救 (不识别就 fallback
    // providerIdFromModelRef 老路径).
    const provider_override = opts.provider_override
      ?? (typeof opts.model_ref_override === "string" && opts.model_ref_override.startsWith("instance:")
            ? undefined  // instance prefix 没 unwrap → caller 责任, orchestrator 不猜
            : providerIdFromModelRef(opts.model_ref_override));

    // Load series and check limits
    const series = await readSeries(series_slug);
    if (!series) {
      throw Object.assign(new Error(`Series "${series_slug}" not found`), { status: 404 });
    }

    // W7 (2026-05-15) 鈥?fail-fast 棰勬牎楠?蹇呴』鏈夋槑纭?provider,鍚﹀垯鐩存帴 throw,
    // 涓嶈繘 task 鍒涘缓娴佺▼銆傝繖鏍疯矾鐢卞眰 catch 鍒?ProviderNotSelectedError 绔嬪嵆鍥?400,
    // 涓嶄細鍏堝垱寤轰竴鍫?task 鐒跺悗鎸傛帀銆傚悓鏍风殑鏍￠獙鍚庨潰 createTaskRecord 鏃惰繕浼氳窇涓€娆?
    // 但作为安全网放在最早处,避免下面 listShots / checkLimits 等空跑。
    resolveProviderId(action, provider_override, series.defaults);

    // Load shots (listShots imported at top)
    const shots = await listShots(series_slug, episode_id);
    if (shots.length === 0) {
      throw Object.assign(new Error(`No shots found for episode "${episode_id}"`), { status: 404 });
    }

    const filteredShots = opts.only_shot_ids
      ? shots.filter(s => opts.only_shot_ids!.includes(s.id))
      : shots;
    if (filteredShots.length === 0) {
      throw Object.assign(new Error("No matching shots"), { status: 400 });
    }

    // Check limits
    checkLimits(series, filteredShots.length, action);

    // Generate job_id
    const job_id = `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 12)}`;
    if (opts.attempt_id) {
      updatePendingJob(opts.attempt_id, {
        status: "running",
        progress: 0.2,
        eta_s: action === "generate_videos" ? filteredShots.length * 8 : filteredShots.length * 4,
      });
    }

    return { series, provider_override, filteredShots, job_id, series_slug, episode_id, action, count_per_shot };
  }

  /** Step 2: reference 准备 — 按 shot 级 retake limit 检查, 确定每 shot 实际生成张数 */
  private _prepareReferences(
    filteredShots: ShotData[],
    series: SeriesData,
    action: "generate_first_frames" | "generate_videos",
    count_per_shot: number,
  ): Array<{ shot: ShotData; actualCount: number; skipped: boolean }> {
    const maxRetake = series.defaults.max_retake_per_shot ?? 5;
    const taskKind = action === "generate_first_frames" ? "first_frame" : "video";
    return filteredShots.map(shot => {
      const existing = (shot.generations || []).filter(
        (g: ShotGeneration) => g.type === taskKind && g.status !== "failed"
      );
      const remaining = Math.max(0, maxRetake - existing.length);
      const actualCount = Math.min(count_per_shot, remaining);
      return { shot, actualCount, skipped: actualCount <= 0 };
    });
  }

  /** Step 3: task payload 构建 — createTaskRecord + emit SSE + build queueTask + create runner */
  private _buildTaskPayloads(
    series: SeriesData,
    prepped: Array<{ shot: ShotData; actualCount: number; skipped: boolean }>,
    opts: OrchestrateOptions,
    job_id: string,
  ): {
    taskDefs: Array<{
      shot: ShotData;
      task_id: string;
      provider_id: string;
      queueTask: Task;
      runner: ReturnType<typeof createRealShotTaskRunner>;
    }>;
    tasks: Array<{ task_id: string; shot_id: string; status: string }>;
  } {
    const { series_slug, episode_id, action } = opts;
    // 2026-05-27 P0 修 ?? 顺序反了 — caller 传的 provider_override 应优先 (它已经把
    // "instance:vmi_xxx:..." unwrap 成真 provider_id 比如 zhipu_cogvideox), 之前
    // providerIdFromModelRef 取首段 "instance" 是 truthy → 覆盖了 caller 的真值 →
    // registry.getVideo("instance") 报错 No video provider registered.
    // 额外:即使 caller 没传, 内置检测 "instance:" prefix 自救 (不识别就 fallback
    // providerIdFromModelRef 老路径).
    const provider_override = opts.provider_override
      ?? (typeof opts.model_ref_override === "string" && opts.model_ref_override.startsWith("instance:")
            ? undefined  // instance prefix 没 unwrap → caller 责任, orchestrator 不猜
            : providerIdFromModelRef(opts.model_ref_override));
    const tasks: Array<{ task_id: string; shot_id: string; status: string }> = [];
    const taskDefs: Array<{
      shot: ShotData;
      task_id: string;
      provider_id: string;
      queueTask: Task;
      runner: ReturnType<typeof createRealShotTaskRunner>;
    }> = [];

    for (const { shot, actualCount, skipped } of prepped) {
      // S9: 按 shot 超限跳过, 不 throw 中断整个 job
      if (skipped) {
        tasks.push({ task_id: "skipped_" + shot.id, shot_id: shot.id, status: "skipped_limit" });
        continue;
      }

      for (let i = 0; i < actualCount; i++) {
        const task_id = `task_${Date.now()}_${crypto.randomUUID().slice(0, 12)}`;

        // Create task record
        const provider_id = resolveProviderId(action, provider_override, series.defaults);
        createTaskRecord({
          id: task_id,
          job_id,
          kind: action === "generate_first_frames" ? "image" : "video",
          provider_id,
          status: "queued",
          meta: {
            series_slug,
            episode_id,
            shot_id: shot.id,
            action,
            provider_id,
            requestId: opts.requestId,
            prompt_override: opts.prompt_override,
            seed_override: opts.seed_override,
          },
        });

        tasks.push({ task_id, shot_id: shot.id, status: "queued" });

        // Emit SSE event
        sseBroker.emit({
          type: "task.queued",
          job_id,
          task_id,
          data: { shot_id: shot.id, action },
          at: new Date().toISOString(),
        });

        // Build queueTask (concurrency-controlled, with retry and timeout)
        const queueTask: Task = {
          id: task_id,
          kind: action === "generate_first_frames" ? "image" : "video",
          provider_id,
          input: {},
          meta: {
            series_slug,
            job_id,
            purpose: action,
            shot_id: shot.id,
            requestId: opts.requestId,
            prompt_override: opts.prompt_override,
            seed_override: opts.seed_override,
            // W7-real-fix: 涓?TaskRecord 瀵归綈,闃叉涓嬫父 runner 璇?task.meta.provider_id 鎷垮埌 undefined
            provider_id,
          },
          retries_remaining: this._defaultRetries,
          timeout_ms: action === "generate_videos"
            ? getPreset("video_provider", provider_id)?.default_timeout_ms ?? 900_000
            : 300_000, // image tasks: 5min default
        };

        // B3: 璁剧疆棰勭畻棰勬鎴愭湰(CNY), provider.estimateCost 鈫?task.meta.cost_estimate_cny
        // X1-3 (A5-5): 真实付费 provider 估价失败时 estimateTaskCost 抛 BudgetExceededError (fail-closed)。
        // 这里捕获后跳过该镜任务 (不入队, 保护预算), 与 M5 预算 skip 同款单镜处理, 不 crash 整个 job。
        if (this._registry) {
          try {
            queueTask.meta.cost_estimate_cny = estimateTaskCost(this._registry, provider_id, action, shot, opts.duration_sec_override);
          } catch (estErr) {
            if (estErr instanceof BudgetExceededError) {
              const estMsg = estErr.message;
              updateTaskRecord(task_id, { status: "failed", error: `estimate_failed: ${estMsg}` });
              loggerSync().warn(`[orchestrator] Shot ${shot.id}: task ${task_id} 估价失败跳过 (付费 provider fail-closed): ${estMsg}`);
              const summaryEntry = tasks.find((t) => t.task_id === task_id);
              if (summaryEntry) summaryEntry.status = "task_skipped_estimate_failed";
              else tasks.push({ task_id, shot_id: shot.id, status: "task_skipped_estimate_failed" });
              continue;
            }
            throw estErr;
          }
        }

        // W7-real-fix (2026-05-15): 删除 mock fallback. registry 必须存在.
        // 上一波 silent mock fallback 让所有任务"6ms 假装完成"+
        // 写 0 字节空 asset → 用户看到"素材文件缺失"占位.
        // 现在 index.ts 启动 eager-init getRegistry, 这里直接断言.
        if (!this._registry) {
          throw new Error("[orchestrator] ProviderRegistry 未注入 — 检查 server 启动时是否调用了 getRegistry()。任务不能用 mock runner 假装完成。");
        }
        const runner = createRealShotTaskRunner(this._registry, series, shot, action, series_slug, episode_id, {
          prompt_override: opts.prompt_override,
          seed_override: opts.seed_override,
          // B5: forward full ModelPicker ref so the runner can extract
          // model_id and pass it through to the provider adapter.
          model_ref_override: opts.model_ref_override,
          // 2026-05-17 涓ユ牸鍋氭硶: 閫忎紶 @ mention 瑙ｆ瀽鐨?extra ref ids
          reference_asset_ids_extra: opts.reference_asset_ids_extra,
          first_frame_asset_id_override: opts.first_frame_asset_id_override,
          // 2026-05-28 P0#13: dispatch 传的 negative_prompt / width / height override 透传
          negative_prompt_override: opts.negative_prompt_override,
          width_override: opts.width_override,
          height_override: opts.height_override,
          // 2026-07-10 audit P2-7: dispatch 校验后的 body duration_s 透传, 让真正发给 provider
          // 的时长与 dry-run 估价/确认弹窗展示的时长同源.
          duration_sec_override: opts.duration_sec_override,
        });

        taskDefs.push({ shot, task_id, provider_id, queueTask, runner });
      }
    }

    return { taskDefs, tasks };
  }

  /** Step 4: task 鍏ラ槦 鈥?鍐欏叆 TaskQueue + 瑙﹀彂 runner + 璺熻釜鍥炶皟 + 杩炵画妫€鏌?+ 瀹屾垚 */
  private async _enqueueTasks(
    taskDefs: Array<{
      shot: ShotData;
      task_id: string;
      provider_id: string;
      queueTask: Task;
      runner: ReturnType<typeof createRealShotTaskRunner>;
    }>,
    tasks: Array<{ task_id: string; shot_id: string; status: string }>,
    series: SeriesData,
    opts: OrchestrateOptions,
    job_id: string,
    shotCount: number,
  ): Promise<OrchestrateResult> {
    const { series_slug, episode_id, action } = opts;

    // 2026-05-27 P0-V1 — 真实视频并发锁. 全局只允许一个真实 video job 跑.
    //   - 非真实 provider (local_mock/local_animatediff*) 返 mock token, 不真锁
    //   - 真实 provider 且已有人持锁 → throw 409, 路由层 catch 返友好 message
    //   - 持锁直到所有 task allSettled (background promise), finally release
    // 之前 acquire/release 全仓库 0 调用 (死代码), dry-run "will_acquire_lock"
    // 是假承诺. 用户双 tab 同时点会双扣费 + 锁文件永不写入磁盘.
    let realVideoLockToken: string | null = null;
    if (action === "generate_videos" && taskDefs.length > 0) {
      const firstProvider = taskDefs[0].provider_id;
      const lock = await acquireRealVideoLock({
        provider: firstProvider,
        jobId: job_id,
        sceneId: episode_id,
      });
      if (!lock) {
        const holder = getRealVideoLockHolder();
        const msg = holder
          ? `已有真实视频任务在跑 (provider=${holder.provider}, job=${holder.jobId}, 已运行 ${Math.round((Date.now() - new Date(holder.startedAt).getTime()) / 1000)}s), 请等它结束或在 /cockpit 强制释放`
          : "已有真实视频任务在跑, 请稍后再试";
        throw Object.assign(new Error(msg), { status: 409, code: "RealVideoLockHeld" });
      }
      realVideoLockToken = lock.token;
      loggerSync().info(
        `[orchestrator] real video lock acquired: provider=${firstProvider}, job=${job_id}, token=${realVideoLockToken.slice(0, 16)}...`,
      );
    }
    /** B3: Track first-frame task promises for continuity post-check */
    const firstFramePromises: Array<{ shotId: string; shotIndex: number; promise: Promise<any> }> = []; // intentional: ProviderResponse polymorphic
    let enqueueComplete = false;
    let expectedTaskCount = 0;
    let settledTaskCount = 0;
    let failedTaskCount = 0;

    const syncAttemptProgress = () => {
      if (!opts.attempt_id || expectedTaskCount === 0) return;
      const progress = Math.min(0.98, Math.max(0.2, settledTaskCount / expectedTaskCount));
      updatePendingJob(opts.attempt_id, {
        status: "running",
        progress,
      });
    };

    const maybeFinalizeAttempt = () => {
      if (!opts.attempt_id || !enqueueComplete || expectedTaskCount === 0 || settledTaskCount < expectedTaskCount) return;
      const result = {
        job_id,
        task_count: expectedTaskCount,
        failed_task_count: failedTaskCount,
        tasks,
      };
      if (failedTaskCount >= expectedTaskCount) {
        failPendingJob(opts.attempt_id, {
          code: "AllTasksFailed",
          message: `All ${expectedTaskCount} task(s) failed`,
        });
      } else {
        completePendingJob(opts.attempt_id, result);
      }
    };

    // Group taskDefs by shot for per-shot allSettled
    const shotPromiseMap = new Map<string, Promise<any>[]>();

    for (const td of taskDefs) {
      // M5: wrap enqueue in try/catch 鈥?preflight BudgetExceededError skips single shot without crashing the job
      let queuePromise: Promise<any>; // intentional: ProviderResponse polymorphic
      try {
        queuePromise = this._queue.enqueue(td.queueTask, td.runner);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        updateTaskRecord(td.task_id, { status: "failed", error: `budget_skip: ${errMsg}` });
        loggerSync().warn(`[orchestrator] Shot ${td.shot.id}: task ${td.task_id} skipped (budget): ${errMsg}`);
        tasks.push({ task_id: td.task_id, shot_id: td.shot.id, status: "task_skipped_budget" });
        continue;
      }
      expectedTaskCount++;

      // Track per-shot promises for allSettled
      let sp = shotPromiseMap.get(td.shot.id);
      if (!sp) { sp = []; shotPromiseMap.set(td.shot.id, sp); }
      sp.push(queuePromise);

      // B3: Track first-frame promises for continuity post-check
      if (action === "generate_first_frames") {
        firstFramePromises.push({ shotId: td.shot.id, shotIndex: td.shot.index, promise: queuePromise });
      }

      // D4: 鍚堝苟 then/catch 涓哄崟鍙傦紝闃?unhandled rejection
      queuePromise.then(
        (result) => {
          settledTaskCount++;
          updateTaskRecord(td.task_id, { status: "done", result });
          sseBroker.emit({
            type: "task.done",
            job_id,
            task_id: td.task_id,
            data: { shot_id: td.shot.id, action, generation: result },
            at: new Date().toISOString(),
          });
          sseBroker.emit({
            type: "shot.updated",
            job_id,
            data: { shot_id: td.shot.id, status: "generated" },
            at: new Date().toISOString(),
          });

          // B3: CLIP quality scoring 鈥?non-blocking, fire-and-forget
          if (action === "generate_first_frames" && result?.path) {
            const imgPath = result.path as string;
            const promptForScoring = td.shot.prompt_img || td.shot.prompt_vid || td.shot.action || "";
            fs.readFile(imgPath).then((imgBuffer) => {
              return scoreImage(imgBuffer, promptForScoring);
            }).then((score) => {
              if (score !== undefined && score < 0.22) {
                const now = new Date().toISOString();
                loggerSync().warn(`[orchestrator] Shot ${td.shot.id}: quality_warning 鈥?CLIP score ${score.toFixed(2)} < 0.22`);
                updateShot(series_slug, episode_id, td.shot.id, {
                  quality_warning: { score, at: now },
                }).catch((e) => { console.warn("[orchestrator] updateShot quality_warning failed:", (e as Error)?.message ?? e); });
                sseBroker.emit({
                  type: "shot.quality_warning",
                  job_id,
                  data: { shot_id: td.shot.id, score },
                  at: now,
                });
              }
            }).catch((err) => {
              loggerSync().warn(`[orchestrator] Shot ${td.shot.id}: CLIP scoring failed (non-blocking):`, err instanceof Error ? err.message : err);
            });
          }
          syncAttemptProgress();
          maybeFinalizeAttempt();
        },
        (err) => {
          settledTaskCount++;
          failedTaskCount++;
          const errorMsg = err instanceof Error ? err.message : String(err);
          updateTaskRecord(td.task_id, { status: "failed", error: errorMsg });
          sseBroker.emit({
            type: "task.failed",
            job_id,
            task_id: td.task_id,
            data: { shot_id: td.shot.id, action, error: errorMsg },
            at: new Date().toISOString(),
          });
          loggerSync().error(`[orchestrator] task ${td.task_id} failed:`, err);
          // 2026-05-27 P0-V3 — 写 FailureCenter, 用户在 /cockpit/failures 可见且能 retry.
          // 之前 orchestrator 视频失败只 updateTaskRecord + sseBroker, 不 appendFailure,
          // failures.jsonl 没记录 → cockpit 看不到. 用户没法批量重试失败 task.
          appendFailure(series_slug, {
            shot_id: td.shot.id,
            code: "TaskFailed",
            message: errorMsg,
            attempt_id: td.task_id,
            kind: action === "generate_videos" ? "video" : "first_frame",
            provider: td.provider_id,
          }).catch(() => {});
          syncAttemptProgress();
          maybeFinalizeAttempt();
        },
      );
    }

    // Per-shot graceful degradation: use allSettled to detect failures
    // without blocking other shots. Individual task results are already
    // handled above via .then()/.catch() for SSE + task record updates.
    for (const [shotId, promises] of shotPromiseMap) {
      const shot = taskDefs.find(td => td.shot.id === shotId)?.shot;
      if (!shot) continue;
      Promise.allSettled(promises).then(async (results) => {
        const newFailures = results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => ({
            at: new Date().toISOString(),
            stage: action,
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          }));

        if (newFailures.length > 0) {
          // S8: 鍏?readShot 鎷挎渶鏂?failures, 鎸?error 鍘婚噸閬垮厤鍙屽啓
          try {
            const freshShot = await readShot(series_slug, episode_id, shot.id);
            const existingErrors = new Set((freshShot?.failures || []).map(f => f.error));
            const deduped = newFailures.filter(f => !existingErrors.has(f.error));
            if (deduped.length > 0) {
              await updateShot(series_slug, episode_id, shot.id, {
                failures: [...(freshShot?.failures || []), ...deduped],
                status: "failed",
              });
            }
          } catch (updateErr) {
            loggerSync().error(`[orchestrator] updateShot failed for shot ${shot.id}:`, updateErr);
          }
        }
      }).catch((settledErr) => {
        // allSettled itself should never reject, but guard for safety
        loggerSync().error(`[orchestrator] allSettled error for shot ${shot.id}:`, settledErr);
      });
    }

    // B3: Continuity check 鈥?fire-and-forget after all first-frame tasks settle
    // Only applies to first-frame generation (video continuity is less meaningful)
    if (action === "generate_first_frames" && firstFramePromises.length > 1) {
      Promise.allSettled(firstFramePromises.map(fp => fp.promise)).then(async () => {
        try {
          // Sort by shot index for adjacency
          const sorted = firstFramePromises.sort((a, b) => a.shotIndex - b.shotIndex);

          // Re-read shots to get updated state with latest generations
          const updatedShots = await listShots(series_slug, episode_id);
          const shotById = new Map(updatedShots.map(s => [s.id, s]));

          for (let i = 1; i < sorted.length; i++) {
            const prevInfo = sorted[i - 1];
            const currInfo = sorted[i];
            const prevShot = shotById.get(prevInfo.shotId);
            const currShot = shotById.get(currInfo.shotId);
            if (!prevShot || !currShot) continue;

            const prevGens = (prevShot.generations || []).filter(
              (g: ShotGeneration) => g.type === "first_frame" && g.status === "done" && g.path
            );
            const currGens = (currShot.generations || []).filter(
              (g: ShotGeneration) => g.type === "first_frame" && g.status === "done" && g.path
            );
            if (prevGens.length === 0 || currGens.length === 0) continue;

            const prevPath = prevGens[prevGens.length - 1].path!;
            const currPath = currGens[currGens.length - 1].path!;

            try {
              const [prevBuf, currBuf] = await Promise.all([
                fs.readFile(prevPath),
                fs.readFile(currPath),
              ]);
              const result = await checkContinuity(prevBuf, currBuf, `Shot #${prevInfo.shotIndex} 鈫?#${currInfo.shotIndex}`);
              if (!result.consistent) {
                const now = new Date().toISOString();
                loggerSync().warn(`[orchestrator] Shot ${currInfo.shotId}: continuity_warning 鈥?inconsistent with shot ${prevInfo.shotId}`);
                await updateShot(series_slug, episode_id, currInfo.shotId, {
                  continuity_warning: { reason: result.reason, at: now },
                }).catch((e) => { console.warn("[orchestrator] updateShot continuity_warning failed:", (e as Error)?.message ?? e); });
                sseBroker.emit({
                  type: "shot.continuity_warning",
                  job_id,
                  data: { shot_id: currInfo.shotId, prev_shot_id: prevInfo.shotId, reason: result.reason },
                  at: now,
                });
              }
            } catch (err) {
              loggerSync().warn(`[orchestrator] Continuity check failed for shots ${prevInfo.shotId}鈫?{currInfo.shotId}:`, err instanceof Error ? err.message : err);
            }
          }
        } catch (err) {
          loggerSync().warn("[orchestrator] Continuity post-check failed:", err instanceof Error ? err.message : err);
        }
      });
    }

    enqueueComplete = true;
    if (opts.attempt_id && expectedTaskCount === 0) {
      completePendingJob(opts.attempt_id, {
        job_id,
        task_count: 0,
        skipped: tasks.length,
        tasks,
      });
    } else {
      syncAttemptProgress();
      maybeFinalizeAttempt();
    }

    // 2026-05-27 P0-V1 — 全部 task 完成 (allSettled) 后释放真实视频锁.
    // 不能等 orchestrate() 返回 (返回时 task 异步还在跑), 必须 background promise.
    if (realVideoLockToken) {
      const allPromises: Promise<unknown>[] = [];
      for (const [, promises] of shotPromiseMap) allPromises.push(...promises);
      const tokenSnapshot = realVideoLockToken;
      Promise.allSettled(allPromises)
        .finally(() => {
          releaseRealVideoLock(tokenSnapshot);
          loggerSync().info(`[orchestrator] real video lock released: job=${job_id}, token=${tokenSnapshot.slice(0, 16)}...`);
        })
        .catch(() => {
          // 双保险, allSettled 不应 reject
          releaseRealVideoLock(tokenSnapshot);
        });
    }

    const skipped = tasks.filter(t => t.status === "skipped_limit").length;
    return {
      job_id,
      task_count: tasks.filter(t => t.status !== "skipped_limit").length,
      shot_count: shotCount,
      skipped,
      tasks,
    } as OrchestrateResult;
  }
}

// Singleton instance
export const orchestrator = new JobOrchestrator();
