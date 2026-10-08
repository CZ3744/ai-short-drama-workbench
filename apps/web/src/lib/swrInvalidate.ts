/**
 * swrInvalidate — 跨页面 SWR cache 失效 helper
 *
 * 在 plan-storyboard、create-episode、save-script 等关键变更后调用，
 * 让 StudioHome / SeriesDetail / Dashboard 等页面的 SWR cache 立即重新拉取。
 *
 * 2026-05-20 P2 解耦扩展:
 *   - 加 shots / characters / scenes / elements / providers / vault / versions key
 *   - 加 prefix-match helper invalidateByPrefix — 各 caller (含 SSE handler)用 prefix 统一 mutate
 *   - 与 CLAUDE.md 陷阱 #2 一致 (SWR key 跨页面不一致 → SSE mutate 永远不命中)
 */
import { mutate } from "swr";

/**
 * 与各 hook/页面内实际使用的 SWR key 对齐：
 *   StudioHome           → useSWR("studio:series-list", ...)
 *   useSeries            → useSWR(["series", slug], ...)
 *   useSeriesEpisodes    → useSWR(["series", slug, "episodes"], ...)
 *   useEpisode           → useSWR(["episode", slug, epId], ...)
 *   useShots             → useSWR(`shots:${slug}:${epId}`, ...)
 *   useCharacters (element API) → useSWR(`characters:${slug}`, ...)
 *   useScenes (element API)     → useSWR(`scenes:${slug}`, ...)
 *   useUserProviders     → useSWR("user:providers", ...)
 *   useVideoModelInst.   → useSWR("user:video-instances", ...)
 *   Settings/ChatgptOauth→ useSWR("providers:health" | "settings:providers-grouped", ...)
 *   useSeriesAssets      → useSWR(`/api/v2/series/${slug}/assets...`, ...)
 *   ShotReferenceChips   → useSWR(`chip-elements:${slug}`, ...)
 *   GlobalQueuePanel ele → useSWR(`gqp:elements:${slug}`, ...)
 */
export const SWR_KEYS = {
  // ── series / episode 主流量 ──
  seriesList: "studio:series-list",
  series: (slug: string) => ["series", slug] as const,
  seriesEpisodes: (slug: string) => ["series", slug, "episodes"] as const,
  episode: (slug: string, epId: string) => ["episode", slug, epId] as const,
  // ── 分镜列表 (useShots) ──
  shots: (slug: string, epId: string) => `shots:${slug}:${epId}`,
  shotsPrefix: (slug: string) => `shots:${slug}:`,
  // ── entity (createEntityHooks) ──
  characters: (slug: string) => `characters:${slug}`,
  charactersItem: (slug: string, id: string) => `characters-item:${slug}:${id}`,
  scenes: (slug: string) => `scenes:${slug}`,
  scenesItem: (slug: string, id: string) => `scenes-item:${slug}:${id}`,
  // ── element (无统一 hook, 各页面/组件用不同 prefix) ──
  elementsChip: (slug: string) => `chip-elements:${slug}`,
  elementsQueue: (slug: string) => `gqp:elements:${slug}`,
  // ── provider settings ──
  userProviders: "user:providers",
  userVideoInstances: "user:video-instances",
  providersHealth: "providers:health",
  settingsProvidersGrouped: "settings:providers-grouped",
  videoChannels: "video-channels",
} as const;

/** 仅使系列列表失效（StudioHome / Dashboard 用） */
export function invalidateSeriesList(): Promise<any> {
  return mutate(SWR_KEYS.seriesList);
}

/** 使系列列表 + 单系列详情 + 分集列表失效 */
export function invalidateSeries(slug: string): Promise<any> {
  return Promise.all([
    mutate(SWR_KEYS.seriesList),
    mutate(SWR_KEYS.series(slug)),
    mutate(SWR_KEYS.seriesEpisodes(slug)),
  ]);
}

/** 使系列列表 + 单系列 + 分集列表 + 单集详情全部失效 */
export function invalidateEpisode(slug: string, epId: string): Promise<any> {
  return Promise.all([
    mutate(SWR_KEYS.seriesList),
    mutate(SWR_KEYS.series(slug)),
    mutate(SWR_KEYS.seriesEpisodes(slug)),
    mutate(SWR_KEYS.episode(slug, epId)),
  ]);
}

/**
 * 使单 episode 的所有分镜失效 (SSE 触发首帧/视频/重拍 done 用).
 * CLAUDE.md 陷阱 #2: 跨文件 mutate 用 string.startsWith() 匹配,
 * 这是与 useShots key `shots:${slug}:${epId}` 唯一兼容的方式.
 */
export function invalidateShots(slug: string, epId?: string): Promise<any> {
  const promises: Promise<any>[] = [];
  if (epId) {
    promises.push(mutate(SWR_KEYS.shots(slug, epId)));
  } else {
    // 全 series 下所有 epId 的分镜列表 — prefix 匹配
    promises.push(mutate(
      (key) => typeof key === "string" && key.startsWith(SWR_KEYS.shotsPrefix(slug)),
      undefined,
      { revalidate: true },
    ));
  }
  // V-1.6: 同时失效 GQP 的 gqp:shots:* key (GlobalQueuePanel 用 epKeysStr 拼接)
  promises.push(mutate(
    (key) => typeof key === "string" && key.startsWith("gqp:shots:"),
    undefined,
    { revalidate: true },
  ));
  return Promise.all(promises);
}

/** 使指定 slug 下的 character/scene/element 各种缓存全部失效 (素材增删改后调) */
export function invalidateElements(slug: string): Promise<any> {
  return Promise.all([
    mutate(SWR_KEYS.characters(slug)),
    mutate(SWR_KEYS.scenes(slug)),
    mutate(SWR_KEYS.elementsChip(slug)),
    mutate(SWR_KEYS.elementsQueue(slug)),
    // 也 invalidate item 级 (用 prefix-match)
    mutate(
      (key) => typeof key === "string" && (
        key.startsWith(`characters-item:${slug}:`) ||
        key.startsWith(`scenes-item:${slug}:`)
      ),
      undefined,
      { revalidate: true },
    ),
  ]);
}

/** 使所有 provider/settings 相关 cache 失效 (Provider 增删改 / OAuth 状态变更后) */
export function invalidateProviders(): Promise<any> {
  return Promise.all([
    mutate(SWR_KEYS.userProviders),
    mutate(SWR_KEYS.userVideoInstances),
    mutate(SWR_KEYS.providersHealth),
    mutate(SWR_KEYS.settingsProvidersGrouped),
    mutate(SWR_KEYS.videoChannels),
  ]);
}

/**
 * 通用 prefix 匹配 mutate — caller 可传任意 string prefix,
 * 触发所有以该 prefix 开头的 SWR key 失效.
 * 用于 SSE handler 等无法预知具体 key 的场景.
 */
export function invalidateByPrefix(prefix: string): Promise<any> {
  return mutate(
    (key) => typeof key === "string" && key.startsWith(prefix),
    undefined,
    { revalidate: true },
  );
}
