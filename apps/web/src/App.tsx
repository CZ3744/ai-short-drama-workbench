import { useEffect, lazy, Suspense, useState, useRef, useCallback } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet, useNavigate, useLocation, useParams } from "react-router-dom";
import { TooltipProvider } from "./components/ui/tooltip";
import { Toaster } from "./components/ui/toast";
import { ConfirmModalProvider } from "./components/ui/ConfirmModal";
import { GlobalToolsProvider } from "./components/shell/GlobalTools";
import { AppTopBar } from "./components/shell/AppTopBar";
import { AppSideNav } from "./components/shell/AppSideNav";
import { GlobalQueuePanel } from "./components/studio/GlobalQueuePanel";
import { AIAssistantPanel } from "./components/ai-assistant/AIAssistantPanel";
import { GlobalKeyboardShortcutsHelp } from "./components/shell/KeyboardShortcutsDialog";
import { useScrollRestoration } from "./hooks/useScrollRestoration";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { WelcomeTour } from "./components/tour/WelcomeTour";
import { useSessionStore } from "./stores/sessionStore";
import { useTasksStore } from "./stores/tasksStore";
// 2026-05-28 P0-9/23: GlobalQueuePanel 原自建独立 SSE — 跟 App.tsx 重复订阅同 URL.
// 现把 task.* event handlers 整合到 App 全局唯一 SSE client, GlobalQueuePanel 只消费 store.
import { createSSEClient, buildTaskEventHandlers } from "./lib/sse";
import { toast } from "sonner";
import { useTaskSynchronization } from "./hooks/useTaskSynchronization";
import { showErrorToast } from "./lib/errorTranslate";
import { invalidateShots, invalidateElements } from "./lib/swrInvalidate";
import { PageTransition } from "./components/studio/PageTransition";
import { safeStorage } from "./lib/safeStorage";

