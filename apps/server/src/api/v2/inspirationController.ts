/**
 * v2 Inspirations Controller — per-series creative inbox.
 *
 * Stores lightweight inspiration notes under:
 *   data/series/<slug>/inspirations.json
 */

import { Router, type Request, type Response } from "express";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_ROOT, ensureDir, pathExists, readJson, writeJson } from "../../../../../packages/core/src/index";
import { readSeries } from "./seriesStore";

export const inspirationRouter = Router();

type InspirationType = "image" | "video" | "text";

interface InspirationRecord {
  id: string;
  src: string;
  user: string;
  text: string;
  tags: string[];
  createdAt: number;
  unread: boolean;
  saved?: boolean;
  type: InspirationType;
  expandedEpisodeId?: string | null;
}

/** P0-3 (2026-05-28 audit wave 4): 回收站条目 — record + 软删时间 (90 天后过期清理) */
interface TrashedInspirationRecord extends InspirationRecord {
  deletedAt: number;
}

/** 90 天保留期, 与 element/character/scene 软删一致 */
const INSPIRATION_TRASH_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const writeLocks = new Map<string, Promise<void>>();

function inspirationFile(slug: string) {
  return path.join(DATA_ROOT, "series", slug, "inspirations.json");
}

function inspirationTrashFile(slug: string) {
  return path.join(DATA_ROOT, "series", slug, "inspirations_trash.json");
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeType(value: unknown): InspirationType {
  return value === "image" || value === "video" || value === "text" ? value : "text";
}

function sanitizeRecord(raw: unknown): InspirationRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string") return null;
  return {
    id: typeof r.id === "string" && r.id ? r.id : `insp_${Date.now()}_${crypto.randomUUID().slice(0, 12)}`,
    src: typeof r.src === "string" && r.src ? r.src.slice(0, 40) : "灵感",
    user: typeof r.user === "string" && r.user ? r.user.slice(0, 80) : "我",
    text: r.text.slice(0, 20_000),
    tags: normalizeTags(r.tags),
    createdAt: typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    unread: typeof r.unread === "boolean" ? r.unread : true,
    saved: typeof r.saved === "boolean" ? r.saved : undefined,
    type: normalizeType(r.type),
    expandedEpisodeId: typeof r.expandedEpisodeId === "string" ? r.expandedEpisodeId : r.expandedEpisodeId === null ? null : undefined,
  };
}

async function ensureSeries(slug: string, res: Response): Promise<boolean> {
  const series = await readSeries(slug);
  if (!series) {
    res.status(404).json({ error: { code: "NotFound", message: `series ${slug} 未找到` } });
    return false;
  }
  return true;
}

async function readInspirations(slug: string): Promise<InspirationRecord[]> {
  const file = inspirationFile(slug);
  if (!(await pathExists(file))) return [];
  const raw = await readJson<unknown>(file);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => sanitizeRecord(item))
    .filter((item): item is InspirationRecord => item !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function writeInspirations(slug: string, list: InspirationRecord[]): Promise<void> {
  const file = inspirationFile(slug);
  await ensureDir(path.dirname(file));
  await writeJson(file, list);
}

/** P0-3: 读回收站 (90 天后过期条目自动过滤掉 — 由 cleanupExpired 异步清盘) */
async function readTrashedInspirations(slug: string): Promise<TrashedInspirationRecord[]> {
  const file = inspirationTrashFile(slug);
  if (!(await pathExists(file))) return [];
  const raw = await readJson<unknown>(file);
  if (!Array.isArray(raw)) return [];
  const now = Date.now();
  return raw
    .map((item) => {
      const base = sanitizeRecord(item);
      if (!base) return null;
      const r = item as Record<string, unknown>;
      const deletedAt = typeof r.deletedAt === "number" && Number.isFinite(r.deletedAt) ? r.deletedAt : now;
      return { ...base, deletedAt } as TrashedInspirationRecord;
    })
    .filter((item): item is TrashedInspirationRecord => item !== null)
    .filter((item) => now - item.deletedAt <= INSPIRATION_TRASH_MAX_AGE_MS)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

async function writeTrashedInspirations(slug: string, list: TrashedInspirationRecord[]): Promise<void> {
  const file = inspirationTrashFile(slug);
  await ensureDir(path.dirname(file));
  await writeJson(file, list);
}

async function withInspirationLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const file = inspirationFile(slug);
  const prev = writeLocks.get(file) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  writeLocks.set(file, next);
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
}

function buildCreateRecord(body: Record<string, unknown>): InspirationRecord | null {
  if (!body || typeof body.text !== "string" || body.text.trim().length === 0) return null;
  return {
    id: `insp_${Date.now()}_${crypto.randomUUID().slice(0, 12)}`,
    src: typeof body.src === "string" && body.src.trim() ? body.src.trim().slice(0, 40) : "灵感",
    user: typeof body.user === "string" && body.user.trim() ? body.user.trim().slice(0, 80) : "我",
    text: body.text.trim().slice(0, 20_000),
    tags: normalizeTags(body.tags),
    createdAt: Date.now(),
    unread: true,
    saved: typeof body.saved === "boolean" ? body.saved : undefined,
    type: normalizeType(body.type),
    expandedEpisodeId: null,
  };
}

function applyPatch(existing: InspirationRecord, body: Record<string, unknown>): InspirationRecord {
  return {
    ...existing,
    ...(typeof body?.text === "string" ? { text: body.text.trim().slice(0, 20_000) } : {}),
    ...(Array.isArray(body?.tags) ? { tags: normalizeTags(body.tags) } : {}),
    ...(typeof body?.unread === "boolean" ? { unread: body.unread } : {}),
    ...(typeof body?.saved === "boolean" ? { saved: body.saved } : {}),
    ...(typeof body?.expandedEpisodeId === "string" || body?.expandedEpisodeId === null
      ? { expandedEpisodeId: body.expandedEpisodeId }
      : {}),
  };
}

inspirationRouter.get("/series/:slug/inspirations", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    if (!(await ensureSeries(slug, res))) return;
    res.json({ inspirations: await readInspirations(slug) });
  } catch (error) { next(error); }
});

