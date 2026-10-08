// P5B: useProviderChain — SSE 监听 provider.fallback 事件 + 全局链状态
//
// - Listens for provider.fallback SSE events
// - Shows toast when provider switches
// - Maintains chain state globally via sessionStore + React context
// - Handles AggregateError (FallbackChainError) display

import { useEffect, useCallback, useRef } from "react";
import { createSSEClient } from "../lib/sse";
import { useSessionStore } from "../stores/sessionStore";

export interface ChainState {
  /** Current active provider ID */
  active: string | null;
  /** Full ordered chain */
  chain: string[];
  /** Whether an override is active */
  overridden: boolean;
}

export interface FallbackEvent {
  from: string;
  to: string;
  reason: string;
}

export interface ProviderChainStore extends ChainState {
  setChain: (chain: ChainState) => void;
  setActive: (id: string) => void;
  handleFallback: (event: FallbackEvent) => void;
  handleChainChanged: (chain: string[], active: string) => void;
}

// Global toast callback — set by the app shell
let _toastFn: ((msg: string, action?: { label: string; onClick: () => void }) => void) | null = null;
export function setToastFn(fn: typeof _toastFn) { _toastFn = fn; }

function showToast(msg: string, action?: { label: string; onClick: () => void }) {
  _toastFn?.(msg, action);
}

/**
 * Subscribe to provider chain events via SSE.
 * Returns current chain state + a dispose function.
 * State is stored in sessionStore (no module-level mutable state).
 */
export function useProviderChain() {
  const disposeRef = useRef<(() => void) | null>(null);
  const chainState = useSessionStore((s) => s.chainState);
  const setChainState = useSessionStore((s) => s.setChainState);
  const setSettingsOpen = useSessionStore((s) => s.setSettingsOpen);

  useEffect(() => {
    // Connect to global SSE for provider.fallback events
    const client = createSSEClient({
      onMessage: (data: any) => {
        if (data?.type === "provider.fallback") {
          const payload = data.data;

          if (payload?.event === "chain_changed") {
            setChainState({
              active: payload.active,
              chain: payload.chain,
              overridden: true,
            });
            showToast(`Fallback 链已更新，当前: ${payload.active}`);
            return;
          }

          if (payload?.from && payload?.to) {
            setChainState((prev) => ({ ...prev, active: payload.to }));
            showToast(`已切换到 ${payload.to}（原因：${payload.reason ?? "未知"}）`);
            return;
          }
        }

        // P5B: Detect FallbackChainError / AggregateError from SSE
        if (data?.type === "task.failed" && data?.data?.error_type === "fallback_chain_exhausted") {
          const msg = data.data.message ?? "所有 LLM provider 均已失败";
          showToast(msg, {
            label: "打开设置",
            // 2026-05-27 audit P0-11: setSettingsOpen flag 没人读, 改 location.href 真跳转
            onClick: () => { window.location.href = "/settings"; },
          });
        }
      },
      autoReconnect: true,
      reconnectInterval: 2000,
    });

    disposeRef.current = () => client.dispose();

    return () => {
      disposeRef.current?.();
    };
  }, [setSettingsOpen, setChainState]);

  const handleFallback = useCallback((event: FallbackEvent) => {
    setChainState((prev) => ({ ...prev, active: event.to }));
    showToast(`已切换到 ${event.to}（原因：${event.reason}）`);
  }, [setChainState]);

  const setActive = useCallback((id: string) => {
    setChainState((prev) => ({ ...prev, active: id }));
  }, [setChainState]);

  const setChain = useCallback((chain: ChainState) => {
    setChainState(chain);
  }, [setChainState]);

  return {
    ...chainState,
    setChain,
    setActive,
    handleFallback,
    dispose: () => disposeRef.current?.(),
  };
}

/** One-shot fetch of provider chain from server */
export async function fetchProviderChain() {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(15_000).
  const res = await fetch("/api/v2/providers/chain");
  if (!res.ok) throw new Error(`Failed to fetch chain: ${res.status}`);
  return res.json() as Promise<{
    chain: string[];
    chain_active: string | null;
    overridden: boolean;
    override: string[] | null;
  }>;
}

/** POST a new chain order */
export async function updateProviderChain(chain: string[]) {
  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(15_000).
  const res = await fetch("/api/v2/providers/chain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chain }),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({ error: { message: "Unknown" } }))) as {
      error?: { message?: string };
    };
    throw new Error(errBody?.error?.message ?? "Failed to update chain");
  }
  return res.json();
}
