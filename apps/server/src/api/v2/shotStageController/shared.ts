/**
 * shotStageController shared helpers — 拆自原 shotStageController.ts。
 *
 * 这里只放被多个子 router 共用的纯 helper / 类型 / DTO 构造。
 * Endpoint handler 按 frame-anchor / firstframe / video / failures / prompts
 * 拆到各自子文件,每个子文件 import 本文件后挂自己的 Router。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Request, Response } from "express";
import {
  readShot,
  readSeries,
  readAsset,
  resolveAssetFilePath,
  readCharacter,
  readScene,
  locateShotById,
  locateShotMatches,
  type ShotGeneration,
  type ShotData,
} from "../seriesStore";
import { listElements } from "../../../repositories/elementRepo";
// 2026-05-17 严格做法: @ mention token 解析 → 真注入 reference image (非纯文本)
import { parseMentionTokensFromTexts } from "../../../../../../packages/drama/src/mentionParser.js";
import { DATA_ROOT } from "../../../../../../packages/core/src/index";
import { getVaultAbsolutePath, getVaultEntry } from "../../../../../../packages/library/src/assetVault";
// 2026-05-20 display_name 体系统一: 候选 rename 同步 assetMetaRepo
import { listAssetMeta } from "../../../repositories/assetMetaRepo";
import { sendError as err } from "../validateHelpers";

export { err };

/**
 * W7 (2026-05-15) — Bug 1 修复:抽首帧/视频前必须有可用 provider,否则直接 400。
 *
 * B-P0-2 (2026-06-01): 本函数已移至 validateHelpers.ts 统一实现(同时修复了只查
 * image_provider_id 漏查 default_image 的一致性 bug)。
 * 此处保留 re-export 以不破现有 import 路径。
 */
export { assertProviderSelectedOrErr } from "../validateHelpers";

/**
 * 2026-05-17 严格做法 — @ mention token 解析 + 真注入 reference image.
 *
 * 流程:caller 提供 series_slug + 任意数量的文本(action/dialogue/voiceover/notes/user_extra),
 * 提取所有 `@角色:小明 / @场景:酒馆 / @物件:旧怀表[.img:xxx]` token, 查 listElements 找到对应
 * element + image, 返回 asset_id list + notes(给 reference_notes 用人类可读描述).
 *
 * 2026-05-27 — 找不到对应素材的 token 改为返 skippedTokens (之前 silent skip 用户无感知).
 *   caller 可以把 skippedTokens 透到 HTTP 响应里, 前端 toast "@xxx 这个素材没找到, 生成时
 *   未注入参考图". 跟工作流非线性铁律一致 — 缺前置数据时显式 toast 引导, 不阻塞.
 *
 * caller 把返回的 assetIds 传给 orchestrator.reference_asset_ids_extra,
 * orchestrator 自动 merge 到 shot.reference_asset_ids 注入 reference_images.
 */
export async function resolveMentionsToAssetIds(
  slug: string,
  ...texts: Array<string | undefined>
): Promise<{
  assetIds: string[];
  notes: Record<string, string>;
  /** 2026-05-27 — 找不到的 mention 列表 (用户感知"我 @ 的东西生效了吗") */
  skippedTokens: Array<{ name: string; kind: "character" | "scene" | "element"; reason: string }>;
}> {
  const tokens = parseMentionTokensFromTexts(...texts);
  if (tokens.length === 0) return { assetIds: [], notes: {}, skippedTokens: [] };

  const elements = await listElements(slug).catch(() => []);
  const assetIds: string[] = [];
  const notes: Record<string, string> = {};
  const skippedTokens: Array<{ name: string; kind: "character" | "scene" | "element"; reason: string }> = [];

  if (elements.length === 0) {
    // 整个 series 没素材 — 所有 token 都 skip, 全报回去
    for (const t of tokens) {
      skippedTokens.push({ name: t.name, kind: t.kind, reason: "series 暂无素材" });
    }
    return { assetIds, notes, skippedTokens };
  }

  for (const token of tokens) {
    // 按 name 精确匹配, 再按 kind 过滤(character/scene 严格,element 泛指 prop/wardrobe/reference/misc)
    let candidates = elements.filter((e) => e.name === token.name);
    if (candidates.length === 0) {
      skippedTokens.push({ name: token.name, kind: token.kind, reason: "素材库找不到这个名字" });
      continue;
    }

    if (token.kind === "character") {
      candidates = candidates.filter((e) => e.kind === "character");
    } else if (token.kind === "scene") {
      candidates = candidates.filter((e) => e.kind === "scene");
    } else {
      // @物件: 接受所有非 character/scene 的 kind
      candidates = candidates.filter((e) => e.kind !== "character" && e.kind !== "scene");
    }
    if (candidates.length === 0) {
      skippedTokens.push({ name: token.name, kind: token.kind, reason: "找到同名但类型不匹配" });
      continue;
    }

    const element = candidates[0];
    // 过滤"已废弃 / 暂不用"的图(T1 真素材池约束)
    const eligible = element.images.filter((i) => i.available_for_shot !== false);
    if (eligible.length === 0) {
      skippedTokens.push({ name: token.name, kind: token.kind, reason: "素材还没生图 (placeholder)" });
      continue;
    }

    let image = token.imageId ? eligible.find((i) => i.image_id === token.imageId) : undefined;
    if (!image) {
      image = eligible.find((i) => i.image_id === element.primary_image_id) ?? eligible[0];
    }

    const assetId = image.asset_id ?? image.vault_id ?? image.image_id;
    if (!assetId || assetIds.includes(assetId)) continue;

    assetIds.push(assetId);
    const labelParts = [element.name];
    if (image.display_name) labelParts.push(image.display_name);
    notes[assetId] = labelParts.join(" · ");
  }

  return { assetIds, notes, skippedTokens };
}

