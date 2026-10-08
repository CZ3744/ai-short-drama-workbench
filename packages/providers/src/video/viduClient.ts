// P24: Vidu Q3 Reference-to-Video API Client
// Endpoint: https://api.vidu.com/ent/v2/reference2video (POST)
// Query:    https://api.vidu.com/ent/v2/tasks/{id}/creations (GET)
// Auth:     Authorization: Token <api_key>, env VIDU_API_KEY
//
// 2026-05-27 — 域名修正 .cn → .com. 之前用 api.vidu.cn 是错的, 官方文档明确是
// api.vidu.com (https://platform.vidu.com/docs/reference-to-video). 用户填了 Key
// 也连不上, 是 P0 blocker.
export const VIDU_DEFAULT_BASE = "https://api.vidu.com/ent/v2";
const CREATE_PATH = "/reference2video";
const QUERY_PREFIX = "/tasks/";
const QUERY_SUFFIX = "/creations";

// ─── Types ────────────────────────────────────────────────────────────

export interface ViduRefImage {
  /** data:image/...;base64,... or https URL */
  url: string;
  /** Optional label for debugging */
  label?: string;
}

export interface ViduCreateBody {
  model: string;
  prompt: string;
  images: string[];
  duration: number;
  aspect_ratio: string;
  style?: string;
  bgm?: boolean;
  seed?: number;
  callback_url?: string;
}

export interface ViduCreateResponse {
  task_id: string;
  state: string;
  model: string;
  prompt: string;
  images: string[];
  duration: number;
  seed: number;
  aspect_ratio: string;
  resolution: string;
  bgm: boolean;
  audio: boolean;
  credits: number;
  created_at: string;
}

export type ViduTaskState =
  | "created"
  | "queueing"
  | "processing"
  | "success"
  | "failed";

export interface ViduCreation {
  id: string;
  url: string;
  cover_url: string;
  watermarked_url?: string;
}

export interface ViduTaskStatus {
  id: string;
  state: ViduTaskState;
  err_code?: string;
  credits: number;
  creations: ViduCreation[];
}

// ─── Client ───────────────────────────────────────────────────────────

export class ViduClient {
  private _apiKey: string;
  private _timeoutMs: number;
  private _baseUrl: string;

  constructor(apiKey: string, opts?: { timeoutMs?: number; baseUrl?: string }) {
    this._apiKey = apiKey;
    this._timeoutMs = opts?.timeoutMs ?? 60_000;
    this._baseUrl = (opts?.baseUrl?.trim() || VIDU_DEFAULT_BASE).replace(/\/$/, "");
  }

  /**
   * Submit a reference-to-video creation task.
   * POST https://api.vidu.cn/ent/v2/reference2video
   */
  async createRef2V(body: ViduCreateBody): Promise<ViduCreateResponse> {
    const url = `${this._baseUrl}${CREATE_PATH}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${this._apiKey}`,
      },
      body: JSON.stringify(body),
      // 2026-05-18: 用户原话"本地不设额外的等待时间限制" — _timeoutMs 不再用
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new ViduApiError(
        `Vidu create failed: HTTP ${resp.status} ${text.slice(0, 500)}`,
        resp.status,
      );
    }

    return (await resp.json()) as ViduCreateResponse;
  }

  /**
   * Query task status.
   * GET https://api.vidu.cn/ent/v2/tasks/{taskId}/creations
   */
  async queryTask(taskId: string): Promise<ViduTaskStatus> {
    const url = `${this._baseUrl}${QUERY_PREFIX}${taskId}${QUERY_SUFFIX}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${this._apiKey}`,
      },
      // 2026-05-18: 用户原话"本地不设额外的等待时间限制" — _timeoutMs 不再用
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new ViduApiError(
        `Vidu query failed: HTTP ${resp.status} ${text.slice(0, 500)}`,
        resp.status,
      );
    }

    return (await resp.json()) as ViduTaskStatus;
  }

  /**
   * Download video bytes from a creation URL.
   */
  async downloadVideo(videoUrl: string): Promise<Buffer> {
    const { streamDownloadToFile } = await import("../core/streamDownload");
    const path = await import("node:path");
    const fsp = await import("node:fs/promises");
    const tmpPath = path.join(process.cwd(), "data", "_tmp", `vidu_${Date.now()}.mp4`);
    try {
      const result = await streamDownloadToFile(videoUrl, tmpPath, {
        maxBytes: 200_000_000,
        timeoutMs: 120_000,
      });
      return await fsp.readFile(result.filePath);
    } finally {
      try { await fsp.unlink(tmpPath); } catch { /* ignore */ }
    }
  }

  /**
   * S1: Cancel a running generation task.
   * POST /ent/v2/tasks/{taskId}/cancel
   */
  async cancelTask(taskId: string): Promise<"cancelled" | "failed"> {
    const url = `${this._baseUrl}/tasks/${encodeURIComponent(taskId)}/cancel`;
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${this._apiKey}`,
        },
        // 2026-05-18: 不设本地 timeout
      });
      if (!resp.ok) return "failed";
      return "cancelled";
    } catch {
      return "failed";
    }
  }

  // 2026-05-28 audit P1-35: pollUntilDone 是死代码, 全 repo 只在本文件出现一次.
  // ViduRefVideoProvider 直接走 pollAsyncJob, 不调这里. 删掉避免后续误用 (wall-clock timeout).
}

// ─── Errors ───────────────────────────────────────────────────────────

export class ViduApiError extends Error {
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.name = "ViduApiError";
    this.httpStatus = httpStatus;
  }
}

// 2026-05-28 audit P1-35: sleep helper 跟 pollUntilDone 一起删 — 仅用于 wall-clock 路径,
// 现在 ViduClient 不再做自己的 polling 循环, 由 caller 走 pollAsyncJob.
