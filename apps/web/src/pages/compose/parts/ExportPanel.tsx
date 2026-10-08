/**
 * ExportPanel.tsx — 2026-05-22 重构 (用户连环 3 反馈)
 *
 * 用户原话:
 *  - "导出规格默认选项和短剧初始选择的参数不一致" → 默认勾选跟 series.aspect_ratio 走
 *  - "为什么我只能导出 zip 才能跳转到文件夹" → 加"在文件夹查看成片"直连, 不绑 zip
 *  - "更多导出位置随时都可预选, 为什么非得有合成视频才让选" → 去向 + 规格随时可预选,
 *     只有最终"执行导出"动作需要合成完成
 *
 * 布局:
 *  - 主卡片: 导出去向 3 选项 (随时预选) + 导出规格 chip (随时预选) + 主"导出成片"按钮
 *  - 合成完成后: "在文件夹中查看成片" 直连按钮
 *  - 历史版本 / 导出说明 原样保留
 */

import { useState, useMemo, useRef, useEffect } from "react";
import { Icon } from "../../../components/shared/Icon";
import { toast } from "sonner";
import { showErrorToast } from "../../../lib/errorTranslate";
import { apiPost, apiDelete } from "../../../lib/api";
import { PromptDialog } from "../../../components/ui/prompt-dialog";
import { EXPORT_PRESETS, groupedExportPresets } from "../../../lib/exportPresets";
import { useConfirm } from "../../../components/ui/ConfirmModal";
import type { ExportStage, ExportTarget, MultiFormatResult, ExportProgress } from "../../../hooks/useExport";
import { Button } from "../../../components/ui/button";
import { formatRelativeTime } from "../../../lib/format";

/** 2026-05-25: folderPath localStorage 持久化 — 防 ComposePage remount 时丢路径 */
// 2026-05-28 audit P2: 统一 localStorage 命名前缀, 跟 tasksStore (video-generate.tasks.v2) 一致.
// 读时兼容老 key 防丢用户偏好.
const FOLDER_LS_KEY = (slug?: string, epId?: string) => `video-generate.compose.export-folder:${slug ?? "_"}:${epId ?? "_"}`;
const FOLDER_LS_KEY_LEGACY = (slug?: string, epId?: string) => `export-folder:${slug ?? "_"}:${epId ?? "_"}`;
// 2026-05-26 — 自动导出 opt-in 持久化. 默认 false (用户原话"先合成在界面预览、再选定路径导出").
// 老用户想保留旧"选好 Downloads → 合成 → 自动复制"工作流就勾上, 设置跟随系列.
const AUTO_EXPORT_LS_KEY = (slug?: string, epId?: string) => `video-generate.compose.export-auto:${slug ?? "_"}:${epId ?? "_"}`;
const AUTO_EXPORT_LS_KEY_LEGACY = (slug?: string, epId?: string) => `export-auto:${slug ?? "_"}:${epId ?? "_"}`;

export interface ExportPanelProps {
  /** 当前导出阶段 */
  stage: ExportStage;
  outputPath: string | null;
  /** 2026-05-25: 导出目录 (library/folder 走多规格复制时, 父目录) */
  outputDir?: string | null;
  /** 2026-05-25: 实际复制的文件名列表 (用户勾选规格各一个 + final.mp4 兜底) */
  files?: string[];
  /** 2026-05-25: 后端返的非致命警告 (某规格生成失败 / 文件大小不一致等) */
  warnings?: string[];
  target: ExportTarget | null;
  error: string | null;
  /** UP-6 (2026-07-22): 后端错误 code (如 "FinalNotReady"), 用于识别"只有预览片"场景弹引导弹窗 */
  errorCode?: string | null;
  multiFormatResults?: MultiFormatResult[] | null;
  /** 合成是否已完成 (混合: React state OR 后端有 full/rough 版本; 用于决定主导出按钮是否渲染) */
  composeDone: boolean;
  /**
   * UP-6 (2026-07-22 词表统一): composeDone 把"预览片"(rough) 也算完成 (解锁预览播放器等 UI),
   * 但预览片不能导出——只有"成片"(full)或"占位样片"(quick_local_preview) 才是可导出产物。
   * 点导出时若为 false, 弹人话引导弹窗 + 一键直达"合成成片", 不再直接放行到后端 (后端也有
   * 同款人话兜底, 这里是更快更准的前端拦截)。
   */
  hasExportableFinal: boolean;
  /**
   * 2026-05-25: useCompose 内部 stage==="done" 实时跃迁信号 (不混历史 versions).
   * 自动导出 useEffect 只看这个 — 每次新合成结束 false→true 跃迁触发, 不被历史 versions 卡死.
   */
  composeStateDone: boolean;
  /** 合成是否进行中 */
  composing: boolean;
  /** 已就绪镜头数 / 总镜头数 — 主卡片进度态显示 */
  readyCount: number;
  totalCount: number;
  /**
   * 2026-07-10 P2-9 — 本次成片里含"占位镜"(灰屏/假画面顶替真实视频) 的数量.
   * >0 时导出面板常驻黄条提示 + 导出前二次确认, 避免占位灰屏被当正式成片交付出去.
   */
  placeholderShotCount?: number;
  /** 未就绪原因 (引导文案) */
  blockReason: string | null;
  /** 历史合成版本 */
  composeVersions: Array<{ mode: string; url: string; filename: string; size_bytes: number; created_at?: string }>;
  /** 2026-05-25: 导出已运行时间 (ms) — 显示给用户看 */
  elapsedMs?: number;
  /** 2026-05-29 P0-6: 多规格导出进度 (percent + 当前规格 + ETA) */
  progress?: ExportProgress | null;
  /** 2026-05-25: 中断导出 (AbortController) */
  onAbort?: () => void;
  /** 2026-05-25: 刷新 compose 版本列表 (历史版本删除后调) */
  onRefreshVersions?: () => void | Promise<void>;
  /** 触发导出 */
  onExport: (target: ExportTarget, folderPath?: string, formats?: string[]) => void;
  /** 引导跳到首个未就绪镜头 */
  onScrollToFirstMissing?: () => void;
  /** 没有未就绪时引导用户点击合成 */
  onCompose?: () => void;
  /** 显示完整导出说明 */
  onShowGuide?: () => void;
  /** 2026-05-22 P0-F: 系列画面比例 (9:16 / 16:9 / 1:1) — 决定导出规格默认勾选 */
  seriesAspectRatio?: string;
  /** 2026-05-22 P0-H: 系列 slug + 集 id — "在文件夹查看成片" reveal 端点用 */
  slug?: string;
  epId?: string;
}

