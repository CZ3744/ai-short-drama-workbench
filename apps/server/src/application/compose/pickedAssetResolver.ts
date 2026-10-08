/**
 * Entity-first picked asset resolver.
 *
 * 背景 (2026-05-22): 用户实测合成黑屏, 根因 — 数据模型双真理源 + 解析端读错字段.
 *   • shot.picked_video_generation_id      (entity-first 引用, 单一真理源 ✓)
 *   • generation.picked === true           (in-record 标志, 经常不同步 ✗)
 * 旧 compose 路径走 `find(g => g.picked === true)`, 完全忽略 picked_video_generation_id,
 * 找不到时 silent mock 一段黑屏冒充, 用户看到的就是 5/5 镜头都是黑屏 + manifest 标 reason=no-picked-video-generation.
 *
 * 本模块统一两件事:
 *   1. 读 picked 走 entity-first: `shot.picked_*_generation_id` → 找 generation → fallback `picked === true`
 *   2. 解析 generation 实际文件路径:
 *        asset_id (series 内 assets) → vault_id (跨项目归档柜) → 老 generation.path 兜底
 *        全部找不到 → 抛 PickedAssetUnresolvedError (上层显式 collect 进 failed_shots, 绝不 silent mock)
 *
 * 调用方:
 *   - tts.ts        (resolvePickedVideo / resolvePickedFirstFrame for reuse 路径)
 *   - ffmpegBuilder (rough 模式 resolvePickedFirstFrame)
 *   - 迁移脚本 migrate-shot-picked-video.ts (resolveGenerationPath 单独导出)
 */
import path from "node:path";

import { readAsset } from "../../api/v2/seriesStore";
import { SSR_BASE } from "../../api/v2/orchestration/_shared/paths";
import { pathExists } from "../../../../../packages/core/src/index";
import {
  getVaultEntry,
  getVaultAbsolutePath,
} from "../../../../../packages/library/src/assetVault";

/** Minimal shape — matches `ShotGeneration` in repositories/shotRepo.ts */
export interface PickedGenerationLike {
  generation_id: string;
  type: string;
  status: string;
  asset_id?: string;
  vault_id?: string;
  path?: string;
  picked?: boolean;
  created_at: string;
}

/** Minimal shot shape for entity-first lookup */
export interface PickedShotLike {
  id: string;
  duration_sec?: number;
  picked_first_frame_generation_id?: string | null;
  picked_video_generation_id?: string | null;
  generations?: PickedGenerationLike[];
  /**
   * 已丢弃(移入废案箱)的候选. moveGenerationToTrash 把丢弃候选追加进这里, 同时
   * shot.generations 落盘成 active+trashed 的并集(见 shotRepo.moveGenerationToTrash),
   * 而且丢弃时不清 picked_*_generation_id。resolver 必须据此把废案剔除,
   * 否则会静默用回被用户丢弃的片段合成。
   */
  trashed_generations?: PickedGenerationLike[];
}

export type PickedKind = "video" | "first_frame";

/** 抛出时 caller 必须 catch 并把 shot_id + reason 收集到 failed_shots, 绝不 silent mock. */
export class PickedAssetUnresolvedError extends Error {
  readonly shotId: string;
  readonly kind: PickedKind;
  /** toC 中文人话, 直接拼到 toast / manifest reason */
  readonly reasonZh: string;
  /** 机器可读 enum, 仅日志/审计用 */
  readonly code:
    | "no-picked-generation"
    | "generation-not-found"
    | "asset-file-missing";

  constructor(args: {
    shotId: string;
    kind: PickedKind;
    code: "no-picked-generation" | "generation-not-found" | "asset-file-missing";
    reasonZh: string;
  }) {
    super(`[${args.shotId}] ${args.code}: ${args.reasonZh}`);
    this.name = "PickedAssetUnresolvedError";
    this.shotId = args.shotId;
    this.kind = args.kind;
    this.code = args.code;
    this.reasonZh = args.reasonZh;
  }
}

