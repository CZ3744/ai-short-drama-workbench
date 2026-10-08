// P5A: burnSubtitles — burn SRT into MP4 via ffmpeg subtitles filter
// Strategy: copy SRT to os.tmpdir() with ulid filename to avoid Unicode/space issues,
// then ffmpeg -vf subtitles=<absolute_srt_path>

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { ulid } from "ulid";

/** B-7: 字幕样式 ID（包含旧的 clean/bold 向后兼容，新增 5 预设） */
export type SubtitleStyleId =
  | "default"
  | "cinema"
  | "variety"
  | "anime"
  | "minimal"
  | "custom"
  | "clean"   // legacy alias → default 样式
  | "bold";   // legacy alias → variety 样式

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

export interface BurnSubtitlesOptions {
  input_mp4: string;
  srt: string;
  output_mp4: string;
  style?: SubtitleStyleId | string;
  animation?: SubtitleAnimation | string;
  /** P1-8 自定义字幕样式参数 — style="custom" 时生效 */
  custom_style?: {
    font_family?: string;
    font_size?: number;
    color?: string;
    stroke_color?: string;
    stroke_width?: number;
    bg_color?: string;
    bg_opacity?: number;
    position?: "bottom" | "top" | "center";
  };
  /** 9:16 / 16:9 / 1:1，用于 ASS PlayRes 和字幕底部安全区。 */
  aspect_ratio?: string;
  /** 显式指定画布宽（用于 ASS PlayResX），覆盖 aspect_ratio 推导。 */
  width?: number;
  /** 显式指定画布高（用于 ASS PlayResY），覆盖 aspect_ratio 推导。 */
  height?: number;
  /** 底部安全区比例；缺省时 9:16=20%、16:9=5%、1:1=12%。 */
  safe_zone_bottom_pct?: number;
  /**
   * 2026-05-27 — abort signal. 之前 burnSubtitles 完全不接 signal, 取消合成时它继续跑
   * 5+ 分钟. 用户合成走到 90%+ 字幕烧录阶段后点取消, 后台 ffmpeg 完全失控.
   */
  signal?: AbortSignal;
}

