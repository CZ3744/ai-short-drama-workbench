/**
 * Shared legacy res-based SSE helpers.
 *
 * Step 3a extraction — verbatim from orchestrationController.ts.
 */

import type { Request, Response } from "express";
import { sseBroker, type SseEventType } from "../../sseBroker";

// ─── SSE helpers ──────────────────────────────────────────────────

export function initSse(res: Response): void {
  if (res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

let _sseActive = new WeakMap<Response, boolean>();

export function wantsSse(req: Request): boolean {
  const accept = (req.headers?.accept ?? req.headers?.Accept ?? "") as string;
  return accept.includes("text/event-stream") || String(req.query?.sse) === "1";
}

export function sseEnabled(res: Response): boolean {
  return _sseActive.get(res) === true;
}

export function sseProgress(res: Response, stage: string, data: Record<string, unknown>, at?: string): void {
  const payload = { stage, ...data, at: at ?? new Date().toISOString() };
  if (sseEnabled(res)) {
    try {
      res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // client disconnected
    }
  }
  // Wave 3: always broadcast via broker so EventSource subscribers on /api/v2/events receive events
  try {
    sseBroker.broadcast(stage as SseEventType, payload);
  } catch {
    // broker error, ignore
  }
}

export function sseDone(res: Response, data: Record<string, unknown>): void {
  if (!sseEnabled(res)) return;
  try {
    res.write(`event: done\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  } catch {
    // client disconnected
  }
}

export function sseError(res: Response, data: Record<string, unknown>): void {
  if (!sseEnabled(res)) return;
  try {
    res.write(`event: error\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  } catch {
    // client disconnected
  }
}

export function enableSse(req: Request, res: Response): boolean {
  if (wantsSse(req)) {
    _sseActive.set(res, true);
    initSse(res);
    return true;
  }
  return false;
}

/** Unified response: SSE if client wants it, otherwise JSON */
export function respondJson(res: Response, data: Record<string, unknown>, status = 200): void {
  if (sseEnabled(res)) {
    sseDone(res, data);
  } else {
    res.status(status).json(data);
  }
}

export function respondError(res: Response, status: number, data: Record<string, unknown>): void {
  if (sseEnabled(res)) {
    sseError(res, data);
  } else {
    res.status(status).json(data);
  }
}
