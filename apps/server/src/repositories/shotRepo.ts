import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { pathExists, readJson, writeJson, ensureDir } from "../../../../packages/core/src/index";
import { loggerSync } from "../../../../packages/core/src/logger";
import type { FrameAnchor, ShotData, ShotGeneration, ShotFailure, PromptVersion } from "../../../../packages/drama/src/types";
import {
  SERIES_ROOT,
  TRASH_ROOT,
  episodeDir,
  shotFile,
  shotsDir,
} from "./_paths";

// ─── File-level write Mutex (pure JS, no npm dep) ─────────────

const _writeLocks = new Map<string, Promise<void>>();

/**
 * Serialize read-modify-write operations per entity file.
 * Prevents lost-update race conditions on updateShot/Episode/Character/Scene/Series/Trash.
 * Uses Map<path, Promise> chain — each new call waits for the previous lock on the same file.
 */
function withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = _writeLocks.get(filePath) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>(r => { release = r; });
  _writeLocks.set(filePath, next);
  return prev
    .then(() => fn())
    .finally(() => release!());
}

// ─── Helpers ────────────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID();
}

function nowISO(): string {
  return new Date().toISOString();
}

// ─── Prompt Version Management ──────────────────────────────────

// Step2: PromptVersion / ShotData / ShotGeneration 单源化到 packages/drama/src/types.ts。
// re-export 保持下游 import 不破。
export type { PromptVersion, ShotData, ShotGeneration };

/**
 * Append a new version to existing prompt versions array.
 * Skips if the latest version has the same content (dedup).
 * Returns a new array (immutable style).
 */
export function appendPromptVersion(
  existing: PromptVersion[] | undefined,
  content: string,
  created_by: "ai" | "user"
): PromptVersion[] {
  const versions = existing ?? [];
  const latest = versions.length > 0 ? versions[versions.length - 1] : null;
  if (latest && latest.content === content) return versions;
  return [
    ...versions,
    {
      version: versions.length + 1,
      content,
      created_at: nowISO(),
      created_by,
    },
  ];
}

// ─── Shot CRUD ──────────────────────────────────────────────────
// Step2: ShotData / ShotGeneration 定义已移至 packages/drama/src/types.ts (见上方 re-export)。

export async function addShot(slug: string, epId: string, data: {
  title?: string; action?: string; prompt_img?: string; prompt_vid?: string;
  video_mode?: "i2v" | "t2v"; duration_sec?: number; aspect_ratio?: string;
  shot_type?: string; camera_movement?: string; dialogue?: string;
  voiceover?: string; notes?: string; style?: string; time_of_day?: string; lighting?: string; mood?: string;
  emotion?: string; transition_in?: string;
  reference_asset_ids?: string[]; keyframe_asset_id?: string; image_model_ref?: string; video_model_ref?: string;
  character_ids?: string[]; scene_id?: string; element_ids?: string[]; index?: number;
  // 2026-05-21 Wave Y P6 — 用户手动新建分镜允许预填 nodes (例 ShotboardPage 粘贴富文本)
  action_nodes?: ShotData["action_nodes"];
  dialogue_nodes?: ShotData["dialogue_nodes"];
  voiceover_nodes?: ShotData["voiceover_nodes"];
  prompt_img_nodes?: ShotData["prompt_img_nodes"];
  prompt_vid_nodes?: ShotData["prompt_vid_nodes"];
}): Promise<ShotData> {
  const id = newId();
  const sf = shotFile(slug, epId, id);
  await ensureDir(shotsDir(slug, epId));

  return withWriteLock(sf, async () => {
    const existing = await listShots(slug, epId);
    const nextIndex = data.index ?? (existing.length > 0 ? Math.max(...existing.map(s => s.index)) + 1 : 1);

    const shot: ShotData = {
      id,
      series_slug: slug,
      episode_id: epId,
      index: nextIndex,
      duration_sec: data.duration_sec ?? 5,
      character_ids: data.character_ids ?? [],
      scene_id: data.scene_id,
      element_ids: data.element_ids ?? [],
      title: data.title,
      shot_type: data.shot_type,
      camera_movement: data.camera_movement,
      action: data.action,
      dialogue: data.dialogue,
      voiceover: data.voiceover,
      prompt_img: data.prompt_img,
      prompt_vid: data.prompt_vid,
      notes: data.notes,
      style: data.style,
      time_of_day: data.time_of_day,
      lighting: data.lighting,
      mood: data.mood,
      emotion: data.emotion,
      transition_in: data.transition_in,
      reference_asset_ids: data.reference_asset_ids ?? [],
      keyframe_asset_id: data.keyframe_asset_id,
      image_model_ref: data.image_model_ref,
      video_model_ref: data.video_model_ref,
      video_mode: data.video_mode ?? "i2v",
      aspect_ratio: data.aspect_ratio ?? "16:9",
      // 2026-05-21 Wave Y P6 — 节点真理源, caller 不传时由内容字段 derive (action="" → 空 nodes)
      action_nodes: data.action_nodes ?? (data.action ? [{ type: "text", text: data.action }] : []),
      dialogue_nodes: data.dialogue_nodes ?? (data.dialogue ? [{ type: "text", text: data.dialogue }] : []),
      voiceover_nodes: data.voiceover_nodes ?? (data.voiceover ? [{ type: "text", text: data.voiceover }] : []),
      prompt_img_nodes: data.prompt_img_nodes ?? (data.prompt_img ? [{ type: "text", text: data.prompt_img }] : []),
      prompt_vid_nodes: data.prompt_vid_nodes ?? (data.prompt_vid ? [{ type: "text", text: data.prompt_vid }] : []),
      status: "draft",
      generations: [],
      active_generations: [],
      trashed_generations: [],
    };

    await writeJson(sf, shot);
    return shot;
  });
}

// D-N1: 同上. 单集 shot 通常 12-50 个, 1000 上限远超场景.
export async function listShots(
  slug: string,
  epId: string,
  opts?: { limit?: number; offset?: number },
): Promise<ShotData[]> {
  const sd = shotsDir(slug, epId);
  if (!(await pathExists(sd))) return [];
  const entries = await fs.readdir(sd);
  const results: ShotData[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const item = await readJson<ShotData>(path.join(sd, entry));
      if (item) results.push({ ...item, element_ids: item.element_ids ?? [] });
    } catch { /* skip */ }
  }
  const sorted = results.sort((a, b) => a.index - b.index);
  const offset = Math.max(0, opts?.offset ?? 0);
  const limit = Math.max(1, Math.min(opts?.limit ?? 1000, 1000));
  return sorted.slice(offset, offset + limit);
}

