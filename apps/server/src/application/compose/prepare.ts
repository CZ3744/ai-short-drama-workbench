import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

import {
  readEpisode,
  listCharacters,
  listShots,
  readSeries,
  createTaskRecord,
  updateTaskRecord,
} from "../../api/v2/seriesStore";
// W6 (2026-05-26) — Cast 层 voice 资产读取 (跨 series 共享)
import { readCast } from "../../repositories/castRepo";
import { normalizeSeriesCastIds } from "../cast/effectiveElements";
import type { Cast } from "../../../../../packages/drama/src/types";
import { validate, ComposeSchema } from "../../api/v2/validators";
import { sseBroker } from "../../api/v2/sseBroker";
import { episodeBase } from "../../api/v2/orchestration/_shared/paths";
import { getRegistry } from "../../api/v2/orchestration/_shared/registry";
import type { ProgressSink } from "../../api/v2/orchestration/_shared/progressSink";
import { formatSrtTime, generateMockVideo } from "../../api/v2/orchestration/_shared/media";
import { ensureDir, writeJson } from "../../../../../packages/core/src/index";
import { loggerSync } from "../../../../../packages/core/src/logger";
import { getConfigValue } from "../../../../../packages/core/src/localSettings";
import { stripMentionTokens } from "../../../../../packages/drama/src/mentionParser";
import type { TtsProvider } from "../../../../../packages/providers/src/core/types";

import type { ComposeEpisodeInput, ComposeEpisodeDeps, ComposeEpisodeResult } from "./composeEpisode";

// Re-export for downstream phase files
export type { ComposeEpisodeDeps, ComposeEpisodeResult };

/**
 * Sanitize subtitle text before writing to SRT.
 * ASS/SSA style override tags use { } and \ as control characters.
 * ffmpeg's subtitles filter converts SRT → ASS internally, so { } in SRT text
 * would be mis-interpreted as ASS override blocks, causing garbled/invisible subtitles.
 */
export function safeSrtText(s: string): string {
  return s
    .replace(/\\/g, " ")   // backslash → space (ASS newline / escape char)
    .replace(/[{}]/g, ""); // strip ASS override tag delimiters
}

export function resolveSubtitleCanvas(aspectRatio?: string): { width: number; height: number; safeZoneBottomPct: number } {
  const normalized = (aspectRatio || "9:16").trim().replace("x", ":");
  if (normalized === "16:9") return { width: 1920, height: 1080, safeZoneBottomPct: 5 };
  if (normalized === "1:1") return { width: 1080, height: 1080, safeZoneBottomPct: 12 };
  return { width: 1080, height: 1920, safeZoneBottomPct: 20 };
}