/** 平台分组 → Icon 名 (Icon.tsx 已有的合法名). 铁律 #11: chip 图标 + 文字, 非 icon-only. */
const GROUP_ICON: Record<string, string> = {
  抖音系: "video",
  YouTube海外: "globe",
  中长视频: "monitor",
  社交: "users",
  预览: "eye",
};

interface FormatOption {
  id: string;
  label: string;
  desc: string;
  aspectRatio: string;
}

/** 2026-05-29 P0-4: 规格 chip 按 group_label 分组渲染 (10 个 chip 一行塞不下).
 *  每组一个小标题 + 一行 chip. 组顺序走 exportPresets.ts 的 EXPORT_GROUP_ORDER. */
const FORMAT_GROUPS: Array<{ group: string; icon: string; options: FormatOption[] }> =
  groupedExportPresets().map(({ group, presets }) => ({
    group,
    icon: GROUP_ICON[group] ?? "grid",
    options: presets.map((p) => ({
      id: p.id,
      label: p.label,
      desc: `${p.description} · ${p.platform_hint}`,
      aspectRatio: p.aspect_ratio,
    })),
  }));

/**
 * 2026-05-22 P0-F: 根据系列画面比例选默认导出规格.
 * 竖版剧 (9:16) → "抖音 / 视频号" / 横版剧 (16:9) → "B 站 / YouTube" / 方形 (1:1) → "朋友圈 / Instagram".
 * 找不到对应 mp4 预设兜底横版 (历史默认).
 * 2026-05-28 深度打磨 #4 label 文案改成主流平台名而非抽象规格.
 */
function defaultFormatForAspect(aspect?: string): string {
  const hit = EXPORT_PRESETS.find((p) => p.aspect_ratio === aspect && p.format === "mp4");
  return hit?.id ?? "1080p_16x9";
}

/** 导出去向选项 — 随时可预选 */
const TARGET_OPTIONS: Array<{ id: ExportTarget; label: string; icon: string; hint: string }> = [
  { id: "zip", label: "下载 zip 包", icon: "download", hint: "打包成片 + 字幕 + 元数据" },
  { id: "library", label: "本地资料库", icon: "archive", hint: "存入工作台资料库统一管理" },
  { id: "folder", label: "自定义文件夹", icon: "folder", hint: "导出到本机指定目录" },
];

