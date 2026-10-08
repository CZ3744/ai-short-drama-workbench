import path from "node:path";
import fs from "node:fs/promises";

import { readEpisode } from "../../api/v2/seriesStore";
import { episodeBase } from "../../api/v2/orchestration/_shared/paths";
import { formatSrtTime, parseSrtTimeToSec } from "../../api/v2/orchestration/_shared/media";

import { pathExists } from "../../../../../packages/core/src/index";

export interface PreviewSubtitlesInput {
  slug: string;
  episodeId: string;
}

export interface SubtitlePreviewLine {
  index: number;
  start: string;
  end: string;
  startSec: number;
  endSec: number;
  text: string;
}

export type PreviewSubtitlesResult =
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "json"; body: Record<string, unknown> };

export async function previewSubtitles(input: PreviewSubtitlesInput): Promise<PreviewSubtitlesResult> {
  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "集不存在" } },
    };
  }

  const baseDir = episodeBase(input.slug, input.episodeId);
  const composeDir = path.join(baseDir, "compose");
  const srtPath = path.join(composeDir, "subtitles", "final.srt");

  if (!(await pathExists(srtPath))) {
    return {
      kind: "error",
      status: 404,
      body: { error: { code: "NotFound", message: "SRT 文件不存在, 请先运行 compose" } },
    };
  }

  const srtContent = await fs.readFile(srtPath, "utf-8");
  const blocks = srtContent.split(/\n{2,}/).filter(Boolean);
  const subtitles: SubtitlePreviewLine[] = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;
    const index = parseInt(lines[0], 10);
    if (isNaN(index)) continue;
    const timeMatch = lines[1].match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})$/);
    if (!timeMatch) continue;
    const text = lines.slice(2).join("\n").trim();
    subtitles.push({
      index,
      start: timeMatch[1],
      end: timeMatch[2],
      startSec: parseSrtTimeToSec(timeMatch[1]),
      endSec: parseSrtTimeToSec(timeMatch[2]),
      text,
    });
  }

  const totalDurationSec = subtitles.length > 0
    ? subtitles[subtitles.length - 1].endSec
    : 0;

  const stats = {
    total_entries: subtitles.length,
    total_duration_sec: Math.round(totalDurationSec * 100) / 100,
    total_duration_formatted: formatSrtTime(Math.round(totalDurationSec * 1000)),
    average_duration_sec: subtitles.length > 0
      ? Math.round((totalDurationSec / subtitles.length) * 100) / 100
      : 0,
    min_duration_sec: subtitles.length > 0
      ? Math.min(...subtitles.map(s => s.endSec - s.startSec))
      : 0,
    max_duration_sec: subtitles.length > 0
      ? Math.max(...subtitles.map(s => s.endSec - s.startSec))
      : 0,
  };

  let alignmentMeta: unknown = null;
  const alignMetaPath = path.join(composeDir, "subtitles", "alignment_meta.json");
  if (await pathExists(alignMetaPath)) {
    try {
      alignmentMeta = JSON.parse(await fs.readFile(alignMetaPath, "utf-8"));
    } catch { /* ignore */ }
  }

  return {
    kind: "json",
    body: {
      ok: true,
      episode_id: input.episodeId,
      srt_content: srtContent,
      subtitles,
      stats,
      alignment_meta: alignmentMeta,
    },
  };
}
