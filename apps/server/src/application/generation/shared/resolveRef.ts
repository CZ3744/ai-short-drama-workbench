/**
 * B-P0-3 (2026-06-01): 共享 helper — imageGenerationService 与 videoGenerationService 各自
 * 有完整重复的 5 个私有函数, 抽到本文件统一实现。
 *
 * 差异通过参数传入:
 *   - taskIdPrefix   : "image_" | "video_" — makeProviderContext 生成 taskId 前缀
 *   - logLabel       : "[image-generation]" | "[video-generation]" — warn 日志标签
 *   - tmpDirName     : "image-generation-inputs" | "video-generation-inputs" — 临时目录名
 *   - errLabel       : "参考图" | "参考资源" — assertReadable 错误文案
 *   - extraExts      : e.g. { mp4: /mp4/i } — extensionForMime 额外扩展名(视频版加 mp4)
 *
 * 行为零变更 — 仅去重, 不改任何语义。
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_ROOT } from "../../../../../../packages/core/src/index";
import type { ProviderContext } from "../../../../../../packages/providers/src/core/types";
import { getVaultAbsolutePath, getVaultEntry } from "../../../../../../packages/library/src/assetVault";
import { readAsset, resolveAssetFilePath } from "../../../repositories/assetRepo";

// ─── makeProviderContext ─────────────────────────────────────────────────────

export function makeProviderContext(args: {
  series_slug: string;
  job_id?: string;
  task_id?: string;
  timeout_ms?: number;
  log?: ProviderContext["log"];
  signal?: AbortSignal;
  /** "image_" | "video_" */
  taskIdPrefix: string;
}): ProviderContext {
  const taskId = args.task_id || `${args.taskIdPrefix}${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
  // 删 AbortSignal.timeout(N), 只透传 ctx.signal (用户主动中止). 远端等多久就等多久.
  // args.timeout_ms 参数保留供 backward-compat 但不再读取.
  return {
    series_slug: args.series_slug,
    job_id: args.job_id || taskId,
    task_id: taskId,
    signal: args.signal,
    log: args.log ?? (() => undefined),
  };
}

// ─── extensionForMime ────────────────────────────────────────────────────────

/**
 * @param extraExts  额外的 mime→extension 映射(如视频版加 mp4: /mp4\/i/)
 */
export function extensionForMime(
  mime: string,
  extraExts?: ReadonlyArray<{ pattern: RegExp; ext: string }>,
): string {
  if (extraExts) {
    for (const { pattern, ext } of extraExts) {
      if (pattern.test(mime)) return ext;
    }
  }
  if (/jpe?g/i.test(mime)) return "jpg";
  if (/webp/i.test(mime)) return "webp";
  if (/gif/i.test(mime)) return "gif";
  return "png";
}

/** 视频版的额外扩展名列表(mp4 优先于 png fallback) */
export const VIDEO_EXTRA_EXTS: ReadonlyArray<{ pattern: RegExp; ext: string }> = [
  { pattern: /mp4/i, ext: "mp4" },
];

// ─── parseDataOrBase64 ───────────────────────────────────────────────────────

/** 完全相同 — image/video 两版一字不差 */
export function parseDataOrBase64(
  raw: string,
  mime: string | undefined,
): { buffer: Buffer; mime: string } {
  const match = raw.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return { mime: match[1] || "image/png", buffer: Buffer.from(match[2], "base64") };
  }
  return {
    mime: mime || "image/png",
    buffer: Buffer.from(raw.replace(/^base64,/, ""), "base64"),
  };
}

// ─── assertReadable ──────────────────────────────────────────────────────────

/**
 * @param errLabel  错误文案前缀: "参考图" (image) | "参考资源" (video)
 */
export async function assertReadable(
  filePath: string,
  label: string,
  errLabel: string = "参考图",
): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    // Y2/UP-5 脱敏: 绝对路径 + 内部 label(id) 只进服务端日志, 绝不抛到前端 (铁律#9)。
    // 前端只见人话"哪步坏了 + 怎么办", 不含 F:\... 路径 / asset_id / 英文键名。
    console.warn(`[assertReadable] 无法读取${errLabel} (${label}): ${filePath}`);
    throw new Error(`引用的${errLabel}文件缺失，请重新导入或重新挑选参考图`);
  }
}

// ─── writeTempReference ──────────────────────────────────────────────────────

export interface WriteTempReferenceArgs {
  raw: string;
  mime: string | undefined;
  tempPaths: string[];
  /** "image-generation-inputs" | "video-generation-inputs" */
  tmpDirName: string;
  extraExts?: ReadonlyArray<{ pattern: RegExp; ext: string }>;
}

export async function writeTempReference(args: WriteTempReferenceArgs): Promise<string> {
  const parsed = parseDataOrBase64(args.raw, args.mime);
  const dir = path.join(DATA_ROOT, "tmp", args.tmpDirName);
  await fs.mkdir(dir, { recursive: true });
  const filename = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}.${extensionForMime(parsed.mime, args.extraExts)}`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, parsed.buffer);
  args.tempPaths.push(filePath);
  return filePath;
}

