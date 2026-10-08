// P20: Unified Provider Interfaces
// All provider types implement a common healthCheck() method.

// ─── Context ────────────────────────────────────────────────────────

export interface ProviderContext {
  series_slug: string;
  job_id: string;
  task_id: string;
  log: (level: "info" | "warn" | "error", msg: string, meta?: unknown) => void;
  // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
  // signal 改为可选, 仅当 caller 显式传入(如前端点击"中止"按钮后绑定的 AbortController.signal)才有值.
  // provider 内部 fetch 直接透传, 不再自己叠加 AbortSignal.timeout(N).
  signal?: AbortSignal;
}

// ─── Cost ───────────────────────────────────────────────────────────

export interface CostInfo {
  currency: "CNY" | "USD";
  amount: number;
  basis: "measured" | "estimated";
}

// ─── Health ─────────────────────────────────────────────────────────

export interface HealthCheckResult {
  ok: boolean;
  reason?: string;
}

// ─── LLM Provider ──────────────────────────────────────────────────

export interface LlmCompleteRequest {
  prompt: string;
  system?: string;
  max_tokens?: number;
  temperature?: number;
  response_format?: "text" | "json";
  stream?: boolean;
  onDelta?: (chunk: string) => void;
}

export interface LlmCompleteResponse {
  text: string;
  usage?: { in_tokens: number; out_tokens: number };
  cost?: CostInfo;
}

export interface LlmProvider {
  readonly id: string;
  complete(req: LlmCompleteRequest, ctx: ProviderContext): Promise<LlmCompleteResponse>;
  healthCheck(): Promise<HealthCheckResult>;
}

// ─── Image Provider ────────────────────────────────────────────────

export interface ImageGenerateRequest {
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  count: number;
  reference_images?: Array<{ asset_id: string; weight?: number }>;
  seed?: number;
  extras?: Record<string, unknown>;
  /**
   * Override the provider instance's default model. Comes from ModelPicker
   * model_ref colon-suffix (e.g. "chatgpt_codex_image:gpt-image-2" → "gpt-image-2").
   * If undefined, adapter falls back to `cfg.model_id`. Adapters MUST honor this
   * field so users can pick the same provider with different models.
   */
  model_id?: string;
  /**
   * 2026-05-16 渐进式落盘 — 每完成一张图后立即触发的回调.
   *
   * 用户原话: "一键抽 N 张按顺序发送, 回来一张落盘一张, 其他未完成请求在图库该落盘的
   * 地方做生成中占位."
   *
   * provider 实现约定:
   *  - 串行 / 单张拉的 provider (chatgpt_codex / aliyun / kling 等) 每收到一张图后立即
   *    await on_image_ready(image, index_from_zero, total)
   *  - 批量返回 N 张的 provider (openai gpt-image-2 n=N, gemini batch) 把整批拿到后
   *    for await 每张触发一次, 仍提供 "回来一张落盘一张" 的 UX
   *  - 回调可选不传, 不传时 provider 不调它 (行为退化为旧逻辑)
   *  - 回调 throw 不能阻塞主流程: provider 必须 try/catch + ctx.log warn, 然后继续
   *    (落盘失败由 caller 自己补偿/重试, 不能让一次落盘错误整批废)
   */
  on_image_ready?: (image: GeneratedImage, index: number, total: number) => Promise<void>;
}

export interface GeneratedImage {
  buffer: Buffer;
  mime: string;
  width: number;
  height: number;
  seed?: number;
}

export interface ImageGenerateResponse {
  images: GeneratedImage[];
  cost?: CostInfo;
}

export interface ImageProvider {
  readonly id: string;
  generate(req: ImageGenerateRequest, ctx: ProviderContext): Promise<ImageGenerateResponse>;
  healthCheck(): Promise<HealthCheckResult>;
  /** B3: 预估单次生成成本(CNY), basis="accurate"表示实价、"estimated"表示估算 */
  estimateCost?(req: ImageGenerateRequest): { cny: number; basis: "accurate" | "estimated" };
  /**
   * X7-6 (2026-07-22): 重启后续取一条 inflight 图像任务 (只重下载、绝不重提交, 不重复扣费),
   * 与 VideoProvider.resumePoll 对称。返回已产出的图 (远端已扣费) 或抛错。
   * 异步付费图像 provider (aliyunWanxImageProvider) 实现; 同步/本地 provider 不需要。
   */
  resumePoll?(providerJobId: string, signal?: AbortSignal): Promise<ImageGenerateResponse>;
}

