import fs from "node:fs";
import path from "node:path";
import { compactSummary, parseMaybeJson, readLocalSettings, getConfigValue, getConfigValueAny, type JobLogger } from "../../core/src/index";
import { loadLlmConfig, type LlmConfig } from "./config";
import { OpenAiCompatibleProvider, type LlmProvider } from "./llm";

export interface MimoConfig {
  apiKey?: string;
  baseUrl?: string;
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  textModel?: string;
  multimodalModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  ttsFormat?: string;
  temperature?: number;
}

const MIMO_DEFAULT_OPENAI_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1";
const MIMO_DEFAULT_ANTHROPIC_BASE_URL = "https://token-plan-cn.xiaomimimo.com/anthropic";

function resolveMimoBaseUrl(config: MimoConfig): string {
  return (config.openaiBaseUrl || config.baseUrl || MIMO_DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");
}

export interface MultimodalInput {
  text?: string;
  images?: Array<{ data: string; mimeType: string }>;
  audio?: Array<{ data: string; mimeType: string }>;
  video?: Array<{ data: string; mimeType: string }>;
}

export interface MultimodalAnalysis {
  summary: string;
  details: Record<string, any>;
  confidence: number;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: string;
  model: string;
  mode: "text" | "multimodal";
  message: string;
  error?: string;
  error_type?: string;
  suggestion?: string;
  selected_auth?: string;
}

// E-N2 (2026-05-12): input 增加可选 agentName, 让 provider 内部能据此做 task-aware
// temperature / model / params 调整. 旧 caller 不传仍然工作 (backward-compatible).
export interface TextLlmProvider {
  id: string;
  label: string;
  chatJson<T>(input: { system: string; user: string; agentName?: string }): Promise<T>;
  chatText(input: { system: string; user: string; agentName?: string }): Promise<string>;
  test(): Promise<ProviderTestResult & { selected_auth?: string }>;
}

export interface MultimodalProvider {
  id: string;
  label: string;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  analyze(input: MultimodalInput): Promise<MultimodalAnalysis>;
  test(): Promise<ProviderTestResult>;
}

type AuthType = "api-key" | "bearer";

// E-N2 (2026-05-12): task-aware temperature. 不同 agent 适合不同温度:
//   critic / qa / repair / validator → 低温 (0.1, 确定性)
//   creative / brainstorm / title → 高温 (0.7, 多样)
//   其他 → 默认 0.35
// 通过 agentName / handbookName 的前后缀模糊匹配, 由 chatJson/chatText 在构造 body
// 前覆盖. 这是 backward-compatible 的 — 没有命中规则就返回 config 的默认.
export function suggestTemperatureForAgent(agentName: string | undefined, fallback: number): number {
  if (!agentName) return fallback;
  const a = agentName.toLowerCase();
  if (/(critic|qa|publish_qa|content_qa|repair|json_repair|validator)/.test(a)) return 0.1;
  if (/(brainstorm|creative|title_copywriter|cover_designer|character_designer|scene_designer)/.test(a)) return 0.7;
  return fallback;
}

function classifyMimoError(status: number): string {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 404) return "model_not_found";
  if (status === 429) return "quota_or_rate_limit";
  return `http_${status}`;
}

