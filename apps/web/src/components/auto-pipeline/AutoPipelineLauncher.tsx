/**
 * AutoPipelineLauncher — 一键自动生成全集触发按钮 + 弹窗.
 *
 * 用户需求 (原话):
 *   "通过自动化的按钮选一个 api, 系统按顺序生成每一分镜的首帧图,
 *    并用首帧图生成视频, 最后生成结束之后自动拼接好停在导出前界面"
 *
 * 设计:
 *   1. 按钮: 主 CTA 风格, 显式 "图标+文字" (UX 铁律 #11)
 *   2. 点击 → 弹窗显示:
 *      - 图像模型选 (ModelPicker kind=image, 沿用 series.defaults 兜底)
 *      - 视频模型选 (ModelPicker kind=video)
 *      - 每分镜首帧候选数 (slider 1-5, 默认 1)
 *      - 每分镜视频段数 (slider 1-3, 默认 1)
 *      - auto pick 策略 (radio first / quality_score, 默认 quality_score)
 *      - 选了真实 video API (非 local_mock_video) 时显示二级确认 + 费用提示
 *   3. 启动 → 调 useAutoPipeline.start()
 *
 * 重要:
 *   - 不写 fake mock 入参, provider 必须显式选 / series.defaults 有
 *   - 真实 API 时显示 "将调用真实 API, 可能产生费用" 警告 + 二次 confirm checkbox
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { showErrorToast } from "../../lib/errorTranslate";
import { BaseDialog } from "../ui/BaseDialog";
import { Button } from "../ui/button";
import { Icon } from "../shared/Icon";
import { Progress } from "../ui/progress";
import { ModelPicker } from "../studio/ModelPicker";
import { getLastUsedModel } from "../../lib/lastUsedModel";
import { isRealVideoProvider } from "../../lib/providerKind";
import type { AutoPipelineStartBody } from "../../lib/autoPipelineApi";
// 2026-05-20 P0 架构修复 (铁律 #2 可干预性 + #13 含全部图片素材):
//   一键自动生成 = N elements × briefs + M shots × frames + V shots × videos + 1 compose
//   启动前必须给用户每 stage 的 sample prompts + 数量预估 + reference 图.
import { AutoPipelinePreviewModal } from "./AutoPipelinePreviewModal";
// 2026-05-27: launcher 启动前显示"当前已有多少 / 待生" 进度概览
import { listElements, type ElementData } from "../../lib/elementApi";
import { apiGet } from "../../lib/_apiClient";
import type { EpisodeRecord } from "../../lib/api";

export interface AutoPipelineLauncherProps {
  slug: string;
  epId: string;
  /**
   * 启动后调用方拿 record 自己渲染 progress panel.
   * 2026-05-26: 加第 2 参 targetEpIds — 用户选"整部剧"模式时填全部集 id, 父组件走 batch 启动.
   * 不传或长度 0 → 默认只启 epId (单集模式, 兼容老 caller).
   */
  onStart: (body: AutoPipelineStartBody, targetEpIds?: string[]) => Promise<void>;
  /** 父组件管 pending 状态 (启动请求中) */
  pending?: boolean;
  /** 已经有 pipeline 在跑时 disable, 提示去看进度面板 */
  disabled?: boolean;
  /** 自定义按钮 className */
  className?: string;
  /** 自定义按钮 label, 默认 "一键自动生成全集" */
  label?: string;
  /**
   * 2026-05-26: 该剧全部集列表 — 加"整部剧"选项让用户一键跑完所有集.
   * 不传时只允许"仅当前集"模式.
   */
  allEpisodes?: Array<{ id: string; title?: string; index?: number }>;
}

