/**
 * Phase 3 (Wave 2, 2026-05-16) — 统一生成端点 controller.
 *
 * 出发点(用户原话): "我绝对禁止在不同的地方分开写同样的逻辑". Phase 1 已经把后端
 * 8 个 controller 的"writeFile + saveToVault + addAsset + 写业务对象"53 行收敛到
 * imageGenerationOrchestrator + 8 个 adapter. Phase 3 再前一步: 给前端一个 **统一**
 * 的生图/生视频入口, 不再依赖各 controller 自己的 endpoint URL.
 *
 * 新增 4 条端点(都是 thin route — 校验 → 调 orchestrator → 返回):
 *   POST /api/v2/generate/image            统一生图
 *   POST /api/v2/generate/image/dry-run    生图 dry-run (不调 provider, 不扣费)
 *   POST /api/v2/generate/video            统一生视频
 *   POST /api/v2/generate/video/dry-run    生视频 dry-run
 *
 * 兼容策略:
 *   - 各 legacy endpoint (element/character/scene/library/vault generate-image 等)
 *     URL 保留, response 字段名保留 — Phase 1 后已经在调同一个 orchestrator,
 *     Wave 3 前端再逐步切到本统一端点.
 *
 * 关键约束:
 *   1. zod 错误信息 toC 兜底 — 错误 message 用中文人话, 不暴露 zod 内部字段路径 (铁律 #9)
 *   2. slug 校验 Unicode-safe — 见 types.ts SLUG_PATH_SAFE (允许中文 slug, 仅防路径穿越)
 *   3. 缺 provider → 400 + code="provider_not_selected" (红线 #1, 复用 ProviderNotSelectedError)
 *   4. dry-run 必须 0 扣费 — 不调 generateImagesForTarget, 走 imageDryRun/videoDryRun helper
 *   5. 返回结构统一:
 *      { ok: true, provider_id, images: PersistedImage[], target_state?, cost?, prompt_snapshot? }
 *      { ok: true, provider_id, video: PersistedVideo, target_state?, cost?, prompt_snapshot? }
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import {
  generateImagesForTarget,
  ImageGenerationTargetSchema,
} from "../../application/generation/imageGenerationOrchestrator";
import {
  generateVideoForTarget,
  VideoGenerationTargetSchema,
} from "../../application/generation/videoGenerationOrchestrator";
import { buildImageDryRunResult } from "../../application/generation/imageDryRun";
import { getRegistry } from "./orchestration/_shared/registry";
import { ProviderNotSelectedError } from "../../jobs/errors";
import {
  estimateVideoCost,
  isRealVideoProvider,
  getKeyFor,
  getRealVideoLockStatus,
  // 2026-07-22 X3-6 (A1-2): sync `/generate/video` 补真实视频锁(与 orchestrator.ts:1879 同语义)
  acquireRealVideoLock,
  releaseRealVideoLock,
  getRealVideoLockHolder,
} from "../../../../../packages/core/src/index";
import {
  providerIdFromModelRef,
  modelIdFromModelRef,
} from "../../application/generation/modelRef";
import { getVideoModelInstance } from "../../../../../packages/core/src/videoModelInstances";

/**
 * 2026-05-18: dry-run / 任何按 model_ref 推断 provider 的地方都得理解二级架构.
 * "instance:<vmi_id>:<model>" → 查 instance → 返回真实 channel 对应的 provider id + 实例
 * 自带的 api_key / model_id. 这样 dry-run 显示的"provider_id"与真正调用一致.
 */
function resolveModelRef(rawRef: string): {
  providerId: string;
  modelId: string | null;
  instanceKeyPresent: boolean;
  instanceFound: boolean;
} {
  const top = providerIdFromModelRef(rawRef);
  if (!top) return { providerId: "", modelId: null, instanceKeyPresent: false, instanceFound: false };
  if (top !== "instance") {
    return {
      providerId: top,
      modelId: modelIdFromModelRef(rawRef) ?? null,
      instanceKeyPresent: false,
      instanceFound: false,
    };
  }
  // 二级架构
  const rest = modelIdFromModelRef(rawRef) ?? "";
  const colonIdx = rest.indexOf(":");
  const instanceId = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
  const modelOverride = colonIdx >= 0 ? rest.slice(colonIdx + 1).trim() : "";
  const instance = getVideoModelInstance(instanceId);
  if (!instance) {
    return { providerId: "instance", modelId: null, instanceKeyPresent: false, instanceFound: false };
  }
  const channelToProvider: Record<string, string> = {
    kling: "kling_3",
    vidu: "vidu_q3_ref",
    jimeng: "jimeng_video_3pro",
    minimax: "minimax_hailuo",
    aliyun_wan: "aliyun_wan_t2v",
  };
  const providerId = channelToProvider[instance.channel] ?? "";
  return {
    providerId,
    modelId: modelOverride || instance.model_id,
    instanceKeyPresent: !!instance.api_key && (instance.channel === "kling" || instance.channel === "jimeng" ? !!instance.secret_key : true),
    instanceFound: true,
  };
}

