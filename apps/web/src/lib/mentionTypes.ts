/**
 * mention 素材引用的公共类型，供 ComposeBox / RegenModal 等使用。
 * 原在 MentionSelector.tsx — 2026-05-21 迁出，解耦 type 与组件。
 */

export type MentionAssetKind = "character" | "scene" | "element";

export interface MentionAsset {
  kind: MentionAssetKind;
  id: string;
  name: string;
  /** 缩略图 URL，渲染 list item 时用 */
  thumbnail?: string;
  /** 物件类型（例如"物品/服装"），仅 kind="element" 时存在 */
  elementKindLabel?: string;
  /** 选中具体图片时存在；token 会带 .img:<image_id> */
  imageId?: string;
  /** 发送给生成接口的 asset_id / vault_id */
  refId?: string;
  parentName?: string;
  imageLabel?: string;
  /**
   * 2026-05-19 #6: element 实体卡是否暂无图。
   * 仅 kind=element 且 imageId 不存在（元素实体卡）时有效。
   */
  missingImage?: boolean;
}