export async function burnSubtitles(opts: BurnSubtitlesOptions): Promise<void> {
  const { input_mp4, srt, output_mp4, style, animation, signal } = opts;
  const canvas = resolveSubtitleCanvas(opts.aspect_ratio, opts.safe_zone_bottom_pct, opts.width, opts.height);

  // 4C: resolve all paths to absolute form (handles Unicode/spaces)
  const resolvedInput = path.resolve(input_mp4);
  const resolvedSrt = path.resolve(srt);
  const resolvedOutput = path.resolve(output_mp4);

  // Ensure input files exist
  await fs.access(resolvedInput);
  await fs.access(resolvedSrt);

  const mp4Dir = path.dirname(resolvedOutput);
  await fs.mkdir(mp4Dir, { recursive: true });

  // 4C: copy SRT to os.tmpdir() + ulid filename — avoids Unicode/space issues
  // in the path that ffmpeg's subtitles filter must parse.
  const srtCopy = path.join(os.tmpdir(), `${ulid()}.srt`);
  await fs.copyFile(resolvedSrt, srtCopy);
  const assCopy = path.join(os.tmpdir(), `${ulid()}.ass`);

  // 字幕样式走 ASS 文件路径(buildAnimatedAss): effectiveStyle 选预设(default/cinema/variety/
  // anime/minimal/custom), 颜色/字体在 buildAnimatedAss 的 ASS_STYLE_MAP / sanitizeCustomStyle 里处理。
  // 旧 SRT + force_style 路径 2026-05-25 已废弃, 2026-06-01 收尾删净死代码(STYLE_MAP/forceStyle/withForceStyleMarginV)。
  const effectiveStyle = style ?? "default";
  const effectiveAnimation: SubtitleAnimation =
    animation === "fade_in" || animation === "typewriter" ? animation : "none";

  // 4C: use absolute resolved paths for all ffmpeg args
  // This avoids path-escaping issues on Windows with Unicode/spaces.
  const args: string[] = [
    "-y",
    "-i",
    resolvedInput,
  ];

  // Build filter with absolute SRT path (escaped for ffmpeg's filter parser).
  // ffmpeg filter graph escape rules (in order):
  //   1. Windows backslash → forward slash (must be first)
  //   2. Single quote → '\'' (filter graph string delimiter)
  //   3. Colon → \:  (filter option separator)
  //   4. Left/right bracket → \[ \] (stream label delimiters)
  //   5. Comma → \,  (filter chain separator)
  function escapeFilterPath(p: string): string {
    return p
      .replace(/\\/g, "/")        // Windows backslash → forward slash
      .replace(/'/g, "\\'")        // single quote → \' (filter path safe)
      .replace(/:/g, "\\:")       // colon (filter option separator)
      .replace(/\[/g, "\\[")      // left bracket (stream label)
      .replace(/\]/g, "\\]")      // right bracket (stream label)
      .replace(/,/g, "\\,");      // comma (filter chain separator)
  }
  // 2026-05-25 真正解 — 全部走 ASS 路径, 不再用 SRT + force_style hack:
  //   ASS 文件显式 PlayResX/Y = canvas (video) size, MarginV/FontSize 跟 PlayRes 同 space,
  //   字幕位置 = 距底 safe_zone_pct%, 完美对齐前端预览.
  //   原 SRT + force_style 路径走 libass default PlayResY=288, marginV/fontsize 全错位.
  //   buildAnimatedAss(animation="none") applySubtitleAnimation 直接返回 text 不加动画 tag,
  //   兼容静态字幕场景 (line 386).
  const srtText = await fs.readFile(srtCopy, "utf8");
  await fs.writeFile(assCopy, buildAnimatedAss(srtText, effectiveStyle, effectiveAnimation, canvas, opts.custom_style), "utf8");
  const vf = `ass='${escapeFilterPath(assCopy)}'`;
  args.push("-vf", vf);

  // Output settings
  args.push(
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    resolvedOutput,
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    let killed = false;

    // 2026-05-27 — abort signal 监听, 用户取消合成时立刻 SIGKILL ffmpeg.
    // 之前完全失控, 用户合成 90%+ 时点取消还要等 5 分钟才停.
    const onAbort = () => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      reject(new Error("burnSubtitles aborted by signal"));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // 字幕烧录最常见的卡死是 libass 字体回退死循环 + filter_complex 死锁,
    // 给 10 分钟硬上限, 真要更长的视频以 1MB/s 估算也够烧 300 秒长片
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      reject(new Error(`burnSubtitles ffmpeg timeout after 600s: ${stderr.slice(-500)}`));
    }, 600_000);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      // Keep stderr within bounds (ring buffer)
      if (stderr.length > 64_000) {
        stderr = stderr.slice(-32_000);
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fs.unlink(srtCopy).catch(() => {});
      fs.unlink(assCopy).catch(() => {});

      // 2026-05-25: 无条件写完整 stderr log (无论成败), 让用户报字幕没烧时我能看真实 ffmpeg 输出.
      // 写到 output_mp4 同目录的 burn-ffmpeg-stderr.log
      // 修上轮 bug: ESM 文件不能用 require, 改 import { writeFileSync } 静态导入.
      try {
        const logPath = path.join(path.dirname(resolvedOutput), "burn-ffmpeg-stderr.log");
        const logContent = [
          `=== burnSubtitles ffmpeg invoke ===`,
          `时间: ${new Date().toISOString()}`,
          `Exit code: ${code}`,
          `Killed by timeout: ${killed}`,
          `Input: ${resolvedInput}`,
          `Output: ${resolvedOutput}`,
          `SRT (copy in tmp): ${srtCopy}`,
          `Style: ${effectiveStyle}`,
          `Animation: ${effectiveAnimation}`,
          ``,
          `=== Args ===`,
          args.map(a => /[\s,]/.test(a) ? `"${a}"` : a).join(" "),
          ``,
          `=== Full stderr ===`,
          stderr,
        ].join("\n");
        fs.writeFile(logPath, logContent, "utf8").catch(() => {});
      } catch (logErr) { /* log fail 不阻塞 */
        // 静默吞 log 错误, 不影响主流程 resolve/reject
        void logErr;
      }

      if (killed) return; // timeout 已 reject

      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`burnSubtitles ffmpeg exited ${code}: ${stderr.slice(-500)}`)
        );
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      fs.unlink(srtCopy).catch(() => {});
      fs.unlink(assCopy).catch(() => {});
      if (!killed) reject(new Error(`burnSubtitles ffmpeg spawn error: ${err.message}`));
    });
  });
}

interface SrtCue {
  start: number;
  end: number;
  text: string;
}

const ASS_STYLE_MAP: Record<string, string> = {
  default:
    "Style: Default,PingFang SC,56,&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,60,1",
  cinema:
    "Style: Default,PingFang SC,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,0,0,2,60,60,80,1",
  variety:
    "Style: Default,PingFang SC,72,&H0000F5FF,&H00FFFFFF,&H00000000,&H66000000,-1,0,0,0,100,100,0,0,1,5,2,2,60,60,80,1",
  anime:
    "Style: Default,PingFang SC,60,&H00FFFFFF,&H00FFFFFF,&H0099FF00,&H66000000,-1,0,0,0,100,100,0,0,1,4,2,2,60,60,70,1",
  minimal:
    "Style: Default,PingFang SC,44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,60,60,50,1",
  custom:
    "Style: Default,Noto Sans SC,42,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,0,2,60,60,60,1",
  clean:
    "Style: Default,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,40,1",
  bold:
    "Style: Default,Arial,24,&H00FFFFFF,&H00FFFFFF,&H00000000,&H66000000,-1,0,0,0,100,100,0,0,1,3,1,2,30,30,40,1",
};