inspirationRouter.post("/series/:slug/inspirations", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    if (!(await ensureSeries(slug, res))) return;
    const record = buildCreateRecord(req.body);
    if (!record) {
      res.status(400).json({ error: { code: "ValidationError", message: "text 必填" } });
      return;
    }
    await withInspirationLock(slug, async () => {
      const list = await readInspirations(slug);
      await writeInspirations(slug, [record, ...list]);
    });
    res.status(201).json({ inspiration: record });
  } catch (error) { next(error); }
});

// P0-3 (2026-05-28 audit wave 4): trash 路由必须在 :id 路由之前注册, 否则 :id 会捕获 "trash" 字符串.
inspirationRouter.get("/series/:slug/inspirations/trash", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    if (!(await ensureSeries(slug, res))) return;
    const trashList = await readTrashedInspirations(slug);
    const now = Date.now();
    const trashWithMeta = trashList.map((t) => ({
      ...t,
      days_remaining: Math.max(0, Math.ceil((INSPIRATION_TRASH_MAX_AGE_MS - (now - t.deletedAt)) / (24 * 60 * 60 * 1000))),
      expires_at: new Date(t.deletedAt + INSPIRATION_TRASH_MAX_AGE_MS).toISOString(),
    }));
    res.json({ trash: trashWithMeta });
  } catch (error) { next(error); }
});

inspirationRouter.post("/series/:slug/inspirations/trash/:id/restore", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    if (!(await ensureSeries(slug, res))) return;
    const restored = await withInspirationLock(slug, async () => {
      const trashList = await readTrashedInspirations(slug);
      const target = trashList.find((t) => t.id === id);
      if (!target) return null;
      const { deletedAt: _omit, ...record } = target;
      void _omit;
      const inspirations = await readInspirations(slug);
      let restoredId = record.id;
      if (inspirations.some((i) => i.id === restoredId)) {
        restoredId = `${record.id}_restored_${Date.now()}`;
      }
      const restoredRecord: InspirationRecord = { ...record, id: restoredId };
      await writeInspirations(slug, [restoredRecord, ...inspirations]);
      await writeTrashedInspirations(slug, trashList.filter((t) => t.id !== id));
      return restoredRecord;
    });
    if (!restored) {
      res.status(404).json({ error: { code: "NotFound", message: `trash ${id} 未找到` } });
      return;
    }
    res.json({ inspiration: restored });
  } catch (error) { next(error); }
});

inspirationRouter.delete("/series/:slug/inspirations/trash/:id", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    if (!(await ensureSeries(slug, res))) return;
    const deleted = await withInspirationLock(slug, async () => {
      const trashList = await readTrashedInspirations(slug);
      const next = trashList.filter((t) => t.id !== id);
      if (next.length === trashList.length) return false;
      await writeTrashedInspirations(slug, next);
      return true;
    });
    if (!deleted) {
      res.status(404).json({ error: { code: "NotFound", message: `trash ${id} 未找到` } });
      return;
    }
    res.json({ ok: true });
  } catch (error) { next(error); }
});

inspirationRouter.patch("/series/:slug/inspirations/:id", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    if (!(await ensureSeries(slug, res))) return;
    const updated = await withInspirationLock(slug, async () => {
      const list = await readInspirations(slug);
      const idx = list.findIndex((item) => item.id === id);
      if (idx === -1) return null;
      const item = applyPatch(list[idx], req.body);
      const nextList = [...list];
      nextList[idx] = item;
      await writeInspirations(slug, nextList);
      return item;
    });
    if (!updated) {
      res.status(404).json({ error: { code: "NotFound", message: `inspiration ${id} 未找到` } });
      return;
    }
    res.json({ inspiration: updated });
  } catch (error) { next(error); }
});

// P0-3 (2026-05-28 audit wave 4): 灵感 DELETE 改软删, 遵循铁律 #6 数据保留 > 直接删除.
// 老行为: 物理删除 → 用户误删无法恢复 → 违反铁律. 新行为: 移到 inspirations_trash.json 90 天可恢复.
inspirationRouter.delete("/series/:slug/inspirations/:id", async (req: Request, res: Response, next) => {
  try {
    const slug = String(req.params.slug);
    const id = String(req.params.id);
    if (!(await ensureSeries(slug, res))) return;
    const trashed = await withInspirationLock(slug, async () => {
      const list = await readInspirations(slug);
      const target = list.find((item) => item.id === id);
      if (!target) return null;
      const nextList = list.filter((item) => item.id !== id);
      await writeInspirations(slug, nextList);
      // 追加到回收站 (允许多次软删同 id, 取最新一份)
      const trashList = await readTrashedInspirations(slug);
      const trashedRecord: TrashedInspirationRecord = { ...target, deletedAt: Date.now() };
      await writeTrashedInspirations(slug, [trashedRecord, ...trashList.filter((t) => t.id !== id)]);
      return trashedRecord;
    });
    if (!trashed) {
      res.status(404).json({ error: { code: "NotFound", message: `inspiration ${id} 未找到` } });
      return;
    }
    res.json({ ok: true, trashed: { id: trashed.id, deletedAt: trashed.deletedAt } });
  } catch (error) { next(error); }
});
