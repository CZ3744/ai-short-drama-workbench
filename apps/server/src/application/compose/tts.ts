import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { SSR_BASE, episodeBase } from "../../api/v2/orchestration/_shared/paths";
import { formatSrtTime, probeAudioDuration, generateMockVideo } from "../../api/v2/orchestration/_shared/media";
import { sseBroker } from "../../api/v2/sseBroker";
import { loggerSync } from "../../../../../packages/core/src/logger";
import { alignSubtitlesForAudio } from "../../../../../packages/render/src/subtitleAligner";
import { killProcessTree, registerChildProcess } from "../../../../../packages/render/src/process";
import { probeVideoFile } from "../../../../../packages/render/src/ffprobe";
import { normalizeTransition } from "../../../../../packages/render/src/transitions";
import { parseDialogue, resolveVoiceForEmotion } from "../../../../../packages/drama/src/dialogueParser";
// W6 (2026-05-26): cast 层 voice 资产解析 (跨 series 共享, 优先级高于 series-local character.voice_*)
import { resolveEffectiveVoiceForCharacter } from "../cast/effectiveVoice";
import { stripMentionTokens } from "../../../../../packages/drama/src/mentionParser";
import type { ProviderContext } from "../../../../../packages/providers/src/core/types";

import type { ComposeContext, ComposeEpisodeDeps } from "./prepare";
import { safeSrtText } from "./prepare";
import {
  resolvePickedAsset,
  PickedAssetUnresolvedError,
} from "./pickedAssetResolver";

/**
 * 2026-05-25 字幕对齐根因修复 — 用户原话: "字幕烧录根本没对齐视频里的声音".
 *
 * 旧 bug:
 *   SRT 时间戳累加用 alignedMs (TTS 真长) 或 durationMs (shot.duration_sec),
 *   但视频片段真长 (ffprobe) 跟这俩都不一样 (e.g. AI provider 给的 10s 视频 vs
 *   shot.duration_sec=5s vs TTS 4s). 三个时间轴各走各的, 字幕画面音频全错位.
 *
 * 修复 (用户选择: "字幕跟视频画面对齐"):
 *   每个 shot 视频片段处理完后 ffprobe 探真长 → effectiveDurMs.
 *   - globalMs 累加用 effectiveDurMs (不再用 alignedMs / durationMs)
 *   - 字幕 segments 时间戳 scale 到 [0, effectiveDurMs] 内
 *   - audio_mode=tts 时 TTS 在 startMs 投放, 真长可能 < effectiveDur (尾部静音) 或 > (跨界)
 *
 * 兜底: ffprobe 失败 / 视频文件不存在 → 退回 shot.duration_sec (旧行为)
 */
async function probeVideoDurationSafe(filePath: string | null, fallbackSec: number, signal?: AbortSignal): Promise<number> {
  if (!filePath) return fallbackSec;
  try {
    const probe = await probeVideoFile(filePath, signal);
    return probe.duration_sec > 0 ? probe.duration_sec : fallbackSec;
  } catch {
    return fallbackSec;
  }
}

/**
 * 2026-05-25 — 从视频文件抽音轨为 mp3, 供 audio_mode=original 时喂 Whisper 拿真发音节奏.
 *
 * 用户原话 "感觉还是没对齐, 你怎么回事" 后定位:
 *   audio_mode=original 时跳过 TTS 合成 → 没 audio 喂 Whisper → 字幕走 fallback_estimate 字符加权,
 *   字幕只跟视频"总长"对齐, 段内分布按字数, 跟视频里 AI 角色实际说话节奏完全无关.
 *
 * 修: audio_mode=original 时, 从视频片段 -vn -acodec libmp3lame 抽出音轨写 <shotId>_video.mp3,
 * 喂 Whisper → 拿到真实 "这一秒到那一秒说了这句话", 字幕逐字对齐视频原声.
 *
 * 失败兜底: ffmpeg 失败 / 视频无音轨 → 返回 null, caller 走 fallback estimate (老行为, 不阻塞).
 * 铁律 #1: 不本地 timeout, 透传 signal.
 */
async function extractVideoAudioTrack(
  videoPath: string,
  outputMp3Path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y", "-i", videoPath,
        "-vn",                          // 跳过视频流
        "-acodec", "libmp3lame",
        "-q:a", "4",                    // VBR 中等质量, mp3 体积小, Whisper 够用
        "-ac", "1",                     // 单声道, 加速 Whisper
        "-ar", "16000",                 // 16kHz 采样 (Whisper 训练带宽), 进一步减体积
        outputMp3Path,
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    registerChildProcess(child); // X7-4: 登记活跃子进程, shutdown 时树杀防孤儿
    if (signal) {
      const onAbort = () => { if (child.pid !== undefined) void killProcessTree(child.pid); };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-4000);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(outputMp3Path);
      } else {
        loggerSync().warn(`[compose] extract audio track 失败 (code=${code}, video=${path.basename(videoPath)}): ${stderr.slice(-300)}`);
        resolve(null);
      }
    });
    child.on("error", () => resolve(null));
  });
}

/**
 * 2026-07-09 audit (铁律 #4 补齐) — 单个 xfade 转场边界字幕时间轴应扣减的重叠毫秒数.
 *
 * 背景: C12 解锁 shot.transition_duration 可存 + C5 让视频 xfade / 音频 acrossfade 都按真实
 *   transition_duration 缩短后, 字幕若仍硬编码扣 500ms, 用户设 ≠0.5s 转场时长时字幕逐镜漂移.
 *
 * 与 ffmpegBuilder / buildXfadeFilterChain (transitions.ts:141-145) 同源同 clamp, 目标
 *   "字幕扣减量 == 视频 xfade 缩短量 == 音频 acrossfade 缩短量":
 *   - 边界 i→i+1 的转场时长归属"下一镜" (nextTransitionDurationSec = shots[i+1].transition_duration),
 *     与 ffmpegBuilder transitionChainInput[i].transitionDurationSec = transSegments[i+1].transition_duration 一致;
 *   - 缺失 / 非法 (NaN / ≤0) 回退整集默认 0.5s (跟 ffmpegBuilder DEFAULT_TRANSITION_DURATION 一致);
 *   - clamp: min(max(t, 0.1), cap).
 *
 * clamp 上限 cap 的"下镜真长": ffmpegBuilder 用 min(本镜真长, 下镜真长) - 0.05, 但字幕在前向单遍
 *   累加里拿不到"下一镜真长"(下一镜视频要到下一轮才 resolve + 可能 trim + ffprobe, 且本镜 shotStartMs
 *   在 TTS adelay 处就要用). 这里用"本镜真长"作上限: 当下镜时长 ≥ 本镜时长时二者相等 → 逐字一致;
 *   仅当"下镜比本镜短 且 转场时长 > 下镜真长 - 0.05"这种退化场景(转场几乎和下镜等长)才偏差, 且偏差
 *   有界(≤ 转场时长), 真实滑杆常用值(0.3-2s) + 多秒镜头下永不触发. realignSubtitles 走另一路径
 *   (全部片段路径预知) 能拿双侧真长, 已做到完全逐字一致.
 */
