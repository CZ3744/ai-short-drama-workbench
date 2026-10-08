import { useState, useCallback, useRef, useEffect } from "react";
import { createSSEClient } from "../lib/sse";

export type ExportStage = "idle" | "exporting" | "done" | "error";
export type ExportTarget = "zip" | "library" | "folder";

/**
 * 2026-05-29 P0-6: 多规格导出进度 — 后端 multiFormatExporter 每完成一个 format 通过 SSE broker
 * 推 export.format_progress, 这里订 /api/v2/events 收. 前端 ExportPanel 据此显 percent + 当前规格 + ETA
 * (之前只显"导出中 12s", 用户不知道总共几个规格 / 还剩多久).
 */
export interface ExportProgress {
  completed: number;
  total: number;
  percent: number;
  /** 刚完成的规格中文名 (如 "B 站 / YouTube 横屏 16:9"); 起点时为 "准备导出" */
  currentLabel: string;
  /** 估算剩余秒数 (按已完成规格的平均耗时 × 剩余数); null = 还算不出 */
  etaSec: number | null;
}

/** P170 3E: 多格式导出结果 */
export interface MultiFormatResult {
  format_id: string;
  output_path: string;
  width: number;
  height: number;
  fps: number;
  container: "mp4" | "gif";
  size_bytes: number;
  ok: boolean;
  error?: string;
}

export interface UseExportResult {
  stage: ExportStage;
  outputPath: string | null;
  /** 2026-05-25: 导出文件所在目录 (library/folder 走多规格复制时, outputPath 只是末个文件, dir 是父目录) */
  outputDir: string | null;
  /** 2026-05-25: 实际复制的文件名列表 (按勾选规格复制多个 / 未勾选时只有 1 个 final.mp4) */
  files: string[];
  /** 2026-05-25: 导出过程的非致命警告 (比如某规格生成失败 / 文件大小不一致). 致命错误走 error 字段. */
  warnings: string[];
  target: ExportTarget | null;
  error: string | null;
  /**
   * UP-6 (2026-07-22): 后端错误 code (如 "FinalNotReady" — 只有预览片/完全没合成过时导出失败).
   * ExportPanel 据此弹人话引导弹窗 + 一键直达"合成成片", 而不是干展示一条裸 error 文案 toast。
   * null = 没有可识别的 code (网络错误 / 老式纯字符串错误等), 走原有通用错误展示。
   */
  errorCode: string | null;
  /** P170 3E: 多格式导出结果 */
  multiFormatResults: MultiFormatResult[] | null;
  /** 2026-05-25: 导出已运行时间 (ms), exporting 时每 200ms 更新. 完成/失败/取消时停 */
  elapsedMs: number;
  /** 2026-05-29 P0-6: 多规格导出进度 (completed/total + percent + 当前规格 + ETA); null = 没有多规格进度 */
  progress: ExportProgress | null;
  startExport: (seriesSlug: string, epId: string, opts: {
    includeCover?: boolean;
    includeMetadata?: boolean;
    target?: ExportTarget;
    folderPath?: string;
    /** P170 3E: 多规格格式ID数组 */
    formats?: string[];
    /** 2026-05-26 整集片头片尾 trim — FinalPreviewPlayer 拖把手选 [start, end] (秒) */
    episodeTrimStartSec?: number;
    episodeTrimEndSec?: number;
  }) => Promise<void>;
  /** 2026-05-25: 中断进行中的导出 (后端会接 abort signal 退出 ffmpeg) */
  abort: () => void;
  reset: () => void;
}

/**
 * Drives POST /episodes/:epId/export.
 * C7: 支持 zip / library / folder 三种导出目标。
 * P170 3E: 支持多规格 formats 数组。
 */