export function AutoPipelineLauncher({
  slug, epId, onStart, pending, disabled, className, label, allEpisodes,
}: AutoPipelineLauncherProps) {
  // 2026-05-20: slug / epId 现在被 PromptReviewButton 用 (拉 stage-aware preview).
  // 之前 underscore-prefix 占位, 现在落地使用.
  const [open, setOpen] = useState(false);
  // 2026-05-20 P0: 启动前查看每阶段 sample prompt 的弹窗
  const [previewOpen, setPreviewOpen] = useState(false);

  // 形态: <provider_id>:<model_id>
  const [imageModelRef, setImageModelRef] = useState<string | null>(null);
  const [videoModelRef, setVideoModelRef] = useState<string | null>(null);
  const [imageCount, setImageCount] = useState(1);
  const [videoCount, setVideoCount] = useState(1);
  const [pickStrategy, setPickStrategy] = useState<"first" | "quality_score">("quality_score");
  const [confirmedRealApi, setConfirmedRealApi] = useState(false);
  // 2026-05-19: 默认推荐"素材图+首帧"组合 — 用户原话需求这是最常用的入口,不烧视频费,
  // 跑完可以挨张验收首帧再决定要不要往下推视频. 之前默认 full 让用户每次都得先切 mode.
  type RunMode = "full" | "only_element_images" | "only_firstframes";
  const [runMode, setRunMode] = useState<RunMode>("only_firstframes");
  const [skipElementImages, setSkipElementImages] = useState(false);
  // 2026-05-26: 运行范围 — 默认仅当前集, 用户可切"整部剧"批量启动所有集 pipeline.
  // 走后端 /auto-pipeline/batch endpoint (上限 50 集) 一次性启动.
  type RunScope = "current" | "all";
  const [runScope, setRunScope] = useState<RunScope>("current");
  const hasMultipleEpisodes = (allEpisodes?.length ?? 0) > 1;

  // 2026-05-27 用户原话"能不能在一键生成页面展示一下进度呢? 当前素材+分镜图多少有、多少还没生成":
  // 弹窗 open 时拉 elements + episodes 算"已生 / 待生" 概览, 让用户启动前心里有数.
  type StatsSnapshot = {
    elementsGenerated: number;
    elementsTotal: number;
    firstFrameDone: number;
    firstFrameTotal: number;
    videoDone: number;
    videoTotal: number;
    epCount: number;
  };
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  useEffect(() => {
    if (!open || !slug) return;
    let alive = true;
    setStatsLoading(true);
    (async () => {
      try {
        // 并发拉 elements (含 image_briefs.generated) + episodes (含 picked_first_frame_count / picked_video_count)
        const [elemResp, epResp] = await Promise.all([
          listElements(slug).catch(() => ({ elements: [] as ElementData[] })),
          apiGet<{ episodes: EpisodeRecord[] }>(`/api/v2/series/${encodeURIComponent(slug)}/episodes`)
            .catch(() => ({ episodes: [] as EpisodeRecord[] })),
        ]);
        if (!alive) return;
        // 素材图: 遍历所有 element.image_briefs 算 generated / total
        let eDone = 0;
        let eTotal = 0;
        for (const el of (elemResp.elements ?? [])) {
          const briefs = (el as { image_briefs?: Array<{ generated?: boolean }> }).image_briefs ?? [];
          eTotal += briefs.length;
          eDone += briefs.filter((b) => b.generated === true).length;
        }
        // 分镜: episodes enrich 后含 picked_first_frame_count + picked_video_count + actual_shot_count
        let ffDone = 0;
        let vidDone = 0;
        let shotTotal = 0;
        for (const ep of (epResp.episodes ?? [])) {
          ffDone += ep.picked_first_frame_count ?? 0;
          vidDone += ep.picked_video_count ?? 0;
          shotTotal += ep.actual_shot_count ?? 0;
        }
        setStats({
          elementsGenerated: eDone,
          elementsTotal: eTotal,
          firstFrameDone: ffDone,
          firstFrameTotal: shotTotal,
          videoDone: vidDone,
          videoTotal: shotTotal,
          epCount: (epResp.episodes ?? []).length,
        });
      } finally {
        if (alive) setStatsLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [open, slug]);

  // 弹窗打开时回填用户上次用的模型 (lastUsedModel localStorage), 让"快速复用"自然
  useEffect(() => {
    if (!open) return;
    if (!imageModelRef) {
      const last = getLastUsedModel("image");
      if (last) setImageModelRef(last);
    }
    if (!videoModelRef) {
      const last = getLastUsedModel("video");
      if (last) setVideoModelRef(last);
    }
    // 只在 open 切换时跑一次, deps 故意不写 imageModelRef/videoModelRef 避免循环 reset
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const realApi = useMemo(() => isRealVideoProvider(videoModelRef), [videoModelRef]);
  // 2026-05-19 #C: 只素材图 / 只首帧 模式不需要视频模型, canStart 跳过视频校验
  const videoRequired = runMode === "full";
  const canSkipElementImages = runMode !== "only_element_images";
  const canStart =
    !!imageModelRef
    && (!videoRequired || !!videoModelRef)
    && (!videoRequired || !realApi || confirmedRealApi);

  async function handleStart() {
    if (!canStart) return;
    try {
      const body: AutoPipelineStartBody = {
        image_provider_id: imageModelRef ?? undefined,
        // 2026-05-19 #C: 非 full 模式不传视频模型, 后端 preflight 也会跳过校验
        video_provider_id: videoRequired ? (videoModelRef ?? undefined) : undefined,
        image_count_per_shot: imageCount,
        video_count_per_shot: videoRequired ? videoCount : undefined,
        auto_pick_strategy: pickStrategy,
        skip_element_images: canSkipElementImages && skipElementImages ? true : undefined,
        only_element_images: runMode === "only_element_images" ? true : undefined,
        only_firstframes: runMode === "only_firstframes" ? true : undefined,
        // 2026-07-09 audit 修复 — confirmed_real_api 之前只在 UI 勾选却从未进请求体,
        // 导致真实付费 provider full 模式一律被后端 400 (用户勾了"我知道会扣费"也没用).
        confirmed_real_api: videoRequired && realApi ? confirmedRealApi : undefined,
      };
      // 2026-05-26: 运行范围决定 batch 启动 vs 单集. 父组件根据 targetEpIds 长度选 endpoint.
      const targetEpIds = runScope === "all" && allEpisodes && allEpisodes.length > 1
        ? allEpisodes.map((e) => e.id)
        : [epId];
      await onStart(body, targetEpIds);
      setOpen(false);
    } catch (err) {
      // useAutoPipeline.start() 已经在 hook 内 setError, 这里再补一个 toast 视觉反馈
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译 + 智能 action 按钮
      showErrorToast(err, "启动一键管线失败");
    }
  }

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        disabled={disabled || pending}
        className={className}
        variant="primary"
        title={disabled ? "已有正在运行的管线" : "一键自动生成全集 — 首帧 → 视频 → 合成"}
      >
        <Icon name="play" size={14} />
        {label ?? "一键自动生成全集"}
      </Button>

      {/* 2026-05-21 UX-修(用户当面批"为什么还是单独写一个弹窗,我不是要求组件复用吗"):
          从 Radix Dialog + 平铺 layout 迁到 BaseDialog 三段架构 (Header / Body 自动滚 / Footer 固定底部).
          BaseDialog 跟 ConfirmModal / PromptReviewModal / LibraryPickerModal 等共用同款 layout 引擎,
          内容超长不再把按钮推出屏幕外, sticky bottom 也不再需要手写 className. */}
      <BaseDialog
        open={open}
        onClose={() => setOpen(false)}
        title="一键自动生成全集"
        subtitle="系统按顺序: 1. 为每分镜生成首帧图 → 2. 用首帧锚定生视频 → 3. 自动合成成片。生成结束停在合成页, 你回来后看成品再决定是否导出。"
        iconName="play"
        maxWidth={560}
        busy={pending}
        footer={
          <>
            {/* 2026-05-20 P0 架构修复 (铁律 #2 可干预性): 启动前必须能看每阶段 sample prompt + reference 图.
                启动前点这个 = 不发任何调用, 只 preview; 也允许复制走外部 AI 自己生再 import. */}
            <Button
              variant="secondary"
              onClick={() => setPreviewOpen(true)}
              disabled={!imageModelRef || pending}
              title="发送前查看每阶段的 sample 提示词 + 自动 reference 图"
            >
              <Icon name="eye" size={14} />
              查看完整提示词
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              取消
            </Button>
            <Button
              onClick={handleStart}
              disabled={!canStart || pending}
              variant="primary"
            >
              {pending ? (
                <>
                  <Icon name="refresh" size={14} className="animate-spin" />
                  启动中…
                </>
              ) : (
                <>
                  <Icon name="play" size={14} />
                  开始自动生成
                </>
              )}
            </Button>
          </>
        }
      >

          {/* 2026-05-27 当前进度概览 — 用户原话"能不能在一键生成页面展示一下进度呢?
              当前素材+分镜图多少有、多少还没生成". 弹窗 open 时拉数据, 显示 3 段紧凑进度.
              用户启动前心里有数:已经多少 / 还差多少 / 全跑 vs 补差. */}
          {(statsLoading || stats) && (
            <div className="mt-1 mb-2 p-3 rounded-lg" style={{
              background: "var(--ink-50)",
              border: "1px solid rgba(0,0,0,0.04)",
            }}>
              <div className="text-xs font-medium text-[var(--ink-700)] mb-2">
                当前进度 {statsLoading && <span className="text-[var(--ink-400)] font-normal">· 加载中…</span>}
              </div>
              {stats && (
                <div className="flex flex-col gap-1.5">
                  {/* 素材图 */}
                  <div className="flex items-center gap-2 text-xs">
                    <span style={{ minWidth: 48, color: "var(--ink-600)" }}>素材图</span>
                    <div className="flex-1 min-w-0">
                      <Progress
                        value={stats.elementsTotal > 0 ? Math.round((stats.elementsGenerated / stats.elementsTotal) * 100) : 0}
                        className="flex-1"
                      />
                    </div>
                    <span style={{ minWidth: 60, textAlign: "right", color: "var(--ink-700)", fontWeight: 600 }}>
                      {stats.elementsGenerated} / {stats.elementsTotal}
                    </span>
                    <span style={{ minWidth: 56, textAlign: "right", color: stats.elementsTotal - stats.elementsGenerated > 0 ? "var(--warn, #b8860b)" : "var(--ok)" }}>
                      {stats.elementsTotal - stats.elementsGenerated > 0 ? `差 ${stats.elementsTotal - stats.elementsGenerated} 张` : "✓ 齐"}
                    </span>
                  </div>
                  {/* 分镜首帧 */}
                  <div className="flex items-center gap-2 text-xs">
                    <span style={{ minWidth: 48, color: "var(--ink-600)" }}>首帧</span>
                    <div className="flex-1 min-w-0">
                      <Progress
                        value={stats.firstFrameTotal > 0 ? Math.round((stats.firstFrameDone / stats.firstFrameTotal) * 100) : 0}
                        className="flex-1"
                      />
                    </div>
                    <span style={{ minWidth: 60, textAlign: "right", color: "var(--ink-700)", fontWeight: 600 }}>
                      {stats.firstFrameDone} / {stats.firstFrameTotal}
                    </span>
                    <span style={{ minWidth: 56, textAlign: "right", color: stats.firstFrameTotal - stats.firstFrameDone > 0 ? "var(--warn, #b8860b)" : "var(--ok)" }}>
                      {stats.firstFrameTotal - stats.firstFrameDone > 0 ? `差 ${stats.firstFrameTotal - stats.firstFrameDone} 镜` : "✓ 齐"}
                    </span>
                  </div>
                  {/* 分镜视频 */}
                  <div className="flex items-center gap-2 text-xs">
                    <span style={{ minWidth: 48, color: "var(--ink-600)" }}>视频</span>
                    <div className="flex-1 min-w-0">
                      <Progress
                        value={stats.videoTotal > 0 ? Math.round((stats.videoDone / stats.videoTotal) * 100) : 0}
                        className="flex-1"
                      />
                    </div>
                    <span style={{ minWidth: 60, textAlign: "right", color: "var(--ink-700)", fontWeight: 600 }}>
                      {stats.videoDone} / {stats.videoTotal}
                    </span>
                    <span style={{ minWidth: 56, textAlign: "right", color: stats.videoTotal - stats.videoDone > 0 ? "var(--warn, #b8860b)" : "var(--ok)" }}>
                      {stats.videoTotal - stats.videoDone > 0 ? `差 ${stats.videoTotal - stats.videoDone} 段` : "✓ 齐"}
                    </span>
                  </div>
                  <div className="text-[10.5px] text-[var(--ink-400)] mt-1">
                    共 {stats.epCount} 集 · 启动后只补待生项 (已生成的自动跳过)
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 2026-05-26 运行范围 — 默认仅当前集; 切"整部剧"批量启动所有集 pipeline.
              用户原话"一键自动生成全集的功能实际只生成的当前第一集的所有分镜,集数多了怎么办" */}
          {hasMultipleEpisodes && (
            <div className="mt-2 space-y-2">
              <label className="block text-sm font-medium text-[var(--ink-800)]">
                运行范围
              </label>
              <div className="flex flex-col gap-2">
                <label className={`flex items-start gap-2 text-sm cursor-pointer rounded-md p-2 border ${runScope === "current" ? "border-[var(--brand-400)] bg-[var(--brand-25,rgba(217,119,87,0.04))]" : "border-[var(--ink-100)]"}`}>
                  <input
                    type="radio"
                    className="mt-1"
                    checked={runScope === "current"}
                    onChange={() => setRunScope("current")}
                  />
                  <div className="flex-1">
                    <div className="font-medium text-[var(--ink-900)]">仅当前集</div>
                    <div className="text-xs text-[var(--ink-500)]">
                      只跑当前打开的这一集 (默认, 适合先试一集看效果)
                    </div>
                  </div>
                </label>
                <label className={`flex items-start gap-2 text-sm cursor-pointer rounded-md p-2 border ${runScope === "all" ? "border-[var(--brand-400)] bg-[var(--brand-25,rgba(217,119,87,0.04))]" : "border-[var(--ink-100)]"}`}>
                  <input
                    type="radio"
                    className="mt-1"
                    checked={runScope === "all"}
                    onChange={() => setRunScope("all")}
                  />
                  <div className="flex-1">
                    <div className="font-medium text-[var(--ink-900)]">整部剧 (全部 {allEpisodes?.length} 集)</div>
                    <div className="text-xs text-[var(--ink-500)]">
                      一键启动每一集的 pipeline (后端并发), 跑完整部剧. 失败的某一集不影响其他集.
                    </div>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* 2026-05-19: 运行模式选择 — 加 step badge 可视化覆盖范围.
              用户原话: "剧集一键生成功能要允许同时一键按顺序抽素材+所有分镜首帧,现在只有分别的功能".
              实际 only_firstframes 就是"素材图+首帧"组合, 把这个改成显眼的默认推荐选项,
              文案明确"包含素材图阶段". */}
          <div className="mt-4 space-y-2">
            <label className="block text-sm font-medium text-[var(--ink-800)]">
              运行模式
            </label>
            <div className="flex flex-col gap-2">
              {/* 推荐: 素材图 + 首帧 (不烧视频费) — 用户最常用的模式, 默认置顶推荐 */}
              <label className={`flex items-start gap-2 text-sm cursor-pointer rounded-md p-2 border ${runMode === "only_firstframes" ? "border-[var(--brand-400)] bg-[var(--brand-25,rgba(217,119,87,0.04))]" : "border-[var(--ink-100)]"}`}>
                <input
                  type="radio"
                  className="mt-1"
                  checked={runMode === "only_firstframes"}
                  onChange={() => setRunMode("only_firstframes")}
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-[var(--ink-900)]">素材图 + 所有分镜首帧</span>
                    <span className="text-[10px] font-semibold text-[var(--brand-700)] bg-[var(--brand-100)] px-1.5 py-0.5 rounded">推荐</span>
                  </div>
                  <div className="flex items-center gap-1 mb-1 text-[11px]">
                    <span className="text-[var(--ink-700)] bg-[var(--ink-50)] px-1.5 py-0.5 rounded">素材图</span>
                    <span className="text-[var(--ink-400)]">→</span>
                    <span className="text-[var(--ink-700)] bg-[var(--ink-50)] px-1.5 py-0.5 rounded">首帧</span>
                    <span className="text-[var(--ink-400)]">·</span>
                    <span className="text-[var(--ink-400)] line-through">视频</span>
                    <span className="text-[var(--ink-400)] line-through">合成</span>
                  </div>
                  <div className="text-xs text-[var(--ink-500)]">
                    按顺序: 先为每个素材补全参考图 → 再用素材图为每分镜抽首帧. 不烧视频费, 适合先一遍验收图.
                  </div>
                </div>
              </label>
              {/* 全流程 */}
              <label className={`flex items-start gap-2 text-sm cursor-pointer rounded-md p-2 border ${runMode === "full" ? "border-[var(--brand-400)] bg-[var(--brand-25,rgba(217,119,87,0.04))]" : "border-[var(--ink-100)]"}`}>
                <input
                  type="radio"
                  className="mt-1"
                  checked={runMode === "full"}
                  onChange={() => setRunMode("full")}
                />
                <div className="flex-1">
                  <div className="font-medium text-[var(--ink-900)] mb-1">全流程 (跑到成片)</div>
                  <div className="flex items-center gap-1 mb-1 text-[11px]">
                    <span className="text-[var(--ink-700)] bg-[var(--ink-50)] px-1.5 py-0.5 rounded">素材图</span>
                    <span className="text-[var(--ink-400)]">→</span>
                    <span className="text-[var(--ink-700)] bg-[var(--ink-50)] px-1.5 py-0.5 rounded">首帧</span>
                    <span className="text-[var(--ink-400)]">→</span>
                    <span className="text-[var(--ink-700)] bg-[var(--ink-50)] px-1.5 py-0.5 rounded">视频</span>
                    <span className="text-[var(--ink-400)]">→</span>
                    <span className="text-[var(--ink-700)] bg-[var(--ink-50)] px-1.5 py-0.5 rounded">合成</span>
                  </div>
                  <div className="text-xs text-[var(--ink-500)]">
                    完整跑完素材图 / 首帧 / 视频 / 合成. 视频如果用付费 provider 会有费用, 完成停在合成页可验收成片.
                  </div>
                </div>
              </label>
              {/* 仅素材图 */}
              <label className={`flex items-start gap-2 text-sm cursor-pointer rounded-md p-2 border ${runMode === "only_element_images" ? "border-[var(--brand-400)] bg-[var(--brand-25,rgba(217,119,87,0.04))]" : "border-[var(--ink-100)]"}`}>
                <input
                  type="radio"
                  className="mt-1"
                  checked={runMode === "only_element_images"}
                  onChange={() => setRunMode("only_element_images")}
                />
                <div className="flex-1">
                  <div className="font-medium text-[var(--ink-900)] mb-1">只跑素材图</div>
                  <div className="flex items-center gap-1 mb-1 text-[11px]">
                    <span className="text-[var(--ink-700)] bg-[var(--ink-50)] px-1.5 py-0.5 rounded">素材图</span>
                    <span className="text-[var(--ink-400)]">·</span>
                    <span className="text-[var(--ink-400)] line-through">首帧</span>
                    <span className="text-[var(--ink-400)] line-through">视频</span>
                    <span className="text-[var(--ink-400)] line-through">合成</span>
                  </div>
                  <div className="text-xs text-[var(--ink-500)]">
                    只为每个素材 (角色 / 场景 等) 补全参考图. 不进首帧 / 视频 / 合成.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {canSkipElementImages && (
            <label className="mt-3 flex items-start gap-2 rounded-md border border-[var(--ink-100)] bg-[var(--ink-25,#fafafa)] p-3 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-1"
                checked={skipElementImages}
                onChange={(e) => setSkipElementImages(e.target.checked)}
              />
              <div className="flex-1">
                <div className="font-medium text-[var(--ink-900)]">跳过素材生图(用现有主图)</div>
                <div className="mt-1 text-xs text-[var(--ink-500)]">
                  已经整理好角色 / 场景 / 道具主图时可勾选,系统会直接用现有素材图去抽分镜首帧。
                </div>
              </div>
            </label>
          )}

          {/* 图像模型 */}
          <div className="mt-4 space-y-2">
            <label className="block text-sm font-medium text-[var(--ink-800)]">
              图像模型 <span className="text-[var(--err)]">*</span>
            </label>
            <ModelPicker
              kind="image"
              value={imageModelRef}
              onChange={setImageModelRef}
              placeholder="选图像模型…"
              size="md"
            />
          </div>

          {/* 视频模型 — 2026-05-19 #C: 仅 full 模式需要 */}
          {videoRequired && (
            <div className="mt-4 space-y-2">
              <label className="block text-sm font-medium text-[var(--ink-800)]">
                视频模型 <span className="text-[var(--err)]">*</span>
              </label>
              <ModelPicker
                kind="video"
                value={videoModelRef}
                onChange={(v) => { setVideoModelRef(v); setConfirmedRealApi(false); }}
                placeholder="选视频模型…"
                size="md"
              />
            </div>
          )}

          {/* 候选数 — 2026-05-19 #C: only_element_images 不需要首帧候选数 (没首帧 stage) */}
          {runMode !== "only_element_images" && (
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="block text-sm font-medium text-[var(--ink-800)]">
                  每分镜首帧候选数: {imageCount}
                </label>
                <input
                  type="range"
                  min={1}
                  max={5}
                  value={imageCount}
                  onChange={(e) => setImageCount(Number(e.target.value))}
                  className="w-full"
                />
                <p className="text-xs text-[var(--ink-500)]">多张可挑最优, 但成本更高</p>
              </div>
              {videoRequired && (
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-[var(--ink-800)]">
                    每分镜视频段数: {videoCount}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={3}
                    value={videoCount}
                    onChange={(e) => setVideoCount(Number(e.target.value))}
                    className="w-full"
                  />
                  <p className="text-xs text-[var(--ink-500)]">视频较贵, 1 段足够多数场景</p>
                </div>
              )}
            </div>
          )}

          {/* 自动 pick 策略 */}
          <div className="mt-4 space-y-2">
            <label className="block text-sm font-medium text-[var(--ink-800)]">
              候选自动挑选策略
            </label>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={pickStrategy === "quality_score"}
                  onChange={() => setPickStrategy("quality_score")}
                />
                <span>按评分挑最优 (推荐)</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  checked={pickStrategy === "first"}
                  onChange={() => setPickStrategy("first")}
                />
                <span>用第一张</span>
              </label>
            </div>
            <p className="text-xs text-[var(--ink-500)]">
              候选数 &gt; 1 时, 按选择的策略给每分镜自动 pick. 跑完后可手动改.
            </p>
          </div>

          {/* 真实 API 警告 — 2026-05-19 #C: only 模式不跑视频, 不展示费用警告 */}
          {videoRequired && realApi && (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3">
              <div className="flex items-start gap-2">
                <Icon name="warning" size={16} className="mt-0.5 text-amber-600" />
                <div className="flex-1 text-sm">
                  <div className="font-semibold text-amber-800">
                    将调用真实视频 API, 可能产生费用
                  </div>
                  <p className="mt-1 text-xs text-amber-700">
                    你选择的视频模型是付费云端 API. 全集每分镜都会真实出账,
                    按分镜数 × 每分镜段数 × provider 单价计算. 启动前请确认 Key 已配置.
                  </p>
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmedRealApi}
                      onChange={(e) => setConfirmedRealApi(e.target.checked)}
                    />
                    <span className="text-amber-900">我已知晓会产生费用, 继续</span>
                  </label>
                </div>
              </div>
            </div>
          )}

        {/* footer 已迁到 BaseDialog footer slot (顶部 props), 这里 children 收尾 */}
      </BaseDialog>

      {/* 2026-05-20 P0 架构修复: stage-aware preview modal */}
      <AutoPipelinePreviewModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        slug={slug}
        epId={epId}
        options={{
          image_provider_id: imageModelRef ?? undefined,
          video_provider_id: videoRequired ? (videoModelRef ?? undefined) : undefined,
          image_count_per_shot: imageCount,
          video_count_per_shot: videoRequired ? videoCount : undefined,
          skip_element_images: canSkipElementImages && skipElementImages ? true : undefined,
          only_element_images: runMode === "only_element_images" ? true : undefined,
          only_firstframes: runMode === "only_firstframes" ? true : undefined,
        }}
      />
    </>
  );
}