/**
 * 2026-05-20 display_name 体系统一: 读时把老数据 user_label 兜底映射为 display_name.
 * 写时只写 display_name (renameGenerationLabel 已统一), 老 JSON 不动, 下次写时被冲掉.
 */
function migrateGenerationUserLabel<T extends { display_name?: string; user_label?: string }>(g: T): T {
  if (g.display_name) return g;
  if (g.user_label) return { ...g, display_name: g.user_label };
  return g;
}

export async function readShot(slug: string, epId: string, shotId: string): Promise<ShotData | null> {
  const sf = shotFile(slug, epId, shotId);
  if (!(await pathExists(sf))) return null;
  const shot = await readJson<ShotData>(sf);
  if (!shot) return null;
  // 2026-05-20: backward-compat — old data 字段映射
  return {
    ...shot,
    element_ids: shot.element_ids ?? [],
    generations: shot.generations?.map(migrateGenerationUserLabel),
    active_generations: shot.active_generations?.map(migrateGenerationUserLabel),
    trashed_generations: shot.trashed_generations?.map(migrateGenerationUserLabel),
  };
}

export async function updateShot(slug: string, epId: string, shotId: string, patch: Partial<ShotData>): Promise<ShotData | null> {
  return withWriteLock(shotFile(slug, epId, shotId), async () => {
    const existing = await readShot(slug, epId, shotId);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id: existing.id, series_slug: existing.series_slug, episode_id: existing.episode_id };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return updated;
  });
}

/**
 * 2026-07-09 audit C10/C11 — 原子追加一条 generation.
 *
 * 旧代码在 adapter 里 readShot(锁外) → 拼 [...generations, gen] → updateShot(patch):
 * 同镜两个并发落盘(新旧管线 / 用户重抽 / count_per_shot≥2)各自锁外读到同一基线
 * generations=[g0], 各自拼 [g0,gX] 再 updateShot 写盘 → 后写覆盖先写 → 丢候选图,
 * 且丢的那张已真实生成并扣费. 这里把 read+append+write 收进同一把 withWriteLock,
 * 锁内重读当前 generations 再 append, 保证并发不丢.
 *
 * opts.extraPatch: 附带写入的标量字段 (last_frame_vault_id / first_frame_from_prev /
 *   picked_first_frame_generation_id 等), 不覆盖 generations/active_generations.
 * opts.status: 落盘状态 (通常 "generated").
 * shot 不存在返回 null (caller 负责 404, 不 silent fallback).
 */
export async function appendGeneration(
  slug: string,
  epId: string,
  shotId: string,
  generation: ShotGeneration,
  opts?: { status?: ShotData["status"]; extraPatch?: Partial<ShotData> },
): Promise<ShotData | null> {
  return withWriteLock(shotFile(slug, epId, shotId), async () => {
    const existing = await readShot(slug, epId, shotId);
    if (!existing) return null;
    const generations = [...(existing.generations ?? []), generation];
    const active_generations = [
      ...(existing.active_generations ?? existing.generations ?? []),
      generation,
    ];
    const updated: ShotData = {
      ...existing,
      ...(opts?.extraPatch ?? {}),
      generations,
      active_generations,
      ...(opts?.status !== undefined ? { status: opts.status } : {}),
      id: existing.id,
      series_slug: existing.series_slug,
      episode_id: existing.episode_id,
    };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return updated;
  });
}

/**
 * 2026-07-09 audit C11 — 原子追加一条"失败" generation 记录 + failure + 置 status:failed.
 *
 * 与 appendGeneration 的区别: 失败 generation 只进 generations, 不进 active_generations
 * (S7 语义: active_generations 只含 queued/running/done 候选; 消费方 shotController /
 * shared / episodeController 把 active_generations 直接当可选候选列表, 不做 status!==failed
 * 过滤 → 失败记录若混入 active 会被当成可选候选图显示).
 *
 * 修复: orchestrator 失败分支原来 readShot(锁外) → updateShot(绝对 generations 数组) 在同镜
 * 并发(count_per_shot≥2: 某 runner 失败落盘时, 另一 runner 的成功候选刚经 appendGeneration
 * 原子 append)会读到旧基线再整段覆盖, 把已扣费的成功候选图冲掉. 这里把 read+append+write
 * 收进同一把 withWriteLock, 锁内重读当前数组再拼, 保证并发不丢. shot 不存在返回 null.
 */
export async function appendFailedGeneration(
  slug: string,
  epId: string,
  shotId: string,
  failedGeneration: ShotGeneration,
  failure: ShotFailure,
): Promise<ShotData | null> {
  return withWriteLock(shotFile(slug, epId, shotId), async () => {
    const existing = await readShot(slug, epId, shotId);
    if (!existing) return null;
    const updated: ShotData = {
      ...existing,
      generations: [...(existing.generations ?? []), failedGeneration],
      // active_generations 不动 (失败不入候选) — 走 merge 保留锁内最新值, 不覆盖
      failures: [...(existing.failures ?? []), failure],
      status: "failed",
      id: existing.id,
      series_slug: existing.series_slug,
      episode_id: existing.episode_id,
    };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return updated;
  });
}

/**
 * 2026-07-10 audit 补漏 — 原子挑选一条 generation 作为 picked 首帧/视频.
 *
 * 旧代码 (autoPickGenerations / shotController.pick) 锁外 readShot/listShots 取快照 →
 * map(shot.generations) 翻 picked 标志 → updateShot(patch 里带绝对 generations 数组).
 * updateShot 虽在锁内重读 existing, 但 {...existing, ...patch} 会用锁外算出的陈旧 generations
 * 整段覆盖锁内的 fresh generations: 若快照与写入之间有并发 appendGeneration 追加了已扣费候选,
 * 该候选被冲掉丢失. 这里把 read+flip+write 收进同一把 withWriteLock, 锁内重读当前 generations
 * 再翻 picked 标志, 保证并发不丢.
 *
 * 双写: picked 指针 (picked_first_frame_generation_id / picked_video_generation_id, 主真理源)
 * + 同类型候选的 generation.picked 标志 (legacy 冗余, 防老数据 picked 残留导致主/legacy 双事实矛盾).
 * kind 只翻同类型候选的 picked, 另一类型不动.
 * opts.status: 落盘状态; opts.extraPatch: 附带标量字段 (picked_generation_id 等), 不覆盖 generations.
 * 目标候选不在 generations 内 (并发被删/陈旧 id) 返回 { ok:false }; shot 不存在返回 { ok:false }.
 */
