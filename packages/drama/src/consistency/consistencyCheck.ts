/**
 * B4 — 角色一致性检查模块
 *
 * 提供:
 * 1. CLIP 相似度计算 (Gemini Flash 视觉 API 或 本地 CLIP)
 * 2. 两两相似度矩阵 → 散点图数据
 * 3. 漂移检测 (阈值警告)
 * 4. LoRA 训练 v2 占位接口
 *
 * Wave 2C: CLIP 一致性真实现
 * - 策略 A (默认): gemini_flash — 调 OpenRouter Gemini Flash 视觉 API
 * - 策略 B: local_clip — 本地 @xenova/transformers CLIP 模型
 * - 策略 C: 兼容旧 phash 配置名，仅非空字节完全相同时返回 byte_identical。
 *   不同图像且评分服务不可用时抛出 ConsistencyScorerUnavailable，不生成路径伪评分。
 *   Gemini 是视觉模型评分，不是 CLIP 嵌入相似度；method 必须随结果保留。
 * - 开关: CONSISTENCY_SCORER_PROVIDER 环境变量 / local-settings (值: gemini_flash / local_clip / phash)
 */

import { getConfigValue } from "../../../core/src/index";
import { resolveWorkspaceMediaFile } from "../../../core/src/workspaceMedia";

// ─── Types ──────────────────────────────────────────────────────────────

/** 单张产物的元数据 */
export interface ConsistencyAsset {
  /** vault_id 或 asset_id */
  id: string;
  /** 图片 URL 或本地路径 */
  image_url: string;
  /** 生成时间 ISO8601 */
  created_at: string;
  /** 来源 shot_id (可选) */
  shot_id?: string;
  /** 来源 provider */
  provider_id?: string;
  /** seed (可选) */
  seed?: number;
}

/** 两两相似度条目 */
export interface PairwiseSimilarity {
  asset_a_id: string;
  asset_b_id: string;
  /** CLIP 相似度 0-1 */
  similarity: number;
  /** 评分方法 (gemini_flash | local_clip | byte_identical) */
  method?: string;
}

/** 散点图数据点 */
export interface ScatterPoint {
  x: number;  // 第一个资产索引
  y: number;  // 第二个资产索引
  /** 相似度值 */
  value: number;
  /** 是否低于阈值 */
  is_drift: boolean;
  asset_a_id: string;
  asset_b_id: string;
  /** 评分方法 */
  method?: string;
}

/** 相似度元数据 (computeClipSimilarityWithMeta 返回) */
export interface ClipSimilarityResult {
  similarity: number;
  method: string;
}

/** 一致性体检报告 */
export interface ConsistencyReport {
  status: "evaluated" | "insufficient_assets";
  method?: string;
  /** 角色 ID */
  character_id: string;
  /** 检查时间 */
  checked_at: string;
  /** 总资产数 */
  total_assets: number;
  /** 平均相似度 */
  avg_similarity: number | null;
  /** 最低相似度 */
  min_similarity: number | null;
  /** 最高相似度 */
  max_similarity: number | null;
  /** 漂移对数 (低于阈值) */
  drift_count: number;
  /** 漂移阈值 */
  drift_threshold: number;
  /** 所有两两相似度 */
  pairs: PairwiseSimilarity[];
  /** 散点图数据 */
  scatter_data: ScatterPoint[];
  /** 漂移警告列表 */
  drift_warnings: Array<{
    asset_a_id: string;
    asset_b_id: string;
    similarity: number;
    message: string;
  }>;
  /** LoRA 训练建议 (v2 占位) */
  lora_recommendation?: {
    should_train: boolean;
    reason: string;
    estimated_improvement: number;
  };
}

// ─── Config ─────────────────────────────────────────────────────────────

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_VISION_MODEL = "google/gemini-2.5-flash-preview";
type ScorerProvider = "gemini_flash" | "local_clip" | "phash";

