/**
 * batchStats — 批量生成统计纯函数与共享类型.
 *
 * 从 BatchSeriesDialog 抽离: ProjectSlot / GlobalDefaults / 常量 / 预估计算.
 */

/** 单个项目的参数 — 跟后端 BatchProjectSchema 对齐 */
export interface ProjectSlot {
  id: string; // 本地 React key
  series_title: string;
  inspiration: string;
  episode_count: string; // string 方便清空
  duration_per_episode_sec: string;
  aspect_ratio: string;
  style: string;
  platform: string;
  /** 折叠状态 — 默认关闭 */
  advancedOpen: boolean;
}

/** 全局默认参数 */
export interface GlobalDefaults {
  aspect_ratio: string;
  platform: string;
  style: string;
  duration_per_episode_sec: string;
}

export interface BatchStats {
  totalEpisodes: number;
  unknownEpisodes: number;
  estimateBasis: number;
  estimatedImageBriefsMin: number;
  estimatedImageBriefsMax: number;
}

/** 计算预估总集数与素材图张数 (纯函数).
 *
 *   - 每集典型 2-4 张素材图 (角色 1-2 + 场景 1-2)
 *   - 用户填了集数 → 按真实集数算; 没填 → 按"每部默认 3 集"兜底估
 *   - 真实张数由 AI 在剧本规划时决定, 这里只是粗估
 */
export function computeBatchStats(projects: ProjectSlot[]): BatchStats {
  let totalEpisodes = 0;
  let unknownEpisodes = 0;
  for (const p of projects) {
    const ec = parseInt(p.episode_count, 10);
    if (Number.isFinite(ec) && ec > 0) {
      totalEpisodes += ec;
    } else {
      unknownEpisodes += 1;
    }
  }
  // 未填集数的部, 按每部默认 3 集兜底
  const estimateBasis = totalEpisodes + unknownEpisodes * 3;
  return {
    totalEpisodes,
    unknownEpisodes,
    estimateBasis,
    estimatedImageBriefsMin: estimateBasis * 2,
    estimatedImageBriefsMax: estimateBasis * 4,
  };
}

export const ASPECT_OPTIONS = [
  { value: "", label: "AI 自己决定" },
  { value: "16:9", label: "16:9 横屏" },
  { value: "9:16", label: "9:16 竖屏 (抖音/小红书)" },
  { value: "1:1", label: "1:1 方形" },
  { value: "4:3", label: "4:3 经典" },
  { value: "21:9", label: "21:9 电影宽屏" },
];

export const PLATFORM_OPTIONS = [
  { value: "", label: "AI 自己决定" },
  { value: "bilibili", label: "Bilibili" },
  { value: "douyin", label: "抖音 Douyin" },
  { value: "xhs", label: "小红书 XHS" },
  { value: "youtube", label: "YouTube" },
  { value: "wechat_channels", label: "视频号" },
];
