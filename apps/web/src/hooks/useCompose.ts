import { useState, useCallback, useRef, useEffect } from "react";
import { useParams } from "react-router-dom";
import { apiPost, apiGet } from "../lib/api";
// 2026-05-22 P0-D: compose SSE 推 stage="compose.shot" 等 raw enum, UI 直接渲染会暴露内部字段给用户.
// 接 labelOfStage 翻成"处理分镜" / "字幕烧录" 等中文人话 (铁律 #9 toC 兜底).
import { labelOfStage } from "../lib/sourceLabels";

export type ComposeStage = "idle" | "composing" | "done" | "error";

export interface ComposeParams {
  /**
   * 2026-05-22 — 音轨来源 (用户原话: "如果我直接想用视频里的语音, 不想再统一二次烧录").
   * "original" = 用视频自带音轨 (跳过 TTS), "tts" = TTS 朗读对白. 默认 "original".
   * 后端 ComposeSchema 接同名字段, full 模式 render 阶段据此决定保留视频原声还是用 TTS 音轨。
   */
  audio_mode?: "original" | "tts";
  /**
   * 2026-05-22 P0 — 字幕是否烧进画面 (独立于 audio_mode, 用户原话: "用视频原声不等于不烧录字幕").
   * true = 字幕烧录到画面; false = 字幕仍生成 final.srt sidecar, 但不烧进视频。默认 true。
   */
  burn_subtitles?: boolean;
  tts_provider_id?: string;
  tts_voice_id?: string;
  subtitle_style?: string;
  subtitle_animation?: "none" | "fade_in" | "typewriter" | "slide_up" | "slide_down" | "scale_up" | "bounce" | "glow" | "karaoke" | "shake";
  /** P1-8: 自定义字幕样式参数 — subtitle_style="custom" 时生效 */
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
  bgm_mood?: string;
  /** 2026-05-19 P1: BGM 音量 (0.0-1.0, 后端默认 0.4 — 跟人声 ducking 后的相对响度) */
  bgm_volume?: number;
  transition?: string;
  /** 2026-05-19 P0: 画面比例 (9:16 / 16:9 / 1:1), 决定最终成片画幅 */
  aspect_ratio?: string;
  /** Wave 4A: "rough" = 粗剪预览(免费), "full" = 精剪成片 */
  mode?: "rough" | "full";
  /** C4: 单镜头无缝重生成 — 仅重合成指定 shot */
  only_shot_ids?: string[];
  /** X6: per-request LLM provider override */
  llm_provider_id?: string;
  /**
   * W8-D: 多角色 TTS 声线绑定.
   * Shape: { [character_id]: { [emotion]: voice_id } }
   * 与后端 character.voice_style_map 同一契约;后端 composeEpisode 在解析每句
   * 对白时优先读 voice_style_map[emotion],兜底走 voice_id / 全局 tts_voice。
   * 这里前端塞 { default: voice } 让后端按"用户为该角色指定的默认 voice"覆盖。
   */
  voice_style_map?: Record<string, Record<string, string>>;
  /**
   * W7 Phase 3: 多轨字幕 — 给了任一字段就走 ASS Layer 0/1/2 烧录,不烧 SRT。
   * - notes: Layer 1 注释 / 翻译,时间戳由用户提供 (秒)
   * - watermark: Layer 2 角标 (如 "第 1 集"), 整集持续显示
   */
  subtitle_tracks?: {
    notes?: Array<{ start_sec: number; end_sec: number; text: string; shot_id?: string }>;
    watermark?: string;
  };
  /**
   * 2026-05-17 两阶段 TTS 工作流: 全集统一音色覆盖.
   * 优先级最高 - 覆盖所有 shot/character 的 voice 设置, 把整集 TTS 强制走该 voice_id.
   * 业内做法: 抽视频时用快速 mock TTS 对口型, 导出时选高质量音色统一覆盖.
   */
  episode_voice_override?: string;
  /** 配合 episode_voice_override 用: 显式指定 TTS provider 避免被 character voice 携带过来 */
  episode_voice_provider_override?: string;
  /**
   * 2026-05-26 铁律 #12 修复 — 用户在 PromptReviewButton onSend 改了台词文本后,
   * doCompose 把改后版本塞 `{ tts_script_override: { __all: editedText } }` 透传过来.
   * 旧版 ComposeParams 类型没声明 + useCompose fetch body 没发, 用户改的台词彻底丢, TTS 仍用旧 dialogue.
   * Shape: { [shot_id]: text } 或 { __all: globalText } (后端 prepare.ts:169 真识别).
   */
  tts_script_override?: Record<string, string>;
}

export interface ComposeProgress {
  percent: number;
  step: string;
  detail?: string;
}

/** Wave 4A: Compose version metadata from compose-versions endpoint */
export interface ComposeVersionInfo {
  filename: string;
  mode: "rough" | "full" | "quick_local_preview";
  created_at: string;
  size_bytes: number;
  url: string;
}

/**
 * 2026-05-25 entity-first: 合成时镜头 picked_video / first_frame 解析失败的详细记录.
 * 后端 render.ts:327-328 + prepare.ts:408 真返此结构 (用户明确 picked 但资源丢失/缺失).
 * 用户视角: 合成 5 镜其中 3 镜视频文件丢失 → 后端用 mock 占位 + 此字段暴露真实原因,
 * 前端必须 toast/banner 提示, 否则用户播放成片黑屏才发现.
 */
export interface ComposeFailedShot {
  /** 出问题的分镜 id */
  shot_id: string;
  /** 哪种资源: video (视频片段) / first_frame (首帧图) */
  kind: "video" | "first_frame";
  /** 失败枚举: asset-file-missing / generation-not-found / no-picked-generation */
  code: string;
  /** toC 中文人话原因 — 直接给用户看 */
  reason_zh: string;
}