const StudioHome = lazy(() => import("./pages/StudioHome"));
const SeriesDetail = lazy(() => import("./pages/SeriesDetail"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const NotFound = lazy(() => import("./pages/NotFound"));

// P32-P37 业务页面
const InboxPage = lazy(() => import("./pages/inbox/InboxPage"));
const ScriptCanvasPage = lazy(() => import("./pages/script/ScriptCanvasPage"));
const ShotboardPage = lazy(() => import("./pages/shotboard/ShotboardPage"));
// W8-nightly: characters / scenes 4 个 legacy lazy 声明删除 — 路由表已迁移到 Element,
// 见 docs/ASSET_MANAGEMENT_REDESIGN.md §8。文件保留作 git 历史,等下一次大清理再删。
// 统一素材 Element 页 — 见 docs/ASSET_MANAGEMENT_REDESIGN.md §8
const ElementListPage = lazy(() => import("./pages/element/ElementListPage"));
const ElementWorkbench = lazy(() => import("./pages/element/ElementWorkbench"));
const ComposePage = lazy(() => import("./pages/compose/ComposePage"));
const TimelinePage = lazy(() => import("./pages/shotboard/TimelinePage"));
// 2026-05-26 audit #8: 3 页合并到 /status (内部 3 tab "健康/失败/日志").
// 老路由 /cockpit / /diagnostics / /failures 全部 redirect 过去.
const SystemStatusPage = lazy(() => import("./pages/system/SystemStatusPage"));
const VaultPage = lazy(() => import("./pages/vault/VaultPage"));
// 2026-05-26 audit #2: /library 已合并到 /vault (VaultPage 顶部加范围切换 tab).
// 老 /library 路由保留兼容书签, 内部直接 Navigate 到 /vault.
// v24-batch-all · shot 4-stage 流水线
const ShotStagePage = lazy(() => import("./pages/shot-stage/ShotStagePage"));
const ShotFailureCenter = lazy(() => import("./pages/shot-stage/FailureCenter"));
// 2026-05-26 audit #1: 统一全局垃圾桶 (分镜 / 素材 / 系列 三 tab)
// 旧 TrashPage / SeriesTrashPage / ElementTrashPage 路由全部重定向到这里.
const GlobalTrashPage = lazy(() => import("./pages/trash/GlobalTrashPage"));
// W5 (2026-05-26): Cast/IP 详情页 (后端 cast 数据仍在, 仅为兼容老书签保留 detail 路由)
const CastDetailPage = lazy(() => import("./pages/cast/CastDetailPage"));

function Loading() {
  // 2026-05-27 — 用户原话: "刷新页面之后会有几个 tab 加载然后弹出, 比较影响观感".
  // 之前居中大 spinner + "加载中..." 文字 + min-h 60vh, 每次 lazy chunk 加载都 闪
  // 一下再切真页面, 视觉跳变明显. 改成顶部细 progress bar (Linear / GitHub /
  // YouTube 同款), 不抢视野, 几乎感知不到 chunk 加载耗时.
  return (
    <div style={{ position: "relative", minHeight: 60, padding: 16 }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          overflow: "hidden",
          background: "transparent",
        }}
      >
        <div
          style={{
            height: "100%",
            background: "linear-gradient(90deg, transparent, var(--brand-500) 50%, transparent)",
            backgroundSize: "200% 100%",
            animation: "mk-progress-shimmer 1.2s linear infinite",
          }}
        />
      </div>
    </div>
  );
}

/**
 * P31 全局 SSE 接线 — App 挂载时建立连接。
 *
 * 事件映射(与后端 sseProgress/sseDone/sseError 对齐):
 *   event: progress → onProgress(data) — data.stage 指示阶段
 *   event: done     → onDone(data)     — 任务完成
 *   event: error    → onSseError(data) — 任务失败
 *   未命名 event    → onMessage(data)  — shot.updated / ledger.record 等
 *
 * P60 Task 3C: Toast 通知增强 — 完成加"查看"、失败加"重试"、统一走 sonner
 */
function useGlobalSSE() {
  const currentSeriesSlug = useSessionStore((s) => s.currentSeriesSlug);
  const addSeriesCost = useSessionStore((s) => s.addSeriesCost);
  const navigate = useNavigate();

  // 用 ref 存储 navigate 避免每次路由变化导致 SSE 重连
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const addSeriesCostRef = useRef(addSeriesCost);
  addSeriesCostRef.current = addSeriesCost;

  // 2026-05-17: 全局 task 占位兜底 — 任何页面 mount/刷新, App 顶层一次性拉
  //   GET /api/v2/tasks?status=queued|running → 写入 tasksStore.
  // 这样所有页面 (ShotStagePage / ElementWorkbench / SeriesDetail / ...) 自动恢复"生成中"占位,
  // 不需要每个页面各自做 fetch (违反解耦).
  //
  // 用户反馈"在添加场景界面生图,生成中关掉二级弹窗去其他板块再回来, 占位消失" — 真因 = ElementWorkbench
  // 用本地 useState genProgress 而非 tasksStore, mount 时 state reset 丢占位. 全局 prefetch 修这类问题.
  //
  // 2026-05-27 — 同款函数同时绑 visibilitychange / online / 周期 30s 兜底:
  //   dev server tsx watch restart 后 SSE seq 重置, ring buffer 清空, 客户端
  //   reconnect 时带的旧 lastEventId 大于新 _seq → replayFromId 漏掉中间 emit
  //   的 task.done → 前端永远以为视频在跑. 这里把 mount 时这个 fetch 抽出来,
  //   在 tab 切回 / 网络恢复 / 定时器周期都重跑, 把卡死的 queued/running
  //   task 同步到真实 done/failed.
  const synchronizeTasks = useTaskSynchronization();

  useEffect(() => {
    if (!currentSeriesSlug) return;

    const slug = currentSeriesSlug;

    // 2026-05-28 P0-9/23 合并 GlobalQueuePanel SSE: task.* event handler 全跟到这一个
    // 全局 SSE client. task succeeded 时 toast (跟原 GQP 行为对齐).
    const taskHandlers = buildTaskEventHandlers(slug, (shotId, kind, status) => {
      if (status === "succeeded") {
        toast.success(
          kind === "image" ? "首帧已生成，候选区已刷新" :
          kind === "video" ? "视频已生成，候选区已刷新" :
          "任务完成",
          { duration: 4000, id: `task-done-${shotId}-${kind}` },
        );
      }
    });

    const client = createSSEClient({
      seriesSlug: slug,
      onOpen: () => { void synchronizeTasks(); },

      // ── event: progress — 任务进度更新 ──
      onProgress: (data) => {
        // data.stage 格式如 "compose.start", "expand-script.done" 等
        const stage = data.stage || "";
        const jobId = data.job_id || "";
        if (jobId) {
          useTasksStore.getState().upsertEvent({
            jobId,
            series_slug: slug || data.series_slug || undefined,
            stage,
            progress: data.progress ?? data.percent ?? 0,
            status: "running",
            message: data.message,
            timestamp: Date.now(),
            shot_id: data.shot_id,
            ep_id: data.episode_id,
          });
        }

        // ── 3E compose.shot 事件 → composeShotMap 实时更新 ──
        if (stage === "compose.shot" && data.shot_id) {
          useTasksStore.getState().pushComposeShot({
            shot_id: data.shot_id,
            index: data.index ?? 0,
            total: data.total ?? 0,
            audio_generated: !!data.audio_generated,
            srt_done: !!data.srt_done,
          });
        }
      },

      // ── event: done — 任务成功完成 ──
      onDone: (data) => {
        const jobId = data.job_id || "";
        const epId = data.episode_id || "";
        const stage = data.stage || "done";

        if (jobId) {
          useTasksStore.getState().upsertEvent({
            jobId,
            series_slug: slug || data.series_slug || undefined,
            stage,
            progress: 100,
            status: "completed",
            message: data.message,
            timestamp: Date.now(),
            ep_id: epId || undefined,
          });
        }

        // P60 3C-1: Toast 完成加 "查看" action — 导航到对应页面
        const viewLabel = stage.startsWith("compose") || stage.startsWith("export")
          ? "查看合成" : "查看进度";
        const targetPath = epId
          ? (stage.startsWith("export")
              ? `/studio/${slug}/compose/${epId}`
              : stage.startsWith("compose")
              ? `/studio/${slug}/compose/${epId}`
              : stage.startsWith("expand-script") || stage === "done"
              ? `/studio/${slug}/script`
              : stage.startsWith("plan-storyboard")
              ? `/studio/${slug}/storyboard/${epId}`
              : `/studio/${slug}/compose/${epId}`)
          : `/studio/${slug}`;

        toast.success(data.message || "任务完成", {
          duration: 6000,
          action: epId ? {
            label: viewLabel,
            onClick: () => navigateRef.current(targetPath),
          } : undefined,
        });

        // V-1.3: plan-storyboard 完成后失效分镜 SWR 缓存
        if (stage.startsWith("plan-storyboard") && epId) {
          void invalidateShots(slug, epId);
        }

        // P70 5f: 浏览器通知 — 视频生成完成
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification("视频生成完成", {
              body: data.message || "点击查看生成结果",
              tag: "compose-done",
            });
          } catch { /* 忽略通知失败 */ }
        }
      },

      // ── event: error — 服务端业务错误 ──
      onSseError: (data) => {
        const jobId = data.job_id || "";
        const epId = data.episode_id || "";
        const errMsg = data.error?.message || data.message || "任务失败";
        const errorCode = data.error?.code || "";

        if (jobId) {
          useTasksStore.getState().upsertEvent({
            jobId,
            series_slug: slug || data.series_slug || undefined,
            stage: data.stage || "error",
            progress: 0,
            status: "failed",
            message: errMsg,
            timestamp: Date.now(),
            ep_id: epId || undefined,
          });
        }

        // P170 4F: 失败 toast 走 showErrorToast + "重试" action
        const sseError = { message: errMsg, code: errorCode, details: data.error?.details };
        // 未携带原始参数的通用错误通知不能擅自重跑合成或触发扣费。
        // 保留错误说明与设置引导；重新提交由对应创作页的明确操作完成。
        showErrorToast(sseError, errMsg);
      },

      // ── 未命名事件(无 event: 字段) ──
      // 2026-05-29 E-01: shot.updated 已移至 onEvent map (命名事件走 addEventListener, 不走 onMessage).
      // ledger.record 保留在此 (后端从未实际 emit, 仅作防御性兼容).
      onMessage: (data) => {
        // ledger 记录 → 更新花费 + Toast (P60 3C-3: 统一走 sonner)
        if (data.type === "ledger.record") {
          const amount = data.amount || 0;
          const jobId = data.job_id || "";
          useTasksStore.getState().setLedger(amount, jobId);
          addSeriesCostRef.current(amount);
          toast.success(`已记录 ¥${(amount / 100).toFixed(2)}`);
        }
      },

      // ── P170 1B: 监听 compose.* 命名事件 ──
      // 2026-05-28 P0-9/23 合并 GlobalQueuePanel: task.* event 全部走 taskHandlers,
      // P0-19: server 重启后 session.reconnect-stale → 主动 fetch /api/v2/tasks 同步.
      onEvent: {
        ...taskHandlers,
        "session.reconnect-stale": () => { void synchronizeTasks(); },
        "compose.stage": (data) => {
          // compose 阶段推进，无需特殊处理（ComposePage 自己的 SSE 会处理）
          // 但如果用户不在合成页，可以显示全局 toast
          if (data.stage) {
            const stageLabel: Record<string, string> = {
              concat: "合并中", burning: "烧录字幕中", done: "合成完成", error: "合成失败",
            };
            const label = stageLabel[data.stage] ?? data.stage;
            const jobId = data.job_id || "";
            if (jobId) {
              useTasksStore.getState().upsertEvent({
                jobId,
                series_slug: slug || data.series_slug || undefined,
                stage: `compose.${data.stage}`,
                progress: data.percent ?? 0,
                status: data.stage === "done" ? "completed" : data.stage === "error" ? "failed" : "running",
                message: `合成: ${label}`,
                timestamp: Date.now(),
                ep_id: data.episode_id || undefined,
              });
            }
          }
        },
        "compose.progress": (data) => {
          const jobId = data.job_id || "";
          if (jobId) {
            useTasksStore.getState().upsertEvent({
              jobId,
              series_slug: slug || data.series_slug || undefined,
              stage: "compose.progress",
              progress: data.percent ?? 0,
              status: "running",
              message: data.step || "合成进度更新",
              timestamp: Date.now(),
              ep_id: data.episode_id || undefined,
            });
          }
        },
        "compose.done": (data) => {
          const jobId = data.job_id || "";
          const epId = data.episode_id || "";
          if (jobId) {
            useTasksStore.getState().upsertEvent({
              jobId,
              series_slug: slug || data.series_slug || undefined,
              stage: "compose.done",
              progress: 100,
              status: "completed",
              message: data.message || "合成完成",
              timestamp: Date.now(),
              ep_id: epId || undefined,
            });
          }
          toast.success(data.message || "合成完成", {
            duration: 6000,
            action: epId && slug ? {
              label: "查看合成",
              onClick: () => navigateRef.current(`/studio/${slug}/compose/${epId}`),
            } : undefined,
          });
        },
        "compose.error": (data) => {
          const jobId = data.job_id || "";
          const errMsg = data.error?.message || data.message || "合成失败";
          if (jobId) {
            useTasksStore.getState().upsertEvent({
              jobId,
              series_slug: slug || data.series_slug || undefined,
              stage: "compose.error",
              progress: 0,
              status: "failed",
              message: errMsg,
              timestamp: Date.now(),
              ep_id: data.episode_id || undefined,
            });
          }
          showErrorToast({ message: errMsg, code: "COMPOSE_ERROR" }, errMsg);
        },
        // 2026-05-20 P1 红线 #1 + 铁律 0 Entity-first:
        // 后端 buildReferenceSet 检测到参考图 vault 找不到 / 文件不存在时, 通过此事件显式上报.
        // 取代旧 silent skip 行为 — 让用户在浏览器看到为什么角色在这镜里像变了个人, 而不是被静默吞掉.
        "references.missing": (data) => {
          const missing = (data?.missing ?? []) as Array<{
            source_type: "character" | "scene";
            source_label: string;
            vault_id: string;
            reason: "vault_not_found" | "file_missing" | "resolve_failed" | "entity_not_resolvable";
          }>;
          if (missing.length === 0) return;
          // toC 兜底 (铁律 #9): reason 翻译人话
          const reasonLabel: Record<string, string> = {
            vault_not_found: "素材库找不到",
            file_missing: "图片文件缺失",
            resolve_failed: "读取出错",
            // 2026-05-20 P1 audit Bug 6: entity 本身查不到(脏数据 / 占位未建)
            entity_not_resolvable: "素材本身未建",
          };
          const samples = missing.slice(0, 3).map(m => {
            const kind = m.source_type === "character" ? "角色" : "场景";
            return `${kind}「${m.source_label}」(${reasonLabel[m.reason] ?? m.reason})`;
          }).join("、");
          const more = missing.length > 3 ? ` 等共 ${missing.length} 张` : "";
          toast.warning(`参考图未找到: ${samples}${more} — 影响视觉一致性，请检查素材库`, {
            duration: 8000,
            id: `references-missing-${data?.shot_id ?? "unknown"}`,
          });
        },
        // 2026-05-20 P1 audit Bug 4: 拆分镜时占位 entity 自动建失败的 SSE 上报。
        // 不再 silent swallow — 让用户看到"N 个素材占位未自动建,请去素材库手动补"。
        "entities.upsert.partial": (data) => {
          const failedCount = data?.failed_count ?? 0;
          const failedNames = (data?.failed_names ?? []) as string[];
          if (failedCount === 0) return;
          const samples = failedNames.slice(0, 3).join("、");
          const more = failedCount > 3 ? ` 等共 ${failedCount} 个` : "";
          toast.warning(`部分素材占位创建失败: ${samples}${more} — 请去素材库手动新建`, {
            duration: 8000,
            id: `entities-upsert-partial-${data?.episode_id ?? "unknown"}`,
          });
        },
        // V-1.7: 剧本提取素材完成后刷新素材 SWR 缓存
        "elements.extracted": (_data) => {
          void invalidateElements(slug);
        },
        // 2026-05-29 E-01: shot.updated — 分镜生图完成后标记 dirty, 触发 SWR mutate 刷新候选区.
        // 之前此事件在 onMessage 里但命名事件走 addEventListener 不走 onMessage → 死代码, 已删除.
        // 注: emit 的 SseEvent 包装在 data 层, 真正 payload 在 data.data.
        "shot.updated": (data) => {
          const inner = data?.data || {};
          useTasksStore.getState().markShotDirty(inner.key || inner.shot_id || data?.shot_id);
        },
        // 2026-05-29 E-02: shot.quality_warning — 生图后 CLIP 质量 <0.22 时实时 toast 提示用户.
        // 之前前端 0 监听, SSE 推送静默丢弃. 用户只能在下次 GET /shots 才能看到 warning 字段.
        "shot.quality_warning": (data) => {
          const inner = data?.data || {};
          toast.warning("这张图跟提示词差距较大，可重新抽取", {
            duration: 6000,
            id: `quality-warning-${inner.shot_id ?? "unknown"}`,
          });
        },
        // 2026-05-29 E-02: shot.continuity_warning — 视觉连续性检查不通过时实时 toast.
        // 2026-07-09 audit C31: inner.reason 是视觉大模型的自由文本英文输出 (如 "The character's
        // jacket changed from red to blue..."), 中文 toast 里夹一句英文违反铁律 #9 toC 兜底。
        // 无通用英译中 helper 可套, 前端不再展示原始 reason (与同类 shot.quality_warning 一致,
        // 该 toast 本就没有 description)。reason 仍会持久化到 shot.continuity_warning.reason + 日志,
        // 不影响排障。
        "shot.continuity_warning": (data) => {
          const inner = data?.data || {};
          toast.warning("此图与上一镜视觉差异较大，可能影响连续性", {
            duration: 6000,
            id: `continuity-warning-${inner.shot_id ?? "unknown"}`,
          });
        },
      },

      onError: () => {
        toast.error("实时连接已断开，正在自动重连...", { duration: 3000 });
      },
    });

    return () => client.dispose();
  }, [currentSeriesSlug]); // only reconnect when series slug changes
}

