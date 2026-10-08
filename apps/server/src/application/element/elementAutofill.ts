/**
 * elementAutofill — LLM-based 素材字段智能填表服务.
 *
 * 用户原话 (2026-05-19 反馈 #2):
 * > "素材创作界面也要允许做一个基于用户输入生成角色详情 json 的功能,
 * >  我直接在左上角的用户输入的聊天框输入我想要这个角色的简介,
 * >  允许通过一种交互要求通过模型选择器的文字模型一键生成匹配下方角色参数的 json 返回,
 * >  然后系统自动导入..."
 *
 * 设计:
 *   1. 纯服务 (无 IO 副作用, 输入 rawText, 输出 fields) — 易于复用、易于测试.
 *   2. 复用 tryWithFallback chain (同 plan-storyboard 风格), 不重复造轮子.
 *   3. parseJsonFromLlm 容错 markdown 代码块.
 *   4. promptText 同时被前端 "复制完整提示词" 按钮消费 — 单一 source of truth.
 *
 * 不在这里:
 *   - 路由层校验 / 错误透传 / scrubForClient (走 elementController 路由层)
 *   - 状态持久化 (前端拿到 fields 后调 patchElement)
 */

import {
  parseJsonFromLlm,
  passThroughSignal,
} from "../../api/v2/orchestration/_shared/llmJson";
import { getRegistry } from "../../api/v2/orchestrationController";
import { providerIdFromModelRef } from "../generation/modelRef";
import { getConfigValue, getKeyFor } from "../../../../../packages/core/src/localSettings";
import { resolveChain, tryWithFallback } from "../../../../../packages/providers/src/core/queue";
import type { ProviderContext } from "../../../../../packages/providers/src/core/types";

export type ElementKind = "character" | "scene" | "prop" | "wardrobe" | "reference" | "misc";

/**
 * 每个 kind 的字段表 — 字段名 / 中文标签 / 给 LLM 的解释.
 * 必须与前端 KIND_FIELD_SCHEMA 保持语义一致(同 4-字段为主), 否则 LLM 回的字段填不到 UI.
 *
 * 注: voice_id 是下拉选 (VoiceSelector), 不允许 LLM 瞎编 — 排除在外.
 */
const FIELD_SPECS: Record<ElementKind, Array<{ key: string; label: string; hint: string }>> = {
  character: [
    { key: "role", label: "角色定位", hint: "例: 女主角 / 男配 / 反派 / 旁白" },
    { key: "appearance", label: "外貌", hint: "年龄/脸型/发型/身材等不随场合变的特征" },
    { key: "outfit", label: "服装基调", hint: "常穿什么风格的衣服, 不写具体某一套" },
    { key: "personality", label: "性格", hint: "活泼/内向/暴躁等行为基调" },
  ],
  scene: [
    { key: "location", label: "地点", hint: "例: 咖啡馆 / 桥边 / 实验室" },
    { key: "time_of_day", label: "时段", hint: "例: 清晨 / 黄昏 / 雨夜" },
    { key: "mood", label: "氛围", hint: "例: 温暖 / 紧张 / 疏离" },
    { key: "visual_style", label: "视觉风格", hint: "例: 写实电影感 / 赛博朋克 / 水彩插画" },
  ],
  prop: [
    { key: "purpose", label: "用途", hint: "这个道具在剧情里起什么作用" },
    { key: "appearance", label: "外观", hint: "材质/颜色/形状/尺寸" },
    { key: "style", label: "风格", hint: "古风 / 现代 / 未来" },
  ],
  wardrobe: [
    { key: "style", label: "风格", hint: "古装 / 现代休闲 / 商务正装" },
    { key: "appearance", label: "外观", hint: "颜色/剪裁/材质" },
    { key: "occasion", label: "适用场合", hint: "日常 / 婚礼 / 战斗" },
  ],
  reference: [
    { key: "style", label: "风格关键词", hint: "用于描述视觉参考的核心风格" },
    { key: "notes", label: "用法备注", hint: "在剧本中如何使用这个参考" },
  ],
  misc: [
    { key: "notes", label: "备注", hint: "自由文本描述" },
  ],
};