export function resolveCandidateUrl(slug: string, g: ShotGeneration): string {
  if (g.vault_id) return `/api/v2/vault/${g.vault_id}/raw`;
  if (g.asset_id) return `/api/v2/series/${slug}/assets/${g.asset_id}/thumbnail`;
  return "";
}

export function resolveCandidateThumbnail(slug: string, g: ShotGeneration): string | undefined {
  if (g.vault_id) return `/api/v2/vault/${g.vault_id}/thumbnail`;
  if (g.asset_id) return `/api/v2/series/${slug}/assets/${g.asset_id}/thumbnail?size=256`;
  return undefined;
}

export function toCandidate(
  slug: string,
  g: ShotGeneration,
  // 2026-05-20 display_name 体系统一: 由 caller 预加载 assetMetaMap 透传,
  // 让 toCandidate 保持纯函数. 优先级 assetMeta > g.display_name > g.user_label (deprecated 兼容老数据)
  assetMetaMap?: Map<string, { display_name?: string }>,
) {
  const metaByGen = assetMetaMap?.get(g.generation_id);
  const metaByVault = g.vault_id ? assetMetaMap?.get(g.vault_id) : null;
  const metaByAsset = g.asset_id ? assetMetaMap?.get(g.asset_id) : null;
  const displayName = metaByGen?.display_name
    ?? metaByVault?.display_name
    ?? metaByAsset?.display_name
    ?? g.display_name
    ?? g.user_label;
  return {
    id: g.generation_id,
    generation_id: g.generation_id,
    type: g.type,
    url: resolveCandidateUrl(slug, g),
    thumbnail: resolveCandidateThumbnail(slug, g),
    provider: g.provider,
    seed: g.seed,
    prompt: g.prompt ?? g.prompt_used ?? g.prompt_final ?? "",
    picked: g.picked ?? false,
    created_at: g.created_at,
    vault_id: g.vault_id ?? undefined,
    asset_id: g.asset_id ?? undefined,
    cost_cny: g.cost_cny,
    quality_scores: g.quality_scores,
    status: g.status,
    error: g.error,
    duration_sec: g.duration_sec_actual ?? g.duration_sec_requested,
    display_name: displayName,
  };
}

/**
 * 2026-05-20: 收集 shot 中所有 generation 的 asset key 用于批量 listAssetMeta.
 * key 来源 = generation_id / vault_id / asset_id (三层都查, 任一命中胜出).
 */
export function collectGenerationAssetKeys(generations: ShotGeneration[]): string[] {
  const keys = new Set<string>();
  for (const g of generations) {
    if (g.generation_id) keys.add(g.generation_id);
    if (g.vault_id) keys.add(g.vault_id);
    if (g.asset_id) keys.add(g.asset_id);
  }
  return [...keys];
}

export type ScopedShot = ShotData & { locator: { slug: string; epId: string; shotId: string } };

export async function readScopedShot(slug: string, epId: string, shotId: string): Promise<ScopedShot | null> {
  const shot = await readShot(slug, epId, shotId);
  if (!shot) return null;
  return { ...shot, locator: { slug, epId, shotId } };
}