export const generationRouter = Router();

// ─── 公共 schema 片段 (与 imageController/videoController 对齐, 防止漂移) ───

const ImageInputRefSchema = z.object({
  asset_id: z.string().max(1000).optional(),
  vault_id: z.string().max(200).optional(),
  path: z.string().max(1000).optional(),
  data_url: z.string().max(50 * 1024 * 1024).optional(),
  base64: z.string().max(50 * 1024 * 1024).optional(),
  mime: z.string().max(100).optional(),
  weight: z.number().min(0).max(1).optional(),
});

const VideoInputRefSchema = z.object({
  asset_id: z.string().max(1000).optional(),
  vault_id: z.string().max(200).optional(),
  path: z.string().max(1000).optional(),
  data_url: z.string().max(50 * 1024 * 1024).optional(),
  base64: z.string().max(50 * 1024 * 1024).optional(),
  mime: z.string().max(100).optional(),
  weight: z.number().min(0).max(1).optional(),
});

const AspectRatioSchema = z.enum(["9:16", "16:9", "1:1", "4:3", "3:4"]);

// ─── /generate/image schema ──────────────────────────────────────

/**
 * 自定义 invalid_type / required 错误信息 — zod v4 默认 message 是英文
 * ("Invalid input: expected string, received undefined"), 必须 toC 兜底
 * 翻成中文人话 (铁律 #9).
 */
const requiredStr = (label: string) =>
  z.string({ error: (issue) => issue.input === undefined ? `${label}必填` : `${label}必须是字符串` });

const GenerateImageBodySchema = z.object({
  prompt: requiredStr("提示词").min(1, "提示词不可为空").max(12000, "提示词过长 (最多 12000 字符)"),
  negative_prompt: z.string().max(4000).optional(),
  provider_id: z.string().max(200).optional(),
  model_ref: z.string().max(200).optional(),
  count: z.number().int().min(1).max(16).optional().default(1),
  width: z.number().int().min(256).max(4096).optional(),
  height: z.number().int().min(256).max(4096).optional(),
  seed: z.number().int().optional(),
  reference_images: z.array(ImageInputRefSchema).max(8).optional(),
  strict_reference_images: z.boolean().optional(),
  default_provider_id: z.string().max(200).optional(),
  i2i_base: z.object({
    image_id: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
  }).optional(),
  extra_tags: z.array(z.string().max(200)).max(32).optional(),
  job_id: z.string().max(200).optional(),
  task_id: z.string().max(200).optional(),
  target: ImageGenerationTargetSchema,
});

const GenerateImageDryRunBodySchema = z.object({
  prompt: requiredStr("提示词").min(1, "提示词不可为空").max(12000),
  negative_prompt: z.string().max(4000).optional(),
  model_ref: z.string().max(200).optional(),
  provider_id: z.string().max(200).optional(),
  default_provider_id: z.string().max(200).optional(),
  count: z.number().int().min(1).max(32).optional().default(1),
  width: z.number().int().min(256).max(4096).optional(),
  height: z.number().int().min(256).max(4096).optional(),
  has_reference_images: z.boolean().optional(),
  target: ImageGenerationTargetSchema,
});

// ─── /generate/video schema ──────────────────────────────────────

const GenerateVideoBodySchema = z.object({
  prompt: requiredStr("提示词").min(1, "提示词不可为空").max(12000),
  negative_prompt: z.string().max(4000).optional(),
  provider_id: z.string().max(200).optional(),
  model_ref: z.string().max(200).optional(),
  duration_sec: z.number().min(1).max(120).optional().default(5),
  aspect_ratio: AspectRatioSchema.optional().default("16:9"),
  seed: z.number().int().optional(),
  first_frame: VideoInputRefSchema.optional(),
  reference_images: z.array(VideoInputRefSchema).max(8).optional(),
  strict_reference_images: z.boolean().optional(),
  default_provider_id: z.string().max(200).optional(),
  timeout_ms: z.number().int().min(1000).max(1_800_000).optional(),
  extra_tags: z.array(z.string().max(200)).max(32).optional(),
  job_id: z.string().max(200).optional(),
  task_id: z.string().max(200).optional(),
  target: VideoGenerationTargetSchema,
});

