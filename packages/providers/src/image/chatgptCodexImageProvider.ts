// ChatGPT Codex Image Provider
//
// Uses an OAuth access_token (obtained via the Codex CLI–compatible PKCE flow
// implemented in packages/core/src/chatgptOauth.ts) to invoke OpenAI's image
// generation backend with the user's ChatGPT Plus / Pro / Team subscription
// quota instead of a metered API key.
//
// Why this is non-trivial:
//   - OpenAI gates `/v1/images/generations` behind API-key auth at api.openai.com.
//     The ChatGPT Codex OAuth token isn't accepted there.
//   - But the ChatGPT Plus tier exposes `/backend-api/codex/responses` and
//     `/backend-api/conversation` style endpoints that DO accept the OAuth
//     bearer token. The Codex CLI (and OpenClaw's `openai-codex` provider)
//     route requests through the Responses API at chatgpt.com with the
//     `image_generation` built-in tool to produce gpt-image-2 output without
//     a separate API key.
//
// Endpoint resolution (in order of preference):
//   1. CHATGPT_CODEX_IMAGE_BASE_URL setting (advanced override)
//   2. https://chatgpt.com/backend-api  (Responses API + image_generation tool)
//
// Important: in Responses API, `gpt-image-2` belongs to the image_generation
// tool. The top-level `model` must be a text-capable mainline model such as
// gpt-5.5, otherwise the Codex backend rejects the request as an unsupported
// conversation model.
//
// SAFETY: Image generation through ChatGPT's responses API consumes the user's
// ChatGPT subscription image quota — same as if they generated in chat.com.
// The user explicitly opted in to this (settings page button + memory record).

import type { PresetOption } from "../../../core/src/presetSchema";
import type {
  ImageProvider,
  ImageGenerateRequest,
  ImageGenerateResponse,
  ProviderContext,
  HealthCheckResult,
  GeneratedImage
} from "../core/types";
import { ProviderError, codeFromHttpStatus } from "../core/errors";
import {
  getStatus,
  getValidAccessToken,
  CHATGPT_BACKEND_BASE_URL,
  bumpQuotaCounter
} from "../../../core/src/chatgptOauth";
import { getConfigValue } from "../../../core/src/localSettings";

interface InternalCfg {
  image_model: string;
  responses_model: string;
  preferred_base_url?: string;
}

// 2026-05-27 — 强化 system instructions: ChatGPT 4o/gpt-image-1 在收到带"动作 +
// 镜头 + 多人物"描述的提示词时, 容易生成"故事板/九宫格/分屏拼贴"风格图. 用户
// 截图反馈这个问题. system 级强制单帧, 比 user prompt 内"不要分镜"指令更稳.
const CODEX_IMAGE_INSTRUCTIONS = [
  "You are an image generation assistant for an AI short-film production tool.",
  "Every request describes ONE single shot, ONE single moment. Your output must be ONE single cinematic still image filling the whole canvas.",
  "STRICTLY FORBIDDEN: storyboard layouts, comic panels, grid mosaics, split screens, multiple frames stitched together, picture-in-picture, before/after collages, 4-panel / 6-panel / 9-panel layouts.",
  "If the user's prompt describes a sequence or multiple beats, pick ONE representative moment and render it as one unified image — never split the canvas.",
].join(" ");

export class ChatgptCodexImageProvider implements ImageProvider {
  readonly id: string;
  private _cfg: InternalCfg;

  constructor(cfg: PresetOption, _apiKey: string | null) {
    this.id = cfg.id;
    const base = (cfg as any).base_url as string | undefined;
    const imageModel = normalizeImageModel(((cfg as any).model_id as string | undefined) ?? "gpt-image-2");
    this._cfg = {
      image_model: imageModel,
      responses_model: ((cfg as any).responses_model as string | undefined) ?? "gpt-5.5",
      preferred_base_url: base,
    };
  }

