/**
 * Wave 2E — 参考图集组装器 (Reference Image Set Builder)
 *
 * 从角色 reference_image_set、场景 reference_image_set、风格板 mood_board
 * 中组装统一的 reference_images 数组，传给 image provider.generate。
 *
 * 核心规则:
 * - supports_multi_reference=true  → 所有参考图按权重入列
 * - supports_multi_reference=false → 每个来源只取主图 (primary)
 * - locked_seed 从第一个有值的角色收集
 */

// ─── Types ──────────────────────────────────────────────────────────────

/** 最终传给 provider.generate 的单条参考图 */
export interface ReferenceImageEntry {
  asset_id: string;   // 文件绝对路径
  weight?: number;    // 0-1 权重
}

/** 单条参考图的溯源信息 (供前端展示) */
export interface ReferenceImageSource {
  source_type: "character" | "scene" | "mood_board";
  source_id: string;
  source_label: string;
  vault_id: string;
  is_primary: boolean;
}

/**
 * 2026-05-20 P1 红线 #1 + 铁律 0 Entity-first:
 * 参考图解析失败时不再 silent skip, 改成 push 到 missing[]. caller (orchestrator)
 * 拿到后通过 SSE 推 references.missing event, 前端 toast 显示 "X 张参考图未找到,
 * 影响视觉一致性" — 让用户在浏览器看到为什么这次角色像变了个人.
 *
 * reason 枚举:
 *   - vault_not_found: vault_id 在数据库里查不到 (deleted / typo)
 *   - file_missing: vault 记录存在但文件不在盘上 (磁盘清理 / 路径变更)
 *   - resolve_failed: 解析过程抛异常 (权限 / IO 错误等)
 */
export interface ReferenceMissingEntry {
  source_type: "character" | "scene";
  source_id: string;
  source_label: string;
  vault_id: string;
  // 2026-05-20 P1 audit Bug 6: 加 entity_not_resolvable — entity 本身查不到(脏数据 / 占位 entity 未建).
  // 区别于 vault_not_found(entity 在但代表图不存在). 前端按 reason 显示更精确的人话.
  reason: "vault_not_found" | "file_missing" | "resolve_failed" | "entity_not_resolvable";
}

/** 参考图集组装结果 */
export interface BuiltReferenceSet {
  /** 最终传给 provider.generate 的 reference_images */
  images: ReferenceImageEntry[];
  /** 详细来源清单 (供前端展示) */
  sources: ReferenceImageSource[];
  /** 解析失败的参考图清单 (取代旧 silent skip 行为) */
  missing: ReferenceMissingEntry[];
  /** 汇总信息 */
  summary: ReferenceSetSummary;
}

export interface ReferenceSetSummary {
  /** 参考图总数 */
  total: number;
  /** 来自角色的参考图数 */
  character_refs: number;
  /** 来自场景的参考图数 */
  scene_refs: number;
  /** 来自风格板的参考图数 */
  mood_board_refs: number;
  /** 锁定 seed (从角色收集, 如无则为 undefined) */
  locked_seed?: number;
}

/** 角色输入 (最小必需字段) */
export interface CharacterRefInput {
  id: string;
  name: string;
  reference_image_set?: string[];
  locked_seed?: number;
}

/** 场景输入 (最小必需字段) */
export interface SceneRefInput {
  id: string;
  name: string;
  reference_image_set?: string[];
}

/** 风格板参考图 (已解析好 abs_path 的) */
export interface MoodBoardRefInput {
  vault_id: string;
  abs_path: string;
  weight: number;
  note: string;
}

/** buildReferenceSet 的完整输入 */
export interface BuildReferenceSetInput {
  characters: CharacterRefInput[];
  scene?: SceneRefInput | null;
  moodBoardRefs: MoodBoardRefInput[];
  /** provider 是否支持多参考图 */
  supportsMultiReference: boolean;
  /**
   * vault_id → 文件绝对路径 解析器.
   *
   * 返回值约定 (2026-05-20 P1: 把 reason 暴露上来, 让 buildReferenceSet 能 push 到 missing[]):
   *   - string: 解析成功, 返回绝对路径
   *   - null: 旧式失败 (兼容, 推断为 file_missing)
   *   - { ok: false, reason }: 推荐. 明确给出失败原因
   */
  resolveVaultPath: (vaultId: string) => Promise<
    | string
    | null
    | { ok: false; reason: "vault_not_found" | "file_missing" | "resolve_failed" }
  >;
}

// ─── Implementation ────────────────────────────────────────────────────

/**
 * 把 resolveVaultPath 多形态返回值归一化:
 *   - string → { ok: true, path }
 *   - null   → { ok: false, reason: "file_missing" } (兼容旧返回)
 *   - object → 透传
 */
async function tryResolve(
  resolveVaultPath: BuildReferenceSetInput["resolveVaultPath"],
  vaultId: string,
):
  Promise<
    | { ok: true; path: string }
    | { ok: false; reason: "vault_not_found" | "file_missing" | "resolve_failed" }
  >
{
  try {
    const r = await resolveVaultPath(vaultId);
    if (typeof r === "string") return { ok: true, path: r };
    if (r === null) return { ok: false, reason: "file_missing" };
    return r;
  } catch {
    return { ok: false, reason: "resolve_failed" };
  }
}