export interface ResolvedPickedAsset {
  /** 真实绝对文件路径, 一定 pathExists */
  absPath: string;
  /** 命中的 generation_id (审计 / SSE 推送用) */
  generationId: string;
  /** 哪一层 resolve 命中: asset / vault / generation_path (legacy) */
  source: "asset" | "vault" | "generation_path";
  /** entity-first or legacy fallback (用户旧数据兼容路径) */
  pickedBy: "shot_picked_id" | "generation_picked_flag";
  /** 命中的原 generation 对象 (caller 可能要读 prompt / created_at 等) */
  generation: PickedGenerationLike;
}

/**
 * Entity-first 选 generation:
 *   1. shot.picked_*_generation_id 设了 → 必须找得到, 找不到抛 "generation-not-found"
 *   2. 未设 → fallback 老数据: 取 picked===true 的, 再不行最新一条
 *   3. 完全没有 generation → 抛 "no-picked-generation"
 */
export function pickGenerationEntityFirst(
  shot: PickedShotLike,
  kind: PickedKind,
): { generation: PickedGenerationLike; pickedBy: ResolvedPickedAsset["pickedBy"] } {
  // shot.generations 是 active+trashed 的并集(shotRepo.moveGenerationToTrash 落盘时如此),
  // 被丢弃的候选 status 仍是 "done" 只是被移进 trashed_generations。必须按 id 剔除废案,
  // 否则 picked_*_generation_id 若仍指向被丢弃的候选(丢弃时未清指针)会被静默用于合成。
  const trashedIds = new Set(
    (shot.trashed_generations ?? []).map((g) => g.generation_id),
  );
  const allGens = (shot.generations ?? []).filter(
    (g) => g.type === kind && g.status === "done" && !trashedIds.has(g.generation_id),
  );

  // entity-first 主路径
  const pickedId =
    kind === "video"
      ? shot.picked_video_generation_id
      : shot.picked_first_frame_generation_id;

  if (pickedId) {
    const hit = allGens.find((g) => g.generation_id === pickedId);
    if (hit) {
      return { generation: hit, pickedBy: "shot_picked_id" };
    }
    // 选中的候选已被移入废案箱 → 显式报错让用户重挑, 绝不静默回退用废案片段合成
    if (trashedIds.has(pickedId)) {
      throw new PickedAssetUnresolvedError({
        shotId: shot.id,
        kind,
        code: "generation-not-found",
        reasonZh:
          kind === "video"
            ? "之前选定的视频片段已被移入废案箱，请重新挑选一个视频片段再合成"
            : "之前选定的首帧图片已被移入废案箱，请重新挑选一张首帧图片再合成",
      });
    }
    // picked id 设了但找不到 generation → 显式错: 数据被删 / 错位
    throw new PickedAssetUnresolvedError({
      shotId: shot.id,
      kind,
      code: "generation-not-found",
      reasonZh:
        kind === "video"
          ? "已选定的视频片段记录已丢失（可能被清理或导入失败），请重新选择或重新生成"
          : "已选定的首帧图片记录已丢失（可能被清理或导入失败），请重新选择或重新生成",
    });
  }

  // legacy fallback: 老数据没 picked_*_generation_id, 走 generation.picked 标志
  const sorted = [...allGens].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const legacyPicked = sorted.find((g) => g.picked === true) ?? sorted[0];
  if (legacyPicked) {
    return { generation: legacyPicked, pickedBy: "generation_picked_flag" };
  }

  // 完全没有 done 的 generation → 上层判断走 mock 占位还是 throw
  throw new PickedAssetUnresolvedError({
    shotId: shot.id,
    kind,
    code: "no-picked-generation",
    reasonZh:
      kind === "video"
        ? "尚未生成或选定视频片段"
        : "尚未生成或选定首帧图片",
  });
}