export async function pickGeneration(
  slug: string,
  epId: string,
  shotId: string,
  generationId: string,
  kind: "first_frame" | "video",
  opts?: { status?: ShotData["status"]; extraPatch?: Partial<ShotData> },
): Promise<{ ok: boolean; shot?: ShotData; reason?: string }> {
  return withWriteLock(shotFile(slug, epId, shotId), async (): Promise<{ ok: boolean; shot?: ShotData; reason?: string }> => {
    const existing = await readShot(slug, epId, shotId);
    if (!existing) return { ok: false };
    const generations = existing.generations ?? [];
    // 2026-07-10 Fable P1-5 — 拒绝挑选已废弃的候选: 废案是用户品味的负向表达(与 picked 同级决策数据),
    // 挑回废案 = 推翻用户显式否决。任何 caller 传废案 id 都应被拒, 而非静默选回。
    const trashedIds = new Set((existing.trashed_generations ?? []).map((g) => g.generation_id));
    if (trashedIds.has(generationId)) return { ok: false, reason: "trashed" };
    if (!generations.some((g) => g.generation_id === generationId && g.type === kind)) {
      return { ok: false };
    }
    const nextGenerations = generations.map((g) => ({
      ...g,
      picked:
        g.generation_id === generationId && g.type === kind
          ? true
          : g.type === kind
            ? false
            : g.picked,
    }));
    const base: ShotData = {
      ...existing,
      ...(opts?.extraPatch ?? {}),
      generations: nextGenerations,
      ...(opts?.status !== undefined ? { status: opts.status } : {}),
      id: existing.id,
      series_slug: existing.series_slug,
      episode_id: existing.episode_id,
    };
    const updated: ShotData = kind === "first_frame"
      ? { ...base, picked_first_frame_generation_id: generationId }
      : { ...base, picked_video_generation_id: generationId };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return { ok: true, shot: updated };
  });
}

/**
 * 2026-07-10 audit 补漏 — 原子从 active/trashed 池移除一条 generation (reject-pool promote 用).
 * 锁内重读再移除, 防同镜并发 appendGeneration 追加的已扣费候选被锁外陈旧快照绝对覆盖冲掉.
 * vault tag 等外部副作用由 caller 在锁外先做完, 这里只做 shot generations 的原子 read-modify-write.
 */
export async function removeGenerationFromPools(
  slug: string,
  epId: string,
  shotId: string,
  generationId: string,
): Promise<{ ok: boolean; shot?: ShotData }> {
  return withWriteLock(shotFile(slug, epId, shotId), async (): Promise<{ ok: boolean; shot?: ShotData }> => {
    const existing = await readShot(slug, epId, shotId);
    if (!existing) return { ok: false };
    const trashedBase = existing.trashed_generations ?? [];
    const trashedIds = new Set(trashedBase.map((g) => g.generation_id));
    const activeSource = existing.active_generations ?? (existing.generations ?? []).filter((g) => !trashedIds.has(g.generation_id));
    const activeGenerations = activeSource.filter((g) => g.generation_id !== generationId);
    const trashedGenerations = trashedBase.filter((g) => g.generation_id !== generationId);
    const updated: ShotData = {
      ...existing,
      active_generations: activeGenerations,
      trashed_generations: trashedGenerations,
      generations: [...activeGenerations, ...trashedGenerations],
    };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return { ok: true, shot: updated };
  });
}

// ─── Wave 1C: Trash Management Helpers ──────────────────────────
// D7: 废案箱操作包进 Mutex，保证 read-modify-write 原子

/** 将指定 generation 从 active 移入 trashed */
export async function moveGenerationToTrash(
  slug: string, epId: string, shotId: string, genId: string,
): Promise<{ ok: boolean; shot?: ShotData }> {
  return withWriteLock(shotFile(slug, epId, shotId), async (): Promise<{ ok: boolean; shot?: ShotData }> => {
    const shot = await readShot(slug, epId, shotId);
    if (!shot) return { ok: false };

    const allGens = shot.generations ?? [];
    const active = shot.active_generations ?? allGens;
    const trashed = shot.trashed_generations ?? [];

    const idx = active.findIndex(g => g.generation_id === genId);
    if (idx === -1) return { ok: false };

    const [moved] = active.splice(idx, 1);
    trashed.push({ ...moved, picked: false });

    const patch: Partial<ShotData> = {
      active_generations: active,
      trashed_generations: trashed,
      generations: [...active, ...trashed],
    };
    // 2026-07-10 Fable P1-3 — 废弃的若正是当前 picked, 同步清指针 + 降 status, 防"状态撒谎":
    // 悬空 picked + status=approved 会让合成页显示"就绪", 合成时才爆灰屏占位 (公理 B: 状态在变更点维护).
    if (shot.picked_video_generation_id === genId) {
      patch.picked_video_generation_id = undefined;
      if (shot.status === "approved") patch.status = shot.picked_first_frame_generation_id ? "picked" : "generating";
    }
    if (shot.picked_first_frame_generation_id === genId) {
      patch.picked_first_frame_generation_id = undefined;
      // 2026-07-10 Fable 二轮验收 P1-3 — 只有连视频也没选时才降"未就绪"; 视频已选(approved 蕴含
      // picked_video)的镜首帧被废不该被误标未就绪(视频是最终产物, 首帧只是它的输入).
      if (!shot.picked_video_generation_id && (shot.status === "approved" || shot.status === "picked")) patch.status = "generating";
    }
    if (shot.picked_generation_id === genId) patch.picked_generation_id = undefined; // legacy 冗余指针
    // 帧锚点若引用该 generation 也失效 (dispatch 的 firstFrame 锚定 / prompt 编译 has_first_frame_ref 读它)
    if (shot.frame_anchors?.some((a) => a.generation_id === genId)) {
      patch.frame_anchors = shot.frame_anchors.filter((a) => a.generation_id !== genId);
    }
    const updated = { ...shot, ...patch, id: shot.id, series_slug: shot.series_slug, episode_id: shot.episode_id };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return { ok: true, shot: updated };
  });
}

/**
 * 2026-05-17: 给指定 generation 改用户自定义名 (inline rename).
 * label 为空串或 undefined 视为清除回默认 provider 名.
 * 同时更新 generations / active_generations / trashed_generations 三个数组里的同 id 项.
 */
export async function renameGenerationLabel(
  slug: string, epId: string, shotId: string, genId: string, label?: string,
): Promise<{ ok: boolean; shot?: ShotData }> {
  return withWriteLock(shotFile(slug, epId, shotId), async (): Promise<{ ok: boolean; shot?: ShotData }> => {
    const shot = await readShot(slug, epId, shotId);
    if (!shot) return { ok: false };

    const cleanLabel = typeof label === "string" ? label.trim().slice(0, 60) : "";

    const patchGen = <T extends { generation_id: string }>(arr: T[] | undefined): T[] | undefined => {
      if (!arr) return arr;
      return arr.map(g => g.generation_id === genId
        // 2026-05-20: 统一写 display_name; 老字段 user_label 清掉避免读时优先级混淆.
        ? ({ ...g, display_name: cleanLabel || undefined, user_label: undefined })
        : g);
    };

    const patch: Partial<ShotData> = {
      generations: patchGen(shot.generations),
      active_generations: patchGen(shot.active_generations),
      trashed_generations: patchGen(shot.trashed_generations),
    };
    const updated = { ...shot, ...patch, id: shot.id, series_slug: shot.series_slug, episode_id: shot.episode_id };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return { ok: true, shot: updated };
  });
}