/**
 * P31 主 Layout — 顶栏 + 侧栏 + Outlet。
 *
 * 2026-05-17: 应用户原话移除全局键盘操作入口,所有业务动作回到可见按钮。
 * PageActionsContext 与命令/帮助弹层也一并移除。
 */
function StudioShell() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  useGlobalSSE();
  // 2026-05-27 — 路由切换记忆滚动位置 (用户原话: "点进之前在哪, 返回就在哪")
  useScrollRestoration();
  const location = useLocation();
  useEffect(() => {
    const sections: Array<[RegExp, string]> = [
      [/\/settings/, "设置"], [/\/status/, "系统状态"], [/\/trash/, "回收站"],
      [/\/vault/, "归档柜"], [/\/shot-stage/, "单镜创作"], [/\/storyboard/, "分镜"],
      [/\/script/, "剧本"], [/\/inbox/, "灵感收件箱"], [/\/elements/, "素材"],
      [/\/compose/, "合成"], [/\/timeline/, "时间线"], [/^\/studio\/[^/]+$/, "系列总览"],
    ];
    document.title = `${sections.find(([pattern]) => pattern.test(location.pathname))?.[1] ?? "工作台"} · AI 短剧工作台`;
    setNavigationOpen(false);
  }, [location.pathname]);

  // T11: 首次启动 3 步引导 — 使用 video-generate.onboarding.completed.v3 标记 (audit P2 统一前缀).
  // 读时兼容老 key "onboarded_v3" 防丢用户偏好.
  const [tourActive, setTourActive] = useState(
    () => {
      const v = safeStorage.getItem("video-generate.onboarding.completed.v3") ?? safeStorage.getItem("onboarded_v3");
      return v !== "demo_completed";
    },
  );
  const [tourKey, setTourKey] = useState(0);
  const shouldShowWelcomeTour = tourActive && location.pathname === "/studio";

  const restartTour = useCallback(() => {
    safeStorage.removeItem("video-generate.onboarding.completed.v3");
    safeStorage.removeItem("onboarded_v3"); // 老 key 也清 — 防止 isOnboarded() fallback 兜底再次开启
    setTourKey((k) => k + 1);
    setTourActive(true);
  }, []);

  const closeTour = useCallback(() => {
    setTourActive(false);
  }, []);

  return (
    <div className="flex flex-col h-screen bg-[var(--surface-canvas)]">
      <a className="studio-skip-link" href="#studio-main">跳到主要内容</a>
      <AppTopBar navigationOpen={navigationOpen} onToggleNavigation={() => setNavigationOpen(v => !v)}>
        <GlobalKeyboardShortcutsHelp />
        <AIAssistantPanel />
        <GlobalQueuePanel />
      </AppTopBar>

      <div className="studio-body flex flex-1 overflow-hidden">
        {navigationOpen && <button className="studio-nav-backdrop" aria-label="关闭导航" onClick={() => setNavigationOpen(false)} />}
        <aside id="studio-navigation" className={`studio-navigation shrink-0 h-full ${navigationOpen ? "is-open" : ""}`} onClick={event => { if ((event.target as HTMLElement).closest("a, button")) setNavigationOpen(false); }}>
          <AppSideNav />
        </aside>

        {/* 2026-05-27 — pb-12 删除. 用户截图显示整页 viewport 底部一条 48px 白带,
            就是这个 padding-bottom: 3rem 留的"浮按钮空间". 但 AI 助手 / GlobalQueuePanel
            是 fixed position, 不占文档流, 浮在右下角不需要给 main 预留空间. 删了
            内容贴底, 浮按钮自然浮在内容右下角 (左侧/中间区域完全不受影响). */}
        <main id="studio-main" tabIndex={-1} className="studio-main flex-1 overflow-y-auto">
          <ErrorBoundary resetKey={location.pathname}>
            <Suspense fallback={<Loading />}>
              {/* 注:页面过渡动画由每个 page 组件内的 PageTransition 负责,
                  此处不再包裹 AnimatePresence/motion.div,避免双层嵌套导致白屏 */}
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>



      {/* T11: 首次启动 3 步引导 — 唯一的首启引导.
          2026-07-09 audit: 原来这里还并挂 <FirstRunChecklist>, 与 WelcomeTour 串行叠加:
          用户先看 3 步模态(欢迎/配模型/建系列), 关掉后左侧又滑出 checklist 重复"填 key/建系列",
          同一批首启任务被引导两遍(违反第一性原理·纯摩擦). 收敛为只留 WelcomeTour 一套
          (它已含配模型 + 真建示例系列, 是更完整的引导); checklist 不再自动弹出. */}
      <WelcomeTour key={tourKey} active={shouldShowWelcomeTour} onClose={closeTour} />
    </div>
  );
}

