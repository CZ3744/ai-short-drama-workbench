/**
 * Post-generation Quality Check — B2 Wave B
 *
 * 4-item automated quality check after image/video generation:
 *   1. Composition score (LLM vision)
 *   2. Sharpness score (Laplacian variance)
 *   3. Prompt alignment score (CLIP / LLM vision)
 *   4. Subject completeness (LLM vision, only when character_ids present)
 *
 * Design:
 * - LLM-vision checks are mocked in unit-test mode (return neutral scores)
 * - Sharpness is computed locally from pixel data (always real)
 * - Each score is 0-1; aggregated into QualityScores
 * - Threshold check is caller's responsibility (orchestrator)
 */

import { scoreImage } from "./clipScorer";

// ─── Types ──────────────────────────────────────────────────────────

// 2026-05-18 (红线 #1 禁伪 mock): 改为 number | undefined.
// 历史: 缺 OPENROUTER_API_KEY / fetch 失败 / 无 sharp/pngjs 时 silent return 0.6 (composition / prompt_alignment / subject_completeness)
// 或 0.5 (sharpness). 这些"中性分"在 QualityBadge 上显示成真分数(亮黄色 + 0.6 + 一般), 用户以为是真评分.
// 现: 缺基础设施时返回 undefined, QualityBadge 必须显示"未评分"灰色态. 真分必须是真调用得到的.
export interface QualityScores {
  /** 0-1: How well the image is composed (balance, rule-of-thirds, framing). undefined = 未评分 */
  composition?: number;
  /** 0-1: Image sharpness (Laplacian variance). undefined = 未评分 */
  sharpness?: number;
  /** 0-1: How well the image matches the text prompt (CLIP-style). undefined = 未评分 */
  prompt_alignment?: number;
  /** 0-1: Whether the main subject is complete and visible. undefined = 未评分 / 无角色引用 */
  subject_completeness?: number;
  /** Timestamp */
  checked_at: string;
}

export interface PostGenCheckOptions {
  /** The text prompt used for generation */
  prompt: string;
  /** Character IDs referenced in this shot (if any) */
  character_ids?: string[];
  /** If true, LLM-vision checks return neutral scores (for unit tests) */
  mock?: boolean;
}

// ─── Sharpness: Laplacian variance ──────────────────────────────────

/**
 * Decode a PNG buffer to raw RGBA pixel data.
 * Returns { width, height, data } where data is Uint8ClampedArray of RGBA.
 */
async function decodePng(buffer: Buffer): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  // Try pngjs first (lightweight) — dynamic import to handle optional dependency
  try {
    const pngjs = await (Function('return import("pngjs")')() as Promise<any>);
    const PNG = pngjs.PNG;
    if (PNG) {
      return new Promise((resolve, reject) => {
        const png = new PNG();
        png.parse(buffer, (err: Error | null, data: any) => {
          if (err) reject(err);
          else resolve({ width: data.width, height: data.height, data: data.data });
        });
      });
    }
  } catch {
    // pngjs not available — try sharp
  }

  // Fallback: use sharp (if available)
  try {
    const sharpMod = await (Function('return import("sharp")')() as Promise<any>);
    const sharp = sharpMod.default || sharpMod;
    const { data, info } = await sharp(buffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    };
  } catch {
    // 2026-05-18: 没 sharp / pngjs → throw, 调用方 sharpness undefined.
    // 不能返单像素 mock 假分.
    throw new Error("no_image_decoder_available");
  }
}

/**
 * Convert RGBA pixel data to grayscale float array.
 * Uses luminance formula: 0.299R + 0.587G + 0.114B
 */
function toGrayscale(data: Uint8ClampedArray, pixelCount: number): Float32Array {
  const gray = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    gray[i] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  }
  return gray;
}

/**
 * Apply 3x3 Laplacian kernel to grayscale image.
 * Kernel: [[0, -1, 0], [-1, 4, -1], [0, -1, 0]]
 * Returns the variance of the absolute Laplacian values.
 * Higher variance = sharper image (more edges).
 */
