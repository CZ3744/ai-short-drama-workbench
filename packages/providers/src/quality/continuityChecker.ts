/**
 * Continuity checker — B3 Wave B
 *
 * Checks visual continuity between adjacent shots by sending two first-frame
 * images to a multimodal LLM and asking whether they depict the same scene
 * context (location, time, style, character appearance).
 *
 * Design:
 * - Non-blocking: API failures return `true` (assume continuity, don't false-alarm)
 * - Same OpenRouter key as clipScorer
 * - Called after all first-frame tasks complete for an episode
 */

import { getConfigValue, readLocalSettings } from "../../../core/src/index";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "google/gemini-2.5-flash-preview";
const TIMEOUT_MS = 30_000;

function getOpenRouterApiKey(): string | null {
  const local = readLocalSettings();
  const fromLocal = local.OPENROUTER_API_KEY;
  if (fromLocal && fromLocal.trim()) return fromLocal.trim();
  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return null;
}

function bufferToDataUrl(buffer: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * Parse the LLM's boolean/JSON response about continuity.
 * Handles: "true", "false", JSON {"continuity": true/false}, "yes"/"no", etc.
 */
function parseContinuityResult(raw: string): boolean {
  const lower = raw.trim().toLowerCase();

  // Try JSON parse
  try {
    const parsed = JSON.parse(raw.trim());
    if (typeof parsed === "boolean") return parsed;
    if (typeof parsed === "object" && parsed !== null) {
      const val = parsed.continuity ?? parsed.consistent ?? parsed.match ?? parsed.ok;
      if (typeof val === "boolean") return val;
    }
  } catch { /* not JSON */ }

  // Negative keywords MUST be checked first because:
  //   "inconsistent" contains "consistent"
  //   "mismatch" contains "match"
  if (lower.includes("inconsistent") || lower.includes("mismatch")) {
    return false;
  }
  if (lower.includes("false") || lower.includes("no")) {
    return false;
  }
  if (lower.includes("consistent") || lower.includes("match")) {
    return true;
  }
  if (lower.includes("true") || lower.includes("yes")) {
    return true;
  }

  return true; // default: assume continuity (don't false-alarm)
}

export interface ContinuityResult {
  /** Whether the two shots are visually consistent */
  consistent: boolean;
  /** Optional reason from the LLM */
  reason?: string;
}

/**
 * Check visual continuity between two adjacent shots' first frames.
 *
 * @param prevBuffer - First frame image of the previous shot
 * @param currBuffer - First frame image of the current shot
 * @param context - Optional description of the shots for better LLM judgment
 * @returns ContinuityResult with consistent flag and optional reason
 *
 * Returns `{ consistent: true }` if the API is unavailable or fails.
 */
export async function checkContinuity(
  prevBuffer: Buffer,
  currBuffer: Buffer,
  context?: string,
): Promise<ContinuityResult> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    console.warn("[continuityChecker] OPENROUTER_API_KEY not configured, assuming continuity");
    return { consistent: true, reason: "API key not configured" };
  }

  const model = getConfigValue("CLIP_SCORER_MODEL", DEFAULT_MODEL);
  const baseUrl = getConfigValue("CLIP_SCORER_BASE_URL", OPENROUTER_BASE_URL).replace(/\/$/, "");

  const prevDataUrl = bufferToDataUrl(prevBuffer);
  const currDataUrl = bufferToDataUrl(currBuffer);

  const contextLine = context ? `\nContext: ${context}` : "";

  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "You are a film continuity checker.",
              "Compare these two consecutive shot frames and determine if they are visually consistent.",
              "",
              "Check for:",
              "- Same location/setting (indoor/outdoor, time of day)",
              "- Same character appearance (clothing, hair, age)",
              "- Same visual style (lighting, color palette, art style)",
              "- Logical narrative progression",
              `${contextLine}`,
              "",
              'Respond with ONLY a JSON object: {"consistent": <boolean>, "reason": "<brief explanation>"}',
            ].join("\n"),
          },
          {
            type: "image_url",
            image_url: { url: prevDataUrl },
          },
          {
            type: "image_url",
            image_url: { url: currDataUrl },
          },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 150,
  };

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" — 删 AbortSignal.timeout(TIMEOUT_MS).
    });

    if (!resp.ok) {
      console.warn(`[continuityChecker] API returned HTTP ${resp.status}, assuming continuity`);
      return { consistent: true, reason: `HTTP ${resp.status}` };
    }

    const data = await resp.json() as any;
    const content: string =
      data?.choices?.[0]?.message?.content ??
      data?.choices?.[0]?.text ??
      "";

    if (!content) {
      console.warn("[continuityChecker] Empty response, assuming continuity");
      return { consistent: true, reason: "empty response" };
    }

    // Parse JSON response
    let consistent = true;
    let reason: string | undefined;
    try {
      const parsed = JSON.parse(content.trim());
      consistent = typeof parsed.consistent === "boolean" ? parsed.consistent : parseContinuityResult(content);
      reason = parsed.reason || parsed.explanation;
    } catch {
      consistent = parseContinuityResult(content);
    }

    console.log(`[continuityChecker] consistent=${consistent}${reason ? `, reason="${reason}"` : ""}`);
    return { consistent, reason };
  } catch (err) {
    console.warn(
      "[continuityChecker] API call failed:",
      err instanceof Error ? err.message : String(err),
      "→ assuming continuity",
    );
    return { consistent: true, reason: "API call failed" };
  }
}
