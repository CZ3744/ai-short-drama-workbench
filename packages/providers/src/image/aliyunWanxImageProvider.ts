import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  HealthCheckResult,
  ImageGenerateRequest,
  ImageGenerateResponse,
  ImageProvider,
  ProviderContext,
  GeneratedImage,
} from "../core/types";
import { ProviderError, codeFromHttpStatus } from "../core/errors";
import { saveInflight, removeInflight } from "../core/inflightStore";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com";
const DEFAULT_MODEL = "wan2.6-t2i";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 180_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export class AliyunWanxImageProvider implements ImageProvider {
  readonly id: string;
  private _cfg: PresetOption;
  private _apiKey: string | null;

  constructor(cfg: PresetOption, apiKey: string | null) {
    this.id = cfg.id;
    this._cfg = cfg;
    this._apiKey = apiKey;
  }

  async generate(req: ImageGenerateRequest, ctx: ProviderContext): Promise<ImageGenerateResponse> {
    if (!this._apiKey) {
      throw new ProviderError({
        message: "DashScope API key not configured for Aliyun Wanx image provider",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }

    const baseUrl = this._baseUrl();
    // B5: request.model_id (ModelPicker colon-suffix) takes priority over
    // cfg.model_id / cfg.model so users can switch wan2.6-t2i ↔ wan2.5-t2i
    // without creating a new provider instance.
    const model = req.model_id?.trim() || this._model();
    const count = clampInt(req.count, 1, MAX_IMAGES);
    const size = normalizedSize(req.width, req.height);
    const timeoutMs = Number((this._cfg as JsonRecord).timeout_ms ?? DEFAULT_TIMEOUT_MS);
    const prompt = clampText(req.prompt, 2100);
    const negativePrompt = clampText(req.negative_prompt ?? "", 500);

    if (req.reference_images?.length) {
      ctx.log(
        "warn",
        `[${this.id}] DashScope text-to-image endpoint does not accept reference_images; ${req.reference_images.length} reference(s) ignored`,
      );
    }

    ctx.log("info", `[${this.id}] Generating ${count} image(s), model=${model}, size=${size}`);

    // B20: 删除同步路径（multimodal endpoint 混用 qwen-vl，与纯文生图不一致）
    // 只走异步路径: POST text2image/image-synthesis + X-DashScope-Async: enable + poll
    // 2026-05-19: ctx.signal 现在 optional, 用 new AbortController().signal 兜底 (never-abort).
    const signalOrNoop = ctx.signal ?? new AbortController().signal;

    // X1-2 (A1-3): 对齐视频 C7 加固 — 异步付费图像 provider 的 post-submit 防重复扣费。
    // 提交拿到 task_id = 远端任务已建、DashScope 计费开始。此后 poll 超时 (_pollTask:204 retriable:true)
    // 或 download 失败 (downloadImage 5xx/429 retriable:true) 若原样上抛, queue._execute 会重跑
    // generate() → 重新 _submitAsync 一个全新计费 task = 同一次首帧扣 2-3 遍钱。故 post-submit 任何
    // 失败一律强制 retriable:false 阻止队列重跑, 并保留 inflight 留存"已扣费"审计凭证 (若有 task_id)。
    let taskId: string | undefined;
    let inflightId: string | undefined;
    let preserveInflightForResume = false;
    try {
      taskId = await this._submitAsync(baseUrl, model, prompt, negativePrompt, count, size, req.seed, timeoutMs, signalOrNoop);

      // M7 对齐视频: 提交成功后立即 saveInflight (poll 前), post-submit 失败保留留证。
      const inflight = await saveInflight({
        provider_id: this.id,
        provider_job_id: taskId,
        submitted_at: new Date().toISOString(),
        context: { series_slug: ctx.series_slug, shot_id: ctx.task_id, kind: "image", job_id: ctx.job_id },
      });
      inflightId = inflight.inflight_id;

      const raw = await this._pollTask(baseUrl, taskId, signalOrNoop);

      const payloads = extractImages(raw);
      if (payloads.length === 0) {
        throw new ProviderError({
          message: "Aliyun Wanx image task succeeded but no image payload was returned",
          code: "invalid_output",
          provider_id: this.id,
          retriable: false,
        });
      }

      const images: GeneratedImage[] = [];
      for (const payload of payloads.slice(0, count)) {
        const buffer = payload.kind === "base64"
          ? Buffer.from(stripDataUrl(payload.value), "base64")
          : await downloadImage(payload.value, signalOrNoop);
        images.push({
          buffer,
          mime: "image/png",
          width: parseSize(size).width,
          height: parseSize(size).height,
          seed: req.seed,
        });
      }

      const costPerImageCny = Number((this._cfg as JsonRecord).cost_per_image_cny ?? 0);
      return {
        images,
        cost: costPerImageCny > 0
          ? { currency: "CNY", amount: costPerImageCny * images.length, basis: "estimated" }
          : undefined,
      };
    } catch (err) {
      // X1-2: post-submit (taskId 已定义) 的 retriable 错误一律降级为 retriable:false + 保留 inflight,
      // 防 queue 重跑重扣。pre-submit 失败 (taskId 未定义, 远端未建任务、未扣费) 保留原 retriable 让队列重试。
      if (err instanceof ProviderError) {
        if (taskId !== undefined && err.retriable) {
          preserveInflightForResume = true;
          throw new ProviderError({ message: err.message, code: err.code, provider_id: this.id, retriable: false, original: (err as { original?: unknown }).original ?? err });
        }
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const postSubmit = taskId !== undefined;
      if (postSubmit) preserveInflightForResume = true;
      throw new ProviderError({
        message: `Aliyun Wanx image generation failed: ${msg}`,
        code: "server",
        provider_id: this.id,
        retriable: !postSubmit,
        original: err,
      });
    } finally {
      // 完成/pre-submit 失败清 inflight; post-submit 失败保留 (留证 + 备将来图像 resume 消费)。
      if (inflightId && !preserveInflightForResume) await removeInflight(inflightId).catch(() => {});
    }
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (!this._apiKey) return { ok: false, reason: "missing DASHSCOPE_API_KEY / ALIYUN_DASHSCOPE_API_KEY" };
    return { ok: true };
  }

  estimateCost(req: ImageGenerateRequest): { cny: number; basis: "estimated" } {
    const costPerImageCny = Number((this._cfg as JsonRecord).cost_per_image_cny ?? 0);
    return { cny: costPerImageCny * clampInt(req.count, 1, MAX_IMAGES), basis: "estimated" };
  }

  // X7-6 (2026-07-22): 重启后续取一条已提交(已扣费)的图像任务。X1-2 已在 generate() post-submit
  // 失败时保留 inflight(kind:"image") + provider_job_id=DashScope task_id, 此方法用它把已产出的图捞回来。
  // 只 _pollTask + download, 绝不 _submitAsync → 零重复扣费(与 VideoProvider.resumePoll 同契约)。
  async resumePoll(providerJobId: string, signal?: AbortSignal): Promise<ImageGenerateResponse> {
    if (!this._apiKey) {
      throw new ProviderError({
        message: "DashScope API key not configured for Aliyun Wanx image resume",
        code: "missing_key",
        provider_id: this.id,
        retriable: false,
      });
    }
    const baseUrl = this._baseUrl();
    // 铁律#1: 不叠加本地 timeout, 只透传 caller signal(启动 resume 不传 → never-abort noop)。
    const signalOrNoop = signal ?? new AbortController().signal;
    const raw = await this._pollTask(baseUrl, providerJobId, signalOrNoop);

    const payloads = extractImages(raw);
    if (payloads.length === 0) {
      throw new ProviderError({
        message: `Aliyun Wanx resume task ${providerJobId} succeeded but no image payload was returned`,
        code: "invalid_output",
        provider_id: this.id,
        retriable: false,
      });
    }

    const images: GeneratedImage[] = [];
    for (const payload of payloads) {
      const buffer = payload.kind === "base64"
        ? Buffer.from(stripDataUrl(payload.value), "base64")
        : await downloadImage(payload.value, signalOrNoop);
      // resume 时无原始 size, 从 PNG IHDR 直接读真实尺寸 (DashScope 恒返 PNG); 读不出退 0 (仅元数据, 不影响落盘)。
      const dims = pngDimensions(buffer);
      images.push({ buffer, mime: "image/png", width: dims.width, height: dims.height });
    }

    const costPerImageCny = Number((this._cfg as JsonRecord).cost_per_image_cny ?? 0);
    return {
      images,
      cost: costPerImageCny > 0
        ? { currency: "CNY", amount: costPerImageCny * images.length, basis: "estimated" }
        : undefined,
    };
  }

  // 2026-05-28 audit P1-27: 删除 _submitSync 死代码 — 全 repo 只在本文件出现一次, 没人调.
  // Aliyun Wanx 都走 _submitAsync (X-DashScope-Async 异步路径), sync 端点是过时的设计.

  private async _submitAsync(
    baseUrl: string,
    model: string,
    prompt: string,
    negativePrompt: string,
    count: number,
    size: string,
    seed: number | undefined,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<string> {
    const isWan26 = model.startsWith("wan2.6");
    const url = isWan26
      ? `${baseUrl}/api/v1/services/aigc/image-generation/generation`
      : `${baseUrl}/api/v1/services/aigc/text2image/image-synthesis`;
    const raw = await this._postDashScope(url, isWan26 ? {
      model,
      input: {
        messages: [
          {
            role: "user",
            content: [
              { text: prompt },
            ],
          },
        ],
      },
      parameters: {
        size,
        n: count,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        ...(seed != null ? { seed } : {}),
      },
    } : {
      model,
      input: {
        prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      },
      parameters: {
        size,
        n: count,
        ...(seed != null ? { seed } : {}),
      },
    }, timeoutMs, signal, { "X-DashScope-Async": "enable" });

    const taskId = getNestedString(raw, ["output", "task_id"]);
    if (!taskId) {
      throw new ProviderError({
        message: "Aliyun Wanx async submit response missing output.task_id",
        code: "invalid_output",
        provider_id: this.id,
        retriable: false,
      });
    }
    return taskId;
  }

  private async _pollTask(baseUrl: string, taskId: string, signal: AbortSignal): Promise<unknown> {
    const pollIntervalMs = Number((this._cfg as JsonRecord).poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS);
    const pollTimeoutMs = Number((this._cfg as JsonRecord).poll_timeout_ms ?? DEFAULT_POLL_TIMEOUT_MS);
    const startedAt = Date.now();
    const url = `${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`;

    while (Date.now() - startedAt < pollTimeoutMs) {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this._apiKey}` },
        // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
        // 删 AbortSignal.timeout(30_000), 只透传 ctx.signal (用户主动中止).
        signal,
      });
      const raw = await response.json().catch(() => ({}));
      if (!response.ok) throw this._httpError(response.status, raw, false);

      const status = getNestedString(raw, ["output", "task_status"]) ?? "UNKNOWN";
      if (status === "SUCCEEDED") return raw;
      if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
        throw new ProviderError({
          message: `Aliyun Wanx task ${taskId} ended with status ${status}: ${extractErrorText(raw)}`,
          code: status === "FAILED" ? "server" : "unknown",
          provider_id: this.id,
          retriable: status === "UNKNOWN",
        });
      }

      await abortableSleep(pollIntervalMs, signal);
    }

    throw new ProviderError({
      message: `Aliyun Wanx image task ${taskId} timed out after ${pollTimeoutMs}ms`,
      code: "timeout",
      provider_id: this.id,
      retriable: true,
    });
  }

  private async _postDashScope(
    url: string,
    body: unknown,
    _timeoutMs: number,
    signal: AbortSignal,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
      // 删 AbortSignal.timeout(timeoutMs), 只透传 ctx.signal (用户主动中止). _timeoutMs 参数保留 backward-compat 但不再读取.
      signal,
    });
    const raw = await response.json().catch(() => ({}));
    if (!response.ok) throw this._httpError(response.status, raw, response.status === 429 || response.status >= 500);
    return raw;
  }

  private _httpError(status: number, raw: unknown, retriable: boolean): ProviderError {
    return new ProviderError({
      message: `Aliyun Wanx API ${status}: ${extractErrorText(raw)}`,
      code: codeFromHttpStatus(status),
      provider_id: this.id,
      retriable,
      original: raw,
    });
  }

  private _baseUrl(): string {
    return String((this._cfg as JsonRecord).base_url ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  private _model(): string {
    return String((this._cfg as JsonRecord).model_id ?? (this._cfg as JsonRecord).model ?? DEFAULT_MODEL);
  }
}

function normalizedSize(width: number, height: number): string {
  const ratio = width / Math.max(1, height);
  const maxPixels = 1440 * 1440;
  const minPixels = 1280 * 1280;
  let w = Math.max(512, Math.round(width));
  let h = Math.max(512, Math.round(height));
  const pixels = w * h;

  if (pixels > maxPixels) {
    const scale = Math.sqrt(maxPixels / pixels);
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
  } else if (pixels < minPixels) {
    const scale = Math.sqrt(minPixels / pixels);
    w = Math.ceil(w * scale);
    h = Math.ceil(h * scale);
  }

  if (ratio > 4) {
    h = Math.max(512, Math.ceil(w / 4));
  } else if (ratio < 0.25) {
    w = Math.max(512, Math.ceil(h / 4));
  }

  return `${toEven(w)}*${toEven(h)}`;
}

function parseSize(size: string): { width: number; height: number } {
  const [w, h] = size.split("*").map((v) => Number(v));
  return { width: w || 1024, height: h || 1024 };
}

function toEven(value: number): number {
  return value % 2 === 0 ? value : value - 1;
}

function clampInt(value: number, min: number, max: number): number {
  const finite = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, finite));
}

function clampText(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

type ImagePayload = { kind: "url" | "base64"; value: string };

function extractImages(raw: unknown): ImagePayload[] {
  const result: ImagePayload[] = [];
  const push = (kind: "url" | "base64", value: unknown) => {
    if (typeof value !== "string" || value.length === 0) return;
    result.push({ kind, value });
  };

  const output = isRecord(raw) ? raw.output : undefined;
  if (isRecord(output)) {
    const results = Array.isArray(output.results) ? output.results : [];
    for (const item of results) {
      if (!isRecord(item)) continue;
      push("url", item.url ?? item.image_url);
      push("base64", item.b64_json ?? item.image_base64);
    }

    push("url", output.url ?? output.image_url);
    push("base64", output.b64_json ?? output.image_base64);

    const choices = Array.isArray(output.choices) ? output.choices : [];
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      const message = isRecord(choice.message) ? choice.message : undefined;
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        push("url", block.image ?? block.image_url ?? block.url);
        push("base64", block.b64_json ?? block.image_base64);
      }
    }
  }

  return result;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getNestedString(value: unknown, keys: string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of keys) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return typeof cursor === "string" ? cursor : undefined;
}

function extractErrorText(raw: unknown): string {
  if (!isRecord(raw)) return String(raw);
  const message = raw.message ?? raw.code ?? raw.request_id;
  if (typeof message === "string") return message.slice(0, 400);
  const nested = isRecord(raw.error) ? raw.error.message ?? raw.error.code : undefined;
  if (typeof nested === "string") return nested.slice(0, 400);
  return JSON.stringify(raw).slice(0, 400);
}

function stripDataUrl(value: string): string {
  return value.includes(",") ? value.split(",").pop() ?? "" : value;
}

// X7-6: 从 PNG IHDR 读真实宽高 (8-byte 签名 + IHDR: width@16, height@20, big-endian uint32)。
// 仅用于 resume 时补图像元数据 (原始 size 已丢); 非 PNG / 损坏 → 返 0/0 (不影响 buffer 落盘)。
function pngDimensions(buffer: Buffer): { width: number; height: number } {
  try {
    if (
      buffer.length >= 24 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    ) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
  } catch {
    // fall through
  }
  return { width: 0, height: 0 };
}

async function downloadImage(url: string, externalSignal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, {
    // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
    // 删 AbortSignal.timeout(60_000), 只透传 externalSignal (用户主动中止).
    signal: externalSignal,
  });
  if (!response.ok) {
    throw new ProviderError({
      message: `Failed to download Aliyun Wanx image: HTTP ${response.status}`,
      code: codeFromHttpStatus(response.status),
      provider_id: "aliyun_wanx_26",
      retriable: response.status >= 500 || response.status === 429,
    });
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new ProviderError({
      message: `Aliyun Wanx image is too large: ${contentLength} bytes`,
      code: "invalid_output",
      provider_id: "aliyun_wanx_26",
      retriable: false,
    });
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
    throw new ProviderError({
      message: `Aliyun Wanx image exceeds ${MAX_IMAGE_BYTES} bytes`,
      code: "invalid_output",
      provider_id: "aliyun_wanx_26",
      retriable: false,
    });
  }
  return Buffer.from(arrayBuffer);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}