/**
 * E-05: 合成接口完整响应类型 — 消除 startCompose 内 6 处 `as` 强转.
 * 对齐 packages/contracts/src/events/sse.ts 的 compose.done payload +
 * 后端 render.ts 同步 response 的全部字段. 所有 optional 字段后端可能不返.
 */
export interface ComposeResponse {
  ok: boolean;
  mode?: string;
  tts_status?: string;
  tts_reason?: string;
  final_video?: string | null;
  final_video_path?: string | null;
  subtitles_only?: boolean;
  message?: string;
  job_id?: string;
  task_id?: string;
  status?: "queued" | "running" | "done" | "failed";
  rough?: boolean;
  quick_preview?: boolean;
  failed_shots?: ComposeFailedShot[];
  failed_shots_reason?: string;
  subtitle_align_method?: string;
  subtitle_align_reason_zh?: string;
  shot_segments?: Array<{ shot_id: string; start_sec: number; end_sec: number }>;
  tts_failures?: Array<{ shot_id: string; error: string }>;
  mock_shots?: Array<{ shot_id: string; reason: string }>;
  trim_failures?: Array<{ shot_id: string; error: string }>;
  bgm_missing_reason?: string;
  bgm_missing_mood?: string;
}

export interface UseComposeResult {
  stage: ComposeStage;
  progress: ComposeProgress;
  error: string | null;
  startCompose: (seriesSlug: string, epId: string, params: ComposeParams) => Promise<void>;
  reset: () => void;
  /** 当前 compose job_id（用于 job 级 rhythm / compress API） */
  currentJobId: string | null;
  /** 2026-05-26 — 当前 compose task_id (用于 DELETE /api/v2/tasks/:id 中止合成) */
  currentTaskId: string | null;
  /** 2026-05-26 — 调 DELETE /api/v2/tasks/:id 中止合成. 后端 abortComposeTask 触发 AbortController.abort. */
  abortCompose: () => Promise<void>;
  /**
   * 2026-05-26 — 快速重对齐字幕 (不重合视频). 调 POST /api/v2/.../realign-subtitles,
   * 后端用 Whisper 重对齐 + 重烧字幕到 final.mp4, ~30 秒 (取决于 Whisper 模型).
   * 用户痛点: 改字幕设置 / 后端字幕逻辑更新后, 不想等整集合成 5 分钟.
   * 先决: 必须已有 source.mp4 + concat_list.txt (即之前完整合成过一次).
   */
  realignSubtitles: () => Promise<void>;
  /** 重对齐字幕中 (loading state, 让按钮显 loading) */
  realigningSubtitles: boolean;
  /** The final.mp4 relative path once compose completes */
  finalPath: string | null;
  /** TTS status from compose response: "ok" | "failed" */
  ttsStatus: string | null;
  /** Reason string when tts_status is "failed" */
  ttsReason: string | null;
  /** 2026-05-25 字幕对齐方式 — 让 compose 完成卡显示精度档位 */
  subtitleAlignMethod: string | null;
  subtitleAlignReasonZh: string | null;
  /**
   * 2026-05-26 — 后端真实每镜时间区间 (ffprobe 真长累加 + xfade 重叠扣).
   * 前端 FinalPreviewPlayer 用这个画 chip / canvas active, 不再前端 shot.duration_sec 自己算.
   * 修用户实测 bug: 12s 视频播 shot 2 "橘子!" 但前端 chip 显示 shot 3 active.
   */
  shotSegments: Array<{ shot_id: string; start_sec: number; end_sec: number }> | null;
  /** P60 Task 4A: true when compose produced only SRT, no video clips */
  subtitlesOnly: boolean;
  /** Message from subtitles_only response */
  subtitlesOnlyMessage: string | null;
  /** Wave 4A: latest compose mode ("rough" | "full") */
  composeMode: "rough" | "full" | "quick_local_preview" | null;
  /** true when backend produced a local no-cost rhythm preview instead of paid video stitching */
  quickPreview: boolean;
  quickPreviewMessage: string | null;
  /** Wave 4A: list of compose versions */
  composeVersions: ComposeVersionInfo[];
  /** Wave 4A: fetch compose versions (optionally pass slug/epId directly) */
  refreshVersions: (seriesSlug?: string, epId?: string) => Promise<void>;
  /** Wave 4A: loading state for versions fetch */
  versionsLoading: boolean;
  /** C4: currently re-composing shot IDs (empty when not in partial recompose) */
  recomposingShotIds: string[];
  /**
   * 2026-05-25 entity-first: 本次合成里解析失败被 mock 占位的镜头(asset 丢/未选 generation).
   * 后端 render.ts 真返 failed_shots 数组, 前端必须 banner 显示 — 否则用户黑屏才知道.
   */
  failedShots: ComposeFailedShot[];
  /** 后端拼好的中文整句失败原因 — 直接放 banner 显示 */
  failedShotsReason: string | null;
  /**
   * 2026-05-27 — 后端早就返了 tts_failures / mock_shots / trim_failures 数组但前端 0 用,
   * 用户拿到部分镜静音 / 部分黑屏 / 部分 trim 失效却不知道. agent audit #35 P0 真凶.
   * 这一波接通 — 合成完成卡新加"细节问题"banner 列出.
   */
  ttsFailures: Array<{ shot_id: string; error: string }>;
  mockShots: Array<{ shot_id: string; reason: string }>;
  trimFailures: Array<{ shot_id: string; error: string }>;
  /**
   * 2026-05-29 P0-1 (silent skip 红线): 用户选了 BGM 风格但库里没对应音频文件 → 成片无 BGM.
   * 后端 render.ts 在 compose.done / 同步 response 带 bgm_missing_reason (toC 中文整句) +
   * bgm_missing_mood (中文风格名). 之前前端 0 接 → 用户拿到无 BGM 视频毫无头绪. ComposePage
   * 像 ttsStatus banner 那样显眼提示 + 引导去 data/bgm-library 添加.
   */
  bgmMissingReason: string | null;
  bgmMissingMood: string | null;
}