interface SubtitleCanvas {
  width: number;
  height: number;
  safeZoneBottomPct: number;
  marginV: number;
}

// 2026-05-25 真 root cause + 真正解:
//   原 SRT + force_style 路径走 libass default PlayResY=288, 字幕位置算的是 video pixel
//   (1920*20%=384) 但渲染时被当 288 space → 字幕飞到画面外 / 字号也错位.
//
//   真正解: 不走 SRT + force_style hack 路径, 总是用 ASS 文件 + 显式 PlayResX/Y=video size
//   (buildAnimatedAss 已正确实现, 见下方 line 316-317).
//   ASS 路径下 marginV 用 video pixel 算, 跟 PlayResY 同 space → 字幕位置 100% 跟前端预览一致.
function resolveSubtitleCanvas(aspectRatio?: string, safeZoneBottomPct?: number, explicitWidth?: number, explicitHeight?: number): SubtitleCanvas {
  if (explicitWidth !== undefined && explicitHeight !== undefined) {
    const pct = clampPct(safeZoneBottomPct ?? 20);
    return {
      width: explicitWidth,
      height: explicitHeight,
      safeZoneBottomPct: pct,
      marginV: Math.max(20, Math.round(explicitHeight * pct / 100)),
    };
  }
  const normalized = (aspectRatio || "9:16").trim().replace("x", ":");
  const width = normalized === "16:9" ? 1920 : 1080;
  const height = normalized === "16:9" ? 1080 : normalized === "1:1" ? 1080 : 1920;
  const fallbackPct = normalized === "16:9" ? 5 : normalized === "1:1" ? 12 : 20;
  const pct = clampPct(safeZoneBottomPct ?? fallbackPct);
  return {
    width,
    height,
    safeZoneBottomPct: pct,
    marginV: Math.max(20, Math.round(height * pct / 100)),
  };
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(0, Math.min(40, value));
}

// P1-8 注入防护 + 去重(2026-06-01 收尾自查): 自定义字幕样式参数会拼进逗号分隔的 ASS Style 行 /
// force_style。用户字体名带逗号(CSS 字体栈如 "PingFang SC, sans-serif")/换行/花括号会串字段
// 或注入 ASS 行; 颜色非法会出垃圾。原先 force_style 与 buildAnimatedAss 各有一份未校验的内联拼接,
// 统一在此 sanitize: 字体名去危险字符 + 取首个字体, 颜色严格 hex 校验后转 BGR, 数值 clamp + 防 NaN。
function sanitizeCustomStyle(cs: NonNullable<BurnSubtitlesOptions["custom_style"]>) {
  const font =
    ((cs.font_family ?? "Noto Sans SC").split(",")[0] || "")
      .replace(/[\r\n{}\\]/g, "")
      .trim()
      .slice(0, 64) || "Noto Sans SC";
  const hexToBgr = (hex: string | undefined, def: string): string => {
    const m = (hex ?? "").replace(/[^0-9a-fA-F]/g, "");
    const h = (m.length >= 6 ? m.slice(0, 6) : def).toUpperCase();
    return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
  };
  const clampInt = (n: number | undefined, lo: number, hi: number, def: number): number => {
    const v = typeof n === "number" && Number.isFinite(n) ? n : def;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  };
  const opacity =
    typeof cs.bg_opacity === "number" && Number.isFinite(cs.bg_opacity)
      ? Math.min(1, Math.max(0, cs.bg_opacity))
      : 0.5;
  return {
    font,
    size: clampInt(cs.font_size, 8, 200, 42),
    outlineW: typeof cs.stroke_width === "number" && Number.isFinite(cs.stroke_width)
      ? Math.min(20, Math.max(0, cs.stroke_width)) : 2,
    bgAlpha: Math.round(opacity * 255).toString(16).padStart(2, "0").toUpperCase(),
    align: cs.position === "top" ? 8 : cs.position === "center" ? 5 : 2,
    primary: hexToBgr(cs.color, "FFFFFF"),
    outline: hexToBgr(cs.stroke_color, "000000"),
    bg: hexToBgr(cs.bg_color, "000000"),
  };
}

function withAssStyleMarginV(styleLine: string, marginV: number): string {
  const parts = styleLine.split(",");
  if (parts.length >= 23) {
    parts[21] = String(marginV);
    return parts.join(",");
  }
  return styleLine;
}