/** Shared mutable context passed through all 4 compose phases. */
export interface ComposeContext {
  slug: string;
  episodeId: string;
  composeMode: string;
  bgmMood?: string;
  bgmVolume?: number;
  normalizeLoudness: boolean;
  ttsProvider: string;
  /**
   * 2026-05-22 P0 — 音轨来源: "original" 保留视频原声 / "tts" 用 TTS 合成语音替换。
   * 仅影响 full 模式; rough 模式静态图本就靠 TTS, 不受此字段影响。
   */
  audioMode: "original" | "tts";
  /** 2026-05-22 P0 — 字幕是否烧进画面 (独立维度, false 时仍写 final.srt sidecar)。 */
  burnSubtitles: boolean;
  subtitleStyle: string;
  subtitleAnimation: "none" | "fade_in" | "typewriter";
  /** P1-8: 自定义字幕样式参数 — subtitleStyle="custom" 时透传给 burnSubtitles */
  customStyle?: {
    font_family?: string;
    font_size?: number;
    color?: string;
    stroke_color?: string;
    stroke_width?: number;
    bg_color?: string;
    bg_opacity?: number;
    position?: "bottom" | "top" | "center";
  };
  aspectRatio: string;
  subtitleCanvas: { width: number; height: number; safeZoneBottomPct: number };
  onlyShotIds: Set<string>;
  isPartialRecompose: boolean;
  baseDir: string;
  composeDir: string;
  audioDir: string;
  subtitleDir: string;
  job_id: string;
  taskId: string;
  ttsProv: TtsProvider | null;
  ttsProvInitError: string | null;
  seriesDefaultVoiceId: string;
  ttsFailures: Array<{ shot_id: string; error: string }>;
  ttsOverallStatus: "ok" | "failed" | "no_provider";
  mockShots: Array<{ shot_id: string; reason: string }>;
  trimFailures: Array<{ shot_id: string; error: string }>;
  /**
   * 2026-05-22 entity-first: 用户明确 picked (shot.picked_*_generation_id 设了)
   * 但解析失败 (generation 记录丢 / 文件丢) 的镜头. 顶层 response 必须暴露这些,
   * 让前端 toast "镜头 X 的视频文件丢失,请重新导入或重新生成".
   * 严禁 silent mock 冒充 — 这是 silent mock fallback 红线 #1 同款 bug.
   */
  failedShots: Array<{
    shot_id: string;
    kind: "video" | "first_frame";
    code: "no-picked-generation" | "generation-not-found" | "asset-file-missing" | "burn-subtitles-failed";
    reason_zh: string;
  }>;
  srtLines: string[];
  globalMs: number;
  videoFiles: Array<{ shotId: string; absPath: string; source: string }>;
  /**
   * 2026-05-22 P0 — audio_mode="tts" 时用: 每镜 TTS 音频文件 + 它在整集时间轴上的起始毫秒。
   * runConcatPhase 之后由 audioMux 把这些片段按 startMs 用 adelay 拼成整集音轨并替换视频原声。
   * audio_mode="original" 时这个数组照样填(无副作用), 只是 mux 阶段不读它。
   */
  ttsAudioSegments: Array<{ shotId: string; absPath: string; startMs: number }>;
  mainDialogTracks: Array<{ startSec: number; endSec: number; text: string; shot_id?: string }>;
  alignMethodUsed: string;
  /**
   * 2026-05-26 — 每镜在整集时间轴上的真实区间 (ffprobe 真长累加 + xfade 重叠扣减后).
   * tts.ts 每镜处理完后 push 一条; render.ts response 暴露给前端,
   * 让 FinalPreviewPlayer 的 segments / chip / canvas active 用真长定位 (不再前端 shot.duration_sec 算).
   * 修用户实测 bug: 12s 视频播到 shot 2 "橘子!" 但前端 chip 显示 "第 3 镜" active (前端按 5/4/5/5/5 累加 24s, 后端按 10/10/... 50s).
   */
  shotEffectiveSegments: Array<{ shot_id: string; start_sec: number; end_sec: number }>;
  srtPath: string;
  finalMp4Path: string;
  burned: boolean;
  // Original validated body + domain data needed by subsequent phases
  v: { ok: boolean; data: any; status: number; errors: Array<{ path: string; message: string }> };
  episode: NonNullable<Awaited<ReturnType<typeof readEpisode>>>;
  series: Awaited<ReturnType<typeof readSeries>>;
  shots: Awaited<ReturnType<typeof listShots>>;
  characters: Awaited<ReturnType<typeof listCharacters>>;
  charMap: Map<string, Awaited<ReturnType<typeof listCharacters>>[number]>;
  /**
   * W6 (2026-05-26): 当 series.cast_id 存在且 cast 未软删时, 一次性读出 cast 对象供 tts.ts
   * voice resolver 复用 (cast.voice_assets 优先级高于 series-local character.voice_*).
   * 未挂 cast / cast 已软删 / 读取失败 → null, voice resolver 走 series-local fallback.
   */
  cast: Cast | null;
  overrideVoiceStyleMap: Record<string, Record<string, string>>;
  ttsScriptOverride: Record<string, string>;
  ttsGlobalOverride: string | null;
  episodeVoiceProviderOverride?: string;
  /** Whether quick local preview was entered (early return path). Set to true in ctx when entering QLP. */
  quickLocalPreviewHint?: boolean;
  /** Internal: full-mode source.mp4 path set by ffmpegBuilder for render phase. */
  _sourceMp4Path?: string;
}

export type PrepareResult =
  | ComposeEpisodeResult
  | { kind: "context"; ctx: ComposeContext };

/**
 * Phase 1 — Prepare: read episode/shots, validate assets, resolve canvas,
 * handle empty-shots / quick-local-preview early returns.
 * Returns either a ready-to-proceed context or an early-return result.
 */
