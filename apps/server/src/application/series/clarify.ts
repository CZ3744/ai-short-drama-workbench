import { readSeries } from "../../api/v2/seriesStore";
import { getRegistry, resolveLlmProviderId } from "../../api/v2/orchestration/_shared/registry";
import { passThroughSignal } from "../../api/v2/orchestration/_shared/llmJson";
import type { ProgressSink } from "../../api/v2/orchestration/_shared/progressSink";

import { getKeyFor, getConfigValue } from "../../../../../packages/core/src/localSettings";
import { clarify as clarifyIntent, type ClarifyResult as IntentClarifyResult } from "../../../../../packages/drama/src/agents/clarifier";
import { resolveChain } from "../../../../../packages/providers/src/core/queue";

export interface ClarifyInput {
  slug: string;
  user_input?: unknown;
  /** 2026-05-20 P1 铁律 #1: caller 透传 req.signal — 客户端断开 / 用户取消能真 abort. */
  signal?: AbortSignal;
}

export interface ClarifyDeps {
  progress: ProgressSink;
}

export type ClarifyResult =
  | { kind: "respondError"; status: number; body: Record<string, unknown> }
  | { kind: "respondJson"; body: { ok: true } & IntentClarifyResult };

export async function clarify(
  input: ClarifyInput,
  _deps: ClarifyDeps,
): Promise<ClarifyResult> {
  // 开关检查
  const enabled = getConfigValue("ENABLE_CLARIFIER", "0") === "1";
  if (!enabled) {
    return {
      kind: "respondError",
      status: 403,
      body: {
        error: { code: "FeatureDisabled", message: "IntentClarifier 功能未启用。请在设置中开启 ENABLE_CLARIFIER=1" },
      },
    };
  }

  const { user_input } = input;
  if (!user_input || typeof user_input !== "string" || user_input.trim().length === 0) {
    return {
      kind: "respondError",
      status: 400,
      body: {
        error: { code: "ValidationError", message: "user_input 必填且不能为空" },
      },
    };
  }

  const series = await readSeries(input.slug);
  if (!series) {
    return {
      kind: "respondError",
      status: 404,
      body: { error: { code: "NotFound", message: "系列不存在" } },
    };
  }

  // 获取 LLM provider
  const registry = getRegistry();
  const providerId = resolveLlmProviderId(series.defaults as Record<string, any>);
  const chain = resolveChain(
    providerId,
    registry.listAvailable("llm").map(p => p.id),
    (id) => getKeyFor(id) !== null,
    getConfigValue("LLM_PROVIDER_CHAIN"),
  );

  // 调用 clarifier
  const result: IntentClarifyResult = await clarifyIntent({
    user_input: user_input.trim(),
    series_defaults: series.defaults,
    registry,
    chain,
    getKeyFor,
    // 2026-05-20 P1 铁律 #1: 透传 caller signal, 让用户取消真生效
    signal: passThroughSignal(input.signal),
  });

  return { kind: "respondJson", body: { ok: true, ...result } };
}