/** 从废案箱恢复 generation 到 active */
export async function restoreGenerationFromTrash(
  slug: string, epId: string, shotId: string, genId: string,
): Promise<{ ok: boolean; shot?: ShotData }> {
  return withWriteLock(shotFile(slug, epId, shotId), async (): Promise<{ ok: boolean; shot?: ShotData }> => {
    const shot = await readShot(slug, epId, shotId);
    if (!shot) return { ok: false };

    const trashed = shot.trashed_generations ?? [];
    const active = shot.active_generations ?? (shot.generations ?? []);

    const idx = trashed.findIndex(g => g.generation_id === genId);
    if (idx === -1) return { ok: false };

    const [restored] = trashed.splice(idx, 1);
    active.push(restored);

    const patch: Partial<ShotData> = {
      active_generations: active,
      trashed_generations: trashed,
      generations: [...active, ...trashed],
    };
    const updated = { ...shot, ...patch, id: shot.id, series_slug: shot.series_slug, episode_id: shot.episode_id };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return { ok: true, shot: updated };
  });
}

/** 从废案箱永久删除 generation */
export async function permanentlyDeleteGeneration(
  slug: string, epId: string, shotId: string, genId: string,
): Promise<{ ok: boolean; shot?: ShotData }> {
  return withWriteLock(shotFile(slug, epId, shotId), async (): Promise<{ ok: boolean; shot?: ShotData }> => {
    const shot = await readShot(slug, epId, shotId);
    if (!shot) return { ok: false };

    const trashed = shot.trashed_generations ?? [];
    const filtered = trashed.filter(g => g.generation_id !== genId);
    if (filtered.length === trashed.length) return { ok: false };

    const active = shot.active_generations ?? (shot.generations ?? []).filter(g => !trashed.some(t => t.generation_id === g.generation_id));

    const patch: Partial<ShotData> = {
      active_generations: active,
      trashed_generations: filtered,
      generations: [...active, ...filtered],
    };
    // 2026-07-10 Fable P1-3 兄弟点 — 永久删除若命中悬空 picked 指针(老数据残留), 一并清, 防状态撒谎.
    if (shot.picked_video_generation_id === genId) patch.picked_video_generation_id = undefined;
    if (shot.picked_first_frame_generation_id === genId) patch.picked_first_frame_generation_id = undefined;
    if (shot.picked_generation_id === genId) patch.picked_generation_id = undefined;
    const updated = { ...shot, ...patch, id: shot.id, series_slug: shot.series_slug, episode_id: shot.episode_id };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return { ok: true, shot: updated };
  });
}

export async function setFrameAnchor(
  slug: string,
  epId: string,
  shotId: string,
  input: {
    role: "first" | "end" | "key";
    position?: number;
    vault_id?: string;
    asset_id?: string;
    generation_id?: string;
  },
): Promise<{ ok: boolean; shot?: ShotData }> {
  return withWriteLock(shotFile(slug, epId, shotId), async (): Promise<{ ok: boolean; shot?: ShotData }> => {
    const shot = await readShot(slug, epId, shotId);
    if (!shot) return { ok: false };

    const position = input.role === "first"
      ? 0
      : input.role === "end"
        ? 1
        : Math.max(0, Math.min(1, typeof input.position === "number" ? input.position : 0.5));
    const anchor: FrameAnchor = {
      id: newId(),
      role: input.role,
      position,
      created_at: nowISO(),
      ...(input.vault_id !== undefined ? { vault_id: input.vault_id } : {}),
      ...(input.asset_id !== undefined ? { asset_id: input.asset_id } : {}),
      ...(input.generation_id !== undefined ? { generation_id: input.generation_id } : {}),
    };

    const current = shot.frame_anchors ?? [];
    const frameAnchors = input.role === "key"
      ? [...current, anchor]
      : [...current.filter((a) => a.role !== input.role), anchor];
    const patch: Partial<ShotData> = { frame_anchors: frameAnchors };
    if (input.role === "first" && input.generation_id) {
      patch.picked_first_frame_generation_id = input.generation_id;
    }
    if (input.role === "end" && input.vault_id) {
      patch.last_frame_vault_id = input.vault_id;
    }

    const updated = { ...shot, ...patch, id: shot.id, series_slug: shot.series_slug, episode_id: shot.episode_id };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return { ok: true, shot: updated };
  });
}

/**
 * W7-stage-reorg (2026-05-16): 批量重排关键帧锚点顺序
 *
 * 只动 role === "key" 的锚点,接收的 order 是 anchor_id 数组(新顺序)。
 * 其它锚点(first / end)位置不动,继续按 0 / 1 排。
 *
 * 实现策略:重新分配 key 锚点的 position 值,均匀分布在 0.1..0.9 之间
 * (避开 first=0 / end=1 边界),按 order 顺序排列。
 */
export async function reorderFrameAnchors(
  slug: string,
  epId: string,
  shotId: string,
  order: string[],
): Promise<{ ok: boolean; shot?: ShotData }> {
  return withWriteLock(shotFile(slug, epId, shotId), async (): Promise<{ ok: boolean; shot?: ShotData }> => {
    const shot = await readShot(slug, epId, shotId);
    if (!shot) return { ok: false };

    const current = shot.frame_anchors ?? [];
    const keyAnchors = current.filter((a) => a.role === "key");
    const otherAnchors = current.filter((a) => a.role !== "key");

    // 把 order 数组里的 id 映射回 anchor 对象, 未匹配的 id 忽略
    const keyMap = new Map(keyAnchors.map((a) => [a.id, a]));
    const reordered: FrameAnchor[] = [];
    for (const id of order) {
      const anchor = keyMap.get(id);
      if (anchor) {
        reordered.push(anchor);
        keyMap.delete(id);
      }
    }
    // 漏掉的 key anchor(order 没传)追加在尾部, 不丢数据
    for (const anchor of keyMap.values()) reordered.push(anchor);

    // 重新分配 position: 均匀分布在 0.1..0.9 之间
    const n = reordered.length;
    const repositioned = reordered.map((a, i) => {
      const pos = n === 1 ? 0.5 : 0.1 + (0.8 * i) / (n - 1);
      return { ...a, position: Math.round(pos * 1000) / 1000 };
    });

    const updated: ShotData = {
      ...shot,
      frame_anchors: [...otherAnchors, ...repositioned],
      id: shot.id,
      series_slug: shot.series_slug,
      episode_id: shot.episode_id,
    };
    await writeJson(shotFile(slug, epId, shotId), updated);
    return { ok: true, shot: updated };
  });
}