function subtitleXfadeOverlapMs(
  nextTransitionDurationSec: number | undefined | null,
  currentRealDurSec: number,
): number {
  const safe =
    typeof nextTransitionDurationSec === "number" &&
    Number.isFinite(nextTransitionDurationSec) &&
    nextTransitionDurationSec > 0
      ? nextTransitionDurationSec
      : 0.5;
  const cap = Math.max(0.1, currentRealDurSec - 0.05);
  const transDurSec = Math.min(Math.max(safe, 0.1), cap);
  return Math.round(transDurSec * 1000);
}

/**
 * 2026-07-10 P1-4 — 单镜 trim 抽公共函数 (主路径 + 部分重合成 reuse 分支共用, 禁复制粘贴).
 * 若 shot 设了 trim_start_sec / trim_end_sec 则 ffmpeg 裁到 [start,end] 区间写 <shotId>_trimmed.mp4.
 * 修 P1-4: 之前 reuse 分支拿的是未裁切原片 → 用户裁掉的废头废尾在部分重合成时全部回归、本镜时长
 *   变回原始长, 拖累后续镜的字幕/分段时间轴. 现在两条路径共用同一裁剪逻辑, 逐帧一致.
 * 失败: push ctx.trimFailures + 返回原 videoPath (不阻塞合成). 铁律 #1: 不本地 timeout, 只透传 signal.
 */
async function trimShotVideoIfNeeded(
  shot: ComposeContext["shots"][number],
  videoPath: string | null,
  videoSource: string,
  ctx: ComposeContext,
  deps: ComposeEpisodeDeps,
): Promise<{ videoPath: string | null; videoSource: string }> {
  if (!videoPath) return { videoPath, videoSource };
  const shotDur = shot.duration_sec || 5;
  const trimStartSec = (shot as { trim_start_sec?: number }).trim_start_sec ?? 0;
  const trimEndSec = (shot as { trim_end_sec?: number }).trim_end_sec ?? shotDur;
  const needsTrim = (trimStartSec > 0.05 || trimEndSec < shotDur - 0.05) && trimEndSec > trimStartSec;
  if (!needsTrim) return { videoPath, videoSource };
  const trimmedPath = path.join(ctx.composeDir, `${shot.id}_trimmed.mp4`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", [
        "-y",
        "-ss", trimStartSec.toFixed(3),
        "-t", (trimEndSec - trimStartSec).toFixed(3),
        "-i", path.resolve(videoPath),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
        "-c:a", "aac", "-b:a", "128k",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        path.resolve(trimmedPath),
      ], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      registerChildProcess(child); // X7-4: 登记活跃子进程, shutdown 时树杀防孤儿
      if (deps.signal) {
        const killOnAbort = () => { if (child.pid !== undefined) void killProcessTree(child.pid); };
        deps.signal.addEventListener("abort", killOnAbort, { once: true });
        child.on("close", () => deps.signal!.removeEventListener("abort", killOnAbort));
      }
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > 32_000) stderr = stderr.slice(-16_000);
      });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`trim ffmpeg exited ${code}: ${stderr.slice(-300)}`));
      });
      child.on("error", reject);
    });
    return { videoPath: trimmedPath, videoSource: `${videoSource}_trimmed` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.trimFailures.push({ shot_id: shot.id, error: msg });
    loggerSync().warn(`[compose] shot ${shot.id} trim 失败,使用未裁切片段:`, err);
    return { videoPath, videoSource };
  }
}

/**
 * 2026-07-10 P1-4 — 每镜逐句字幕对齐结果落盘, 供部分重合成的 reuse 分支复用 (保持逐句一致).
 * 主路径每镜算出的 alignSegments (相对本镜起点的秒, Whisper 逐句 / 字符加权兜底) 落到
 *   subtitles/segments_<shotId>.json; "重合成单镜"时未动的镜从这里读回按本次 shotStartMs 平移,
 *   字幕逐句对齐, 不再退化成"一镜一大条". 读不到 (老数据 / 上一版是 rough) 时 reuse 走整块兜底.
 */
function shotSegmentsFilePath(subtitleDir: string, shotId: string): string {
  return path.join(subtitleDir, `segments_${shotId}.json`);
}

async function persistShotSegments(
  subtitleDir: string,
  shotId: string,
  segments: Array<{ startSec: number; endSec: number; text: string }>,
): Promise<void> {
  try {
    await fs.writeFile(
      shotSegmentsFilePath(subtitleDir, shotId),
      JSON.stringify({
        shot_id: shotId,
        generated_at: new Date().toISOString(),
        segments: segments.map((s) => ({ start_sec: s.startSec, end_sec: s.endSec, text: s.text })),
      }),
      "utf8",
    );
  } catch {
    // 落盘失败不阻塞主流量 — reuse 时读不到会退化整块字幕兜底, 不伪造数据.
  }
}

async function loadShotSegments(
  subtitleDir: string,
  shotId: string,
): Promise<Array<{ startSec: number; endSec: number; text: string }> | null> {
  try {
    const raw = await fs.readFile(shotSegmentsFilePath(subtitleDir, shotId), "utf8");
    const parsed = JSON.parse(raw) as { segments?: Array<{ start_sec: number; end_sec: number; text: string }> };
    if (!parsed?.segments || parsed.segments.length === 0) return null;
    const mapped = parsed.segments
      .filter((s) => typeof s.start_sec === "number" && typeof s.end_sec === "number" && typeof s.text === "string")
      .map((s) => ({ startSec: s.start_sec, endSec: s.end_sec, text: s.text }));
    return mapped.length > 0 ? mapped : null;
  } catch {
    return null;
  }
}

/**
 * Phase 2 — TTS: iterate over every shot, resolve video assets, trim,
 * synthesize TTS audio, align subtitles, and build SRT + video file lists.
 * Mutates ctx in place.
 */
