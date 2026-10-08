/**
 * P150-B1 · IntentClarifier
 *
 * 入口: POST /series/:slug/clarify  body { user_input: string }
 * 返回:
 *   proceed=true  → { proceed: true, inferred_settings: { ... } }
 *   proceed=false → { proceed: false, questions: [{ dim, question, options }] }
 *
 * prompt 核心: 6 个维度(时长、情绪、结局、视觉风格、节奏、受众)
 * 只问信息增益最大的 ≤3 个维度
 */
import { z } from "zod";
import type { SeriesDefaults } from "../types.js";
import { parseJsonFromLlm } from "../utils/llmJsonParser.js";

// ─── ClarifyDimension ─────────────────────────────────────────────

export type ClarifyDimension =
  | "duration"
  | "emotion"
  | "ending"
  | "visual_style"
  | "pacing"
  | "audience";

export const DIMENSION_LABELS: Record<ClarifyDimension, string> = {
  duration: "时长",
  emotion: "情绪基调",
  ending: "结局走向",
  visual_style: "视觉风格",
  pacing: "节奏",
  audience: "目标受众",
};

// ─── ClarifyQuestion ──────────────────────────────────────────────

export interface ClarifyQuestion {
  dim: ClarifyDimension;
  question: string;
  options: string[];
}

// ─── ClarifyResult ────────────────────────────────────────────────

export type ClarifyResult =
  | { proceed: true; inferred_settings: Partial<SeriesDefaults> }
  | { proceed: false; questions: ClarifyQuestion[] };

// ─── Zod schemas for LLM response ─────────────────────────────────

const InferredSettingsSchema = z.object({
  duration: z.string().optional(),
  emotion: z.string().optional(),
  ending: z.string().optional(),
  visual_style: z.string().optional(),
  pacing: z.string().optional(),
  audience: z.string().optional(),
}).partial();

const QuestionSchema = z.object({
  dim: z.enum(["duration", "emotion", "ending", "visual_style", "pacing", "audience"]),
  question: z.string(),
  options: z.array(z.string()).min(2).max(5),
});

const ClarifyLlmResponseSchema = z.object({
  proceed: z.boolean(),
  inferred_settings: InferredSettingsSchema.optional(),
  questions: z.array(QuestionSchema).max(3).optional(),
});

// ─── Prompt ───────────────────────────────────────────────────────

function buildClarifyPrompt(userInput: string, existingDefaults?: Partial<SeriesDefaults>): string {
  const existingContext = existingDefaults
    ? `\n已知的系列设定:\n${JSON.stringify(existingDefaults, null, 2)}`
    : "";

  return `你是一位专业的短视频策划助手。用户描述了一个创作意图，请分析以下 6 个维度中哪些已能从输入推断，哪些缺失:

维度说明:
- duration(时长): 视频目标时长，如 30秒、60秒、3分钟
- emotion(情绪基调): 温馨、悬疑、搞笑、热血、悲伤、治愈
- ending(结局走向): 大团圆、开放式、反转、悲剧、悬念
- visual_style(视觉风格): 赛博朋克、古风、写实、卡通、水墨、日系动漫
- pacing(节奏): 快节奏剪辑、慢节奏叙事、渐进式、高燃
- audience(目标受众): Z世代、职场人、学生、全年龄、女性向

规则:
1. 如果用户输入已涵盖全部 6 个维度(或结合已知设定可合理推断)，返回 proceed=true，并在 inferred_settings 中填入推断值
2. 如果有维度缺失，只选信息增益最大的 ≤3 个维度提问，每个问题给 2-4 个选项供用户快选
3. 优先级: 情绪 > 视觉风格 > 受众 > 时长 > 节奏 > 结局
4. 不要问用户已经明确给出的信息
${existingContext}

用户输入:
<user_input>
${userInput}
</user_input>

严格按以下 JSON 格式返回，不要包含任何额外文字或 Markdown 代码块:
{
  "proceed": true/false,
  "inferred_settings": { ... },   // proceed=true 时必填
  "questions": [                   // proceed=false 时必填
    { "dim": "...", "question": "...", "options": ["...", "..."] }
  ]
}`;
}

// ─── ClarifyInput ─────────────────────────────────────────────────

export interface ClarifyInput {
  user_input: string;
  series_defaults?: Partial<SeriesDefaults>;
  /** LLM provider 注入 */
  registry: import("../../../providers/src/core/index").ProviderRegistry;
  chain: string[];
  getKeyFor: (id: string) => string | null;
  signal?: AbortSignal;
}

// ─── clarify() 入口 ───────────────────────────────────────────────

export async function clarify(input: ClarifyInput): Promise<ClarifyResult> {
  const { user_input, series_defaults, registry, chain, getKeyFor, signal } = input;

  // 构建 prompt
  const prompt = buildClarifyPrompt(user_input, series_defaults);

  // 动态导入 fallback chain 避免循环依赖
  const { tryWithFallback, resolveChain } = await import("../../../providers/src/core/queue");
  const { getConfigValue } = await import("../../../core/src/localSettings");

  // 解析 LLM chain
  const resolvedChain = resolveChain(
    chain[0] || getConfigValue("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55"),
    chain,
    (id: string) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );

  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(60_000) fallback.
  const providerCtx = {
    series_slug: "clarify",
    job_id: `clarify_${Date.now().toString(36)}`,
    task_id: `task_${Date.now().toString(36)}`,
    log: () => {},
    signal,
  };

  const llmResult = await tryWithFallback(
    resolvedChain,
    (id: string) => registry.getLlm(id),
    {
      prompt,
      system: "你是一位专业的短视频策划助手。只返回合法 JSON，不要包含 Markdown 代码块。",
      response_format: "json",
      max_tokens: 1024,
    },
    providerCtx,
  );

  // 解析 & 校验
  const raw = parseJsonFromLlm(llmResult.text);
  const parsed = ClarifyLlmResponseSchema.parse(raw);

  if (parsed.proceed) {
    return {
      proceed: true,
      inferred_settings: parsed.inferred_settings ?? {},
    };
  }

  return {
    proceed: false,
    questions: (parsed.questions ?? []).slice(0, 3),
  };
}
