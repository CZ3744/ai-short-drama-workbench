import type { RequestHandler } from "express";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

function parseOrigin(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** CORS alone does not prevent a foreign page from submitting local mutations. */
export function localRequestGuard(webOrigin: string): RequestHandler {
  const configured = parseOrigin(webOrigin);
  if (!configured) throw new Error("WEB_ORIGIN 必须是完整的 HTTP 或 HTTPS 来源地址，不能包含路径");
  const trusted = new Set([configured.origin]);
  // Both standard local URLs should work, including a custom development port.
  if (LOOPBACK_HOSTS.includes(configured.hostname)) {
    for (const host of LOOPBACK_HOSTS) {
      trusted.add(`${configured.protocol}//${host}${configured.port ? `:${configured.port}` : ""}`);
    }
  }

  return (req, res, next) => {
    const reject = (code: string, message: string) => { res.status(403).json({ error: { code, message } }); };
    // Do not trust X-Forwarded-Host: this application binds to loopback and has no remote authentication.
    const host = req.get("host") ?? "";
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) {
      reject("LOCAL_HOST_REQUIRED", "请通过本机地址打开工作台");
      return;
    }
    const requestOrigin = parseOrigin(`${req.protocol}://${host}`)?.origin;
    if (!requestOrigin) {
      reject("LOCAL_HOST_REQUIRED", "请通过有效的本机地址打开工作台");
      return;
    }
    const isTrusted = (value: string) => {
      const origin = parseOrigin(value)?.origin;
      return origin != null && (origin === requestOrigin || trusted.has(origin));
    };
    const origin = req.get("origin");
    if (origin !== undefined) {
      if (!isTrusted(origin)) {
        reject("UNTRUSTED_ORIGIN", "此网页无权访问本机工作台，请从工作台页面重试");
        return;
      }
    } else {
      // GETs and old browsers may omit Origin. Check their referrer when present;
      // retain header-free access for local launchers, health probes and CLI clients.
      const referer = req.get("referer");
      let refererOrigin: string | undefined;
      try { if (referer) refererOrigin = new URL(referer).origin; } catch { /* rejected below */ }
      if ((referer && (!refererOrigin || !isTrusted(refererOrigin))) ||
          (!refererOrigin && req.get("sec-fetch-site") === "cross-site")) {
        reject("UNTRUSTED_ORIGIN", "此网页无权访问本机工作台，请从工作台页面重试");
        return;
      }
    }
    next();
  };
}
