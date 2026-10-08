// T10: Subtitle Lab — template system, style overrides, keyword highlighting
//
// 🟡 2026-05-25 状态: 半成品独立功能 — 后端 routes.ts:335 提供 /subtitle-lab/templates +
//   /subtitle-lab/preview 两 endpoint, 但前端 0 caller. 字幕实验室 UI 设计阶段产物,
//   预留给未来"字幕样式编辑器"页面接入. 跟 compose 主流量 (packages/providers/src/video/
//   burnSubtitles.ts 的 STYLE_MAP) 是独立并行设计 — 主流量预设见 PRODUCT §4.3 B-7
//   (default/cinema/variety/anime/minimal 5 个, force_style 字符串).
//
// 命名差异:
//   - 本文件 SUBTITLE_TEMPLATES: viral_vertical / cinema_bar / variety_show / minimal (4 个, 结构化 object)
//   - burnSubtitles.ts STYLE_MAP: default / cinema / variety / anime / minimal (5 个, force_style 字符串)
//
// 想接前端时: 让 subtitle-lab UI 走本文件 SUBTITLE_TEMPLATES 作可视化编辑, 然后
//   把用户编辑后的 styles 序列化为 force_style 传给后端 compose 路径,
//   不直接复用 burnSubtitles.ts STYLE_MAP 字符串 (两者结构不兼容,转换需要 helper).

export interface SubtitleTemplate {
  id: string;
  name: string;
  name_en: string;
  description: string;
  preview_class: string;
  styles: SubtitleStyles;
}

export interface SubtitleStyles {
  font_name: string;
  font_size: number;
  primary_color: string;
  outline_color: string;
  outline_width: number;
  shadow_color: string;
  shadow_depth: number;
  alignment: "bottom_center" | "bottom_left" | "top_center" | "center";
  margin_bottom: number;
  max_lines: number;
  bold: boolean;
  italic: boolean;
}

export interface SubtitleLine {
  index: number;
  start_ms: number;
  end_ms: number;
  text: string;
  style_overrides?: Partial<SubtitleStyles>;
  keywords?: Array<{ word: string; color: string; scale: number }>;
}

export const SUBTITLE_TEMPLATES: SubtitleTemplate[] = [
  {
    id: "viral_vertical",
    name: "爆款竖屏",
    name_en: "Viral Vertical",
    description: "大字号、粗体、强阴影，适合短视频平台",
    preview_class: "stl-viral",
    styles: {
      font_name: "PingFang SC Bold",
      font_size: 48,
      primary_color: "&H00FFFFFF",
      outline_color: "&H00000000",
      outline_width: 3,
      shadow_color: "&H80000000",
      shadow_depth: 3,
      alignment: "bottom_center",
      margin_bottom: 120,
      max_lines: 2,
      bold: true,
      italic: false,
    },
  },
  {
    id: "cinema_bar",
    name: "电影长条",
    name_en: "Cinema Bar",
    description: "优雅、窄字幕条，适合电影感视频",
    preview_class: "stl-cinema",
    styles: {
      font_name: "Noto Serif SC",
      font_size: 28,
      primary_color: "&H00E8E0D0",
      outline_color: "&H00101010",
      outline_width: 2,
      shadow_color: "&H40000000",
      shadow_depth: 2,
      alignment: "bottom_center",
      margin_bottom: 80,
      max_lines: 1,
      bold: false,
      italic: false,
    },
  },
  {
    id: "variety_show",
    name: "综艺包装",
    name_en: "Variety Show",
    description: "彩色描边、活泼动感，适合娱乐内容",
    preview_class: "stl-variety",
    styles: {
      font_name: "PingFang SC Medium",
      font_size: 36,
      primary_color: "&H0000CCFF",
      outline_color: "&H00FFFFFF",
      outline_width: 4,
      shadow_color: "&H800000FF",
      shadow_depth: 4,
      alignment: "bottom_center",
      margin_bottom: 100,
      max_lines: 2,
      bold: true,
      italic: false,
    },
  },
  {
    id: "minimal",
    name: "极简",
    name_en: "Minimal",
    description: "轻量、半透明底，适合知识内容",
    preview_class: "stl-minimal",
    styles: {
      font_name: "PingFang SC Regular",
      font_size: 24,
      primary_color: "&H00FFFFFF",
      outline_color: "&H00202020",
      outline_width: 1,
      shadow_color: "&H20000000",
      shadow_depth: 1,
      alignment: "bottom_center",
      margin_bottom: 60,
      max_lines: 2,
      bold: false,
      italic: false,
    },
  },
];

/** Convert internal styles to ASS format */
export function toAssStyle(tpl: SubtitleTemplate, overrides?: Partial<SubtitleStyles>): string {
  const s = { ...tpl.styles, ...overrides };
  const lines = [
    `[V4+ Styles]`,
    `Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding`,
    `Style: Default,${s.font_name},${s.font_size},${s.primary_color},&H00000000,${s.outline_color},&H00000000,${s.bold ? -1 : 0},${s.italic ? -1 : 0},0,0,100,100,0,0,1,${s.outline_width},${s.shadow_depth},2,10,10,${s.margin_bottom},1`,
  ];
  return lines.join("\n");
}

/** Apply keyword highlighting to a subtitle line */
export function highlightKeywords(text: string, keywords: Array<{ word: string; color: string; scale: number }>): string {
  let result = text;
  for (const kw of keywords) {
    const escaped = kw.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tag = `{\\c${kw.color}\\fs${Math.round((kw.scale > 0 ? kw.scale : 1) * 100)}}`;
    result = result.replace(new RegExp(escaped, "g"), `${tag}$&{\\c\\fs}`);
  }
  return result;
}

/** Generate subtitle lab preview data from manifest */
export function generateSubtitlePreview(
  scenes: Array<{ narration_text: string; duration_sec: number }>,
  templateId: string,
  keywordOverrides?: Array<{ word: string; color: string }>,
): { lines: SubtitleLine[]; total_duration_ms: number } {
  const template = SUBTITLE_TEMPLATES.find(t => t.id === templateId) || SUBTITLE_TEMPLATES[3];
  const keywords = keywordOverrides?.map(k => ({ ...k, scale: 1.3 })) || [];
  const lines: SubtitleLine[] = [];
  let cursorMs = 0;

  for (const scene of scenes) {
    const text = scene.narration_text;
    if (!text.trim()) continue;
    const durationMs = Math.round(scene.duration_sec * 1000);
    const chunks = splitTextIntoChunks(text, template.styles.max_lines);

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunkDuration = Math.round(durationMs / chunks.length);
      lines.push({
        index: lines.length,
        start_ms: cursorMs,
        end_ms: cursorMs + chunkDuration,
        text: chunks[ci],
        keywords: keywords.filter(k => chunks[ci].includes(k.word)).map(k => ({ ...k })),
      });
      cursorMs += chunkDuration;
    }
  }

  return { lines, total_duration_ms: cursorMs };
}

function splitTextIntoChunks(text: string, _maxLines: number): string[] {
  // Split by punctuation for subtitle-friendly chunks (~15 chars per line)
  const clean = text.replace(/\s+/g, "").trim();
  const sentences = clean.split(/(?<=[，。！？、,\.!\?])/);
  const chunks: string[] = [];
  let current = "";

  for (const s of sentences) {
    if ((current + s).length > 20 && current.length > 0) {
      chunks.push(current);
      current = s;
    } else {
      current += s;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [clean];
}
