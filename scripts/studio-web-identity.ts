import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/** A local launcher probe; never disclose a checkout path or user configuration. */
export function handleStudioWebIdentity(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (req.url?.split("?", 1)[0] !== "/__studio_identity") {
    next();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  const peer = req.socket.remoteAddress;
  if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") {
    res.statusCode = 403;
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(req.method === "HEAD" ? undefined : JSON.stringify({ app: "video-generate", service: "web", pid: process.pid }));
}

export function studioWebIdentityPlugin(): Plugin {
  return {
    name: "studio-local-identity",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(handleStudioWebIdentity);
    },
  };
}