function redactKey(key: string): string {
  if (!key) return "(empty)";
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

/**
 * Shared MiMo API fetch with auth probe.
 * Tries api-key header first, then Bearer token.
 * Returns the parsed JSON response and which auth method succeeded.
 */
export async function fetchMimoWithAuthProbe(
  url: string,
  body: object,
  apiKey: string,
  logger: JobLogger | undefined,
  callerLabel: string
): Promise<{ data: any; authUsed: AuthType }> {
  const authTypes: AuthType[] = ["api-key", "bearer"];
  let lastError: Error | null = null;

  for (const authType of authTypes) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authType === "api-key") {
      headers["api-key"] = apiKey;
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    try {
      // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
      // 删 AbortSignal.timeout(60_000), 远端等多久就等多久, 只听 API 真实结果.
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const data = await response.json() as any;
        return { data, authUsed: authType };
      }

      const status = response.status;
      const errorType = classifyMimoError(status);
      await logger?.line(`MiMo ${callerLabel} ${authType} → ${status} (${errorType}), key=${redactKey(apiKey)}`);

      if (status === 401 || status === 403) {
        lastError = new Error(`MiMo ${callerLabel} auth failed (${authType}): HTTP ${status}`);
        continue;
      }
      if (status === 404) {
        throw Object.assign(new Error(`MiMo ${callerLabel} model/endpoint not found: HTTP 404`), { error_type: "model_not_found" });
      }
      if (status === 429) {
        throw Object.assign(new Error(`MiMo ${callerLabel} rate limit or quota exceeded: HTTP 429`), { error_type: "quota_or_rate_limit" });
      }
      throw Object.assign(new Error(`MiMo ${callerLabel} API error: HTTP ${status}`), { error_type: errorType });
    } catch (error) {
      if (error instanceof Error && (error as any).error_type) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw Object.assign(
    lastError || new Error(`MiMo ${callerLabel}: all auth methods failed`),
    { error_type: lastError?.message?.includes("fetch") ? "network_error" : "auth_failed" }
  );
}

export class MimoTextProvider implements TextLlmProvider {
  id = "mimo";
  label = "MiMo v2.5 Pro";

  private config: MimoConfig;
  private logger?: JobLogger;

  constructor(config: MimoConfig, logger?: JobLogger) {
    this.config = config;
    this.logger = logger;
  }

  async chatJson<T>(input: { system: string; user: string; agentName?: string }): Promise<T> {
    if (!this.config.apiKey) {
      throw Object.assign(new Error("MIMO_API_KEY not configured"), { error_type: "key_missing" });
    }
    const url = `${resolveMimoBaseUrl(this.config)}/chat/completions`;
    // E-N2: task-aware temperature
    const temp = suggestTemperatureForAgent(input.agentName, this.config.temperature || 0.35);
    const body = {
      model: this.config.textModel || "mimo-v2.5-pro",
      temperature: temp,
      messages: [
        { role: "system", content: `${input.system}\n\nReturn only valid JSON. Do not wrap it in Markdown.` },
        { role: "user", content: input.user }
      ],
      response_format: { type: "json_object" }
    };

    const { data } = await fetchMimoWithAuthProbe(url, body, this.config.apiKey!, this.logger, "text");
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("MiMo response missing content");
    }
    return parseMaybeJson<T>(content);
  }

  async chatText(input: { system: string; user: string; agentName?: string }): Promise<string> {
    if (!this.config.apiKey) {
      throw Object.assign(new Error("MIMO_API_KEY not configured"), { error_type: "key_missing" });
    }
    const url = `${resolveMimoBaseUrl(this.config)}/chat/completions`;
    // E-N2: task-aware temperature (chatText)
    const temp = suggestTemperatureForAgent(input.agentName, this.config.temperature || 0.35);
    const body = {
      model: this.config.textModel || "mimo-v2.5-pro",
      temperature: temp,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user }
      ]
    };

    const { data } = await fetchMimoWithAuthProbe(url, body, this.config.apiKey!, this.logger, "text");
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("MiMo response missing content");
    }
    return content;
  }

  async test(): Promise<ProviderTestResult & { selected_auth?: string }> {
    if (!this.config.apiKey) {
      return {
        ok: false,
        provider: this.id,
        model: this.config.textModel || "mimo-v2.5-pro",
        mode: "text",
        message: "MIMO_API_KEY 未配置",
        error: "key_missing",
        suggestion: "请在设置页配置 MiMo API Key",
        selected_auth: "none"
      };
    }

    try {
      const url = `${resolveMimoBaseUrl(this.config)}/chat/completions`;
      const body = {
        model: this.config.textModel || "mimo-v2.5-pro",
        temperature: 0.35,
        messages: [
          { role: "system", content: "Return JSON only." },
          { role: "user", content: "Return exactly this JSON object: {\"ok\":true,\"message\":\"ready\"}" }
        ],
        response_format: { type: "json_object" }
      };

      const { data, authUsed } = await fetchMimoWithAuthProbe(url, body, this.config.apiKey!, this.logger, "text");
      const content = data?.choices?.[0]?.message?.content;
      let parsed: { ok?: boolean; message?: string } = {};
      try { parsed = JSON.parse(content); } catch { parsed = { message: content }; }

      return {
        ok: Boolean(parsed.ok),
        provider: this.id,
        model: this.config.textModel || "mimo-v2.5-pro",
        mode: "text",
        message: parsed.message || "ready",
        selected_auth: authUsed
      };
    } catch (error) {
      const errObj = error as any;
      return {
        ok: false,
        provider: this.id,
        model: this.config.textModel || "mimo-v2.5-pro",
        mode: "text",
        message: "MiMo 文本模型测试失败",
        error: errObj.error_type || (error instanceof Error ? error.message : String(error)),
        suggestion: errObj.error_type === "key_missing"
          ? "请在设置页配置 MiMo API Key"
          : errObj.error_type === "auth_failed"
            ? "API Key 认证失败，请检查 Key 是否正确"
            : errObj.error_type === "model_not_found"
              ? "模型或端点不存在，请检查 MIMO_TEXT_MODEL 和 MIMO_API_BASE_URL"
              : errObj.error_type === "quota_or_rate_limit"
                ? "API 配额或频率限制，请稍后重试"
                : "请检查 MiMo API Key 和网络连接",
        selected_auth: "none"
      };
    }
  }
}