export async function removeFrameAnchor(
  slug: string,
  epId: string,
  shotId: string,
  anchorId: string,
): Promise<{ ok: boolean; shot?: ShotData }> {
  return withWriteLock(shotFile(slug, epId, shotId), async (): Promise<{ ok: boolean; shot?: ShotData }> => {
    const shot = await readShot(slug, epId, shotId);
    if (!shot) return { ok: false };

    const current = shot.frame_anchors ?? [];
    const removed = current.find((a) => a.id === anchorId);
    if (!removed) return { ok: false };

    const updated: ShotData = {
      ...shot,
      frame_anchors: current.filter((a) => a.id !== anchorId),
      id: shot.id,
      series_slug: shot.series_slug,
      episode_id: shot.episode_id,
    };
    if (removed.role === "first") {
      updated.picked_first_frame_generation_id = null;
    } else if (removed.role === "end") {
      delete updated.last_frame_vault_id;
    }

    await writeJson(shotFile(slug, epId, shotId), updated);
    return { ok: true, shot: updated };
  });
}

// ─── U8: Shot Deletion (soft-delete) ───────────────────────────

export async function trashShot(slug: string, epId: string, shotId: string): Promise<{ ok: boolean }> {
  const shot = await readShot(slug, epId, shotId);
  if (!shot) return { ok: false };

  // Soft-delete: move shot file to data/_trash/<slug>/<epId>/
  try {
    const trashDir = path.join(TRASH_ROOT, slug, epId);
    await fs.mkdir(trashDir, { recursive: true });
    const srcPath = shotFile(slug, epId, shotId);
    const trashTs = Date.now();
    const dstPath = path.join(trashDir, `${shotId}_${trashTs}.json`);
    // 写入 trashed_at 元信息再搬移，方便垃圾桶列表读取
    const trashedShot = { ...shot, trashed_at: new Date(trashTs).toISOString() };
    await writeJson(srcPath, trashedShot);
    await fs.rename(srcPath, dstPath);
    // 2026-07-22 X3-3 (A3-5): shot 文件已挪出 shots/ 目录 → 清 locator 缓存, 防旧 locator 残留.
    invalidateShotLocator(shotId);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * 2026-07-10 Fable P0-1 — 重拆/重导分镜前, 把该集旧 shot 文件"整批移入垃圾桶"(而非 fs.rm 硬删).
 *
 * 背景: 旧代码硬删旧 s000N.json 只为保证 listShots 干净(防幽灵镜重复扣费), 却连带毁掉用户
 * 几天 + 几百块 API 费做出的挑选劳动(picked 指针 / trim / 帧锚点 / 候选命名 / generation↔asset
 * 关联). 正确原语是"挪出 shots/ 目录"(垃圾桶语义): listShots 不变仍防幽灵镜, 旧分镜成套可恢复.
 *
 * 与 trashShot 同款落盘格式: TRASH_ROOT/<slug>/<epId>/<shotId>_<ts>.json + trashed_at 字段;
 * 额外记 trashed_batch_id, 让"分镜版本回滚"能按批次整套搬回.
 *
 * - shotId = 文件名去掉 .json(plan 路径 s0001 / import 路径 s0001_ab12 都原样保留, 与内部 id 一致).
 * - 每个文件的搬移走 withWriteLock(与 appendGeneration/pickGeneration 同锁 key): 上一轮 inflight
 *   回写若与重拆并发, 谁先拿锁谁先落盘, 不丢已扣费候选, 也不重建幽灵文件.
 * - 只 readJson 一次, 不走 readShot 全套(migration/pathExists), 性能友好.
 * - 单文件搬移异常兜底: 先尝试 rename 保命, 再不行才硬删(保证 listShots 干净不复活幽灵镜).
 *
 * @returns { batch_id, moved } — 批次 id + 被移走的 shotId 列表
 */
export async function trashEpisodeShotFiles(
  slug: string, epId: string,
): Promise<{ batch_id: string; moved: string[] }> {
  const dir = shotsDir(slug, epId);
  const batchTs = Date.now();
  const batchId = `sbtrash_${batchTs.toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const trashedAt = new Date(batchTs).toISOString();
  const trashDir = path.join(TRASH_ROOT, slug, epId);
  const moved: string[] = [];

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    // 目录不存在(首次拆分) — 无旧文件可搬
    return { batch_id: batchId, moved };
  }

  let trashDirEnsured = false;
  const ensureTrashDir = async () => {
    if (!trashDirEnsured) { await fs.mkdir(trashDir, { recursive: true }); trashDirEnsured = true; }
  };

  for (const file of files) {
    // 兼容 plan 的 s0001.json 与 import 的 s0001_xxxx.json(跨路径残留一并搬走), 忽略其它文件
    if (!/^s\d{4}(_[0-9a-z]+)?\.json$/i.test(file)) continue;
    const shotId = file.slice(0, -".json".length);
    const srcPath = path.join(dir, file);
    const dstPath = path.join(trashDir, `${shotId}_${batchTs}.json`);
    await withWriteLock(srcPath, async () => {
      try {
        await ensureTrashDir();
        const shot = await readJson<ShotData & { trashed_at?: string; trashed_batch_id?: string }>(srcPath).catch(() => null);
        if (shot) {
          await writeJson(dstPath, { ...shot, trashed_at: trashedAt, trashed_batch_id: batchId });
          await fs.rm(srcPath, { force: true });
        } else {
          // 读不出内容(损坏/空) — 直接搬文件, 时间戳由文件名兜底
          await fs.rename(srcPath, dstPath);
        }
        moved.push(shotId);
      } catch (e) {
        loggerSync().warn(`[trashEpisodeShotFiles] ${slug}/${epId}/${file} 移入垃圾桶失败:`, e);
        // 最后手段: 先试 rename 保命, 再不行才硬删(宁保 listShots 干净, 防幽灵镜重复扣费)
        try { await fs.rename(srcPath, dstPath); moved.push(shotId); }
        catch { await fs.rm(srcPath, { force: true }).catch(() => {}); }
      }
    });
  }

  // 2026-07-22 X3-3 (A3-5): 重拆/重导把整批旧分镜挪出 shots/ → 逐个清 locator 缓存,
  // 防"跨系列同号 s000N 谁赢首次扫描"被旧结果锁死 5 分钟(与 A3-4 治本叠加).
  for (const sid of moved) invalidateShotLocator(sid);

  return { batch_id: batchId, moved };
}

/** 从垃圾桶恢复分镜 — 找到 data/_trash/<slug>/<epId>/<shotId>_<ts>.json 并移回 shots/ */
export async function restoreTrashedShot(
  slug: string, epId: string, shotId: string
): Promise<{ ok: boolean; shot?: ShotData; reason?: "not_found" | "conflict" }> {
  const trashDir = path.join(TRASH_ROOT, slug, epId);
  try {
    if (!(await pathExists(trashDir))) return { ok: false, reason: "not_found" };
    const files = await fs.readdir(trashDir);
    // 精确匹配 `${shotId}_<纯数字时间戳>.json`(避免 "s0001" 误匹配 import 的 "s0001_ab12_<ts>.json").
    const prefix = `${shotId}_`;
    const matches = files.filter((f) => {
      if (!f.startsWith(prefix) || !f.endsWith(".json")) return false;
      return /^\d+$/.test(f.slice(prefix.length, -".json".length));
    });
    if (matches.length === 0) return { ok: false, reason: "not_found" };
    // 同一 shotId 可能有多批(多次重拆) — 取时间戳最大的那批(最近一次移入)恢复.
    matches.sort((a, b) => Number(a.slice(prefix.length, -".json".length)) - Number(b.slice(prefix.length, -".json".length)));
    const match = matches[matches.length - 1];
    const srcPath = path.join(trashDir, match);
    const shot = await readJson<ShotData & { trashed_at?: string; trashed_batch_id?: string }>(srcPath);
    if (!shot) return { ok: false, reason: "not_found" };
    await ensureDir(shotsDir(slug, epId));
    const dstPath = shotFile(slug, epId, shotId);
    // 2026-07-10 Fable P0-1 — 冲突检查: 当前这一集若已有同编号在用分镜(重拆后新生成的 s000N),
    // 直接 writeJson 会静默覆盖新分镜, 连带毁掉它的挑选/生成 → 绝不覆盖, 明确报错让上层引导用户先处理.
    if (await pathExists(dstPath)) {
      return { ok: false, reason: "conflict" };
    }
    // 清除垃圾桶专属标记
    const { trashed_at: _rmAt, trashed_batch_id: _rmBatch, ...restored } = shot;
    await writeJson(dstPath, restored);
    await fs.unlink(srcPath);
    // 2026-07-22 X3-3 (A3-5): 分镜搬回 shots/ → 清缓存, 让下次 locate 重扫拿到新位置
    // (防之前 trash 期间可能缓存的 null / 或恢复到不同 epId 的旧 locator).
    invalidateShotLocator(shotId);
    return { ok: true, shot: restored as ShotData };
  } catch {
    return { ok: false, reason: "not_found" };
  }
}

/**
 * 2026-07-22 X6-1 (A3-3) — 按 trashed_batch_id 把一整批分镜从垃圾桶原子搬回 shots/。
 *
 * 供"分镜版本回滚"消费: trashEpisodeShotFiles 重拆时给整集旧 shot 盖同一个 batch_id 移入 trash,
 * 回滚旧版本时据此把那批文件成套搬回。
 *
 * **原子 all-or-nothing**: 先扫全批 + 预检目标位是否被占 (conflict); 只要有一条冲突就**一条都不搬**,
 * 返回 conflicts 让上层整体回滚 + 报 409 (绝不半套落盘, 见 A3-3 设计 d 步)。无冲突才逐个 writeJson
 * (剥离 trash 标记) + unlink 源。每文件走 withWriteLock (与 trashEpisodeShotFiles/appendGeneration 同锁 key),
 * 与重拆/inflight 回写并发安全。
 *
 * @returns { restored: 落盘的 shotId 列表; conflicts: 目标位已被占用无法搬回的 shotId 列表 }
 */
export async function restoreTrashedShotsByBatch(
  slug: string, epId: string, batchId: string,
): Promise<{ restored: string[]; conflicts: string[] }> {
  const restored: string[] = [];
  const conflicts: string[] = [];
  const trashDir = path.join(TRASH_ROOT, slug, epId);
  if (!(await pathExists(trashDir))) return { restored, conflicts };

  let files: string[];
  try {
    files = await fs.readdir(trashDir);
  } catch {
    return { restored, conflicts };
  }

  // Phase 1 — 收集本批文件 + 预检冲突 (不移动任何文件)
  type BatchEntry = { srcPath: string; shotId: string; shot: ShotData & { trashed_at?: string; trashed_batch_id?: string } };
  const batch: BatchEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const srcPath = path.join(trashDir, file);
    const shot = await readJson<ShotData & { trashed_at?: string; trashed_batch_id?: string }>(srcPath).catch(() => null);
    if (!shot || shot.trashed_batch_id !== batchId) continue;
    // 目标落盘 id: 优先内部 id (与 persistStoryboard 落盘一致), 兜底从文件名剥尾部 _<ts>
    const shotId = typeof shot.id === "string" && shot.id.length > 0
      ? shot.id
      : file.replace(/_\d+\.json$/i, "");
    batch.push({ srcPath, shotId, shot });
  }
  if (batch.length === 0) return { restored, conflicts };

  for (const entry of batch) {
    if (await pathExists(shotFile(slug, epId, entry.shotId))) {
      conflicts.push(entry.shotId);
    }
  }
  // 有任一冲突 → 整批不搬 (原子性), 让 activateStoryboardVersion 整体回滚 + 409
  if (conflicts.length > 0) return { restored, conflicts };

  // Phase 2 — 无冲突, 逐个搬回 (锁内剥标记 writeJson + unlink 源)
  await ensureDir(shotsDir(slug, epId));
  for (const entry of batch) {
    const dstPath = shotFile(slug, epId, entry.shotId);
    await withWriteLock(entry.srcPath, async () => {
      try {
        // 二次防御: 锁内再查一遍目标位 (并发下可能刚被占)
        if (await pathExists(dstPath)) { conflicts.push(entry.shotId); return; }
        const { trashed_at: _rmAt, trashed_batch_id: _rmBatch, ...clean } = entry.shot;
        await writeJson(dstPath, clean);
        await fs.rm(entry.srcPath, { force: true });
        restored.push(entry.shotId);
      } catch (e) {
        loggerSync().warn(`[restoreTrashedShotsByBatch] ${slug}/${epId}/${entry.shotId} 搬回失败:`, e);
        conflicts.push(entry.shotId);
      }
    });
    invalidateShotLocator(entry.shotId);
  }

  return { restored, conflicts };
}

/**
 * 2026-07-22 X6-1 — 探测某批次在垃圾桶里是否还有文件 (供 activateStoryboardVersion 在"停放当前分镜"
 * 之前确认目标快照非空: 若批次已被永久清理=0 文件, 必须提前拒绝, 绝不白park当前分镜换来空分镜板)。
 */
export async function hasTrashedShotsInBatch(slug: string, epId: string, batchId: string): Promise<boolean> {
  const trashDir = path.join(TRASH_ROOT, slug, epId);
  if (!(await pathExists(trashDir))) return false;
  let files: string[];
  try {
    files = await fs.readdir(trashDir);
  } catch {
    return false;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const shot = await readJson<{ trashed_batch_id?: string }>(path.join(trashDir, file)).catch(() => null);
    if (shot && shot.trashed_batch_id === batchId) return true;
  }
  return false;
}

/** 列出垃圾桶里的分镜 (按 trashed_at desc) */
export async function listTrashedShots(slug: string, epId?: string): Promise<Array<ShotData & { trashed_at: string }>> {
  const results: Array<ShotData & { trashed_at: string }> = [];
  try {
    const base = epId ? path.join(TRASH_ROOT, slug, epId) : path.join(TRASH_ROOT, slug);
    if (!(await pathExists(base))) return [];
    // 如果 epId 给定只扫单集；否则递归扫所有集
    const epDirs = epId ? [epId] : (await fs.readdir(base, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
    for (const ep of epDirs) {
      const trashDir = epId ? base : path.join(base, ep);
      if (!(await pathExists(trashDir))) continue;
      const files = await fs.readdir(trashDir);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const shot = await readJson<ShotData & { trashed_at?: string }>(path.join(trashDir, f));
          if (shot) results.push({ ...shot, trashed_at: shot.trashed_at ?? new Date(0).toISOString() });
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return results.sort((a, b) => b.trashed_at.localeCompare(a.trashed_at));
}

/** 永久删除垃圾桶中的分镜文件
 * W-3.3: 永久删前先把 generations 的 vault 资产移到 trash (铁律 #6 数据保留)
 */
export async function permanentlyDeleteTrashedShot(
  slug: string, epId: string, shotId: string
): Promise<{ ok: boolean }> {
  const trashDir = path.join(TRASH_ROOT, slug, epId);
  try {
    if (!(await pathExists(trashDir))) return { ok: false };
    const files = await fs.readdir(trashDir);
    // 2026-07-10 Fable 二轮验收 P0-1 — 精确匹配 `${shotId}_<纯数字时间戳>.json` + 取最新批(与
    // restoreTrashedShot 对齐), 防松散前缀把 s0001 误吃 s0001_ab12_<ts>.json 删错批次/错分镜.
    const prefix = `${shotId}_`;
    const matches = files.filter((f) => f.startsWith(prefix) && f.endsWith(".json") && /^\d+$/.test(f.slice(prefix.length, -".json".length)));
    if (matches.length === 0) return { ok: false };
    matches.sort((a, b) => Number(a.slice(prefix.length, -".json".length)) - Number(b.slice(prefix.length, -".json".length)));
    const match = matches[matches.length - 1];
    const shotPath = path.join(trashDir, match);

    // 读 shot 数据, 提取所有 vault_id 并移到 vault trash
    const shot = await readJson<{ generations?: Array<{ vault_id?: string }>; last_frame_vault_id?: string }>(shotPath);
    const vaultIds = new Set<string>();
    for (const gen of shot?.generations ?? []) {
      if (gen.vault_id) vaultIds.add(gen.vault_id);
    }
    if (shot?.last_frame_vault_id) vaultIds.add(shot.last_frame_vault_id);

    if (vaultIds.size > 0) {
      // 延迟 import 避免循环依赖
      const { moveToTrash } = await import("../../../../packages/library/src/assetVault");
      for (const vid of vaultIds) {
        try {
          await moveToTrash(vid, `shot永久删除:${slug}/${epId}/${shotId}`);
        } catch { /* vault trash 失败不阻断 shot 删除 */ }
      }
    }

    await fs.unlink(shotPath);
    // 2026-07-22 X3-3 (A3-5): 分镜文件永久删除 → 清 locator 缓存, 防悬空 locator 残留.
    invalidateShotLocator(shotId);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** 批量重排分镜顺序：传入 shot_ids 数组（新顺序），把 index 字段逐个更新并写盘 */
export async function reorderShots(slug: string, epId: string, shot_ids: string[]): Promise<{ ok: boolean }> {
  try {
    for (let i = 0; i < shot_ids.length; i++) {
      const sid = shot_ids[i];
      const existing = await readShot(slug, epId, sid);
      if (existing && existing.index !== i + 1) {
        await updateShot(slug, epId, sid, { index: i + 1 });
      }
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ============================================================
// v24-batch-all · Shot-centric 辅助 (BACKEND_SPEC /api/v2/shots/:sid)
// 说明: BACKEND_SPEC 要求 flat /api/shots/:sid/*, 但现有存储是
// data/series/<slug>/episodes/<epId>/shots/<shotId>.json.
// 下面的工具: 通过全盘扫描 + LRU 缓存把 sid -> {slug,epId,shotId}
// ============================================================

export interface ShotLocator {
  slug: string;
  epId: string;
  shotId: string;
}

const SHOT_LOCATOR_CACHE = new Map<string, { at: number; value: ShotLocator }>();
const SHOT_LOCATOR_TTL_MS = 5 * 60 * 1000;
const SHOT_LOCATOR_MAX = 500;

function pruneShotLocator() {
  if (SHOT_LOCATOR_CACHE.size <= SHOT_LOCATOR_MAX) return;
  const oldest = Array.from(SHOT_LOCATOR_CACHE.entries()).sort((a, b) => a[1].at - b[1].at);
  for (let i = 0; i < oldest.length - SHOT_LOCATOR_MAX; i++) {
    SHOT_LOCATOR_CACHE.delete(oldest[i][0]);
  }
}

/**
 * 2026-07-22 X3-3 (A3-5): 分镜被 trash / restore / 重拆(trashEpisodeShotFiles) / 永久删后,
 * 主动清 locator 缓存. 否则 5 分钟 TTL 内旧 locator 仍生效: 单镜读不到文件返 null(优雅 404),
 * 但叠加 A3-4 跨系列同号时会把"谁赢首次扫描"锁死 5 分钟, 放大错分镜概率. 写路径末尾调用本函数.
 */
export function invalidateShotLocator(shotId: string): void {
  SHOT_LOCATOR_CACHE.delete(shotId);
}

/**
 * 2026-07-22 X3-3 (A3-4 治本): 全盘扫描返回 shotId 的**所有**命中 locator (不止第一个).
 * LLM 拆分镜写的 `s%04d` id 按集顺序、跨集/跨系列不唯一(只有 addShot 的 UUID 唯一);
 * 调用方(扁平付费路由)据此判断歧义: 0=未找到 / 1=唯一命中 / >1=歧义(需带 slug+epId 上下文
 * 消歧, 否则拒绝操作防错分镜扣费). 本函数不读/不写缓存(每次真扫), 缓存由 locateShotById 管.
 */
export async function locateShotMatches(shotId: string): Promise<ShotLocator[]> {
  const matches: ShotLocator[] = [];
  if (!(await pathExists(SERIES_ROOT))) return matches;
  const seriesDirs = await fs.readdir(SERIES_ROOT, { withFileTypes: true });
  for (const sd of seriesDirs) {
    if (!sd.isDirectory()) continue;
    const slug = sd.name;
    const epRoot = path.join(SERIES_ROOT, slug, "episodes");
    if (!(await pathExists(epRoot))) continue;
    const epDirs = await fs.readdir(epRoot, { withFileTypes: true });
    for (const ed of epDirs) {
      if (!ed.isDirectory()) continue;
      const epId = ed.name;
      const shotFilePath = path.join(epRoot, epId, "shots", `${shotId}.json`);
      if (await pathExists(shotFilePath)) {
        matches.push({ slug, epId, shotId });
      }
    }
  }
  return matches;
}

/**
 * 根据 shotId 全盘找到它的 {slug, epId}. 加 5 分钟 TTL 缓存.
 * TODO(pm): 大仓库下扫盘可能慢, 是否加 data/shot_index.json 索引?
 *
 * 2026-07-22 X3-3 (A3-4 治本): 扫到 **>1 命中直接返 null (不再取第一个)** — 逼 caller 带
 * slug/epId 上下文, 杜绝跨集/跨系列同号 s000N 打到错分镜(付费到错镜/导入错镜/预览错镜).
 * 歧义不写缓存(避免把错误结果锁死 5 分钟). 唯一命中才写缓存. 需要区分"未找到"与"歧义"
 * (给出 409 而非 404)的 caller 请直接用 locateShotMatches + resolveFlatShotLocatorOrErr.
 */
export async function locateShotById(shotId: string): Promise<ShotLocator | null> {
  const cached = SHOT_LOCATOR_CACHE.get(shotId);
  const now = Date.now();
  if (cached && now - cached.at < SHOT_LOCATOR_TTL_MS) {
    return cached.value;
  }
  const matches = await locateShotMatches(shotId);
  if (matches.length === 1) {
    SHOT_LOCATOR_CACHE.set(shotId, { at: now, value: matches[0] });
    pruneShotLocator();
    return matches[0];
  }
  if (matches.length > 1) {
    loggerSync().warn(
      `[locateShotById] shotId "${shotId}" 跨 ${matches.length} 处命中 (${matches.map((m) => `${m.slug}/${m.epId}`).join(", ")}) — 拒绝含糊定位, caller 需带 slug/epId 上下文`,
    );
  }
  return null;
}

/** 读取 shot 仅用 shotId (自动定位 slug/epId) */
export async function readShotById(shotId: string): Promise<(ShotData & { locator: ShotLocator }) | null> {
  const loc = await locateShotById(shotId);
  if (!loc) return null;
  const shot = await readShot(loc.slug, loc.epId, loc.shotId);
  if (!shot) return null;
  return { ...shot, locator: loc };
}

/** 按 shotId 更新 (自动定位) */
export async function updateShotById(shotId: string, patch: Partial<ShotData>): Promise<(ShotData & { locator: ShotLocator }) | null> {
  const loc = await locateShotById(shotId);
  if (!loc) return null;
  const updated = await updateShot(loc.slug, loc.epId, loc.shotId, patch);
  if (!updated) return null;
  return { ...updated, locator: loc };
}

/**
 * 给 failures 里每条记录保证有 attempt_id 字段 (老数据补生成).
 * 返回 failures 数组 (带 attempt_id 保证), 并写回 shot 文件 (若有补齐).
 */
export async function listShotFailuresWithId(shotId: string): Promise<Array<{
  attempt_id: string; at: string; stage: string; error: string;
  model?: string; code?: string; request_json?: unknown; response_json?: unknown;
}> | null> {
  const loc = await locateShotById(shotId);
  if (!loc) return null;
  return withWriteLock(shotFile(loc.slug, loc.epId, loc.shotId), async () => {
    const shot = await readShot(loc.slug, loc.epId, loc.shotId);
    if (!shot) return null;
    const failures = shot.failures ?? [];
    let mutated = false;
    type EnrichedFailure = ShotFailure & { attempt_id: string };
    const enriched: EnrichedFailure[] = failures.map((f: ShotFailure & { attempt_id?: string }) => {
      if (typeof f.attempt_id === "string" && f.attempt_id.length > 0) {
        return f as EnrichedFailure;
      }
      mutated = true;
      return { ...f, attempt_id: `att_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 12)}` };
    });
    if (mutated) {
      await writeJson(shotFile(loc.slug, loc.epId, loc.shotId), { ...shot, failures: enriched });
    }
    return enriched;
  });
}

/** 追加一条 failure, 自动带 attempt_id. 返回新记录. */
export async function appendShotFailure(shotId: string, failure: {
  attempt_id?: string; stage: string; error: string; model?: string; code?: string;
  request_json?: unknown; response_json?: unknown;
}): Promise<{ attempt_id: string } | null> {
  const loc = await locateShotById(shotId);
  if (!loc) return null;
  const aid = failure.attempt_id ?? `att_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 12)}`;
  await withWriteLock(shotFile(loc.slug, loc.epId, loc.shotId), async () => {
    const shot = await readShot(loc.slug, loc.epId, loc.shotId);
    if (!shot) return;
    // ShotFailure base + extended runtime fields (attempt_id, model, code, request_json, response_json)
    type ExtendedFailure = ShotFailure & { attempt_id: string; model?: string; code?: string; request_json?: unknown; response_json?: unknown };
    const failures: ExtendedFailure[] = (Array.isArray(shot.failures) ? shot.failures : []) as ExtendedFailure[];
    failures.push({ at: new Date().toISOString(), ...failure, attempt_id: aid });
    await writeJson(shotFile(loc.slug, loc.epId, loc.shotId), { ...shot, failures });
  });
  return { attempt_id: aid };
}

/** 从 failures 数组里按 attempt_id 移除 */
export async function dismissShotFailureById(shotId: string, attempt_id: string): Promise<boolean> {
  const loc = await locateShotById(shotId);
  if (!loc) return false;
  return withWriteLock(shotFile(loc.slug, loc.epId, loc.shotId), async () => {
    const shot = await readShot(loc.slug, loc.epId, loc.shotId);
    if (!shot) return false;
    const failures = (shot.failures ?? []).filter((f: ShotFailure & { attempt_id?: string }) => f.attempt_id !== attempt_id);
    await writeJson(shotFile(loc.slug, loc.epId, loc.shotId), { ...shot, failures });
    return true;
  });
}