  async generate(req: ImageGenerateRequest, ctx: ProviderContext): Promise<ImageGenerateResponse> {
    const status = getStatus();
    if (!status.logged_in) {
      throw new ProviderError({
        message: "ChatGPT 账号未登录 — 请在设置页用 ChatGPT 账号登录后再使用此模型",
        code: "missing_key",
        provider_id: this.id,
        retriable: false
      });
    }

    const token = await getValidAccessToken();
    const size = this._mapSize(req.width, req.height);
    const baseBackend = getConfigValue("CHATGPT_CODEX_IMAGE_BASE_URL") || this._cfg.preferred_base_url || CHATGPT_BACKEND_BASE_URL;
    const responsesModel = getConfigValue("CHATGPT_CODEX_RESPONSES_MODEL")
      || getConfigValue("PROVIDER_CHATGPT_CODEX_IMAGE_RESPONSES_MODEL")
      || this._cfg.responses_model
      || "gpt-5.5";
    // B5: request.model_id (from ModelPicker model_ref colon-suffix) takes
    // priority over instance defaults and env overrides — users who pick
    // "chatgpt_codex_image:gpt-image-2" must get gpt-image-2 regardless of
    // what the preset file or local-settings env says.
    const imageModel = normalizeImageModel(
      req.model_id
        || getConfigValue("CHATGPT_CODEX_IMAGE_MODEL")
        || getConfigValue("PROVIDER_CHATGPT_CODEX_IMAGE_MODEL")
        || this._cfg.image_model
        || "gpt-image-2"
    );

    ctx.log("info", `[chatgpt-codex-image] generate responsesModel=${responsesModel} imageModel=${imageModel} size=${size} count=${req.count} prompt="${req.prompt.slice(0, 80)}"`);

    let lastErr: Error | null = null;
    const wanted = Math.max(1, Math.min(req.count, 4));
    const images: GeneratedImage[] = [];

    for (let i = 0; i < wanted; i += 1) {
      try {
        const response = await this._generateViaResponses({
          token,
          baseUrl: baseBackend,
          responsesModel,
          imageModel,
          req,
          size,
          ctx
        });
        // 2026-05-16 渐进式落盘: 每张完成后立即触发 on_image_ready (caller 把它
        // 落盘 + emit SSE image.partial, 用户在图库看到 skeleton 被真图替换).
        // 单次 _generateViaResponses 通常返 1 张, 容错性地 forEach 处理.
        for (const img of response.images) {
          images.push(img);
          if (req.on_image_ready) {
            try {
              await req.on_image_ready(img, images.length - 1, wanted);
            } catch (cbErr) {
              ctx.log(
                "warn",
                `[chatgpt-codex-image] on_image_ready 回调失败 (index=${images.length - 1}): ${
                  cbErr instanceof Error ? cbErr.message : cbErr
                }`,
              );
              // 回调失败不阻塞主流程 — 让 caller 自行决定补偿.
            }
          }
        }
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        ctx.log("warn", `[chatgpt-codex-image] responsesModel=${responsesModel} imageModel=${imageModel} failed: ${lastErr.message.slice(0, 200)}`);
        // 401/403 不再继续试下一个模型 —— 是认证问题,换模型也没用。
        if (/HTTP 400|HTTP 401|HTTP 403|invalid_token|unauthorized|unsupported/i.test(lastErr.message)) {
          break;
        }
      }
    }

    if (images.length > 0) {
      try {
        await bumpQuotaCounter(images.length);
      } catch (e) {
        ctx.log("warn", `[chatgpt-codex-image] quota counter bump failed: ${e instanceof Error ? e.message : e}`);
      }
      return { images: images.slice(0, wanted) };
    }

    const msg = lastErr?.message ?? "ChatGPT Codex image generation failed";
    const guidance = /401|403|unauthorized|invalid_token/i.test(msg)
      ? "ChatGPT 订阅生图认证失败 — 可能令牌过期或账号无 gpt-image-2 权限,请尝试在设置页重新登录或切换为本地 SDXL / Gemini / 万相等模型继续"
      : `ChatGPT 订阅生图失败: ${msg.slice(0, 240)} — 当前请求使用 Responses 顶层模型 ${responsesModel} + image_generation 工具模型 ${imageModel}`;

    throw new ProviderError({
      message: guidance,
      code: /401|403|unauthorized|invalid_token/i.test(msg) ? "missing_key" : "server",
      provider_id: this.id,
      retriable: false,
      original: lastErr ?? undefined
    });
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const status = getStatus();
    if (!status.logged_in) return { ok: false, reason: "ChatGPT 账号未登录" };
    if (status.expires_at_ms && status.expires_at_ms < Date.now()) {
      return { ok: false, reason: "ChatGPT 访问令牌已过期，需要重新登录或刷新" };
    }
    return { ok: true };
  }

  estimateCost(req: ImageGenerateRequest): { cny: number; basis: "estimated" } {
    // ChatGPT Plus subscription — counted against user's monthly image quota, no
    // direct per-image USD billing. Surface as 0 with a note via "estimated".
    return { cny: 0, basis: "estimated" };
  }

  // ─── internals ─────────────────────────────────────────────────────

  private _mapSize(w: number, h: number): "1024x1024" | "1536x1024" | "1024x1536" {
    if (w === h) return "1024x1024";
    if (w > h) return "1536x1024";
    return "1024x1536";
  }