export type FlatShotLocator = { slug: string; epId: string; shotId: string };

function pickCtx(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * 2026-07-22 X3-3 (A3-4): 扁平 `/shots/:sid/*` 路由的**安全**定位, 替代裸 locateShotById.
 *
 * 背景: LLM 拆分镜写的 `s%04d` id 跨集/跨系列不唯一, 裸 locateShotById 历史上"取第一个命中"
 * → 付费视频/导入/预览可能打到**错分镜**(错扣费、候选落错镜). 参照 failures.ts:73 已修模式.
 *
 * 定位优先级:
 *  1. 请求带 slug+epId 上下文 (query 或 body 任一) → 显式 readShot 精确定位(不再全盘扫)
 *  2. 无上下文 → locateShotById (命中缓存/唯一命中的快路径; 它对 >1 命中已返 null)
 *  3. locateShotById 返 null → locateShotMatches 判因: 0 命中→404 / >1 命中→**409 toC**
 *     (文案不暴露 ULID/hash, 引导"从分镜板进入")
 *
 * 命中返 locator; 未命中/歧义时**已写好 res 响应**, caller 直接 `return;` 即可.
 */
export async function resolveFlatShotLocatorOrErr(
  req: Request,
  res: Response,
  sid: string,
): Promise<FlatShotLocator | null> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const ctxSlug = pickCtx(req.query.slug) ?? pickCtx(body.slug);
  const ctxEpId = pickCtx(req.query.epId) ?? pickCtx(body.epId);
  if (ctxSlug && ctxEpId) {
    const shot = await readShot(ctxSlug, ctxEpId, sid);
    if (!shot) {
      err(res, 404, "NotFound", `shot ${sid} 未找到`);
      return null;
    }
    return { slug: ctxSlug, epId: ctxEpId, shotId: shot.id };
  }
  const loc = await locateShotById(sid);
  if (loc) return loc;
  // locateShotById 对歧义(>1 命中)与未找到都返 null — 这里补一次全扫判因, 给 409 而非笼统 404.
  const matches = await locateShotMatches(sid);
  if (matches.length > 1) {
    err(
      res,
      409,
      "ShotIdAmbiguous",
      "这个分镜编号在多个剧集里都存在，无法确定要操作哪一个。请从分镜板进入该分镜后再操作。",
    );
    return null;
  }
  err(res, 404, "NotFound", `shot ${sid} 未找到`);
  return null;
}

