import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir, resolveVideoFormat, type JobLogger, type SceneManifest } from "../../core/src/index";

export async function buildSubtitles(manifest: SceneManifest, jobRoot: string, logger: JobLogger) {
  const subtitlesDir = path.join(jobRoot, "subtitles");
  await ensureDir(subtitlesDir);
  const srtPath = path.join(subtitlesDir, "final.srt");
  const assPath = path.join(subtitlesDir, "final.ass");
  const entries: string[] = [];
  const assEvents: string[] = [];
  // v0.2.4: track cursor in integer milliseconds to avoid float accumulation
  // drift across 17+ scenes and hundreds of cues. Accumulated float error
  // caused audio/subtitle sync to drift by hundreds of ms by the end.
  let cursorMs = 0;
  let index = 1;
  const format = resolveVideoFormat({ resolution: manifest.resolution, aspectRatio: manifest.aspect_ratio });
  for (const scene of manifest.scenes) {
    const duration = scene.actual_duration_sec ?? scene.duration_estimate_sec;
    const previousActual = scene.actual_duration_sec;
    if (previousActual == null) {
      scene.actual_duration_sec = duration;
    }
    const chunks = splitSubtitle(scene.narration_text, { width: format.width, height: format.height });
    const chunkCount = Math.max(1, chunks.length);
    const totalMs = Math.round(duration * 1000);
    const baseChunkMs = Math.floor(totalMs / chunkCount);
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const startMs = cursorMs;
      // Last chunk absorbs any rounding remainder so sum == totalMs exactly.
      const endMs = cursorMs + (i === chunks.length - 1 ? (totalMs - baseChunkMs * (chunkCount - 1)) : baseChunkMs);
      entries.push(`${index}\n${formatSrt(startMs / 1000)} --> ${formatSrt(endMs / 1000)}\n${chunk}\n`);
      assEvents.push(`Dialogue: 0,${formatAss(startMs / 1000)},${formatAss(endMs / 1000)},Default,,0,0,0,,${escapeAss(chunk)}`);
      cursorMs = endMs;
      index += 1;
    }
    scene.subtitle_path = "subtitles/final.srt";
    scene.status = scene.status === "asset_ready" ? "subtitle_ready" : scene.status;
  }
  await fs.writeFile(srtPath, `${entries.join("\n")}\n`, "utf8");
  await fs.writeFile(assPath, renderAss(assEvents, format.width, format.height), "utf8");
  await logger.line(`Subtitles ready: subtitles/final.srt (${entries.length} entries), subtitles/final.ass`);
  return { srtPath, assPath, totalDuration: cursorMs / 1000 };
}

function splitSubtitle(text: string, format?: { width?: number; height?: number }) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [""];

  const w = format?.width ?? 1920;
  const h = format?.height ?? 1080;
  const isVertical = h > w;
  const isSquare = Math.abs(h - w) < 100;
  const maxCharsPerLine = isVertical ? 20 : isSquare ? 28 : 34;
  const maxLinesPerCue = isVertical ? 3 : isSquare ? 4 : 6;

  // Step 1: Split into sentences
  const sentences = clean.split(/(?<=[。！？!?；;])/).map((item) => item.trim()).filter(Boolean);
  const source = sentences.length > 0 ? sentences : [clean];

  // Step 2: Build lines with hard wrap per maxCharsPerLine, preserve all content
  const lines: string[] = [];
  for (const sentence of source) {
    const wrapped = hardWrapLine(sentence, maxCharsPerLine);
    lines.push(...wrapped);
  }
  if (lines.length === 0) lines.push("");

  // Step 3: Group lines into cues, each with at most maxLinesPerCue
  const cues: string[] = [];
  for (let i = 0; i < lines.length; i += maxLinesPerCue) {
    cues.push(lines.slice(i, i + maxLinesPerCue).join("\n"));
  }
  return cues;
}

function hardWrapLine(text: string, maxChars: number): string[] {
  const chars = [...text];
  const result: string[] = [];
  let current = "";
  for (const char of chars) {
    if ([...current].length >= maxChars) {
      result.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) result.push(current);
  return result.length > 0 ? result : [""];
}

function formatSrt(seconds: number) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hour = Math.floor(totalMin / 60);
  return `${pad(hour)}:${pad(min)}:${pad(sec)},${ms.toString().padStart(3, "0")}`;
}

function formatAss(seconds: number) {
  const totalCs = Math.max(0, Math.round(seconds * 100));
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hour = Math.floor(totalMin / 60);
  return `${hour}:${pad(min)}:${pad(sec)}.${cs.toString().padStart(2, "0")}`;
}

function renderAss(events: string[], width = 1920, height = 1080) {
  const baseFontSize = Math.round(Math.min(width, height) * 0.04);
  const fontSize = Math.max(28, Math.min(64, baseFontSize));
  const marginH = Math.round(width * 0.0625);
  const marginV = Math.round(height * 0.067);
  const outline = Math.max(1, Math.round(fontSize * 0.045));
  const shadow = Math.round(fontSize * 0.023);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Microsoft YaHei,${fontSize},&H00FFFFFF,&H00FFFFFF,&H40352A22,&H66000000,0,0,0,0,100,100,0,0,1,${outline},${shadow},2,${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

function escapeAss(text: string) {
  // v0.2.4: backslashes must be escaped first, otherwise subsequent \{ / \N
  // replacements get re-interpreted by ASS (e.g. `\N`/`\h` style tags leak
  // through user narration text).
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

function pad(value: number) {
  return value.toString().padStart(2, "0");
}