const GenerateVideoDryRunBodySchema = z.object({
  prompt: requiredStr("提示词").min(1, "提示词不可为空").max(12000),
  negative_prompt: z.string().max(4000).optional(),
  model_ref: z.string().max(200).optional(),
  provider_id: z.string().max(200).optional(),
  default_provider_id: z.string().max(200).optional(),
  duration_sec: z.number().min(1).max(120).optional().default(5),
  aspect_ratio: AspectRatioSchema.optional().default("16:9"),
  seed: z.number().int().optional(),
  count: z.number().int().min(1).max(4).optional().default(1),
  source_video_generation_id: z.string().max(200).optional(),
  target: VideoGenerationTargetSchema,
});

// ─── helpers ─────────────────────────────────────────────────────

/**
 * 把 zod parse 失败翻成 toC 友好的 400 — 不暴露 path/code 等内部字段.
 * 但仍把 zod 自带的中文 message 拼到 messages 数组里, 方便排错.
 *
 * 特别处理 "provider 缺失" 这种最常见错误: 给 code="provider_not_selected"
 * (跟 ProviderNotSelectedError 对齐, 前端 ErrorTranslator 可统一分支).
 */
/**
 * 把 zod issue 翻成 toC 友好的中文 message.
 * - 必填字段 (invalid_type, input === undefined) → "X 必填"
 * - 顶层 target 缺失 → "target 必填"
 * - 其余保留 zod 自带 message (我们已在 schema 里手动写好中文)
 */
function humanizeZodIssue(issue: z.core.$ZodIssue): string {
  const pathStr = (issue.path ?? []).join(".");
  // 顶层必填字段缺失
  // 2026-05-28 audit P1 — z.core.$ZodIssue.input 仅 invalid_type 子类型有, 用 unknown narrowing 替代 (issue as any)
  const issueRec = issue as unknown as { input?: unknown };
  if (issue.code === "invalid_type" && issueRec.input === undefined) {
    if (pathStr === "target") return "target 必填";
    if (pathStr === "prompt") return "提示词必填";
    if (pathStr === "target.kind") return "target.kind 必填";
    if (pathStr === "target.series_slug") return "target.series_slug 必填";
  }
  // schema 内手写的中文 message 直接用
  return issue.message;
}

function respondZodValidationError(
  res: Response,
  err: z.ZodError,
  kind: "image" | "video",
): void {
  const issues = err.issues ?? [];
  const humanMessages: string[] = issues.map((issue) => humanizeZodIssue(issue));
  const isProviderMissing = humanMessages.some((m) =>
    typeof m === "string"
    && (m.includes("provider_id") || m.includes("model_ref") || m.includes("选择"))
  );
  // 主 message: 优先报第一个 critical 错误
  const main = humanMessages[0] || "请求体校验失败";
  res.status(400).json({
    error: {
      code: isProviderMissing ? "provider_not_selected" : "ValidationError",
      message: isProviderMissing
        ? `请先选择${kind === "image" ? "图像" : "视频"}模型, 或在设置中配置默认${kind === "image" ? "图像" : "视频"}模型`
        : main,
      messages: humanMessages.length > 1 ? humanMessages : undefined,
    },
  });
}

/**
 * 校验"至少有一个 provider 来源": provider_id / model_ref / default_provider_id 三者之一.
 * 这一步在 zod 之外做, 是因为 zod 难以表达"三者至少一个非空 trim 后"语义.
 * 缺则 throw ProviderNotSelectedError, 由 error middleware 转 400 + code.
 */
function ensureProviderHint(
  body: {
    provider_id?: string;
    model_ref?: string;
    default_provider_id?: string;
  },
  kind: "image" | "video",
): void {
  const has = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
  if (!has(body.provider_id) && !has(body.model_ref) && !has(body.default_provider_id)) {
    throw new ProviderNotSelectedError(
      kind === "image" ? "generate_first_frames" : "generate_videos",
    );
  }
}

// ─── POST /generate/image ────────────────────────────────────────

generationRouter.post(
  "/generate/image",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = GenerateImageBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        respondZodValidationError(res, parsed.error, "image");
        return;
      }
      ensureProviderHint(parsed.data, "image");

      const result = await generateImagesForTarget(parsed.data, {
        registry: getRegistry(),
        log: (level, msg, meta) => {
          const line = `[generate/image] ${msg}`;
          if (level === "error") console.error(line, meta ?? "");
          else if (level === "warn") console.warn(line, meta ?? "");
          else console.log(line, meta ?? "");
        },
      });

      res.json({
        ok: true,
        provider_id: result.provider_id,
        images: result.images,
        target_state: result.target_state,
        cost: result.cost,
        prompt_snapshot: parsed.data.prompt,
      });
    } catch (e) {
      next(e);
    }
  },
);

