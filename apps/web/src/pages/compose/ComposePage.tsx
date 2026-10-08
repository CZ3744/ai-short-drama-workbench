import { computeReadiness, computeStages, composeExportBlockReason } from "./composeReadiness";
import { composePreviewUrl, composeVersionUrl } from "./composePreviewUrl";
// W6-F · ComposePage · 合成界面重构
// T1: icon-only → 图标+文字 / disabled引导 / manual_import翻译
// T2: 按集 + 按版本 sub-tabs
// T3: 时间轴框架性 UI
// T4: 导出按钮引导（disabled → 可点击 + 弹窗解释）
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Empty } from "../../components/ui/empty";
import { ROUTES } from "../../lib/routes";
import { ModelPicker } from "../../components/studio/ModelPicker";
import { PageTransition } from "../../components/studio/PageTransition";
import { useShots } from "../../hooks/useShots";
import { useEpisode } from "../../hooks/useEpisode";
import { useSeries } from "../../hooks/useSeries";
import { useCompose } from "../../hooks/useCompose";
import { useExport, type ExportTarget } from "../../hooks/useExport";
import { useTasksStore } from "../../stores/tasksStore";
import { showErrorToast } from "../../lib/errorTranslate";
import { useConfirm } from "../../components/ui/ConfirmModal";
import { Icon } from "../../components/shared/Icon";
import { StageProgressBar } from "./parts/StageProgressBar";
import { MissingShotsAlert } from "./parts/MissingShotsAlert";
// 2026-05-27 — ShotReadiness inline 到此 (之前 import 自 ClipTimeline.tsx, 但 ClipTimeline
// 整个 372 行 export function 0 处调用, audit #35 P1 #6 死代码. 类型移过来后整个文件删了).

import { FinalPreviewPlayer, type FinalPreviewPlayerHandle } from "./parts/FinalPreviewPlayer";
import { EpisodeVersionTabs } from "./parts/EpisodeVersionTabs";
import { TimelineFramework } from "./parts/TimelineFramework";
import { ExportPanel } from "./parts/ExportPanel";
// 2026-05-28 深度打磨 #3: 台词速览 — 合成完后核对每镜对白, 点台词跳到该段并自动播放
import { DialogueOverview } from "./parts/DialogueOverview";
// 2026-05-18 顶层重设计:
//  - TrimTimeline 不再常驻渲染 8 镜并排 — trim 控件作为 TimelineFramework 选中镜的 inline expand
//  - ExportActions 不再常驻渲染 — ExportPanel 统一卡片化布局右栏
// 2026-05-19: 三栏 layout 左栏配置面板 (替代 orphan 死代码 ComposeSettingsDrawer)
import { ComposeSettingsPanel } from "./parts/ComposeSettingsPanel";
import type { ComposeParams } from "../../hooks/useCompose";
// W5-B: 发送前查看完整提示词 (TTS 等价请求体)
import { PromptReviewButton, type PromptPreview } from "../../components/shared/PromptReviewButton";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "../../components/ui/dropdown-menu";
import * as RadixDropdown from "@radix-ui/react-dropdown-menu";
import { Button } from "../../components/ui/button";
import { apiPost } from "../../lib/api";
import { parseProviderFromModelRef } from "../../lib/modelRef";
import { formatDuration } from "../../lib/format";
// 2026-07-09 audit C16: 合成"部分镜异常"面板此前直接展示原始 TTS/裁切报错与占位回退 code,
// 过 friendlyTaskError 翻人话 (铁律 #9 toC 兜底).
import { friendlyTaskError } from "../../lib/sourceLabels";
// 2026-05-18 一键自动生成全集 — 首帧 → 视频 → 合成串行 chain
import { AutoPipelineLauncher } from "../../components/auto-pipeline/AutoPipelineLauncher";
import { AutoPipelineProgressPanel } from "../../components/auto-pipeline/AutoPipelineProgressPanel";
import { useAutoPipeline } from "../../hooks/useAutoPipeline";


// 2026-07-09 audit C16: mock_shots[].reason 是后端闭合 enum (tts.ts 158/157/238/240/241),
// 不能原样展示给用户. 优先复用同 shot_id 的 failedShots.reason_zh (更具体), 查不到再走此字典.
const MOCK_SHOT_REASON_LABEL: Record<string, string> = {
  "reuse-asset-missing": "复用的历史片段已丢失",
  "no-picked-video-generation": "尚未选定该镜的视频",
  "generation-record-lost": "视频生成记录丢失",
  "asset-file-missing": "视频文件已丢失",
};

export default function ComposeRoute() {
  const { slug, epId } = useParams();
  return <ComposePage key={`${slug}:${epId}`} />;
}

