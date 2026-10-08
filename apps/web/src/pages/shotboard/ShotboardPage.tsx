import type { CoverGenerationOptions } from "../../lib/seriesApi";
// v24 · ShotboardPage · 系列级分集 / 分镜管理
// W5-C 重构:
//   T1 - 删除 list/card/picker 视图切换 UI，固定卡片视图
//   T2 - 整张卡片可点进入创作页，删除独立"创作"按钮
//   T3 - HTML5 native drag-and-drop 拖拽改顺序
//   T4 - 勾选框 + 批量操作底栏（重抽首帧/视频/删除/取消）
//   T5 - 删除二次确认 modal + 软删到垃圾桶
//   T6 - 添加新集/新镜使用相同 mk-card 外框但虚线边+浅色填充
//
// Wave 6-C (2026-05-15):
//   T3 - 顶部加 VersionSwitcher（placeholder，W6-B 完成后替换 import）
//
// W8-D (2026-05-16):
//   整集挂机抽首帧 - toolbar 加按钮; 遍历当前集所有 picked_first_frame_id 为空的镜,
//   串行 await + 800ms 间隔调 POST /shots/:sid/firstframe/generate 批量入队
//   防并发洪水; 二次确认 modal 防误扣费; 失败不阻塞继续下一个.
//
// Wave 解耦 (2026-05-21):
//   主文件从 1505 行拆成多个子组件 — ShotboardHeader / EpisodeStrip / ShotGrid /
//   BulkActionBar / parts/DeleteConfirmModal / parts/DryRunModal / parts/ShotCard,
//   主页面只剩路由 + 数据装载 + state + 主结构组装。不动业务逻辑。
//
// 数据源:
//   - GET /api/v2/series/:slug              -> series + episodes
//   - GET /api/v2/series/:slug/episodes/:epId/shots -> 当前集分镜
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToggleSet } from "../../hooks/useToggleSet";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { PageTransition } from "../../components/studio/PageTransition";
import { Empty } from "../../components/ui/empty";
import { Icon } from "../../components/shared/Icon";
import { type VersionSummary } from "../../components/shared/VersionSwitcher";
import { useStoryboardVersions } from "../../hooks/useStoryboardVersions";
import { useSessionStore } from "../../stores/sessionStore";
import { useTasksStore } from "../../stores/tasksStore";
import { useShots, createShot, patchShot } from "../../hooks/useShots";
import { PromptDialog } from "../../components/ui/prompt-dialog";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { createEpisode, deleteEpisode, getSeries, apiPost, generateEpisodeCover, type EpisodeRecord, type SeriesRecord } from "../../lib/api";
import { ROUTES } from "../../lib/routes";
import { showErrorToast } from "../../lib/errorTranslate";
import { batchDryRun, batchExecute, isNotImplemented, type BatchTarget } from "../../lib/shotApi";
// 2026-05-18 EVE-3: 一键自动生成全集 hook — 与 ComposePage 同款,接 SSE pipeline.* 事件
import { useAutoPipeline } from "../../hooks/useAutoPipeline";
// 2026-05-18 EVE-4: 用户原话"评估一下可以跳过灵感生成剧本直接粘贴分镜吗?"
// 在分镜页加"粘贴 AI 分镜"按钮入口,跳过灵感/剧本步骤直接导入
import { PasteStoryboardDialog } from "../../components/script/PasteStoryboardDialog";
import { useConfirm } from "../../components/ui/ConfirmModal";
import { ShotboardHeader } from "./ShotboardHeader";
import { EpisodeStrip, getEpisodeId, getEpisodeNumber } from "./EpisodeStrip";
import { EpisodeTimelineBar } from "./EpisodeTimelineBar";
// 2026-05-28 AI 出图打磨 — 跨分镜角色/场景一致性 + 情绪曲线突变 体检
import { EpisodeShotIntelligenceAdvisor } from "./EpisodeShotIntelligenceAdvisor";
import { ShotGrid } from "./ShotGrid";
import { BulkActionBar } from "./BulkActionBar";
import { DeleteConfirmModal } from "./parts/DeleteConfirmModal";
import { DryRunModal } from "./parts/DryRunModal";
import type { Shot } from "../../hooks/useShots";