  /**
   * Strategy A: chatgpt.com /backend-api/codex/responses with the image_generation tool.
   *
   * The Responses API streams back tool calls + a final assistant message that
   * contains base64 image parts. We collect them.
   */
  private async _generateViaResponses(args: {
    token: string;
    baseUrl: string;
    responsesModel: string;
    imageModel: string;
    req: ImageGenerateRequest;
    size: "1024x1024" | "1536x1024" | "1024x1536";
    ctx: ProviderContext;
  }): Promise<ImageGenerateResponse> {
    const { token, baseUrl, responsesModel, imageModel, req, size, ctx } = args;

    // Build messages — text-only generation, or text + reference image.
    const userContent: any[] = [{ type: "input_text", text: req.prompt }];
    if (req.reference_images && req.reference_images.length > 0) {
      const fs = await import("node:fs/promises");
      for (const ref of req.reference_images.slice(0, 4)) {
        try {
          const buf = await fs.readFile(ref.asset_id);
          const mime = await this._detectMime(ref.asset_id, buf);
          const b64 = buf.toString("base64");
          userContent.push({
            type: "input_image",
            image_url: `data:${mime};base64,${b64}`,
            detail: "high"
          });
        } catch (err) {
          ctx.log("warn", `[chatgpt-codex-image] skip ref ${ref.asset_id}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    const body = {
      model: responsesModel,
      input: [
        {
          role: "user",
          content: userContent
        }
      ],
      instructions: CODEX_IMAGE_INSTRUCTIONS,
      tools: [
        {
          type: "image_generation",
          model: imageModel,
          size,
          quality: "high",
          output_format: "png"
        }
      ],
      tool_choice: { type: "image_generation" },
      // Match Codex/OpenClaw transport: the Codex image route returns image
      // tool results through Responses SSE events.
      stream: true,
      // store:false avoids polluting the user's ChatGPT history with these calls.
      store: false
    };

    const url = resolveCodexResponsesUrl(baseUrl);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        // OpenAI's Codex backend looks at this header to route quota.
        "OpenAI-Beta": "responses=experimental",
        // Identify ourselves — same UA shape Codex CLI uses.
        "User-Agent": "video-generate/chatgpt-codex-image (+oauth-pkce)",
        Accept: "text/event-stream"
      },
      body: JSON.stringify(body),
      // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
      // 删 AbortSignal.timeout(180_000), 只透传 ctx.signal (用户主动中止). ChatGPT 订阅复杂图
      // 可能 >3min, 不能本地误判超时.
      signal: ctx.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // W7 (2026-05-16): OpenAI 错误正文可能含敏感串(Bearer/JWT/sk-* 早被 res 屏蔽,
      // 但 org_id / project_id / user email / quota 文案仍可能裹在 JSON 里)。
      // 顶层 errorMiddleware 的 scrubForClient 已覆盖 Bearer/sk-/tp-/JWT/api_key/token/secret,
      // 这里额外做 truncate(200 字符)+ 关键模式替换 + 包成 ProviderError 让分类正确。
      const scrubbed = text
        .replace(/Bearer\s+[A-Za-z0-9_\-]{8,}/g, "Bearer [REDACTED]")
        .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-[REDACTED]")
        .replace(/tp-[a-z0-9]{20,}/g, "tp-[REDACTED]")
        .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]")
        .replace(/\borg-[A-Za-z0-9]{6,}/g, "org-[REDACTED]")
        .replace(/\bproj_[A-Za-z0-9]{6,}/g, "proj_[REDACTED]")
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]")
        .slice(0, 200);
      throw new ProviderError({
        message: `ChatGPT 图像服务返回 HTTP ${res.status} ${res.statusText}${scrubbed ? `: ${scrubbed}` : ""}`,
        code: codeFromHttpStatus(res.status),
        provider_id: this.id,
        original: { status: res.status, statusText: res.statusText },
      });
    }
    const text = await res.text();
    const images = extractImagesFromCodexResponseText(text, req.width, req.height);
    if (images.length === 0) {
      throw new ProviderError({
        message: "ChatGPT 图像服务未返回图片内容",
        code: "invalid_output",
        provider_id: this.id,
      });
    }
    return { images };
  }

  // (B) /v1/images/generations fallback removed per PM 2026-05-14:
  //     user has no API key by design, OAuth-only routing is the source of truth.
  //     Errors now bubble up and the UI guides user to switch image model.

  private async _detectMime(filePath: string, buf: Buffer): Promise<string> {
    // Trust extension first, fall back to magic bytes.
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    // Magic-byte detection
    if (buf.length >= 8) {
      const head = buf.subarray(0, 8).toString("hex");
      if (head.startsWith("89504e47")) return "image/png";
      if (head.startsWith("ffd8ff")) return "image/jpeg";
      if (head.startsWith("47494638")) return "image/gif";
      if (head.startsWith("52494646")) return "image/webp";
    }
    return "image/png";
  }
}

// ─── Responses API result parsing ─────────────────────────────────────

interface ResponsesAPIResult {
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      // Newer schema (gpt-image-2 via responses)
      image?: { b64_json?: string; url?: string };
      // Older schema
      b64_json?: string;
      url?: string;
      // Image tool output node
      result?: string; // base64 png
      output?: string; // some endpoints
    }>;
    // Tool-call output nodes
    result?: string;
    output?: string;
    image?: { b64_json?: string; url?: string };
  }>;
  // Legacy / alternate shape
  data?: Array<{ b64_json?: string; url?: string }>;
}

type ResponsesOutputItem = NonNullable<ResponsesAPIResult["output"]>[number];

interface CodexSseEvent {
  type?: string;
  item?: ResponsesOutputItem & {
    revised_prompt?: string;
  };
  response?: ResponsesAPIResult & {
    usage?: unknown;
    tool_usage?: unknown;
  };
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
}

function resolveCodexResponsesUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, "");
  if (/\/responses$/i.test(clean)) return clean;
  if (/\/codex$/i.test(clean)) return `${clean}/responses`;
  return `${clean}/codex/responses`;
}

function extractImagesFromCodexResponseText(
  body: string,
  width: number,
  height: number
): GeneratedImage[] {
  const trimmed = body.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("data:") || trimmed.includes("\ndata:")) {
    return extractImagesFromCodexSse(trimmed, width, height);
  }

  try {
    return extractImagesFromResponsesResult(JSON.parse(trimmed) as ResponsesAPIResult, width, height);
  } catch {
    return [];
  }
}

function extractImagesFromCodexSse(
  body: string,
  width: number,
  height: number
): GeneratedImage[] {
  const events = parseCodexSseEvents(body);
  const failure = events.find((event) => event.type === "response.failed" || event.type === "error");
  if (failure) {
    const message = failure.error?.message
      ?? failure.message
      ?? (failure.error?.code ? `OpenAI Codex image generation failed (${failure.error.code})` : "");
    throw new Error(message || "OpenAI Codex image generation failed");
  }

  const outputItemImages: GeneratedImage[] = [];
  for (const event of events) {
    if (event.type !== "response.output_item.done") continue;
    if (event.item?.type !== "image_generation_call") continue;
    outputItemImages.push(...extractImagesFromResponsesResult({ output: [event.item] }, width, height));
  }
  if (outputItemImages.length > 0) return outputItemImages;

  const completed = events.find((event) => event.type === "response.completed" && event.response);
  return completed?.response
    ? extractImagesFromResponsesResult(completed.response, width, height)
    : [];
}

function parseCodexSseEvents(body: string): CodexSseEvent[] {
  const events: CodexSseEvent[] = [];
  const blocks = body.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, ""))
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as CodexSseEvent);
    } catch {
      // Ignore non-JSON keepalive/debug lines.
    }
  }
  return events;
}

function extractImagesFromResponsesResult(
  data: ResponsesAPIResult,
  width: number,
  height: number
): GeneratedImage[] {
  const out: GeneratedImage[] = [];
  const push = (b64?: string) => {
    if (!b64) return;
    const cleaned = b64.replace(/^data:[^,]+,/, "");
    out.push({
      buffer: Buffer.from(cleaned, "base64"),
      mime: "image/png",
      width,
      height
    });
  };

  // Shape 1: data: [{ b64_json }]
  for (const d of data.data ?? []) push(d.b64_json);

  // Shape 2: output: [{ content: [{ image: { b64_json } }, …] }]
  for (const item of data.output ?? []) {
    if (item.image?.b64_json) push(item.image.b64_json);
    if (typeof item.result === "string") push(item.result);
    if (typeof item.output === "string" && item.output.length > 100) push(item.output);
    for (const c of item.content ?? []) {
      if (c.image?.b64_json) push(c.image.b64_json);
      if (c.b64_json) push(c.b64_json);
      if (c.result) push(c.result);
      if (typeof c.output === "string" && c.output.length > 100) push(c.output);
    }
  }

  return out;
}

function normalizeImageModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return "gpt-image-2";
  return trimmed.replace(/^openai\//i, "");
}