export async function prepareCompose(
  input: ComposeEpisodeInput,
  deps: ComposeEpisodeDeps,
): Promise<PrepareResult> {
  let job_id = "";
  let taskId = "";

  const v = validate(ComposeSchema, input.body);
  if (!v.ok) return { kind: "validation", status: v.status, errors: v.errors };

  const episode = await readEpisode(input.slug, input.episodeId);
  if (!episode) return { kind: "error", status: 404, body: { error: { code: "NotFound", message: "集不存在" } } };

  const baseDir = episodeBase(input.slug, input.episodeId);
  const shots = await listShots(input.slug, input.episodeId);

  deps.requestLog?.info({
    action: "compose",
    series_slug: input.slug,
    episode_id: input.episodeId,
    shot_count: shots.length,
  }, "COMPOSE start");

  const characters = await listCharacters(input.slug);
  const charMap = new Map<string, typeof characters[number]>();
  for (const ch of characters) charMap.set(ch.name, ch);

  // 2026-05-21 V-4: 多角色 TTS 临时覆盖 — 用户在 ComposeSettingsDrawer 为每个角色选音色,
  // 前端按 `{ charId: { default: voiceId } }` 发到 v.data.voice_style_map (charId 在外两层 map)。
  // 优先级高于 character.voice_style_map (持久配置),低于 episode_voice_override / shot.tts_voice_override。
  const overrideVoiceStyleMap = (v.data as { voice_style_map?: Record<string, Record<string, string>> }).voice_style_map ?? {};
  // 2026-05-21 X-4: TTS 文本逐镜临时覆盖 — 用户在 PromptReview 改对白后直接合成,不必回 ShotStage
  const ttsScriptOverride = (v.data as { tts_script_override?: Record<string, string> }).tts_script_override ?? {};
  const ttsGlobalOverride = typeof ttsScriptOverride.__all === "string" ? ttsScriptOverride.__all : null;

  // 2026-05-17 voice-sync v1: 提前读 series, 让 ttsProvider / defaultVoice 走 series defaults
  const series = await readSeries(input.slug);

  // W6 (2026-05-26): 预读 cast (若 series 加入了素材组且未软删), 让 tts.ts voice resolver 复用
  // cast.voice_assets 实现跨 series voice 共享. 读取失败 / 已软删 → null, 自动降级 series-local.
  // W7 (2026-05-26): series 可加入多个素材组, 当前 voice resolver 只用首个组 (按 cast_ids 顺序);
  // 后续可改成"按 character 查所有组" 但目前用户场景一个角色基本只在一组里 .
  let cast: Cast | null = null;
  const seriesCastIds = normalizeSeriesCastIds(series ?? null);
  if (seriesCastIds.length > 0) {
    cast = await readCast(seriesCastIds[0]).catch(() => null);
  }

  if (shots.length === 0) {
    const composeDir2 = path.join(baseDir, "compose");
    const subtitleDir2 = path.join(composeDir2, "subtitles");
    await ensureDir(composeDir2);
    await ensureDir(subtitleDir2);
    const emptySrt = path.join(subtitleDir2, "final.srt");
    await fs.writeFile(emptySrt, "", "utf8");

    return {
      kind: "json",
      body: {
        ok: true,
        subtitles_only: true,
        message: "无视频片段,仅生成 SRT",
        episode_id: input.episodeId,
        srt: emptySrt,
      },
    };
  }

  const composeMode = (v.data as { mode?: string }).mode || "full";
  // 2026-05-19 P1: BGM 混音 + P3 音量归一化 (前端 ComposeSettingsPanel BGM tab 拍板)
  const bgmMood = (v.data as { bgm_mood?: string }).bgm_mood;
  const bgmVolume = (v.data as { bgm_volume?: number }).bgm_volume;
  // 默认开 loudnorm (P3 音量归一化让各集听感统一), rough 模式跳过(粗剪求快)
  const normalizeLoudness = composeMode !== "rough";
  // 2026-05-17 voice-sync v1: TTS Provider fallback 链 — body 显式覆盖 > series defaults > edge_tts.
  // 让用户在 SettingsPage / ComposeSettingsDrawer 选的 tts_provider_id 真生效.
  // 2026-05-17 voice-sync v2: 加 episode_voice_provider_override — 配合 episode_voice_override
  // 用 (e.g. 选了"小米 MiMo · 默认音色" → episode_voice_provider_override="mimo_tts").
  const episodeVoiceProviderOverride = (v.data as { episode_voice_provider_override?: string }).episode_voice_provider_override;
  const ttsProvider =
    episodeVoiceProviderOverride || v.data.tts_provider || series?.defaults?.tts_provider_id || "edge_tts";
  // 2026-05-22 P0 — 音轨来源 / 字幕烧录是两个独立维度 (用户原话: "用视频原声不等于不烧录字幕")。
  // ComposeSchema 已 default audio_mode="tts" / burn_subtitles=true, 这里仍兜底防 v.data 缺字段。
  const audioMode: "original" | "tts" =
    (v.data as { audio_mode?: "original" | "tts" }).audio_mode === "original" ? "original" : "tts";
  const burnSubtitles: boolean =
    (v.data as { burn_subtitles?: boolean }).burn_subtitles !== false;
  const subtitleStyle = v.data.subtitle_style || "default";
  const subtitleAnimation = (v.data as { subtitle_animation?: "none" | "fade_in" | "typewriter" }).subtitle_animation || "none";
  const customStyle = v.data.custom_style;
  const aspectRatio = (v.data as { aspect_ratio?: string }).aspect_ratio
    || (series?.defaults as { aspect_ratio?: string } | undefined)?.aspect_ratio
    || "9:16";
  const subtitleCanvas = resolveSubtitleCanvas(aspectRatio);

  const onlyShotIds = new Set<string>((v.data as { only_shot_ids?: string[] }).only_shot_ids || []);
  const isPartialRecompose = onlyShotIds.size > 0;

  job_id = deps.taskContext?.job_id ?? `compose_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 12)}`;
  taskId = deps.taskContext?.task_id ?? `task_${job_id}`;
  const taskMeta = {
    series_slug: input.slug,
    slug: input.slug,
    episode_id: input.episodeId,
    ep_id: input.episodeId,
    epId: input.episodeId,
    mode: composeMode,
    action: "compose",
  };
  if (deps.taskContext) {
    updateTaskRecord(taskId, {
      status: "running",
      meta: taskMeta,
    });
  } else {
    createTaskRecord({
      id: taskId,
      job_id,
      kind: "compose",
      provider_id: "compose",
      status: "running",
      meta: taskMeta,
    });
  }

  const composeDir = path.join(baseDir, "compose");
  const audioDir = path.join(composeDir, "audio");
  const subtitleDir = path.join(composeDir, "subtitles");
  await ensureDir(composeDir);
  await ensureDir(audioDir);
  await ensureDir(subtitleDir);

  deps.progress.progress("compose.start", {
    episode_id: input.episodeId,
    shot_count: shots.length,
    tts_provider: ttsProvider,
  });
  sseBroker.emit({
    type: "compose.stage",
    job_id,
    data: {
      stage: "compose.start",
      episode_id: input.episodeId,
      shot_count: shots.length,
      tts_provider: ttsProvider,
    },
    at: new Date().toISOString(),
  });

  const fullVideoGenerations = shots.flatMap((shot) => (shot.generations || [])
    .filter((g) => g.type === "video" && g.status === "done" && (g.asset_id || g.path))
    .map((g) => ({ shot, generation: g })));
  const quickLocalPreview = composeMode === "full"
    && !isPartialRecompose
    && fullVideoGenerations.length === 0
    && getConfigValue("COMPOSE_QUICK_LOCAL_PREVIEW", "1") !== "0";

  if (quickLocalPreview) {
    const srtLinesQuick: string[] = [];
    let cursorMs = 0;
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const rawText = ttsScriptOverride[shot.id] ?? ttsGlobalOverride ?? (shot.dialogue || shot.voiceover || shot.action || "");
      const text = stripMentionTokens(rawText).trim();
      const durationMs = Math.max(1, shot.duration_sec || 5) * 1000;
      if (text) {
        const srtIdx = srtLinesQuick.length / 4 + 1;
        srtLinesQuick.push(`${srtIdx}`);
        srtLinesQuick.push(`${formatSrtTime(cursorMs)} --> ${formatSrtTime(cursorMs + durationMs)}`);
        srtLinesQuick.push(safeSrtText(text));
        srtLinesQuick.push("");
      }
      cursorMs += durationMs;
    }

    const srtPath = path.join(subtitleDir, "final.srt");
    await fs.writeFile(srtPath, srtLinesQuick.join("\n"), "utf8");
    await writeJson(path.join(subtitleDir, "alignment_meta.json"), {
      method: "quick_local_preview",
      generated_at: new Date().toISOString(),
      total_entries: srtLinesQuick.length / 4,
      total_duration_ms: cursorMs,
      aligned_from: "shot_duration_estimate",
    });

    const sourceMp4Path = path.join(composeDir, "source.mp4");
    const finalMp4Path = path.join(composeDir, "final.mp4");
    await generateMockVideo(sourceMp4Path, Math.max(Math.round(cursorMs / 1000), 1), aspectRatio);
    await fs.copyFile(sourceMp4Path, finalMp4Path);

    await writeJson(path.join(composeDir, "compose_manifest.json"), {
      episode_id: input.episodeId,
      composed_at: new Date().toISOString(),
      mode: "quick_local_preview",
      tts_provider: ttsProvider,
      subtitle_style: subtitleStyle,
      subtitle_animation: subtitleAnimation,
      aspect_ratio: aspectRatio,
      subtitle_safe_zone_bottom_pct: subtitleCanvas.safeZoneBottomPct,
      shot_count: shots.length,
      total_duration_ms: cursorMs,
      srt_path: `episodes/${input.episodeId}/compose/subtitles/final.srt`,
      tts_status: "skipped_no_real_video",
      video_sources: [],
    });

    // 2026-07-10 P2-9 (铁律 #5 状态精确) — quick_local_preview 是全假画面无声样片, 不是正式成片,
    // 绝不把 episode.status 标成"已合成" (否则系列总览撒谎显示已完成). 维持原状不写 status.
    // 任务记录仍标 done — 样片本身确实生成完成了, 用户能预览; 样片语义由前端确认框 + banner 提示.
    updateTaskRecord(taskId, {
      status: "done",
      result: {
        final_video_path: `episodes/${input.episodeId}/compose/final.mp4`,
        tts_status: "skipped_no_real_video",
      },
    });

    deps.progress.progress("compose.quick_preview.done", {
      episode_id: input.episodeId,
      total_duration_ms: cursorMs,
      final_video_path: `episodes/${input.episodeId}/compose/final.mp4`,
    });
    sseBroker.emit({
      type: "compose.done",
      job_id,
      data: {
        episode_id: input.episodeId,
        mode: "quick_local_preview",
        total_duration_ms: cursorMs,
        final_video_path: `episodes/${input.episodeId}/compose/final.mp4`,
        percent: 100,
        tts_status: "skipped",
        tts_reason: "尚未生成真实视频片段，已生成静音快速样片用于节奏预览。",
      },
      at: new Date().toISOString(),
    });

    return {
      kind: "json",
      body: {
        ok: true,
        job_id,
        episode_id: input.episodeId,
        mode: "quick_local_preview",
        compose_dir: `episodes/${input.episodeId}/compose`,
        total_duration_sec: Math.round(cursorMs / 1000),
        shot_count: shots.length,
        srt: srtPath,
        subtitles_burned: false,
        final_video_path: `episodes/${input.episodeId}/compose/final.mp4`,
        video_count: 0,
        quick_preview: true,
        tts_status: "skipped",
        tts_reason: "尚未生成真实视频片段，已生成静音快速样片用于节奏预览。",
      },
    };
  }

  // 2026-05-17 voice-sync v1: TTS 走 ProviderRegistry abstraction
  // (旧版直接 spawn python -m edge_tts CLI, character.voice_id 不是 edge_tts voice 时
  // silent crash → 用户在 ElementWorkbench 配 mimo/minimax voice 完全没用,质量红线 #1).
  //
  // ttsProv 在主流程开头 eager init, registry 缺失 / key 缺失等基础设施问题立刻报告;
  // shot 循环里失败只 collect 到 ttsFailures, 不阻塞合成 (用户能拿到无音视频 + SRT).
  const registry = getRegistry();
  // 2026-05-27 — 优先级 (高 → 低):
  //   1. v.data.tts_voice  (本次合成临时覆盖, ComposeSettingsPanel "全局默认音色" 来源 — 之前
  //                          schema 漏接, 用户选了等于没选, silent fallback 红线 #3)
  //   2. series.defaults.tts_voice_id  (系列级配置)
  //   3. 全局 env TTS_VOICE
  //   4. 硬编码 zh-CN-XiaoxiaoNeural
  // 注意: episode_voice_override 比这个更高优先级, 在 tts.ts 的 voice resolver 内处理.
  const composeLevelTtsVoice = (v.data as { tts_voice?: string }).tts_voice;
  const seriesDefaultVoiceId =
    composeLevelTtsVoice || series?.defaults?.tts_voice_id || getConfigValue("TTS_VOICE", "zh-CN-XiaoxiaoNeural");

  let ttsProv: TtsProvider | null = null;
  let ttsProvInitError: string | null = null;
  try {
    ttsProv = registry.getTts(ttsProvider);
  } catch (err) {
    ttsProvInitError =
      err instanceof Error
        ? err.message
        : `TTS provider "${ttsProvider}" 不可用`;
    loggerSync().warn(`[compose] ${ttsProvInitError} — 镜头将无音轨,SRT 走时长估算`);
  }
  const ttsFailures: Array<{ shot_id: string; error: string }> = [];
  let ttsOverallStatus: "ok" | "failed" | "no_provider" = ttsProv ? "ok" : "no_provider";
  // 2026-05-18 (红线 #1 禁伪 mock): 收集 "本应有真视频但 silent 退回 mock 假片段" 的分镜.
  const mockShots: Array<{ shot_id: string; reason: string }> = [];
  const trimFailures: Array<{ shot_id: string; error: string }> = [];
  // 2026-05-22 entity-first: 用户明确 picked 但解析失败 — 必须暴露给前端
  const failedShots: ComposeContext["failedShots"] = [];

  const srtLines: string[] = [];
  let globalMs = 0;
  const videoFiles: Array<{ shotId: string; absPath: string; source: string }> = [];
  // 2026-05-22 P0 — audio_mode="tts" 用: 每镜 TTS 音频 + 整集起始毫秒, runConcatPhase 后由 audioMux 消费
  const ttsAudioSegments: ComposeContext["ttsAudioSegments"] = [];
  // W7 Phase 3: 累积"主字幕"track,用于多轨字幕合成(layer 0)
  const mainDialogTracks: Array<{ startSec: number; endSec: number; text: string; shot_id?: string }> = [];
  let alignMethodUsed = "fallback_estimate";
  // 2026-05-26 — 每镜真实时间区间, tts.ts 累加时 push
  const shotEffectiveSegments: ComposeContext["shotEffectiveSegments"] = [];

  const ctx: ComposeContext = {
    slug: input.slug,
    episodeId: input.episodeId,
    composeMode,
    bgmMood,
    bgmVolume,
    normalizeLoudness,
    ttsProvider,
    audioMode,
    burnSubtitles,
    subtitleStyle,
    subtitleAnimation,
    customStyle,
    aspectRatio,
    subtitleCanvas,
    onlyShotIds,
    isPartialRecompose,
    baseDir,
    composeDir,
    audioDir,
    subtitleDir,
    job_id,
    taskId,
    ttsProv,
    ttsProvInitError,
    seriesDefaultVoiceId,
    ttsFailures,
    ttsOverallStatus,
    mockShots,
    trimFailures,
    failedShots,
    srtLines,
    globalMs,
    videoFiles,
    ttsAudioSegments,
    mainDialogTracks,
    alignMethodUsed,
    shotEffectiveSegments,
    srtPath: "",
    finalMp4Path: "",
    burned: false,
    v: v as { ok: boolean; data: any; status: number; errors: Array<{ path: string; message: string }> },
    episode,
    series,
    shots,
    characters,
    charMap,
    cast,
    overrideVoiceStyleMap,
    ttsScriptOverride,
    ttsGlobalOverride,
    episodeVoiceProviderOverride,
  };

  return { kind: "context", ctx };
}