export class MimoMultimodalProvider implements MultimodalProvider {
  id = "mimo_multimodal";
  label = "MiMo 多模态";
  supportsImages = true;
  supportsAudio = false;
  supportsVideo = false;

  private config: MimoConfig;
  private logger?: JobLogger;

  constructor(config: MimoConfig, logger?: JobLogger) {
    this.config = config;
    this.logger = logger;
  }

  async analyze(input: MultimodalInput): Promise<MultimodalAnalysis> {
    if (!this.config.apiKey) {
      throw Object.assign(new Error("MIMO_API_KEY not configured"), { error_type: "key_missing" });
    }
    const url = `${resolveMimoBaseUrl(this.config)}/chat/completions`;

    const messages: any[] = [
      { role: "system", content: "你是一个多模态分析助手，能够理解图片、音频和视频内容。请用中文回复。" }
    ];

    const userContent: any[] = [];
    if (input.text) {
      userContent.push({ type: "text", text: input.text });
    }
    if (input.images) {
      for (const img of input.images) {
        userContent.push({
          type: "image_url",
          image_url: { url: `data:${img.mimeType};base64,${img.data}` }
        });
      }
    }

    messages.push({ role: "user", content: userContent });

    const body = {
      model: this.config.multimodalModel || "mimo-v2.5-pro",
      temperature: this.config.temperature || 0.35,
      messages
    };

    const { data } = await fetchMimoWithAuthProbe(url, body, this.config.apiKey!, this.logger, "multimodal");
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("MiMo multimodal response missing content");
    }

    return {
      summary: content,
      details: { raw_response: data },
      confidence: 0.8
    };
  }

  async test(): Promise<ProviderTestResult & { selected_auth?: string }> {
    if (!this.config.apiKey) {
      return {
        ok: false,
        provider: this.id,
        model: this.config.multimodalModel || "mimo-v2.5-pro",
        mode: "multimodal",
        message: "MIMO_API_KEY 未配置",
        error: "key_missing",
        suggestion: "请在设置页配置 MiMo API Key",
        selected_auth: "none"
      };
    }

    try {
      const url = `${resolveMimoBaseUrl(this.config)}/chat/completions`;
      const body = {
        model: this.config.multimodalModel || "mimo-v2.5-pro",
        messages: [
          { role: "system", content: "Return JSON only." },
          { role: "user", content: "测试多模态连接。请回复：{\"ok\":true,\"message\":\"multimodal ready\"}" }
        ]
      };

      const { data, authUsed } = await fetchMimoWithAuthProbe(url, body, this.config.apiKey!, this.logger, "multimodal");
      const content = data?.choices?.[0]?.message?.content;

      return {
        ok: true,
        provider: this.id,
        model: this.config.multimodalModel || "mimo-v2.5-pro",
        mode: "multimodal",
        message: content || "multimodal ready",
        selected_auth: authUsed
      };
    } catch (error) {
      const errObj = error as any;
      return {
        ok: false,
        provider: this.id,
        model: this.config.multimodalModel || "mimo-v2.5-pro",
        mode: "multimodal",
        message: "MiMo 多模态测试失败",
        error: errObj.error_type || (error instanceof Error ? error.message : String(error)),
        suggestion: errObj.error_type === "key_missing"
          ? "请在设置页配置 MiMo API Key"
          : errObj.error_type === "auth_failed"
            ? "API Key 认证失败，请检查 Key 是否正确"
            : errObj.error_type === "model_not_found"
              ? "模型或端点不存在，请检查模型名和 API 地址"
              : errObj.error_type === "quota_or_rate_limit"
                ? "API 配额或频率限制，请稍后重试"
                : "请检查 MiMo API Key 和网络连接",
        selected_auth: "none"
      };
    }
  }
}

