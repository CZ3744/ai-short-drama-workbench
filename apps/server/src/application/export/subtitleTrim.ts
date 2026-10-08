/**
 * subtitleTrim.ts — 2026-07-10 (P1-6)
 *
 * 导出时若用户裁掉片头/片尾 (episode_trim_start_sec / episode_trim_end_sec),
 * 外挂字幕 sidecar (.srt / .ass) 必须跟着视频一起平移/裁剪, 否则用户拿到的
 * 是"视频裁了 6 秒、字幕还停在原时间轴"的错位交付物 (铁律 #4 的最后一公里).
 *
 * 规则 (与 trimEpisodeMp4 的 -ss/-to 语义一致, 窗为原始时间轴上的 [start, end]):
 *   - 完全落在裁剪窗外的条目删除;
 *   - 跨窗首 / 窗尾的条目截断到边界;
 *   - 窗内条目整体时间轴减去 start (窗首 → 0), 永不产生负时间;
 *   - SRT 重新编号 1..N。
 *   - trimEndSec === undefined (或 <= start) 表示"裁到片尾", 窗尾无限。
 *
 * SRT 时间码解析/格式化复用仓库既有的 parseSrtTimeToSec / formatSrtTime
 * (packages 侧同一份实现), 不手搓新正则。ASS 时间码 (H:MM:SS.cs, 厘秒) 仓库
 * 无对外 helper, 在本模块内小范围实现, 与 burnSubtitles 的 formatAssTime 同式。
 */

import { parseSrtTimeToSec, formatSrtTime } from "../../api/v2/orchestration/_shared/media";

// 浮点边界容差 (秒). 避免 rawEnd 恰等于 start 时因浮点误差保留空条目。
const EPS = 1e-4;

interface TrimWindow {
  start: number;
  end: number; // Number.POSITIVE_INFINITY 表示裁到片尾
}

function resolveWindow(trimStartSec: number, trimEndSec: number | undefined): TrimWindow {
  const start = Math.max(0, Number.isFinite(trimStartSec) ? trimStartSec : 0);
  const end =
    trimEndSec !== undefined && Number.isFinite(trimEndSec) && trimEndSec > start
      ? trimEndSec
      : Number.POSITIVE_INFINITY;
  return { start, end };
}

/**
 * 把 SRT 文本按裁剪窗平移/裁剪, 返回新的 SRT 文本。
 * 窗内无字幕时返回空字符串 (合法的空字幕轨)。
 */
export function trimSrtToWindow(
  srtText: string,
  trimStartSec: number,
  trimEndSec: number | undefined,
): string {
  const { start, end } = resolveWindow(trimStartSec, trimEndSec);

  const blocks = srtText
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .filter((b) => b.trim().length > 0);

  const outEntries: string[] = [];
  let outIndex = 1;

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.replace(/\s+$/, ""));
    const timeLineIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIdx < 0) continue;
    const m = lines[timeLineIdx].match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!m) continue;
    const rawStart = parseSrtTimeToSec(m[1]);
    const rawEnd = parseSrtTimeToSec(m[2]);
    const text = lines.slice(timeLineIdx + 1).join("\n").trim();
    if (!text) continue;

    // 窗外剔除: 完全在窗首之前 或 完全在窗尾之后
    if (rawEnd <= start + EPS) continue;
    if (rawStart >= end - EPS) continue;

    // 截断到窗内 + 平移 -start (窗首 → 0, 永不为负)
    const outStartSec = Math.max(rawStart, start) - start;
    const outEndSec = Math.min(rawEnd, end) - start;
    const outStartMs = Math.max(0, Math.round(outStartSec * 1000));
    let outEndMs = Math.round(outEndSec * 1000);
    if (outEndMs <= outStartMs) outEndMs = outStartMs + 1; // 保底非零时长

    outEntries.push(`${outIndex}\n${formatSrtTime(outStartMs)} --> ${formatSrtTime(outEndMs)}\n${text}`);
    outIndex += 1;
  }

  return outEntries.length > 0 ? `${outEntries.join("\n\n")}\n` : "";
}

/** ASS 时间码 "H:MM:SS.cs" → 秒。无法解析返回 null。 */
function parseAssTime(raw: string): number | null {
  const m = raw.trim().match(/^(\d+):(\d{2}):(\d{2})[.:](\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100;
}

/** 秒 → ASS 时间码 "H:MM:SS.cs" (与 burnSubtitles.formatAssTime 同式)。 */
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

/**
 * 把 ASS 文本按裁剪窗平移/裁剪, 返回新的 ASS 文本。
 * 只动 Dialogue 行的 Start/End (第 2、3 字段), 其余行 (Script Info / Styles / 注释)
 * 原样保留; Text 字段里的逗号 / override tag ({\fad(180,80)} 等) 因 split/join
 * 对称而完整保留。窗外 Dialogue 行删除。
 */
export function trimAssToWindow(
  assText: string,
  trimStartSec: number,
  trimEndSec: number | undefined,
): string {
  const { start, end } = resolveWindow(trimStartSec, trimEndSec);

  const lines = assText.replace(/\r/g, "").split("\n");
  const out: string[] = [];

  for (const line of lines) {
    if (!line.startsWith("Dialogue:")) {
      out.push(line);
      continue;
    }
    // Dialogue: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    const parts = line.split(",");
    if (parts.length < 10) {
      out.push(line); // 不认得的格式, 原样保留
      continue;
    }
    const rawStart = parseAssTime(parts[1]);
    const rawEnd = parseAssTime(parts[2]);
    if (rawStart == null || rawEnd == null) {
      out.push(line);
      continue;
    }
    // 窗外剔除
    if (rawEnd <= start + EPS) continue;
    if (rawStart >= end - EPS) continue;

    const outStart = Math.max(rawStart, start) - start;
    const outEnd = Math.min(rawEnd, end) - start;
    parts[1] = formatAssTime(outStart);
    parts[2] = formatAssTime(Math.max(outEnd, outStart + 0.01));
    out.push(parts.join(","));
  }

  return out.join("\n");
}