// ---- 占位组件(P35 场景库未实现) ----

function SeriesOverviewPlaceholder() {
  return (
    <PageTransition>
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="text-[48px] mb-4 text-[var(--ink-300)]">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="inline-block">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
              <polygon points="10 8 15 10 10 12" />
            </svg>
          </div>
          <h2 className="text-[var(--fs-xl)] font-semibold text-[var(--ink-900)] mb-2">系列总览</h2>
          <p className="text-[var(--fs-sm)] text-[var(--ink-500)]">在左侧选择一个阶段开始创作</p>
        </div>
      </div>
    </PageTransition>
  );
}

export default function App() {
  return (
    <TooltipProvider>
      <GlobalToolsProvider>
      <ConfirmModalProvider>
      <BrowserRouter>
        <Routes>
          {/* 根路由 → 默认跳 /studio */}
          <Route path="/" element={<Navigate to="/studio" replace />} />

          {/* /studio — 引导页(无 shell) */}
          <Route
            path="/studio"
            element={
              <StudioShell />
            }
          >
            {/* index → 系列引导页 */}
            <Route index element={<StudioHome />} />

            {/* /studio/:slug — 系列总览 */}
            <Route path=":slug" element={<SeriesDetail />}>
              <Route index element={<SeriesOverviewPlaceholder />} />
              <Route path="inbox" element={<InboxPage />} />
              <Route path="script" element={<ScriptCanvasPage />} />
              <Route path="script/:epId" element={<ScriptCanvasPage />} />
              <Route path="storyboard" element={<ShotboardPage />} />
              <Route path="storyboard/:epId" element={<ShotboardPage />} />
              {/* 统一素材 Element: 全部 / 按 kind / 详情 */}
              <Route path="elements" element={<ElementListPage />} />
              <Route path="elements/kind/:kind" element={<ElementListPage />} />
              {/* 2026-05-26 audit #1: 素材回收站合并到全局 /trash. 老路由重定向. */}
              <Route path="elements/trash" element={<Navigate to="/trash?tab=elements" replace />} />
              <Route path="elements/:elementId" element={<ElementWorkbench />} />
              <Route path="timeline/:epId" element={<TimelinePage />} />
              <Route path="compose/:epId" element={<ComposePage />} />
              {/* v24-batch-all · 单镜 4-stage 流水线 */}
              <Route path="shot-stage/:epId/:shotId" element={<ShotStagePage />} />
              <Route path="shot-stage/:epId/:shotId/failures" element={<ShotFailureCenter />} />
              {/* 2026-05-26 audit #1: 分镜垃圾桶合并到全局 /trash. 老路由重定向 (保留 series scope). */}
              <Route path="trash" element={<Navigate to="/trash?tab=shots" replace />} />
            </Route>
          </Route>

          {/* 根级次要入口 — 也需要 shell 才有返回/面包屑 */}
          <Route element={<StudioShell />}>
            {/* 2026-05-26 audit #8: /cockpit + /diagnostics + /failures 合到 /status 3 tab.
                老路由全部 redirect 兼容老书签 (?tab= 参数自动落到对应 tab). */}
            <Route path="/status" element={<SystemStatusPage />} />
            <Route path="/cockpit" element={<Navigate to="/status?tab=logs" replace />} />
            <Route path="/diagnostics" element={<Navigate to="/status?tab=health" replace />} />
            <Route path="/failures" element={<Navigate to="/status?tab=failures" replace />} />
            <Route path="/dashboard" element={<Navigate to="/status?tab=logs" replace />} />
            <Route path="/vault" element={<VaultPage />} />
            {/* 2026-05-26 audit #2: /library 合并到 /vault — 老路由重定向兼容老书签. */}
            <Route path="/library" element={<Navigate to="/vault?scope=global" replace />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* 2026-05-26 audit #1: 全局垃圾桶 (替代 /trash/series + /studio/:slug/trash + /studio/:slug/elements/trash) */}
            <Route path="/trash" element={<GlobalTrashPage />} />
            <Route path="/trash/series" element={<Navigate to="/trash?tab=series" replace />} />
            {/* W7 (2026-05-26): Cast/IP 详情页 — 后端数据仍在, 仅保留 detail 路由给老书签 / debug.
                /casts 列表页 + /casts/:castId/dashboard 跨剧台账已删 — 单用户本机不做"独立 IP 容器", 用素材组顶替.
                老书签 /casts 重定向到当前系列素材库 (没系列则主页). */}
            <Route path="/casts" element={<Navigate to="/studio" replace />} />
            <Route path="/casts/:castId" element={<CastDetailPage />} />
            <Route path="/casts/:castId/dashboard" element={<Navigate to="/studio" replace />} />
          </Route>

          {/* catch-all 404 */}
          <Route
            path="*"
            element={
              <Suspense fallback={<Loading />}>
                <NotFound />
              </Suspense>
            }
          />
        </Routes>
      </BrowserRouter>

      <Toaster position="top-right" richColors />
      </ConfirmModalProvider>
    </GlobalToolsProvider>
    </TooltipProvider>
  );
}