export interface ModelRouterConfig {
  globalProvider: "ikuncode_gpt55" | "mimo_v25_pro" | "auto";
  ikuncodeConfig: LlmConfig;
  mimoConfig: MimoConfig;
}

/**
 * A-5 (2026-05-12): 抽象 OpenAI-compatible adapter, 让 IkuncodeAdapter 之外的
 * provider (OpenAI 官方 / DeepSeek / Qwen / Claude via openai-compat 网关) 都能复用.
 * 之前所有 OpenAI-compat provider 都得各写一个 class, 现在统一走这个 + id/label 注入.
 */
class GenericOpenAiCompatAdapter implements TextLlmProvider {
  id: string;
  label: string;
  private provider: LlmProvider;

  constructor(id: string, label: string, config: LlmConfig, logger?: JobLogger) {
    this.id = id;
    this.label = label;
    this.provider = new OpenAiCompatibleProvider(config, logger);
  }

  async chatJson<T>(input: { system: string; user: string; agentName?: string }): Promise<T> {
    return this.provider.callJson<T>({
      // E-N2: 优先用 caller 传的 agentName (从 agentRunner 转下来), 否则用 provider id
      agentName: input.agentName || this.id,
      promptFile: "inline",
      inputSummary: input.user.slice(0, 200),
      system: input.system,
      user: input.user,
    });
  }

  async chatText(input: { system: string; user: string; agentName?: string }): Promise<string> {
    if (typeof this.provider.callText === "function") {
      return this.provider.callText({
        agentName: input.agentName || this.id,
        promptFile: "inline",
        inputSummary: input.user.slice(0, 200),
        system: input.system,
        user: input.user,
      });
    }
    const result = await this.provider.callJson<{ response?: string }>({
      agentName: input.agentName || this.id,
      promptFile: "inline",
      inputSummary: input.user.slice(0, 200),
      system: input.system,
      user: input.user,
    });
    return (result && typeof (result as any).response === "string")
      ? (result as any).response
      : JSON.stringify(result);
  }