const KIND_LABEL: Record<ElementKind, string> = {
  character: "角色",
  scene: "场景",
  prop: "道具",
  wardrobe: "服装",
  reference: "参考资料",
  misc: "其他素材",
};

export interface AutofillElementInput {
  /** 系列 slug, 仅用作 LLM ctx 标记 */
  slug: string;
  /** 素材类型, 决定提取哪些字段 */
  elementKind: ElementKind;
  /** 用户在 "文字描述" 框输入的自然语言 */
  rawText: string;
  /** 用户从 ModelPicker 选的 LLM, 形如 "ikuncode_gpt55:xxx" 或纯 instance_id */
  model_ref?: string;
  /** 请求追踪 id, 透传给日志 (可选) */
  requestId?: string;
  /** 2026-05-20 P1 铁律 #1: caller (路由层) 透传 req.signal — 客户端断开 / 用户取消能真 abort. */
  signal?: AbortSignal;
}

export interface AutofillElementResult {
  /** 字段名 → LLM 解析出来的字符串值; 用户没提到的字段值为空字符串 */
  fields: Record<string, string>;
  /** LLM 实际命中的 provider id (fallback 后的真值) */
  provider_id: string;
  /** LLM 原始文本回复, 给前端 debug 用 */
  raw_llm_output: string;
  /** 完整提示词 (system + user 拼成), 前端 "复制提示词" 按钮直接用 */
  prompt_used: string;
}

/**
 * 给指定 kind 构造 LLM prompt.
 *
 * 导出原因: 前端 "复制完整提示词" 按钮要拿到一模一样的 prompt 文本走外部 AI,
 * 一字不差 — 否则导入回来的 JSON 结构对不上.
 */
export function buildAutofillPrompt(input: { elementKind: ElementKind; rawText: string }): {
  system: string;
  user: string;
  combined: string;
} {
  const spec = FIELD_SPECS[input.elementKind];
  const kindLabel = KIND_LABEL[input.elementKind];

  const fieldLines = spec
    .map((f) => `  - ${f.key} (${f.label}): ${f.hint}`)
    .join("\n");
  const exampleJson = "{\n" +
    spec.map((f) => `  "${f.key}": ""`).join(",\n") +
    "\n}";

  const system = `你是短剧创作助手, 专门把用户的自然语言描述解析成结构化的"${kindLabel}"字段, 供本地 AI 短剧工作台直接导入. 只返回纯 JSON 对象, 不要任何 markdown 代码块、注释、说明文字、前后空话.`;

  const user = `用户对一个"${kindLabel}"的描述如下:

"""
${input.rawText.trim()}
"""

请提取以下字段, 严格按 JSON 输出:
${fieldLines}

输出 JSON 结构 (字段名必须一字不差, 顺序不重要):
${exampleJson}

铁律:
- 直接输出 JSON 对象, 不要用 markdown 代码块 (\`\`\`json ... \`\`\`) 包裹.
- 用户没明确提到的字段 → 填空字符串 "", 不要瞎编、不要 null、不要写 "未提及".
- 不要在 JSON 前后加任何说明文字 ("好的我来帮你..." 之类一律不要).
- 字段值用简洁中文, 不要超过 120 字.`;

  return {
    system,
    user,
    combined: `[SYSTEM]\n${system}\n\n[USER]\n${user}`,
  };
}

/**
 * 把 LLM 回的 raw JSON 严格筛成预期字段集. 多余的键丢弃, 缺失的键补空字符串.
 * 所有 value 强转 string (LLM 偶尔会返数字 / null / bool).
 */