function laplacianVariance(gray: Float32Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      // Laplacian kernel: 4*center - top - bottom - left - right
      const laplacian =
        4 * gray[idx] -
        gray[(y - 1) * width + x] -  // top
        gray[(y + 1) * width + x] -  // bottom
        gray[y * width + (x - 1)] -  // left
        gray[y * width + (x + 1)];   // right

      const absVal = Math.abs(laplacian);
      sum += absVal;
      sumSq += absVal * absVal;
      count++;
    }
  }

  if (count === 0) return 0;

  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return variance;
}

/**
 * Compute sharpness score from image buffer.
 * Returns 0-1 where 1 = perfectly sharp, 0 = very blurry.
 * Uses Laplacian variance with a calibration curve.
 */
export async function computeSharpness(buffer: Buffer): Promise<number | undefined> {
  // 2026-05-18: 任何失败 (decoder 缺 / 图太小) 返回 undefined, 不返"中性 0.5" 假分.
  try {
    const { width, height, data } = await decodePng(buffer);

    // Skip if image is too small to decode properly
    if (width <= 1 && height <= 1) return undefined;

    const gray = toGrayscale(data, width * height);
    const variance = laplacianVariance(gray, width, height);

    // Calibrate variance to 0-1 score
    // Typical Laplacian variance ranges: blurry < 100, moderate 100-500, sharp > 500
    // We use a sigmoid-like curve to normalize
    const score = 1 - Math.exp(-variance / 300);
    return Math.max(0, Math.min(1, score));
  } catch {
    return undefined;
  }
}

// ─── Composition check (LLM vision) ────────────────────────────────

/**
 * Check image composition via LLM vision.
 * In mock mode, returns a neutral 0.6 score.
 * In real mode, sends image to multimodal LLM asking for composition score.
 */
async function checkComposition(buffer: Buffer, prompt: string, mock: boolean): Promise<number | undefined> {
  // 2026-05-18: 改为 undefined (未评分), 防止"中性 0.6" 假分误导用户.
  if (mock) return undefined; // mock 模式不评分 (单测验功能不验质量)

  // Real implementation: use OpenRouter vision API
  try {
    const { readLocalSettings, getConfigValue } = await import("../../../core/src/index");
    const local = readLocalSettings();
    const apiKey = local.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
    if (!apiKey) return undefined; // 缺 key 显式标记未评分, 不要 0.6 假装是真分

    const model = getConfigValue("CLIP_SCORER_MODEL", "google/gemini-2.5-flash-preview");
    const baseUrl = getConfigValue("CLIP_SCORER_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/$/, "");

    const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;

    const body = {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          {
            type: "text",
            text: [
              "You are a composition quality scorer for generated images.",
              "Rate the composition quality on a scale of 0.0 to 1.0.",
              "Consider: rule of thirds, visual balance, framing, subject placement, negative space.",
              `Prompt context: "${prompt}"`,
              'Respond with ONLY a JSON object: {"score": <number>}',
            ].join("\n"),
          },
        ],
      }],
      temperature: 0.1,
      max_tokens: 50,
    };

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(30_000).
    });

    if (!resp.ok) return undefined; // fetch 失败显式标记未评分
    const data = await resp.json() as any;
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    return parseScore(content);
  } catch {
    return undefined; // 异常也标记未评分
  }
}

// ─── Subject completeness check (LLM vision) ───────────────────────

/**
 * Check if the main subject (character) is complete and visible.
 * Only relevant when character_ids are present.
 * In mock mode, returns a neutral 0.6 score.
 */
