/** @deprecated Use llm/ikunProvider.ts or llm/mimoProvider.ts with core/types LlmProvider interface instead */
import { compactSummary, parseMaybeJson, type JobLogger } from "../../core/src/index";
import { loadPrompt } from "./prompt";
import type { LlmConfig } from "./config";

// E-N3 (2026-05-12): 之前 60s 单调对长 reasoning 模型 (o1, claude opus reasoning) 不够,
// 上调到 120s. 仍远小于 process.ts runProcess 的 5min, 给上游 retry 留余地.
const LLM_HTTP_TIMEOUT_MS = 120_000;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResult {
  content: string;
  usage?: unknown;
  raw?: unknown;
}

export interface JsonCallInput {
  agentName: string;
  promptFile: string;
  inputSummary: string;
  system: string;
  user: string;
}

export interface LlmProvider {
  readonly config: LlmConfig;
  callJson<T>(input: JsonCallInput): Promise<T>;
  callText?(input: JsonCallInput): Promise<string>;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly config: LlmConfig;

  constructor(config: LlmConfig, private readonly logger?: JobLogger) {
    this.config = config;
  }

  // E-N1 (2026-05-12): mock 模式短路. 之前 config.mock=true (e.g. apiKey 为空时
  // config.ts:66 自动开 mock) 也仍走 chat() → fetch → 必然失败. 现在如果 mock=true
  // 或 apiKey 为空, 抛 key_missing 让 caller 走 fallback chain / agentRunner fallback.
  // 这避免了 60s timeout 等死.
  private assertCallable(): void {
    if (this.config.mock || !this.config.apiKey || this.config.apiKey.trim() === "") {
      throw Object.assign(
        new Error(`${this.config.provider || "llm"} 不可用: ${this.config.mock ? "mock 模式" : "API Key 未配置"}`),
        { error_type: "key_missing", status: 400 },
      );
    }
  }

  // E-N2 (2026-05-12): 根据 agentName 决定 task-aware temperature.
  // 这里同步导入避免顶部循环依赖 (mimo.ts → llm.ts 已存在依赖反向风险).
  private suggestTemp(agentName?: string): number {
    if (!agentName) return this.config.temperature;
    const a = agentName.toLowerCase();
    if (/(critic|qa|publish_qa|content_qa|repair|json_repair|validator)/.test(a)) return 0.1;
    if (/(brainstorm|creative|title_copywriter|cover_designer|character_designer|scene_designer)/.test(a)) return 0.7;
    return this.config.temperature;
  }

  async callText(input: JsonCallInput): Promise<string> {
    this.assertCallable();
    const result = await this.chat([
      { role: "system", content: input.system },
      { role: "user", content: input.user }
    ], { temperature: this.suggestTemp(input.agentName) });
    return result.content;
  }

