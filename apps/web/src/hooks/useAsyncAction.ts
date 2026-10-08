/**
 * useAsyncAction — 把 "if busy return; setBusy(true); try{...} catch{showErrorToast}
 * finally{setBusy(false)}" 这套样板抽成一个 hook.
 *
 * 节省每个 caller ~6-10 行模板代码. 默认错误处理调 showErrorToast (走 translate +
 * action 按钮链路), caller 可传 onError / silent 自定义.
 *
 * 用户原话 (2026-05-19):
 *   "避免屎山, 避免同样的逻辑需要去不同处改多次"
 *
 * @example
 *   const { busy, run } = useAsyncAction(async (payload: BatchPayload) => {
 *     return apiPost("/batch-generate", payload);
 *   }, { errorMessage: "批量生成失败" });
 *
 *   <button onClick={() => run(payload)} disabled={busy}>生成</button>
 */

import { useCallback, useRef, useState } from "react";
import { showErrorToast } from "../lib/errorTranslate";

export interface UseAsyncActionOptions<TResult> {
  /** 兜底错误消息 (传给 showErrorToast 第 2 参数) */
  errorMessage?: string;
  /** 成功回调 — 在 result 返回后调一次 */
  onSuccess?: (result: TResult) => void;
  /** 自定义错误处理 — 设置后不再 showErrorToast (除非 silent=false) */
  onError?: (err: unknown) => void;
  /** 完全不展示 toast — caller 自己处理 (例如显示在 inline error UI) */
  silent?: boolean;
}

export interface UseAsyncActionResult<TArgs extends unknown[], TResult> {
  busy: boolean;
  /** 触发 action, 自动管 busy + error 状态. 重复调用在 busy=true 时直接 noop */
  run: (...args: TArgs) => Promise<TResult | undefined>;
  /** 最后一次失败的 Error (成功后清空) */
  error: Error | null;
  /** 手动清 error 状态 (不影响 busy) */
  reset: () => void;
}

export function useAsyncAction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: UseAsyncActionOptions<TResult> = {},
): UseAsyncActionResult<TArgs, TResult> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // 把 options + fn 装 ref, 避免 run 在每次 render 重建 (caller 通常传匿名 fn)
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(options);
  optsRef.current = options;

  const run = useCallback(async (...args: TArgs): Promise<TResult | undefined> => {
    if (busy) return undefined;
    setBusy(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      optsRef.current.onSuccess?.(result);
      return result;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      const opts = optsRef.current;
      if (opts.onError) {
        opts.onError(err);
      } else if (!opts.silent) {
        showErrorToast(err, opts.errorMessage);
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const reset = useCallback(() => setError(null), []);

  return { busy, run, error, reset };
}
