import type { Request, Response } from "express";

const signals = new WeakMap<Response, AbortSignal>();

/**
 * 生成调用应等待“响应通道真正断开”，而非“请求体已读取完成”。
 * 不使用 IncomingMessage.signal/close：POST 请求体读完不代表用户取消。
 * 不设置生成时限；正常响应 finish 后释放监听器，异常 close 才取消。
 */
export function clientDisconnectSignal(req: Request, res: Response): AbortSignal {
  const existing = signals.get(res);
  if (existing) return existing;
  const controller = new AbortController();
  signals.set(res, controller.signal);
  const cleanup = () => {
    req.removeListener("aborted", abort);
    res.removeListener("close", onClose);
    res.removeListener("finish", cleanup);
  };
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new DOMException("客户端已断开或取消请求", "AbortError"));
    cleanup();
  };
  const onClose = () => {
    if (!res.writableFinished) abort();
    else cleanup();
  };
  req.once("aborted", abort);
  res.once("close", onClose);
  res.once("finish", cleanup);
  if (req.aborted || (res.destroyed && !res.writableFinished)) abort();
  return controller.signal;
}
