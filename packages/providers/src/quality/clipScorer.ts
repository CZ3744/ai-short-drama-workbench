/**
 * 多模态模型图文匹配评分。它不是本地 CLIP 嵌入相似度。
 * 不可用时返回 undefined，而不是伪造 0.5 分；调用方可继续生成流程。
 */
import { getConfigValue } from "../../../core/src/index";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "google/gemini-2.5-flash-preview";

/** 只解析明确的评分值；错误页、空响应和无法解析的内容没有分数。 */
export function parseScore(raw: string): number | undefined {
  const normalize = (value: unknown): number | undefined => {
    if (typeof value === "number") return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
    if (typeof value !== "string") return undefined;
    const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(%)?$/i);
    if (!match) return undefined;
    const number = Number(match[1]);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, match[2] ? number / 100 : number)) : undefined;
  };
  const text = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1");
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return normalize(record.score ?? record.match_score ?? record.quality ?? record.rating);
    }
    return normalize(parsed);
  } catch {
    const direct = normalize(text);
    if (direct !== undefined) return direct;
    const labelled = text.match(/^(?:score|match_score|quality|rating)\s*[:=]\s*(.+)$/i);
    if (labelled) return normalize(labelled[1]);
    const percentage = text.match(/^The match is (?:about )?([\d.]+\s*%)\.?$/i);
    return percentage ? normalize(percentage[1]) : undefined;
  }
}

export interface ScoreImageOptions {
  signal?: AbortSignal;
  /** 可注入边界用于自动测试，不读取用户真实 Key。 */
  config?: (key: string, fallback?: string) => string;
  fetcher?: typeof fetch;
}

export async function scoreImage(buffer: Buffer, prompt: string, options: ScoreImageOptions = {}): Promise<number | undefined> {
  const config = options.config ?? getConfigValue;
  const apiKey = config("OPENROUTER_API_KEY", "").trim();
  if (!apiKey || options.signal?.aborted) return undefined;
  const model = config("CLIP_SCORER_MODEL", DEFAULT_MODEL);
  const baseUrl = config("CLIP_SCORER_BASE_URL", DEFAULT_BASE_URL).replace(/\/$/, "");
  const body = {
    model,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: `data:image/png;base64,${buffer.toString("base64")}` } },
      { type: "text", text: [
        "You are an image-prompt alignment scorer.",
        "Rate how well the image matches the prompt on a scale of 0.0 to 1.0.",
        "Consider subject, composition, style, mood, colors, and details.",
        `Prompt: ${JSON.stringify(prompt)}`,
        'Respond with ONLY a JSON object: {"score": <number>}',
      ].join("\n") },
    ] }],
    temperature: 0.1, max_tokens: 50,
  };
  try {
    const response = await (options.fetcher ?? fetch)(`${baseUrl}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body), signal: options.signal,
    });
    if (!response.ok || options.signal?.aborted) return undefined;
    const data = await response.json() as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text;
    return typeof content === "string" ? parseScore(content) : undefined;
  } catch {
    // 评分是旁路能力。失败不是图片质量差，也不是“质量中等”，不阻断主生成。
    return undefined;
  }
}