// ─── Video Provider ────────────────────────────────────────────────

export interface VideoGenerateRequest {
  prompt: string;
  first_frame?: { asset_id: string };
  /**
   * 2026-05-21 X-1: 尾帧(支持 i2v 首尾连贯的 provider 用 — kling/jimeng/vidu 等)。
   * provider 内部判断是否支持; 不支持就 silent 忽略,不抛错(向后兼容)。
   */
  last_frame?: { asset_id: string };
  reference_images?: Array<{ asset_id: string; weight?: number }>;
  duration_sec: number;
  aspect_ratio: "9:16" | "16:9" | "1:1" | "4:3" | "3:4";
  seed?: number;
  extras?: Record<string, unknown>;
  /**
   * Override the provider instance's default model. Comes from ModelPicker
   * model_ref colon-suffix. If undefined, adapter falls back to `cfg.model_id`.
   */
  model_id?: string;
  /**
   * 2026-05-18: Per-call override for "渠道 + 多模型实例" 二级架构.
   * 调用方 (videoGenerationService) 解析 model_ref "instance:<id>" 后,
   * 把 instance 的 api_key / secret_key / api_base_url / region 透传到 provider.
   * Provider 必须优先用这些值, fallback 到自己的 cfg / env. 不允许 silent ignore.
   * 5 个 channel (kling / vidu / jimeng / minimax / aliyun_wan) 都接.
   */
  instance_override?: {
    api_key: string;
    secret_key?: string;
    api_base_url?: string;
    region?: string;
  };
}

export interface GeneratedVideo {
  buffer: Buffer;
  mime: string;
  duration_sec: number;
  width: number;
  height: number;
  /**
   * 2026-05-17: provider 实测 fps (从 mp4 元数据). 0/undefined 视为未知,
   * orchestrator 走 series.defaults.fps 兜底. 本地 AnimateDiff 实际 8fps,
   * 之前 orchestrator 写死 24 → ShotGeneration 假数据(任务表 result.fps=24 不可信).
   */
  fps?: number;
}

export interface VideoGenerateResponse {
  video: GeneratedVideo;
  cost?: CostInfo;
}

export interface VideoProvider {
  readonly id: string;
  readonly mode: "t2v" | "i2v" | "ref2v" | "mock";
  generate(req: VideoGenerateRequest, ctx: ProviderContext): Promise<VideoGenerateResponse>;
  healthCheck(): Promise<HealthCheckResult>;
  /** Resume polling an inflight task after server restart. Returns result or throws. */
  resumePoll?(providerJobId: string, signal?: AbortSignal): Promise<VideoGenerateResponse>;
  /** B3: 预估单次生成成本(CNY), basis="accurate"表示实价、"estimated"表示估算 */
  estimateCost?(req: VideoGenerateRequest): { cny: number; basis: "accurate" | "estimated" };
  /** S1: 尝试取消远端 provider 任务。cancelled=已取消, unsupported=不支持, failed=取消失败 */
  cancel?(providerJobId: string, ctx: ProviderContext): Promise<"cancelled" | "unsupported" | "failed">;
}

// ─── TTS Provider ──────────────────────────────────────────────────

export interface TtsSynthesizeRequest {
  text: string;
  voice_id: string;
  rate?: number;
  format?: "m4a" | "mp3" | "wav";
}

export interface GeneratedAudio {
  buffer: Buffer;
  mime: string;
  duration_sec: number;
}

export interface TtsSynthesizeResponse {
  audio: GeneratedAudio;
  cost?: CostInfo;
}

export interface TtsVoiceInfo {
  id: string;
  gender: string;
  language: string;
  style?: string;
}

export interface TtsProvider {
  readonly id: string;
  synthesize(req: TtsSynthesizeRequest, ctx: ProviderContext): Promise<TtsSynthesizeResponse>;
  listVoices?(): Promise<TtsVoiceInfo[]>;
  healthCheck(): Promise<HealthCheckResult>;
}

// ─── Union ─────────────────────────────────────────────────────────

export type AnyProvider = LlmProvider | ImageProvider | VideoProvider | TtsProvider;
export type ProviderKind = "llm" | "image" | "video" | "tts";
