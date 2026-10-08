/**
 * Structured Logger — Pino-based application logger (P150-C4)
 *
 * - Dev mode: pino-pretty colored output
 * - Prod mode: JSONL to logs/app-YYYYMMDD.jsonl (daily rotation via filename)
 * - Each request gets a child logger with requestId
 * - Provider calls log requestId + providerId + durationMs + success
 * - JobLogger retained for per-job file logging (backward compat)
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./fs";
import { DailyLogSink, logFileForDate } from "./dailyLogSink";
import { redactSecrets } from "./localSettings";

/* ── Pino app logger ────────────────────────────────────────── */

const isDev = process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test";
const LOG_DIR = path.resolve(process.cwd(), "logs");

/** Resolve today's jsonl log file path (prod mode) */
export function dailyLogFile(): string {
  return logFileForDate(LOG_DIR, new Date());
}

// Lazy pino — avoids top-level await / import issues
let _pino: any = null;
let _rootLogger: any = null;
let _sink: DailyLogSink | null = null;
let _pretty: any = null;

async function getPino(): Promise<any> {
  if (_pino) return _pino;
  _pino = await import("pino");
  return _pino;
}

/**
 * Create or return the root pino logger.
 * - Dev: pino-pretty transport (colored, human-readable)
 * - Prod: raw pino writing to daily jsonl file
 */
let _loggerPromise: Promise<any> | null = null;

export async function getAppLogger(): Promise<any> {
  if (_rootLogger) return _rootLogger;
  // 首批并发请求必须共享初始化，不能各自创建日志文件流和 pretty worker。
  if (!_loggerPromise) {
    _loggerPromise = initializeAppLogger().catch((error) => {
      _loggerPromise = null; // 文件权限等临时故障恢复后允许重试。
      throw error;
    });
  }
  return _loggerPromise;
}

async function initializeAppLogger(): Promise<any> {
  if (_rootLogger) return _rootLogger;
  const pino = (await getPino()).default ?? (await getPino());

  _sink = new DailyLogSink(LOG_DIR);
  let stream: any = _sink;
  if (isDev) {
    _pretty = pino.transport({ target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } });
    _pretty.on("error", () => process.stderr.write("[logger] 日志格式化输出不可用，文件日志仍会继续\n"));
    stream = pino.multistream([{ stream: _pretty }, { stream: _sink }]);
  }
  _rootLogger = pino({ level: process.env.LOG_LEVEL || "info", timestamp: pino.stdTimeFunctions.isoTime }, stream);
  return _rootLogger;
}

export async function closeAppLogger(): Promise<void> {
  try { await _sink?.drain(); } finally { _pretty?.end(); }
}

/**
 * Synchronous accessor for the root logger.
 * Returns cached instance if available, otherwise a minimal console-based shim.
 * Use this in non-request code where async init is impractical.
 */
export function loggerSync(): any {
  if (_rootLogger) return _rootLogger;
  // Shim: prints to stderr until pino is bootstrapped
  return {
    info: (...args: any[]) => console.log("[logger-shim]", ...args),
    warn: (...args: any[]) => console.warn("[logger-shim]", ...args),
    error: (...args: any[]) => console.error("[logger-shim]", ...args),
    debug: (...args: any[]) => console.debug("[logger-shim]", ...args),
    child: function() { return this; },
  };
}

/**
 * Create a child logger bound to a request ID.
 * Usage in Express middleware: req.log = await createRequestLogger(req.requestId)
 */
export async function createRequestLogger(requestId: string): Promise<any> {
  const root = await getAppLogger();
  return root.child({ requestId });
}

/**
 * Log a provider call with structured fields.
 * Call this after each LLM/image/video provider invocation.
 */
