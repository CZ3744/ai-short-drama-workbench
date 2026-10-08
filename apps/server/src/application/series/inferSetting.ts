import { readSeries } from "../../api/v2/seriesStore";
import { validate, InferSettingSchema } from "../../api/v2/validators";
import { getRegistry, resolveLlmProviderId } from "../../api/v2/orchestration/_shared/registry";
import { passThroughSignal, parseJsonFromLlm } from "../../api/v2/orchestration/_shared/llmJson";
import type { ProgressSink } from "../../api/v2/orchestration/_shared/progressSink";

import { getKeyFor, getConfigValue } from "../../../../../packages/core/src/localSettings";
import { listPresets } from "../../../../../packages/core/src/presets";
import { logProviderCall } from "../../../../../packages/core/src/logger";
import { tryWithFallback, resolveChain } from "../../../../../packages/providers/src/core/queue";

export interface InferSettingInput {
  slug: string;
  body: unknown;
  /** 2026-05-20 P1 铁律 #1: caller (路由层) 透传 req.signal 让客户端断开能真 abort. */
  signal?: AbortSignal;
}

export interface InferSettingDeps {
  progress: ProgressSink;
  requestId?: string;
}

export type InferSettingResult =
  | { kind: "rawJson"; status: number; body: Record<string, unknown> }
  | { kind: "respondError"; status: number; body: Record<string, unknown> }
  | { kind: "respondJson"; body: Record<string, unknown> };

const INFER_SETTING_PROMPT = `你是一位短视频创作助手。用户正在填写创作设置但对某个选项犹豫不决。
根据用户已填的灵感文本和其他设置，推断该设置项的最佳值。

规则:
1. 只从提供的选项列表中选择
2. 给出简短理由(15字以内)
3. 返回 JSON: { "value": "选项ID", "reason": "理由" }
4. 只返回 JSON，不要额外文字`;

export async function inferSetting(
  input: InferSettingInput,
  _deps: InferSettingDeps,
): Promise<InferSettingResult> {
  // C2: Zod validation
  const validated = validate(InferSettingSchema, input.body);
  if (!validated.ok) {
    return { kind: "rawJson", status: validated.status, body: { errors: validated.errors } };
  }
  const { setting_key, dict_id, context } = validated.data;

  if (!setting_key || !dict_id) {
    return {
      kind: "respondError",
      status: 400,
      body: {
        error: { code: "ValidationError", message: "setting_key 和 dict_id 必填" },
      },
    };
  }

  // 加载选项列表
  const presets = listPresets(dict_id);
  if (!presets || presets.length === 0) {
    return {
      kind: "respondError",
      status: 400,
      body: {
        error: { code: "InvalidDictId", message: `字典 ${dict_id} 不存在或为空` },
      },
    };
  }

  const optionsDesc = presets.map(p => `- ${p.id}: ${p.label_zh ?? p.id}`).join("\n");

  const contextParts: string[] = [];
  if (context?.inspiration) contextParts.push(`灵感文本:\n${context.inspiration}`);
  if (context?.current_settings) {
    const entries = Object.entries(context.current_settings).filter(([, v]) => v);
    if (entries.length > 0) contextParts.push(`已填设置:\n${entries.map(([k, v]) => `${k}: ${v}`).join("\n")}`);
  }

  const userPrompt = `设置项: ${setting_key}
可选值:
${optionsDesc}
${contextParts.length > 0 ? "\n" + contextParts.join("\n\n") : ""}

请推断最佳值。`;

  // 调 LLM
  const registry = getRegistry();
  const series = await readSeries(input.slug);
  const providerId = resolveLlmProviderId((series?.defaults ?? {}) as Record<string, any>);
  const chain = resolveChain(
    providerId,
    registry.listAvailable("llm").map(p => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );

  const llmStartMs = Date.now();
  const llmResult = await tryWithFallback(
    chain,
    (id) => registry.getLlm(id),
    {
      prompt: `${INFER_SETTING_PROMPT}\n\n${userPrompt}`,
      system: "你是一位短视频创作助手。只返回合法 JSON，不要 Markdown 代码块。",
      response_format: "json",
      max_tokens: 256,
    },
    {
      series_slug: input.slug,
      job_id: `infer_${Date.now().toString(36)}`,
      task_id: `task_${Date.now().toString(36)}`,
      log: () => {},
      // 2026-05-20 P1 铁律 #1: 透传 caller signal, 不本地设 timeout
      signal: passThroughSignal(input.signal),
    },
  );
  logProviderCall({
    requestId: _deps.requestId,
    providerId: chain[0] || "llm",
    kind: "llm",
    durationMs: Date.now() - llmStartMs,
    success: true,
    meta: { purpose: "infer_setting" },
  }).catch((e) => { console.warn("[orch] logProviderCall failed:", (e as Error)?.message ?? e); });

  const raw = parseJsonFromLlm(llmResult.text);
  const parsed = raw as { value?: string; reason?: string };

  if (!parsed.value) {
    return { kind: "respondJson", body: { ok: false, suggested_value: "", reason: "AI 未能推断" } };
  }

  // 验证返回值在选项列表中
  const valid = presets.some(p => p.id === parsed.value);
  return {
    kind: "respondJson",
    body: {
      ok: true,
      suggested_value: valid ? parsed.value : presets[0].id,
      reason: parsed.reason || "",
    },
  };
}