/**
 * Drives POST /episodes/:epId/compose + SSE progress stream.
 * SSE endpoint: GET /episodes/:epId/compose/progress
 * Events (P170 1B): compose.stage | compose.progress | compose.done | compose.error
 */
export function useCompose(): UseComposeResult {
  const [stage, setStage] = useState<ComposeStage>("idle");
  const [progress, setProgress] = useState<ComposeProgress>({ percent: 0, step: "" });
  const [error, setError] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [finalPath, setFinalPath] = useState<string | null>(null);
  const [ttsStatus, setTtsStatus] = useState<string | null>(null);
  const [ttsReason, setTtsReason] = useState<string | null>(null);
  const [subtitleAlignMethod, setSubtitleAlignMethod] = useState<string | null>(null);
  const [subtitleAlignReasonZh, setSubtitleAlignReasonZh] = useState<string | null>(null);
  const [shotSegments, setShotSegments] = useState<Array<{ shot_id: string; start_sec: number; end_sec: number }> | null>(null);
  const [realigningSubtitles, setRealigningSubtitles] = useState<boolean>(false);
  const [subtitlesOnly, setSubtitlesOnly] = useState(false);
  const [subtitlesOnlyMessage, setSubtitlesOnlyMessage] = useState<string | null>(null);
  // Wave 4A
  const [composeMode, setComposeMode] = useState<"rough" | "full" | "quick_local_preview" | null>(null);
  const [quickPreview, setQuickPreview] = useState(false);
  const [quickPreviewMessage, setQuickPreviewMessage] = useState<string | null>(null);
  const [composeVersions, setComposeVersions] = useState<ComposeVersionInfo[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  // C4: partial recompose tracking
  const [recomposingShotIds, setRecomposingShotIds] = useState<string[]>([]);
  // 2026-05-25: 合成失败镜头 (后端 render.ts 真返 failed_shots, 之前前端 0 hit silent 丢)
  const [failedShots, setFailedShots] = useState<ComposeFailedShot[]>([]);
  const [failedShotsReason, setFailedShotsReason] = useState<string | null>(null);
  // 2026-05-27 — 接通后端 tts_failures / mock_shots / trim_failures (audit #35 P0 #5)
  const [ttsFailures, setTtsFailures] = useState<Array<{ shot_id: string; error: string }>>([]);
  const [mockShots, setMockShots] = useState<Array<{ shot_id: string; reason: string }>>([]);
  const [trimFailures, setTrimFailures] = useState<Array<{ shot_id: string; error: string }>>([]);
  // 2026-05-29 P0-1: 选了 BGM 但库里没文件 → 成片无 BGM 的 toC 提示
  const [bgmMissingReason, setBgmMissingReason] = useState<string | null>(null);
  const [bgmMissingMood, setBgmMissingMood] = useState<string | null>(null);
  // 2026-07-22 X5-7 (A2-5): 用户刷新页面后, "本次合成有 N 镜异常"黄条 + 细节问题 banner 消失 ——
  // 数据其实已经持久化在 compose_manifest.json(render.ts:172 写盘), 只是 failedShots/mockShots/
  // bgmMissingReason 这三个 state 从不在挂载时重读, 刷新即回到初始空数组/null。
  // hasStartedRef: 若这次 GET 还没返回前用户就手动点了"合成成片"/"粗剪预览", 不能让这份旧快照
  // 覆盖 startCompose/SSE 刚写入的实时状态 —— 用 ref 做互斥(不依赖 stage, 避免 effect 闭包过期)。
  const hasStartedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  // 2026-05-27 — 追踪 SSE 最后看到的 event id, 让 tryReconnectSSE 能从断点续传 (后端 ring
  // buffer 支持 ?lastEventId=N replay). 不传的话重连会从最新 event 开始, 中间 stage 事件丢
  // 失 → 进度条跳变. EventSource 每个 ev.lastEventId 自带, 这里手动 capture (因为我们手动
  // 重建 EventSource, native auto-reconnect 不走我们这条路径).
  const lastEventIdRef = useRef<string>("");
  // FIX 2026-05-14: pollTimer was a closure-local variable so unmount cleanup
  // (useEffect below) couldn't reach it. If the user navigated away while the
  // SSE-fallback polling was active, the 5s setInterval kept running forever
  // and called apiGet on a stale jobId. Hoisting to a ref makes it visible.
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentRef = useRef<{ slug: string; epId: string }>({ slug: "", epId: "" });

  // 2026-07-09 audit (C24): 统一清 pollTimer 的组件级 helper (稳定引用).
  // 之前只有 unmount cleanup + startCompose 内的 stopAll 会清 timer, abortCompose / reset 漏清 →
  // 用户"取消合成"后 5s 轮询继续打 GET /jobs/:id, 下一拍若 job 已完成就 setStage("done") 把已取消的
  // UI 翻回假"合成完成" (违反状态精确铁律); 若 job 失效 404 则轮询被 catch 静默吞、无限泄漏永不停.
  // 让四处 (abortCompose / reset / unmount / stopAll) 都复用同一 helper, 消除导致此 bug 的不对称.
  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Cleanup on unmount — close SSE + clear any active polling timer.
  useEffect(() => {
    return () => {
      esRef.current?.close();
      clearPollTimer();
    };
  }, [clearPollTimer]);

  // 2026-07-22 X5-7 (A2-5) — 挂载 / 切集时回灌黄条数据.
  // useCompose() 全仓库唯一调用方是 ComposePage(挂在 /studio/:slug/compose/:epId 路由下),
  // 这里直接读同一路由 context 拿 slug/epId, 不用改 useCompose() 的零参数签名 / 不用碰调用点.
  const { slug: manifestRouteSlug, epId: manifestRouteEpId } = useParams<{ slug?: string; epId?: string }>();
  useEffect(() => {
    if (!manifestRouteSlug || !manifestRouteEpId) return;
    hasStartedRef.current = false;
    let cancelled = false;
    (async () => {
      try {
        // exportRoutes.ts:135 已有的通用 compose 产物文件端点, 无需新端点.
        // A2-5 finding 点名 failed_shots/mock_shots/audio_mix.bgm_missing_reason 三个字段, 但
        // render.ts:172-217 实际同一份 manifest 里 tts_failures/trim_failures 也一并落盘 ——
        // ComposePage 的"细节问题"banner(line 735)三者一起判断, 只回灌一半会出现"部分场景刷新后
        // banner 仍消失"的半吊子修复, 这里一次性把该 banner 依赖的全部字段接上.
        const manifest = await apiGet<{
          failed_shots?: ComposeFailedShot[];
          mock_shots?: Array<{ shot_id: string; reason: string }>;
          tts_failures?: Array<{ shot_id: string; error: string }>;
          trim_failures?: Array<{ shot_id: string; error: string }>;
          audio_mix?: { bgm_missing_reason?: string; bgm_requested_mood?: string };
        }>(
          `/api/v2/series/${encodeURIComponent(manifestRouteSlug)}/episodes/${encodeURIComponent(manifestRouteEpId)}/compose-file/compose_manifest.json`
        );
        // 请求飞行途中用户已经手动发起了新合成 —— 新合成的实时状态优先, 旧快照绝不覆盖.
        if (cancelled || hasStartedRef.current) return;
        if (Array.isArray(manifest.failed_shots) && manifest.failed_shots.length > 0) {
          setFailedShots(manifest.failed_shots);
        }
        if (Array.isArray(manifest.mock_shots) && manifest.mock_shots.length > 0) {
          setMockShots(manifest.mock_shots);
        }
        if (Array.isArray(manifest.tts_failures) && manifest.tts_failures.length > 0) {
          setTtsFailures(manifest.tts_failures);
        }
        if (Array.isArray(manifest.trim_failures) && manifest.trim_failures.length > 0) {
          setTrimFailures(manifest.trim_failures);
        }
        if (manifest.audio_mix?.bgm_missing_reason) {
          setBgmMissingReason(manifest.audio_mix.bgm_missing_reason);
          setBgmMissingMood(manifest.audio_mix.bgm_requested_mood ?? null);
        }
      } catch {
        // 该集从未合成过(manifest 不存在)或读取失败 —— 静默降级, 维持初始空状态, 不打扰用户.
      }
    })();
    return () => { cancelled = true; };
  }, [manifestRouteSlug, manifestRouteEpId]);

  /**
   * Wave 4A: Fetch compose versions for a given series/episode.
   * Called on mount or after compose completes.
   */
  const loadVersions = useCallback(async (seriesSlug: string, epId: string) => {
    setVersionsLoading(true);
    try {
      const data = await apiGet<{ versions: ComposeVersionInfo[] }>(
        `/api/v2/series/${seriesSlug}/episodes/${epId}/compose-versions`
      );
      setComposeVersions(data.versions || []);
    } catch {
      // ignore — versions listing is optional
    } finally {
      setVersionsLoading(false);
    }
  }, []);

  const refreshVersions = useCallback(async (seriesSlug?: string, epId?: string) => {
    const s = seriesSlug || currentRef.current.slug;
    const e = epId || currentRef.current.epId;
    if (!s || !e) return;
    await loadVersions(s, e);
  }, [loadVersions]);

  const reset = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    clearPollTimer(); // 2026-07-09 audit (C24): reset 也必须停轮询, 否则旧 timer 用旧 jobId 继续跑
    setStage("idle");
    setProgress({ percent: 0, step: "" });
    setError(null);
    setCurrentJobId(null);
    setCurrentTaskId(null);
    setFinalPath(null);
    setTtsStatus(null);
    setTtsReason(null);
    setSubtitleAlignMethod(null);
    setSubtitleAlignReasonZh(null);
    setShotSegments(null);
    setSubtitlesOnly(false);
    setSubtitlesOnlyMessage(null);
    setComposeMode(null);
    setQuickPreview(false);
    setQuickPreviewMessage(null);
    setRecomposingShotIds([]);
    setFailedShots([]);
    setFailedShotsReason(null);
    setTtsFailures([]);
    setMockShots([]);
    setTrimFailures([]);
    setBgmMissingReason(null);
    setBgmMissingMood(null);
  }, [clearPollTimer]);

  /**
   * 2026-05-26 — 中止合成. 调 DELETE /api/v2/tasks/:id, 后端 abortComposeTask 触发
   * compose AbortController.abort(), 各阶段 spawn 的 ffmpeg / 子进程都收到 SIGKILL.
   * 不抛错, 失败 silent 兜底 (用户点了取消, 后端能取消就取消, 不能就由 SSE 正常推完然后 stop).
   */
  /**
   * 2026-05-26 — 快速重对齐字幕. 调后端 realign-subtitles 端点, 成功后:
   *   - 更新 subtitleAlignMethod / subtitleAlignReasonZh state 立刻刷新对齐卡
   *   - finalPath 加 timestamp query 强制 video 重新加载 (绕 browser cache)
   *   - 失败 toast.error 显示后端 reason
   */
  const realignSubtitles = useCallback(async () => {
    const { slug, epId } = currentRef.current;
    if (!slug || !epId) return;
    setRealigningSubtitles(true);
    try {
      const r = await fetch(
        `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/realign-subtitles`,
        { method: "POST" },
      );
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({}));
        const msg = (errBody as { error?: { message?: string } })?.error?.message ?? `HTTP ${r.status}`;
        const { toast } = await import("../components/ui/toast");
        toast.error("字幕重对齐失败", { description: msg, duration: 8000 });
        return;
      }
      const data = await r.json() as { align_method?: string; align_method_reason_zh?: string };
      if (data.align_method) {
        setSubtitleAlignMethod(data.align_method);
        setSubtitleAlignReasonZh(data.align_method_reason_zh ?? null);
      }
      // 让前端 video src 加 timestamp query 强制 reload (绕 Cache)
      setFinalPath((prev) => prev ? `${prev.split("?")[0]}?t=${Date.now()}` : prev);
      const { toast } = await import("../components/ui/toast");
      toast.success("字幕已重新对齐", {
        description: data.align_method_reason_zh ?? data.align_method,
        duration: 6000,
      });
    } catch (err: any) {
      const { toast } = await import("../components/ui/toast");
      toast.error("字幕重对齐失败", { description: err?.message ?? String(err), duration: 8000 });
    } finally {
      setRealigningSubtitles(false);
    }
  }, []);

  const abortCompose = useCallback(async () => {
    const taskId = currentTaskId;
    if (!taskId) {
      // 没 task_id (queued 前点取消 / 旧路径) → 直接关 SSE + 重置状态, 后端无 abort 可调
      esRef.current?.close();
      esRef.current = null;
      clearPollTimer(); // 2026-07-09 audit (C24): 取消即停轮询, 防轮询把已取消 UI 翻回"合成完成"
      setStage("idle");
      return;
    }
    // 2026-05-27 — 改 POST /tasks/:id/abort. 之前发 DELETE 后端只挂 POST → 404 被 silent
    // catch 吞掉, 前端假装"已取消" 但 ffmpeg/TTS 子进程继续跑到底 + 扣费. 假取消 = 严重欺骗.
    try {
      const res = await fetch(`/api/v2/tasks/${encodeURIComponent(taskId)}/abort`, { method: "POST" });
      if (!res.ok) {
        // abort 真失败要让用户知道, 而非 silent 假装成功
        const msg = `取消请求失败 (HTTP ${res.status}). 后端可能还在跑, 建议刷新检查.`;
        setError(msg);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`取消失败: ${msg}. 后端可能还在跑.`);
    }
    esRef.current?.close();
    esRef.current = null;
    clearPollTimer(); // 2026-07-09 audit (C24): 取消即停轮询, 防轮询把已取消 UI 翻回"合成完成"
    setStage("idle");
    setProgress({ percent: 0, step: "已取消" });
  }, [currentTaskId, clearPollTimer]);

  const startCompose = useCallback(async (seriesSlug: string, epId: string, params: ComposeParams) => {
    // X5-7: 挡住"挂载时回灌旧 manifest"的 in-flight 请求, 不让它覆盖这次真实合成的新状态.
    hasStartedRef.current = true;
    reset();
    currentRef.current = { slug: seriesSlug, epId };
    setStage("composing");
    setComposeMode(params.mode || "full");
    // C4: track partial recompose
    if (params.only_shot_ids && params.only_shot_ids.length > 0) {
      setRecomposingShotIds(params.only_shot_ids);
    }

    const mode = params.mode || "full";

    const onerrorCountRef = { current: 0 };
    // FIX 2026-05-14: 旧实现把 pollTimer 当闭包变量, unmount 时无法清理.
    // 改用 pollTimerRef (上面 useRef) 让 cleanup 可以 reach.
    let sseRetryCount = 0; // BUG-029: track SSE reconnection attempts after polling fallback

    /** 轮询回退：SSE 失败超过 3 次时激活，每 5s 查 GET /api/v2/jobs/:job_id (P170 1B) */
    const startPolling = (jobId: string) => {
      if (pollTimerRef.current) return;
      pollTimerRef.current = setInterval(async () => {
        try {
          const res = await apiGet<{ status?: string; final_path?: string; error?: string; percent?: number; stage?: string }>(
            `/api/v2/jobs/${encodeURIComponent(jobId)}`
          );
          if (res.status === "done") {
            setStage("done");
            setProgress({ percent: 100, step: "合成完成" });
            if (res.final_path) setFinalPath(res.final_path);
            stopAll();
            void loadVersions(seriesSlug, epId);
          } else if (res.status === "failed") {
            setError(res.error ?? "合成失败");
            setStage("error");
            stopAll();
          } else {
            // Update progress from polling response
            setProgress(prev => ({
              percent: res.percent ?? prev.percent,
              step: res.stage ?? prev.step,
            }));
          }

          // BUG-029: Every 6 polling cycles (~30s), attempt SSE reconnection
          sseRetryCount++;
          if (sseRetryCount % 6 === 0 && esRef.current?.readyState === EventSource.CLOSED) {
            tryReconnectSSE(jobId);
          }
        } catch {
          // 轮询失败静默忽略，等待下次重试
        }
      }, 5000);
    };

    /** BUG-029: Attempt to re-establish SSE connection after polling fallback */
    const tryReconnectSSE = (jobId: string) => {
      // 2026-05-27 — 加 lastEventId query 让后端 ring buffer 从断点 replay, 不丢中间 events
      const lastId = lastEventIdRef.current;
      const esUrl = `/api/v2/series/${seriesSlug}/episodes/${epId}/compose/progress?job_id=${encodeURIComponent(jobId)}${lastId ? `&lastEventId=${encodeURIComponent(lastId)}` : ""}`;
      const newEs = new EventSource(esUrl);
      // 通用 message 监听捕获每个事件的 id (实际典型事件走 named addEventListener, 这里兜底)
      newEs.onmessage = (ev) => { if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId; };
      let reconnectFailed = false;

      newEs.onopen = () => {
        // SSE reconnected successfully — stop polling
        if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
        esRef.current = newEs;
        onerrorCountRef.current = 0; // reset error count
      };

      newEs.addEventListener("compose.stage", (ev) => {
        if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId;
        try {
          const d = JSON.parse(ev.data);
          // 2026-05-22 P0-D: 翻成中文人话 (铁律 #9 toC 兜底), 不暴露 raw "compose.shot" 给 UI
          const stageZh = labelOfStage(d.stage) || d.stage || "进行中";
          setProgress(prev => ({ percent: d.percent ?? prev.percent, step: stageZh, detail: `当前: ${stageZh}` }));
        } catch {}
      });
      newEs.addEventListener("compose.progress", (ev) => {
        if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId;
        try { const d = JSON.parse(ev.data); setProgress({ percent: d.percent ?? 0, step: d.step ?? "", detail: d.detail }); } catch {}
      });
      newEs.addEventListener("compose.done", (ev) => {
        if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId;
        try {
          const d = JSON.parse(ev.data);
          setFinalPath(d.final_video_path ?? d.final_path ?? null);
          if (d.mode === "quick_local_preview") {
            setComposeMode("quick_local_preview");
            setQuickPreview(true);
            setQuickPreviewMessage(d.tts_reason ?? "已生成本地快速样片，适合先检查节奏和字幕。");
          } else if (d.mode === "rough") {
            setComposeMode("rough");
          }
          if (d.tts_status) {
            setTtsStatus(d.tts_status);
            setTtsReason(d.tts_reason ?? null);
          }
          // 2026-05-25 entity-first: reconnect 路径也接 failed_shots, 跟主 SSE 同款行为
          if (Array.isArray(d.failed_shots) && d.failed_shots.length > 0) {
            setFailedShots(d.failed_shots);
            setFailedShotsReason(d.failed_shots_reason ?? null);
          }
          // 2026-05-29 P0-1: reconnect 路径也接 BGM 缺失提示 (兜底 envelope/平铺两种 shape)
          const bgmSrcR = (d?.data && typeof d.data === "object" && d.data.bgm_missing_reason) ? d.data : d;
          if (bgmSrcR.bgm_missing_reason) {
            setBgmMissingReason(bgmSrcR.bgm_missing_reason);
            setBgmMissingMood(bgmSrcR.bgm_missing_mood ?? null);
          }
        } catch {}
        setStage("done"); setProgress({ percent: 100, step: "合成完成" }); stopAll(); void loadVersions(seriesSlug, epId);
      });
      newEs.addEventListener("compose.error", (ev) => {
        if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId;
        try { const d = JSON.parse(ev.data); setError(d.error ?? "合成失败"); } catch { setError("合成失败"); }
        setStage("error"); stopAll();
      });

      newEs.onerror = () => {
        reconnectFailed = true;
        newEs.close();
        // Keep polling — will try again in next 6 cycles
      };
    };

    const stopAll = () => {
      clearPollTimer(); // 2026-07-09 audit (C24): 复用组件级 helper, 与 abortCompose/reset/unmount 一致
      esRef.current?.close();
      esRef.current = null;
    };

    try {
      // Fire compose request and capture response for tts_status
      const composeResp = await apiPost<ComposeResponse>(`/api/v2/series/${seriesSlug}/episodes/${epId}/compose`, {
        // 2026-05-22 P0 — audio_mode / burn_subtitles 真接通后端 ComposeSchema。
        // 旧版前端 emit 了 audio_mode 但 startCompose 不发, 后端也没字段 → 全链路断链,
        // 用户骂"感觉忘记接入了"。这两个字段是音轨来源 / 字幕烧录两个独立维度。
        ...(params.audio_mode ? { audio_mode: params.audio_mode } : {}),
        ...(params.burn_subtitles !== undefined ? { burn_subtitles: params.burn_subtitles } : {}),
        tts_provider: params.tts_provider_id,
        tts_voice: params.tts_voice_id,
        subtitle_style: params.subtitle_style,
        ...(params.custom_style ? { custom_style: params.custom_style } : {}),
        subtitle_animation: params.subtitle_animation,
        bgm_mood: params.bgm_mood,
        bgm_volume: params.bgm_volume,
        transition: params.transition,
        aspect_ratio: params.aspect_ratio,
        mode,
        ...(params.only_shot_ids ? { only_shot_ids: params.only_shot_ids } : {}),
        ...(params.subtitle_tracks ? { subtitle_tracks: params.subtitle_tracks } : {}),
        ...(params.episode_voice_override ? { episode_voice_override: params.episode_voice_override } : {}),
        ...(params.episode_voice_provider_override ? { episode_voice_provider_override: params.episode_voice_provider_override } : {}),
        // 2026-05-21 V-4: voice_style_map 改走 ComposeSchema 顶层字段(后端 composeEpisode 直接读 v.data.voice_style_map)。
        // 旧版塞 overrides.voice_style_map 后端永不读 → 多角色 TTS 配置 silent 失效, 已修复。
        ...(params.voice_style_map ? { voice_style_map: params.voice_style_map } : {}),
        // llm_provider_id 仍走 overrides (后端 overrides 字段接 z.record 透传)
        ...(params.llm_provider_id ? { overrides: { llm_provider_id: params.llm_provider_id } } : {}),
        // 2026-05-26 铁律 #12 修复 — 用户在合成页"查看合成请求 → 编辑文本 → 发送"改的台词必须真发送
        ...(params.tts_script_override ? { tts_script_override: params.tts_script_override } : {}),
      });

      // Capture TTS status from the compose response
      if (composeResp.tts_status) {
        setTtsStatus(composeResp.tts_status);
        setTtsReason(composeResp.tts_reason ?? null);
      }
      // 2026-05-25 字幕对齐方式 — 让 compose 完成卡能显示
      if (composeResp.subtitle_align_method) {
        setSubtitleAlignMethod(composeResp.subtitle_align_method ?? null);
        setSubtitleAlignReasonZh(composeResp.subtitle_align_reason_zh ?? null);
      }
      // 2026-05-26 — 真 segments 接收, 让前端 chip/canvas 用真长定位
      if (composeResp.shot_segments && composeResp.shot_segments.length > 0) {
        setShotSegments(composeResp.shot_segments);
      }
      // P60 Task 4A: Capture subtitles_only flag for SRT-only compose
      if (composeResp.subtitles_only) {
        setSubtitlesOnly(true);
        setSubtitlesOnlyMessage(composeResp.message ?? "SRT 已生成，无视频片段");
      }
      // 2026-05-25: 异步化后 R1 立即 return queued, 但短路径 (任务在排队前已确定) 也可能
      // 同步返 failed_shots — 都接住, SSE compose.done 那条路径也会再 set 一次, 两条无冲突.
      if (composeResp.failed_shots && composeResp.failed_shots.length > 0) {
        setFailedShots(composeResp.failed_shots);
        setFailedShotsReason(composeResp.failed_shots_reason ?? null);
      }
      // 2026-05-27 — 同步路径也接 tts_failures / mock_shots / trim_failures
      if (Array.isArray(composeResp.tts_failures)) setTtsFailures(composeResp.tts_failures);
      if (Array.isArray(composeResp.mock_shots)) setMockShots(composeResp.mock_shots);
      if (Array.isArray(composeResp.trim_failures)) setTrimFailures(composeResp.trim_failures);
      // 2026-05-29 P0-1: 同步路径也接 BGM 缺失提示 (短路径: 合成在 R1 同步返时)
      if (composeResp.bgm_missing_reason) {
        setBgmMissingReason(composeResp.bgm_missing_reason);
        setBgmMissingMood(composeResp.bgm_missing_mood ?? null);
      }

      // Capture job_id for polling fallback
      const jobId: string | undefined = composeResp.job_id;
      setCurrentJobId(jobId ?? null);
      // 2026-05-26 — 保存 task_id 让"取消合成"按钮能调 DELETE /api/v2/tasks/:id 中止
      const taskId: string | undefined = composeResp.task_id;
      setCurrentTaskId(taskId ?? null);
      setProgress({ percent: 1, step: "已进入合成队列" });

      // Open SSE for progress (P170 1B: 附带 job_id 用于精确订阅)
      const esUrl = jobId
        ? `/api/v2/series/${seriesSlug}/episodes/${epId}/compose/progress?job_id=${encodeURIComponent(jobId)}`
        : `/api/v2/series/${seriesSlug}/episodes/${epId}/compose/progress`;
      const es = new EventSource(esUrl);
      esRef.current = es;

      // 2026-05-27 — 通用 lastEventId 捕获 (兜底, 类型化 listener 各自也捕获)
      es.onmessage = (ev) => { if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId; };

      // P170 1B: 监听 compose.stage — 阶段推进
      es.addEventListener("compose.stage", (ev) => {
        if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId;
        try {
          const data = JSON.parse(ev.data);
          const stageName = data.stage ?? "";
          // 2026-05-22 P0-D: 翻成中文人话 (铁律 #9 toC 兜底), 不把 "compose.shot" 等 raw enum 喂 UI
          const stageZh = labelOfStage(stageName) || stageName || "进行中";
          // 使用 setProgress 的函数形式避免闭包陈旧引用
          setProgress(prev => ({
            percent: data.percent ?? prev.percent,
            step: stageZh,
            detail: `当前: ${stageZh}`,
          }));
        } catch { /* ignore parse errors */ }
      });

      // P170 1B: 监听 compose.progress — 百分比进度
      es.addEventListener("compose.progress", (ev) => {
        if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId;
        try {
          const data = JSON.parse(ev.data);
          setProgress({
            percent: data.percent ?? 0,
            step: data.step ?? "",
            detail: data.detail,
          });
        } catch { /* ignore parse errors */ }
      });

      // P170 1B: 监听 compose.done — 合成完成
      es.addEventListener("compose.done", (ev) => {
        if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId;
        try {
          const data = JSON.parse(ev.data);
          setFinalPath(data.final_video_path ?? data.final_path ?? null);
          if (data.mode === "quick_local_preview") {
            setComposeMode("quick_local_preview");
            setQuickPreview(true);
            setQuickPreviewMessage(data.tts_reason ?? "已生成本地快速样片，适合先检查节奏和字幕。");
          } else if (data.mode === "rough") {
            setComposeMode("rough");
          }
          if (data.tts_status) {
            setTtsStatus(data.tts_status);
            setTtsReason(data.tts_reason ?? null);
          }
          // 2026-05-25 entity-first: SSE compose.done 也带 failed_shots(异步化后这才是主流量).
          // 后端 render.ts 在 done 事件 data 里塞了 failed_shots / failed_shots_reason,
          // 这里 capture, ComposePage 据此 banner 提示 "X 镜异常被 mock 占位".
          if (Array.isArray(data.failed_shots) && data.failed_shots.length > 0) {
            setFailedShots(data.failed_shots);
            setFailedShotsReason(data.failed_shots_reason ?? null);
          }
          // 2026-05-27 — 接通 tts_failures / mock_shots / trim_failures, 之前前端 0 用
          if (Array.isArray(data.tts_failures)) setTtsFailures(data.tts_failures);
          if (Array.isArray(data.mock_shots)) setMockShots(data.mock_shots);
          if (Array.isArray(data.trim_failures)) setTrimFailures(data.trim_failures);
          // 2026-05-27 — 接 shot_segments 真长 (用户截图: 进度条 0:33 跟视频真长 0:35 错位).
          // 同步 startCompose 路径 line 506 已经处理, SSE 异步路径之前漏接 → 前端用 shot.duration_sec
          // fallback → 总长跟真长差几秒. 后端 render.ts SSE 也补发了, 这里收到就 set.
          if (Array.isArray(data.shot_segments) && data.shot_segments.length > 0) {
            setShotSegments(data.shot_segments);
          }
          // 字幕对齐 method / reason — 之前漏接, 让"合成完成"卡能显示是 Whisper 还是字符估算
          if (data.subtitle_align_method) {
            setSubtitleAlignMethod(data.subtitle_align_method);
            setSubtitleAlignReasonZh(data.subtitle_align_reason_zh ?? null);
          }
          // 2026-05-29 P0-1: 选了 BGM 但库缺文件 → 成片无 BGM, 透 banner.
          // 兜底兼容 SSE envelope ({data:{...}}) 与平铺两种 shape, 跟其他字段同源处理.
          const bgmSrc = (data?.data && typeof data.data === "object" && data.data.bgm_missing_reason) ? data.data : data;
          if (bgmSrc.bgm_missing_reason) {
            setBgmMissingReason(bgmSrc.bgm_missing_reason);
            setBgmMissingMood(bgmSrc.bgm_missing_mood ?? null);
          }
          setStage("done");
          setProgress({ percent: 100, step: "合成完成" });
        } catch {
          setStage("done");
          setProgress({ percent: 100, step: "合成完成" });
        }
        stopAll();
        void loadVersions(seriesSlug, epId);
      });

      // P170 1B: 监听 compose.error — 合成失败
      es.addEventListener("compose.error", (ev) => {
        if (ev.lastEventId) lastEventIdRef.current = ev.lastEventId;
        try {
          const data = JSON.parse(ev.data);
          setError(data.error ?? "合成失败");
        } catch {
          setError("合成失败");
        }
        setStage("error");
        stopAll();
      });

      es.onerror = () => {
        onerrorCountRef.current++;
        // SSE 连接失败超过 3 次 → 激活轮询回退
        if (onerrorCountRef.current >= 3 && jobId) {
          startPolling(jobId);
        } else if (onerrorCountRef.current < 3) {
          // 少于 3 次仍报错（SSE 会自动重连）
          // 仅在明确无需重连时标记错误
        }
        // 不在此处 close SSE，让 EventSource 自行重连
      };
    } catch (err: any) {
      // P1-2: 本集已有合成在跑 → 后端 409 ComposeInProgress. 这不是"本次合成失败", 而是被互斥锁
      // 挡住 (另一个手动合成 / 一键管线的 compose 阶段正占着本集). 不写 error 态 (否则页面卡红字),
      // 改 toast 人话提示 + 给"取消当前合成"入口 (holder.task_id), 页面回到 idle 让用户可重试。
      const isComposeBusy = err?.status === 409 || err?.code === "ComposeInProgress";
      if (isComposeBusy) {
        const details = (err?.details ?? {}) as { task_id?: string | null; source?: string };
        const holderTaskId = typeof details.task_id === "string" && details.task_id ? details.task_id : null;
        const { toast } = await import("../components/ui/toast");
        toast.warning("本集已有合成在进行", {
          description: err?.message ?? "请等当前合成完成，或先取消再试。",
          duration: 10000,
          // 只有手动合成 holder 才有 compose task_id 可直接取消; 管线 holder 无 task_id,
          // 提示语已引导去一键管线面板取消 (composeLockBusyMessage 分支)。
          ...(holderTaskId
            ? {
                action: {
                  label: "取消当前合成",
                  onClick: () => {
                    void (async () => {
                      const { toast: t } = await import("../components/ui/toast");
                      try {
                        const res = await fetch(`/api/v2/tasks/${encodeURIComponent(holderTaskId)}/abort`, { method: "POST" });
                        if (res.ok) {
                          t.success("已请求取消当前合成", { description: "稍后可重新点击合成。" });
                        } else {
                          t.error("取消失败", { description: `后端可能仍在合成 (HTTP ${res.status})。` });
                        }
                      } catch (e: any) {
                        t.error("取消失败", { description: e?.message ?? "网络错误，后端可能仍在合成。" });
                      }
                    })();
                  },
                },
              }
            : {}),
        });
        setStage("idle");
        setProgress({ percent: 0, step: "" });
        setRecomposingShotIds([]);
        return;
      }
      setError(err?.message ?? "请求失败");
      setStage("error");
    }
  }, [reset, clearPollTimer]);

  return { stage, progress, error, startCompose, reset, currentJobId, currentTaskId, abortCompose, realignSubtitles, realigningSubtitles, finalPath, ttsStatus, ttsReason, subtitleAlignMethod, subtitleAlignReasonZh, shotSegments, subtitlesOnly, subtitlesOnlyMessage, composeMode, quickPreview, quickPreviewMessage, composeVersions, refreshVersions, versionsLoading, recomposingShotIds, failedShots, failedShotsReason, ttsFailures, mockShots, trimFailures, bgmMissingReason, bgmMissingMood };
}