// ─── POST /generate/image/dry-run ────────────────────────────────

generationRouter.post(
  "/generate/image/dry-run",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = GenerateImageDryRunBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        respondZodValidationError(res, parsed.error, "image");
        return;
      }
      ensureProviderHint(parsed.data, "image");

      const result = buildImageDryRunResult(
        {
          model_ref: parsed.data.model_ref ?? parsed.data.provider_id,
          prompt: parsed.data.prompt,
          negative_prompt: parsed.data.negative_prompt,
          count: parsed.data.count,
          width: parsed.data.width,
          height: parsed.data.height,
          has_reference_images: parsed.data.has_reference_images,
        },
        {
          registry: getRegistry(),
          default_provider_id: parsed.data.default_provider_id,
        },
      );

      if (result.error === "key_missing") {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

// ─── POST /generate/video ────────────────────────────────────────

generationRouter.post(
  "/generate/video",
  async (req: Request, res: Response, next: NextFunction) => {
    // 2026-07-22 X3-6 (A1-2): 真实视频锁 — 与 orchestrator.ts:1879 同语义(全局同一时间最多一个真实视频任务).
    // 之前这条 sync 入口不过锁, 可与主路径真实 job 并发扣费; 且 /generate/video/dry-run 会读锁状态展示占用,
    // 真执行却不 acquire(口是心非). 现补: 真实付费 provider 抢不到锁 → 409; 非真实(mock/local)返 MOCK_TOKEN 不真锁.
    let lockToken: string | undefined;
    try {
      const parsed = GenerateVideoBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        respondZodValidationError(res, parsed.error, "video");
        return;
      }
      ensureProviderHint(parsed.data, "video");

      const rawRef = (parsed.data.model_ref?.trim())
        || (parsed.data.provider_id?.trim())
        || (parsed.data.default_provider_id?.trim());
      const lockProviderId = rawRef ? resolveModelRef(rawRef).providerId : "";
      const taskId = parsed.data.task_id || `generate_video_${Date.now()}`;
      const lock = await acquireRealVideoLock({ provider: lockProviderId, jobId: taskId, sceneId: "generate_video_sync" });
      if (!lock) {
        const holder = getRealVideoLockHolder();
        res.status(409).json({
          error: {
            code: "RealVideoLockHeld",
            message: holder
              ? `已有真实视频任务在跑 (provider=${holder.provider}, 已运行 ${Math.round((Date.now() - new Date(holder.startedAt).getTime()) / 1000)}s), 请等它结束或到 /cockpit 强制释放`
              : "已有真实视频任务在跑, 请稍后再试",
          },
        });
        return;
      }
      lockToken = lock.token;

      const result = await generateVideoForTarget(parsed.data, {
        registry: getRegistry(),
        log: (level, msg, meta) => {
          const line = `[generate/video] ${msg}`;
          if (level === "error") console.error(line, meta ?? "");
          else if (level === "warn") console.warn(line, meta ?? "");
          else console.log(line, meta ?? "");
        },
      });

      res.json({
        ok: true,
        provider_id: result.provider_id,
        video: result.video,
        target_state: result.target_state,
        cost: result.cost,
        prompt_snapshot: parsed.data.prompt,
      });
    } catch (e) {
      next(e);
    } finally {
      // mock/local provider 拿的是 MOCK_TOKEN, release 无副作用; 真实锁在此释放(与 orchestrator finally 同).
      if (lockToken) releaseRealVideoLock(lockToken);
    }
  },
);

// ─── POST /generate/video/dry-run ────────────────────────────────
//
// 注意: 这里不能直接复用 buildVideoDryRunResult — 它绑死 ShotData (取 shot.aspect_ratio
// / shot.duration_sec / shot.prompt_vid / shot.id 等). 统一端点的 vault_only target 没有
// shot 上下文. 本地用一段独立的等价实现, 行为对齐 videoDryRun (估费 / key probe / lock 提示).

const VIDEO_PROVIDER_KEY_NAMES: Record<string, string> = {
  minimax_hailuo: "MINIMAX_API_KEY",
  aliyun_wan_t2v: "ALIYUN_DASHSCOPE_API_KEY",
  jimeng_video_3pro: "JIMENG_VOLC_ACCESS_KEY",
  jimeng_video_3_720p: "JIMENG_VOLC_ACCESS_KEY",
  kling_3: "KLING_ACCESS_KEY/KLING_SECRET_KEY",
  vidu_q3_ref: "VIDU_API_KEY",
  zhipu_cogvideox: "ZHIPU_API_KEY",
  baidu_qianfan_video: "BAIDU_QIANFAN_API_KEY",
  tencent_hunyuan_video: "TENCENT_SECRET_ID/TENCENT_SECRET_KEY",
};