  async test(): Promise<ProviderTestResult> {
    try {
      const result = await this.chatJson<{ ok: boolean; message: string }>({
        system: "Return JSON only.",
        user: 'Return exactly this JSON object: {"ok":true,"message":"ready"}',
      });
      return {
        ok: Boolean(result.ok),
        provider: this.id,
        model: this.provider.config.model,
        mode: "text",
        message: result.message || "ready",
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.id,
        model: this.provider.config.model,
        mode: "text",
        message: `${this.label} test failed`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

class IkuncodeAdapter implements TextLlmProvider {
  id = "ikuncode";
  label = "IKunCode gpt-5.5";
  private provider: LlmProvider;

  constructor(config: LlmConfig, logger?: JobLogger) {
    this.provider = new OpenAiCompatibleProvider(config, logger);
  }

  async chatJson<T>(input: { system: string; user: string; agentName?: string }): Promise<T> {
    return this.provider.callJson<T>({
      // E-N2: 透传 agentName 让底层 OpenAiCompatibleProvider 调温度
      agentName: input.agentName || "IKunCode",
      promptFile: "inline",
      inputSummary: input.user.slice(0, 200),
      system: input.system,
      user: input.user
    });
  }

  async chatText(input: { system: string; user: string; agentName?: string }): Promise<string> {
    // v0.2.4 fix: previously forced every chatText through callJson, which
    // wrapped the response in {response: "..."} and occasionally returned
    // raw JSON back as stringified object when the model emitted free-form
    // prose. Use the provider's plain-text completion path so downstream
    // consumers (visual direction, titles etc.) get clean strings.
    if (typeof this.provider.callText === "function") {
      return await this.provider.callText({
        agentName: input.agentName || "IKunCode",
        promptFile: "inline",
        inputSummary: input.user.slice(0, 200),
        system: input.system,
        user: input.user
      });
    }
    const result = await this.provider.callJson<{ response?: string }>({
      agentName: input.agentName || "IKunCode",
      promptFile: "inline",
      inputSummary: input.user.slice(0, 200),
      system: input.system,
      user: input.user
    });
    return (result && typeof (result as any).response === "string") ? (result as any).response : JSON.stringify(result);
  }

  async test(): Promise<ProviderTestResult> {
    try {
      const result = await this.chatJson<{ ok: boolean; message: string }>({
        system: "Return JSON only.",
        user: "Return exactly this JSON object: {\"ok\":true,\"message\":\"ready\"}"
      });
      return {
        ok: Boolean(result.ok),
        provider: this.id,
        model: "gpt-5.5",
        mode: "text",
        message: result.message || "ready"
      };
    } catch (error) {
      return {
        ok: false,
        provider: this.id,
        model: "gpt-5.5",
        mode: "text",
        message: "IKunCode test failed",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

/**
 * 顺序 fallback 链 — 实现 TextLlmProvider 接口, 把 N 个真实 provider 包成"主→备→兜底"链.
 * Auto 模式默认走这条链, 任一 provider 抛错则降级到下一个; 全失败才向上抛, 由 agentRunner
 * 的 fallback hardcoded JSON 接住.
 */
export class FallbackTextProvider implements TextLlmProvider {
  id: string;
  label: string;
  private providers: TextLlmProvider[];
  private logger?: JobLogger;

  constructor(providers: TextLlmProvider[], logger?: JobLogger) {
    if (providers.length === 0) {
      throw new Error("FallbackTextProvider 至少需要 1 个 provider");
    }
    this.providers = providers;
    this.logger = logger;
    this.id = `fallback_chain[${providers.map(p => p.id).join("→")}]`;
    this.label = `Fallback Chain (${providers.map(p => p.label).join(" → ")})`;
  }

  async chatJson<T>(input: { system: string; user: string; agentName?: string }): Promise<T> {
    let lastErr: unknown;
    const errors: string[] = [];
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i];
      try {
        if (i > 0) {
          await this.logger?.line(`[fallback_chain] try #${i + 1} ${p.id} (上一家失败)`);
        }
        return await p.chatJson<T>(input);
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message ?? err).slice(0, 200);
        errors.push(`${p.id}: ${msg}`);
        await this.logger?.line(`[fallback_chain] ${p.id} chatJson 失败: ${msg}`);
      }
    }
    // E-N3 (2026-05-12): 全失败时把所有 provider 的错聚合到 cause, 之前只抛 lastErr,
    // 用户看不到链上别家的错原因. agentRunner 的 classifyCallError 会用首条 message.
    const aggregated = lastErr instanceof Error
      ? lastErr
      : new Error(`All LLM providers in chain failed: ${String(lastErr)}`);
    (aggregated as any).chain_errors = errors;
    throw aggregated;
  }

  async chatText(input: { system: string; user: string; agentName?: string }): Promise<string> {
    let lastErr: unknown;
    const errors: string[] = [];
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i];
      try {
        if (i > 0) {
          await this.logger?.line(`[fallback_chain] try #${i + 1} ${p.id} (上一家失败)`);
        }
        return await p.chatText(input);
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message ?? err).slice(0, 200);
        errors.push(`${p.id}: ${msg}`);
        await this.logger?.line(`[fallback_chain] ${p.id} chatText 失败: ${msg}`);
      }
    }
    const aggregated = lastErr instanceof Error
      ? lastErr
      : new Error(`All LLM providers in chain failed: ${String(lastErr)}`);
    (aggregated as any).chain_errors = errors;
    throw aggregated;
  }

  async test(): Promise<ProviderTestResult & { selected_auth?: string }> {
    // 取链上第一个 ok 的; 全失败返回最后一次
    let last: ProviderTestResult & { selected_auth?: string } | undefined;
    for (const p of this.providers) {
      try {
        const r = await p.test();
        if (r.ok) return r;
        last = r;
      } catch (err: any) {
        last = {
          ok: false,
          provider: p.id,
          model: "unknown",
          mode: "text",
          message: "test threw",
          error: err?.message ?? String(err),
        };
      }
    }
    return last ?? {
      ok: false,
      provider: this.id,
      model: "unknown",
      mode: "text",
      message: "empty chain",
    };
  }
}

/**
 * A-5 (2026-05-12): Auto 模式之前只串 ikuncode + mimo, 用户花钱填的 OpenAI / Claude
 * / DeepSeek / Qwen key 完全不会被加载. 现在 Auto 模式按以下顺序构造 fallback chain:
 *   1. ikuncode (本地默认, 主路)
 *   2. mimo     (副路)
 *   3. openai   (如配置 OPENAI_API_KEY)
 *   4. claude   (如配置 CLAUDE_API_KEY 且 baseUrl 是 OpenAI 兼容反代)
 *   5. deepseek (如配置 DEEPSEEK_API_KEY)
 *   6. qwen     (如配置 QWEN_API_KEY / DASHSCOPE_API_KEY)
 * 没 key 的 provider 自动跳过. 保证用户填一个 key 就能进 chain.
 */
function buildExtraTextProviders(logger?: JobLogger): TextLlmProvider[] {
  const out: TextLlmProvider[] = [];

  const baseCfg = {
    provider: "",
    baseUrl: "",
    apiKey: "",
    model: "",
    temperature: 0.35,
    mock: false,
    subtitleMode: "both" as const,
    ttsProvider: "silence" as const,
    ttsFallbackProvider: "silence" as const,
    ttsVoice: "",
    ttsRate: "+0%",
    ttsEnabled: false,
  } satisfies LlmConfig;

  const openaiKey = getConfigValue("OPENAI_API_KEY", "").trim();
  if (openaiKey) {
    out.push(new GenericOpenAiCompatAdapter("openai", "OpenAI", {
      ...baseCfg,
      provider: "openai",
      baseUrl: (getConfigValue("OPENAI_BASE_URL", "https://api.openai.com/v1") || "https://api.openai.com/v1").trim(),
      apiKey: openaiKey,
      model: (getConfigValue("OPENAI_MODEL", "gpt-4o-mini") || "gpt-4o-mini").trim(),
    }, logger));
  }

  const claudeKey = getConfigValue("CLAUDE_API_KEY", "").trim();
  const claudeBase = getConfigValue("CLAUDE_BASE_URL", "").trim();
  if (claudeKey && claudeBase) {
    // 仅当用户显式给了 OpenAI 兼容的 Claude 反代 baseUrl 才进 chain;
    // Anthropic 原生 API 走 messages 格式, 这里 OpenAiCompatibleProvider 不支持.
    out.push(new GenericOpenAiCompatAdapter("claude", "Claude (compat)", {
      ...baseCfg,
      provider: "claude",
      baseUrl: claudeBase,
      apiKey: claudeKey,
      model: (getConfigValue("CLAUDE_MODEL", "claude-3-5-sonnet-latest") || "claude-3-5-sonnet-latest").trim(),
    }, logger));
  }

  const deepseekKey = getConfigValue("DEEPSEEK_API_KEY", "").trim();
  if (deepseekKey) {
    out.push(new GenericOpenAiCompatAdapter("deepseek", "DeepSeek", {
      ...baseCfg,
      provider: "deepseek",
      baseUrl: (getConfigValue("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1") || "https://api.deepseek.com/v1").trim(),
      apiKey: deepseekKey,
      model: (getConfigValue("DEEPSEEK_MODEL", "deepseek-chat") || "deepseek-chat").trim(),
    }, logger));
  }

  const qwenKey = getConfigValueAny(["QWEN_API_KEY", "DASHSCOPE_API_KEY"], "").trim();
  if (qwenKey) {
    out.push(new GenericOpenAiCompatAdapter("qwen", "Qwen / DashScope", {
      ...baseCfg,
      provider: "qwen",
      baseUrl: (getConfigValue("QWEN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1") || "https://dashscope.aliyuncs.com/compatible-mode/v1").trim(),
      apiKey: qwenKey,
      model: (getConfigValue("QWEN_MODEL", "qwen-plus") || "qwen-plus").trim(),
    }, logger));
  }

  return out;
}

export class ModelRouter {
  private config: ModelRouterConfig;
  private ikuncodeProvider: IkuncodeAdapter;
  private mimoTextProvider: MimoTextProvider;
  private mimoMultimodalProvider: MimoMultimodalProvider;
  private extraProviders: TextLlmProvider[];
  private logger?: JobLogger;

  constructor(config: ModelRouterConfig, logger?: JobLogger) {
    this.config = config;
    this.logger = logger;
    this.ikuncodeProvider = new IkuncodeAdapter(config.ikuncodeConfig, logger);
    this.mimoTextProvider = new MimoTextProvider(config.mimoConfig, logger);
    this.mimoMultimodalProvider = new MimoMultimodalProvider(config.mimoConfig, logger);
    // A-5: 按用户填的 key 构造额外 provider 列表
    this.extraProviders = buildExtraTextProviders(logger);
  }

  selectTextProvider(task?: string): TextLlmProvider {
    switch (this.config.globalProvider) {
      case "mimo_v25_pro":
        // 用户明确选 mimo, 不走 fallback chain — fail loud
        return this.mimoTextProvider;
      case "auto": {
        // 自动模式: 包成 fallback chain, 任一 provider 失败就降级到下一家
        // 多模态任务 mimo 优先, 反之 ikuncode 优先
        const wantsMultimodal = task && (task.includes("multimodal_analyze") || task.includes("image_understanding"));
        const primary: TextLlmProvider[] = wantsMultimodal
          ? [this.mimoTextProvider, this.ikuncodeProvider]
          : [this.ikuncodeProvider, this.mimoTextProvider];
        // A-5: 追加用户配置的额外 provider (按 OPENAI / CLAUDE / DEEPSEEK / QWEN 顺序)
        const chain: TextLlmProvider[] = [...primary, ...this.extraProviders];
        return new FallbackTextProvider(chain, this.logger);
      }
      case "ikuncode_gpt55":
      default:
        return this.ikuncodeProvider;
    }
  }

  /**
   * A-6 (2026-05-12): 多模态 (image understanding) 之前只单 provider, 现在改成 fallback.
   * 目前仅 Mimo 真实支持; OpenAI Vision 等接入是 follow-up. 但接口已经包装为 chain 形态,
   * 后续加新 multimodal provider 时只在这里 push 一行.
   * IKunCode 模式仍返回 null (没多模态能力), 维持原行为.
   */
  selectMultimodalProvider(): MultimodalProvider | null {
    if (this.config.globalProvider === "ikuncode_gpt55") {
      return null;
    }
    // 目前只有 MimoMultimodalProvider 一家. 仍然返回单 provider, 等真有第二家再包 Fallback.
    // (Auto 模式下用户至少配了 MIMO_API_KEY 才走多模态; 没 key 时 analyze 会抛 key_missing,
    // 由 caller 处理 — 不在 router 层吞掉.)
    return this.mimoMultimodalProvider;
  }

  getIkuncodeProvider(): TextLlmProvider {
    return this.ikuncodeProvider;
  }

  getMimoTextProvider(): MimoTextProvider {
    return this.mimoTextProvider;
  }

  getMimoMultimodalProvider(): MimoMultimodalProvider {
    return this.mimoMultimodalProvider;
  }
}

export function loadMimoConfig(): MimoConfig {
  return {
    apiKey: getConfigValue("MIMO_API_KEY"),
    baseUrl: getConfigValue("MIMO_API_BASE_URL"),
    openaiBaseUrl: getConfigValueAny(["MIMO_OPENAI_BASE_URL", "MIMO_API_BASE_URL"]),
    anthropicBaseUrl: getConfigValue("MIMO_ANTHROPIC_BASE_URL"),
    textModel: getConfigValue("MIMO_TEXT_MODEL"),
    multimodalModel: getConfigValueAny(["MIMO_MULTIMODAL_MODEL", "MIMO_TEXT_MODEL"]),
    ttsModel: getConfigValue("MIMO_TTS_MODEL"),
    ttsVoice: getConfigValue("MIMO_TTS_VOICE"),
    ttsFormat: getConfigValue("MIMO_TTS_FORMAT"),
    temperature: parseFloat(getConfigValue("LLM_TEMPERATURE", "0.35"))
  };
}

export function loadModelRouterConfig(): ModelRouterConfig {
  const ikuncodeConfig = loadLlmConfig();

  return {
    globalProvider: (getConfigValue("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55") as ModelRouterConfig["globalProvider"]),
    ikuncodeConfig,
    mimoConfig: loadMimoConfig()
  };
}