function ComposePage() {
  const { slug, epId } = useParams<{ slug: string; epId: string }>();
  const navigate = useNavigate();
  const { shots, isLoading } = useShots(slug, epId);
  const { data: episode } = useEpisode(slug, epId);
  const { data: series } = useSeries(slug);
  const confirm = useConfirm();
  const compose = useCompose();
  const exportState = useExport();
  // 2026-05-27 — composeShotMap subscribe 删 (audit #35 P1 #7), 全文 0 引用
  // 一键自动管线 hook — record / start / abort / retryStage / reset
  const autoPipeline = useAutoPipeline();

  // 2026-05-26: 离页再回来恢复 pipeline 进度. 后端 pipeline 还在跑 (fire-and-forget),
  // 前端 unmount 时 SSE 取消订阅, record reset; mount 时调 rehydrate 拉最新 running pipeline 接回 UI.
  useEffect(() => {
    if (!slug || !epId) return;
    void autoPipeline.rehydrate(slug, epId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, epId]);

  const [ttsModelRef, setTtsModelRef] = useState<string | null>(null);
  const ttsProviderId = ttsModelRef ? parseProviderFromModelRef(ttsModelRef) : undefined;

  // 2026-05-19: 左栏配置面板推上来的完整 params (BGM / 字幕 / 转场 / 多角色音色 / 水印 / 注释字幕 / 全集音色覆盖)
  // 老 ComposePage 只发 tts_provider_id, 后端能干 13 字段但 UI 0 接入 — 现在打通.
  const composeParamsRef = useRef<ComposeParams>({});
  const seriesAspectRatio = series?.defaults?.aspect_ratio ?? "9:16";
  const [previewAspectRatio, setPreviewAspectRatio] = useState("9:16");
  const handleParamsChange = useCallback((next: ComposeParams) => {
    composeParamsRef.current = next;
    if (next.aspect_ratio) setPreviewAspectRatio(next.aspect_ratio);
  }, []);

  useEffect(() => {
    if (!composeParamsRef.current.aspect_ratio) {
      setPreviewAspectRatio(seriesAspectRatio);
    }
  }, [seriesAspectRatio]);

  // 2026-05-19: firstMissingRef 原本挂在 ClipTimeline 第一个 missing block, 现 ClipTimeline 删了
  // 保留 ref 给 MissingShotsAlert "定位" 按钮做兼容 (无 ref 则 scrollTo 空跑, 不报错)
  const firstMissingRef = useRef<HTMLDivElement | null>(null);
  const [recomposingShotIds, setRecomposingShotIds] = useState<string[]>([]);

  // T4: 导出引导 modal
  const [showExportGuide, setShowExportGuide] = useState(false);

  // 2026-05-29 P0-2: 总时长区分"估算"(shot.duration_sec 累加, 跟真长常差几秒) vs "真长"
  // (后端 ffprobe 累加 shotSegments). 没拿到 shotSegments (初次进页 / 还没合成) 显式标"(估算)",
  // 不直接秀一个跟成片对不上的数字让用户误信 (用户铁律: 进度条/总长 = 视频真长, 不撒谎).
  const hasRealDurations = !!compose.shotSegments && compose.shotSegments.length > 0;
  const totalDuration = useMemo(() => {
    if (hasRealDurations) {
      // 真长: 取所有 shotSegments 的最大 end_sec (整集时间轴右端 = 真总长)
      return compose.shotSegments!.reduce((max, s) => Math.max(max, s.end_sec), 0);
    }
    return shots.reduce((acc, s) => acc + (s.duration_sec || 0), 0);
  }, [hasRealDurations, compose.shotSegments, shots]);
  const readiness = useMemo(() => shots.map(computeReadiness), [shots]);
  const missingShots = useMemo(() => readiness.filter((r) => !r.ready), [readiness]);

  // 2026-07-10 P2-9 (铁律 #5 状态精确) — 本次成片里含"占位镜"(灰屏/假画面顶替真实视频) 的数量.
  // 后端 compose response 的 failedShots (解析失败被占位) + mockShots (无真视频占位) 去重到真实 shot,
  // 排除 __audio_mux__ / __compose_burn__ 等伪 id. 传给导出面板常驻黄条 + 导出前二次确认,
  // 避免灰屏占位成片被当正式成片交付出去.
  const placeholderShotCount = useMemo(() => {
    // quick_local_preview 样片: 整集全是假画面测试图案 (无真实视频), 全部镜头算占位.
    if (compose.quickPreview) return shots.length;
    const ids = new Set<string>();
    for (const f of compose.failedShots) if (shots.some((s) => s.id === f.shot_id)) ids.add(f.shot_id);
    for (const m of compose.mockShots) if (shots.some((s) => s.id === m.shot_id)) ids.add(m.shot_id);
    return ids.size;
  }, [compose.quickPreview, compose.failedShots, compose.mockShots, shots]);

  const composing = compose.stage === "composing";
  const composeStateDone = compose.stage === "done";
  // 2026-05-25 — 用户报"合成完成弹窗之后就回退到导出之前的状态了":
  // 原 done 完全依赖 useCompose 内部 React state (component-local). SWR 重试 / HMR / strict mode /
  // 任何 ComposePage unmount-remount 都会让 useCompose 重置 → stage="idle" → UI 误以为没合成.
  // 修: composedSucceeded 同时看 React state 和后端真实文件 (composeVersions 列表). 后端有 full / rough
  // 版本就说明合成成功过, UI 显示成片. React state 丢了不影响.
  const composedSucceeded = composeStateDone || compose.composeVersions.length > 0;
  const done = composedSucceeded;
  // UP-6 (2026-07-22 词表统一): `done` 上面故意把"预览片"(rough) 也算"合成完成"(解锁预览播放器/
  // 时间轴等 UI), 但预览片不能导出——只有"成片"(full)或"占位样片"(quick_local_preview, 没素材时的
  // 诚实降级, 仍会真写 final.mp4 可导出)才是可导出产物。跟下面 finalSrc 同一套双信号判断法:
  // composeStateDone 时优先信实时 compose.composeMode (刚跑完这次合成的真实模式), 避免 composeVersions
  // 磁盘列表还没来得及刷新导致误判; 否则 fallback 磁盘 composeVersions 列表同一判据 (页面刷新/重进场景)。
  const hasExportableFinal = useMemo(() => {
    if (composeStateDone && compose.composeMode) {
      return compose.composeMode === "full" || compose.composeMode === "quick_local_preview";
    }
    return compose.composeVersions.some((v) => v.mode === "full" || v.mode === "quick_local_preview");
  }, [composeStateDone, compose.composeMode, compose.composeVersions]);
  const pct = Number.isFinite(compose.progress.percent) ? Math.min(100, Math.max(0, compose.progress.percent)) : 0;
  const stageView = useMemo(() => computeStages(readiness, composing, done), [readiness, composing, done]);

  // 2026-05-25 — mount 时主动拉 compose 版本列表, 让"上次合成的成片"页面刷新后仍能展示.
  // 同时让 finalSrc fallback 走 versions[0].url, 不再仅依赖 React state.
  useEffect(() => {
    if (slug && epId) {
      compose.refreshVersions(slug, epId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, epId]);

  // 2026-05-22 → 2026-05-25 — 用户连续 2 次报"合成完成还是没显示成片":
  // 1. 后端 final_video_path 是相对路径, 直接喂 <video src> 404. 用 API URL 包一层.
  // 2. 进一步: React state 不可靠. 优先用 React state (实时新鲜), fallback 后端 composeVersions 列表.
  const finalSrc = useMemo<string | null>(() => {
    if (!slug || !epId) return null;
    // 2026-05-27 — 加 cache buster. 用户原话工作流"反复微调", 第二次合成后视频
    // URL 跟第一次一样 (固定 final.mp4), 浏览器从缓存读旧版 → 用户以为"改的没生效".
    // composeMode + finalPath 都是 SSE 推的, 都变 = 真合成完了, 用它们做 cache key.
    // 优先实时 SSE 推的 finalPath
    if (composeStateDone && compose.finalPath) {
      return composePreviewUrl(slug, epId, compose.finalPath, compose.currentJobId);
    }
    // Fallback: 用后端 composeVersions 列表最新 full / quick_local_preview 版本 URL.
    // 即使 React state 被 reset (HMR / 路由切换), 只要后端 final.mp4 还在就能播放.
    const latest = compose.composeVersions.find((v) => v.mode === "full")
      ?? compose.composeVersions.find((v) => v.mode === "quick_local_preview")
      ?? compose.composeVersions.find((v) => v.mode === "rough")
      ?? compose.composeVersions[0];
    return latest ? composeVersionUrl(latest.url, latest.created_at) : null;
  }, [composeStateDone, compose.finalPath, compose.currentJobId, compose.composeVersions, slug, epId]);
  // 2026-05-26 — 真 segments 优先用后端 compose response 的 shotSegments (ffprobe 真长累加).
  // 没拿到时(初次进页 / 还没合成) fallback 到 shot.duration_sec 累加 (旧逻辑, 24s 总),
  // 等用户合成完后端返 shotSegments 才会精确(50s 真长). 修 12s 显示错镜 bug.
  const segments = useMemo(
    () => readiness.map((r, i) => {
      const realSeg = compose.shotSegments?.find((s) => s.shot_id === r.shotId);
      if (realSeg) {
        return { shotId: r.shotId, label: r.label, durationSec: realSeg.end_sec - realSeg.start_sec, startSec: realSeg.start_sec, endSec: realSeg.end_sec, ready: r.ready };
      }
      const start = readiness.slice(0, i).reduce((acc, x) => {
        const xReal = compose.shotSegments?.find((s) => s.shot_id === x.shotId);
        return acc + (xReal ? xReal.end_sec - xReal.start_sec : x.durationSec);
      }, 0);
      return { shotId: r.shotId, label: r.label, durationSec: r.durationSec, startSec: start, endSec: start + r.durationSec, ready: r.ready };
    }),
    [readiness, compose.shotSegments],
  );

  // T4: 导出不可用原因
  const exportBlockReason = useMemo(
    () => composeExportBlockReason(done, composing, readiness),
    [done, composing, readiness],
  );

  // 2026-05-19: 合并左栏 panel 最新 params + 顶部 TTS 模型(冗余兼容)
  // TopBar 的 ttsProviderId 优先级 > panel.tts_provider_id, 让顶部"快速换模型"立即生效
  function buildComposeParams(mode: "full" | "rough", overrides?: Record<string, unknown>): ComposeParams {
    const fromPanel = composeParamsRef.current;
    return {
      ...fromPanel,
      mode,
      ...(ttsProviderId ? { tts_provider_id: ttsProviderId } : {}),
      ...(overrides ?? {}),
    };
  }

  async function doCompose(overrides?: Record<string, unknown>) {
    if (!slug || !epId || composing) return;
    if (shots.length === 0) {
      toast.error("还没分镜，先去分镜板规划", { action: { label: "去分镜板", onClick: () => navigate(`/studio/${slug}/storyboard/${epId}`) } });
      return;
    }
    const videoShotCount = readiness.filter((r) => r.hasPickedVideo).length;
    if (videoShotCount === 0) {
      // 2026-07-10 P2-9 (铁律 #5 状态精确) — 如实描述零视频合成的真实产物. 后端此场景产出的是
      // 占位样片(灰屏/测试图案假画面, 只能看个节奏), 不是正式成片; 老文案"只有字幕和配音(无画面)"
      // 与实际不符(占位路径画面是假图案, 且是否有声随后端 preview 开关而不同). 改为如实 + 引导去粗剪.
      const hasAnyFirstFrame = readiness.some((r) => r.hasPickedFrame);
      const ok = await confirm({
        title: "还没有视频素材，只能出占位样片",
        description:
          "当前所有镜头都还没有视频。这样合成得到的不是正式成片，而是一个占位样片：\n" +
          "· 画面全部是灰色占位块，不是真实画面\n" +
          "· 只适合先大致看看整集节奏和字幕，不能用于交付\n\n" +
          (hasAnyFirstFrame
            ? "更推荐点「粗剪预览」——它用你已挑的真实首帧 + 配音拼样片，比占位样片直观得多。配音费用取决于你选择的模型。"
            : "建议先为镜头生成视频；若已有首帧，可到单镜创作页挑首帧后用「粗剪预览」。"),
        variant: "warning",
        confirmLabel: "仍要生成占位样片",
        cancelLabel: "先不合成",
      });
      if (!ok) return;
    }
    try { await compose.startCompose(slug, epId, buildComposeParams("full", overrides)); }
    catch (err) { showErrorToast(err, "合成失败"); }
  }

  const handleCompose = () => doCompose();

  const handlePreviewRough = async () => {
    if (!slug || !epId || composing) return;
    if (shots.length === 0) {
      toast.info("先添加分镜，就能预览故事的节奏", { action: { label: "去分镜板", onClick: () => navigate(`/studio/${slug}/storyboard/${epId}`) } });
      return;
    }
    try { await compose.startCompose(slug, epId, buildComposeParams("rough")); }
    catch (err) { showErrorToast(err, "粗剪失败"); }
  };

  // 2026-05-26 整集片头片尾 trim — 用户在 FinalPreviewPlayer 拖把手选范围, 导出时透传给后端.
  // trimStart === 0 + trimEnd === null 表示不裁切 (导出完整 final.mp4).
  const [episodeTrimStartSec, setEpisodeTrimStartSec] = useState<number>(0);
  const [episodeTrimEndSec, setEpisodeTrimEndSec] = useState<number | null>(null);
  const handleTrimChange = useCallback((start: number, end: number | null) => {
    setEpisodeTrimStartSec(start);
    setEpisodeTrimEndSec(end);
  }, []);

  // 2026-05-28 深度打磨 #3 — FinalPreviewPlayer ref, DialogueOverview 点击 chip 调 seekTo
  const playerRef = useRef<FinalPreviewPlayerHandle | null>(null);
  const handleJumpToSec = useCallback((sec: number) => {
    playerRef.current?.seekTo(sec);
  }, []);
  // 2026-05-27 — 只在切系列/集时 reset trim, 不在 compose.finalPath 变 null 时 reset.
  // 之前 watch compose.finalPath 会把"重合成单镜 / 再合成一次" (useCompose.reset 清 finalPath)
  // 也算成 reset trim 的触发, 用户拖好的片头片尾选择被无声丢, 必须重新拖一次. 反人类.
  // 真正需要 reset 的场景是切到不同系列/集 (deps 的 slug/epId 变化即可触发).
  useEffect(() => {
    setEpisodeTrimStartSec(0);
    setEpisodeTrimEndSec(null);
  }, [slug, epId]);

  const handleExport = async (target: ExportTarget, folderPath?: string, formats?: string[]) => {
    if (!slug || !epId) return;
    try {
      await exportState.startExport(slug, epId, {
        target,
        folderPath,
        formats,
        includeCover: true,
        includeMetadata: true,
        ...(episodeTrimStartSec > 0.05 ? { episodeTrimStartSec } : {}),
        ...(episodeTrimEndSec !== null && episodeTrimEndSec > 0 ? { episodeTrimEndSec } : {}),
      });
    } catch (err) {
      showErrorToast(err, "导出失败");
    }
  };

  const handleRecomposeShot = async (shotId: string) => {
    if (!slug || !epId || composing) return;
    setRecomposingShotIds((prev) => [...prev, shotId]);
    try {
      await compose.startCompose(slug, epId, { ...buildComposeParams("full"), only_shot_ids: [shotId] });
    } catch (err) {
      showErrorToast(err, "重合成失败");
    } finally {
      setRecomposingShotIds((prev) => prev.filter((x) => x !== shotId));
    }
  };

  // 2026-05-22 — 用户原话 "点击这个无法跳转":
  // 旧实现 scrollIntoView(firstMissingRef) — firstMissingRef 在 ClipTimeline 删除后不再挂载
  // 任何 DOM 节点, scrollIntoView 是 no-op. 改成跳转到首个未就绪 shot 的单镜创作页, 让用户去修.
  const handleScrollToFirstMissing = () => {
    const firstMissing = missingShots[0];
    if (firstMissing && slug && epId) {
      navigate(`/studio/${slug}/shot-stage/${epId}/${firstMissing.shotId}`);
    }
  };

  // T2: 切集导航
  // 2026-05-27 — 合成进行中切集要二次确认. 之前直接 navigate, useCompose unmount → SSE 关闭,
  // 后端实际还在跑, 用户回到本集合成显示成 idle, 过会儿出现 final.mp4 但用户已不知道. 反人类.
  const handleEpisodeChange = async (newEpId: string) => {
    if (!slug) return;
    if (composing) {
      const ok = await confirm({
        title: "合成正在进行, 离开本集?",
        description: "本集合成会继续在后台进行 (任务中心可查看状态), 但当前页面不再显示进度. 确定离开?",
        confirmLabel: "继续切到下一集",
        cancelLabel: "留在本集",
        variant: "warning",
      });
      if (!ok) return;
    }
    navigate(`/studio/${slug}/compose/${newEpId}`);
  };

  if (!slug || !epId) {
    return <div className="flex min-h-screen items-center justify-center p-6"><Empty title="先选择要合成的剧集" description="从作品的分集列表进入，即可合成并导出成片。" /></div>;
  }

  return (
    <PageTransition>
      <div className="v24-compose-page" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-canvas)", overflow: "hidden" }}>

        {/* ── TopBar — 2026-05-26 重设计: 用户原话"按钮不够直观, 离得太远".
            原: 6 个按钮 (TTS / 查看请求 / 一键全集 / 粗剪 / 合成 / 取消) 平铺一行, 主次不分.
            新: 主 CTA "合成成片"右侧 + "⋯ 更多" 下拉收纳次要 (TTS模型 / 查看请求 / 一键全集 / 粗剪),
                合成中显示进度按钮 + 取消按钮. 集中视觉焦点到主 CTA. */}
        <div style={{ padding: "12px 24px", background: "#fff", borderBottom: "1px solid var(--ink-100)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--brand-700)", textTransform: "uppercase" }}>合成</div>
            <h2 style={{ margin: "2px 0 0", fontFamily: "'Noto Serif SC', serif", fontSize: 18, fontWeight: 600, color: "var(--ink-900)" }}>
              {episode?.title ?? epId}
            </h2>
          </div>
          <span className={`mk-pill ${shots.length > 0 && missingShots.length === 0 ? "mk-pill--ready" : "mk-pill--draft"}`} style={{ height: 22 }}>
            {readiness.filter((r) => r.ready).length} / {shots.length} 镜就绪
          </span>
          <span
            style={{ fontSize: 12, color: "var(--ink-500)" }}
            title={hasRealDurations
              ? "合成产物真实总时长 (ffprobe 实测)"
              : "按每镜设定时长累加的估算值 — 合成完成后显示成片真实总时长"}
          >
            总时长 {formatDuration(totalDuration)}
            {!hasRealDurations && <span style={{ color: "var(--ink-400)", marginLeft: 4 }}>(估算)</span>}
          </span>
          <span style={{ flex: 1 }} />
          {/* 合成中: 主按钮显进度 + 取消; 否则: 主 CTA + 更多下拉 */}
          {composing ? (
            <>
              <Button variant="primary" loading disabled>
                合成中 {pct.toFixed(0)}%
              </Button>
              <Button
                variant="secondary"
                size="sm"
                iconLeft="close"
                onClick={() => { void compose.abortCompose(); }}
                title="停止本次合成 — 已生成的镜头素材会保留, 可稍后重新合成"
              >
                取消合成
              </Button>
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11, color: "var(--ink-500)" }}>配音模型</span>
                <ModelPicker kind="tts" value={ttsModelRef} onChange={setTtsModelRef} size="sm" placeholder="按合成设置" />
              </div>
              <PromptReviewButton
                label="查看合成请求"
                size="sm"
                disabled={shots.length === 0 || isLoading}
                title="发送前审核完整合成请求和配音文本"
                loadPrompt={async (): Promise<PromptPreview> => apiPost<PromptPreview>(`/api/v2/series/${slug}/episodes/${epId}/preview-compose-prompt`, buildComposeParams("full"))}
                onSend={async (editedText: string) => { await doCompose({ tts_script_override: { __all: editedText } }); }}
              />
              <Button
                variant="primary"
                iconLeft={done ? "refresh" : "play"}
                onClick={handleCompose}
              >
                {done ? "再合成一次" : "合成成片"}
              </Button>
              {/* 2026-07-09 audit(UX 第一性原理) — 粗剪预览免费省钱, 成本敏感项目里该第一眼可见(以前只埋在"更多"下拉).
                  提为"合成成片"旁次级按钮, 让用户第一步就能 30s 免费看节奏、再决定要不要正式合成. 下拉里保留同项作备份. */}
              <Button
                variant="secondary"
                iconLeft="play"
                onClick={() => { void handlePreviewRough(); }}
                title="用已选首帧和配音生成预览片，先检查节奏。是否收费取决于所选配音模型。"
              >
                粗剪预览
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" title="更多合成相关操作">
                    更多 <span style={{ marginLeft: 4, fontSize: 10 }}>▾</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>合成方式</DropdownMenuLabel>
                  <DropdownMenuItem
                    onSelect={(e) => { e.preventDefault(); void handlePreviewRough(); }}
                    title="用已选首帧和配音预览节奏；配音费用取决于所选模型"
                  >
                    <Icon name="play" size={13} style={{ marginRight: 8 }} /> 粗剪预览
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>高级</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <RadixDropdown.Item asChild>
                    <div style={{ padding: "4px 0", outline: "none" }}>
                      <AutoPipelineLauncher
                        slug={slug}
                        epId={epId}
                        pending={autoPipeline.pending}
                        disabled={!!autoPipeline.record && autoPipeline.record.status === "running"}
                        onStart={async (body) => {
                          if (!slug || !epId) return;
                          await autoPipeline.start(slug, epId, body);
                        }}
                        label="⚡ 一键全自动生成全集"
                      />
                    </div>
                  </RadixDropdown.Item>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>

        {/* 2026-05-18 一键自动管线进度面板 — record 在跑时显示, 完成后用户可点 "进入合成页" 自跳 */}
        {autoPipeline.record && (
          <div style={{ padding: "12px 24px", background: "#fff", borderBottom: "1px solid var(--ink-100)" }}>
            <AutoPipelineProgressPanel
              record={autoPipeline.record}
              pending={autoPipeline.pending}
              onAbort={() => autoPipeline.abort()}
              // 2026-05-19 反馈 #2: 透传 opts 让"重试失败的 N 项"只重抽失败子集
              onRetryStage={(stage, opts) => autoPipeline.retryStage(stage, opts)}
              onJumpToCompose={() => {
                // 完成时自动滚到中栏预览, 并清空 record 让 UI 干净
                const main = document.querySelector(".v24-compose-page");
                if (main) main.scrollIntoView({ behavior: "smooth", block: "start" });
                autoPipeline.reset();
                // 强制刷新一遍 episode + shots — 让 picked / final_video_path 同步到 useShots
                compose.refreshVersions(slug, epId);
              }}
              onClose={() => autoPipeline.reset()}
            />
          </div>
        )}

        {/* ── T2: 按集 sub-tabs ── */}
        <div style={{ padding: "8px 24px", background: "#fafafa", borderBottom: "1px solid var(--ink-100)" }}>
          <EpisodeVersionTabs
            slug={slug}
            activeEpId={epId}
            onEpisodeChange={handleEpisodeChange}
          />
        </div>

        {/* ── Stage progress bar ── */}
        <div style={{ padding: "12px 24px", background: "#fff", borderBottom: "1px solid var(--ink-100)" }}>
          <StageProgressBar
            current={stageView.current}
            completed={stageView.completed}
            stageDetails={stageView.details}
            running={composing}
          />
        </div>

        {/* ── Missing alert ── */}
        {missingShots.length > 0 && !composing && (
          <div style={{ padding: "12px 24px 0" }}>
            <MissingShotsAlert
              missingCount={missingShots.length}
              totalCount={shots.length}
              missingLabels={missingShots.map((r) => r.label)}
              onClick={handleScrollToFirstMissing}
              dismissible
            />
          </div>
        )}

        {/* ── Main: 2026-05-26 三栏恢复 (用户澄清"三栏跟之前一样, 视频放中间, 按钮重新排布"):
            左 配置 / 中 预览 / 右 导出. ExportPanel 内部已重写紧凑横排 (主按钮顶部 + 去向/规格 chip),
            放回右栏 340px 内能塞下, 右栏纵向延伸不影响中栏视频区域高度. */}
        <div className="compose-columns" style={{ flex: 1, display: "grid", gridTemplateColumns: "280px minmax(0, 1fr) 340px", gap: 0, minHeight: 0 }}>
          {/* 左: 合成配置面板 — 5 tab (TTS / 字幕 / BGM / 转场 / 高级)
              2026-05-27 — 合成中加灰禁用整个面板. 之前合成中用户改参数, 误以为本次合成会用
              新参数, 实际本次用启动那一刻 snapshot 的旧参数. 灰 + 顶部小字提示一致行为. */}
          <div style={{ position: "relative" }}>
            <ComposeSettingsPanel
              seriesSlug={slug}
              epId={epId}
              defaultAspectRatio={seriesAspectRatio}
              onParamsChange={handleParamsChange}
            />
            {composing && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  background: "rgba(252,250,247,0.7)",
                  zIndex: 10,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "flex-start",
                  paddingTop: 28,
                  gap: 8,
                  pointerEvents: "auto",
                  borderRight: "1px solid var(--ink-100)",
                  cursor: "not-allowed",
                }}
                title="本次合成参数已锁定, 想换设置请等下次合成"
              >
                <div style={{
                  padding: "8px 14px",
                  borderRadius: 8,
                  background: "var(--surface-card)",
                  border: "1px solid var(--ink-200)",
                  fontSize: 11.5,
                  color: "var(--ink-700)",
                  fontWeight: 600,
                  textAlign: "center",
                  maxWidth: 240,
                  lineHeight: 1.5,
                  boxShadow: "0 2px 8px rgba(40,32,24,0.06)",
                }}>
                  ⏳ 本次合成参数已锁定
                  <div style={{ fontSize: 10.5, color: "var(--ink-500)", fontWeight: 400, marginTop: 4 }}>
                    想换设置, 等当前合成完再改
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 中: 预览 (视频 + 字幕对齐卡 + trim + 控件) */}
          <div style={{ padding: "16px 24px", overflow: "auto", minWidth: 0 }}>
            {isLoading ? (
              <div style={{ padding: 40, textAlign: "center", color: "var(--ink-400)" }}>加载中…</div>
            ) : shots.length === 0 ? (
              // 2026-07-22 X5-5 (A4-12): 原来只有文字建议, 没有可点击按钮, 用户得自己找导航.
              <Empty
                title="还没有分镜"
                description="先回剧本页点「转去分镜」让 LLM 拆镜头"
                cta="去剧本页"
                onCta={() => navigate(ROUTES.script(slug))}
              />
            ) : (
              <>
                {/* 2026-05-25 entity-first — 合成完成但有镜头资源失败 (后端 mock 占位 + failed_shots 暴露).
                    用户视角: 5 镜 3 镜视频文件丢失 → 后端用占位画面 → 这条 banner 提示真相 + 列出失败镜头,
                    点击跳分镜补救. 缺这条 banner 用户播放成片才发现黑屏 — WORK_LOG 2026-05-22 留尾 #2. */}
                {done && compose.failedShots.length > 0 && (
                  <div
                    className="mk-card"
                    style={{
                      padding: 14, marginBottom: 14,
                      background: "var(--warn-bg, #fef3c7)",
                      border: "1.5px solid var(--warn, #f59e0b)",
                      borderRadius: 10,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <Icon name="warning" size={16} style={{ color: "var(--warn, #b45309)" }} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--warn, #b45309)" }}>
                        本次合成有 {compose.failedShots.length} 镜异常 — 已用占位画面顶替
                      </span>
                    </div>
                    {compose.failedShotsReason && (
                      <div style={{ fontSize: 11.5, color: "var(--ink-700)", lineHeight: 1.55, marginBottom: 10 }}>
                        {compose.failedShotsReason}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {compose.failedShots.map((f) => {
                        const shotMeta = shots.find((s) => s.id === f.shot_id);
                        const label = shotMeta?.title?.trim() || `第 ${shotMeta?.index ?? "?"} 镜`;
                        return (
                          <button
                            key={f.shot_id}
                            type="button"
                            onClick={() => {
                              if (!slug || !epId) return;
                              navigate(`/studio/${slug}/shot-stage/${epId}/${f.shot_id}`);
                            }}
                            title={f.reason_zh}
                            style={{
                              height: 24, padding: "0 10px",
                              borderRadius: 999,
                              background: "#fff",
                              border: "1px solid var(--warn, #f59e0b)",
                              color: "var(--warn, #b45309)",
                              fontSize: 11, fontWeight: 600,
                              cursor: "pointer",
                              display: "inline-flex", alignItems: "center", gap: 4,
                            }}
                          >
                            <Icon name="edit" size={10} /> {label} · 去修
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {/* 2026-05-27 — 细节问题 banner. 后端早就返了 tts_failures / mock_shots /
                    trim_failures 三个数组 (各镜级失败明细), 前端 0 用. 用户拿到部分镜静音 /
                    部分黑屏 / 部分 trim 失效却不知道哪一镜出问题. agent audit #35 P0 #5.
                    跟 failedShots banner (整集级解析失败) 互补 — 这条是"个别镜的子环节失败". */}
                {done && (compose.ttsFailures.length > 0 || compose.mockShots.length > 0 || compose.trimFailures.length > 0) && (
                  <div
                    className="mk-card"
                    style={{
                      padding: "10px 14px", marginBottom: 12,
                      background: "#fffbeb",
                      border: "1px solid #fde68a",
                      borderRadius: 8,
                      fontSize: 11.5,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <Icon name="info" size={14} style={{ color: "#b45309" }} />
                      <strong style={{ color: "var(--ink-900)" }}>合成细节有部分镜异常</strong>
                      <span style={{ fontSize: 10.5, color: "var(--ink-500)" }}>
                        (整集合成成功, 但下面这些镜的子环节有问题, 点跳去修)
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {compose.ttsFailures.filter(f => f.shot_id !== "__audio_mux__").map((f) => {
                        const shotMeta = shots.find((s) => s.id === f.shot_id);
                        const label = shotMeta?.title?.trim() || `第 ${shotMeta?.index ?? "?"} 镜`;
                        return (
                          <div key={`tts-${f.shot_id}`} style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-800)" }}>
                            <span style={{ minWidth: 50, color: "#b45309", fontWeight: 600 }}>TTS</span>
                            <button
                              type="button"
                              onClick={() => slug && epId && navigate(`/studio/${slug}/shot-stage/${epId}/${f.shot_id}`)}
                              style={{
                                background: "none", border: "none", color: "var(--brand-700)",
                                textDecoration: "underline", cursor: "pointer", padding: 0, fontWeight: 600,
                              }}
                            >
                              {label}
                            </button>
                            <span style={{ color: "var(--ink-500)" }}>· {friendlyTaskError(f.error)}</span>
                          </div>
                        );
                      })}
                      {compose.mockShots.map((m) => {
                        const shotMeta = shots.find((s) => s.id === m.shot_id);
                        const label = shotMeta?.title?.trim() || `第 ${shotMeta?.index ?? "?"} 镜`;
                        // 2026-07-09 audit C16: 优先用同 shot 的 failedShots.reason_zh (后端已给的具体中文原因),
                        // 查不到再走本地枚举字典兜底, 都不命中才退到 friendlyTaskError 兜底 (绝不裸露 enum).
                        const reasonZh = compose.failedShots.find((f) => f.shot_id === m.shot_id)?.reason_zh
                          || MOCK_SHOT_REASON_LABEL[m.reason]
                          || friendlyTaskError(m.reason);
                        return (
                          <div key={`mock-${m.shot_id}`} style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-800)" }}>
                            <span style={{ minWidth: 50, color: "#b45309", fontWeight: 600 }}>占位画面</span>
                            <button
                              type="button"
                              onClick={() => slug && epId && navigate(`/studio/${slug}/shot-stage/${epId}/${m.shot_id}`)}
                              style={{
                                background: "none", border: "none", color: "var(--brand-700)",
                                textDecoration: "underline", cursor: "pointer", padding: 0, fontWeight: 600,
                              }}
                            >
                              {label}
                            </button>
                            <span style={{ color: "var(--ink-500)" }}>· {reasonZh}</span>
                          </div>
                        );
                      })}
                      {compose.trimFailures.map((t) => {
                        const shotMeta = shots.find((s) => s.id === t.shot_id);
                        const label = shotMeta?.title?.trim() || `第 ${shotMeta?.index ?? "?"} 镜`;
                        return (
                          <div key={`trim-${t.shot_id}`} style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-800)" }}>
                            <span style={{ minWidth: 50, color: "#b45309", fontWeight: 600 }}>裁切</span>
                            <button
                              type="button"
                              onClick={() => slug && epId && navigate(`/studio/${slug}/shot-stage/${epId}/${t.shot_id}`)}
                              style={{
                                background: "none", border: "none", color: "var(--brand-700)",
                                textDecoration: "underline", cursor: "pointer", padding: 0, fontWeight: 600,
                              }}
                            >
                              {label}
                            </button>
                            <span style={{ color: "var(--ink-500)" }}>· {friendlyTaskError(t.error)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 2026-05-27 — 音轨状态 banner. 用户原话"为什么合成的视频里没有语音":
                    真因常见两条: (a) TTS provider 没配 Key / instance 没选 → ctx.ttsProv = null
                    → ttsAudioSegments 全空 → muxTtsAudio 返 ok:false → silent 退回视频原声 →
                    AI 生成视频本就无原声 → 整集静音. (b) audio_mode=original 但 AI 视频确实无原声.
                    后端 SSE compose.done 一直发了 tts_status / tts_reason, 但 ComposePage UI
                    没接入显示, 用户拿到无声视频毫无头绪. 加 banner: tts_status="no_provider"/"failed"
                    显眼红/黄, 写出真原因 + 去设置 CTA. */}
                {done && (compose.ttsStatus === "no_provider" || compose.ttsStatus === "failed" || compose.ttsReason) && (
                  <div
                    className="mk-card"
                    style={{
                      padding: "10px 14px", marginBottom: 12,
                      background: compose.ttsStatus === "no_provider" ? "#fef2f2" : "#fff7ed",
                      border: `1px solid ${compose.ttsStatus === "no_provider" ? "#fca5a5" : "#fdba74"}`,
                      borderRadius: 8,
                      fontSize: 12,
                      display: "flex", alignItems: "flex-start", gap: 10,
                    }}
                  >
                    <Icon
                      name={compose.ttsStatus === "no_provider" ? "warning" : "info"}
                      size={15}
                      style={{
                        color: compose.ttsStatus === "no_provider" ? "#b91c1c" : "#c2410c",
                        flexShrink: 0,
                        marginTop: 1,
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: "var(--ink-900)", marginBottom: 3 }}>
                        {compose.ttsStatus === "no_provider"
                          ? "本集无语音 — TTS 配音模型未就绪"
                          : "本集语音生成不完整"}
                      </div>
                      <div style={{ color: "var(--ink-700)", lineHeight: 1.55 }}>
                        {compose.ttsReason ?? "TTS 失败, 已退回视频原声 (AI 生成视频通常无原声, 表现为整集静音)."}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => navigate("/settings")}
                      style={{
                        fontSize: 11.5,
                        padding: "5px 12px",
                        borderRadius: 6,
                        background: "var(--surface-card)",
                        color: "var(--brand-700)",
                        border: "1px solid var(--ink-200)",
                        cursor: "pointer",
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                      title="去设置页配 TTS Provider (智谱/MiniMax/edge-tts 等), 然后重新合成"
                    >
                      去配 TTS
                    </button>
                  </div>
                )}

                {/* 2026-05-29 P0-1 (silent skip 红线) — BGM 库缺文件 banner.
                    用户在 BGM tab 选了「温馨」等风格, 但 data/bgm-library/ 没对应音频文件 →
                    合成不阻塞但成片无 BGM. 后端 compose.done 带 bgm_missing_reason (toC 整句),
                    这里像 ttsStatus banner 那样显眼提示 + 引导去 BGM 库添加. 缺这条用户拿到
                    无 BGM 视频毫无头绪 (之前后端只 warn 一行, 前端 0 显示). */}
                {done && compose.bgmMissingReason && (
                  <div
                    className="mk-card"
                    style={{
                      padding: "10px 14px", marginBottom: 12,
                      background: "#fff7ed",
                      border: "1px solid #fdba74",
                      borderRadius: 8,
                      fontSize: 12,
                      display: "flex", alignItems: "flex-start", gap: 10,
                    }}
                  >
                    <Icon name="music" size={15} style={{ color: "#c2410c", flexShrink: 0, marginTop: 1 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, color: "var(--ink-900)", marginBottom: 3 }}>
                        这一版没有背景音乐{compose.bgmMissingMood ? ` — 缺「${compose.bgmMissingMood}」曲目` : ""}
                      </div>
                      <div style={{ color: "var(--ink-700)", lineHeight: 1.55 }}>
                        {compose.bgmMissingReason}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        // 没有独立 BGM 库管理页, 引导用户去左栏 BGM tab + toast 指明放文件的目录.
                        toast.info("打开左栏「BGM」tab 选风格; 音乐文件放 data/bgm-library/ 目录", {
                          description: "文件名按风格 id (如 warm.mp3), 详见该目录 README。放好后点「再合成一次」。",
                          duration: 9000,
                        });
                      }}
                      style={{
                        fontSize: 11.5, padding: "5px 12px", borderRadius: 6,
                        background: "var(--surface-card)", color: "var(--brand-700)",
                        border: "1px solid var(--ink-200)", cursor: "pointer",
                        fontWeight: 600, flexShrink: 0,
                      }}
                      title="去 BGM 库添加对应风格的音乐文件"
                    >
                      怎么加 BGM
                    </button>
                  </div>
                )}

                {/* 2026-05-25 字幕对齐方式提示 — 让用户一眼看到 Whisper 是否真在工作.
                    fallback_estimate (无 Whisper) 显黄色 info, Whisper 任一变种显绿色 OK. */}
                {done && compose.subtitleAlignMethod && (
                  <div
                    className="mk-card"
                    style={{
                      padding: "8px 12px", marginBottom: 12,
                      background: compose.subtitleAlignMethod === "fallback_estimate" ? "#fff7ed" : "#ecfdf5",
                      border: `1px solid ${compose.subtitleAlignMethod === "fallback_estimate" ? "#fdba74" : "#86efac"}`,
                      borderRadius: 8,
                      fontSize: 11.5,
                      display: "flex", alignItems: "center", gap: 8,
                    }}
                  >
                    <Icon
                      name={compose.subtitleAlignMethod === "fallback_estimate" ? "warning" : "check"}
                      size={13}
                      style={{ color: compose.subtitleAlignMethod === "fallback_estimate" ? "#c2410c" : "#047857" }}
                    />
                    <span style={{ color: "var(--ink-800)", fontWeight: 600 }}>字幕对齐:</span>
                    <span style={{ color: "var(--ink-700)" }}>
                      {compose.subtitleAlignReasonZh ?? compose.subtitleAlignMethod}
                    </span>
                    {/* 2026-05-27 — 只在 full 模式才让用户点 "Whisper 重对齐". rough / quick_preview
                        路径后端只写 rough_*_concat.txt / 不写 concat_list.txt, 重对齐找不到产物
                        返 400 "缺 concat_list.txt". 用户截图看到按钮以为可用 → 点了 toast 报错. */}
                    {compose.subtitleAlignMethod === "fallback_estimate" && compose.composeMode === "full" && (
                      <button
                        type="button"
                        onClick={() => { void compose.realignSubtitles(); }}
                        disabled={compose.realigningSubtitles}
                        className="ml-auto"
                        style={{
                          fontSize: 11,
                          padding: "4px 12px",
                          borderRadius: 6,
                          background: compose.realigningSubtitles ? "var(--ink-100)" : "var(--brand-500)",
                          color: compose.realigningSubtitles ? "var(--ink-500)" : "#fff",
                          border: "none",
                          cursor: compose.realigningSubtitles ? "default" : "pointer",
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                        title={compose.realigningSubtitles
                          ? "正在用 Whisper 重对齐, 请等约 30 秒"
                          : "用 Whisper 从视频音轨重对齐字幕, 不重合视频 (~30 秒)"}
                      >
                        <Icon name="refresh" size={11} className={compose.realigningSubtitles ? "animate-spin" : ""} />
                        {compose.realigningSubtitles ? "对齐中…" : "Whisper 重对齐 (~30s)"}
                      </button>
                    )}
                  </div>
                )}
                <FinalPreviewPlayer
                  ref={playerRef}
                  src={finalSrc}
                  segments={segments}
                  aspectRatio={previewAspectRatio}
                  trimStartSec={episodeTrimStartSec}
                  trimEndSec={episodeTrimEndSec}
                  onTrimChange={handleTrimChange}
                  onRecomposeShot={handleRecomposeShot}
                  recomposingShotIds={recomposingShotIds}
                  readyCount={readiness.filter((r) => r.ready).length}
                  totalCount={shots.length}
                  onComposeClick={handleCompose}
                  onScrollToFirstMissing={handleScrollToFirstMissing}
                  composing={composing}
                />

                {/* 2026-05-28 深度打磨 #3 — 台词速览. 合成完后用户最常做的事是"核对台词都对了吗",
                    之前必须从头看到尾才能听全, 现在一列时间戳 + 文本, 点一行跳到那段并自动播放.
                    竞品: 剪映 / CapCut / 智影 都是视频旁边一列台词预览, 用户能逐条听过.
                    只在合成完成 + 有 dialogue/voiceover 时显示, 避免空状态噪音. */}
                {done && shots.some((s) => s.dialogue?.trim() || s.voiceover?.trim()) && (
                  <DialogueOverview
                    shots={shots}
                    segments={segments}
                    onJumpTo={handleJumpToSec}
                    estimatedTimings={!hasRealDurations}
                  />
                )}

                {/* 2026-05-26 微调工作流引导卡 — 用户原话"能否反复微调后合成, 直到满意才导出".
                    答: 早就支持 (自动导出默认 opt-in 关). 但 UX 上没让用户看清楚有哪些"微调入口".
                    合成完成 + 没失败 + 没在重合成时显示这张卡, 列 4 个微调入口 + "满意了 → 右侧导出". */}
                {done && compose.stage !== "error" && compose.failedShots.length === 0 && (
                  <div
                    style={{
                      marginTop: 14,
                      padding: "12px 14px",
                      background: "var(--brand-25, rgba(217,119,87,0.04))",
                      border: "1px solid var(--brand-200, rgba(217,119,87,0.25))",
                      borderRadius: 10,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                      <Icon name="edit" size={13} style={{ color: "var(--brand-700)" }} />
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--brand-700)" }}>
                        预览完了? 不满意可以反复微调 — 满意了再点右侧导出
                      </span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 11.5, color: "var(--ink-700)", lineHeight: 1.55 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <span style={{ color: "var(--brand-500)", fontWeight: 700, flexShrink: 0 }}>·</span>
                        <span><strong>字幕跟语音对不上?</strong> 上方 <code style={{ background: "var(--ink-50)", padding: "0 4px", borderRadius: 3, fontSize: 10.5 }}>↻ Whisper 重对齐</code> 重新检查字幕时间</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <span style={{ color: "var(--brand-500)", fontWeight: 700, flexShrink: 0 }}>·</span>
                        <span><strong>某一镜想重做?</strong> 控件栏 <code style={{ background: "var(--ink-50)", padding: "0 4px", borderRadius: 3, fontSize: 10.5 }}>↻ 重合成 第 N 镜</code> 只重该镜</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <span style={{ color: "var(--brand-500)", fontWeight: 700, flexShrink: 0 }}>·</span>
                        <span><strong>前/后多余?</strong> 上方"裁剪 起点/终点"双滑块剪掉,导出时一次切</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <span style={{ color: "var(--brand-500)", fontWeight: 700, flexShrink: 0 }}>·</span>
                        <span><strong>换字幕样式 / 配音 / BGM?</strong> 左栏改设置 → 顶部 <code style={{ background: "var(--ink-50)", padding: "0 4px", borderRadius: 3, fontSize: 10.5 }}>▶ 再合成一次</code></span>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <span style={{ color: "var(--brand-500)", fontWeight: 700, flexShrink: 0 }}>·</span>
                        <span><strong>单镜内部裁切?</strong> 下方"基础剪辑"单击该镜 → 拖入帧/出帧滑块</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <span style={{ color: "var(--ok, #047857)", fontWeight: 700, flexShrink: 0 }}>✓</span>
                        <span style={{ color: "var(--ok, #047857)", fontWeight: 600 }}>反复微调不会自动导出 — 满意了才点右侧导出</span>
                      </div>
                    </div>
                  </div>
                )}

                {compose.stage === "error" && (
                  <div className="mk-card" style={{ padding: 14, marginTop: 14, background: "#fff6f5", border: "1px solid #f5c7c1" }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--err)", marginBottom: 4 }}>合成失败</div>
                    <div style={{ fontSize: 11.5, color: "var(--ink-700)", marginBottom: 8 }}>{compose.error}</div>
                    {/* T1: 重试按钮加图标 */}
                    <Button variant="primary" size="sm" iconLeft="refresh" onClick={handleCompose}>
                      重试合成
                    </Button>
                  </div>
                )}

              </>
            )}
          </div>

          {/* 右: 导出面板 (2026-05-26 恢复三栏 — 用户澄清"右侧还是按钮 column, 只是排布更紧凑").
              ExportPanel 内部已重写紧凑横排 (主按钮顶部 + 去向/规格 chip), 在 340px 宽度内能塞下. */}
          <ExportPanel
            stage={exportState.stage}
            outputPath={exportState.outputPath}
            outputDir={exportState.outputDir}
            files={exportState.files}
            warnings={exportState.warnings}
            target={exportState.target}
            error={exportState.error}
            errorCode={exportState.errorCode}
            multiFormatResults={exportState.multiFormatResults}
            elapsedMs={exportState.elapsedMs}
            progress={exportState.progress}
            onAbort={exportState.abort}
            onRefreshVersions={() => compose.refreshVersions(slug, epId)}
            composeStateDone={composeStateDone}
            composeDone={done}
            hasExportableFinal={hasExportableFinal}
            composing={composing}
            readyCount={readiness.filter((r) => r.ready).length}
            totalCount={shots.length}
            placeholderShotCount={placeholderShotCount}
            blockReason={exportBlockReason}
            composeVersions={compose.composeVersions}
            onExport={handleExport}
            onScrollToFirstMissing={handleScrollToFirstMissing}
            onCompose={handleCompose}
            onShowGuide={() => setShowExportGuide(true)}
            seriesAspectRatio={seriesAspectRatio}
            slug={slug}
            epId={epId}
          />
        </div>

        {/* ── Bottom: 时间轴 (整合版) ──
            2026-05-18 顶层重设计: 删除两条平行时间轴的视觉冗余.
            原方案 TimelineFramework(就绪/未就绪) + TrimTimeline(单镜裁剪) 横向并列, 都显示 S01-S08, 视觉断层严重.
            新方案: TimelineFramework 是入口, 单击选中后下方 inline 展开该镜的 trim 入帧/出帧滑块,
            双击跳转单镜编辑页. 用户不再看到两条 S01-S08 横向条. */}
        {shots.length > 0 && (
          <div style={{ flexShrink: 0, borderTop: "1px solid var(--ink-100)", background: "#fff", padding: "12px 24px", maxHeight: 420, overflow: "auto" }}>
            {/* 2026-05-26 — 加标题"基础剪辑". 用户原话"前端可以直接预览播放和实现基础剪辑";
                TimelineFramework 早就实现了 per-shot trim 入帧/出帧滑块 + 单击选中 + 双击跳编辑页,
                但没有标题, 用户截图里没注意到这块就在合成页底部. */}
            {/* 2026-05-27 — 标题改 "单镜级精细剪辑", 跟上方"整集片头片尾切" 明确区分 */}
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 14, fontWeight: 700, color: "var(--ink-900)" }}>
                单镜级精细剪辑
                <span style={{ fontSize: 10.5, fontWeight: 400, color: "var(--ink-400)", marginLeft: 6, fontFamily: "inherit" }}>
                  (调每镜内的开始 / 结束秒数, 不同于上方的整集片头片尾切)
                </span>
              </h3>
              <span style={{ fontSize: 11, color: "var(--ink-500)" }}>
                单击选中分镜 → 拖入帧/出帧滑块裁切 · 双击进入单镜编辑页
              </span>
            </div>
            <TimelineFramework
              slug={slug}
              epId={epId}
              shots={shots}
              finalVideoUrl={finalSrc}
            />
          </div>
        )}

        {/* T4: 导出说明弹窗 */}
        {showExportGuide && (
          <div style={{ position: "fixed", inset: 0, zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.4)" }}>
            <div className="mk-card" style={{ padding: 24, maxWidth: 420, width: "90%", background: "#fff", borderRadius: 12, boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <Icon name="download" size={20} />
                <h3 style={{ fontSize: 16, fontWeight: 700, color: "var(--ink-900)", margin: 0 }}>导出说明</h3>
              </div>
              <div style={{ fontSize: 13, color: "var(--ink-700)", lineHeight: 1.7, marginBottom: 16 }}>
                <p style={{ margin: "0 0 10px" }}>导出成片需要先完成以下步骤：</p>
                <ol style={{ paddingLeft: 18, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {/* 2026-07-09 audit(#5 铁律#5 状态精确) — 首帧对"已导入视频/视频直出"的镜非必需, 就绪判据
                      (computeReadiness: ready=approved&&hasPickedVideo)已不要求首帧. 说明弹窗随之对齐:
                      挑首帧标注"(可选)"+"已导入视频可跳过", 消除"5/5 镜就绪却说还要挑 5 个首帧"的自相矛盾. */}
                  <li>（可选）为想用 AI 生成视频的镜头 <strong>挑首帧</strong>（在分镜创作页）—— 已直接导入视频的镜头可跳过</li>
                  <li>为每个镜头 <strong>生成并选定视频片段</strong></li>
                  <li>审批所有镜头</li>
                  <li>点击右上角 <strong>「合成成片」</strong> 生成最终视频</li>
                  <li>合成完成后，导出按钮自动激活，支持 zip / 资料库 / 自定义文件夹</li>
                </ol>
                <p style={{ margin: "14px 0 0", fontSize: 12, color: "var(--ink-400)" }}>
                  支持多平台同时导出: B 站 / YouTube (16:9) · 抖音 / 视频号 (9:16) · 朋友圈 / Instagram (1:1) · GIF
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <Button variant="secondary" size="sm" onClick={() => setShowExportGuide(false)}>
                  关闭
                </Button>
                {shots.length > 0 && missingShots.length === 0 && (
                  <Button
                    variant="primary"
                    size="sm"
                    iconLeft="play"
                    onClick={() => { setShowExportGuide(false); handleCompose(); }}
                  >
                    立即合成
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </PageTransition>
  );
}