function redactSensitiveFields<T extends Record<string, unknown>>(obj: T): T {
  const SENSITIVE = new Set([
    "authorization", "api_key", "apikey", "access_key", "secret_key", "secret_id",
    "ak", "sk", "token", "x-api-key", "bearer",
  ]);
  const out: Record<string, unknown> = { ...obj };
  for (const k of Object.keys(out)) {
    if (SENSITIVE.has(k.toLowerCase())) out[k] = "****";
  }
  return out as T;
}

generationRouter.post(
  "/generate/video/dry-run",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = GenerateVideoDryRunBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        respondZodValidationError(res, parsed.error, "video");
        return;
      }
      ensureProviderHint(parsed.data, "video");

      const rawRef = (parsed.data.model_ref && parsed.data.model_ref.trim())
        || (parsed.data.provider_id && parsed.data.provider_id.trim())
        || (parsed.data.default_provider_id && parsed.data.default_provider_id.trim());
      if (!rawRef) {
        // ensureProviderHint 应该已经 throw, 这里防御性兜底
        throw new ProviderNotSelectedError("generate_videos");
      }
      // 2026-05-18: 走二级架构 resolver — "instance:<vmi>:<model>" 解析
      const resolved = resolveModelRef(rawRef);
      const providerId = resolved.providerId;
      if (!providerId) throw new ProviderNotSelectedError("generate_videos");
      const modelId = resolved.modelId;

      const isReal = isRealVideoProvider(providerId);
      const keyEnv = VIDEO_PROVIDER_KEY_NAMES[providerId];
      const keyPresent = isReal
        ? (resolved.instanceFound ? resolved.instanceKeyPresent : !!getKeyFor(providerId))
        : true;

      const lockStatus = getRealVideoLockStatus();
      const realLockHeldBy = isReal && lockStatus.locked && lockStatus.holder
        ? {
          provider: lockStatus.holder.provider,
          job_id: lockStatus.holder.jobId,
          scene_id: lockStatus.holder.sceneId,
          age_ms: lockStatus.age_ms,
        }
        : undefined;

      const duration = Number(parsed.data.duration_sec) || 5;
      const requestPreview = redactSensitiveFields({
        provider_id: providerId,
        model_id: modelId ?? "(provider default)",
        prompt: parsed.data.prompt,
        negative_prompt: parsed.data.negative_prompt ?? "",
        duration_sec: duration,
        aspect_ratio: parsed.data.aspect_ratio,
        seed: parsed.data.seed,
        count: parsed.data.count,
        source_video_generation_id: parsed.data.source_video_generation_id ?? null,
        target_kind: parsed.data.target.kind,
        target_series_slug: parsed.data.target.series_slug,
        target_id: parsed.data.target.target_id ?? null,
        headers_preview: { authorization: "****", "content-type": "application/json" },
      });

      const cost = estimateVideoCost({
        provider: providerId,
        model: modelId ?? "",
        duration,
      });

      if (isReal && !keyPresent) {
        res.status(400).json({
          ok: false,
          dry_run: true,
          will_not_call_provider: true,
          provider_id: providerId,
          model_id: modelId,
          key_present: false,
          is_real_provider: true,
          will_acquire_real_lock: false,
          request_preview: requestPreview,
          estimated_cost_cny: cost.estimated_cny,
          estimated_cost_note: cost.note,
          error: "key_missing",
          message: `provider ${providerId} 需要的 API Key (${keyEnv ?? "API Key"}) 未配置`,
        });
        return;
      }

      res.json({
        ok: true,
        dry_run: true,
        will_not_call_provider: true,
        provider_id: providerId,
        model_id: modelId,
        key_present: keyPresent,
        is_real_provider: isReal,
        will_acquire_real_lock: isReal,
        real_lock_held_by: realLockHeldBy,
        request_preview: requestPreview,
        estimated_cost_cny: cost.estimated_cny,
        estimated_cost_note: cost.note,
        target_kind: parsed.data.target.kind,
        message: isReal
          ? `将调用 ${providerId} 真实视频接口, 预估 ¥${(cost.estimated_cny ?? 0).toFixed(2)}`
          : `${providerId} 为本地/Mock provider, 不会扣费`,
      });
    } catch (e) {
      next(e);
    }
  },
);
