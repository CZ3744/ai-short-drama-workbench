/**
 * B-7: 字幕样式预设
 * 前端用于选择器展示，后端 burnSubtitles 通过 style id 应用对应 ASS 样式头。
 */

export interface SubtitleStylePreset {
  id: string;
  label: string;
  description: string;
  animation: SubtitleAnimation;
  /** 竖屏默认底部安全区比例，横屏在使用端按画幅收窄到 5%。 */
  safe_zone_bottom_pct: number;
  /** 预览颜色（前端展示用） */
  preview_color: string;
}

export type SubtitleAnimation =
  | "none"
  | "fade_in"
  | "typewriter"
  | "slide_up"
  | "slide_down"
  | "scale_up"
  | "bounce"
  | "glow"
  | "karaoke"
  | "shake";

export const SUBTITLE_ANIMATIONS: Array<{ id: SubtitleAnimation; label: string; description: string }> = [
  { id: "none", label: "无动画", description: "字幕直接出现,最稳妥" },
  { id: "fade_in", label: "淡入", description: "每句字幕轻微淡入,适合剧情类" },
  { id: "typewriter", label: "打字机", description: "从左到右揭示字幕,适合口播/悬念" },
  { id: "slide_up", label: "上滑入", description: "字幕从画面底部滑入到位,适合短视频" },
  { id: "slide_down", label: "下滑入", description: "字幕从画面上方滑入到位,适合注释字幕" },
  { id: "scale_up", label: "缩放出现", description: "从小到大弹出,适合综艺/强调" },
  { id: "bounce", label: "弹跳", description: "字幕从下方弹入,适合活泼风格" },
  { id: "glow", label: "发光描边", description: "金色描边渐隐,适合古风/高燃" },
  { id: "karaoke", label: "卡拉OK", description: "逐字高亮填充,适合唱歌/朗诵" },
  { id: "shake", label: "抖动强调", description: "入场时小幅抖动,适合震惊/搞笑" },
];

export const SUBTITLE_PRESETS: SubtitleStylePreset[] = [
  {
    id: "default",
    label: "默认(简约白)",
    description: "白字 + 黑描边，适合大多数场景",
    animation: "none",
    safe_zone_bottom_pct: 20,
    preview_color: "#ffffff",
  },
  {
    id: "cinema",
    label: "影视风(典雅白衬底)",
    description: "白字 + 半透明黑底，适合剧情/纪录片",
    animation: "fade_in",
    safe_zone_bottom_pct: 20,
    preview_color: "#f0f0f0",
  },
  {
    id: "variety",
    label: "综艺风(粗大彩色)",
    description: "黄字 + 粗黑描边，大气醒目，适合综艺/Vlog",
    animation: "typewriter",
    safe_zone_bottom_pct: 20,
    preview_color: "#fff500",
  },
  {
    id: "anime",
    label: "动漫风(蓝描边)",
    description: "白字 + 蓝描边，适合二次元/动漫",
    animation: "fade_in",
    safe_zone_bottom_pct: 20,
    preview_color: "#99ccff",
  },
  {
    id: "minimal",
    label: "极简(细线无衬底)",
    description: "细字无描边，适合 Vlog/创作类",
    animation: "none",
    safe_zone_bottom_pct: 20,
    preview_color: "#eeeeee",
  },
  {
    id: "custom",
    label: "自定义",
    description: "自由调字体/字号/字色/描边，适合有明确风格需求的创作者",
    animation: "fade_in",
    safe_zone_bottom_pct: 20,
    preview_color: "#c084fc",
  },
];

/** 自定义字幕样式参数 — 用户可调, 保存在 episode 或 project 级别 */
export interface CustomSubtitleStyle {
  font_family?: string;
  font_size?: number;
  color?: string;
  stroke_color?: string;
  stroke_width?: number;
  bg_color?: string;
  bg_opacity?: number;
  position?: "bottom" | "top" | "center";
}

/** 自定义字幕默认值 */
export const CUSTOM_SUBTITLE_DEFAULTS: Required<CustomSubtitleStyle> = {
  font_family: "Noto Sans SC",
  font_size: 42,
  color: "#ffffff",
  stroke_color: "#000000",
  stroke_width: 2,
  bg_color: "#000000",
  bg_opacity: 0.5,
  position: "bottom",
};

export type SubtitleStyleId = "default" | "cinema" | "variety" | "anime" | "minimal" | "custom";

/** 根据 id 查找预设 */
export function findSubtitlePreset(id: string): SubtitleStylePreset | undefined {
  return SUBTITLE_PRESETS.find((p) => p.id === id);
}

export function subtitleSafeZoneBottomPct(
  aspectRatio?: string,
  preset?: SubtitleStylePreset,
): number {
  if (aspectRatio === "16:9") return 5;
  if (aspectRatio === "1:1") return 12;
  return preset?.safe_zone_bottom_pct ?? 20;
}