export async function buildReferenceSet(
  input: BuildReferenceSetInput,
): Promise<BuiltReferenceSet> {
  const images: ReferenceImageEntry[] = [];
  const sources: ReferenceImageSource[] = [];
  const missing: ReferenceMissingEntry[] = [];
  let lockedSeed: number | undefined;

  // ── 1. 角色 reference_image_set ──────────────────────────────

  for (const char of input.characters) {
    const refSet = char.reference_image_set;
    if (!refSet || refSet.length === 0) continue;

    if (input.supportsMultiReference) {
      // 全部入列: primary 权重 0.7, 其余 0.5
      for (let i = 0; i < refSet.length; i++) {
        const vaultId = refSet[i];
        const resolved = await tryResolve(input.resolveVaultPath, vaultId);
        if (!resolved.ok) {
          // 2026-05-20 P1: 不再 silent skip, push 到 missing[] 让 caller 显式 SSE 上报
          missing.push({
            source_type: "character",
            source_id: char.id,
            source_label: char.name,
            vault_id: vaultId,
            reason: resolved.reason,
          });
          continue;
        }

        images.push({ asset_id: resolved.path, weight: i === 0 ? 0.7 : 0.5 });
        sources.push({
          source_type: "character",
          source_id: char.id,
          source_label: char.name,
          vault_id: vaultId,
          is_primary: i === 0,
        });
      }
    } else {
      // 只取主图 (first)
      const vaultId = refSet[0];
      const resolved = await tryResolve(input.resolveVaultPath, vaultId);
      if (resolved.ok) {
        images.push({ asset_id: resolved.path, weight: 0.7 });
        sources.push({
          source_type: "character",
          source_id: char.id,
          source_label: char.name,
          vault_id: vaultId,
          is_primary: true,
        });
      } else {
        missing.push({
          source_type: "character",
          source_id: char.id,
          source_label: char.name,
          vault_id: vaultId,
          reason: resolved.reason,
        });
      }
    }

    // 收集 locked_seed (取第一个有值的角色)
    if (lockedSeed === undefined && char.locked_seed !== undefined) {
      lockedSeed = char.locked_seed;
    }
  }

  // ── 2. 场景 reference_image_set ──────────────────────────────

  if (input.scene) {
    const refSet = input.scene.reference_image_set;
    if (refSet && refSet.length > 0) {
      if (input.supportsMultiReference) {
        for (const vaultId of refSet) {
          const resolved = await tryResolve(input.resolveVaultPath, vaultId);
          if (!resolved.ok) {
            missing.push({
              source_type: "scene",
              source_id: input.scene.id,
              source_label: input.scene.name,
              vault_id: vaultId,
              reason: resolved.reason,
            });
            continue;
          }

          images.push({ asset_id: resolved.path, weight: 0.5 });
          sources.push({
            source_type: "scene",
            source_id: input.scene.id,
            source_label: input.scene.name,
            vault_id: vaultId,
            is_primary: false,
          });
        }
      } else {
        // 只取主图
        const vaultId = refSet[0];
        const resolved = await tryResolve(input.resolveVaultPath, vaultId);
        if (resolved.ok) {
          images.push({ asset_id: resolved.path, weight: 0.5 });
          sources.push({
            source_type: "scene",
            source_id: input.scene.id,
            source_label: input.scene.name,
            vault_id: vaultId,
            is_primary: true,
          });
        } else {
          missing.push({
            source_type: "scene",
            source_id: input.scene.id,
            source_label: input.scene.name,
            vault_id: vaultId,
            reason: resolved.reason,
          });
        }
      }
    }
  }

  // ── 3. 风格板 (mood board) ──────────────────────────────────

  for (const ref of input.moodBoardRefs) {
    images.push({ asset_id: ref.abs_path, weight: ref.weight });
    sources.push({
      source_type: "mood_board",
      source_id: ref.vault_id,
      source_label: ref.note || `风格板 ${ref.vault_id.slice(0, 8)}`,
      vault_id: ref.vault_id,
      is_primary: false,
    });
  }

  // ── 汇总 ─────────────────────────────────────────────────────

  const characterRefs = sources.filter((s) => s.source_type === "character").length;
  const sceneRefs = sources.filter((s) => s.source_type === "scene").length;
  const moodBoardRefs = sources.filter((s) => s.source_type === "mood_board").length;

  return {
    images,
    sources,
    missing,
    summary: {
      total: images.length,
      character_refs: characterRefs,
      scene_refs: sceneRefs,
      mood_board_refs: moodBoardRefs,
      locked_seed: lockedSeed,
    },
  };
}

/**
 * 仅计算参考图数量（不解析 vault 路径），用于前端快速预览。
 * 前端可用此函数根据 Shot 已有数据估算。
 */
export function countReferenceImages(params: {
  characters: Array<{ reference_image_set?: string[] }>;
  scene?: { reference_image_set?: string[] } | null;
  moodBoardCount: number;
  supportsMultiReference: boolean;
}): ReferenceSetSummary {
  let characterRefs = 0;
  let sceneRefs = 0;

  for (const char of params.characters) {
    const refSet = char.reference_image_set;
    if (refSet && refSet.length > 0) {
      characterRefs += params.supportsMultiReference ? refSet.length : 1;
    }
  }

  if (params.scene) {
    const refSet = params.scene.reference_image_set;
    if (refSet && refSet.length > 0) {
      sceneRefs += params.supportsMultiReference ? refSet.length : 1;
    }
  }

  return {
    total: characterRefs + sceneRefs + params.moodBoardCount,
    character_refs: characterRefs,
    scene_refs: sceneRefs,
    mood_board_refs: params.moodBoardCount,
  };
}
