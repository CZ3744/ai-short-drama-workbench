// P5B: 60s TTL cache for provider health checks
// Avoids hammering provider APIs on every GET /providers/health call.

export type QuotaState = "ok" | "low" | "exhausted" | "unknown";

export interface HealthEntry {
  id: string;
  ok: boolean;
  quota_state: QuotaState;
  last_checked_at: string;
  reason?: string;
}

const cache = new Map<string, { result: HealthEntry; ts: number }>();
const TTL = 60_000; // 60 seconds

export function getCachedHealth(providerId: string): HealthEntry | null {
  const entry = cache.get(providerId);
  if (entry && Date.now() - entry.ts < TTL) {
    return entry.result;
  }
  return null;
}

export function setCachedHealth(providerId: string, result: HealthEntry): void {
  cache.set(providerId, { result, ts: Date.now() });
}

export function clearHealthCache(): void {
  cache.clear();
}

/** Probe an LLM provider's health with a lightweight tokens=1 call */
export async function checkProviderHealth(
  providerId: string,
  checkConnection: (id: string) => Promise<{ ok: boolean; error_type?: string; error?: string }>,
): Promise<HealthEntry> {
  const now = new Date().toISOString();
  try {
    const result = await checkConnection(providerId);
    if (result.ok) {
      return { id: providerId, ok: true, quota_state: "ok", last_checked_at: now };
    }
    // Determine quota state from error type
    let quota_state: QuotaState = "unknown";
    const errorType = result.error_type ?? "";
    const errorMsg = (result.error ?? "").toLowerCase();
    if (errorType === "rate_limit" || errorMsg.includes("rate limit")) {
      quota_state = "exhausted";
    } else if (errorType === "key_missing" || errorType === "auth_failed") {
      quota_state = "unknown";
    } else if (errorMsg.includes("quota") || errorMsg.includes("insufficient")) {
      quota_state = "exhausted";
    }
    return { id: providerId, ok: false, quota_state, last_checked_at: now, reason: result.error_type ?? "connection_failed" };
  } catch (err) {
    return { id: providerId, ok: false, quota_state: "unknown", last_checked_at: now, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function getHealthWithCache(
  providerId: string,
  checkConnection: (id: string) => Promise<{ ok: boolean; error_type?: string; error?: string }>,
): Promise<HealthEntry> {
  const cached = getCachedHealth(providerId);
  if (cached) return cached;
  const result = await checkProviderHealth(providerId, checkConnection);
  setCachedHealth(providerId, result);
  return result;
}
