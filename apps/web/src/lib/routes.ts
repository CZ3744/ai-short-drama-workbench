/**
 * 路径常量 — 所有前端路由集中管理
 */

export const ROUTES = {
  root: "/",
  studio: "/studio",
  seriesDetail: (slug: string) => `/studio/${slug}`,
  inbox: (slug: string) => `/studio/${slug}/inbox`,
  script: (slug: string, epId?: string) => epId ? `/studio/${slug}/script/${epId}` : `/studio/${slug}/script`,
  storyboard: (slug: string, epId?: string) => epId ? `/studio/${slug}/storyboard/${epId}` : `/studio/${slug}/storyboard`,
  characters: (slug: string) => `/studio/${slug}/characters`,
  characterDetail: (slug: string, charId: string) => `/studio/${slug}/characters/${charId}`,
  scenes: (slug: string) => `/studio/${slug}/scenes`,
  sceneDetail: (slug: string, sceneId: string) => `/studio/${slug}/scenes/${sceneId}`,
  // 统一素材 Element (角色/场景/物品/参考照片). 见 docs/ASSET_MANAGEMENT_REDESIGN.md
  elements: (slug: string) => `/studio/${slug}/elements`,
  elementsByKind: (slug: string, kind: string) => `/studio/${slug}/elements/kind/${kind}`,
  /** 2026-05-26 audit #1: 素材回收站合并到全局 /trash, 不再走 series scope */
  elementsTrash: () => `/trash?tab=elements`,
  elementDetail: (slug: string, elementId: string) => `/studio/${slug}/elements/${elementId}`,
  seriesLibrary: (slug: string) => `/studio/${slug}/library`,
  compose: (slug: string, epId: string) => `/studio/${slug}/compose/${epId}`,
  timeline: (slug: string, epId: string) => `/studio/${slug}/timeline/${epId}`,
  settings: "/settings",
  playground: "/playground",
  /** 2026-05-26 audit #2: /library 合并到 /vault (老路由 redirect) */
  library: "/vault?scope=global",
  vault: "/vault",
  vaultTrash: "/vault?status=trashed",
  // 2026-05-26 audit #4 死代码清理: cockpit / diagnostics / failures / seriesTrash / castDetail
  // 5 个 const 全无 caller (cockpit & diagnostics & failures redirect 到 /status; seriesTrash 跟
  // trashSeries() 重复; casts 列表已删, detail 也没人调). 全部删除, 新代码用 trashSeries() / "/status".
  moodBoard: (slug: string) => `/studio/${slug}/mood-board`,
  /** 2026-05-26 audit #1: 全局垃圾桶替代旧 series 范围 trash */
  trash: () => "/trash",
  trashShots: () => "/trash?tab=shots",
  trashElements: () => "/trash?tab=elements",
  trashSeries: () => "/trash?tab=series",
  seriesInbox: (slug: string) => `/studio/${slug}/inbox`,
} as const;
