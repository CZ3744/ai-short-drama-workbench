// ====================================================================
// diagnosticsApi.ts — Failures + Diagnostics + Raw Image + SSE Reader
// (P1 wave 2 #11 解耦)
// ====================================================================
// 覆盖范围:
// - FailureItem / FailuresResponse / list / ignore
// - DiagnosticsResponse / getDiagnostics
// - Raw Image Generation (generateRawImage)
// - SSE stream reader (connectSse)
// ====================================================================

import { apiGet, apiPatch, apiPost } from "./_apiClient";

// ─────── 失败中心 ───────

export interface FailureItem {
  id: string;
  category: string;
  category_label: string;
  source: "generation" | "task";
  kind?: string;
  provider?: string;
  series_slug?: string;
  series_title?: string;
  episode_id?: string;
  shot_id?: string;
  task_id?: string;
  generation_id?: string;
  job_id?: string;
  error_code?: string;
  error_message: string;
  raw_error_sanitized?: string;
  request_summary?: string;
  prompt_final?: string | null;
  prompt_snippet?: string | null;
  cost_cny?: number | null;
  created_at?: string;
  ignored: boolean;
  retry_count: number;
}

export interface FailuresResponse {
  ok: boolean;
  total: number;
  since: string;
  cutoff: string;
  summary: Array<{ category: string; label: string; count: number }>;
  grouped: Record<string, FailureItem[]>;
  failures: FailureItem[];
}

export async function getFailures(since = "24h") {
  return apiGet<FailuresResponse>(`/api/v2/failures?since=${encodeURIComponent(since)}`);
}

export async function ignoreFailure(id: string) {
  return apiPatch<{ ok: boolean }>(`/api/v2/failures/${encodeURIComponent(id)}/ignore`, {});
}

// ─────── Diagnostics ───────

export interface DiagnosticsResponse {
  env?: Record<string, unknown>;
  keys?: Record<string, "present" | "missing">;
  tools?: Record<string, { found: boolean; version: string }>;
  disk?: Record<string, unknown>;
  queue?: Record<string, unknown>;
  inflight?: Array<Record<string, unknown>>;
  recent_errors?: Array<{
    timestamp?: string;
    level?: string;
    message?: string;
    source?: string;
    [key: string]: unknown;
  }>;
  budget?: Record<string, unknown>;
}

export async function getDiagnostics(): Promise<DiagnosticsResponse> {
  return apiGet<DiagnosticsResponse>("/api/v2/diagnostics");
}

// ====================================================================
// Raw Image Generation
// ====================================================================

export interface RawImageReferenceInput {
  asset_id?: string;
  vault_id?: string;
  path?: string;
  data_url?: string;
  base64?: string;
  mime?: string;
  weight?: number;
}

export interface RawImageGenerationInput {
  provider_id?: string;
  model_ref?: string;
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  count?: number;
  seed?: number;
  series_slug?: string;
  reference_images?: RawImageReferenceInput[];
  strict_reference_images?: boolean;
  extras?: Record<string, unknown>;
}

export interface RawGeneratedImage {
  index: number;
  data_url: string;
  base64: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  seed?: number;
}

export interface RawImageGenerationResult {
  ok: true;
  provider_id: string;
  elapsed_ms: number;
  task_id: string;
  images: RawGeneratedImage[];
  cost?: { currency: "CNY" | "USD"; amount: number; basis: "measured" | "estimated" };
}

export async function generateRawImage(input: RawImageGenerationInput): Promise<RawImageGenerationResult> {
  return apiPost<RawImageGenerationResult>("/api/v2/images/generate", input, { timeoutMs: 600_000 });
}

// ─── Wave 3: SSE stream reader ──────────────────────────────────────

/**
 * Connect to an SSE endpoint and call onEvent for each received event.
 * Returns a promise that resolves when the stream ends or rejects on error.
 * Pass an AbortSignal to cancel.
 */
export function connectSse(
  url: string,
  onEvent: (type: string, data: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  return fetch(url, { signal }).then(async (response) => {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`SSE connect failed: ${response.status} ${text}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("ReadableStream not supported");
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        if (!part.trim()) continue;
        let type = "";
        let data = "";
        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) type = line.slice(7).trim();
          else if (line.startsWith("data: ")) data = line.slice(6).trim();
        }
        if (data) {
          try {
            onEvent(type, JSON.parse(data));
          } catch {
            // skip malformed events
          }
        }
      }
    }
  });
}
