/**
 * 2026-05-20 display_name 体系统一 — 前端 displayName helper.
 *
 * 用户原话:
 *   "所有图片/视频都要重命名前端"
 *   "display_name 体系全工作台: 每张 image/video 可重命名, 不动文件真实名, 全前端用 display_name"
 *   "图片底下的名称要各处同步"
 *
 * 后端已建立单一真理源 (assetMetaRepo + entity.display_name 双写). 前端只读 display_name.
 *
 * 用法:
 *   import { displayNameOf } from "@/lib/displayName";
 *   <span>{displayNameOf(image, providerLabel)}</span>
 *
 * 兼容老数据 (旧 entity 字段名):
 *   - ShotCandidate.user_label
 *   - SeriesVariant.user_note (variant 实体专属)
 *   - VaultEntry.context.note (legacy library)
 *
 * 不允许:
 *   - 暴露 image_id / vault_id / asset_id / generation_id (技术 ID 给用户看 — 铁律 #9 toC 兜底)
 */

export interface HasDisplayName {
  display_name?: string;
  /** @deprecated 老字段, fallback only */
  user_label?: string;
  /** @deprecated 老字段, fallback only */
  user_note?: string;
}

/**
 * 读统一 display_name, 没就走 fallback (provider 名 / 默认名).
 * 老字段 user_label / user_note 作 fallback 链, 保证老数据也能显示.
 */
export function displayNameOf(entity: HasDisplayName | null | undefined, fallback: string = ""): string {
  if (!entity) return fallback;
  const dn = entity.display_name?.trim();
  if (dn) return dn;
  const ul = entity.user_label?.trim();
  if (ul) return ul;
  const un = entity.user_note?.trim();
  if (un) return un;
  return fallback;
}

/**
 * 用在 VaultEntry — display_name 优先, fallback 到 context.note / tags[0] / 上下文类型.
 */
export interface VaultEntryLike {
  display_name?: string;
  tags?: string[];
  context?: {
    shot_id?: string;
    character_id?: string;
    scene_id?: string;
    note?: string;
    user_note?: string;
  };
}

export function vaultEntryTitle(e: VaultEntryLike): string {
  return e.display_name?.trim()
    || e.context?.note?.trim()
    || e.context?.user_note?.trim()
    || e.tags?.[0]
    || (e.context?.shot_id ? "分镜素材" : "")
    || (e.context?.character_id ? "角色素材" : "")
    || (e.context?.scene_id ? "场景素材" : "")
    || "未命名素材";
}