// ─── resolveSingleRef ────────────────────────────────────────────────────────

/** 公共 ref 结构 — image/video InputRef 的共同字段 */
export interface AnyInputRef {
  asset_id?: string;
  vault_id?: string;
  path?: string;
  data_url?: string;
  base64?: string;
  mime?: string;
  weight?: number;
}

export interface ResolveSingleRefArgs {
  ref: AnyInputRef;
  series_slug: string;
  temp_paths: string[];
  tmpDirName: string;
  errLabel?: string;
  extraExts?: ReadonlyArray<{ pattern: RegExp; ext: string }>;
}

/**
 * 解析单个参考图 ref → 绝对路径。
 * 找不到时 throw Error(不由本函数判断 strict),由外层 resolveReferenceImages 统一处理。
 */
export async function resolveSingleRef(args: ResolveSingleRefArgs): Promise<string | null> {
  const { ref, series_slug, temp_paths, tmpDirName, errLabel = "参考图", extraExts } = args;

  if (ref.data_url || ref.base64) {
    return writeTempReference({
      raw: ref.data_url ?? ref.base64!,
      mime: ref.mime,
      tempPaths: temp_paths,
      tmpDirName,
      extraExts,
    });
  }

  const raw = (ref.path ?? ref.vault_id ?? ref.asset_id ?? "").trim();
  if (!raw) return null;

  const vaultEntry = await getVaultEntry(raw).catch(() => null);
  if (vaultEntry) {
    const abs = getVaultAbsolutePath(vaultEntry);
    await assertReadable(abs, `vault ${raw}`, errLabel);
    return abs;
  }

  if (series_slug && series_slug !== "adhoc" && series_slug !== "library") {
    const asset = await readAsset(series_slug, raw).catch(() => null);
    const abs = asset ? resolveAssetFilePath(series_slug, asset.path) : null;
    if (abs) {
      await assertReadable(abs, `asset ${raw}`, errLabel);
      return abs;
    }
  }

  if (path.isAbsolute(raw)) {
    await assertReadable(raw, raw, errLabel);
    return raw;
  }

  // Y2/UP-5 脱敏: raw (asset_id / vault_id / 绝对路径) 只进服务端日志, 前端见人话。
  console.warn(`[resolveSingleRef] ${errLabel}不存在或不可读取: ${raw}`);
  throw new Error(`引用的${errLabel}不存在或无法读取，请重新导入或重新挑选参考图`);
}

// ─── resolveReferenceImages ──────────────────────────────────────────────────

export interface ResolveReferenceImagesArgs {
  refs: AnyInputRef[];
  series_slug: string;
  temp_paths: string[];
  strict: boolean;
  log: ProviderContext["log"];
  /** "[image-generation]" | "[video-generation]" */
  logLabel: string;
  tmpDirName: string;
  errLabel?: string;
  extraExts?: ReadonlyArray<{ pattern: RegExp; ext: string }>;
}

export async function resolveReferenceImages(
  args: ResolveReferenceImagesArgs,
): Promise<Array<{ asset_id: string; weight?: number }>> {
  const out: Array<{ asset_id: string; weight?: number }> = [];
  for (const ref of args.refs.slice(0, 8)) {
    try {
      const resolved = await resolveSingleRef({
        ref,
        series_slug: args.series_slug,
        temp_paths: args.temp_paths,
        tmpDirName: args.tmpDirName,
        errLabel: args.errLabel,
        extraExts: args.extraExts,
      });
      if (resolved) out.push({ asset_id: resolved, weight: ref.weight });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (args.strict) throw err;
      args.log("warn", `${args.logLabel} skip reference image: ${msg}`);
    }
  }
  return out;
}
