// 2026-05-28 audit P1: Express Request augmentation — 替代项目内 13 处
// `(req as any).log` / `(req as any).requestId` 类型谎言.
//
// req.log 在 index.ts 的请求中间件挂上 (createRequestLogger 子 logger),
// req.requestId 是 8 字符的 crypto.randomUUID 切片 (用作访问日志关联).
//
// logger 实例的具体方法 (info / warn / error / debug / child) 来自 pino-like
// 子 logger; 我们这里保持宽松类型让 caller 兼容老代码 (loggerSync / 真 pino 都行).

import "express";

declare global {
  namespace Express {
    interface Request {
      /** Crypto-random 8-char request ID (set by middleware in index.ts) */
      requestId?: string;
      /**
       * Child logger bound to this request's requestId. May be undefined if
       * createRequestLogger() failed at startup (fallback path in middleware).
       *
       * Loose typing on purpose — production pino / dev loggerSync share the
       * info/warn/error/debug/child surface but full pino-types would tightly
       * couple this augment to packages/core.
       */
      log?: {
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
        debug?: (...args: unknown[]) => void;
        child?: (bindings: Record<string, unknown>) => Express.Request["log"];
      };
      /**
       * Express 5 真实字段 (Node 18+ IncomingMessage.signal): AbortSignal
       * 在 client 断开 / server.close 时 abort.
       * @types/express 5.0.6 还没加, 这里补上.
       */
      signal?: AbortSignal;
      /**
       * Multer 单文件上传字段 (multer.single() middleware 注入).
       * castController / characterController 用 multer 接 voice sample / reference image.
       */
      file?: Express.Multer.File;
    }
  }
}

export {};
