/**
 * realignSubtitles.ts — 2026-05-26
 *
 * 快速重对齐字幕 (不重合成视频).
 *
 * 痛点: 用户改 Whisper 配置 / 后端字幕对齐逻辑变了 → 必须等几分钟整集合成才能验证.
 *
 * 这条路径: 复用现有 compose 产物 (source_mixed.mp4 + concat_list.txt + vault videos),
 *   从 vault video 抽音轨 → 喂 Whisper → 写新 SRT → 重烧字幕到 final.mp4.
 *
 * 优势:
 *   - 不重做视频拼接 / TTS 合成 / BGM mix / 多规格转码 → 整集 50s 视频 ~30s 搞定 (取决于 Whisper 模型大小)
 *   - 用户能立刻看字幕对齐效果, 不必干等
 *
 * 失败兜底:
 *   - 缺 concat_list / source_mixed / vault video → 显式 400 + reason, 不 silent
 *   - 任一镜 Whisper 失败 → 该镜走 fallback estimate (字符加权 by 视频真长), 其他镜不受影响
 *   - 烧字幕失败 → 不替换 final.mp4, 报错让用户走整集重合成
 *
 * 铁律 #1: 透传 caller signal, 不本地 timeout.
 * 铁律 #3: 失败显式 throw + 路由层 400, 不 silent mock.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { readEpisode, listShots } from "../../api/v2/seriesStore";
import { episodeBase } from "../../api/v2/orchestration/_shared/paths";
import { formatSrtTime, probeAudioDuration } from "../../api/v2/orchestration/_shared/media";
import type { ProgressSink } from "../../api/v2/orchestration/_shared/progressSink";

import { pathExists } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import { alignSubtitlesForAudio } from "../../../../../packages/render/src/subtitleAligner";
import { killProcessTree, registerChildProcess } from "../../../../../packages/render/src/process";
import { probeVideoFile } from "../../../../../packages/render/src/ffprobe";
import { normalizeTransition } from "../../../../../packages/render/src/transitions";
import { burnSubtitles } from "../../../../../packages/providers/src/video/burnSubtitles";
import { stripMentionTokens } from "../../../../../packages/drama/src/mentionParser";

import { safeSrtText, resolveSubtitleCanvas } from "./prepare";

export interface RealignSubtitlesInput {
  slug: string;
  episodeId: string;
}

export interface RealignSubtitlesDeps {
  progress: ProgressSink;
  signal?: AbortSignal;
}

export type RealignSubtitlesResult =
  | { kind: "error"; status: number; body: Record<string, unknown> }
  | { kind: "json"; body: Record<string, unknown> };

/**
 * 从 concat_list.txt 读出每镜对应的 vault video 绝对路径, 顺序跟 shots 一一对应.
 * 旧合成产物的 concat_list 是 ffmpeg concat demuxer 格式: `file 'PATH'` 每行一项.
 */
async function readConcatList(concatListPath: string): Promise<string[]> {
  const raw = await fs.readFile(concatListPath, "utf-8");
  const paths: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("file ")) continue;
    // 兼容 `file 'X'` / `file "X"` / `file X`
    const m = trimmed.match(/^file\s+(['"])(.+)\1$/) ?? trimmed.match(/^file\s+(\S+)$/);
    if (m) paths.push(m[m.length - 1]);
  }
  return paths;
}

/**
 * 从 video 抽音轨为 16kHz mono mp3 喂 Whisper. 跟 tts.ts:extractVideoAudioTrack 同款.
 * 失败 → return null caller 走 fallback estimate.
 */
async function extractAudio(videoPath: string, outputMp3: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffmpeg",
      ["-y", "-i", videoPath, "-vn", "-acodec", "libmp3lame", "-q:a", "4", "-ac", "1", "-ar", "16000", outputMp3],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    registerChildProcess(child); // X7-4: 登记活跃子进程, shutdown 时树杀防孤儿
    if (signal) {
      const onAbort = () => { if (child.pid !== undefined) void killProcessTree(child.pid); }; // X7-3: tree-kill
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-2000); });
    child.on("close", (code) => {
      if (code === 0) resolve(true);
      else { loggerSync().warn(`[realign] extract audio failed code=${code}: ${stderr.slice(-300)}`); resolve(false); }
    });
    child.on("error", () => resolve(false));
  });
}

