import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { createRequestLogger } from "../../../../packages/core/src/logger";

/** 纯 HTTP 边界：不启动后台恢复、生成队列或定时备份，可独立集成测试。 */
export function requestLogging(options: { verbose?: boolean } = {}): RequestHandler {
  return async (req, res, next) => {
    const requestId = crypto.randomUUID();
    const start = Date.now();
    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    try {
      req.log = await createRequestLogger(requestId);
    } catch {
      // 日志磁盘故障不能阻塞用户请求；全局错误处理仍有 console 兜底。
    }
    res.once("finish", () => {
      const durationMs = Date.now() - start;
      if (options.verbose) console.log(`[${requestId}] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
      req.log?.info({
        http: { method: req.method, url: req.originalUrl, status: res.statusCode, durationMs },
        requestId,
      }, `HTTP ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
    });
    next();
  };
}
