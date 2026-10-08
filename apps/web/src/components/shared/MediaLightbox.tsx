// W7 · MediaLightbox — 候选图/视频放大查看
// 用法: 任何候选图/视频/锚点点击 → 弹出全屏 lightbox
// - 图像: 1:1 原尺寸, 滚轮缩放(0.25x ~ 4x), Ctrl+滚轮微调
// - 视频: HTML5 controls + autoPlay loop + 倍速切换
// - ESC / 遮罩点击 / 右上角"关闭"按钮 三种关闭方式
// - 底部 metadata 小条: 显示翻译后的人话(provider 经 labelOfSource)
// - portal 到 document.body, 避免被父级 transform / overflow 截断
//
// W8-sweep (2026-05-16): 加 actions slot, 让 caller 可以在 lightbox 内嵌入
// "用此图微调重抽" / "下载" / "复制地址" 等业务操作按钮 (铁律 #2 可干预性).
// 不传 actions = 老行为(只有缩放/倍速/metadata).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { Button } from "../ui/button";
import { formatBeijingTime } from "../../lib/format";

export interface MediaLightboxProps {
  open: boolean;
  src: string;
  kind: "image" | "video";
  /** 已翻译为人话的 metadata; 传啥显啥, 没传不显示 */
  metadata?: {
    provider?: string;   // 已经过 labelOfSource 翻译的人话
    time?: string;       // ISO 时间或相对时间
    cost_cny?: number;
    seed?: number;
    duration_sec?: number;
  };
  /**
   * 可选 actions 区 — 渲染在底部 metadata 行右侧.
   * 给 caller 注入"用此图微调"/"下载原图"/"复制地址" 等业务按钮.
   * 推荐每个按钮 icon + 文字 (铁律 #11). 不传则不渲染.
   */
  actions?: React.ReactNode;
  onClose: () => void;
}

const VIDEO_RATES = [0.5, 1, 1.5, 2] as const;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;
const ZOOM_STEP_FINE = 0.1;

// 保留：与 lib/format.ts:formatRelativeTime 不等价。
//   差异：接受 string | undefined，undefined 时返回 null（lib 返回 string，不接 undefined）。
function formatRelTime(time?: string): string | null {
  if (!time) return null;
  const d = new Date(time);
  if (isNaN(d.getTime())) return time;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatBeijingTime(d, { mode: "date" });
}