export async function shotDetailDto(shot: ScopedShot) {
  const trashedIds = new Set((shot.trashed_generations ?? []).map((g) => g.generation_id));
  const activeGenerations = (shot.active_generations && shot.active_generations.length > 0)
    ? shot.active_generations
    : (shot.generations ?? []).filter((g) => !trashedIds.has(g.generation_id));
  // 2026-05-26 Codex P1-5 — shot 没存自己的 image/video_model_ref 时, fallback 到 series.defaults 默认模型.
  // 用户在新建系列时勾选的"默认图像模型"才能真的带进子页面, 不再只是装饰.
  const seriesDefaults = await readSeries(shot.locator.slug)
    .then((s) => (s?.defaults ?? {}) as Record<string, any>)
    .catch(() => ({} as Record<string, any>));
  const fallbackImageModel = shot.image_model_ref || seriesDefaults.default_image || seriesDefaults.image_provider_id || "";
  const fallbackVideoModel = shot.video_model_ref || seriesDefaults.default_video || seriesDefaults.video_provider_id || "";
  // 2026-05-20 display_name 体系统一: 批量预加载所有 generation 的 assetMeta
  const allGens = [...activeGenerations, ...(shot.trashed_generations ?? [])];
  const assetKeys = collectGenerationAssetKeys(allGens);
  const assetMetaMap = assetKeys.length > 0 ? await listAssetMeta(assetKeys) : new Map<string, { display_name?: string }>();
  // 2026-05-26 Codex P1-4 — 失败的 generation 不该算"候选"(无可点图). 之前 "候选数 +1 但顶部仍'等待挑首帧'" 就是这里
  // 把 status=failed 的也算进候选数. failed task 由前端独立 failedImageTasks 渲染 FailedTaskTile.
  const firstFrameCandidates = activeGenerations
    .filter((g) => g.type === "first_frame" && g.status !== "failed")
    .map((g) => toCandidate(shot.locator.slug, g, assetMetaMap));
  const videoCandidates = activeGenerations
    .filter((g) => g.type === "video" && g.status !== "failed")
    .map((g) => toCandidate(shot.locator.slug, g, assetMetaMap));
  const trashedCandidates = (shot.trashed_generations ?? []).map((g) => toCandidate(shot.locator.slug, g, assetMetaMap));
  return {
    sid: shot.id,
    slug: shot.locator.slug,
    ep_id: shot.locator.epId,
    title: shot.title ?? shot.scene_label ?? `分镜 ${shot.index}`,
    prompt: shot.prompt_img ?? "",
    motion_prompt: shot.prompt_vid ?? "",
    negative_prompt: shot.negative_prompt ?? "",
    params: {
      duration_sec: shot.duration_sec,
      shot_type: shot.shot_type ?? "",
      camera_movement: shot.camera_movement ?? "",
      style: shot.style ?? "",
      time_of_day: shot.time_of_day ?? "",
      lighting: shot.lighting ?? "",
      mood: shot.mood ?? "",
      video_mode: shot.video_mode ?? "i2v",
      // 2026-05-26 Codex P1-5 — shot 没存就读 series defaults, 让默认模型真带进单镜页
      image_model_ref: fallbackImageModel,
      video_model_ref: fallbackVideoModel,
    },
    action: shot.action ?? "",
    dialogue: shot.dialogue ?? "",
    voiceover: shot.voiceover ?? "",
    // 2026-05-21 Wave Y — 富文本节点透传前端 (前端优先用 nodes derive 含 @ 短格式给编辑器)
    action_nodes: shot.action_nodes,
    dialogue_nodes: shot.dialogue_nodes,
    voiceover_nodes: shot.voiceover_nodes,
    prompt_img_nodes: shot.prompt_img_nodes,
    prompt_vid_nodes: shot.prompt_vid_nodes,
    notes: shot.notes ?? "",
    scene_id: shot.scene_id ?? "",
    character_ids: shot.character_ids ?? [],
    element_ids: shot.element_ids ?? [],
    reference_asset_ids: shot.reference_asset_ids ?? [],
    reference_notes: shot.reference_notes ?? {},
    // 2026-05-19 Wave O Entity-first Case B: 单镜级 reference 图 override 透传给前端,
    // ReferenceOverridePanel 据此渲染当前选中的图 (没 override 字段也兼容旧数据)
    reference_overrides: shot.reference_overrides ?? [],
    keyframe_asset_id: shot.keyframe_asset_id ?? "",
    character_anchors: (shot.character_ids ?? []).map((id) => ({
      id, name: id, lora: "", weight: 0.85, photo: 1, kind: "character",
    })),
    status: shot.status,
    // 2026-05-28 audit P1 type-safety — ShotData 未声明 locked 字段, 走 unknown narrowing
    locked: !!(shot as unknown as { locked?: unknown }).locked,
    stage: 1,
    picked_first_frame_id: shot.picked_first_frame_generation_id ?? null,
    picked_video_id: shot.picked_video_generation_id ?? shot.picked_generation_id ?? null,
    frame_anchors: shot.frame_anchors ?? [],
    first_frame_candidates: firstFrameCandidates,
    video_candidates: videoCandidates,
    trashed_candidates: trashedCandidates,
    updated_at: new Date().toISOString(),
  };
}

export function findShotGeneration(
  shot: ShotData,
  generationId: string | undefined,
  type?: ShotGeneration["type"],
): ShotGeneration | null {
  const targetId = typeof generationId === "string" ? generationId.trim() : "";
  if (!targetId) return null;
  const seen = new Set<string>();
  const generations = [
    ...(shot.active_generations ?? []),
    ...(shot.generations ?? []),
    ...(shot.trashed_generations ?? []),
  ];
  for (const g of generations) {
    if (!g?.generation_id || seen.has(g.generation_id)) continue;
    seen.add(g.generation_id);
    if (g.generation_id !== targetId) continue;
    if (type && g.type !== type) return null;
    return g;
  }
  return null;
}

export function resolveFirstFrameOverrideFromInput(
  shot: ShotData,
  firstFrameId: unknown,
): string | undefined {
  const raw = typeof firstFrameId === "string" ? firstFrameId.trim() : "";
  if (!raw) return undefined;
  const generation = findShotGeneration(shot, raw, "first_frame");
  return generation?.vault_id ?? generation?.asset_id ?? raw;
}