/**
 * 给一个 generation, 把文件路径解出来.
 * 多级 fallback: asset_id → vault_id → generation.path → null.
 * 返回 null 表示文件真的找不到 (上层抛 asset-file-missing).
 */
export async function resolveGenerationPath(
  slug: string,
  baseDir: string,
  generation: PickedGenerationLike,
): Promise<{ absPath: string; source: ResolvedPickedAsset["source"] } | null> {
  // 1. series 内 assets (主流量, 自动生成的图/视频)
  if (generation.asset_id) {
    try {
      const asset = await readAsset(slug, generation.asset_id);
      if (asset) {
        const candidate = path.join(SSR_BASE, slug, asset.path);
        if (await pathExists(candidate)) {
          return { absPath: candidate, source: "asset" };
        }
      }
    } catch {
      /* asset lookup failed, try vault */
    }
  }

  // 2. 跨项目 vault (导入的本地视频 / 跨集复用 — 此次用户实测路径)
  if (generation.vault_id) {
    try {
      const vaultEntry = await getVaultEntry(generation.vault_id);
      if (vaultEntry && vaultEntry.status === "active") {
        const candidate = getVaultAbsolutePath(vaultEntry);
        if (await pathExists(candidate)) {
          return { absPath: candidate, source: "vault" };
        }
      }
    } catch {
      /* vault lookup failed, try legacy path */
    }
  }

  // 3. legacy generation.path (老数据兜底)
  if (generation.path) {
    const candidates = [
      path.join(baseDir, generation.path),
      path.join(SSR_BASE, slug, generation.path),
      // generation.path 也可能存绝对路径 (老导入路径写的)
      generation.path,
    ];
    for (const cand of candidates) {
      if (await pathExists(cand)) {
        return { absPath: cand, source: "generation_path" };
      }
    }
  }

  return null;
}

/**
 * 主入口: 给 shot + kind, 返回解出来的绝对路径.
 * 找不到 generation → 抛 no-picked-generation (上层决定走 mock 还是失败)
 * generation 找到但文件丢 → 抛 asset-file-missing (上层只能 collect failed, 绝不 silent mock)
 */
export async function resolvePickedAsset(
  shot: PickedShotLike,
  kind: PickedKind,
  slug: string,
  baseDir: string,
): Promise<ResolvedPickedAsset> {
  const { generation, pickedBy } = pickGenerationEntityFirst(shot, kind);
  const resolved = await resolveGenerationPath(slug, baseDir, generation);
  if (!resolved) {
    throw new PickedAssetUnresolvedError({
      shotId: shot.id,
      kind,
      code: "asset-file-missing",
      reasonZh:
        kind === "video"
          ? `镜头视频文件已丢失（generation: ${generation.generation_id}）— 请重新导入或重新生成`
          : `镜头首帧图片文件已丢失（generation: ${generation.generation_id}）— 请重新导入或重新生成`,
    });
  }
  return {
    absPath: resolved.absPath,
    generationId: generation.generation_id,
    source: resolved.source,
    pickedBy,
    generation,
  };
}

/**
 * 把 reason code 翻成 toC 中文 — UI / manifest / API response 统一从这里取.
 * 铁律 #9 toC 兜底: 暴露给用户的 reason / error / status 不能 underscore_case enum.
 */
export const MOCK_REASON_ZH: Record<string, string> = {
  "no-picked-video-generation": "未选定视频片段",
  "no-picked-first-frame": "未选定首帧图片",
  "asset-file-missing": "视频文件已丢失",
  "rough-mode-no-video": "粗剪模式下使用首帧静态画面",
  "reuse-asset-missing": "复用的旧片段文件已丢失",
  "shot-not-approved": "该镜头尚未审核通过",
};

export function describeMockReason(reason: string): string {
  return MOCK_REASON_ZH[reason] ?? reason;
}
