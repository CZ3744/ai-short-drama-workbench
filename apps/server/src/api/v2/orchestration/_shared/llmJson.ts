/**
 * Shared LLM-JSON parsing + provider-failure classification helpers.
 *
 * Step 3a extraction — verbatim from orchestrationController.ts.
 */

import { ProviderError } from "../../../../../../../packages/providers/src/core/index";
import { FallbackChainError } from "../../../../../../../packages/providers/src/core/queue";

/**
 * 2026-05-20 P1 红线 #1 升级: 旧 timeoutSignal helper 是 dummy never-abort signal,
 * 名字误导 — 看上去像本地超时, 实际什么也不做, 同时把"用户中止 / 客户端断开"链路也丢了.
 *
 * 改成 passThroughSignal(externalSignal?): 仅透传 caller 传入的 signal —
 *   - 有 external signal → 直接返回它 (用户点"取消"或客户端断开能真触发 abort)
 *   - 无 external signal → never-abort signal (保留之前 dummy 行为, 远端等多久等多久)
 *
 * 铁律 #1 (严禁本地主动 timeout) 要求: 任何 LLM/HTTP/IO 调用都不能自己加 setTimeout(abort)
 * 或 AbortSignal.timeout(N), 只透传 caller signal. ChatGPT 等慢 provider 真生成 70-180s
 * 是常态, 本地写死的超时会把成功的生成误判失败 → 用户重试浪费 token.
 *
 * 12 处旧 timeoutSignal(N) callsite 全部改为 passThroughSignal(input.signal),
 * input.signal 由路由层从 req.signal 透传 (req.signal 在 client 断开连接时自动 abort).
 */
// 2026-05-27 — 复用单例 never-abort signal, 避免每次调用都 new AbortController()
// 累积 controller 引用 (12 处 callsite × N 个 LLM 调用 = 大量内存浪费).
const NEVER_ABORT_SIGNAL = new AbortController().signal;

export function passThroughSignal(externalSignal?: AbortSignal): AbortSignal {
  if (externalSignal) return externalSignal;
  // 无 external 时返回 never-abort signal: 让 fetch 等远端调用按 provider 自己节奏跑
  return NEVER_ABORT_SIGNAL;
}

export function parseJsonFromLlm(text: string): unknown {
  // Strip markdown code blocks if present (robust regex handles optional language tag)
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```[\w]*\n?([\s\S]*?)```$/, "$1").trim();
  return JSON.parse(cleaned);
}

export function isRecoverableProviderFailure(err: unknown): boolean {
  return err instanceof FallbackChainError || err instanceof ProviderError;
}

export function providerFailureSummary(err: unknown): string {
  if (err instanceof FallbackChainError) return err.summary();
  if (err instanceof ProviderError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