function resolveScorerProvider(): ScorerProvider {
  const val = getConfigValue("CONSISTENCY_SCORER_PROVIDER", "gemini_flash").trim().toLowerCase();
  // 2026-05-20 Wave T S26 — 加 phash 起点(用户可强制只跑兜底,完全离线)
  if (val === "phash") return "phash";
  if (val === "local_clip") return "local_clip";
  return "gemini_flash";
}

function getOpenRouterApiKey(): string | null {
  return getConfigValue("OPENROUTER_API_KEY").trim() || null;
}

// ─── Strategy A: Gemini Flash Vision API ────────────────────────────────

/**
 * 调用 Gemini Flash 多模态 API 比对两张图是否为同一角色/同一场景。
 * 返回 0-1 相似度。
 */
async function scoreViaGeminiFlash(imageA: string, imageB: string): Promise<number> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not configured");
  }

  const model = getConfigValue("CONSISTENCY_SCORER_MODEL", DEFAULT_VISION_MODEL);
  const baseUrl = getConfigValue("CONSISTENCY_SCORER_BASE_URL", OPENROUTER_BASE_URL).replace(/\/$/, "");

  const [visionA, visionB] = await Promise.all([imageA, imageB].map(image => /^(https?:|data:)/.test(image) ? Promise.resolve(image) : fetchImageAsDataUrl(image)));
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: visionA },
          },
          {
            type: "image_url",
            image_url: { url: visionB },
          },
          {
            type: "text",
            text: [
              "You are a visual consistency scorer for character/scene images.",
              "Compare these TWO images and rate their similarity on a scale of 0.0 to 1.0.",
              "",
              "Scoring guide:",
              "- 1.0: Same character/scene, near-identical appearance, lighting, style.",
              "- 0.8-0.95: Same subject, minor pose/expression/angle differences.",
              "- 0.5-0.8: Same category (e.g. both anime girls), but clearly different character/scene.",
              "- 0.2-0.5: Different subjects, but some shared visual elements (color palette, art style).",
              "- 0.0-0.2: Completely unrelated images.",
              "",
              "Key questions to consider:",
              "1. Is this the SAME character? (face, hair, outfit, body proportions)",
              "2. Is this the SAME scene/location? (background, lighting, props)",
              "3. How consistent is the art style between them?",
              "",
              'Respond with ONLY a JSON object: {"score": <number>, "is_same_character": <boolean>, "is_same_scene": <boolean>, "reason": "<short explanation>"}',
            ].join("\n"),
          },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 150,
  };

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(VISION_TIMEOUT_MS).
  });

  if (!resp.ok) {
    throw new Error(`Gemini Flash API HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as any;
  const content: string =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    "";

  if (!content) {
    throw new Error("Empty response from Gemini Flash API");
  }

  const score = parseVisionScore(content);
  console.log(`[consistencyCheck:gemini_flash] score=${score.toFixed(2)} raw=${content.slice(0, 80)}`);
  return score;
}

export function parseVisionScore(raw: string): number {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("视觉评分响应为空");
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let value: unknown;
  try {
    const parsed = JSON.parse(text);
    value = typeof parsed === "number" ? parsed : parsed?.score ?? parsed?.similarity ?? parsed?.match_score ?? parsed?.quality;
  } catch { value = text; }
  if (typeof value === "string") {
    if (/^(?:100|\d{1,2})(?:\.\d+)?%$/.test(value.trim())) value = Number(value.trim().slice(0, -1)) / 100;
    else if (/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value.trim())) value = Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("视觉评分响应没有有效的 0 到 1 分数");
  return value;
}

// ─── Strategy B: Local CLIP via @xenova/transformers ────────────────────

/**
 * 使用 @xenova/transformers 本地 CLIP 模型计算两张图的 embedding cosine 相似度。
 * 需要 npm install @xenova/transformers, 未安装时自动 fallback。
 */
async function scoreViaLocalClip(imageA: string, imageB: string): Promise<number> {
  // Image embeddings require the vision model, not the text feature-extraction pipeline.
  const transformers: any = await import("@xenova/transformers");
  const { AutoProcessor, CLIPVisionModelWithProjection, RawImage } = transformers;
  const modelId = "Xenova/clip-vit-base-patch16";
  const processor = await AutoProcessor.from_pretrained(modelId);
  const model = await CLIPVisionModelWithProjection.from_pretrained(modelId);
  try {
    const vectors: number[][] = [];
    for (const image of [imageA, imageB]) {
      const raw = await RawImage.read(await fetchImageAsDataUrl(image));
      const output = await model(await processor(raw));
      vectors.push(Array.from(output.image_embeds.data as Float32Array));
    }
    const [a, b] = vectors;
    if (!a.length || a.length !== b.length || [...a, ...b].some(v => !Number.isFinite(v))) throw new Error("图像嵌入无效");
    const norm = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0) * b.reduce((sum, v) => sum + v * v, 0));
    if (!Number.isFinite(norm) || norm === 0) throw new Error("图像嵌入无效");
    const cosine = a.reduce((sum, v, i) => sum + v * b[i], 0) / norm;
    return clamp((cosine + 1) / 2);
  } finally { await model.dispose(); }

}

/**
 * Fetch an image URL and return as base64 data URL (for Transformers.js input).
 * Supports: http/https URLs, file:// paths, local paths.
 */
async function fetchImageAsDataUrl(url: string): Promise<string> {
  // If already a data URL, return as-is
  if (url.startsWith("data:")) return url;

  // Remote URL
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch image: HTTP ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ext = url.split(".").pop()?.split("?")[0] ?? "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }

  // Local file path
  const fs = await import("node:fs/promises");
  const resolved = resolveWorkspaceMediaFile(url);
  const buffer = await fs.readFile(resolved);
  const ext = resolved.split(".").pop() ?? "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

// ─── Strategy C: 只验证字节完全一致，不替代视觉评分 ──────────

/** 服务不可用不是质量合格；未得到真实评分时显式报告不可用。 */
async function scoreViaPHashStub(imageA: string, imageB: string): Promise<ClipSimilarityResult> {
  // 兼容旧的 phash 配置名，但这里只能证明字节相同，不能证明语义相似。
  try {
    const [bufA, bufB] = await Promise.all([fetchImageAsBytes(imageA), fetchImageAsBytes(imageB)]);
    if (bufA.length > 0 && bufA.equals(bufB)) return { similarity: 1.0, method: "byte_identical" };
  } catch { /* 无法读取图像不代表图像一致。 */ }
  const error = new Error("一致性评分不可用：请配置视觉评分服务或本地 CLIP。文件路径、同目录关系和随机哈希不能替代图像相似度。");
  Object.assign(error, { code: "ConsistencyScorerUnavailable", status: 503 });
  throw error;
}

/** 把图 URL/路径下成 Buffer(http/local 两路) */
async function fetchImageAsBytes(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const b64 = url.split(",")[1] ?? "";
    return Buffer.from(b64, "base64");
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  const fs = await import("node:fs/promises");
  const resolved = resolveWorkspaceMediaFile(url);
  return await fs.readFile(resolved);
}

// ─── CLIP Similarity (Real) ─────────────────────────────────────────────

/**
 * 计算两张图片的 CLIP 相似度 (完整结果,含 method 标注)。
 *
 * 2026-05-20 Wave T S26 — 三级 cascade 升级:
 *   1. **Gemini Flash 视觉 API**（默认首选，需要可用的服务配置）
 *      失败原因:网络中断 / OPENROUTER_API_KEY 未配 / 配额耗尽
 *   2. **Local CLIP @xenova/transformers**（需要可选依赖及已下载的模型）
 *      失败原因:`@xenova/transformers` 未装 / 模型下载失败
 *   3. **非空字节相同比对**：仅能确认两份文件完全一样。
 *      两图不同且服务均不可用时抛出错误，不能把服务故障表示为相似度分数。
 *
 * 用户可通过 `CONSISTENCY_SCORER_PROVIDER` 强制走某个起点:
 *   - "gemini_flash"(默认):试 1 → 2 → 3
 *   - "local_clip":跳过 1,从 2 → 3 起
 *   - "phash":只跑 3（不调用 LLM；远程 URL 仍需要读取文件）
 *
 * 本函数不设置固定生成超时。
 *
 * @param imageA - 第一张图片的 URL/路径
 * @param imageB - 第二张图片的 URL/路径
 * @returns 相似度 0-1 + 评分方法标注
 */
export async function computeClipSimilarityWithMeta(
  imageA: string,
  imageB: string,
): Promise<ClipSimilarityResult> {
  // 相同地址也须读取内容，不能把失效 URL 当成一致性证明。
  if (imageA === imageB) return scoreViaPHashStub(imageA, imageB);

  const provider = resolveScorerProvider();

  // 三级 cascade — 从用户偏好的起点开始,失败往下顺延
  // Gemini Flash(等级 1)
  if (provider === "gemini_flash") {
    try {
      const score = await scoreViaGeminiFlash(imageA, imageB);
      return { similarity: score, method: "gemini_flash" };
    } catch (err) {
      console.warn(
        `[consistencyCheck] gemini_flash 失败,降级试 local_clip:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Local CLIP(等级 2)— gemini 失败或用户起点选 local_clip 时跑
  if (provider === "gemini_flash" || provider === "local_clip") {
    try {
      const score = await scoreViaLocalClip(imageA, imageB);
      return { similarity: score, method: "local_clip" };
    } catch (err) {
      console.warn(
        `[consistencyCheck] local_clip 失败,降级 phash 兜底:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // 字节相同比对；无法评分时明确报错
  const phashResult = await scoreViaPHashStub(imageA, imageB);
  return phashResult;
}

/**
 * 计算两张图片的 CLIP 相似度 (仅返回数值,向后兼容)。
 *
 * 内部调用 computeClipSimilarityWithMeta, 丢弃 method 信息。
 *
 * @param imageA - 第一张图片的 URL/路径
 * @param imageB - 第二张图片的 URL/路径
 * @returns 相似度 0-1
 */
export async function computeClipSimilarity(
  imageA: string,
  imageB: string,
): Promise<number> {
  const result = await computeClipSimilarityWithMeta(imageA, imageB);
  return result.similarity;
}

/**
 * 批量计算一组资产的两两 CLIP 相似度矩阵。
 *
 * @param assets - 资产列表
 * @returns 两两相似度数组 (含 method 标注)
 */
export async function computePairwiseSimilarities(
  assets: ConsistencyAsset[],
  scorer: typeof computeClipSimilarityWithMeta = computeClipSimilarityWithMeta,
): Promise<PairwiseSimilarity[]> {
  const pairs: PairwiseSimilarity[] = [];

  for (let i = 0; i < assets.length; i++) {
    for (let j = i + 1; j < assets.length; j++) {
      const result = await scorer(
        assets[i].image_url,
        assets[j].image_url,
      );
      if (!Number.isFinite(result.similarity) || result.similarity < 0 || result.similarity > 1) throw new Error("一致性评分无效");
      pairs.push({
        asset_a_id: assets[i].id,
        asset_b_id: assets[j].id,
        similarity: result.similarity,
        method: result.method,
      });
    }
  }

  return pairs;
}

// ─── Drift Detection ────────────────────────────────────────────────────

/** 默认漂移阈值: 低于此值视为不一致 */
const DEFAULT_DRIFT_THRESHOLD = 0.65;

/**
 * 生成一致性体检报告。
 *
 * @param characterId - 角色 ID
 * @param assets - 该角色的所有历史产物
 * @param driftThreshold - 漂移阈值 (默认 0.65)
 * @returns 完整体检报告
 */
export async function runConsistencyCheck(
  characterId: string,
  assets: ConsistencyAsset[],
  driftThreshold: number = DEFAULT_DRIFT_THRESHOLD,
  scorer: typeof computeClipSimilarityWithMeta = computeClipSimilarityWithMeta,
): Promise<ConsistencyReport> {
  if (!Number.isFinite(driftThreshold) || driftThreshold < 0 || driftThreshold > 1) throw Object.assign(new Error("一致性阈值必须在 0 到 1 之间"), { status: 400 });
  if (assets.length < 2) {
    return {
      character_id: characterId,
      checked_at: new Date().toISOString(),
      total_assets: assets.length,
      status: "insufficient_assets",
      avg_similarity: null,
      min_similarity: null,
      max_similarity: null,
      drift_count: 0,
      drift_threshold: driftThreshold,
      pairs: [],
      scatter_data: [],
      drift_warnings: [],
      lora_recommendation: {
        should_train: false,
        reason: "产物不足 2 张, 无法评估一致性",
        estimated_improvement: 0,
      },
    };
  }

  const pairs = await computePairwiseSimilarities(assets, scorer);

  const methods = new Set(pairs.map(p => p.method));
  if (methods.size !== 1) throw Object.assign(new Error("本次评分使用了不同方法，无法汇总比较。请指定同一评分器后重试；上次报告仍然保留。"), { code: "ConsistencyScorerUnavailable", status: 503 });

  // 统计
  const similarities = pairs.map((p) => p.similarity);
  const avg = similarities.reduce((a, b) => a + b, 0) / similarities.length;
  const min = Math.min(...similarities);
  const max = Math.max(...similarities);

  // 散点图数据
  const assetIndexMap = new Map(assets.map((a, i) => [a.id, i]));
  const scatterData: ScatterPoint[] = pairs.map((p) => ({
    x: assetIndexMap.get(p.asset_a_id) ?? 0,
    y: assetIndexMap.get(p.asset_b_id) ?? 0,
    value: p.similarity,
    is_drift: p.similarity < driftThreshold,
    asset_a_id: p.asset_a_id,
    asset_b_id: p.asset_b_id,
    method: p.method,
  }));

  // 漂移警告
  const driftWarnings = pairs
    .filter((p) => p.similarity < driftThreshold)
    .map((p) => ({
      asset_a_id: p.asset_a_id,
      asset_b_id: p.asset_b_id,
      similarity: p.similarity,
      message: `相似度 ${(p.similarity * 100).toFixed(1)}% 低于阈值 ${(driftThreshold * 100).toFixed(0)}%, 角色外观可能已漂移`,
    }));

  // LoRA 建议 (v2 占位)
  const shouldTrainLora = driftWarnings.length >= 3 || avg < 0.7;

  return {
    character_id: characterId,
    checked_at: new Date().toISOString(),
    total_assets: assets.length,
    status: "evaluated",
    method: pairs[0]?.method,
    avg_similarity: avg,
    min_similarity: min,
    max_similarity: max,
    drift_count: driftWarnings.length,
    drift_threshold: driftThreshold,
    pairs,
    scatter_data: scatterData,
    drift_warnings: driftWarnings,
    lora_recommendation: {
      should_train: shouldTrainLora,
      reason: shouldTrainLora
        ? `检测到 ${driftWarnings.length} 对漂移, 平均相似度 ${(avg * 100).toFixed(1)}%, 建议训练 LoRA 提升一致性`
        : "角色一致性良好, 暂不需要 LoRA 训练",
      estimated_improvement: shouldTrainLora ? 0.15 : 0,
    },
  };
}

// ─── LoRA Training Placeholder (v2) ─────────────────────────────────────

/**
 * LoRA 训练接口 (v2 占位)。
 * 当前不实现, 仅留接口供后续扩展。
 *
 * @param characterId - 角色 ID
 * @param trainingImages - 训练图片列表
 * @returns 训练结果 (占位)
 */
export async function trainCharacterLoRA(
  characterId: string,
  trainingImages: string[],
): Promise<{
  success: boolean;
  lora_path: string | null;
  message: string;
}> {
  // v2 占位: 不实际训练
  void characterId;
  void trainingImages;
  return {
    success: false,
    lora_path: null,
    message: "LoRA 训练功能将在 v2 版本中实现。当前为占位接口。",
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Clamp 值到 [0, 1] 区间 */
function clamp(v: number): number {
  if (!Number.isFinite(v)) throw new Error("一致性评分不是有限数值");
  return Math.max(0, Math.min(1, v));
}