export function useExport(): UseExportResult {
  const [stage, setStage] = useState<ExportStage>("idle");
  const [outputPath, setOutputPath] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [target, setTarget] = useState<ExportTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  // UP-6 (2026-07-22): 跟 error 并列存后端 code, 见 UseExportResult.errorCode 注释.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [multiFormatResults, setMultiFormatResults] = useState<MultiFormatResult[] | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  // 2026-05-29 P0-6: 多规格导出进度
  const [progress, setProgress] = useState<ExportProgress | null>(null);

  // 2026-05-25: AbortController + 计时器, 让用户能取消 + 看到耗时
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 2026-05-29 P0-6: 导出期间订 /api/v2/events 的 SSE client + 进度起始时间 (算 ETA 用)
  const sseRef = useRef<ReturnType<typeof createSSEClient> | null>(null);
  const exportStartRef = useRef<number>(0);

  // exporting 时每 200ms 更新计时器, 非 exporting 时清掉
  useEffect(() => {
    if (stage === "exporting") {
      const start = Date.now();
      setElapsedMs(0);
      timerRef.current = setInterval(() => setElapsedMs(Date.now() - start), 200);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [stage]);

  // 2026-05-29 P0-6: 关掉导出进度 SSE 订阅 (导出完成/失败/取消/unmount 时)
  const closeProgressSse = useCallback(() => {
    sseRef.current?.dispose();
    sseRef.current = null;
  }, []);

  // unmount 时清理 SSE, 防泄漏
  useEffect(() => () => { sseRef.current?.dispose(); sseRef.current = null; }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    closeProgressSse();
    setStage("idle");
    setOutputPath(null);
    setOutputDir(null);
    setFiles([]);
    setWarnings([]);
    setTarget(null);
    setError(null);
    setErrorCode(null);
    setMultiFormatResults(null);
    setElapsedMs(0);
    setProgress(null);
  }, [closeProgressSse]);

  // 2026-05-28 P0-4 修: 非 exporting 状态 abort 是 no-op, 避免 done/error 后再点 abort
  // 把已经完成的导出错误标记 "已取消". stageRef + abortRef 双重守门.
  const stageRef = useRef<ExportStage>(stage);
  useEffect(() => { stageRef.current = stage; }, [stage]);
  const abort = useCallback(() => {
    if (stageRef.current !== "exporting") return;
    if (!abortRef.current) return;
    abortRef.current.abort();
    abortRef.current = null;
    closeProgressSse();
    setError("已取消");
    setErrorCode(null);
    setStage("error");
  }, [closeProgressSse]);

  const startExport = useCallback(async (seriesSlug: string, epId: string, opts: {
    includeCover?: boolean;
    includeMetadata?: boolean;
    target?: ExportTarget;
    folderPath?: string;
    formats?: string[];
    episodeTrimStartSec?: number;
    episodeTrimEndSec?: number;
  }) => {
    // 取消上一次未完成的导出
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setStage("exporting");
    setError(null);
    setErrorCode(null);
    setTarget(opts.target ?? "zip");
    setMultiFormatResults(null);
    setFiles([]);
    setWarnings([]);
    setOutputDir(null);
    setProgress(null);

    // 2026-05-29 P0-6: 多规格导出时订 /api/v2/events 收 export.format_progress (后端每完成一个 format 推).
    //   只在勾了多个 format 时才开 SSE — 单 format / zip 没有逐规格进度, 不必开. 用 series_slug
    //   过滤减少噪音 (export 事件经 broker broadcast 到 global, series_slug 订阅也能收到 global 广播).
    const wantsProgress = !!(opts.formats && opts.formats.length > 0);
    closeProgressSse();
    if (wantsProgress) {
      exportStartRef.current = Date.now();
      sseRef.current = createSSEClient({
        seriesSlug,
        onEvent: {
          "export.format_progress": (raw: Record<string, unknown>) => {
            // sseBroker._send 写的是完整 envelope { type, job_id, data: {...flat payload}, at },
            // 真 payload 在 .data 里 (sseProgress 经 broadcast 走这条). 兜底兼容平铺 shape.
            const d = (raw?.data && typeof raw.data === "object" ? raw.data : raw) as {
              completed?: number; total?: number; percent?: number; current_format_label?: string; episode_id?: string;
            };
            // 只认本集的进度 (broker 是全局广播, 多集同时导出时过滤)
            if (d.episode_id && d.episode_id !== epId) return;
            const completed = d.completed ?? 0;
            const total = d.total ?? 0;
            const percent = d.percent ?? (total > 0 ? Math.round((completed / total) * 100) : 0);
            // ETA: 已完成 N 个耗时 elapsed → 每个平均 elapsed/N → 剩余 (total-N) 个 × 平均
            let etaSec: number | null = null;
            if (completed > 0 && total > completed) {
              const elapsed = (Date.now() - exportStartRef.current) / 1000;
              const perFormat = elapsed / completed;
              etaSec = Math.max(1, Math.round(perFormat * (total - completed)));
            }
            setProgress({
              completed,
              total,
              percent,
              currentLabel: d.current_format_label ?? "",
              etaSec,
            });
          },
        },
      });
    }
    try {
      // 直接用 fetch (而不是 apiPost) 以接 AbortSignal
      const r = await fetch(`/api/v2/series/${encodeURIComponent(seriesSlug)}/episodes/${encodeURIComponent(epId)}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          include_cover: opts.includeCover ?? true,
          include_metadata: opts.includeMetadata ?? true,
          target: opts.target ?? "zip",
          folder_path: opts.folderPath,
          ...(opts.formats && opts.formats.length > 0 ? { formats: opts.formats } : {}),
          ...(opts.episodeTrimStartSec !== undefined && opts.episodeTrimStartSec > 0.001 ? { episode_trim_start_sec: opts.episodeTrimStartSec } : {}),
          ...(opts.episodeTrimEndSec !== undefined && opts.episodeTrimEndSec > 0.001 ? { episode_trim_end_sec: opts.episodeTrimEndSec } : {}),
        }),
        signal: ac.signal,
      });
      if (!r.ok) {
        const errBody = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
        const msg = errBody?.error?.message ?? `HTTP ${r.status}`;
        // UP-6 (2026-07-22): 一并读后端 code (如 "FinalNotReady"), 供 ExportPanel 识别弹引导弹窗.
        const code = errBody?.error?.code;
        setError(msg);
        setErrorCode(typeof code === "string" ? code : null);
        setStage("error");
        return;
      }
      const res = await r.json() as {
        ok: boolean;
        output_path: string;
        output_dir?: string;
        files?: string[];
        warnings?: string[];
        target: string;
        multi_format_results?: MultiFormatResult[];
      };
      if (res.ok && res.output_path) {
        setOutputPath(res.output_path);
        if (res.output_dir) setOutputDir(res.output_dir);
        if (res.files && res.files.length > 0) setFiles(res.files);
        if (res.warnings && res.warnings.length > 0) setWarnings(res.warnings);
        if (res.multi_format_results && res.multi_format_results.length > 0) {
          setMultiFormatResults(res.multi_format_results);
        }
        setStage("done");
      } else {
        setError("导出失败");
        setStage("error");
      }
    } catch (err: any) {
      if (err?.name === "AbortError" || ac.signal.aborted) {
        // 用户主动取消 — abort() 已经设了 error/stage, 这里不动
        return;
      }
      setError(err?.message ?? "导出请求失败");
      setStage("error");
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      // 2026-05-29 P0-6: 导出结束 (成功/失败) 关进度 SSE
      closeProgressSse();
    }
  }, [closeProgressSse]);

  return { stage, outputPath, outputDir, files, warnings, target, error, errorCode, multiFormatResults, elapsedMs, progress, startExport, abort, reset };
}