export function MediaLightbox(props: MediaLightboxProps): React.ReactElement | null {
  const { open, src, kind, metadata, actions, onClose } = props;
  const [zoom, setZoom] = useState(1);
  const [videoRate, setVideoRate] = useState<number>(1);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 重置缩放/倍速
  useEffect(() => {
    if (open) {
      setZoom(1);
      setVideoRate(1);
    }
  }, [open, src]);

  // ESC 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 锁滚动
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // 应用倍速到 video 元素
  useEffect(() => {
    if (kind === "video" && videoRef.current) {
      videoRef.current.playbackRate = videoRate;
    }
  }, [kind, videoRate, open]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (kind !== "image") return;
      e.preventDefault();
      const step = e.ctrlKey ? ZOOM_STEP_FINE : ZOOM_STEP;
      const dir = e.deltaY > 0 ? -1 : 1;
      setZoom((z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z + dir * step)));
    },
    [kind],
  );

  const metaText = useMemo(() => {
    if (!metadata) return null;
    const parts: string[] = [];
    if (metadata.provider) parts.push(metadata.provider);
    const t = formatRelTime(metadata.time);
    if (t) parts.push(t);
    if (typeof metadata.cost_cny === "number") parts.push(`¥${metadata.cost_cny.toFixed(2)}`);
    if (typeof metadata.seed === "number") parts.push(`seed: ${metadata.seed}`);
    if (typeof metadata.duration_sec === "number") parts.push(`${metadata.duration_sec}s`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [metadata]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const overlayStyle: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    background: "rgba(0,0,0,0.9)",
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    color: "#fff",
  };

  const topBarStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: "12px 16px",
    gap: 8,
  };

  const contentStyle: React.CSSProperties = {
    display: "grid",
    placeItems: "center",
    overflow: "hidden",
    padding: "0 20px",
  };

  const bottomBarStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 16px",
    fontSize: 12,
    color: "rgba(255,255,255,0.85)",
    flexWrap: "wrap",
    justifyContent: "center",
  };

  const closeBtnStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 32,
    padding: "0 12px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.3)",
    background: "rgba(255,255,255,0.08)",
    color: "#fff",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
  };

  const rateBtnStyle = (on: boolean): React.CSSProperties => ({
    height: 26,
    padding: "0 10px",
    borderRadius: 6,
    border: on ? "1px solid #fff" : "1px solid rgba(255,255,255,0.25)",
    background: on ? "rgba(255,255,255,0.2)" : "transparent",
    color: "#fff",
    fontSize: 11.5,
    fontWeight: on ? 700 : 500,
    cursor: "pointer",
  });

  const node = (
    <div
      style={overlayStyle}
      // 2026-05-27 — 整 overlay onClick 拦截冒泡. portal 渲染到 body, 但 React 合成
      // 事件跟 DOM portal 位置无关仍冒泡到 portal 父 ReactElement (ShotCard 的
      // <article onClick=navigate>). 用户原话: "点完分镜视频并关掉之后就自动进
      // 分镜界面了, 那我还有什么预览的意义". 全 stopPropagation 阻冒泡.
      onClick={(e) => {
        e.stopPropagation();
        // 仅当点击遮罩自身(非内容)时关闭
        if (e.target === e.currentTarget) onClose();
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* 顶部:关闭按钮 (icon+文字 — 铁律#11) */}
      <div style={topBarStyle}>
        {/* 绝对定位顶栏关闭按钮 — overlay 语义保留原生 button */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          style={closeBtnStyle}
          title="关闭 (Esc)"
        >
          <Icon name="close" size={13} />
          关闭
        </button>
      </div>

      {/* 内容区: 图 or 视频 */}
      <div
        style={contentStyle}
        onClick={(e) => {
          // 内容空白处点击也关闭(只有图/视频本身阻止冒泡)
          if (e.target === e.currentTarget) onClose();
        }}
        onWheel={onWheel}
      >
        {kind === "image" ? (
          <img
            src={src}
            alt="放大预览"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "92vw",
              maxHeight: "78vh",
              transform: `scale(${zoom})`,
              transformOrigin: "center",
              transition: "transform 80ms ease-out",
              userSelect: "none",
              boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
              borderRadius: 4,
            }}
          />
        ) : (
          <video
            ref={videoRef}
            src={src}
            controls
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            onClick={(e) => e.stopPropagation()}
            onLoadedMetadata={(e) => {
              // 2026-05-17 修转圈不加载: Chrome autoPlay policy 要求 muted, 之前没加 muted
              // 被 block 显示 controls 但 video stuck. 现在 muted=true + autoPlay → 真开始播.
              // 同时加 preload="auto" 让浏览器主动缓冲, 不等用户交互.
              const v = e.currentTarget;
              v.play().catch(() => { /* 用户交互前 play() reject 静默 — controls 按钮兜底 */ });
            }}
            style={{
              maxWidth: "92vw",
              maxHeight: "78vh",
              borderRadius: 4,
              boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
              background: "#000",
            }}
          />
        )}
      </div>

      {/* 底部:metadata + 操作 */}
      <div style={bottomBarStyle}>
        {kind === "image" && (
          <>
            <span style={{ opacity: 0.75 }}>滚轮缩放 · Ctrl+滚轮微调</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 56, textAlign: "center" }}>
              缩放 {(zoom * 100).toFixed(0)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom(1)}
              style={rateBtnStyle(false)}
              title="还原 100%"
            >
              <Icon name="refresh" size={10} /> 还原
            </button>
            {metaText && <span style={{ opacity: 0.5 }}>·</span>}
          </>
        )}
        {kind === "video" && (
          <>
            <span style={{ opacity: 0.75 }}>倍速</span>
            {VIDEO_RATES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setVideoRate(r)}
                style={rateBtnStyle(videoRate === r)}
                title={`${r}x 倍速播放`}
              >
                {r}x
              </button>
            ))}
            {metaText && <span style={{ opacity: 0.5 }}>·</span>}
          </>
        )}
        {metaText && <span>{metaText}</span>}
        {actions ? (
          <>
            {(metaText || kind === "image" || kind === "video") && (
              <span style={{ opacity: 0.5 }}>·</span>
            )}
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {actions}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default MediaLightbox;