export async function runTtsPhase(
  ctx: ComposeContext,
  deps: ComposeEpisodeDeps,
): Promise<void> {
  // 2026-05-25 — 每镜诊断 (per_shot_alignment) 记到 alignment_meta.json,
  // 用户下次合成出问题 cat 这一个文件就能定位
  const perShotAlignment: Array<{
    shot_id: string;
    shot_duration_sec: number;
    video_real_duration_sec: number | null;
    tts_audio_duration_sec: number | null;
    used_duration_sec: number;
    used_source: "video_real" | "shot_duration_fallback";
    segment_count: number;
    // "reused": X2-3 (A2-4) — 部分重合成里没被重合成的复用镜, 走 reuse 分支不重新对齐, 单独标记。
    align_method: "whisper_api" | "whisper_local" | "whisper_python" | "fallback_estimate" | "skipped" | "reused";
    align_source: "tts_audio" | "video_track" | "none" | "reused";
  }> = [];

  for (let i = 0; i < ctx.shots.length; i++) {
    const shot = ctx.shots[i];
    const shotId = shot.id;
    const rawText2 = ctx.ttsScriptOverride[shot.id] ?? ctx.ttsGlobalOverride ?? (shot.dialogue || shot.voiceover || shot.action || "");
    const text = stripMentionTokens(rawText2);
    const durationMs = (shot.duration_sec || 5) * 1000;

    if (ctx.isPartialRecompose && !ctx.onlyShotIds.has(shotId)) {
      // 2026-05-22 entity-first: 部分重合成 reuse 路径同样走 picked_*_generation_id 主路径.
      // 解析失败 → 收集到 ctx.failedShots (顶层会让 user 看到 toast + 提供"重新导入或跳过"选项),
      // 老 generation.picked 标志位作 legacy fallback (由 resolvePickedAsset 内部处理).
      const reuseKind = ctx.composeMode === "rough" ? "first_frame" : "video";
      let existingVideoPath: string | null = null;
      try {
        const resolved = await resolvePickedAsset(shot, reuseKind, ctx.slug, ctx.baseDir);
        existingVideoPath = resolved.absPath;
      } catch (err) {
        if (err instanceof PickedAssetUnresolvedError) {
          ctx.failedShots.push({
            shot_id: shotId,
            kind: reuseKind,
            code: err.code,
            reason_zh: `复用片段失败：${err.reasonZh}`,
          });
        } else {
          throw err;
        }
        // 仍生成占位 mock 让 SRT 时间轴不错位,但显式标 reason 让用户知道这里是占位.
        existingVideoPath = path.join(ctx.composeDir, `${shotId}_reuse.mp4`);
        ctx.mockShots.push({ shot_id: shotId, reason: "reuse-asset-missing" });
        try { await generateMockVideo(existingVideoPath, shot.duration_sec || 5, ctx.aspectRatio); } catch { existingVideoPath = null; }
      }

      // 2026-07-10 P1-4 — reuse 镜也要 trim (与主路径同款判断, 复用 trimShotVideoIfNeeded 公共函数).
      // 之前 reuse 拿未裁切原片 → 用户裁掉的废头废尾回归、本镜时长回退, 拖累后续镜时间轴. 现补齐.
      let reuseSource = "reuse";
      {
        const trimmed = await trimShotVideoIfNeeded(shot, existingVideoPath, "reuse", ctx, deps);
        existingVideoPath = trimmed.videoPath;
        reuseSource = trimmed.videoSource;
      }

      // 2026-05-26 Fix 8 — 铁律 #4: 字幕 globalMs 累加必须用 ffprobe 真长 (视频片段真长),
      // 严禁用 shot.duration_sec * 1000 (它经常 ≠ AI provider 生成的真实秒数,
      // 50s 视频字幕只到 24s 这种坑就是这么来的). 部分重合成的 reuse 片段也必须走 ffprobe.
      // 注意: 上面已 trim, 这里 probe 的是裁切后片段真长, realDurSec 反映裁切后的时长.
      const fallbackDurSec = shot.duration_sec || 5;
      const realDurSec = await probeVideoDurationSafe(existingVideoPath, fallbackDurSec, deps.signal);
      const realDurMs = Math.max(1, Math.round(realDurSec * 1000));

      // 2026-07-10 修 — reuse 镜在整集时间轴上的起始毫秒快照 (globalMs 累加前),
      // 供多轨主字幕 + TTS 音轨复用按本镜真实位置投放.
      const shotStartMsReuse = ctx.globalMs;
      // X2-3 (A2-4): 记本镜复用了几段字幕, 写进下方 per_shot_alignment 的 segment_count。
      let reuseSegmentCount = 0;
      if (text.trim()) {
        // 2026-07-10 P1-4 — 优先复用上一次合成落盘的逐句对齐 (subtitles/segments_<shotId>.json),
        // 按本镜真长 scale + 本次 shotStartMs 平移, 与整集合成逐句一致; 读不到 (老数据 / 上版 rough)
        // 退化成整条台词按本镜时间轴投放 (老行为兜底). SRT 序号统一走 srtLines.length/4+1 递增计数,
        // 不再用镜头下标 i+1 (跟主路径混用会序号乱序).
        const reusedSegments = await loadShotSegments(ctx.subtitleDir, shotId);
        if (reusedSegments && reusedSegments.length > 0) {
          reuseSegmentCount = reusedSegments.length;
          const maxEnd = reusedSegments[reusedSegments.length - 1].endSec;
          // 若用户两次合成之间改了本镜 trim, realDurSec 会变 → 按新真长重新 scale, 保证不越界.
          const scale = maxEnd > 0.001 ? realDurSec / maxEnd : 1;
          for (const seg of reusedSegments) {
            const segStart = Math.max(0, Math.min(seg.startSec * scale, realDurSec));
            const segEnd = Math.max(0, Math.min(seg.endSec * scale, realDurSec));
            const srtIdx = ctx.srtLines.length / 4 + 1;
            ctx.srtLines.push(`${srtIdx}`);
            ctx.srtLines.push(`${formatSrtTime(Math.round(segStart * 1000) + shotStartMsReuse)} --> ${formatSrtTime(Math.round(segEnd * 1000) + shotStartMsReuse)}`);
            ctx.srtLines.push(safeSrtText(seg.text));
            ctx.srtLines.push("");
            ctx.mainDialogTracks.push({
              startSec: segStart + shotStartMsReuse / 1000,
              endSec: segEnd + shotStartMsReuse / 1000,
              text: safeSrtText(seg.text),
              shot_id: shotId,
            });
          }
        } else {
          // 兜底: 无逐句落盘 → 整条台词按本镜 skip 时间轴投放 (老行为). 多轨字幕模式 render.ts 用
          // ctx.mainDialogTracks 作 ASS 主字幕层, 同步 push 与正常分支一致.
          reuseSegmentCount = 1;
          const srtIdx = ctx.srtLines.length / 4 + 1;
          ctx.srtLines.push(`${srtIdx}`);
          ctx.srtLines.push(`${formatSrtTime(shotStartMsReuse)} --> ${formatSrtTime(shotStartMsReuse + realDurMs)}`);
          ctx.srtLines.push(safeSrtText(text.trim()));
          ctx.srtLines.push("");
          ctx.mainDialogTracks.push({
            startSec: shotStartMsReuse / 1000,
            endSec: (shotStartMsReuse + realDurMs) / 1000,
            text: safeSrtText(text.trim()),
            shot_id: shotId,
          });
        }
        // 2026-07-10 修 (音轨红线) — audio_mode=tts 下 render.ts 的 muxTtsAudio 会用 ctx.ttsAudioSegments
        // 整体替换成片音轨 (-map 0:v -map [aout]); reuse 分支之前不 push → 单镜重合成时只有被重合成那镜
        // 有声, 其余复用镜全程静音. 复用上一版写在 audioDir 的本镜音频 (仍在盘上), 按本镜真实 startMs 投放,
        // 不重新合成 (省钱 + 保持"复用"语义). 文件不存在时 muxTtsAudio 内部 fs.access 会跳过, 不伪造音频.
        if (ctx.audioMode === "tts") {
          ctx.ttsAudioSegments.push({
            shotId,
            absPath: path.join(ctx.audioDir, `${shotId}.mp3`),
            startMs: shotStartMsReuse,
          });
        }
      }
      // 2026-05-27 — partial recompose reuse 分支也要 push shotEffectiveSegments, 之前漏掉
      // 导致部分重合成时, 重的镜有 segments 数据, 复用的镜没. 前端拿到的 array 缺项 →
      // ComposePage:222 segments fallback 那段镜走 shot.duration_sec → 跟真长错位.
      // 2026-07-09 P0 修复 — reuse 分支必须推进 ctx.globalMs. 之前漏了这一步, 导致"部分重合成"
      // (只重合某几镜, 其余走 reuse) 时 globalMs 只被重合成的镜推进; 所有 reuse 镜的字幕与
      // shotEffectiveSegments 全堆在同一偏移, 首个 reuse 镜 segment 起点还为负. render 把这份错 SRT
      // 烧进全长拼接视频 → 字幕/音轨全程错位 (命中铁律 #4 字幕对齐红线, 且 silent 无报错).
      // 旧写法 segStartSec=(globalMs-realDurMs) 本身就假设 globalMs 已推进, 恰印证推进那步丢了.
      // 推进量与主路径一致: 下一镜非 hard 转场则扣掉该转场真实重叠时长 (2026-07-09 audit 由硬编码
      // 500ms 改为真实 transition_duration, 见 subtitleXfadeOverlapMs; 与视频/音频缩短量同源同 clamp).
      const segStartSec = ctx.globalMs / 1000;
      const nextShotReuse = i + 1 < ctx.shots.length ? ctx.shots[i + 1] : null;
      const nextTransRawReuse = ((nextShotReuse as { transition_in?: string } | null)?.transition_in?.trim())
        ? (nextShotReuse as { transition_in?: string }).transition_in
        : (ctx.v.data as { transition?: string }).transition;
      // 2026-07-10 audit 补漏 — rough 草稿走纯 concat 不做 xfade, reuse 分支同主分支一样不能扣转场重叠, 否则字幕逐镜提前漂移.
      const stepMsReuse = (ctx.composeMode !== "rough" && nextShotReuse && normalizeTransition(nextTransRawReuse) !== "hard")
        ? Math.max(realDurMs - subtitleXfadeOverlapMs((nextShotReuse as { transition_duration?: number }).transition_duration, realDurSec), 0)
        : realDurMs;
      ctx.globalMs += stepMsReuse;
      const segEndSec = ctx.globalMs / 1000;
      ctx.shotEffectiveSegments.push({
        shot_id: shotId,
        start_sec: Number(segStartSec.toFixed(3)),
        end_sec: Number(segEndSec.toFixed(3)),
      });

      // X2-3 (A2-4): 部分重合成时复用镜也写一条 per_shot_alignment。之前 reuse 分支在此 continue,
      // 永不到达主路径的 perShotAlignment.push → alignment_meta.json 的 per_shot_alignment 只含被重合成
      // 的 1-2 镜、total_video_duration_sec (= Σ used_duration_sec) 只算那几镜, 而 total_duration_ms
      // (= ctx.globalMs, reuse 分支已推进) 是全集真值 → 同一诊断文件两个总时长自相矛盾, 用户 cat 定位
      // 字幕对齐时只见 1 镜几秒 (真片 50s) 反被误导 (命中"诊断文件撒谎比没有更糟")。
      // 复用镜标 align_method="reused", used_duration_sec=本镜 ffprobe 真长, 使镜数=全集镜数、总时长计全集。
      perShotAlignment.push({
        shot_id: shotId,
        shot_duration_sec: fallbackDurSec,
        video_real_duration_sec: realDurSec > 0 ? Number(realDurSec.toFixed(3)) : null,
        tts_audio_duration_sec: null, // 复用镜不重新探 TTS 音频真长 (复用上版落盘 mp3, 不重合成 TTS)
        used_duration_sec: Number((realDurSec > 0 ? realDurSec : fallbackDurSec).toFixed(3)),
        used_source: realDurSec > 0 ? "video_real" : "shot_duration_fallback",
        segment_count: reuseSegmentCount,
        align_method: "reused",
        align_source: "reused",
      });

      if (existingVideoPath) ctx.videoFiles.push({ shotId, absPath: existingVideoPath, source: reuseSource });
      continue;
    }

    // W7 P1: rough 模式不在外层 for 循环里解析视频片段 — 留给 rough 分支用 generateRoughShotSegment 真实拼接。
    // 外层 for 循环仅负责 TTS 生成 + SRT 对齐(rough/full 共享)。
    let videoPath: string | null = null;
    let videoSource = "mock";

    if (ctx.composeMode !== "rough") {
      // 2026-05-22 entity-first: 主真理源是 shot.picked_video_generation_id (上层 Compose UI 选定).
      // 旧版 `g.picked === true` 是 in-record 标志, 与 picked_video_generation_id 经常不同步
      // (用户 2026-05-22 实测合成黑屏的直接根因), 必须以 shot 级 entity 引用为准.
      // 三种失败模式都不 silent mock:
      //   1. 完全没生成视频 (no-picked-generation) — 仍 mock 占位但显式收集 failedShots, manifest reason 中文人话
      //   2. picked_id 设了但 generation 记录丢失 (generation-not-found) — 收集 failedShots, mock 占位让时间轴对齐
      //   3. generation 找到但文件不存在 (asset-file-missing) — 收集 failedShots, mock 占位
      try {
        const resolved = await resolvePickedAsset(shot, "video", ctx.slug, ctx.baseDir);
        videoPath = resolved.absPath;
        videoSource = resolved.source;
      } catch (err) {
        if (err instanceof PickedAssetUnresolvedError) {
          // 严禁 silent mock: 收集到 failedShots (顶层 response.failed_shots) + mockShots (manifest)
          // 让前端能 toast "镜头 X 的视频文件已丢失,请重新导入或重新生成"
          // 用户可选: 跳过该镜走 mock 占位 / 取消合成回去修.
          // 但合成本身不应 hard fail — 用户可能 5 镜里只丢 1 张, 其他 4 镜应正常合.
          ctx.failedShots.push({
            shot_id: shotId,
            kind: "video",
            code: err.code,
            reason_zh: err.reasonZh,
          });
          ctx.mockShots.push({
            shot_id: shotId,
            reason:
              err.code === "no-picked-generation"
                ? "no-picked-video-generation"
                : err.code === "generation-not-found"
                  ? "generation-record-lost"
                  : "asset-file-missing",
          });
          videoPath = path.join(ctx.composeDir, `${shotId}_mock.mp4`);
          videoSource = "mock_due_to_failure";
          try {
            await generateMockVideo(videoPath, shot.duration_sec || 5, ctx.aspectRatio);
          } catch (mockErr) {
            loggerSync().error(`[compose] mock video failed for ${shotId}:`, mockErr);
            videoPath = "";
          }
        } else {
          throw err;
        }
      }

      // W7 Phase 4: 单镜 trim — 若 shot 设置了 trim_start_sec / trim_end_sec
      // 则把片段裁切为 [trim_start, trim_end] 区间,再加入 concat.
      // 2026-07-10 P1-4 — 裁剪逻辑抽成 trimShotVideoIfNeeded 公共函数, 与部分重合成 reuse 分支复用同一实现
      // (解耦: 两份相似实现合并成一处, 保证主路径与 reuse 镜裁剪逐帧一致).
      {
        const trimmed = await trimShotVideoIfNeeded(shot, videoPath, videoSource, ctx, deps);
        videoPath = trimmed.videoPath;
        videoSource = trimmed.videoSource;
      }

      if (videoPath) ctx.videoFiles.push({ shotId, absPath: videoPath, source: videoSource });
    }

    const audioPath = path.join(ctx.audioDir, `${shotId}.mp3`);
    // 2026-05-22 P0 — 记录本镜在整集时间轴上的起始毫秒 (循环累加 globalMs 之前的快照)。
    // audio_mode="tts" 时 audioMux 用它把 TTS 片段 adelay 到正确位置。
    const shotStartMs = ctx.globalMs;
    let audioGenerated = false;
    let resolvedVoiceForShot: string = ctx.seriesDefaultVoiceId;

    // 2026-05-22 P0 — audio_mode="original" (用视频原声): 跳过 TTS 合成。
    // 字幕生成不受影响 (下方 `if (text.trim())` 分支照常按 shot.duration_sec 估时间轴),
    // 这样"用视频原声 + 烧字幕"是合法组合。rough 模式静态图必须靠 TTS, 不在此跳过。
    const shouldSynthesizeTts = ctx.audioMode !== "original" || ctx.composeMode === "rough";

    if (ctx.ttsProv && text.trim() && shouldSynthesizeTts) {
      // 2026-05-17 voice-sync v2 + W6 (2026-05-26) — Voice resolver 优先级(从高到低):
      //   1. v.data.episode_voice_override  (本次合成全集覆盖, "导出统一音色"路径)
      //   2. shot.tts_voice_override  (单镜级覆盖)
      //   3. v.data.voice_style_map[charId][emotion]  (2026-05-21 V-4 多角色临时覆盖)
      //   4. ★ W6 cast.voice_assets[charId].voice_style_map[emotion]  (cast 层情绪映射)
      //   5. ★ W6 cast.voice_assets[charId].provider_voice_ids[provider]  (cast 层 provider voice)
      //   6. character.voice_style_map[emotion]  (角色情绪映射 — ElementWorkbench 持久配置)
      //   7. character.voice_id  (角色默认声线 — ElementWorkbench 配的)
      //   8. series.defaults.tts_voice_id  (系列默认)
      //   9. getConfigValue("TTS_VOICE", "zh-CN-XiaoxiaoNeural")  (全局默认)
      //
      // ★ cast 层 (4 / 5) 在 series-local 之前: 持续 IP 中 cast.voice_assets 是"权威的"角色配音,
      //   series-local character.voice_* 是"老 series 单独配的"; cast 优先实现跨剧统一. 单镜级 1-3 仍最高
      //   (用户临时调整意图不被 cast 全局覆盖).
      //
      // 2026-05-26 audit #5 — 多角色同镜对白真正用各自 voice (之前只用 dialogueLines[0] 的角色 voice 通管整镜).
      //   工作流: 解析 dialogueLines → 每行 resolve voice → 各自 synthesize 单 mp3 → ffmpeg concat 拼成本镜单 mp3.
      //   单角色 / 无对白 (旁白) 走老路径 (一次 synthesize), 不动. episode_override / shot_override 也短路老路径.
      //   多 voice 拼接简化方案: 顺序串行 (不并行多轨), 保证 ttsAudioSegments[] 仍是一个 mp3, 不破坏现有
      //   render.ts muxTtsAudio 对一镜一音的假设.
      const episodeOverride = (ctx.v.data as { episode_voice_override?: string }).episode_voice_override;
      const dialogueLines = parseDialogue(text);
      const shotOverride = (shot as { tts_voice_override?: string }).tts_voice_override;

      // 决定每行用哪个 voice. episode/shot override > per-line resolve.
      function resolveVoiceForLine(line: { character_name: string; emotion: string | null }): string {
        if (episodeOverride) return episodeOverride;
        if (shotOverride) return shotOverride;
        const charData = ctx.charMap.get(line.character_name);
        const tempOverrideForChar = charData ? ctx.overrideVoiceStyleMap[charData.id] : undefined;
        if (tempOverrideForChar) {
          return resolveVoiceForEmotion(
            tempOverrideForChar,
            line.emotion,
            charData?.voice_id ?? ctx.seriesDefaultVoiceId,
          );
        }
        const resolved = resolveEffectiveVoiceForCharacter({
          shotOverride: undefined,
          character: charData ?? null,
          cast: ctx.cast,
          provider: ctx.ttsProvider,
          emotion: line.emotion,
          seriesDefaultVoiceId: ctx.seriesDefaultVoiceId,
          globalDefault: ctx.seriesDefaultVoiceId,
        });
        return resolved.voice_id;
      }

      // 判断本镜是不是 "多角色对白" — 至少 2 个不同 voice 才拆分合成, 否则走老路径(一次 synthesize).
      const perLineVoices = dialogueLines.map(resolveVoiceForLine);
      const uniqueVoices = new Set(perLineVoices);
      const multiVoiceMode = !episodeOverride && !shotOverride && dialogueLines.length >= 2 && uniqueVoices.size >= 2;

      // resolvedVoiceForShot 保留给 manifest 显示 (单声路径) — 多声路径选 perLineVoices[0] 作为代表展示.
      if (episodeOverride) {
        resolvedVoiceForShot = episodeOverride;
      } else if (shotOverride) {
        resolvedVoiceForShot = shotOverride;
      } else if (perLineVoices.length > 0) {
        resolvedVoiceForShot = perLineVoices[0];
      }

      const providerCtx: ProviderContext = {
        series_slug: ctx.slug,
        job_id: ctx.job_id,
        task_id: ctx.taskId,
        log: (level, msg) => loggerSync()[level](`[compose tts] ${msg}`),
        signal: deps.signal,
      };

      try {
        if (multiVoiceMode) {
          // 多角色对白: 逐行各自 synthesize 单 mp3, 然后 ffmpeg concat 拼成本镜 audioPath.
          const segmentMp3s: string[] = [];
          for (let i = 0; i < dialogueLines.length; i++) {
            const line = dialogueLines[i];
            const voiceId = perLineVoices[i];
            const segPath = path.join(ctx.audioDir, `${shotId}_l${i}.mp3`);
            const lineText = line.text.trim();
            if (!lineText) continue;
            const result = await ctx.ttsProv!.synthesize(
              { text: lineText, voice_id: voiceId, format: "mp3" },
              providerCtx,
            );
            await fs.writeFile(segPath, result.audio.buffer);
            segmentMp3s.push(segPath);
          }
          if (segmentMp3s.length === 0) {
            throw new Error("multi-voice mode 解出 0 行可发声对白");
          }
          // ffmpeg concat demuxer: 写一个 list.txt, 全部 mp3 串成 audioPath (libmp3lame 重编, 兼容性最稳).
          const listPath = path.join(ctx.audioDir, `${shotId}_concat.txt`);
          const listBody = segmentMp3s
            .map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`)
            .join("\n");
          await fs.writeFile(listPath, listBody);
          await new Promise<void>((resolve, reject) => {
            const child = spawn(
              "ffmpeg",
              [
                "-y", "-f", "concat", "-safe", "0",
                "-i", listPath,
                "-acodec", "libmp3lame", "-q:a", "4",
                audioPath,
              ],
              { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
            );
            registerChildProcess(child); // X7-4: 登记活跃子进程, shutdown 时树杀防孤儿
            if (deps.signal) {
              const onAbort = () => { if (child.pid !== undefined) void killProcessTree(child.pid); };
              deps.signal.addEventListener("abort", onAbort, { once: true });
              child.on("close", () => deps.signal!.removeEventListener("abort", onAbort));
            }
            let stderr = "";
            child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-2000); });
            child.on("close", (code) => {
              if (code === 0) resolve();
              else reject(new Error(`ffmpeg concat exit=${code}: ${stderr.slice(-300)}`));
            });
            child.on("error", (e) => reject(e));
          });
          audioGenerated = true;
          ctx.ttsAudioSegments.push({ shotId, absPath: audioPath, startMs: shotStartMs });
          loggerSync().info(
            `[compose tts] shot ${shotId} multi-voice mode: ${dialogueLines.length} lines, ${uniqueVoices.size} voices, concat → ${path.basename(audioPath)}`,
          );
          // 清理临时 list 和 per-line mp3 (audioPath 是最终拼好的)
          try { await fs.unlink(listPath); } catch { /* ignore */ }
          for (const p of segmentMp3s) {
            try { await fs.unlink(p); } catch { /* ignore */ }
          }
        } else {
          // 走老路径: 一次 synthesize. 单角色 / 无对白 / episode/shot override 都在这.
          const result = await ctx.ttsProv!.synthesize(
            { text, voice_id: resolvedVoiceForShot, format: "mp3" },
            providerCtx,
          );
          await fs.writeFile(audioPath, result.audio.buffer);
          audioGenerated = true;
          ctx.ttsAudioSegments.push({ shotId, absPath: audioPath, startMs: shotStartMs });
        }
      } catch (err) {
        // 不 silent fail: 显式收集到 ttsFailures, manifest + response 返回让用户看到
        const msg = err instanceof Error ? err.message : String(err);
        loggerSync().warn(
          `[compose tts] shot ${shotId} voice="${resolvedVoiceForShot}" provider="${ctx.ttsProvider}" 合成失败: ${msg}`,
        );
        ctx.ttsFailures.push({ shot_id: shotId, error: msg });
        ctx.ttsOverallStatus = "failed";
      }
    }

    let alignSegments: Array<{ startSec: number; endSec: number; text: string }> = [];
    let alignMethodForShot: "whisper_api" | "whisper_local" | "whisper_python" | "fallback_estimate" | "skipped" = "skipped";
    let ttsAudioDurSec: number | null = null;
    // 2026-05-25 — 字幕跟哪段音频对齐. tts_audio = 跟 TTS 生成的 mp3 对齐 (audio_mode=tts 推荐);
    // video_track = 从视频文件抽音轨喂 Whisper (audio_mode=original 推荐, 真发音节奏); none = 无音频走 fallback.
    let alignSource: "tts_audio" | "video_track" | "none" = "none";

    if (text.trim()) {
      // 选择喂 Whisper 的音频源:
      //   audio_mode=tts → TTS 生成的 mp3 (字幕跟 TTS 节奏走, 因为 final.mp4 音轨也是 TTS)
      //   audio_mode=original + 有视频文件 → 抽视频音轨喂 Whisper (字幕跟视频里说话节奏走)
      //   两边都没 → fallback estimate
      let whisperAudioPath: string | null = null;
      let whisperAudioDurSec: number | null = null;

      if (audioGenerated && audioPath) {
        whisperAudioPath = audioPath;
        whisperAudioDurSec = (await probeAudioDuration(audioPath)) ?? null;
        alignSource = "tts_audio";
      } else if (ctx.audioMode === "original" && videoPath && ctx.composeMode !== "rough") {
        const extractedPath = path.join(ctx.audioDir, `${shotId}_video.mp3`);
        const ok = await extractVideoAudioTrack(videoPath, extractedPath, deps.signal);
        if (ok) {
          whisperAudioPath = extractedPath;
          whisperAudioDurSec = (await probeAudioDuration(extractedPath)) ?? null;
          alignSource = "video_track";
        }
      }

      if (whisperAudioPath) {
        try {
          const alignResult = await alignSubtitlesForAudio(whisperAudioPath, text, {
            whisperProvider: "auto",
            language: "zh",
            timeoutMs: 120_000,
          });
          alignSegments = alignResult.segments.map((seg) => ({
            startSec: seg.startSec,
            endSec: seg.endSec,
            text: seg.text,
          }));
          alignMethodForShot = alignResult.method;
          if (alignResult.method !== "fallback_estimate") {
            ctx.alignMethodUsed = alignResult.method;
            loggerSync().info(`[compose] shot ${shotId}: Whisper 对齐成功 (${alignResult.method} via ${alignSource}), ${alignSegments.length} 段`);
          }
        } catch (alignErr: unknown) {
          const alignMsg = alignErr instanceof Error ? alignErr.message : String(alignErr);
          loggerSync().warn(`[compose] shot ${shotId}: Whisper 对齐失败 (via ${alignSource}): ${alignMsg}`);
        }
      }

      if (alignSegments.length === 0) {
        const sentences = text.split(/(?<=[。！？!?；;，,])/).map((s: string) => s.trim()).filter(Boolean);
        const totalDurSec = whisperAudioDurSec ?? durationMs / 1000;
        const totalChars = sentences.reduce((sum: number, s: string) => sum + s.length, 0);
        let cursor = 0;
        for (const sent of sentences) {
          const weight = totalChars > 0 ? sent.length / totalChars : 1 / sentences.length;
          const dur = weight * totalDurSec;
          alignSegments.push({ startSec: cursor, endSec: cursor + dur, text: sent });
          cursor += dur;
        }
        alignMethodForShot = "fallback_estimate";
      }

      if (whisperAudioDurSec !== null) ttsAudioDurSec = whisperAudioDurSec;
    }

    // 2026-05-25 字幕对齐根因修复 — 探测视频片段真长, 用它替代 shot.duration_sec 作为本镜时间槽长度.
    // 用户实测案例: 视频 10s/镜 × 5 = 50s, shot.duration_sec=5s 累加只到 24s, 字幕从 24s 后断片,
    // 前段也跟视频里说话节奏完全不同步. 修后字幕 100% 在视频时间槽内分布.
    // rough 模式: ffmpegBuilder 里 generateRoughShotSegment 用 (trimEnd - trimStart || shot.duration_sec)
    // 拉伸首帧, 所以这里 fallback 同样考虑 trim, 保证字幕长度 = 视频长度.
    const baseDurSecForFallback = shot.duration_sec || 5;
    const trimStartSecF = (shot as { trim_start_sec?: number }).trim_start_sec ?? 0;
    const trimEndSecF = (shot as { trim_end_sec?: number }).trim_end_sec ?? baseDurSecForFallback;
    const fallbackDurSec = (trimEndSecF > trimStartSecF) ? (trimEndSecF - trimStartSecF) : baseDurSecForFallback;
    const videoRealDurSec = ctx.composeMode !== "rough"
      ? await probeVideoDurationSafe(videoPath, fallbackDurSec, deps.signal)
      : fallbackDurSec; // rough 模式视频是 generateRoughShotSegment 后产物, 这里没探测; 由 prepare 路径处理
    const effectiveDurSec = videoRealDurSec > 0 ? videoRealDurSec : fallbackDurSec;
    const effectiveDurMs = Math.round(effectiveDurSec * 1000);
    const usedSource: "video_real" | "shot_duration_fallback" =
      videoRealDurSec > 0 && Math.abs(videoRealDurSec - fallbackDurSec) > 0.05 ? "video_real" : "shot_duration_fallback";

    // 2026-05-25 — 是否需要 scale segments 到视频真长, 取决于 alignSource:
    //   - video_track: Whisper 听的是从视频抽的音轨, 时间戳已是视频内真实时间, **不缩放** (直接用).
    //   - tts_audio:   Whisper/fallback 时间戳基于 TTS mp3 内部时间, 跟视频帧 10s 不一致, **缩放** 到 video 真长.
    //   - none:        fallback estimate 按 shot.duration_sec/1000 估的, **缩放** 到 video 真长.
    // 关键修复 (用户报"还是不对齐"): 旧版总是 scale, audio_mode=original 时把 TTS 节奏拉伸到 video 长度,
    // 但 audio_mode=original 视频音轨跟 TTS 节奏不同 → 缩放后跟视频里说话还是错位. 现在 video_track 不缩放,
    // 跟视频原声完全同步; tts_audio 缩放保 audio_mode=tts 时字幕跟 TTS mux 进去的音轨同步.
    const shouldScale = alignSource !== "video_track";
    if (alignSegments.length > 0 && shouldScale) {
      const segMaxEndSec = alignSegments[alignSegments.length - 1].endSec;
      const scale = segMaxEndSec > 0.001 ? effectiveDurSec / segMaxEndSec : 1;
      alignSegments = alignSegments.map((seg) => ({
        startSec: seg.startSec * scale,
        endSec: seg.endSec * scale,
        text: seg.text,
      }));
    }
    // 即便不缩放也保证 segments 不越界 (Whisper 偶尔报 endSec 略超 audio_dur)
    if (alignSegments.length > 0) {
      alignSegments = alignSegments.map((seg) => ({
        startSec: Math.max(0, Math.min(seg.startSec, effectiveDurSec)),
        endSec: Math.max(0, Math.min(seg.endSec, effectiveDurSec)),
        text: seg.text,
      }));
    }

    // 2026-07-10 P1-4 — 主路径每镜逐句对齐 (相对本镜起点, 已 scale 到本镜真长) 落盘 segments_<shotId>.json,
    // 供后续"重合成单镜"时未动的镜从 reuse 分支读回按本次 shotStartMs 平移, 保持逐句字幕一致 (不退化整块).
    // 部分重合成里被重合成的镜也走这条主路径 → 顺带刷新它的落盘, 下次 reuse 拿到最新.
    if (alignSegments.length > 0) {
      await persistShotSegments(ctx.subtitleDir, shotId, alignSegments);
    }

    perShotAlignment.push({
      shot_id: shotId,
      shot_duration_sec: fallbackDurSec,
      video_real_duration_sec: videoRealDurSec > 0 ? Number(videoRealDurSec.toFixed(3)) : null,
      tts_audio_duration_sec: ttsAudioDurSec !== null ? Number(ttsAudioDurSec.toFixed(3)) : null,
      used_duration_sec: Number(effectiveDurSec.toFixed(3)),
      used_source: usedSource,
      segment_count: alignSegments.length,
      align_method: alignMethodForShot,
      align_source: alignSource,
    });

    if (alignSegments.length > 0) {
      for (const seg of alignSegments) {
        const srtIdx = ctx.srtLines.length / 4 + 1;
        ctx.srtLines.push(`${srtIdx}`);
        ctx.srtLines.push(`${formatSrtTime(Math.round(seg.startSec * 1000) + ctx.globalMs)} --> ${formatSrtTime(Math.round(seg.endSec * 1000) + ctx.globalMs)}`);
        ctx.srtLines.push(safeSrtText(seg.text));
        ctx.srtLines.push("");
        // W7 Phase 3: 同步累积到多轨字幕 layer 0
        const startSecGlobal = seg.startSec + ctx.globalMs / 1000;
        const endSecGlobal = seg.endSec + ctx.globalMs / 1000;
        ctx.mainDialogTracks.push({
          startSec: startSecGlobal,
          endSec: endSecGlobal,
          text: safeSrtText(seg.text),
          shot_id: shotId,
        });
      }
    }

    // 2026-05-25 xfade 转场重叠修正 — 若下一镜走 xfade (非 hard) 转场, 视频帧 timeline 上本镜尾巴
    // 会被吃掉一个转场时长 (跟 buildXfadeFilterChain 公式一致: offset(i)=sum(d[0..i-1])-Σt).
    // 字幕 globalMs 也得同量扣减, 否则越往后字幕累计偏移. hard cut (默认) 无重叠, 不扣.
    // 2026-05-26 audit — 跟 ffmpegBuilder transition 优先级一致: shot.transition_in 优先, 缺时
    // fallback 到 v.data.transition (整集默认).
    // 2026-05-27 — 跟 ffmpegBuilder 同步走 normalizeTransition, 之前自己写白名单 isHard 漏掉 LLM 写的
    // 非规范转场字符串 → normalizeTransition 返 "hard" 但 tts 误判非 hard → 多扣重叠 → 总长偏短.
    // 2026-07-09 audit (铁律 #4 补齐) — 扣减量由硬编码 500ms 改为该转场真实 transition_duration
    // (归属下一镜, 与视频 xfade / 音频 acrossfade 同源同 clamp, 见 subtitleXfadeOverlapMs). C12 解锁
    // shot.transition_duration 可存 + C5 音画按真实时长缩短后, 字幕若仍扣 500 则用户设 ≠0.5s 转场逐镜漂移.
    const nextShot = i + 1 < ctx.shots.length ? ctx.shots[i + 1] : null;
    const nextShotTransRaw = (nextShot as { transition_in?: string } | null)?.transition_in;
    const episodeDefaultTransRaw = (ctx.v.data as { transition?: string }).transition;
    const nextTransitionRaw = (nextShotTransRaw && nextShotTransRaw.trim())
      ? nextShotTransRaw
      : episodeDefaultTransRaw;
    let stepMs = effectiveDurMs;
    // 2026-07-10 修 — 仅 full 模式走 buildXfadeFilterChain, 非 hard 转场才真吃掉转场重叠, 字幕/分段
    // 时间轴同量扣减才对齐. rough 草稿走纯 concat (ffmpegConcat) 不做 xfade, 一旦扣重叠字幕/分段会
    // 逐镜提前漂移 (镜越多漂越大). 故 rough 下 stepMs 恒用完整 effectiveDurMs, 不扣转场重叠.
    if (nextShot && ctx.composeMode !== "rough") {
      const normalized = normalizeTransition(nextTransitionRaw);
      if (normalized !== "hard") {
        stepMs = Math.max(
          effectiveDurMs - subtitleXfadeOverlapMs((nextShot as { transition_duration?: number }).transition_duration, effectiveDurSec),
          0,
        );
      }
    }
    // 2026-05-26 — 真 segments 暴露给前端, 让 chip / canvas 用真长定位 (修 12s 显示错镜 bug).
    const segStartSec = ctx.globalMs / 1000;
    const segEndSec = segStartSec + stepMs / 1000;
    ctx.shotEffectiveSegments.push({
      shot_id: shotId,
      start_sec: Number(segStartSec.toFixed(3)),
      end_sec: Number(segEndSec.toFixed(3)),
    });
    ctx.globalMs += stepMs;

    deps.progress.progress("compose.shot", {
      shot_id: shotId,
      index: i + 1,
      total: ctx.shots.length,
      video_path: videoPath || null,
      video_source: videoSource,
      audio_generated: audioGenerated,
      srt_done: text.trim().length > 0,
    });
    sseBroker.emit({
      type: "compose.progress",
      job_id: ctx.job_id,
      data: {
        percent: Math.round(((i + 1) / ctx.shots.length) * 100),
        step: `处理分镜 ${i + 1}/${ctx.shots.length}`,
        detail: audioGenerated ? `已生成 ${shotId} 语音` : `${shotId} 无语音`,
        shot_id: shotId,
        index: i + 1,
        total: ctx.shots.length,
      },
      at: new Date().toISOString(),
    });
  }

  ctx.srtPath = path.join(ctx.subtitleDir, "final.srt");
  await fs.writeFile(ctx.srtPath, ctx.srtLines.join("\n"), "utf8");

  const alignMetaPath = path.join(ctx.subtitleDir, "alignment_meta.json");
  const { writeJson } = await import("../../../../../packages/core/src/index");
  // 2026-05-25 诊断字段扩充 — 用户原话"字幕烧录根本没对齐视频里的声音".
  // per_shot_alignment 让下次出问题 cat alignment_meta.json 即可定位每镜的:
  // 视频真长 / TTS 真长 / 实际用了哪个时长 / Whisper 是否生效.
  // total_video_duration_sec 是字幕总时长 (= 视频总长), 跟 final.mp4 ffprobe 应该一致.
  const totalUsedSec = perShotAlignment.reduce((s, r) => s + r.used_duration_sec, 0);
  await writeJson(alignMetaPath, {
    method: ctx.alignMethodUsed,
    generated_at: new Date().toISOString(),
    total_entries: ctx.srtLines.length / 4,
    total_duration_ms: ctx.globalMs,
    total_video_duration_sec: Number(totalUsedSec.toFixed(3)),
    aligned_from: "video_real_duration_with_whisper_or_charweight_segments",
    per_shot_alignment: perShotAlignment,
  });
}