export async function realignSubtitles(
  input: RealignSubtitlesInput,
  deps: RealignSubtitlesDeps,
): Promise<RealignSubtitlesResult> {
  const baseDir = episodeBase(input.slug, input.episodeId);
  const composeDir = path.join(baseDir, "compose");
  const audioDir = path.join(composeDir, "audio");
  const subtitleDir = path.join(composeDir, "subtitles");
  const concatListPath = path.join(composeDir, "concat_list.txt");
  const sourceMixed = path.join(composeDir, "source_mixed.mp4");
  const sourceFallback = path.join(composeDir, "source.mp4");
  const finalMp4 = path.join(composeDir, "final.mp4");

  // 1. 先决条件验证 — 必须有 concat_list + source mp4 (旧合成产物)
  if (!(await pathExists(concatListPath))) {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "NoComposeProduct", message: "缺 concat_list.txt, 请先点'合成成片'生成一次基础产物再用此快速重对齐" } },
    };
  }
  const sourceForBurn = (await pathExists(sourceMixed)) ? sourceMixed : sourceFallback;
  if (!(await pathExists(sourceForBurn))) {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "NoComposeProduct", message: "缺 source.mp4, 请先完整合成一次再用此快速重对齐" } },
    };
  }

  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) {
    return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };
  }
  const shots = await listShots(input.slug, input.episodeId);
  const videoPaths = await readConcatList(concatListPath);
  if (videoPaths.length === 0) {
    return { kind: "error", status: 400, body: { error: { code: "EmptyConcatList", message: "concat_list.txt 为空" } } };
  }
  if (shots.length !== videoPaths.length) {
    return {
      kind: "error",
      status: 400,
      body: { error: { code: "ShotMismatch", message: `concat_list 视频数 (${videoPaths.length}) 跟 shots (${shots.length}) 不一致, 可能 shots 在合成后被改过. 请点整集重合成` } },
    };
  }

  // 2. 每镜抽音轨 + Whisper 对齐 + 累加全局时间轴
  await fs.mkdir(audioDir, { recursive: true }).catch(() => {});
  await fs.mkdir(subtitleDir, { recursive: true }).catch(() => {});

  const srtLines: string[] = [];
  let globalMs = 0;
  const perShot: Array<{
    shot_id: string;
    align_method: string;
    align_source: "video_track" | "none";
    video_real_duration_sec: number;
    segment_count: number;
  }> = [];

  let alignMethodOverall: "whisper_python" | "whisper_api" | "whisper_local" | "fallback_estimate" = "fallback_estimate";

  // C6 修复 (铁律 #4) + 2026-07-09 audit 补齐 — globalMs 累加必须扣掉 xfade 转场重叠, 且扣减量
  // 与 ffmpegBuilder / 视频 / 音频缩短量逐字一致 (之前硬编码 500ms; C12+C5 后视频/音频按真实
  // transition_duration 缩短, 字幕必须同步, 否则用户设 ≠0.5s 转场时逐镜漂移).
  // 权威来源 = ffmpegBuilder 合成时写的 transition_manifest.json:
  //   - entries[].transition_to_next 已 normalize (含 shot.transition_in + 整集默认转场解析结果);
  //   - entries[].duration_sec 是该边界的转场时长 (= shots[i+1].transition_duration ?? 0.5, 未 clamp).
  //   (整集默认转场是 compose 请求参数 v.data.transition, 不 persist 在 episode 上 → 无法从 episode
  //    重新推导, 必须读这份 manifest.)
  // manifest 缺失 (老产物) → 下方 fallback 到 shots[i+1].transition_in / transition_duration (尽力而为).
  const transitionByShotId = new Map<string, { type: string; rawDurSec: number | undefined }>();
  try {
    const tm = JSON.parse(await fs.readFile(path.join(composeDir, "transition_manifest.json"), "utf-8"));
    if (Array.isArray(tm?.entries)) {
      for (const e of tm.entries) {
        if (e && typeof e.shotId === "string" && typeof e.transition_to_next === "string") {
          const rawDurSec =
            typeof e.duration_sec === "number" && Number.isFinite(e.duration_sec) ? e.duration_sec : undefined;
          transitionByShotId.set(e.shotId, { type: e.transition_to_next, rawDurSec });
        }
      }
    }
  } catch {
    // manifest 缺失/损坏 → 走 shot.transition_in / transition_duration fallback
  }

  // 2026-07-09 audit (铁律 #4) — 预探所有片段真长, 供 xfade 重叠 clamp 用 min(本镜,下镜) 双侧真长
  // (与 ffmpegBuilder / buildXfadeFilterChain transitions.ts:141-145 逐字一致). concat_list 里就是
  // 原合成用的 (已 trim) 片段, 探测结果 == ffmpegBuilder 当时探的值. 探测失败退回 shot.duration_sec.
  const realDurs: number[] = [];
  for (let i = 0; i < shots.length; i++) {
    let d = shots[i].duration_sec || 5;
    try {
      const probe = await probeVideoFile(videoPaths[i], deps.signal);
      if (probe.duration_sec > 0) d = probe.duration_sec;
    } catch {
      // 用 fallback shot.duration_sec
    }
    realDurs.push(d);
  }

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const videoPath = videoPaths[i];
    const rawText = shot.dialogue || shot.voiceover || shot.action || "";
    const text = stripMentionTokens(rawText).trim();

    deps.progress.progress("realign.shot", {
      shot_id: shot.id,
      index: i + 1,
      total: shots.length,
      step: `重对齐 ${i + 1}/${shots.length}`,
    });

    // 真长 (循环前已预探到 realDurs[], 供 clamp 双侧真长复用, 见上方注释)
    const realDurSec = realDurs[i];

    // 抽音轨 + Whisper
    let alignSegments: Array<{ startSec: number; endSec: number; text: string }> = [];
    let alignMethod: "whisper_python" | "whisper_api" | "whisper_local" | "fallback_estimate" = "fallback_estimate";
    let alignSource: "video_track" | "none" = "none";

    if (text) {
      const extractedMp3 = path.join(audioDir, `${shot.id}_realign.mp3`);
      const extractOk = await extractAudio(videoPath, extractedMp3, deps.signal);
      if (extractOk) {
        try {
          const aligned = await alignSubtitlesForAudio(extractedMp3, text, {
            whisperProvider: "auto",
            language: "zh",
            timeoutMs: 120_000,
          });
          alignSegments = aligned.segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text }));
          alignMethod = aligned.method;
          alignSource = "video_track";
          if (alignMethod !== "fallback_estimate") alignMethodOverall = alignMethod;
        } catch (err) {
          loggerSync().warn(`[realign] shot ${shot.id} whisper 失败:`, err);
        }
      }

      // Whisper 没拿到 segments → fallback 字符加权按视频真长分布
      if (alignSegments.length === 0) {
        const sentences = text.split(/(?<=[。！？!?；;，,])/).map((s: string) => s.trim()).filter(Boolean);
        const totalChars = sentences.reduce((sum: number, s: string) => sum + s.length, 0);
        let cursor = 0;
        for (const sent of sentences) {
          const weight = totalChars > 0 ? sent.length / totalChars : 1 / sentences.length;
          const dur = weight * realDurSec;
          alignSegments.push({ startSec: cursor, endSec: cursor + dur, text: sent });
          cursor += dur;
        }
        alignMethod = "fallback_estimate";
      }

      // segments scale 到视频真长 (Whisper 时间戳已是视频内真时间, scale 系数 ≈ 1, 但兜底防 endSec 略超)
      const segMaxEndSec = alignSegments[alignSegments.length - 1].endSec;
      const scale = segMaxEndSec > 0.001 ? Math.min(realDurSec / segMaxEndSec, 1.0) : 1;
      if (alignSource !== "video_track" || Math.abs(scale - 1) > 0.01) {
        alignSegments = alignSegments.map((s) => ({
          startSec: Math.max(0, Math.min(s.startSec * scale, realDurSec)),
          endSec: Math.max(0, Math.min(s.endSec * scale, realDurSec)),
          text: s.text,
        }));
      }

      // 写 SRT entries (累加 globalMs 偏移)
      for (const seg of alignSegments) {
        const srtIdx = srtLines.length / 4 + 1;
        srtLines.push(`${srtIdx}`);
        srtLines.push(`${formatSrtTime(Math.round(seg.startSec * 1000) + globalMs)} --> ${formatSrtTime(Math.round(seg.endSec * 1000) + globalMs)}`);
        srtLines.push(safeSrtText(seg.text));
        srtLines.push("");
      }
    }

    perShot.push({
      shot_id: shot.id,
      align_method: alignMethod,
      align_source: alignSource,
      video_real_duration_sec: Number(realDurSec.toFixed(3)),
      segment_count: alignSegments.length,
    });

    // C6 修复 + 2026-07-09 audit 补齐 (铁律 #4) — 扣 xfade 转场重叠, 扣减量与 ffmpegBuilder / 视频 /
    // 音频缩短量逐字一致 (之前硬编码 -500ms). boundary i→i+1: manifest.get(shots[i].id) 是"从本镜切到
    // 下一镜"的已解析转场 (type = transition_to_next; rawDurSec = ffmpegBuilder 写的转场时长, 即
    // shots[i+1].transition_duration ?? 0.5, 未 clamp). 这里补 clamp 与 buildXfadeFilterChain
    // (transitions.ts:141-145) 同式: min(max(t,0.1), min(本镜真长,下镜真长)-0.05). realign 预知全部片段
    // 路径 → 双侧真长 realDurs[i]/realDurs[i+1] 都拿得到 → 完全逐字一致.
    // manifest 缺失 (老产物) → type/时长退回 shots[i+1] 持久字段 (尽力而为, 整集默认转场不可从 episode 反推).
    let stepMs = Math.round(realDurs[i] * 1000);
    if (i + 1 < shots.length) {
      const manifestEntry = transitionByShotId.get(shot.id);
      const nextTransition = manifestEntry?.type
        ?? normalizeTransition((shots[i + 1] as { transition_in?: string }).transition_in);
      if (nextTransition !== "hard") {
        const rawDur =
          manifestEntry?.rawDurSec ?? (shots[i + 1] as { transition_duration?: number }).transition_duration;
        const safeDur = typeof rawDur === "number" && Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 0.5;
        const cap = Math.max(0.1, Math.min(realDurs[i], realDurs[i + 1]) - 0.05);
        const transDurSec = Math.min(Math.max(safeDur, 0.1), cap);
        stepMs = Math.max(stepMs - Math.round(transDurSec * 1000), 0);
      }
    }
    globalMs += stepMs;
  }

  // 3. 写新 SRT
  const srtPath = path.join(subtitleDir, "final.srt");
  await fs.writeFile(srtPath, srtLines.join("\n"), "utf-8");

  // 4. 更新 alignment_meta.json (用户能 cat 看到效果)
  const alignMetaPath = path.join(subtitleDir, "alignment_meta.json");
  await fs.writeFile(
    alignMetaPath,
    JSON.stringify({
      method: alignMethodOverall,
      generated_at: new Date().toISOString(),
      generated_by: "realign-subtitles-only",
      total_entries: srtLines.length / 4,
      total_duration_ms: globalMs,
      total_video_duration_sec: Number((globalMs / 1000).toFixed(3)),
      aligned_from: "video_track_via_whisper_or_charweight_after_compose",
      per_shot_alignment: perShot,
    }, null, 2),
    "utf-8",
  );

  // 5. 重新烧字幕到 source_mixed → final.mp4
  // 用 episode 时存的 compose_manifest 拿 style / animation / aspect_ratio / safe_zone
  const composeManifestPath = path.join(composeDir, "compose_manifest.json");
  let subtitleStyle = "default";
  let subtitleAnimation: "none" | "fade_in" | "typewriter" = "none";
  let aspectRatio = "9:16";
  let safeZoneBottomPct = 20;
  try {
    const manifest = JSON.parse(await fs.readFile(composeManifestPath, "utf-8"));
    subtitleStyle = manifest.subtitle_style || subtitleStyle;
    subtitleAnimation = manifest.subtitle_animation || subtitleAnimation;
    aspectRatio = manifest.aspect_ratio || aspectRatio;
    safeZoneBottomPct = manifest.subtitle_safe_zone_bottom_pct ?? safeZoneBottomPct;
  } catch {
    // manifest 缺失走默认值
  }
  const canvas = resolveSubtitleCanvas(aspectRatio);

  deps.progress.progress("realign.burn", { episode_id: input.episodeId });

  try {
    await burnSubtitles({
      input_mp4: sourceForBurn,
      srt: srtPath,
      output_mp4: finalMp4,
      style: subtitleStyle,
      animation: subtitleAnimation,
      aspect_ratio: aspectRatio,
      width: canvas.width,
      height: canvas.height,
      safe_zone_bottom_pct: safeZoneBottomPct,
      signal: deps.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    loggerSync().error("[realign] burnSubtitles 失败:", err);
    return {
      kind: "error",
      status: 500,
      body: { error: { code: "BurnFailed", message: `字幕重烧失败: ${msg.slice(0, 200)}` } },
    };
  }

  // 6. 更新 compose_manifest.json 的 align_method (让前端 reload 后字幕对齐卡显示新状态)
  try {
    const manifest = JSON.parse(await fs.readFile(composeManifestPath, "utf-8"));
    manifest.realigned_at = new Date().toISOString();
    manifest.realigned_align_method = alignMethodOverall;
    await fs.writeFile(composeManifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  } catch { /* manifest 没了不影响 */ }

  deps.progress.progress("realign.done", {
    episode_id: input.episodeId,
    align_method: alignMethodOverall,
    total_duration_sec: Number((globalMs / 1000).toFixed(3)),
  });

  return {
    kind: "json",
    body: {
      ok: true,
      episode_id: input.episodeId,
      align_method: alignMethodOverall,
      align_method_reason_zh: alignMethodOverall === "whisper_python"
        ? "Python faster-whisper 本地转写 (逐字精准)"
        : alignMethodOverall === "whisper_api"
          ? "OpenAI Whisper API (逐字精准)"
          : alignMethodOverall === "whisper_local"
            ? "本地 whisper.cpp (逐字精准)"
            : "字符加权估算 (Whisper 不可用, 跟字符数匀分)",
      total_video_duration_sec: Number((globalMs / 1000).toFixed(3)),
      shot_count: shots.length,
      per_shot_alignment: perShot,
      srt_path: `episodes/${input.episodeId}/compose/subtitles/final.srt`,
      final_video_path: `episodes/${input.episodeId}/compose/final.mp4`,
    },
  };
}