export async function logProviderCall(opts: {
  requestId?: string;
  providerId: string;
  kind: "llm" | "image" | "video" | "tts";
  durationMs: number;
  success: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const root = await getAppLogger();
  const logger = opts.requestId ? root.child({ requestId: opts.requestId }) : root;
  const entry = {
    providerId: opts.providerId,
    kind: opts.kind,
    durationMs: opts.durationMs,
    success: opts.success,
    ...(opts.error ? { error: opts.error } : {}),
    ...(opts.meta ?? {}),
  };
  if (opts.success) {
    logger.info(entry, `provider.${opts.kind}.${opts.providerId} ok (${opts.durationMs}ms)`);
  } else {
    logger.warn(entry, `provider.${opts.kind}.${opts.providerId} failed (${opts.durationMs}ms)`);
  }
}

/**
 * Read the last N error/warn lines from today's jsonl log (prod).
 * Returns empty array if file doesn't exist or is unreadable.
 */
export async function readRecentErrors(maxLines = 100): Promise<Array<{ timestamp: string; level: string; message: string; requestId?: string }>> {
  const logFile = dailyLogFile();
  try {
    await fsp.access(logFile);
  } catch {
    return [];
  }
  try {
    const content = await fsp.readFile(logFile, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const errors: Array<{ timestamp: string; level: string; message: string; requestId?: string }> = [];
    // Walk from the end
    for (let i = lines.length - 1; i >= 0 && errors.length < maxLines; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        // pino levels: 30=info, 40=warn, 50=error, 60=fatal
        if (typeof obj.level === "number" && obj.level >= 40) {
          errors.push({
            timestamp: obj.time || obj.timestamp || "",
            level: obj.level === 50 ? "error" : obj.level === 60 ? "fatal" : "warn",
            message: obj.msg || "",
            requestId: obj.requestId,
          });
        }
      } catch {
        // skip malformed lines
      }
    }
    return errors;
  } catch {
    return [];
  }
}

/* ── JobLogger (backward compat) ────────────────────────────── */

export class JobLogger {
  constructor(private readonly logDir: string) {}

  async line(message: string) {
    await ensureDir(this.logDir);
    const row = `[${new Date().toISOString()}] ${message}\n`;
    await fsp.appendFile(path.join(this.logDir, "job.log"), row, "utf8");
  }

  async render(message: string) {
    await ensureDir(this.logDir);
    const row = `[${new Date().toISOString()}] ${message}\n`;
    await fsp.appendFile(path.join(this.logDir, "render.log"), row, "utf8");
  }

  async llm(entry: Record<string, unknown>) {
    await ensureDir(this.logDir);
    const sanitized = JSON.stringify(redactSecrets(entry));
    await fsp.appendFile(path.join(this.logDir, "llm_calls.jsonl"), `${sanitized}\n`, "utf8");
  }
}

/* ── T6: API key redaction (scrub for client & log) ───────────── */

/**
 * Scrub API keys / tokens / secrets from any string before sending to the client.
 * Provider error messages may echo keys in plaintext; this is a last-resort filter.
 *
 * Covers:
 *  - Bearer token (any opaque string >= 16 chars after "Bearer ")
 *  - Token <opaque>  (Vidu Authorization scheme, viduClient.ts:91)
 *  - api-key / x-api-key 头 (header dump / curl 回显场景)
 *  - sk-* style keys (Stripe, OpenAI, DashScope)
 *  - tp-* style keys (MiMo format)
 *  - JSON field values: "apiKey"/"api_key"/"token"/"secret"
 */
export function scrubForClient(text: string): string {
  // 顺序很重要: 先做"精确"前缀匹配 (Bearer/Token/sk-/tp-/JWT/JSON-quoted),
  // 最后再做宽泛的 api-key header 兜底, 否则后者会"吞掉" tp-/sk- 前缀,
  // 让 redacted marker 不再含品牌标识 (回归测试 logger.test.ts:23 验证).
  return text
    // Bearer + opaque token (>= 16 chars)
    .replace(/Bearer\s+[A-Za-z0-9_\-]{16,}/g, "Bearer [REDACTED]")
    // Token + opaque key (Vidu uses `Authorization: Token <apikey>`)
    .replace(/Token\s+[A-Za-z0-9+/=_-]{16,}/g, "Token [REDACTED]")
    // sk- prefixed keys (>= 20 chars): OpenAI/DashScope/Anthropic. 允许现代带连字符段格式
    // (sk-proj-/sk-ant-/sk-svcacct-), 否则连字符会打断 [A-Za-z0-9] 匹配, 致这些新格式 key 原样泄露.
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-[REDACTED]")
    // Google API keys (AIzaSy...): Gemini / Google Cloud, 之前完全未覆盖.
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "AIza[REDACTED]")
    // tp- prefixed keys (>= 20 chars): MiMo format
    .replace(/tp-[a-z0-9]{20,}/g, "tp-[REDACTED]")
    // JWT (MiniMax): three base64url parts joined by dots
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]")
    // JSON key-value: "apiKey"/"api_key"/"token"/"secret": "value"
    .replace(/"(api_?key|token|secret)"\s*:\s*"[^"]{8,}"/gi, '"$1":"[REDACTED]"')
    // Header-style api-key / x-api-key (header dump or curl -H 命令回显).
    // 放最后兜底; 已被前述模式标记为 [REDACTED] 的部分不会再次被吞 (>=8 chars
    // 的 alnum/-/_ 仍然会命中, 但内容已变成 "[REDACTED]" 等占位串, 重复替换是幂等的).
    .replace(/(api[-_]?key|x-api-key)\s*[:=]\s*[A-Za-z0-9+/=_-]{8,}/gi, "$1: [REDACTED]")
    // 2026-07-22 Y5 (UP-5): 内网绝对路径 (Windows 盘符 + 反斜杠) → 占位, 防 C:/Projects/video-studio\... 抛到用户端.
    // 要求盘符后紧跟反斜杠, 天然排除 http:// 等 URL, 不会误伤正常文本 (logger.test.ts:80 保持不变).
    .replace(/[A-Za-z]:\\[^\s"'<>|)\]]+/g, "[本地文件]")
    // 内部 asset id (asset_<时间戳>_<hex>) → 人话占位, 防 asset_1784699642689_c7163757-ff5 见人.
    .replace(/\basset_\d{6,}_[A-Za-z0-9-]+/g, "素材");
}

/**
 * Same as scrubForClient but intended for log output.
 * Currently identical; future-proofed in case log format needs different redaction markers.
 */
export function scrubForLog(text: string): string {
  return scrubForClient(text);
}