  async callJson<T>(input: JsonCallInput): Promise<T> {
    this.assertCallable();
    const taskTemp = this.suggestTemp(input.agentName);
    const attempts: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await this.chat([
          {
            role: "system",
            content: `${input.system}\n\nReturn only valid JSON. Do not wrap it in Markdown.`
          },
          { role: "user", content: input.user }
        ], { temperature: taskTemp });
        await this.logCall(input, {
          status: "raw_received",
          attempt,
          output_summary: compactSummary(result.content),
          usage: result.usage
        });
        try {
          const parsed = parseMaybeJson<T>(result.content);
          await this.logCall(input, { status: "parsed", attempt, output_summary: compactSummary(parsed) });
          return parsed;
        } catch (parseError) {
          attempts.push(result.content);
          await this.logCall(input, {
            status: "parse_failed",
            attempt,
            error: parseError instanceof Error ? parseError.message : String(parseError),
            output_summary: compactSummary(result.content)
          });
          const repaired = await this.repairJson<T>(input, result.content, parseError);
          if (repaired.ok) return repaired.value;
        }
      } catch (error) {
        await this.logCall(input, {
          status: "failed",
          attempt,
          error: error instanceof Error ? error.message : String(error)
        });
        if (attempt === 2) throw error;
      }
    }
    throw new Error(`LLM JSON parse failed after retries for ${input.agentName}. Last output: ${compactSummary(attempts.at(-1) ?? "")}`);
  }

  private async repairJson<T>(input: JsonCallInput, invalidOutput: string, parseError: unknown): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      const repairPrompt = await loadPrompt("json_repair.md");
      // E-N2: repair 是确定性任务, 永远走 0.1
      // E-N4: invalidOutput 可能很大, 截到 4KB 防 token 爆.
      const truncatedInvalid = invalidOutput.length > 4096 ? invalidOutput.slice(0, 4096) + "\n[...truncated]" : invalidOutput;
      const result = await this.chat([
        {
          role: "system",
          content: "You repair JSON for production workflows. Return only valid JSON."
        },
        {
          role: "user",
          content: `${repairPrompt}\n\nAgent: ${input.agentName}\nPrompt file: ${input.promptFile}\nParse error: ${
            parseError instanceof Error ? parseError.message : String(parseError)
          }\n\nInvalid output:\n${truncatedInvalid}`
        }
      ], { temperature: 0.1 });
      const parsed = parseMaybeJson<T>(result.content);
      await this.logCall(input, {
        status: "repaired",
        prompt_file: "json_repair.md",
        output_summary: compactSummary(parsed),
        usage: result.usage
      });
      return { ok: true, value: parsed };
    } catch (error) {
      await this.logCall(input, {
        status: "repair_failed",
        prompt_file: "json_repair.md",
        error: error instanceof Error ? error.message : String(error)
      });
      return { ok: false };
    }
  }

  // E-N2: chat() 接受可选 override (目前仅 temperature). 调用方可不传保持默认.
  private async chat(messages: ChatMessage[], override?: { temperature?: number }): Promise<ChatResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: this.config.model,
      temperature: override?.temperature ?? this.config.temperature,
      messages,
      response_format: { type: "json_object" }
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(body),
      // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" — 删 AbortSignal.timeout.
    });

    let data: any;
    const text = await response.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      if ([400, 422].includes(response.status)) {
        const retryBody = { ...body };
        delete (retryBody as Partial<typeof body>).response_format;
        const retry = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`
          },
          body: JSON.stringify(retryBody),
          // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout.
        });
        const retryText = await retry.text();
        let retryData: any;
        try {
          retryData = retryText ? JSON.parse(retryText) : {};
        } catch {
          retryData = { raw: retryText };
        }
        if (!retry.ok) {
          throw new Error(`LLM HTTP ${retry.status}: ${compactSummary(redact(retryData), 700)}`);
        }
        return {
          content: extractContent(retryData),
          usage: retryData.usage,
          raw: retryData
        };
      }
      throw new Error(`LLM HTTP ${response.status}: ${compactSummary(redact(data), 700)}`);
    }

    return {
      content: extractContent(data),
      usage: data.usage,
      raw: data
    };
  }

  private async logCall(input: JsonCallInput, payload: Record<string, unknown>) {
    await this.logger?.llm({
      at: new Date().toISOString(),
      agent_name: input.agentName,
      prompt_file: input.promptFile,
      input_summary: input.inputSummary,
      model: this.config.model,
      provider: this.config.provider,
      base_url: this.config.baseUrl,
      llm_mode: "real",
      ...payload
    });
  }
}

function extractContent(data: any) {
  const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(`LLM response did not include message content: ${compactSummary(redact(data), 500)}`);
  }
  return content;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    // v0.2.4: previously only matched sk-* which misses MiMo / DashScope
    // / MiniMax (JWT). Broaden patterns without over-matching normal text.
    return value
      .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted]")
      .replace(/Bearer\s+[A-Za-z0-9_.\-~+/=]{16,}/gi, "Bearer [redacted]")
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted_jwt]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => {
      const lk = key.toLowerCase();
      const sensitive = /^(api[_-]?key|authorization|auth[_-]?key|secret[_-]?key|access[_-]?key|bearer|token|dashscope_api_key|minimax_api_key|x[_-]?api[_-]?key)$/.test(lk);
      return [key, sensitive ? "[redacted]" : redact(val)];
    }));
  }
  return value;
}