export function ExportPanel({
  stage,
  outputPath,
  outputDir,
  files,
  warnings,
  target,
  error,
  errorCode,
  multiFormatResults,
  composeDone,
  hasExportableFinal,
  composeStateDone,
  composing,
  readyCount,
  totalCount,
  placeholderShotCount = 0,
  blockReason,
  composeVersions,
  elapsedMs,
  progress,
  onAbort,
  onRefreshVersions,
  onExport,
  onScrollToFirstMissing,
  onCompose,
  onShowGuide,
  seriesAspectRatio,
  slug,
  epId,
}: ExportPanelProps) {
  const confirm = useConfirm();
  // 2026-05-25: 用户反复反馈"没看到导出的视频" — 加全局 toast, 不依赖用户看 ExportPanel 内部区块.
  // 导出完成立刻 toast.success 显示文件数 + 目录, 失败立刻 toast.error.
  // 用 ref 跟踪上一次 stage 防止 useEffect 重复触发.
  const lastReportedStageRef = useRef<ExportStage>("idle");
  useEffect(() => {
    if (lastReportedStageRef.current === stage) return;
    lastReportedStageRef.current = stage;
    if (stage === "done") {
      const fileCount = files?.length ?? 0;
      const folder = outputDir || (outputPath ? outputPath.replace(/[/\\][^/\\]*$/, "") : "");
      toast.success(`已导出 ${fileCount} 个文件`, {
        description: folder ? `存到: ${folder}` : undefined,
        duration: 10000,
      });
    } else if (stage === "error" && error) {
      // UP-6 (2026-07-22): "只有预览片 / 还没合成过成片" 这类失败不再是干巴巴一条技术错误 toast——
      // 弹带"去合成成片"按钮的引导 toast (复用 sonner action 按钮体系, 跟 errorTranslate.ts
      // showErrorToast 的"打开设置"按钮同一套做法), 点了直接触发 onCompose (发起正式合成)。
      // 正常情况下 handlePrimaryExport 点击时已经拦在前端 (见下方 hasExportableFinal 分支),
      // 这里是兜底: 直连 API / composeVersions 短暂不同步等场景下, 后端仍会带同款人话 + code 回来。
      if (errorCode === "FinalNotReady") {
        toast.error(error, {
          duration: 12000,
          ...(onCompose ? { action: { label: "去合成成片", onClick: () => onCompose() } } : {}),
        });
      } else {
        toast.error("导出失败", {
          description: error,
          duration: 12000,
        });
      }
    }
  }, [stage, files, outputDir, outputPath, error, errorCode, onCompose]);

  // P0-F: 默认勾选跟系列画面比例走
  const defaultFormat = useMemo(() => defaultFormatForAspect(seriesAspectRatio), [seriesAspectRatio]);
  const [selectedFormats, setSelectedFormats] = useState<Set<string>>(() => new Set([defaultFormat]));
  // series 异步加载完成后 seriesAspectRatio 才到位; 用户没手动改过规格时同步默认勾选
  const userTouchedFormatRef = useRef(false);
  useEffect(() => {
    if (!userTouchedFormatRef.current) {
      setSelectedFormats(new Set([defaultFormat]));
    }
  }, [defaultFormat]);

  // P0-I: 导出去向随时可预选 (不锁 composeDone)
  // 2026-05-25: folderPath localStorage 持久化 — 防 ComposePage remount 时丢路径
  const [exportTarget, setExportTarget] = useState<ExportTarget>("zip");
  const [folderPath, setFolderPath] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    try { return localStorage.getItem(FOLDER_LS_KEY(slug, epId)) ?? localStorage.getItem(FOLDER_LS_KEY_LEGACY(slug, epId)) ?? ""; } catch { return ""; }
  });
  // 2026-05-26 — 合成完成自动导出 (opt-in). 默认 false: 用户先看 player 预览满意了再点导出.
  const [autoExportEnabled, setAutoExportEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      const v = localStorage.getItem(AUTO_EXPORT_LS_KEY(slug, epId)) ?? localStorage.getItem(AUTO_EXPORT_LS_KEY_LEGACY(slug, epId));
      return v === "1";
    } catch { return false; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (autoExportEnabled) localStorage.setItem(AUTO_EXPORT_LS_KEY(slug, epId), "1");
      else localStorage.removeItem(AUTO_EXPORT_LS_KEY(slug, epId));
      // 清理老 key (audit P2 统一前缀)
      localStorage.removeItem(AUTO_EXPORT_LS_KEY_LEGACY(slug, epId));
    } catch { /* ignore */ }
  }, [autoExportEnabled, slug, epId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const v = localStorage.getItem(AUTO_EXPORT_LS_KEY(slug, epId)) ?? localStorage.getItem(AUTO_EXPORT_LS_KEY_LEGACY(slug, epId));
      setAutoExportEnabled(v === "1");
    } catch { /* ignore */ }
  }, [slug, epId]);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [revealing, setRevealing] = useState(false);

  // P1-14: 多版本对比 — 选中的版本 filename 集合
  const [compareSelected, setCompareSelected] = useState<Set<string>>(new Set());
  const [compareOpen, setCompareOpen] = useState(false);

  // folderPath 变化时写 localStorage; 切系列/集时重新读
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (folderPath) localStorage.setItem(FOLDER_LS_KEY(slug, epId), folderPath);
      else localStorage.removeItem(FOLDER_LS_KEY(slug, epId));
      // 清理老 key (audit P2 统一前缀)
      localStorage.removeItem(FOLDER_LS_KEY_LEGACY(slug, epId));
    } catch { /* localStorage quota / privacy mode, 静默 */ }
  }, [folderPath, slug, epId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = localStorage.getItem(FOLDER_LS_KEY(slug, epId)) ?? localStorage.getItem(FOLDER_LS_KEY_LEGACY(slug, epId)) ?? "";
      setFolderPath(saved);
    } catch { /* ignore */ }
  }, [slug, epId]);

  const exporting = stage === "exporting";
  const exportDone = stage === "done";

  // 2026-05-25 重大产品修复 — 用户原话: "我选的是本机下载目录, 我选本地目录不行吗".
  //
  // 根因: 合成成片 (生成 final.mp4 在项目数据目录) 和 导出成片 (复制到 user 选的目录) 是两步,
  // 但用户的直觉是: "选了 Downloads + 点合成成片 = 视频应该在 Downloads".
  // 这是产品设计错位 — 应该自动导出, 不让用户多点一次.
  //
  // 修: 监听 composeDone 状态变化, 一旦合成完成 + folder target 已选 + folderPath 已设,
  // 自动触发 onExport. 用户体验: 选好 Downloads → 点合成 → 等几分钟 → 视频自动出现在 Downloads.
  // 自动导出: folder 和 library 都触发(zip 用户得显式点, 因为下载浏览器要 user gesture).
  // 2026-05-25 修: 用户原话"导出的文件根本不是最新的, 你好好用点心呗".
  //   原 bug — 监听 composeDone (混合: React state OR 历史 versions). 第一次合成后 composeDone=true,
  //   之后再合成 ref 永远捕捉不到 false→true 跃迁 → 第二次起永不自动导出 → 用户拿到旧文件.
  //   修: 用 composeStateDone (useCompose 实时 stage==="done"), 不掺历史 versions.
  //   每次新合成结束都跃迁触发. + stage 条件 idle→exporting 才阻止 (允许 done/error 后重导).
  // 2026-05-28 P0-2 修: onExport / selectedFormats 收 ref, useEffect deps 只剩跃迁信号 +
  // 配置开关. 之前每次 caller re-render 新建 onExport 函数引用 → effect 误触发多次导出.
  const lastComposeStateRef = useRef(false);
  const onExportRef = useRef(onExport);
  useEffect(() => { onExportRef.current = onExport; }, [onExport]);
  const selectedFormatsRef = useRef(selectedFormats);
  useEffect(() => { selectedFormatsRef.current = selectedFormats; }, [selectedFormats]);
  useEffect(() => {
    const wasNotDone = !lastComposeStateRef.current;
    const justBecameDone = composeStateDone && wasNotDone;
    lastComposeStateRef.current = composeStateDone;
    if (!justBecameDone || stage === "exporting") return;
    if (!autoExportEnabled) return;
    if (exportTarget === "folder" && folderPath) {
      onExportRef.current(exportTarget, folderPath, Array.from(selectedFormatsRef.current));
    } else if (exportTarget === "library") {
      onExportRef.current(exportTarget, undefined, Array.from(selectedFormatsRef.current));
    }
  }, [composeStateDone, exportTarget, folderPath, stage, autoExportEnabled]);

  function handleToggleFormat(formatId: string) {
    userTouchedFormatRef.current = true;
    setSelectedFormats((prev) => {
      // 不允许取消最后一个格式
      if (prev.has(formatId) && prev.size <= 1) return prev;
      const next = new Set(prev);
      if (next.has(formatId)) next.delete(formatId);
      else next.add(formatId);
      return next;
    });
  }

  /**
   * 选导出去向 — 随时可点.
   * 2026-05-25: folder 目标改 优先调系统原生文件夹选择器, 失败 fallback PromptDialog.
   * 2026-05-25 续修 (用户反馈"如何修改导出文件夹? 这你都想不到?"):
   *   原 `!folderPath` 判断只首次弹 picker, 用户选过后想换没法换 → dead-end.
   *   改: 已选 folder 再点 radio 也弹 picker (再选一次 = 更换路径).
   *   同时右侧加 "更改..." 显眼链接, 不只靠隐式 "再点 radio".
   */
  async function handlePickTarget(t: ExportTarget) {
    const isReclickFolder = t === "folder" && exportTarget === "folder";
    setExportTarget(t);
    if (t === "folder" && (!folderPath || isReclickFolder)) {
      await openNativePickerOrFallback();
    }
  }

  /** 调后端原生选择器, 取消时静默, 失败时降级到 PromptDialog.
   *  2026-05-28 P0-3: 返 picked path (string | null), 让 caller 选完立刻导出, 不再 dead-end. */
  async function openNativePickerOrFallback(): Promise<string | null> {
    const loadingId = toast.loading("正在打开系统文件夹选择器…", {
      description: "如长时间无反应, 看看任务栏是否有 PowerShell / 选择器窗口被挡",
    });
    try {
      const r = await apiPost<{ ok: boolean; path?: string; canceled?: boolean }>(
        "/api/utils/pick-folder",
        { initialDir: folderPath || undefined },
      );
      toast.dismiss(loadingId);
      if (r.ok && r.path) {
        setFolderPath(r.path);
        toast.success(`已记住导出文件夹`, {
          description: r.path,
          duration: 8000,
        });
        return r.path;
      }
      if (r.ok && r.canceled) {
        toast.info("已取消选择", { duration: 3000 });
        return null;
      }
      setFolderDialogOpen(true);
      return null;
    } catch (err) {
      toast.dismiss(loadingId);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[pick-folder] native picker 不可用, 降级到手输:", msg);
      toast.warning("系统选择器不可用, 改用手输", { description: msg, duration: 6000 });
      setFolderDialogOpen(true);
      return null;
    }
  }

  /** 执行导出 — 用预选的去向 + 规格. 这一步才需要 composeDone.
   *  2026-05-28 P0-3 修: folder 未选路径时 picker 选完直接导出 (不再 dead-end). */
  async function handlePrimaryExport() {
    if (!composeDone) {
      toast.info("合成完成后即可一键导出（导出去向和规格已经记住）");
      return;
    }
    // UP-6 (2026-07-22 词表统一) — composeDone 上面把"预览片"(粗剪, rough) 也算完成, 但预览片
    // 不能导出, 只有"成片"(full)/"占位样片"(quick_local_preview) 才行. 之前这里没拦, 用户跑完
    // 「粗剪预览」直接点「导出成片」会一路捅到后端裸技术错误"final.mp4 不存在,请先运行 compose".
    // 改: 点导出时先判断, 只有预览片就弹人话引导 (复用本文件已有的 useConfirm 弹窗体系, 跟下面
    // "占位镜仍要导出吗" 同一套) + 一键直达"合成成片" (onCompose, 由 ComposePage 接的是发起正式
    // 合成的 handleCompose), 不再放行到网络请求。
    if (!hasExportableFinal) {
      const goCompose = await confirm({
        title: "预览片不能导出",
        description: "你现在只有粗剪预览片，用于免费查看节奏，不能直接导出。要导出可交付的成片，请先点「合成成片」。",
        variant: "warning",
        confirmLabel: "去合成成片",
      });
      if (goCompose) onCompose?.();
      return;
    }
    // 2026-07-10 P2-9 — 成片含占位镜(灰屏/假画面)时, 导出前二次确认, 避免占位灰屏被当正式成片交付出去.
    if (placeholderShotCount > 0) {
      const ok = await confirm({
        title: `成片含 ${placeholderShotCount} 个占位镜头，仍要导出？`,
        description:
          `本次成片里有 ${placeholderShotCount} 个镜头是灰屏 / 假画面占位（真实视频缺失或未生成），不是最终画面。\n` +
          "导出后这些镜头仍是占位画面。建议先补齐这些镜头的真实视频再重新合成、导出。",
        variant: "warning",
        confirmLabel: "仍要导出占位成片",
        cancelLabel: "先去补齐",
      });
      if (!ok) return;
    }
    if (exportTarget === "folder" && !folderPath) {
      const picked = await openNativePickerOrFallback();
      if (!picked) return; // 用户取消或失败, 静默
      onExportRef.current(exportTarget, picked, Array.from(selectedFormats));
      return;
    }
    onExportRef.current(
      exportTarget,
      exportTarget === "folder" ? folderPath : undefined,
      Array.from(selectedFormats),
    );
  }

  /** P0-H: 直接在系统文件管理器打开成片目录 — 不走 zip 导出 */
  async function handleRevealFolder() {
    if (!slug || !epId) {
      toast.error("缺少剧集信息，无法定位成片目录");
      return;
    }
    setRevealing(true);
    try {
      await apiPost(
        `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/compose/reveal`,
        {},
      );
      toast.success("已在文件管理器打开成片目录");
    } catch (err: unknown) {
      // 2026-05-28 audit P2: 走 showErrorToast 统一错误翻译
      showErrorToast(err, "打开文件夹失败");
    } finally {
      setRevealing(false);
    }
  }

  /**
   * 导出成功后打开输出所在文件夹.
   * 2026-05-25: 白名单挡时 (用户自定义 folder_path 在系统任意位置) 优雅降级:
   * 自动把路径复制到剪贴板, toast 提示用户手动打开.
   * 优先用后端返回的 output_dir, 兜底 outputPath dirname.
   */
  function openOutputFolder() {
    const folder = outputDir || (outputPath ? outputPath.replace(/[/\\][^/\\]*$/, "") : "");
    if (!folder) return;
    apiPost("/api/utils/open-folder", { path: folder }).catch(async (err) => {
      // 后端白名单挡 (user-supplied folder 在 claw-shared / outputs / data / projects / assets 之外):
      // 不空 toast.error, 而是把路径写剪贴板 + 提示用户.
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await navigator.clipboard?.writeText(folder);
        toast.warning(`无法直接打开文件夹 (${msg})`, {
          description: `路径已复制到剪贴板: ${folder}`,
          duration: 8000,
        });
      } catch {
        toast.warning(`无法直接打开文件夹 (${msg})`, {
          description: `请手动到: ${folder}`,
          duration: 8000,
        });
      }
    });
  }

  const targetLabel = TARGET_OPTIONS.find((t) => t.id === exportTarget)?.label ?? "导出";

  // 主导出按钮文案 — 2026-05-26 简化 (用户原话"按钮重新排布", 三栏 340px 右栏内 flex:2 主按钮 ~200px,
  // 原"导出成片 → 下载 zip 包" 8+ 字会折行, 简化成 4-6 字; exporting/done 状态也短化).
  const primaryLabel = (() => {
    if (exporting) {
      // 2026-05-29 P0-6: 有多规格进度时显 percent, 否则退回耗时秒数 (单规格/zip 无逐规格进度)
      if (progress && progress.total > 0) {
        return `导出中… ${progress.percent}%`;
      }
      const sec = elapsedMs ? Math.floor(elapsedMs / 1000) : 0;
      return `导出中… ${sec}s`;
    }
    const short =
      exportTarget === "zip" ? "下载 zip"
      : exportTarget === "library" ? "存入资料库"
      : "导出到文件夹";
    if (exportDone) return `重新${short}`;
    return short;
  })();

  /** 智能字节单位: <1KB→B / <1MB→KB / >=1MB→MB */
  function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  /** 2026-05-29 P0-6: ETA 秒 → 人话 (如 "约 34 秒" / "约 1 分 20 秒") */
  function formatEta(sec: number): string {
    if (sec < 60) return `约 ${sec} 秒`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `约 ${m} 分 ${s} 秒` : `约 ${m} 分`;
  }

  return (
    <div
      style={{
        borderLeft: "1px solid var(--ink-100)",
        background: "var(--surface-canvas, #fafafa)",
        padding: "16px 16px 20px",
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* 区域标题 */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
          color: "var(--ink-500)",
          textTransform: "uppercase",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Icon name="download" size={13} />
        导出成片
      </div>

      {/* 2026-07-10 P2-9 (铁律 #5 状态精确) — 占位镜常驻黄条.
          本次成片含灰屏/假画面占位镜时一直显示, 导出前提醒这不是完整成片 (与导出确认框互补, 常驻不靠点开). */}
      {composeDone && placeholderShotCount > 0 && (
        <div
          style={{
            padding: "10px 12px",
            background: "var(--warn-bg, #fef3c7)",
            border: "1px solid var(--warn, #f59e0b)",
            borderRadius: 8,
            fontSize: 11.5,
            color: "var(--warn, #92400e)",
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            lineHeight: 1.5,
          }}
        >
          <Icon name="warning" size={14} style={{ color: "var(--warn, #b45309)", flexShrink: 0, marginTop: 1 }} />
          <span>
            <strong>本成片含 {placeholderShotCount} 个占位镜头</strong>（灰屏 / 假画面顶替真实视频）。
            导出前建议先补齐这些镜头的真实视频再重新合成，否则导出的成片里这些镜头仍是占位画面。
          </span>
        </div>
      )}

      {/* 2026-05-26 — 自动导出 opt-in checkbox.
          默认关 — 用户原话"先合成在界面预览、再选定路径导出": 先在 player 看效果, 满意了再手动点导出.
          勾上 → 老行为 (合成完立刻复制到 folder/library), 适合"选好 Downloads 不再多点一次"流派. */}
      {((exportTarget === "folder" && folderPath) || exportTarget === "library") && (
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "8px 10px",
            background: autoExportEnabled ? "var(--ok-bg, rgba(16,185,129,0.08))" : "var(--ink-50)",
            border: `1px solid ${autoExportEnabled ? "var(--ok, #10b981)" : "var(--ink-150)"}`,
            borderRadius: 8,
            fontSize: 11.5,
            color: autoExportEnabled ? "var(--ok, #047857)" : "var(--ink-700)",
            cursor: "pointer",
            lineHeight: 1.5,
          }}
        >
          <input
            type="checkbox"
            checked={autoExportEnabled}
            onChange={(e) => setAutoExportEnabled(e.target.checked)}
            style={{ marginTop: 2, accentColor: "var(--ok, #10b981)" }}
          />
          <span style={{ flex: 1 }}>
            <strong>合成完成后自动导出到{exportTarget === "library" ? "本地资料库" : "此目录"}</strong>
            {!autoExportEnabled && (
              <span style={{ color: "var(--ink-500)", marginLeft: 6 }}>
                — 默认关。勾上后合成完立刻复制,不勾就先看预览再手动点导出。
              </span>
            )}
            {autoExportEnabled && exportTarget === "folder" && folderPath && (
              <>
                <br />
                <code style={{ fontSize: 10.5, fontFamily: "ui-monospace, Consolas, monospace", color: "var(--ink-700)", wordBreak: "break-all" }}>
                  {folderPath}
                </code>
              </>
            )}
          </span>
        </label>
      )}

      {/* === 引导卡片 (未就绪时显示) === */}
      {!composeDone && !composing && blockReason && (
        <div
          style={{
            padding: "10px 12px",
            background: "var(--surface-card, #fff)",
            border: "1px solid var(--ink-150, #e7e5e2)",
            borderLeft: "3px solid var(--warn, #f59e0b)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--ink-700)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <Icon name="info" size={14} className="text-[var(--warn, #f59e0b)] mt-[1px]" />
            <span style={{ lineHeight: 1.5 }}>{blockReason}</span>
          </div>
          {/* 2026-05-25 合成 UI 整改 #1-3: 引导卡只显 blockReason 文案 + "去修首个未就绪"二级 CTA.
              主"合成成片"按钮唯一收敛到页面右上角, 不重复. blockReason 文案已指向右上角. */}
          {totalCount > 0 && readyCount < totalCount && onScrollToFirstMissing && (
            <Button
              variant="secondary"
              size="sm"
              iconLeft="arrow-down"
              style={{ alignSelf: "flex-start" }}
              onClick={onScrollToFirstMissing}
            >
              去修复首个未就绪镜头
            </Button>
          )}
        </div>
      )}

      {/* === 主卡片 — 2026-05-26 重设计紧凑横排 ===
          用户反复反馈"右侧一列按钮, 页面拉太长". 改 column → row inline 紧凑:
          顶部一行: [主导出按钮 大] + [⋯ 更多] 折叠次要
          中部一行: [去向 chip x3 横排紧凑] [规格 chip x4 横排]
          原 column 设计 ~400px 高 → 现 row 设计 ~120px 高, 屏幕剩余空间留给预览. */}
      <div
        style={{
          padding: 14,
          background: "var(--surface-card, #fff)",
          border: composeDone ? "1px solid var(--brand-200, #b8d6ff)" : "1px solid var(--ink-150)",
          borderRadius: 10,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          boxShadow: composeDone ? "0 1px 3px rgba(47,134,255,0.10)" : "none",
        }}
      >
        {/* 2026-05-26 — 主导出按钮挪到主卡片顶部 (用户原话"按钮离得太远", 之前主按钮在底部, 用户得滚动找).
            主按钮 + reveal 一行横排, 立刻可见可点, 不需要扫到底部. */}
        {composeDone && (
          <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
            <button
              type="button"
              onClick={handlePrimaryExport}
              disabled={exporting}
              style={{
                flex: 2,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: "12px 16px",
                borderRadius: 8,
                border: "none",
                background: exporting ? "var(--ink-200)" : "var(--brand-500, #2f86ff)",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                cursor: exporting ? "default" : "pointer",
                transition: "background 0.15s",
              }}
              title={`导出到「${targetLabel}」`}
            >
              <Icon name={exporting ? "refresh" : "download"} size={15} className={exporting ? "animate-spin" : ""} />
              {primaryLabel}
            </button>
            {!exporting && (
              <Button
                variant="secondary"
                size="md"
                iconLeft={revealing ? "refresh" : "folder"}
                disabled={revealing}
                onClick={handleRevealFolder}
                title="在文件管理器中打开成片所在目录"
                style={{ flex: 1 }}
              >
                {revealing ? "打开中…" : "查看文件"}
              </Button>
            )}
            {exporting && onAbort && (
              <button
                type="button"
                onClick={onAbort}
                title="中断导出 (后端 ffmpeg 也会接到 abort 信号停止)"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "10px 16px",
                  borderRadius: 8,
                  border: "1.5px solid #dc2626",
                  background: "#fef2f2",
                  color: "#b91c1c",
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: "pointer",
                  transition: "all 0.15s",
                  flex: 1,
                  justifyContent: "center",
                }}
              >
                <Icon name="close" size={14} />
                取消导出{elapsedMs != null && elapsedMs > 0 ? `(已 ${Math.floor(elapsedMs / 1000)}s)` : ""}
              </button>
            )}
          </div>
        )}

        {/* 2026-05-29 P0-6 — 多规格导出进度条 (percent + 当前规格 + ETA).
            之前导出中只显"导出中… 12s", 用户不知道总共几个规格 / 进度多少 / 还剩多久.
            后端 multiFormatExporter 每完成一个 format 推 export.format_progress, useExport 订
            /api/v2/events 收, 这里画进度条. 单规格 / zip 无逐规格进度时 progress 为 null, 不显. */}
        {exporting && progress && progress.total > 0 && (
          <div
            style={{
              padding: "10px 12px",
              background: "var(--brand-50, #eaf3ff)",
              border: "1px solid var(--brand-200, #b8d6ff)",
              borderRadius: 8,
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11.5 }}>
              <span style={{ fontWeight: 600, color: "var(--brand-700)" }}>
                导出中 {progress.completed}/{progress.total} 个规格
              </span>
              <span style={{ fontFamily: "ui-monospace, Consolas, monospace", color: "var(--ink-600)", fontWeight: 600 }}>
                {progress.percent}%
              </span>
            </div>
            {/* 进度条轨 */}
            <div style={{ height: 6, borderRadius: 999, background: "var(--ink-100)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, Math.max(0, progress.percent))}%`,
                  background: "var(--brand-500, #2f86ff)",
                  borderRadius: 999,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 10.5, color: "var(--ink-500)" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "62%" }} title={progress.currentLabel}>
                {progress.completed === 0 ? "准备导出…" : `刚完成: ${progress.currentLabel}`}
              </span>
              {progress.etaSec !== null && (
                <span style={{ flexShrink: 0 }}>预计还需 {formatEta(progress.etaSec)}</span>
              )}
            </div>
          </div>
        )}

        {/* 导出去向 + 规格 紧凑横排 — 一行展示, 不再 column 大卡片 */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          {/* 去向: chip 横排 (radio) */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10.5, color: "var(--ink-500)", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Icon name="folder" size={10} /> 去向:
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              {TARGET_OPTIONS.map((opt) => {
                const active = exportTarget === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handlePickTarget(opt.id)}
                    title={`${opt.label} — ${opt.hint}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "4px 9px",
                      borderRadius: 6,
                      border: `1px solid ${active ? "var(--brand-500)" : "var(--ink-200)"}`,
                      background: active ? "var(--brand-50)" : "var(--surface-card)",
                      color: active ? "var(--brand-700)" : "var(--ink-600)",
                      cursor: "pointer",
                      transition: "all 0.15s",
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    <Icon name={opt.icon} size={11} />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {/* 折叠的去向详情 — 仅 folder 选中时显示路径 + "更改" */}
        {exportTarget === "folder" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", background: "var(--ink-50)", borderRadius: 6, fontSize: 11 }}>
            <Icon name="folder" size={11} style={{ color: "var(--ink-500)" }} />
            <code style={{ flex: 1, fontFamily: "ui-monospace, Consolas, monospace", color: folderPath ? "var(--ink-700)" : "var(--ink-400)", wordBreak: "break-all" }}>
              {folderPath || "(未选目录, 点右侧选择)"}
            </code>
            <button
              type="button"
              onClick={() => handlePickTarget("folder")}
              style={{
                padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
                color: "var(--brand-700)", background: "rgba(47,134,255,0.10)",
                cursor: "pointer", border: "none",
              }}
            >
              {folderPath ? "更改…" : "选择…"}
            </button>
          </div>
        )}

        {/* 导出规格 — 2026-05-29 P0-4: 10 个预设按平台分组渲染 (抖音系 / YouTube海外 / 中长视频 / 社交 / 预览).
            每组一个小标题 + 一行 chip, 不再一行横排塞 10 个. chip 仍图标(勾选框)+ 文字 (铁律 #11). */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ fontSize: 10.5, color: "var(--ink-500)", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Icon name="grid" size={10} /> 导出规格 <span style={{ color: "var(--ink-400)", fontWeight: 400 }}>(可多选, 按平台分组)</span>
          </span>
          {FORMAT_GROUPS.map(({ group, icon, options }) => (
            <div key={group} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {/* 分组小标题 */}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--ink-500)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  letterSpacing: "0.02em",
                }}
              >
                <Icon name={icon} size={11} />
                {group}
              </span>
              {/* 该组 chip 行 */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {options.map((opt) => {
                  const checked = selectedFormats.has(opt.id);
                  const matchesSeries = !!seriesAspectRatio && opt.aspectRatio === seriesAspectRatio;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => handleToggleFormat(opt.id)}
                      title={matchesSeries ? `${opt.desc} · 与剧集比例一致` : opt.desc}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "4px 9px",
                        borderRadius: 6,
                        border: `1px solid ${checked ? "var(--brand-500)" : "var(--ink-200)"}`,
                        background: checked ? "var(--brand-50)" : "var(--surface-card)",
                        color: checked ? "var(--brand-700)" : "var(--ink-600)",
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: "pointer",
                        transition: "all 0.15s",
                      }}
                    >
                      <span
                        style={{
                          width: 11,
                          height: 11,
                          borderRadius: 3,
                          border: `1.5px solid ${checked ? "var(--brand-500)" : "var(--ink-300)"}`,
                          background: checked ? "var(--brand-500)" : "transparent",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {checked && <Icon name="check" size={8} className="text-white" />}
                      </span>
                      {opt.label}
                      {/* 2026-05-25 合成 UI #6: "本剧"角标统一颜色 (原选中态白底反差太强), 改 ★ 微视觉提示默认推荐 */}
                      {matchesSeries && (
                        <span
                          title="与本剧画面比例一致 (默认推荐)"
                          style={{
                            fontSize: 10,
                            color: checked ? "var(--brand-600)" : "var(--ink-400)",
                            lineHeight: 1,
                          }}
                        >
                          ★
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>


        {/* 多规格结果 — 2026-05-25: KB→MB 智能单位, 失败规格 inline 显示原因 (不只 tooltip) */}
        {multiFormatResults && multiFormatResults.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 6, borderTop: "1px solid var(--ink-100)" }}>
            <span style={{ fontSize: 10.5, color: "var(--ink-500)", fontWeight: 600 }}>多规格结果:</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {multiFormatResults.map((r) => (
                <div
                  key={r.format_id}
                  style={{
                    padding: "4px 8px",
                    borderRadius: 6,
                    fontSize: 11,
                    background: r.ok ? "var(--brand-50)" : "#fff6f5",
                    color: r.ok ? "var(--brand-700)" : "var(--err, #dc2626)",
                    border: `1px solid ${r.ok ? "var(--brand-200, #b8d6ff)" : "#f5c7c1"}`,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Icon name={r.ok ? "check" : "close"} size={10} />
                    <span style={{ fontWeight: 600 }}>{r.format_id}</span>
                    {r.ok && (
                      <span style={{ color: "var(--ink-500)", fontSize: 10.5 }}>
                        {r.width}×{r.height} · {humanSize(r.size_bytes)}
                      </span>
                    )}
                  </div>
                  {!r.ok && r.error && (
                    <div style={{ fontSize: 10.5, color: "var(--err, #b91c1c)", paddingLeft: 16, lineHeight: 1.4 }}>
                      {r.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* === 导出成功路径 === */}
      {/* 2026-05-25: 用户原话"没看到导出的视频" — 原 UI 只显单个 outputPath, 用户勾选多规格时实际复制了多份,
          但前端没列出. 改成列 N 个文件名清单 + 显眼路径 + 打开文件夹按钮. */}
      {exportDone && outputPath && (
        <div
          style={{
            padding: "10px 12px",
            background: "var(--brand-50, #eaf3ff)",
            border: "1px solid var(--brand-200, #b8d6ff)",
            borderRadius: 8,
            fontSize: 11,
            color: "var(--brand-700)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <Icon name="check" size={12} />
            <span style={{ fontWeight: 600 }}>
              {files && files.length > 0 ? `已导出 ${files.length} 个文件` : "导出成功"}
            </span>
          </div>
          {/* 输出目录 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ fontSize: 10, color: "var(--ink-500)", fontWeight: 600 }}>输出目录</span>
            <code
              style={{
                fontSize: 10.5,
                fontFamily: "ui-monospace, Consolas, monospace",
                color: "var(--ink-700)",
                wordBreak: "break-all",
                lineHeight: 1.4,
              }}
            >
              {outputDir || (outputPath ? outputPath.replace(/[/\\][^/\\]*$/, "") : "")}
            </code>
          </div>
          {/* 文件清单 — 列出按勾选规格复制的 N 个文件 */}
          {files && files.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 10, color: "var(--ink-500)", fontWeight: 600 }}>
                文件清单 ({files.length})
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {files.map((f) => (
                  <div
                    key={f}
                    style={{
                      fontSize: 10.5,
                      fontFamily: "ui-monospace, Consolas, monospace",
                      color: "var(--ink-700)",
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      paddingLeft: 6,
                    }}
                  >
                    <Icon name="check" size={9} className="text-[var(--brand-500)]" />
                    {f}
                  </div>
                ))}
              </div>
            </div>
          )}
          <Button
            variant="primary"
            size="sm"
            iconLeft="folder"
            style={{ alignSelf: "flex-start" }}
            onClick={openOutputFolder}
          >
            打开输出文件夹
          </Button>
        </div>
      )}

      {/* 2026-05-25 audit P0: warnings 后端返了但 UI 之前没渲染 — 加 amber 警告区, 列出 N 条 */}
      {exportDone && warnings && warnings.length > 0 && (
        <div
          style={{
            padding: "8px 10px",
            background: "var(--warn-bg, #fef3c7)",
            border: "1px solid var(--warn, #f59e0b)",
            borderRadius: 8,
            fontSize: 11,
            color: "var(--warn, #92400e)",
            display: "flex",
            flexDirection: "column",
            gap: 5,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontWeight: 600 }}>
            <Icon name="warning" size={12} />
            <span>{warnings.length} 条提示</span>
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 10.5, lineHeight: 1.5 }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {/* === 导出失败 === 2026-05-25 audit P0: 加"重试"按钮 + 显眼标题 */}
      {stage === "error" && error && (
        <div
          style={{
            padding: "10px 12px",
            background: "#fff6f5",
            border: "1px solid #f5c7c1",
            borderRadius: 8,
            fontSize: 11.5,
            color: "var(--err, #dc2626)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
            <Icon name="close" size={13} />
            <span>导出失败</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--ink-700)", lineHeight: 1.5, wordBreak: "break-word" }}>
            {error}
          </div>
          <Button
            variant="primary"
            size="sm"
            iconLeft="refresh"
            style={{ alignSelf: "flex-start" }}
            onClick={() => {
              if (exportTarget === "folder" && !folderPath) {
                toast.warning("请先选择自定义文件夹");
                return;
              }
              onExport(
                exportTarget,
                exportTarget === "folder" ? folderPath : undefined,
                Array.from(selectedFormats),
              );
            }}
          >
            重试导出
          </Button>
        </div>
      )}

      {/* === 历史版本 === */}
      {composeVersions.length > 0 && (
        <div
          style={{
            background: "var(--surface-card, #fff)",
            border: "1px solid var(--ink-150)",
            borderRadius: 10,
            padding: "10px 12px",
          }}
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: "0.08em",
              color: "var(--ink-500)",
              textTransform: "uppercase",
              marginBottom: 6,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <Icon name="history" size={11} />
            历史版本 · {composeVersions.length}
            {/* P1-14: 对比按钮 — 选中 2 个版本后激活 */}
            {compareSelected.size >= 2 && (
              <button
                type="button"
                onClick={() => setCompareOpen(true)}
                style={{
                  marginLeft: "auto",
                  padding: "2px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--brand-500)",
                  background: "var(--brand-50)",
                  color: "var(--brand-700)",
                  fontSize: 10.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
                title="并排对比选中的两个版本"
              >
                <Icon name="grid" size={10} />
                对比 ({compareSelected.size})
              </button>
            )}
          </div>
          {/* 2026-05-25 audit P0: 历史版本文件名之前 textOverflow:ellipsis + nowrap 看不到完整名,
              改 word-break wrap; 加"预览"按钮 (新 tab 直接看) + "下载"按钮 (强制下载) 区分 */}
          {composeVersions.slice(0, 6).map((v, i) => {
            const modeLabel: Record<string, string> = {
              rough: "粗剪",
              full: "精剪",
              quick_local_preview: "样片",
            };
            const isCompareChecked = compareSelected.has(v.filename);
            return (
              <div
                key={i}
                style={{
                  padding: "6px 0",
                  fontSize: 11,
                  color: "var(--ink-700)",
                  borderBottom: i < Math.min(composeVersions.length, 6) - 1 ? "1px solid var(--ink-50)" : "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                  {/* P1-14: 对比选择 checkbox */}
                  <input
                    type="checkbox"
                    checked={isCompareChecked}
                    onChange={() => {
                      setCompareSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(v.filename)) next.delete(v.filename);
                        else next.add(v.filename);
                        // 最多选 2 个
                        if (next.size > 2) {
                          const arr = [...next];
                          next.clear();
                          next.add(arr[arr.length - 1]);
                          next.add(arr[arr.length - 2]);
                        }
                        return next;
                      });
                    }}
                    title="勾选两个版本后点上方「对比」按钮"
                    style={{ marginTop: 3, accentColor: "var(--brand-500)", cursor: "pointer" }}
                  />
                  {/* P1-13: 缩略图 — 用 video 元素 preload 取首帧 */}
                  <video
                    src={v.url}
                    preload="metadata"
                    muted
                    style={{
                      width: 64,
                      height: 36,
                      borderRadius: 4,
                      objectFit: "cover",
                      background: "var(--ink-100)",
                      flexShrink: 0,
                    }}
                    onLoadedData={(e) => {
                      // seek to 0.1s 取首帧 (0 可能是黑帧)
                      const el = e.currentTarget;
                      el.currentTime = 0.1;
                    }}
                  />
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <span
                        style={{
                          fontFamily: "ui-monospace, Consolas, monospace",
                          fontSize: 10,
                          color: "var(--brand-700)",
                          fontWeight: 700,
                        }}
                      >
                        {modeLabel[v.mode] ?? v.mode}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          color: "var(--ink-800)",
                          fontFamily: "ui-monospace, Consolas, monospace",
                          fontSize: 10.5,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={v.filename}
                      >
                        {v.filename}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--ink-400)", fontFamily: "ui-monospace, Consolas, monospace", whiteSpace: "nowrap" }}>
                        {humanSize(v.size_bytes)}
                      </span>
                    </div>
                    {/* P1-13: 相对时间 */}
                    {v.created_at && (
                      <span style={{ fontSize: 10, color: "var(--ink-400)" }}>
                        {formatRelativeTime(v.created_at)}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 4, paddingLeft: 86 }}>
                  <a
                    href={v.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      fontSize: 10.5,
                      color: "var(--brand-700)",
                      textDecoration: "none",
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: "var(--brand-50)",
                      border: "1px solid var(--brand-200, #b8d6ff)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                    }}
                    title="新标签页打开视频(可在线播放)"
                  >
                    <Icon name="play" size={9} />预览
                  </a>
                  <a
                    href={v.url}
                    download={v.filename}
                    style={{
                      fontSize: 10.5,
                      color: "var(--ink-700)",
                      textDecoration: "none",
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: "var(--ink-50)",
                      border: "1px solid var(--ink-200)",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                    }}
                    title="强制下载文件"
                  >
                    <Icon name="download" size={9} />下载
                  </a>
                  {/* 2026-05-25 audit 续集 P0 #1: 删除按钮 — confirm 二次确认 + 调 DELETE 后端 + 刷新列表.
                      final.mp4 后端拒绝删 (那是当前成片). */}
                  {slug && epId && v.filename !== "final.mp4" && (
                    <button
                      type="button"
                      onClick={async () => {
                        const ok = await confirm({
                          // W11 D4: 软删走 _trash, 文案更新让用户知道可恢复
                          title: `删除 ${modeLabel[v.mode] ?? v.mode} ${v.filename}?`,
                          description: "文件会移入垃圾桶，可随时恢复；无需重新合成。",
                          variant: "warning",
                          confirmLabel: "移到垃圾桶",
                        });
                        if (!ok) return;
                        try {
                          await apiDelete(`/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/compose-file/${encodeURIComponent(v.filename)}`);
                          toast.success(`已删除 ${v.filename}`, { description: "如需恢复，从垃圾桶找回" });
                          onRefreshVersions?.();
                        } catch (err: unknown) {
                          toast.error("删除失败", { description: err instanceof Error ? err.message : String(err) });
                        }
                      }}
                      style={{
                        fontSize: 10.5,
                        color: "var(--ink-600)",
                        padding: "2px 8px",
                        borderRadius: 4,
                        background: "var(--ink-50)",
                        border: "1px solid var(--ink-200)",
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                      }}
                      title="移到 _trash/ 子目录, 可手动恢复 (软删, 不真删)"
                    >
                      <Icon name="trash" size={9} />删除
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* === Footer ghost link === */}
      {onShowGuide && (
        <Button
          variant="ghost"
          size="sm"
          iconLeft="info"
          style={{ alignSelf: "center", marginTop: 4 }}
          onClick={onShowGuide}
        >
          查看完整导出说明
        </Button>
      )}

      {/* === 自定义文件夹对话框 === */}
      <PromptDialog
        open={folderDialogOpen}
        title="导出到自定义文件夹"
        description="请输入本机可写的绝对路径。留在本地导出不会消耗视频 API 额度。"
        label="文件夹路径"
        placeholder="D:\\Videos\\output"
        defaultValue={folderPath}
        confirmText="记住此路径"
        onClose={() => setFolderDialogOpen(false)}
        onSubmit={(p) => {
          setFolderPath(p);
          setExportTarget("folder");
          setFolderDialogOpen(false);
          toast.success("已记住导出文件夹，合成完成后点「导出成片」即可");
        }}
      />

      {/* === P1-14: 多版本对比弹窗 === */}
      {compareOpen && (() => {
        const selectedVersions = composeVersions.filter((v) => compareSelected.has(v.filename));
        if (selectedVersions.length < 2) return null;
        const [left, right] = selectedVersions;
        const modeLabel: Record<string, string> = { rough: "粗剪", full: "精剪", quick_local_preview: "样片" };
        return (
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 9999,
              background: "rgba(0,0,0,0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
            }}
            onClick={(e) => { if (e.target === e.currentTarget) setCompareOpen(false); }}
          >
            <div
              style={{
                background: "var(--surface-card, #fff)",
                borderRadius: 12,
                padding: 20,
                width: "90vw",
                maxWidth: 1200,
                maxHeight: "85vh",
                overflow: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 14,
              }}
            >
              {/* 标题栏 */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-800)" }}>
                  版本对比
                </span>
                <button
                  type="button"
                  onClick={() => setCompareOpen(false)}
                  style={{
                    padding: "4px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--ink-200)",
                    background: "var(--ink-50)",
                    cursor: "pointer",
                    fontSize: 12,
                    color: "var(--ink-600)",
                  }}
                >
                  关闭
                </button>
              </div>

              {/* 并排视频 */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {[left, right].map((v, idx) => (
                  <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 4,
                          background: idx === 0 ? "var(--brand-50)" : "var(--ok-bg, rgba(16,185,129,0.08))",
                          color: idx === 0 ? "var(--brand-700)" : "var(--ok, #047857)",
                          fontSize: 11,
                          fontWeight: 700,
                        }}
                      >
                        {idx === 0 ? "A" : "B"}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-700)" }}>
                        {modeLabel[v.mode] ?? v.mode}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--ink-400)" }}>
                        {humanSize(v.size_bytes)}
                        {v.created_at ? ` · ${formatRelativeTime(v.created_at)}` : ""}
                      </span>
                    </div>
                    {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                    <video
                      src={v.url}
                      controls
                      style={{
                        width: "100%",
                        borderRadius: 8,
                        background: "#000",
                        maxHeight: "50vh",
                      }}
                    />
                    <code style={{ fontSize: 10, color: "var(--ink-500)", wordBreak: "break-all" }}>
                      {v.filename}
                    </code>
                  </div>
                ))}
              </div>

              {/* 同步播放提示 */}
              <p style={{ fontSize: 10.5, color: "var(--ink-400)", textAlign: "center" }}>
                两个视频独立播放, 手动同步对比。拖动进度条到相同时间点即可。
              </p>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default ExportPanel;