export function buildAnimatedAss(
  srtText: string,
  styleId: string,
  animation: SubtitleAnimation,
  canvas: SubtitleCanvas,
  customStyle?: BurnSubtitlesOptions["custom_style"],
): string {
  const { width, height } = canvas;
  const cues = parseSrt(srtText);
  let baseStyle: string;
  if (styleId === "custom" && customStyle) {
    // P1-8: 自定义字幕 — 动态生成 ASS Style 行(经 sanitizeCustomStyle 防注入: 字体名/颜色拼进逗号分隔行)
    const s = sanitizeCustomStyle(customStyle);
    // ASS colors use &HAABBGGRR, so replace the leading alpha instead of appending it.
    const background = `&H${s.bgAlpha}${s.bg.slice(4)}`;
    baseStyle = `Style: Default,${s.font},${s.size},${s.primary},${s.primary},${s.outline},${background},-1,0,0,0,100,100,0,0,1,${s.outlineW},0,${s.align},60,60,60,1`;
  } else {
    baseStyle = ASS_STYLE_MAP[styleId] ?? ASS_STYLE_MAP.default;
  }
  const styleLine = withAssStyleMarginV(baseStyle, canvas.marginV);
  const events = cues.map((cue) => {
    const text = applySubtitleAnimation(sanitizeAssText(cue.text), cue, animation, width, height);
    return `Dialogue: 0,${formatAssTime(cue.start)},${formatAssTime(cue.end)},Default,,0,0,0,,${text}`;
  });
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

function parseSrt(srtText: string): SrtCue[] {
  const blocks = srtText.replace(/\r/g, "").split(/\n\s*\n/g);
  const cues: SrtCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!match) continue;
    cues.push({
      start: parseSrtTime(match[1]),
      end: parseSrtTime(match[2]),
      text: lines.slice(timeIndex + 1).join("\n"),
    });
  }
  return cues;
}

function parseSrtTime(raw: string): number {
  const [hms, msRaw] = raw.replace(",", ".").split(".");
  const [h, m, s] = hms.split(":").map((part) => Number(part));
  const ms = Number((msRaw ?? "0").padEnd(3, "0"));
  return h * 3600 + m * 60 + s + ms / 1000;
}

function formatAssTime(sec: number): string {
  const totalCs = Math.max(0, Math.round(sec * 100));
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function sanitizeAssText(text: string): string {
  return text
    .replace(/\\/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\r/g, "")
    .replace(/\n/g, "\\N");
}

function applySubtitleAnimation(
  text: string,
  cue: SrtCue,
  animation: SubtitleAnimation,
  width: number,
  height: number,
): string {
  const durationMs = Math.max(280, Math.min(1100, Math.round((cue.end - cue.start) * 1000 * 0.45)));
  switch (animation) {
    case "fade_in":
      return `{\\fad(180,80)}${text}`;
    case "typewriter":
      return `{\\clip(0,0,0,${height})\\t(0,${durationMs},\\clip(0,0,${width},${height}))}${text}`;
    case "slide_up":
      // 从下方 30px 滑入到位
      return `{\\move(${width / 2},${height + 30},${width / 2},${height})\\fad(120,60)}${text}`;
    case "slide_down":
      // 从上方 30px 滑入到位
      return `{\\move(${width / 2},${height - 30},${width / 2},${height})\\fad(120,60)}${text}`;
    case "scale_up":
      // 从 60% 放大到 100%, 同时淡入
      return `{\\fscx60\\fscy60\\fad(100,60)\\t(0,${durationMs},\\fscx100\\fscy100)}${text}`;
    case "bounce":
      // 弹跳: 从下方跳入 + 缩放回弹
      return `{\\fscy80\\move(${width / 2},${height + 20},${width / 2},${height})\\t(0,${Math.round(durationMs * 0.5)},\\fscy105)\\t(${Math.round(durationMs * 0.5)},${durationMs},\\fscy100)\\fad(80,60)}${text}`;
    case "glow":
      // 发光描边: 粗边框渐变消失
      return `{\\bord6\\3c&H00FFFF&\\3a&H00&\\fad(60,400)\\t(0,800,\\bord2\\3c&H000000&\\3a&H80&)}${text}`;
    case "karaoke":
      // 卡拉OK: ASS \\kf 逐字填充高亮
      return `{\\kf${Math.round((cue.end - cue.start) * 100)}}${text}`;
    case "shake":
      // 抖动强调: 开头快速小幅抖动
      return `{\\t(0,100,\\pos(${width / 2 - 2},${height}))\\t(100,200,\\pos(${width / 2 + 2},${height}))\\t(200,300,\\pos(${width / 2},${height}))\\fad(60,60)}${text}`;
    default:
      return text;
  }
}