function coerceFields(raw: unknown, elementKind: ElementKind): Record<string, string> {
  const spec = FIELD_SPECS[elementKind];
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    // 完全不是对象 → 全部空字符串
    for (const f of spec) out[f.key] = "";
    return out;
  }
  const obj = raw as Record<string, unknown>;
  for (const f of spec) {
    const v = obj[f.key];
    if (v == null) {
      out[f.key] = "";
    } else if (typeof v === "string") {
      out[f.key] = v.trim();
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[f.key] = String(v);
    } else {
      // 数组/对象 → 转 JSON 字符串保底, 让用户看到原始数据自己改
      try {
        out[f.key] = JSON.stringify(v);
      } catch {
        out[f.key] = "";
      }
    }
  }
  return out;
}

/**
 * 主入口: 拿用户的 rawText 调 LLM 解析出结构化字段.
 *
 * 错误策略: 任何 LLM provider 失败 → throw, 路由层 catch 走 scrubForClient + 400/502 透传.
 * 不做 silent fallback (CLAUDE.md 红线 #6 — silent mock fallback 严格禁止).
 *
 * 时序:
 *   1. 构造 prompt (复用 buildAutofillPrompt, 与前端"复制提示词"按钮共享)
 *   2. resolveChain: 用户传 model_ref 优先, 否则走 GLOBAL_MODEL_PROVIDER fallback
 *   3. tryWithFallback 调 LLM, response_format=json
 *   4. parseJsonFromLlm 容错 markdown 包裹
 *   5. coerceFields 强类型化(都转 string, 多余键丢弃)
 *   6. 返回 fields + raw_llm_output + prompt_used
 */
export async function autofillElementFromText(
  input: AutofillElementInput,
): Promise<AutofillElementResult> {
  if (!input.rawText || input.rawText.trim().length === 0) {
    throw new Error("rawText 不能为空 — 请先在文字描述框输入内容");
  }
  if (!FIELD_SPECS[input.elementKind]) {
    throw new Error(`不支持的素材类型: ${input.elementKind}`);
  }

  const registry = getRegistry();
  const all = registry.listAvailable("llm").map((p) => p.id);
  const lead =
    providerIdFromModelRef(input.model_ref) ||
    getConfigValue("GLOBAL_MODEL_PROVIDER", "ikuncode_gpt55");
  const chain = resolveChain(
    lead,
    all,
    (id: string) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );
  if (chain.length === 0) {
    throw new Error("没有可用的文字模型 — 请先在「设置」配置至少一个 LLM Key");
  }

  const { system, user, combined } = buildAutofillPrompt({
    elementKind: input.elementKind,
    rawText: input.rawText,
  });

  const ctx: ProviderContext = {
    series_slug: input.slug || "element-autofill",
    job_id: `autofill_${Date.now().toString(36)}`,
    task_id: `autofill_${input.requestId ?? Date.now().toString(36)}`,
    log: () => {},
    // 2026-05-20 P1 铁律 #1: 透传 caller signal, 不本地 timeout
    signal: passThroughSignal(input.signal),
  };

  let actualProviderId = chain[0];
  const result = await tryWithFallback(
    chain,
    (id) => registry.getLlm(id),
    {
      prompt: user,
      system,
      response_format: "json",
      max_tokens: 1024,
    },
    ctx,
    (evt) => {
      actualProviderId = evt.to;
    },
  );

  const rawText = (result.text ?? "").trim();

  // parseJsonFromLlm 已处理 ```json...``` 包裹. 万一 LLM 还是输出了
  // 自然语言前缀(比如"好的, 这是结果:\n{...}"), 用正则兜底找第一个 { 到最后一个 }.
  let parsed: unknown;
  try {
    parsed = parseJsonFromLlm(rawText);
  } catch {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch (e) {
        throw new Error(
          `LLM 返回内容无法解析为 JSON: ${e instanceof Error ? e.message : String(e)}。原始片段: ${rawText.slice(0, 200)}`,
        );
      }
    } else {
      throw new Error(
        `LLM 没返回 JSON 对象。原始内容(截断): ${rawText.slice(0, 200)}`,
      );
    }
  }

  const fields = coerceFields(parsed, input.elementKind);

  return {
    fields,
    provider_id: actualProviderId,
    raw_llm_output: rawText,
    prompt_used: combined,
  };
}
