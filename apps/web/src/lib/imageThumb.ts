/**
 * imageThumb.ts — 统一图片缩略图 URL 计算
 *
 * 2026-05-20 解耦改造:之前在 ChipDropdown.tsx 和 ReferenceOverridePanel.tsx 各写了
 * 一份 imageThumbUrl,严格违反"看到两份相似实现必须合并"的解耦信仰.
 * 抽到这里,全项目走同一份逻辑.
 *
 * 优先级:
 *   1. image.url       — 已有直链(本地/导入/asset cache)
 *   2. image.asset_id  — 走 /api/v2/series/:slug/assets/:assetId/thumbnail?size=256
 *   3. image.vault_id  — 走 /api/v2/vault/:vaultId/thumbnail?size=256
 *   4. 空串            — 由 caller 渲染 placeholder
 *
 * 参数类型故意宽松为 Partial (只需 url/asset_id/vault_id 任一字段),
 * 方便 caller 传入非完整 ElementImage 对象(如仅有 asset_id 的临时 shape).
 */

/** 缩略图所需的最小 image 字段集合 */
export interface ImageThumbInput {
  url?: string;
  asset_id?: string;
  vault_id?: string;
}

/** 缩略图尺寸 (px) — 默认 256, 调大调小都走同 URL 参数 */
export interface ImageThumbOpts {
  size?: number;
}

export function imageThumbUrl(slug: string, image: ImageThumbInput, opts: ImageThumbOpts = {}): string {
  const size = opts.size ?? 256;
  if (image.url) return image.url;
  if (image.asset_id) return `/api/v2/series/${slug}/assets/${image.asset_id}/thumbnail?size=${size}`;
  if (image.vault_id) return `/api/v2/vault/${image.vault_id}/thumbnail?size=${size}`;
  return "";
}

/**
 * 2026-05-27 — 原图 URL (跟 imageThumbUrl 对称, 但走 /raw 路径不带 size 参数).
 * 用于点击放大预览 / 下载 / 复制图片地址等需要完整分辨率的场景.
 */
export function imageOriginalUrl(slug: string, image: ImageThumbInput): string {
  if (image.url) return image.url;
  if (image.asset_id) return `/api/v2/series/${slug}/assets/${image.asset_id}/raw`;
  if (image.vault_id) return `/api/v2/vault/${image.vault_id}/raw`;
  return "";
}

/**
 * 2026-05-27 同款 bug 第二轮扫: 候选 (ShotCandidate / RejectItem / VaultEntry / 任何
 * 带 vault_id+url 字段的资源) → lightbox 放大时的原图 URL.
 *
 * 跟 imageOriginalUrl 区别 — 优先级反过来:
 *   1. vault_id  — 走 /vault/:id/raw (后端永远存在的原图端点)
 *   2. asset_id  — 走 /assets/:id/raw (无 size 参数)
 *   3. url       — 兜底 (外链/本地导入图直接给的原图)
 *   4. thumbnail — 最后兜底, 至少有个图
 *
 * 为什么不直接用 imageOriginalUrl: candidate.url 在 asset_id-only 路径下是后端
 * resolveCandidateUrl 给的 thumbnail 端点 (非原图), 不能 first-priority 用.
 * vault_id first 让 lightbox 拿到真正完整分辨率.
 *
 * 视频 candidate 也走这个 helper — vault /:id/raw 同时给图和视频, kind 由 caller
 * 自己判断喂给 <img> 或 <video>.
 */
export interface CandidateOriginalInput {
  vault_id?: string;
  asset_id?: string;
  url?: string;
  thumbnail?: string;
}

export function candidateOriginalUrl(slug: string, c: CandidateOriginalInput): string {
  if (c.vault_id) return `/api/v2/vault/${c.vault_id}/raw`;
  if (c.asset_id) return `/api/v2/series/${slug}/assets/${c.asset_id}/raw`;
  return c.url || c.thumbnail || "";
}
