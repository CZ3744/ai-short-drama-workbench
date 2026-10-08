import { useRef, useState, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import { cn } from "../../../lib/cn";
import { Card } from "../../../components/ui/card";
import { Icon } from "../../../components/shared/Icon";
import { Button } from "../../../components/ui/button";
import { seriesAspectToCss } from "../../../lib/aspectRatio";

export interface ShotSegment {
  shotId: string;
  label: string;
  startSec: number;
  endSec: number;
}

export interface FinalPreviewPlayerProps {
  /** Video source URL (e.g. /api/v2/series/:slug/episodes/:epId/final.mp4) */
  src: string | null;
  /** Shot segments for timeline markers */
  segments?: ShotSegment[];
  /** Subtitles SRT URL (if sidecar, not burned) */
  subtitlesUrl?: string | null;
  /** 1080x1920 by default */
  aspectRatio?: string;
  className?: string;
  /** C4: callback when user clicks "重合成这一段" on a shot segment */
  onRecomposeShot?: (shotId: string) => void;
  /** C4: shot IDs currently being re-composed */
  recomposingShotIds?: string[];
  // 2026-05-18: 空状态 CTA — 给中间大块留白注入引导
  /** 已就绪镜头数 / 总镜头数 (空状态下显示进度) */
  readyCount?: number;
  totalCount?: number;
  /** 全部就绪时点击合成 */
  onComposeClick?: () => void;
  /** 未就绪时跳到首个未就绪 */
  onScrollToFirstMissing?: () => void;
  /** 是否正在合成中 */
  composing?: boolean;
  /**
   * 2026-05-26 整集片头片尾 trim — 用户拖把手选 [start, end] 范围, 导出时 ffmpeg 切掉两端.
   * 状态托管在外部 (ComposePage) 以便 ExportPanel 透传给 useExport.
   * 缺省 = 不裁切, 用 final.mp4 全长.
   */
  trimStartSec?: number;
  trimEndSec?: number | null;
  onTrimChange?: (startSec: number, endSec: number | null) => void;
}

/**
 * 2026-05-28 深度打磨 #3 — 外部通过 ref 调用 seek + autoplay.
 * ComposePage 的 DialogueOverview 点击台词 chip 时调 ref.current?.seekTo(sec) 跳到该镜并播放.
 */
export interface FinalPreviewPlayerHandle {
  /** Seek to a specific second and start playing (autoplay if paused) */
  seekTo: (sec: number) => void;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function resolveCanvasColor(color: string): string {
  const match = color.match(/^var\((--[^)]+)\)$/);
  if (!match) return color;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  return resolved || "rgb(26, 24, 22)";
}

export const FinalPreviewPlayer = forwardRef<FinalPreviewPlayerHandle, FinalPreviewPlayerProps>(function FinalPreviewPlayer({
  src,
  segments = [],
  subtitlesUrl,
  aspectRatio = "9:16",
  className,
  onRecomposeShot,
  recomposingShotIds = [],
  readyCount,
  totalCount,
  onComposeClick,
  onScrollToFirstMissing,
  composing,
  trimStartSec = 0,
  trimEndSec = null,
  onTrimChange,
}: FinalPreviewPlayerProps, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);

  // 2026-05-28 深度打磨 #3: 暴露 seekTo 给外部 (字幕速览 chip 点击跳转 + autoplay).
  useImperativeHandle(ref, () => ({
    seekTo: (sec: number) => {
      const v = videoRef.current;
      if (!v) return;
      const target = Math.max(0, Math.min(sec, v.duration || sec));
      v.currentTime = target;
      setCurrentTime(target);
      if (v.paused) {
        v.play().then(() => setPlaying(true)).catch(() => { /* 浏览器 autoplay policy 拦截不报错 */ });
      }
    },
  }), []);


  // 2026-05-26 整集 trim — canvas 绘制扩 trim 暗 overlay (trim 区外变暗) + trim 边界竖线
  const effectiveTrimEnd = trimEndSec !== null && trimEndSec !== undefined && trimEndSec > 0 && trimEndSec <= duration
    ? trimEndSec
    : duration;
  const effectiveTrimStart = Math.max(0, Math.min(trimStartSec, effectiveTrimEnd - 0.5));
  const trimActive = effectiveTrimStart > 0.05 || effectiveTrimEnd < duration - 0.05;

  // Draw shot markers + trim overlay on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !duration || segments.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 2026-05-27 视觉重新打磨 (用户反馈"进度条没有设计感"):
    //   - 整体高度从 32 → 56, 给 segments markers + 时间刻度 + cursor 三层留呼吸感
    //   - 渐变背景: 深棕 → 黑, 跟 brand 色调一致 (不再灰白)
    //   - segments 用细线分隔 + active 渐变高亮 (brand 色) + 顶部白细边
    //   - 红光标加 box-shadow / 双层 (内核 + 外发光), 顶部圆头把手
    //   - 时间刻度 (每 10s) 浅色短刻度 + 数字
    // 2026-05-27 scale 校正 (更新): segments 整体 × scaleRatio 映射到 video 真长.
    // 但只在 fallback 路径才 scale (segments 用 shot.duration_sec 累加, 跟真长偏差大);
    // 后端真长 shot_segments 已到位时 segmentsTotal ≈ duration, scaleRatio = 1 不动,
    // 各镜按真实比例占位, 红光标跟镜 marker 严格对齐 (不会中间镜偏移).
    // 差距小阈值 0.5s — 因为 ffmpeg 出的 mp4 跟 segments 累加因浮点 / xfade overlap 算法
    // 微差是正常的, 不该触发 scale 把中间镜拉乱.
    const segmentsTotal = segments[segments.length - 1].endSec;
    const diff = Math.abs(segmentsTotal - duration);
    const scaleRatio = (segmentsTotal > 0.001 && diff > 0.5) ? duration / segmentsTotal : 1;

    // ── 1. 背景 — 深色渐变, 给视觉重量感 ──────────
    const bgGradient = ctx.createLinearGradient(0, 0, 0, h);
    bgGradient.addColorStop(0, "#2a221c");
    bgGradient.addColorStop(1, "#1a1410");
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, w, h);

    // ── 2. 时间刻度 — 每 10s 一道竖线 + 数字 (浅白) ──────────
    const tickStep = duration > 120 ? 30 : duration > 60 ? 15 : duration > 30 ? 10 : 5;
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.font = "9.5px ui-monospace, Consolas, monospace";
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    for (let t = tickStep; t < duration; t += tickStep) {
      const x = (t / duration) * w;
      ctx.beginPath();
      ctx.moveTo(x, h - 8);
      ctx.lineTo(x, h);
      ctx.stroke();
      const m = Math.floor(t / 60), s = Math.floor(t % 60);
      ctx.fillText(`${m}:${String(s).padStart(2, "0")}`, x, h - 22);
    }

    // ── 3. 分镜 segments markers — 渐变 + 顶部白细边 + active brand 高亮 ──────────
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const scaledStart = seg.startSec * scaleRatio;
      const scaledEnd = seg.endSec * scaleRatio;
      const x1 = (scaledStart / duration) * w;
      const x2 = (scaledEnd / duration) * w;
      const isIn = currentTime >= scaledStart && currentTime < scaledEnd;

      // segment 主体填充 — active 用 brand 渐变, 非 active 用细微亮度差
      if (isIn) {
        const segGrad = ctx.createLinearGradient(0, 0, 0, h);
        segGrad.addColorStop(0, "rgba(217,119,87,0.65)");
        segGrad.addColorStop(1, "rgba(193,90,55,0.55)");
        ctx.fillStyle = segGrad;
      } else {
        ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.04)" : "rgba(255,255,255,0.07)";
      }
      ctx.fillRect(x1, 0, x2 - x1, h - 12);  // 留底部 12px 给时间刻度

      // 顶部白细边 (active 时加粗 + brand 色)
      ctx.strokeStyle = isIn ? "rgba(255,210,180,0.9)" : "rgba(255,255,255,0.15)";
      ctx.lineWidth = isIn ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x1, 0.5);
      ctx.lineTo(x2, 0.5);
      ctx.stroke();

      // 镜分隔线 (右边界, 最后一个不画)
      if (i < segments.length - 1) {
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x2, 0);
        ctx.lineTo(x2, h - 12);
        ctx.stroke();
      }

      // Label — 加粗 active, 浅白 inactive
      if (x2 - x1 > 24) {
        ctx.fillStyle = isIn ? "#fff" : "rgba(255,255,255,0.55)";
        ctx.font = isIn ? "bold 11.5px ui-sans-serif, sans-serif" : "11px ui-sans-serif, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(seg.label, (x1 + x2) / 2, (h - 12) / 2);
      }
    }

    // ── 4. trim 区外暗 overlay (整集片头片尾切) ──────────
    if (trimActive) {
      const trimX1 = (effectiveTrimStart / duration) * w;
      const trimX2 = (effectiveTrimEnd / duration) * w;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      if (trimX1 > 0) ctx.fillRect(0, 0, trimX1, h - 12);
      if (trimX2 < w) ctx.fillRect(trimX2, 0, w - trimX2, h - 12);
      // trim 边界竖线 (绿色) + 顶部把手
      ctx.strokeStyle = "#10b981";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(trimX1, 0); ctx.lineTo(trimX1, h - 12);
      ctx.moveTo(trimX2, 0); ctx.lineTo(trimX2, h - 12);
      ctx.stroke();
      // 顶部小绿色把手
      ctx.fillStyle = "#10b981";
      ctx.fillRect(trimX1 - 3, 0, 6, 8);
      ctx.fillRect(trimX2 - 3, 0, 6, 8);
    }

    // ── 5. 红光标 cursor — 双层 (外发光 + 内核) + 圆形把手 ──────────
    if (currentTime >= 0 && currentTime <= duration) {
      const cursorX = (currentTime / duration) * w;
      // 外发光 (3px wide, 半透)
      ctx.strokeStyle = "rgba(239, 68, 68, 0.35)";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(cursorX, 0);
      ctx.lineTo(cursorX, h - 12);
      ctx.stroke();
      // 内核 (1.5px solid)
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cursorX, 0);
      ctx.lineTo(cursorX, h - 12);
      ctx.stroke();
      // 顶部圆形把手 (用户拖拽的视觉抓手)
      ctx.fillStyle = "#ef4444";
      ctx.beginPath();
      ctx.arc(cursorX, 5, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.beginPath();
      ctx.arc(cursorX - 1.5, 4, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    void resolveCanvasColor;  // 保留 import (上面渐变已用直接颜色, 不再 var)
  }, [segments, duration, currentTime, trimActive, effectiveTrimStart, effectiveTrimEnd]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  }, []);

  const toggleFullscreen = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      v.requestFullscreen?.();
    }
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        setMuted(prev => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, toggleFullscreen]);

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
  }, []);

  // 2026-05-27 — 红光标 scrub 拖动支持. 用户原话"红色竖条不跟手", 之前只 onClick 单次
  // seek, 没拖动. 现在按住红光标 (或 canvas 任意位置) → mousedown 立即 seek + 进入拖动态
  // → 全局 mousemove 持续 seek (鼠标拖到哪 video 跳哪) → mouseup 退出. 行业标准做法.
  const isDraggingRef = useRef(false);

  const seekToClientX = useCallback((clientX: number) => {
    const canvas = canvasRef.current;
    const v = videoRef.current;
    if (!canvas || !v || !duration) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const ratio = x / rect.width;
    const targetSec = ratio * duration;
    v.currentTime = Math.max(0, Math.min(targetSec, duration));
    // 立即更新 currentTime state, 让红光标立刻跟手 (不等 video 'timeupdate' event 200ms 节流)
    setCurrentTime(v.currentTime);
  }, [duration]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    isDraggingRef.current = true;
    seekToClientX(e.clientX);
  }, [seekToClientX]);

  // 全局 mousemove / mouseup 监听 — 让用户拖出 canvas 也能继续 scrub, 标准实现.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      seekToClientX(e.clientX);
    };
    const onUp = () => { isDraggingRef.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [seekToClientX]);

  // 2026-05-26 handleSegmentClick 删 — chip 行已删, canvas onClick seek 已能跳转任意时间.

  if (!src) {
    // 2026-05-18: 空状态加 CTA — 填满中间空白
    const hasShots = typeof totalCount === "number" && totalCount > 0;
    const allReady = hasShots && readyCount === totalCount;
    const ready = readyCount ?? 0;
    const total = totalCount ?? 0;
    const progressPct = total > 0 ? Math.round((ready / total) * 100) : 0;

    return (
      <Card variant="outlined" className={cn("flex items-center justify-center min-h-[480px] p-[var(--sp-8)]", className)}>
        <div className="flex flex-col items-center text-center gap-4 max-w-md">
          {/* 大图标 — 状态化 */}
          <div
            className="grid place-items-center rounded-full"
            style={{
              width: 88,
              height: 88,
              background: composing
                ? "var(--brand-50, #eaf3ff)"
                : allReady
                  ? "var(--brand-100, #dceaff)"
                  : "var(--ink-50)",
              color: composing
                ? "var(--brand-500)"
                : allReady
                  ? "var(--brand-700)"
                  : "var(--ink-400)",
              transition: "background 0.2s",
            }}
          >
            <Icon
              name={composing ? "refresh" : allReady ? "play" : "clock"}
              size={36}
              className={composing ? "animate-spin" : ""}
            />
          </div>

          {/* 主标题 + 描述 */}
          <div>
            <p style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 18, fontWeight: 600, color: "var(--ink-900)" }}>
              {composing
                ? "成片合成中…"
                : allReady
                  ? "全部分镜就绪,可以合成"
                  : hasShots
                    ? "还有镜头未就绪"
                    : "成片预览待生成"}
            </p>
            <p style={{ fontSize: 13, color: "var(--ink-500)", marginTop: 6, lineHeight: 1.6 }}>
              {composing
                ? "合成完成后视频会在这里直接播放,支持按分镜跳转检查。"
                : allReady
                  ? "点击下方按钮开始合成,合成完成后视频会在这里直接播放。"
                  : hasShots
                    ? `已就绪 ${ready} / ${total} 个镜头,完成剩余镜头后即可合成成片。`
                    : "完成粗剪或精剪后,视频会在这里直接播放,并支持按分镜跳转检查。"}
            </p>
          </div>

          {/* 进度条 — 未就绪时显示 */}
          {hasShots && !allReady && !composing && (
            <div style={{ width: "100%", maxWidth: 280, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ position: "relative", height: 6, background: "var(--ink-100)", borderRadius: 999, overflow: "hidden" }}>
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${progressPct}%`,
                    background: "var(--brand-500)",
                    borderRadius: 999,
                    transition: "width 0.3s",
                  }}
                />
              </div>
              <div style={{ fontSize: 11, color: "var(--ink-500)", fontFamily: "ui-monospace, Consolas, monospace" }}>
                {ready} / {total} 镜就绪 · {progressPct}%
              </div>
            </div>
          )}

          {/* 2026-05-25 合成 UI 整改: 中间预览区不再放主 CTA (页面右上角"合成成片"是唯一入口).
              未就绪时显示二级"去修首个未就绪"链接, 已就绪时显示引导文字指向右上角. */}
          {hasShots && !composing && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 4 }}>
              {allReady ? (
                <p style={{ fontSize: 12, color: "var(--ink-500)", margin: 0 }}>
                  点击页面 <strong style={{ color: "var(--brand-700)" }}>右上角「合成成片」</strong> 按钮开始
                </p>
              ) : (
                onScrollToFirstMissing && (
                  <Button
                    variant="secondary"
                    iconLeft="arrow-down"
                    onClick={onScrollToFirstMissing}
                  >
                    去修复首个未就绪镜头
                  </Button>
                )
              )}
            </div>
          )}
        </div>
      </Card>
    );
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* Video container */}
      <div
        className="relative bg-black rounded-[var(--r-lg)] overflow-hidden mx-auto"
        // 2026-05-25 — 原三元 9:16/16:9/1:1 三选一, 4:3/3:4 系列 fallback 到 1:1 错误.
        // 改 seriesAspectToCss helper 覆盖任意比例 (含 9:16/16:9/1:1/4:3/3:4 + 自定义).
        style={{ aspectRatio: seriesAspectToCss(aspectRatio, "16/9"), maxHeight: "70vh", width: "auto" }}
      >
        <video
          ref={videoRef}
          src={src}
          muted={muted}
          className="w-full h-full object-contain"
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={() => setPlaying(false)}
          onClick={togglePlay}
        />

        {subtitlesUrl && (
          <div className="absolute left-3 bottom-3 rounded-[var(--r-md)] px-2 py-1 text-[var(--fs-xs)]"
            style={{ background: "rgba(26,24,22,0.72)", color: "var(--ink-50)" }}>
            已加载字幕侧车
          </div>
        )}
      </div>

      {/* 2026-05-26 — UI 重构:
          原: canvas 顶部 fillText "第 N 镜" + 底下成对 chip "第 N 镜 重合成这段" → 标签出现两次, 5 镜 10 元素堆密.
          新: canvas 高度 28 → 32 让 label 更清楚, 删除冗余 chip 行,
              重合成功能挪到 chip hover 出现的 ↻ icon (chip 主点击=跳转, hover icon 点击=重合成).
              一行 5 个紧凑 chip, 鼠标贴上去才显示重合成入口. */}
      <div className="px-2">
        {/* 2026-05-27 升级: canvas 高度 32 → 56, 渐变深色背景, 加时间刻度+ 改 cursor 把手 */}
        <canvas
          ref={canvasRef}
          width={1200}
          height={56}
          className="w-full rounded-md"
          style={{ cursor: "col-resize", height: 56, boxShadow: "inset 0 0 0 1px rgba(40,32,24,0.15), 0 1px 2px rgba(40,32,24,0.08)" }}
          onMouseDown={handleMouseDown}
        />
        {/* 时间标签 — chip 风格 + monospace + brand 色, 取代之前灰色简陋字 */}
        <div className="flex justify-between items-center mt-1.5">
          <span style={{
            fontFamily: "ui-monospace, Consolas, monospace",
            fontSize: 11,
            fontWeight: 700,
            color: "var(--brand-700)",
            background: "var(--surface-card)",
            border: "1px solid var(--ink-150)",
            borderRadius: 4,
            padding: "2px 8px",
            letterSpacing: "0.02em",
          }}>
            {formatTime(currentTime)}
          </span>
          <span style={{
            fontFamily: "ui-monospace, Consolas, monospace",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--ink-500)",
            background: "var(--ink-50)",
            border: "1px solid var(--ink-150)",
            borderRadius: 4,
            padding: "2px 8px",
            letterSpacing: "0.02em",
          }}>
            {formatTime(duration)}
          </span>
        </div>
      </div>

      {/* 2026-05-26 — 删除冗余 chip 行 (用户截图反馈"两套镜头切换 UI 不直观").
          canvas 顶部已经显示 segments label + 高亮 active, chip 行重复显示反而乱.
          点击 canvas seek 跳转, 重合成当前镜入口挪到下方 controls 显眼按钮. */}

      {/* 2026-05-27 重新打磨 (用户截图反馈"两处剪辑混淆"):
          - 标题改 "整集片头片尾切" 跟下方"基础剪辑"(单镜级)明确区分
          - 浅绿边框 + 渐变背景, 让这块视觉自成一区
          - 显式提示 "对每镜内的精细切见下方时间轴", 引导用户理解功能边界 */}
      {onTrimChange && duration > 0 && (
        <div
          className="px-3 py-2.5 mt-2 mx-2"
          style={{
            display: "flex", flexDirection: "column", gap: 8,
            background: "linear-gradient(180deg, rgba(16,185,129,0.04) 0%, rgba(252,250,247,0.6) 100%)",
            border: "1px solid rgba(16,185,129,0.2)",
            borderRadius: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-600)", flexWrap: "wrap" }}>
            <Icon name="edit" size={12} style={{ color: "#059669" }} />
            <strong style={{ color: "var(--ink-900)", fontSize: 12.5 }}>整集片头片尾切</strong>
            <span style={{ fontSize: 10.5, color: "var(--ink-400)", marginLeft: 2 }}>(导出时一次性裁掉, 不影响单镜内容)</span>
            <span style={{ flex: 1 }} />
            <span style={{
              fontFamily: "ui-monospace, Consolas, monospace",
              fontSize: 10.5,
              color: "var(--ink-700)",
              background: "var(--surface-card)",
              border: "1px solid var(--ink-150)",
              borderRadius: 4,
              padding: "2px 7px",
            }}>
              片头 {formatTime(effectiveTrimStart)} · 主体 <strong style={{ color: "#059669" }}>{formatTime(effectiveTrimEnd - effectiveTrimStart)}</strong> · 片尾 {formatTime(duration - effectiveTrimEnd)}
            </span>
            {trimActive && (
              <button
                type="button"
                onClick={() => onTrimChange(0, null)}
                style={{
                  fontSize: 10.5, padding: "2px 8px", borderRadius: 4,
                  background: "var(--ink-50)", color: "var(--ink-600)",
                  border: "1px solid var(--ink-150)", cursor: "pointer",
                }}
                title="清除裁剪 (导出完整视频)"
              >
                重置
              </button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10.5, color: "var(--ink-500)", minWidth: 28, fontWeight: 600 }}>起点</span>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.1}
              value={effectiveTrimStart}
              onChange={(e) => {
                const next = Math.min(Number(e.target.value), effectiveTrimEnd - 0.5);
                onTrimChange(next, trimEndSec);
              }}
              style={{ flex: 1, accentColor: "#10b981", height: 4 }}
              title={`片头切掉 ${formatTime(effectiveTrimStart)}`}
            />
            <span style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 10.5, color: "var(--ink-700)", minWidth: 42, textAlign: "right", fontWeight: 600 }}>{formatTime(effectiveTrimStart)}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 10.5, color: "var(--ink-500)", minWidth: 28, fontWeight: 600 }}>终点</span>
            <input
              type="range"
              min={0}
              max={duration}
              step={0.1}
              value={effectiveTrimEnd}
              onChange={(e) => {
                const next = Math.max(Number(e.target.value), effectiveTrimStart + 0.5);
                // 等于 duration 视为"无终点裁剪", 传 null 给后端不发参数
                onTrimChange(trimStartSec, next >= duration - 0.05 ? null : next);
              }}
              style={{ flex: 1, accentColor: "#10b981", height: 4 }}
              title={`保留到 ${formatTime(effectiveTrimEnd)}, 之后切掉`}
            />
            <span style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 10.5, color: "var(--ink-700)", minWidth: 42, textAlign: "right", fontWeight: 600 }}>{formatTime(effectiveTrimEnd)}</span>
          </div>
          <div style={{ fontSize: 10.5, color: "var(--ink-400)", lineHeight: 1.5, paddingTop: 2 }}>
            想精细调整每镜内的开始 / 结束秒数, 看 <strong style={{ color: "var(--ink-600)" }}>下方「基础剪辑」</strong> 时间轴 — 那是单镜级裁切, 跟这里的整集级是两件不同的事.
          </div>
        </div>
      )}

      {/* Controls — 2026-05-26 加显眼"重合成当前镜"按钮, 用户截图报"找不到重新合成的方法".
          按钮文字带当前播放到的镜头号 ("重合成第 3 镜") 让用户立刻知道点了影响哪个镜头. */}
      <div className="flex items-center gap-2 px-2">
        <Button
          variant="ghost"
          size="sm"
          iconLeft={playing ? "pause" : "play"}
          onClick={togglePlay}
          title={playing ? "暂停播放" : "开始播放"}
        >
          {playing ? "暂停" : "播放"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconLeft={muted ? "slash" : "volume"}
          onClick={() => setMuted(!muted)}
          title={muted ? "取消静音" : "静音"}
        >
          {muted ? "取消静音" : "静音"}
        </Button>
        {/* 重合成当前镜 — 找当前播放的 segment, 该镜未在重合成时显示
            2026-05-27 — 用 scaled 后的 startSec/endSec (跟 canvas isIn 同基准, 不然差几秒
            导致按钮显示错镜号) */}
        {onRecomposeShot && (() => {
          const segTotal = segments[segments.length - 1]?.endSec ?? duration;
          const sr = segTotal > 0.001 && duration > 0 ? duration / segTotal : 1;
          const activeSeg = segments.find(s => currentTime >= s.startSec * sr && currentTime < s.endSec * sr) ?? segments[0];
          if (!activeSeg) return null;
          const isRecomposing = recomposingShotIds.includes(activeSeg.shotId);
          return (
            <Button
              variant="ghost"
              size="sm"
              iconLeft="refresh"
              loading={isRecomposing}
              disabled={isRecomposing}
              onClick={() => onRecomposeShot(activeSeg.shotId)}
              title={`只重新合成 ${activeSeg.label} (其他镜头不变, 比整集重合成快)`}
            >
              {isRecomposing ? `${activeSeg.label} 重合成中…` : `重合成 ${activeSeg.label}`}
            </Button>
          );
        })()}
        <Button
          variant="ghost"
          size="sm"
          iconLeft="expand"
          className="ml-auto"
          onClick={toggleFullscreen}
          title="全屏预览"
        >
          全屏
        </Button>
      </div>
    </div>
  );
});