export default function ShotboardPage() {
  const { slug, epId } = useParams<{ slug: string; epId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setCurrentEpisode = useSessionStore((s) => s.setCurrentEpisode);
  const confirm = useConfirm();

  // T1: 固定卡片视图，只有 picker 模式（URL 带 ?shot=xxx）才切换
  const pickerMode = searchParams.has("shot");

  const [series, setSeries] = useState<SeriesRecord | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeRecord[]>([]);
  const [loadingSeries, setLoadingSeries] = useState(true);

  // T4: 批量勾选
  const { ids: selectedIds, toggle: toggleShotId, replace: replaceSelectedIds, clear: clearSelectedIds, has: hasShotSelected, size: selectedCount } = useToggleSet<string>();

  // T3: 拖拽状态
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [localOrder, setLocalOrder] = useState<string[]>([]);

  // T5: 删除确认
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: string[]; labels: string[] } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 批量执行（首帧/视频）dry-run 弹窗
  const [dryRun, setDryRun] = useState<null | {
    action: "firstframe" | "video";
    result: import("../../lib/shotApi").BatchDryRunResult;
  }>(null);

  // 2026-05-19 #C: W8-D "整集挂机抽首帧" toolbar + 二次确认 + 串行入队 handler 已删除.
  // 该能力合并进 AutoPipelineLauncher 弹窗的"运行模式 = 只跑首帧" — 走 Auto Pipeline
  // 后端并发, 比之前前端串行 800ms 间隔快得多, 也避免和"一键自动生成全集"两个 toolbar 重复.

  // W-detail-fix: URL 有 epId 但不在 episodes 列表 → fallback 到第一集,
  // 避免书签/删除后的死链报错。空 episodes 时 selectedEpId 为空,下面 UI 自然渲染空态。
  const selectedEpId = useMemo(() => {
    const episodeIds = episodes.map(getEpisodeId).filter(Boolean);
    if (epId && episodeIds.includes(epId)) return epId;
    return episodeIds[0] || "";
  }, [epId, episodes]);

  const selectedEpisode = useMemo(
    () => episodes.find((ep) => getEpisodeId(ep) === selectedEpId) ?? null,
    [episodes, selectedEpId],
  );

  const { shots, isLoading: loadingShots, error: shotsError, refresh } = useShots(slug, selectedEpId);

  // 2026-05-27 — task.done/failed 落盘时, ShotboardPage 自己监听 dirtyShotKeys
  // 决定是否 refresh.
  //
  // 2026-05-27 #2 修死循环: deps 用 dirtyShotKeys.join(",") 字符串签名而非数组
  // 引用, 避免 zustand store 内 dirtyShotKeys 引用变 (即使内容空也变) 反复触发
  // useEffect → "Maximum update depth exceeded". shots / refresh 用 ref 抓最新值,
  // 不进 deps. 这样 useEffect 只在 dirty 列表"内容"变 + selectedEpId 变时触发.
  const dirtyShotKeys = useTasksStore((s) => s.dirtyShotKeys);
  const clearDirtyShot = useTasksStore((s) => s.clearDirtyShot);
  const dirtySig = dirtyShotKeys.join(",");
  const shotsRef = useRef(shots);
  const refreshRef = useRef(refresh);
  useEffect(() => { shotsRef.current = shots; }, [shots]);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => {
    if (!selectedEpId || dirtyShotKeys.length === 0) return;
    const currentShots = shotsRef.current;
    const mineDirty = dirtyShotKeys.filter((k) => currentShots.some((s) => s.id === k));
    if (mineDirty.length === 0) return;
    void refreshRef.current();
    for (const k of mineDirty) clearDirtyShot(k);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtySig, selectedEpId]);

  // 2026-05-18 EVE-3: 一键自动生成全集 hook — 与 ComposePage 同款,接 SSE pipeline.* 事件
  const autoPipeline = useAutoPipeline();

  // 2026-05-26: 离页再回来恢复 pipeline 进度面板. 后端 pipeline 进程仍在跑 (fire-and-forget),
  // 但前端组件 unmount 时 SSE 取消订阅 + record reset 成 null. mount 时问后端"该 series+ep 是不是
  // 还有 running pipeline?", 有就 setRecord + 重订阅, 进度面板自动复现.
  useEffect(() => {
    if (!slug || !selectedEpId) return;
    void autoPipeline.rehydrate(slug, selectedEpId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, selectedEpId]);

  // 2026-05-18 EVE-4: 粘贴 AI 分镜 JSON 对话框 — 跳过灵感/剧本直接导入分镜
  const [showPasteDialog, setShowPasteDialog] = useState(false);

  // T3: 本地顺序 state 随 shots 更新
  //
  // 2026-05-19 紧急修 (用户原话:"点鼠标返回键 Maximum update depth exceeded"):
  // 之前 `setLocalOrder(shots.map(...))` 每次渲染都创建新数组,即使 id 列表完全一致也
  // 触发 setState → re-render. 当 shots 引用本身不稳定 (如 useShots 返回 `data ?? []`
  // 在 data=undefined 时每次新 []) 时,useEffect 反复触发 → infinite render loop.
  //
  // 即使 useShots 已经返回稳定空数组(修复 useShots.ts), 这里再加 id 对比兜底:
  // 如果新旧 id 列表完全相同,跳过 setState. 这样未来类似 race condition 也不会再触发.
  useEffect(() => {
    const nextIds = shots.map((s) => s.id);
    setLocalOrder((prev) => {
      if (prev.length === nextIds.length && prev.every((id, i) => id === nextIds[i])) {
        return prev; // 同款引用 → React 跳过 re-render → 阻断潜在 loop
      }
      return nextIds;
    });
  }, [shots]);

  const orderedShots = useMemo(() => {
    if (localOrder.length === 0) return shots;
    const map = new Map(shots.map((s) => [s.id, s]));
    return localOrder.map((id) => map.get(id)).filter(Boolean) as Shot[];
  }, [shots, localOrder]);

  const loadSeries = useCallback(async () => {
    if (!slug) return;
    setLoadingSeries(true);
    try {
      const data = await getSeries(slug);
      setSeries(data.series);
      setEpisodes(data.episodes);
    } catch (err) {
      showErrorToast(err, "加载分集失败");
    } finally {
      setLoadingSeries(false);
    }
  }, [slug]);

  // T4: 全选
  const selectAll = useCallback(() => {
    replaceSelectedIds(orderedShots.map((s) => s.id));
  }, [orderedShots, replaceSelectedIds]);

  const clearSelect = useCallback(() => {
    clearSelectedIds();
    setDryRun(null);
  }, [clearSelectedIds]);

  const makeBatchTargets = useCallback((action: "firstframe" | "video"): BatchTarget[] => {
    return [...selectedIds].map((sid) => ({ sid, action }));
  }, [selectedIds]);

  const handleBatchDryRun = useCallback(async (action: "firstframe" | "video") => {
    try {
      // 2026-05-21 — 预提示已挑过的 shot 数量 (与一键 autoPipeline 补全语义对齐):
      // 用户多选 N 个其中 K 个已挑了 picked_first_frame_id / picked_video_id, 批量重抽会
      // 覆盖那 K 个的"选定状态". 显式告知避免误操作, 不阻塞 (用户可能就是想重抽).
      const pickedKey: "picked_first_frame_id" | "picked_video_id" =
        action === "firstframe" ? "picked_first_frame_id" : "picked_video_id";
      const targetShots = shots.filter((s) => hasShotSelected(s.id));
      const alreadyPickedCount = targetShots.filter((s) => !!s[pickedKey]).length;
      if (alreadyPickedCount > 0) {
        toast.warning(
          `已选 ${targetShots.length} 镜中 ${alreadyPickedCount} 镜已挑${action === "firstframe" ? "首帧" : "视频"},批量重抽会覆盖。继续点"确认"会真重抽。`,
          { duration: 5000 },
        );
      }
      const targets = makeBatchTargets(action);
      const res = await batchDryRun(targets);
      if (isNotImplemented(res)) showErrorToast(res.reason);
      else setDryRun({ action, result: res });
    } catch (err) {
      showErrorToast(err, action === "firstframe" ? "批量抽首帧预览失败" : "批量抽视频预览失败");
    }
  }, [makeBatchTargets, hasShotSelected, shots]);

  const handleBatchExecute = useCallback(async () => {
    if (!dryRun) return;
    try {
      const targets = makeBatchTargets(dryRun.action);
      const res = await batchExecute(targets);
      if (isNotImplemented(res)) {
        showErrorToast(res.reason);
        return;
      }
      toast.success("批量任务已提交");
      clearSelect();
      setDryRun(null);
      await refresh();
    } catch (err) {
      showErrorToast(err, dryRun.action === "firstframe" ? "批量抽首帧执行失败" : "批量抽视频执行失败");
    }
  }, [clearSelect, dryRun, makeBatchTargets, refresh]);

  // T5: 批量删除到垃圾桶
  const handleBatchDelete = useCallback(() => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const labels = ids.map((id) => {
      const shot = shots.find((s) => s.id === id);
      return shot?.index ? `第${shot.index}镜` : id.slice(0, 8);
    });
    setDeleteConfirm({ ids, labels });
  }, [selectedIds, shots]);

  // 2026-05-25 C2 批量操作扩展: 批量给选中分镜的画面描述追加同款后缀文字
  // 典型场景: 整集统一加 "电影感胶片质感 / 黄昏色调 / 4K 高清" 之类的风格描述
  const [appendPromptDialog, setAppendPromptDialog] = useState<{ open: boolean; busy: boolean }>({ open: false, busy: false });
  const handleBatchAppendPrompt = useCallback(() => {
    if (selectedIds.size === 0) return;
    setAppendPromptDialog({ open: true, busy: false });
  }, [selectedIds]);
  const submitBatchAppendPrompt = useCallback(async (text: string) => {
    if (!slug || !selectedEpId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const ids = [...selectedIds];
    // P1-30 (2026-05-28 audit wave 4): 提交前算每镜追加后的预期长度, 超 2000 字符的告知用户并 reject.
    const PROMPT_MAX = 2000;
    const oversize: Array<{ index: number; predictedLen: number }> = [];
    for (const sid of ids) {
      const shot = shots.find((s) => s.id === sid);
      if (!shot) continue;
      const existing = (shot.prompt_img ?? "").trim();
      const predictedLen = (existing ? existing.length + 2 + trimmed.length : trimmed.length);
      if (predictedLen > PROMPT_MAX) {
        oversize.push({ index: shot.index ?? 0, predictedLen });
      }
    }
    if (oversize.length > 0) {
      const sampleIdx = oversize.slice(0, 3).map((o) => `第${o.index}镜(${o.predictedLen}字)`).join(", ");
      const more = oversize.length > 3 ? ` 等共 ${oversize.length} 镜` : "";
      toast.error(
        `${oversize.length} 镜追加后会超过 ${PROMPT_MAX} 字限制 — ${sampleIdx}${more}. 请缩短追加内容, 或先精简这些镜的现有描述.`,
        { duration: 6000 },
      );
      return;
    }
    setAppendPromptDialog({ open: true, busy: true });
    try {
      let ok = 0;
      for (const sid of ids) {
        const shot = shots.find((s) => s.id === sid);
        if (!shot) continue;
        const existing = (shot.prompt_img ?? "").trim();
        const next = existing ? `${existing}\n\n${trimmed}` : trimmed;
        try {
          await patchShot(slug, selectedEpId, sid, { prompt_img: next });
          ok++;
        } catch (e) {
          showErrorToast(e, `第 ${shot.index ?? "?"} 镜更新失败`);
        }
      }
      toast.success(`已给 ${ok} / ${ids.length} 镜追加描述`);
      await refresh();
      setAppendPromptDialog({ open: false, busy: false });
    } catch (err) {
      showErrorToast(err, "批量加描述失败");
      setAppendPromptDialog((s) => ({ ...s, busy: false }));
    }
  }, [slug, selectedEpId, selectedIds, shots, refresh]);

  const handleSingleDelete = useCallback((shotId: string, shotIndex?: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    const label = shotIndex ? `第${shotIndex}镜` : shotId.slice(0, 8);
    setDeleteConfirm({ ids: [shotId], labels: [label] });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteConfirm || !slug || !selectedEpId) return;
    setDeleting(true);
    try {
      for (const sid of deleteConfirm.ids) {
        await apiPost(`/api/v2/series/${slug}/episodes/${selectedEpId}/shots/${sid}/trash`, {});
      }
      toast.success(`${deleteConfirm.ids.length} 条分镜已移入垃圾桶`);
      setDeleteConfirm(null);
      clearSelect();
      await refresh();
    } catch (err) {
      showErrorToast(err, "删除失败");
    } finally {
      setDeleting(false);
    }
  }, [deleteConfirm, slug, selectedEpId, clearSelect, refresh]);

  // 2026-05-19 #C: W8-D 整集挂机抽首帧的 startNightBatch / confirmNightBatch handler 已删除.
  // 该能力合并进 AutoPipelineLauncher (运行模式 = 只跑首帧) 用后端并发执行.

  // T3: HTML5 原生拖拽
  const handleDragStart = useCallback((e: React.DragEvent, shotId: string) => {
    e.stopPropagation();
    setDragId(shotId);
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, shotId: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (shotId !== dragId) setDragOverId(shotId);
  }, [dragId]);

  const handleDrop = useCallback(async (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragId || dragId === targetId || !slug || !selectedEpId) {
      setDragId(null);
      setDragOverId(null);
      return;
    }

    const prevOrder = [...localOrder];
    const newOrder = [...localOrder];
    const fromIdx = newOrder.indexOf(dragId);
    const toIdx = newOrder.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) {
      setDragId(null);
      setDragOverId(null);
      return;
    }
    newOrder.splice(fromIdx, 1);
    newOrder.splice(toIdx, 0, dragId);

    // Optimistic 更新
    setLocalOrder(newOrder);
    setDragId(null);
    setDragOverId(null);

    try {
      await apiPost(`/api/v2/series/${slug}/episodes/${selectedEpId}/shots/reorder`, { shot_ids: newOrder });
    } catch (err) {
      // 回滚
      setLocalOrder(prevOrder);
      showErrorToast(err, "重排失败，已还原");
    }
  }, [dragId, localOrder, slug, selectedEpId]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverId(null);
  }, []);

  useEffect(() => {
    void loadSeries();
  }, [loadSeries]);

  useEffect(() => {
    clearSelect();
  }, [selectedEpId, clearSelect]);

  useEffect(() => {
    if (selectedEpId) setCurrentEpisode(selectedEpId);
  }, [selectedEpId, setCurrentEpisode]);

  const counts = useMemo(() => {
    const total = shots.length;
    const picked = shots.filter((s) => s.picked_first_frame_id || s.status === "approved").length;
    const ready = shots.filter((s) => s.status === "ready" && !s.picked_first_frame_id).length;
    return { total, picked, ready };
  }, [shots]);

  // T3: 分镜版本（W6-H 接通真实 hook）
  const { versions: rawSbVersions, loading: sbVersionsLoading, activate: activateSbVersion, remove: deleteSbVersion, create: createSbVersion } =
    useStoryboardVersions(slug, selectedEpId || undefined);
  const sbVersionSummaries = useMemo<VersionSummary[]>(
    () => rawSbVersions.map((v) => ({ id: v.id, name: v.name, created_at: v.created_at, is_active: v.is_active })),
    [rawSbVersions],
  );
  // 2026-07-22 X6-1 (A3-3): 激活分镜版本现在会**真搬分镜** (旧现行镜整套进垃圾桶, 目标版本 shots 从
  // 垃圾桶搬回)。激活后必须刷新分镜板, 否则用户看到的还是旧那套 = 状态撒谎。activateSbVersion 内部已
  // 吞错误弹 toast (409 冲突/快照缺失), 这里 await 完无条件刷一次 shots (失败时 shots 未变, 刷新无害)。
  const handleActivateSbVersion = useCallback(async (id: string) => {
    await activateSbVersion(id);
    await refresh();
  }, [activateSbVersion, refresh]);

  // useAsyncAction 接管 busy + 错误 — busy=true 时 noop, 防用户连点 race
  const createEpisodeAction = useAsyncAction(
    async () => {
      if (!slug) return null;
      const nextIndex = episodes.length > 0 ? Math.max(...episodes.map(getEpisodeNumber)) + 1 : 1;
      return createEpisode(slug, { title: `第 ${nextIndex} 集`, index: nextIndex });
    },
    {
      errorMessage: "新增集失败",
      onSuccess: async (result) => {
        if (result && slug) {
          await loadSeries();
          navigate(ROUTES.storyboard(slug, result.episode.id));
        }
      },
    },
  );
  const creatingEpisode = createEpisodeAction.busy;
  async function handleCreateEpisode() {
    if (!slug) return;
    await createEpisodeAction.run();
  }

  // 2026-05-21 — 集封面生成: 跟 SeriesDetail 同款, 多 episode 可并发, 按 epId 记录 busy
  const { add: addCoverGenerating, remove: removeCoverGenerating, has: isCoverGenerating } = useToggleSet<string>();
  const handleEpisodeCoverGen = useCallback(
    async (epId: string, opts: CoverGenerationOptions) => {
      if (!slug || isCoverGenerating(epId)) return;
      addCoverGenerating(epId);
      try {
        await generateEpisodeCover(slug, epId, opts);
        toast.success("集封面已生成");
        await loadSeries();
      } catch (err) {
        showErrorToast(err, "封面生成失败");
      } finally {
        removeCoverGenerating(epId);
      }
    },
    [slug, isCoverGenerating, addCoverGenerating, removeCoverGenerating, loadSeries],
  );

  /**
   * 2026-05-19 #14: 删除当前选中分集 — 软删到 .trash/ 可恢复, 二次确认.
   * 用户原话"不小心新建的分集无法删除".
   */
  async function handleDeleteEpisode() {
    if (!slug || !selectedEpId) return;
    const ep = episodes.find((e) => getEpisodeId(e) === selectedEpId);
    if (!ep) return;
    const number = getEpisodeNumber(ep) || episodes.indexOf(ep) + 1;
    const epTitle = ep.title || `第 ${number} 集`;
    const shotCount = shots.length;
    // P1-40 (2026-05-28 audit wave 4): 文案与 deleteEpisode 真 trash 范围对齐 — 整个 episodes/<id>/
    // 目录走软删到回收站, 含剧本 + 分镜板 + 版本历史 + 合成索引. 但产出图/视频在 assets/vault 里仍保留.
    // 2026-07-22 X6-2 (A3-8): 恢复入口已补齐 (回收站→分集一键恢复), 文案改成实话 —— 不再撒谎"联系开发/
    // 自动清理", 也不再泄漏 .trash/<id>_<ts> 技术路径 (铁律 #9 toC 兜底).
    const ok = await confirm({
      title: `删除「${epTitle}」?`,
      description:
        "· 这一集会从分镜板消失\n" +
        `· 删除范围: 集剧本 + 分镜板 (${shotCount} 个分镜) + 该集所有版本历史 + 合成索引\n` +
        "· 数据移入回收站, 可在「回收站 → 分集」里一键恢复 (整份分镜 + 已挑首帧/视频都会回来)\n" +
        "· 该集的产出图 / 视频 / vault 资源在归档柜里仍保留 (不随集软删)",
      variant: "destructive",
      confirmLabel: "删除这一集",
    });
    if (!ok) return;
    try {
      await deleteEpisode(slug, selectedEpId);
      // 删完跳到剩余第一集 or 系列总览
      await loadSeries();
      const remaining = episodes.filter((e) => getEpisodeId(e) !== selectedEpId);
      if (remaining.length > 0) {
        navigate(ROUTES.storyboard(slug, getEpisodeId(remaining[0])));
      } else {
        navigate(`/studio/${slug}`);
      }
    } catch (err) {
      showErrorToast(err, "删除集失败");
    }
  }

  // 两个 shot 操作 (create / insertAfter) 共享 busy — 通过 || 合并 useAsyncAction.busy
  const createShotAction = useAsyncAction(
    async () => {
      if (!slug || !selectedEpId) return;
      await createShot(slug, selectedEpId, {
        index: shots.length + 1,
        title: `分镜 ${shots.length + 1}`,
        action: "",
      });
      await refresh();
    },
    { errorMessage: "新增分镜失败" },
  );

  const insertShotAction = useAsyncAction(
    async (afterShotId: string) => {
      if (!slug || !selectedEpId) return;
      const { shot: newShot } = await createShot(slug, selectedEpId, {
        title: `分镜 ${shots.length + 1}`,
        action: "",
      });
      // 把新 shot 插入 afterShotId 之后
      const currentOrder = localOrder.length > 0 ? [...localOrder] : shots.map((s) => s.id);
      const insertIdx = currentOrder.indexOf(afterShotId);
      if (insertIdx === -1) {
        // afterShotId 不在当前列表时不需要 reorder, 直接刷新即可
        await refresh();
        return;
      }
      const newOrder = [...currentOrder];
      // 新 shot 追加在末尾, 把它移到 insertIdx + 1
      newOrder.splice(insertIdx + 1, 0, newShot.id);
      // 如果 newShot.id 已在 newOrder 末尾还要删掉重复(正常不会, 但防止 createShot 返回已存在 id)
      const dedupOrder = [...new Set(newOrder)];
      await apiPost(`/api/v2/series/${slug}/episodes/${selectedEpId}/shots/reorder`, { shot_ids: dedupOrder });
      await refresh();
    },
    { errorMessage: "插入分镜失败" },
  );

  const creatingShot = createShotAction.busy || insertShotAction.busy;
  async function handleCreateShot() {
    if (!slug || !selectedEpId) return;
    await createShotAction.run();
  }
  async function handleInsertShotAfter(afterShotId: string) {
    if (!slug || !selectedEpId) return;
    await insertShotAction.run(afterShotId);
  }

  // W7-PM-cleanup (User #22.2): scrollStrip 不再被调用(左右箭头已删),保留 stripRef 给 mk-scroll 用 — 现已挪进 EpisodeStrip 子组件内部

  if (!slug) {
    return (
      <PageTransition>
        <div className="flex min-h-[60vh] items-center justify-center p-6">
          <Empty title="缺少系列" description="请先选择或创建一个系列" cta="回首页" onCta={() => navigate("/studio")} />
        </div>
      </PageTransition>
    );
  }

  // 空 episodes 优雅引导(铁律 #1 用户控制权 + #10 优雅空状态 > 强制流程)
  if (!loadingSeries && episodes.length === 0) {
    return (
      <PageTransition>
        <div className="flex min-h-[60vh] items-center justify-center p-6">
          <Empty
            icon={<Icon name="film" size={48} />}
            title="这个系列还没有剧集"
            description="先到灵感箱写一条想法,或者直接去剧本页开写,再回来拆分镜。"
            cta="回系列总览"
            onCta={() => navigate(ROUTES.seriesDetail(slug))}
          />
        </div>
      </PageTransition>
    );
  }

  const allSelected = orderedShots.length > 0 && selectedCount === orderedShots.length;
  const someSelected = selectedCount > 0 && selectedCount < orderedShots.length;

  return (
    <PageTransition>
      <div className="v24-shotboard-page" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-canvas)" }}>
        {/* 顶部标题栏 (T1: 删除视图切换 UI) */}
        <ShotboardHeader
          slug={slug}
          series={series}
          episodes={episodes}
          counts={counts}
          selectedEpisode={selectedEpisode}
          sbVersionSummaries={sbVersionSummaries}
          sbVersionsLoading={sbVersionsLoading}
          navigate={navigate}
          onActivateSbVersion={handleActivateSbVersion}
          onDeleteSbVersion={deleteSbVersion}
          onCreateSbVersion={() => { void createSbVersion({ activate: true }); }}
          onShowPasteDialog={() => setShowPasteDialog(true)}
        />

        <div className="mk-scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 24px 28px" }}>
          {/* 剧集列表 (T6: 添加新集卡片视觉一致) */}
          <EpisodeStrip
            episodes={episodes}
            loadingSeries={loadingSeries}
            selectedEpId={selectedEpId}
            slug={slug}
            location={location}
            navigate={navigate}
            creatingEpisode={creatingEpisode}
            isCoverGenerating={isCoverGenerating}
            onEpisodeCoverGen={(id, opts) => void handleEpisodeCoverGen(id, opts)}
            onCreateEpisode={handleCreateEpisode}
          />

          {/* 2026-05-27 — 本集节奏可视化时间轴, 给用户全局视野: 总时长/镜数/情绪分布/钩子提醒 */}
          {slug && selectedEpId && orderedShots.length > 0 && (
            <EpisodeTimelineBar
              shots={orderedShots}
              slug={slug}
              selectedEpId={selectedEpId}
              navigate={navigate}
            />
          )}

          {/* 2026-05-28 AI 出图打磨 — 跨分镜一致性 + 情绪连贯性 全局体检 (在节奏轴下方, 出图前先看) */}
          {slug && selectedEpId && orderedShots.length > 0 && (
            <EpisodeShotIntelligenceAdvisor
              shots={orderedShots}
              slug={slug}
              selectedEpId={selectedEpId}
              navigate={navigate}
            />
          )}

          {/* 分镜列表 */}
          <ShotGrid
            slug={slug}
            selectedEpId={selectedEpId}
            selectedEpisode={selectedEpisode}
            episodes={episodes}
            pickerMode={pickerMode}
            loadingShots={loadingShots}
            shotsError={shotsError}
            orderedShots={orderedShots}
            dragId={dragId}
            dragOverId={dragOverId}
            hasShotSelected={hasShotSelected}
            toggleShotId={toggleShotId}
            allSelected={allSelected}
            someSelected={someSelected}
            selectAll={selectAll}
            clearSelect={clearSelect}
            creatingShot={creatingShot}
            navigate={navigate}
            autoPipeline={autoPipeline}
            onCreateShot={handleCreateShot}
            onInsertAfter={(sid) => void handleInsertShotAfter(sid)}
            onSingleDelete={handleSingleDelete}
            onDeleteEpisode={() => void handleDeleteEpisode()}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={(e, sid) => void handleDrop(e, sid)}
            onDragEnd={handleDragEnd}
          />

          {/* T4: 批量操作底栏 */}
          {selectedCount > 0 && !pickerMode && (
            <BulkActionBar
              selectedCount={selectedCount}
              onBatchDryRunFirstframe={() => void handleBatchDryRun("firstframe")}
              onBatchDryRunVideo={() => void handleBatchDryRun("video")}
              onBatchAppendPrompt={handleBatchAppendPrompt}
              onBatchDelete={handleBatchDelete}
              onClearSelect={clearSelect}
            />
          )}

          {/* 2026-05-25 C2: 批量加描述弹窗 */}
          <PromptDialog
            open={appendPromptDialog.open}
            busy={appendPromptDialog.busy}
            title={`批量给 ${selectedCount} 镜追加画面描述`}
            description="输入要追加的文字, 系统会在每镜原画面描述末尾另起一段插入. 适合整集统一加风格 (例: 电影感胶片质感 / 黄昏色调 / 4K)."
            label="追加文字"
            placeholder="例: 电影感胶片质感, 颗粒感, 暖色调"
            multiline
            confirmText="追加"
            onClose={() => setAppendPromptDialog({ open: false, busy: false })}
            onSubmit={submitBatchAppendPrompt}
          />
        </div>

        {/* 批量抽帧/视频 dry-run 弹窗 */}
        {dryRun && (
          <DryRunModal
            dryRun={dryRun}
            selectedIds={selectedIds}
            selectedCount={selectedCount}
            orderedShots={orderedShots}
            onCancel={() => setDryRun(null)}
            onConfirm={() => void handleBatchExecute()}
          />
        )}

        {/* T5: 删除二次确认 */}
        {deleteConfirm && (
          <DeleteConfirmModal
            count={deleteConfirm.ids.length}
            labels={deleteConfirm.labels}
            onCancel={() => !deleting && setDeleteConfirm(null)}
            onConfirm={() => void confirmDelete()}
          />
        )}

        {/* 2026-05-19 #C: W8-D 整集挂机抽首帧二次确认 modal 已删除 — 合并进 AutoPipelineLauncher. */}

        {/* 2026-05-18 EVE-4: 粘贴 AI 分镜对话框 — 跳过灵感+剧本步骤直接导入 */}
        {showPasteDialog && slug && (
          <PasteStoryboardDialog
            slug={slug}
            epId={selectedEpId || undefined}
            onClose={() => setShowPasteDialog(false)}
            onImported={() => {
              setShowPasteDialog(false);
              refresh();
            }}
          />
        )}
      </div>
    </PageTransition>
  );
}
