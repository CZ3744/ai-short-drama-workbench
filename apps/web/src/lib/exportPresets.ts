/**
 * B-6: 多平台导出预设
 * 前端 + 后端均可 import 使用。
 * format_id 与 packages/render/src/multiFormatExporter.ts FORMAT_PRESETS 的 key 一一对应。
 *
 * 2026-05-29 P0-4: 预设 4 → 10 个, 按平台分组 (audit docs/audit/2026-05-28_compose-competitive.md P0-4).
 *   - 旧 4 个 id 全部保留 (向后兼容用户 localStorage 选择): 1080p_16x9 / 1080p_9x16 / 720p_1x1 / gif_10fps
 *   - 新增 6 个: 快手 / 小红书 3:4 / YouTube Shorts / TikTok / B 站高码率 60fps / 4K
 *   - 每个 preset 加 group_label, ExportPanel 按它分组渲染 chip (10 个塞不下一行).
 */

/** 平台分组标签 — ExportPanel 按它把 chip 分组渲染 (小标题 + chip 行) */
export type ExportGroupLabel = "抖音系" | "YouTube海外" | "中长视频" | "社交" | "预览";

export interface ExportPreset {
  /** 与后端 FORMAT_PRESETS key 对应 */
  id: string;
  label: string;
  description: string;
  aspect_ratio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  resolution: { width: number; height: number };
  bitrate?: string;
  format: "mp4" | "gif" | "webm";
  fps?: number;
  platform_hint: string;
  /** 2026-05-29 P0-4: 平台分组 — chip 按此分块渲染 */
  group_label: ExportGroupLabel;
}

// 2026-05-28 深度打磨 #4: label 改"平台 + 比例" 两段式 — 让用户一眼看到投哪平台,
// 不再"竖版短视频"这种抽象规格名 (用户得映射"竖版 = 抖音"). 竞品 (剪映/即创/智影) 都直接列
// 平台名而不是抽象规格. platform_hint 仍保留作 desc 显完整覆盖列表.
// 2026-05-29 P0-4: 扩到 10 个, 加 group_label 按平台分组. 旧 4 个 id 不动 (localStorage 兼容).
export const EXPORT_PRESETS: ExportPreset[] = [
  // ── 抖音系 (竖屏 9:16) ──────────────────────────────────────────────
  {
    id: "1080p_9x16",
    label: "抖音 / 视频号",
    description: "竖屏 1080×1920 · 6Mbps",
    aspect_ratio: "9:16",
    resolution: { width: 1080, height: 1920 },
    bitrate: "6M",
    format: "mp4",
    fps: 30,
    platform_hint: "抖音 / 微信视频号 / Reels",
    group_label: "抖音系",
  },
  {
    id: "kuaishou_9x16",
    label: "快手",
    description: "竖屏 1080×1920 · 8Mbps",
    aspect_ratio: "9:16",
    resolution: { width: 1080, height: 1920 },
    bitrate: "8M",
    format: "mp4",
    fps: 30,
    platform_hint: "快手 (码率略高于抖音, 画质更稳)",
    group_label: "抖音系",
  },
  // ── YouTube 海外 (竖屏 9:16) ────────────────────────────────────────
  {
    id: "youtube_shorts_9x16",
    label: "YouTube Shorts",
    description: "竖屏 1080×1920 · 8Mbps",
    aspect_ratio: "9:16",
    resolution: { width: 1080, height: 1920 },
    bitrate: "8M",
    format: "mp4",
    fps: 30,
    platform_hint: "YouTube Shorts (海外短视频)",
    group_label: "YouTube海外",
  },
  {
    id: "tiktok_9x16",
    label: "TikTok",
    description: "竖屏 1080×1920 · 8Mbps",
    aspect_ratio: "9:16",
    resolution: { width: 1080, height: 1920 },
    bitrate: "8M",
    format: "mp4",
    fps: 30,
    platform_hint: "TikTok (海外短视频)",
    group_label: "YouTube海外",
  },
  // ── 中长视频 (横屏 16:9) ────────────────────────────────────────────
  {
    id: "1080p_16x9",
    label: "B 站 / YouTube",
    description: "横屏 1920×1080 · 8Mbps",
    aspect_ratio: "16:9",
    resolution: { width: 1920, height: 1080 },
    bitrate: "8M",
    format: "mp4",
    fps: 30,
    platform_hint: "B 站 / YouTube / 微博横版",
    group_label: "中长视频",
  },
  {
    id: "bilibili_hq_16x9",
    label: "B 站高码率 60fps",
    description: "横屏 1920×1080 · 16Mbps · 60fps",
    aspect_ratio: "16:9",
    resolution: { width: 1920, height: 1080 },
    bitrate: "16M",
    format: "mp4",
    fps: 60,
    platform_hint: "B 站游戏 / 电影解说类高画质投稿",
    group_label: "中长视频",
  },
  {
    id: "4k_16x9",
    label: "4K 超清",
    description: "横屏 3840×2160 · 40Mbps",
    aspect_ratio: "16:9",
    resolution: { width: 3840, height: 2160 },
    bitrate: "40M",
    format: "mp4",
    fps: 30,
    platform_hint: "YouTube 4K / B 站 4K (源画质不足时上采样)",
    group_label: "中长视频",
  },
  // ── 社交 ────────────────────────────────────────────────────────────
  {
    id: "xiaohongshu_3x4",
    label: "小红书",
    description: "竖屏 1080×1440 · 6Mbps",
    aspect_ratio: "3:4",
    resolution: { width: 1080, height: 1440 },
    bitrate: "6M",
    format: "mp4",
    fps: 30,
    platform_hint: "小红书原生 3:4 竖版偏好",
    group_label: "社交",
  },
  {
    id: "720p_1x1",
    label: "朋友圈 / Instagram",
    description: "方形 1080×1080 · 5Mbps",
    aspect_ratio: "1:1",
    resolution: { width: 1080, height: 1080 },
    bitrate: "5M",
    format: "mp4",
    fps: 30,
    platform_hint: "微信朋友圈 / Instagram / Threads",
    group_label: "社交",
  },
  // ── 预览 ────────────────────────────────────────────────────────────
  {
    id: "gif_10fps",
    label: "GIF 预览",
    description: "压缩 640×360 · 10fps",
    aspect_ratio: "16:9",
    resolution: { width: 640, height: 360 },
    format: "gif",
    fps: 10,
    platform_hint: "微博图床 / 贴吧论坛 / Twitter 预览",
    group_label: "预览",
  },
];

/** 分组渲染顺序 (ExportPanel 用) */
export const EXPORT_GROUP_ORDER: ExportGroupLabel[] = [
  "抖音系",
  "YouTube海外",
  "中长视频",
  "社交",
  "预览",
];

/** 按 group_label 聚合预设, 保持 EXPORT_GROUP_ORDER 顺序 */
export function groupedExportPresets(): Array<{ group: ExportGroupLabel; presets: ExportPreset[] }> {
  return EXPORT_GROUP_ORDER.map((group) => ({
    group,
    presets: EXPORT_PRESETS.filter((p) => p.group_label === group),
  })).filter((g) => g.presets.length > 0);
}

/** 根据 id 查找预设 */
export function findExportPreset(id: string): ExportPreset | undefined {
  return EXPORT_PRESETS.find((p) => p.id === id);
}