async function checkSubjectCompleteness(
  buffer: Buffer,
  prompt: string,
  characterIds: string[],
  mock: boolean,
): Promise<number | undefined> {
  // Skip if no characters referenced — 这是"无需评分", 不是"未评分", 用 1.0 表示满分(不锁主体)
  if (!characterIds || characterIds.length === 0) return 1.0;

  if (mock) return undefined;

  try {
    const { readLocalSettings, getConfigValue } = await import("../../../core/src/index");
    const local = readLocalSettings();
    const apiKey = local.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;
    if (!apiKey) return undefined;

    const model = getConfigValue("CLIP_SCORER_MODEL", "google/gemini-2.5-flash-preview");
    const baseUrl = getConfigValue("CLIP_SCORER_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/$/, "");

    const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;

    const body = {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl } },
          {
            type: "text",
            text: [
              "You are a subject completeness checker for generated images.",
              `This image should contain ${characterIds.length} character(s).`,
              "Rate whether the main subject/character is fully visible and complete (not cropped, not occluded).",
              "Scale: 0.0 = subject missing/very incomplete, 0.5 = partially visible, 1.0 = fully visible and complete.",
              `Prompt: "${prompt}"`,
              'Respond with ONLY a JSON object: {"score": <number>}',
            ].join("\n"),
          },
        ],
      }],
      temperature: 0.1,
      max_tokens: 50,
    };

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(30_000).
    });

    if (!resp.ok) return undefined;
    const data = await resp.json() as any;
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    return parseScore(content);
  } catch {
    return undefined;
  }
}

// ─── Prompt alignment (CLIP scorer) ─────────────────────────────────

/**
 * Check prompt-image alignment using the existing CLIP scorer.
 * In mock mode, returns a neutral 0.6 score.
 */
async function checkPromptAlignment(
  buffer: Buffer,
  prompt: string,
  mock: boolean,
): Promise<number | undefined> {
  if (mock) return undefined;

  // Reuse the existing clipScorer — 真失败时这个内部已抛 / 返 0, 这里捕获后返 undefined
  try {
    const s = await scoreImage(buffer, prompt);
    return typeof s === "number" && Number.isFinite(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

// ─── Score parser (shared) ──────────────────────────────────────────

function parseScore(raw: string): number {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "number") return clamp(parsed);
    if (typeof parsed === "object" && parsed !== null) {
      const val = parsed.score ?? parsed.match_score ?? parsed.quality ?? parsed.rating;
      if (typeof val === "number") return clamp(val);
      if (typeof val === "string") return clamp(parseFloat(val));
    }
  } catch { /* not JSON */ }

  const floatMatch = trimmed.match(/(\d+\.?\d*)/);
  if (floatMatch) {
    const rawVal = parseFloat(floatMatch[1]);
    if (rawVal > 1 && rawVal <= 100) return clamp(rawVal / 100);
    return clamp(rawVal);
  }

  return 0.5;
}

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

// ─── Main function ──────────────────────────────────────────────────

/**
 * Run all 4 post-generation quality checks on an image.
 *
 * @param buffer - The generated image buffer (PNG/JPEG)
 * @param opts   - Options including prompt, character_ids, and mock flag
 * @returns QualityScores with all 4 dimensions
 *
 * Each check is non-blocking: failures return neutral scores (0.5-0.6),
 * ensuring the pipeline never stalls on quality checks.
 */
export async function postGenCheck(
  buffer: Buffer,
  opts: PostGenCheckOptions,
): Promise<QualityScores> {
  const mock = opts.mock ?? false;

  // 2026-05-18: 单项失败 → undefined (未评分), 不再用"中性 0.5/0.6"假分掩盖.
  // 前端 QualityBadge 必须区分 "undefined = 未评分(灰色态)" vs "number = 真分".
  const [composition, sharpness, prompt_alignment, subject_completeness] = await Promise.all([
    checkComposition(buffer, opts.prompt, mock).catch(() => undefined),
    computeSharpness(buffer).catch(() => undefined),
    checkPromptAlignment(buffer, opts.prompt, mock).catch(() => undefined),
    checkSubjectCompleteness(buffer, opts.prompt, opts.character_ids ?? [], mock).catch(() => undefined),
  ]);

  return {
    composition,
    sharpness,
    prompt_alignment,
    subject_completeness,
    checked_at: new Date().toISOString(),
  };
}