export async function resolveShotGenerationFilePath(
  slug: string,
  generation: ShotGeneration,
): Promise<string> {
  const candidates = [
    generation.vault_id,
    generation.asset_id,
    generation.generation_id,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  for (const key of candidates) {
    const vaultEntry = await getVaultEntry(key).catch(() => null);
    if (vaultEntry) {
      const abs = getVaultAbsolutePath(vaultEntry);
      await fs.access(abs);
      return abs;
    }
  }

  if (generation.asset_id) {
    const asset = await readAsset(slug, generation.asset_id).catch(() => null);
    const abs = asset ? resolveAssetFilePath(slug, asset.path) : null;
    if (abs) {
      await fs.access(abs);
      return abs;
    }
  }

  if (generation.path) {
    const abs = resolveAssetFilePath(slug, generation.path);
    if (abs) {
      await fs.access(abs);
      return abs;
    }
  }

  throw Object.assign(
    new Error("源视频文件不可读取,请确认这条候选视频仍在素材库中"),
    { status: 400, code: "source_video_missing" },
  );
}

function runFfmpegFirstFrame(inputPath: string, outputPath: string): Promise<void> {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const args = ["-y", "-ss", "0.05", "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg 抽帧失败 (exit ${code}): ${stderr.slice(-800)}`));
    });
  });
}

/**
 * 2026-05-20 Wave T hotfix — 清理 >24h 的视频抽帧 jpg,防磁盘泄漏.
 *
 * 用户反复"用此视频微调"会留每次 ~几百 KB 的 jpg,十几次就 MB 级垃圾.
 * 选择在抽帧前清理而非 finally 清理:
 *   - 抽帧后这张 jpg 还要作为 reference 给 orchestrator → provider,caller 链长不好 finally
 *   - 24h 后多半已不再用(用户当天生成 + 当天确认 / 删除)
 * 失败不阻断主路径(忽略 unlink error)
 */
async function cleanupOldVideoRegenRefs(outDir: string, maxAgeMs = 24 * 3600 * 1000): Promise<void> {
  try {
    const entries = await fs.readdir(outDir).catch(() => []);
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(entries.map(async (name) => {
      if (!name.endsWith(".jpg")) return;
      const full = path.join(outDir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < cutoff) await fs.unlink(full);
      } catch {
        // ignore — 不阻断
      }
    }));
  } catch {
    // 整个清理失败也不阻断
  }
}

export async function extractSourceVideoFirstFrameForRegen(
  slug: string,
  sid: string,
  shot: ShotData,
  sourceVideoGenerationId: unknown,
): Promise<string | undefined> {
  const sourceId = typeof sourceVideoGenerationId === "string" ? sourceVideoGenerationId.trim() : "";
  if (!sourceId) return undefined;
  const generation = findShotGeneration(shot, sourceId, "video");
  if (!generation) {
    throw Object.assign(new Error("源视频候选不存在,请刷新页面后再试"), {
      status: 400,
      code: "source_video_not_found",
    });
  }
  if (generation.status !== "done") {
    throw Object.assign(new Error("源视频还没有生成完成,暂不能用于微调重抽"), {
      status: 400,
      code: "source_video_not_ready",
    });
  }
  const inputPath = await resolveShotGenerationFilePath(slug, generation);
  const outDir = path.join(DATA_ROOT, "tmp", "video-regen-refs");
  await fs.mkdir(outDir, { recursive: true });
  // 2026-05-20 Wave T hotfix — 抽帧前清掉 >24h 的旧 jpg
  await cleanupOldVideoRegenRefs(outDir);
  const safeSource = sourceId.replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 48) || "source";
  const outputPath = path.join(outDir, `${sid}_${safeSource}_${Date.now()}.jpg`);
  await runFfmpegFirstFrame(inputPath, outputPath);
  await fs.access(outputPath);
  return outputPath;
}

export function ensureSourceVideoUsable(
  res: Response,
  shot: ShotData,
  sourceVideoGenerationId: unknown,
): boolean {
  const sourceId = typeof sourceVideoGenerationId === "string" ? sourceVideoGenerationId.trim() : "";
  if (!sourceId) return true;
  const generation = findShotGeneration(shot, sourceId, "video");
  if (!generation) {
    err(res, 400, "source_video_not_found", "源视频候选不存在,请刷新页面后再试");
    return false;
  }
  if (generation.status !== "done") {
    err(res, 400, "source_video_not_ready", "源视频还没有生成完成,暂不能用于微调重抽");
    return false;
  }
  return true;
}

// Re-export commonly imported items so child files don't need long relative paths.
export type { ShotGeneration, ShotData };
export { readScene, readCharacter };
