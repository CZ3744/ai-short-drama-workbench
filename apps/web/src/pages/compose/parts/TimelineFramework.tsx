/**
 * TimelineFramework.tsx — 2026-05-18 顶层重设计
 *
 * 单条时间轴整合(原 TimelineFramework + TrimTimeline 合并):
 *  - 水平时间轴,按 duration_sec 比例渲染各镜色块
 *  - 单击 → 选中(展开下方 trim 详情);双击 → 跳转单镜编辑页
 *  - 选中镜下方 inline 出现 trim 入帧/出帧拖拽控件(只对该镜,不再 8 镜并排)
 *  - @dnd-kit SortableContext 拖拽改顺序
 *  - 视觉统一: 用 brand-500 / ink-300 表达 ready / pending(原"绿+红斜纹"混合配色废弃)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "../../../lib/cn";
import { apiPost } from "../../../lib/api";
import { showErrorToast } from "../../../lib/errorTranslate";
import { toast } from "sonner";
import { Icon } from "../../../components/shared/Icon";
import type { Shot } from "../../../hooks/useShots";
import { patchShot } from "../../../hooks/useShots";
import { useAsyncAction } from "../../../hooks/useAsyncAction";
import { Button } from "../../../components/ui/button";

export interface TimelineFrameworkProps {
  slug: string;
  epId: string;
  shots: Shot[];
  className?: string;
  /** P1-4: 合成后的视频 URL, 用于波形可视化 */
  finalVideoUrl?: string | null;
}

// 2026-05-22: 跟 ComposePage.computeReadiness 同步 — picked_video_id + approved 就绪,
// 不强求 picked_first_frame_id (用户本地导入视频路径不会自动建首帧).
function isReady(s: Shot): boolean {
  return (
    s.status === "approved" &&
    Boolean(s.picked_video_id)
  );
}

// ── 单个可拖拽色块 ─────────────────────────────────────────────────────────────

interface SortableShotBlockProps {
  shot: Shot;
  widthPct: number;
  isLast: boolean;
  isDraggingId: string | null;
  selected: boolean;
  onSelect: (s: Shot) => void;
  onGoToShot: (s: Shot) => void;
}

function SortableShotBlock({
  shot,
  widthPct,
  isLast,
  isDraggingId,
  selected,
  onSelect,
  onGoToShot,
}: SortableShotBlockProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: shot.id });

  const ready = isReady(shot);
  const durSec = shot.duration_sec || 3;
  const isActiveDrag = isDraggingId === shot.id;

  // 统一配色:ready = brand-500 浅色填充;pending = ink-50;selected = brand outline
  const bg = ready ? "var(--brand-50, #eaf3ff)" : "var(--ink-50, #f5f5f4)";
  const accent = ready ? "var(--brand-500, #2f86ff)" : "var(--ink-300, #c9c5c2)";

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    width: `${widthPct}%`,
    minWidth: 28,
    height: "100%",
    borderRight: !isLast ? "1px solid rgba(255,255,255,0.6)" : "none",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    cursor: isDragging ? "grabbing" : "pointer",
    background: bg,
    padding: 0,
    gap: 2,
    opacity: isActiveDrag ? 0.5 : 1,
    outline: selected
      ? "2px solid var(--brand-600, #1565d8)"
      : isDragging && !isActiveDrag
        ? "2px solid var(--brand-400)"
        : "none",
    outlineOffset: -2,
    zIndex: isDragging || selected ? 10 : 0,
    position: "relative",
    userSelect: "none",
    flexShrink: 0,
    borderTop: `3px solid ${accent}`,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(!isActiveDrag && "hover:brightness-95 transition-all")}
      title={`第 ${shot.index} 镜 · ${durSec}s · ${ready ? "就绪" : "待制作"} — 单击选中/双击跳转`}
      onClick={(e) => {
        if (isDragging) return;
        if (e.detail >= 2) {
          // 双击跳转
          onGoToShot(shot);
        } else {
          // 单击选中
          onSelect(shot);
        }
      }}
      {...attributes}
      {...listeners}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "var(--ink-800)",
          lineHeight: 1,
          textAlign: "center",
          letterSpacing: "0.04em",
          pointerEvents: "none",
        }}
      >
        S{String(shot.index).padStart(2, "0")}
      </span>
      {widthPct > 5 && (
        <span
          style={{
            fontSize: 9,
            color: "var(--ink-500)",
            lineHeight: 1,
            pointerEvents: "none",
          }}
        >
          {durSec}s
        </span>
      )}
    </div>
  );
}

// ── 单镜 inline Trim 详情 ─────────────────────────────────────────────────────

interface SelectedShotTrimProps {
  slug: string;
  epId: string;
  shot: Shot;
  onClose: () => void;
  onGoToShot: (s: Shot) => void;
}

function SelectedShotTrim({ slug, epId, shot, onClose, onGoToShot }: SelectedShotTrimProps) {
  const dur = shot.duration_sec || 3;
  const [trimStart, setTrimStart] = useState(shot.trim_start_sec ?? 0);
  const [trimEnd, setTrimEnd] = useState(shot.trim_end_sec ?? dur);

  // shot 切换时重置 local state
  useEffect(() => {
    setTrimStart(shot.trim_start_sec ?? 0);
    setTrimEnd(shot.trim_end_sec ?? (shot.duration_sec || 3));
  }, [shot.id, shot.trim_start_sec, shot.trim_end_sec, shot.duration_sec]);

  const trimmed = trimStart > 0.05 || trimEnd < dur - 0.05;
  const ready = isReady(shot);

  // useAsyncAction 接管 busy + 错误 — 失败时回滚 local state (走 onError 关闭)
  const trimAction = useAsyncAction(
    async (args: { newStart: number; newEnd: number }) => {
      await patchShot(slug, epId, shot.id, {
        trim_start_sec: Number(args.newStart.toFixed(2)),
        trim_end_sec: Number(args.newEnd.toFixed(2)),
      });
      return args;
    },
    {
      silent: true,
      onSuccess: (args) => {
        toast.success(`已保存 ${shot.title || `第 ${shot.index} 镜`} 裁剪 ${(args.newEnd - args.newStart).toFixed(1)}s`);
      },
      onError: (err) => {
        showErrorToast(err, "裁剪保存失败,已回滚");
        setTrimStart(shot.trim_start_sec ?? 0);
        setTrimEnd(shot.trim_end_sec ?? dur);
      },
    },
  );
  const saving = trimAction.busy;

  async function commitTrim(newStart: number, newEnd: number) {
    const origStart = shot.trim_start_sec ?? 0;
    const origEnd = shot.trim_end_sec ?? dur;
    if (Math.abs(origStart - newStart) < 0.01 && Math.abs(origEnd - newEnd) < 0.01) return;
    await trimAction.run({ newStart, newEnd });
  }

  function handleStartChange(v: number) {
    const next = Math.max(0, Math.min(trimEnd - 0.5, v));
    setTrimStart(next);
  }
  function handleStartCommit(v: number) {
    const next = Math.max(0, Math.min(trimEnd - 0.5, v));
    void commitTrim(next, trimEnd);
  }
  function handleEndChange(v: number) {
    const next = Math.min(dur, Math.max(trimStart + 0.5, v));
    setTrimEnd(next);
  }
  function handleEndCommit(v: number) {
    const next = Math.min(dur, Math.max(trimStart + 0.5, v));
    void commitTrim(trimStart, next);
  }

  // 可视化 trim 条 (单镜 100% 宽)
  const startPct = (trimStart / dur) * 100;
  const endPct = (trimEnd / dur) * 100;
  const visibleWidthPct = endPct - startPct;

  return (
    <div
      style={{
        marginTop: 10,
        padding: "12px 14px",
        background: "var(--surface-card, #fff)",
        border: "1px solid var(--ink-150, #e7e5e2)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* 标题行 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            background: ready ? "var(--brand-50)" : "var(--ink-50)",
            color: ready ? "var(--brand-700)" : "var(--ink-600)",
            border: `1px solid ${ready ? "var(--brand-200, #b8d6ff)" : "var(--ink-200, #e7e5e2)"}`,
            borderRadius: 6,
            fontSize: 11.5,
            fontWeight: 700,
          }}
        >
          <Icon name={ready ? "check" : "clock"} size={11} />
          第 {shot.index} 镜
        </span>
        {/* 2026-05-25 合成 UI #8 (铁律 #9 toC 兜底): 用户没起名时显示 "第 N 镜" 人话, 不再 "(未命名)" 技术字面 */}
        {shot.title?.trim() && (
          <span style={{ fontSize: 12, color: "var(--ink-700)", fontWeight: 600 }}>
            {shot.title}
          </span>
        )}
        <span style={{ fontSize: 11, color: "var(--ink-400)" }}>
          原始 {dur.toFixed(1)}s · 当前 {(trimEnd - trimStart).toFixed(1)}s
          {trimmed && ` · 已裁掉 ${(dur - (trimEnd - trimStart)).toFixed(1)}s`}
          {saving && " · 保存中…"}
        </span>
        <span style={{ flex: 1 }} />
        <Button
          variant="secondary"
          size="sm"
          iconLeft="external-link"
          onClick={() => onGoToShot(shot)}
        >
          打开单镜
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconLeft="close"
          onClick={onClose}
          title="关闭详情"
        >
          收起
        </Button>
      </div>

      {/* trim 可视化条 */}
      <div
        style={{
          position: "relative",
          width: "100%",
          height: 36,
          background: "var(--ink-50, #f5f5f4)",
          borderRadius: 6,
          overflow: "hidden",
          border: "1px solid var(--ink-150)",
        }}
      >
        {/* 已裁掉的区域(左) */}
        {trimStart > 0 && (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: `${startPct}%`,
              height: "100%",
              background: "repeating-linear-gradient(45deg, rgba(0,0,0,0.04) 0 4px, rgba(0,0,0,0.10) 4px 8px)",
            }}
          />
        )}
        {/* 保留区 */}
        <div
          style={{
            position: "absolute",
            left: `${startPct}%`,
            top: 0,
            width: `${visibleWidthPct}%`,
            height: "100%",
            background: "var(--brand-50, #eaf3ff)",
            borderTop: "2px solid var(--brand-500, #2f86ff)",
            borderBottom: "2px solid var(--brand-500, #2f86ff)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            color: "var(--brand-700)",
            fontWeight: 600,
          }}
        >
          {visibleWidthPct > 15 && `保留 ${(trimEnd - trimStart).toFixed(1)}s`}
        </div>
        {/* 已裁掉的区域(右) */}
        {trimEnd < dur && (
          <div
            style={{
              position: "absolute",
              left: `${endPct}%`,
              top: 0,
              width: `${100 - endPct}%`,
              height: "100%",
              background: "repeating-linear-gradient(45deg, rgba(0,0,0,0.04) 0 4px, rgba(0,0,0,0.10) 4px 8px)",
            }}
          />
        )}
      </div>

      {/* 双 range slider */}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 10, alignItems: "center", fontSize: 11.5, color: "var(--ink-600)" }}>
        <span style={{ fontWeight: 600, color: "var(--ink-700)" }}>入帧</span>
        <input
          type="range"
          min={0}
          max={dur}
          step={0.1}
          value={trimStart}
          onChange={(e) => handleStartChange(Number(e.target.value))}
          onMouseUp={(e) => handleStartCommit(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => handleStartCommit(Number((e.target as HTMLInputElement).value))}
          style={{ width: "100%", accentColor: "var(--brand-500)" }}
        />
        <span style={{ fontFamily: "ui-monospace, Consolas, monospace", color: "var(--brand-700)", minWidth: 40, textAlign: "right" }}>
          {trimStart.toFixed(1)}s
        </span>

        <span style={{ fontWeight: 600, color: "var(--ink-700)" }}>出帧</span>
        <input
          type="range"
          min={0}
          max={dur}
          step={0.1}
          value={trimEnd}
          onChange={(e) => handleEndChange(Number(e.target.value))}
          onMouseUp={(e) => handleEndCommit(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => handleEndCommit(Number((e.target as HTMLInputElement).value))}
          style={{ width: "100%", accentColor: "var(--brand-500)" }}
        />
        <span style={{ fontFamily: "ui-monospace, Consolas, monospace", color: "var(--brand-700)", minWidth: 40, textAlign: "right" }}>
          {trimEnd.toFixed(1)}s
        </span>
      </div>

      {/* 2026-05-25 合成 UI #11: 只在有 trim 斜纹区时讲"斜纹区域 = 合成时跳过", 否则简短提示. */}
      <div style={{ fontSize: 10.5, color: "var(--ink-400)" }}>
        {trimmed
          ? "斜纹区域 = 合成时跳过 · 拖动滑块自动保存"
          : "拖动两端滑块裁掉头尾不需要的画面"}
      </div>

      {/* P1-1: 单镜级转场选择器 */}
      <TransitionPicker
        slug={slug}
        epId={epId}
        shot={shot}
      />
    </div>
  );
}

// ── P1-1: 单镜级转场选择器 ────────────────────────────────────────────────────

/** 转场选项 — 与 transitions.ts TransitionType 对齐 */
const TRANSITION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "",           label: "(跟随整集)" },
  { value: "hard",       label: "硬切" },
  { value: "crossfade",  label: "交叉溶解" },
  { value: "fade",       label: "淡入淡出" },
  { value: "wipe-left",  label: "左划入" },
  { value: "wipe-right", label: "右划入" },
  { value: "wipe-up",    label: "上划入" },
  { value: "wipe-down",  label: "下划入" },
];

interface TransitionPickerProps {
  slug: string;
  epId: string;
  shot: Shot;
}

function TransitionPicker({ slug, epId, shot }: TransitionPickerProps) {
  const [transType, setTransType] = useState(shot.transition_in ?? "");
  const [transDur, setTransDur] = useState(shot.transition_duration ?? 0.5);
  const [saving, setSaving] = useState(false);

  // shot 切换时重置 local state
  useEffect(() => {
    setTransType(shot.transition_in ?? "");
    setTransDur(shot.transition_duration ?? 0.5);
  }, [shot.id, shot.transition_in, shot.transition_duration]);

  async function saveTransition(type: string, dur: number) {
    setSaving(true);
    try {
      await patchShot(slug, epId, shot.id, {
        transition_in: type || undefined,
        transition_duration: dur,
      });
      toast.success(`转场已保存: ${TRANSITION_OPTIONS.find(o => o.value === type)?.label ?? "硬切"} ${dur.toFixed(1)}s`);
    } catch (err) {
      showErrorToast(err, "转场保存失败");
    } finally {
      setSaving(false);
    }
  }

  const isHard = transType === "hard" || transType === "";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        background: "var(--ink-50, #f5f5f4)",
        borderRadius: 8,
        fontSize: 11,
        color: "var(--ink-600)",
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontWeight: 600, color: "var(--ink-700)", display: "inline-flex", alignItems: "center", gap: 4 }}>
        <Icon name="film" size={11} />
        转场
      </span>
      <select
        value={transType}
        onChange={(e) => {
          const v = e.target.value;
          setTransType(v);
          void saveTransition(v, transDur);
        }}
        disabled={saving}
        style={{
          padding: "3px 6px",
          borderRadius: 6,
          border: "1px solid var(--ink-200)",
          fontSize: 11,
          background: "var(--surface-card, #fff)",
          color: "var(--ink-700)",
          cursor: "pointer",
        }}
      >
        {TRANSITION_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {!isHard && (
        <>
          <span style={{ fontSize: 10.5, color: "var(--ink-500)" }}>时长</span>
          <input
            type="range"
            min={0.3}
            max={2}
            step={0.1}
            value={transDur}
            onChange={(e) => setTransDur(Number(e.target.value))}
            onMouseUp={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              void saveTransition(transType, v);
            }}
            onTouchEnd={(e) => {
              const v = Number((e.target as HTMLInputElement).value);
              void saveTransition(transType, v);
            }}
            style={{ width: 80, accentColor: "var(--brand-500)" }}
          />
          <span style={{ fontFamily: "ui-monospace, Consolas, monospace", color: "var(--brand-700)", minWidth: 30 }}>
            {transDur.toFixed(1)}s
          </span>
        </>
      )}
      {saving && <span style={{ fontSize: 10, color: "var(--ink-400)" }}>保存中…</span>}
    </div>
  );
}

// ── P1-4: 音波 waveform 可视化 ────────────────────────────────────────────────

interface WaveformCanvasProps {
  videoUrl: string | null;
  className?: string;
}

function WaveformCanvas({ videoUrl, className }: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!videoUrl || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cancelled = false;
    setLoading(true);

    // 用 Web Audio API 解码视频音频 → PCM → 画波形
    const audioCtx = new AudioContext();

    fetch(videoUrl)
      .then((r) => r.arrayBuffer())
      .then((buf) => audioCtx.decodeAudioData(buf))
      .then((audioBuffer) => {
        if (cancelled) return;
        const data = audioBuffer.getChannelData(0);
        const w = canvas.width;
        const h = canvas.height;
        const step = Math.ceil(data.length / w);

        ctx.clearRect(0, 0, w, h);

        // 渐变: 绿→蓝
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, "rgba(16, 185, 129, 0.7)");
        grad.addColorStop(1, "rgba(59, 130, 246, 0.7)");
        ctx.fillStyle = grad;

        for (let i = 0; i < w; i++) {
          let min = 1;
          let max = -1;
          for (let j = 0; j < step; j++) {
            const idx = i * step + j;
            if (idx < data.length) {
              const v = data[idx];
              if (v < min) min = v;
              if (v > max) max = v;
            }
          }
          const yMin = ((1 + min) / 2) * h;
          const yMax = ((1 + max) / 2) * h;
          ctx.fillRect(i, yMin, 1, Math.max(1, yMax - yMin));
        }
        setLoading(false);
      })
      .catch(() => {
        // 静默失败 — 波形是增强功能, 不阻塞主流程
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      audioCtx.close().catch(() => {});
    };
  }, [videoUrl]);

  if (!videoUrl) return null;

  return (
    <div className={className} style={{ position: "relative" }}>
      <canvas
        ref={canvasRef}
        width={800}
        height={48}
        style={{
          width: "100%",
          height: 48,
          borderRadius: 6,
          background: "var(--ink-50, #f5f5f4)",
          border: "1px solid var(--ink-100)",
        }}
      />
      {loading && (
        <span
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            fontSize: 10,
            color: "var(--ink-400)",
          }}
        >
          加载波形…
        </span>
      )}
    </div>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

export function TimelineFramework({
  slug,
  epId,
  shots,
  className,
  finalVideoUrl,
}: TimelineFrameworkProps) {
  const navigate = useNavigate();

  const initialSorted = useMemo(
    () => [...shots].sort((a, b) => a.index - b.index),
    [shots],
  );

  const [localOrder, setLocalOrder] = useState<string[]>(() =>
    initialSorted.map((s) => s.id),
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // shots 增删时同步 localOrder
  //
  // 2026-05-19 防御性修复 (兼并 ShotboardPage 同款 fix):
  // 若新旧合并结果与 prev 内容完全一致, 返回 prev 引用以阻断潜在的 infinite re-render.
  useEffect(() => {
    const incoming = initialSorted.map((s) => s.id);
    setLocalOrder((prev) => {
      const incomingSet = new Set(incoming);
      const prevSet = new Set(prev);
      // 保持已有顺序,追加新增,过滤已删
      const retained = prev.filter((id) => incomingSet.has(id));
      const added = incoming.filter((id) => !prevSet.has(id));
      const next = [...retained, ...added];
      if (prev.length === next.length && prev.every((id, i) => id === next[i])) {
        return prev;
      }
      return next;
    });
  }, [initialSorted]);

  const shotMap = useMemo(() => {
    const m = new Map<string, Shot>();
    for (const s of shots) m.set(s.id, s);
    return m;
  }, [shots]);

  const ordered = useMemo(
    () => localOrder.map((id) => shotMap.get(id)).filter(Boolean) as Shot[],
    [localOrder, shotMap],
  );

  const totalDuration = useMemo(
    () => ordered.reduce((acc, s) => acc + (s.duration_sec || 3), 0),
    [ordered],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setDraggingId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = localOrder.indexOf(active.id as string);
      const newIndex = localOrder.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      const newOrder = arrayMove(localOrder, oldIndex, newIndex);
      const prevOrder = [...localOrder];
      setLocalOrder(newOrder);

      try {
        await apiPost(
          `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/shots/reorder`,
          { shot_ids: newOrder },
        );
      } catch (err) {
        setLocalOrder(prevOrder);
        showErrorToast(err, "时间轴排序失败,已还原");
      }
    },
    [localOrder, slug, epId],
  );

  const goToShot = useCallback(
    (s: Shot) => {
      navigate(`/studio/${slug}/shot-stage/${epId}/${s.id}`);
    },
    [navigate, slug, epId],
  );

  const handleSelect = useCallback((s: Shot) => {
    setSelectedId((prev) => (prev === s.id ? null : s.id));
  }, []);

  if (shots.length === 0) return null;

  const readyCount = ordered.filter((s) => isReady(s)).length;
  const selectedShot = selectedId ? shotMap.get(selectedId) : null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* 标题行 — 紧凑 */}
      <div className="flex items-center gap-3 flex-wrap">
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "var(--ink-500)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          时间轴
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-400)" }}>
          {readyCount} / {ordered.length} 镜就绪 · {totalDuration}s
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: "var(--ink-300)" }}>
          单击选中 / 双击跳转 / 拖拽排序
        </span>
      </div>

      {/* 时间轴条 */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(e) => setDraggingId(e.active.id as string)}
        onDragEnd={(e) => void handleDragEnd(e)}
        onDragCancel={() => setDraggingId(null)}
      >
        <SortableContext items={ordered.map((s) => s.id)} strategy={horizontalListSortingStrategy}>
          <div
            style={{
              position: "relative",
              height: 52,
              background: "var(--ink-50)",
              borderRadius: 8,
              overflow: "hidden",
              border: "1px solid var(--ink-100)",
              display: "flex",
            }}
          >
            {ordered.map((s, i) => {
              const durSec = s.duration_sec || 3;
              const widthPct = (durSec / totalDuration) * 100;
              return (
                <SortableShotBlock
                  key={s.id}
                  shot={s}
                  widthPct={widthPct}
                  isLast={i === ordered.length - 1}
                  isDraggingId={draggingId}
                  selected={selectedId === s.id}
                  onSelect={handleSelect}
                  onGoToShot={goToShot}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      {/* P1-4: 音波 waveform 可视化 (合成后视频才显示) */}
      {finalVideoUrl && (
        <WaveformCanvas videoUrl={finalVideoUrl} />
      )}

      {/* 图例 — 2026-05-25 合成 UI #10: 全就绪时只显"就绪",有未就绪时同时显两态.
          原永远两态导致 5/5 就绪时"待制作"图例无意义占位. */}
      {readyCount < ordered.length && (
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 10.5, color: "var(--ink-400)" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 14, height: 4, background: "var(--brand-500)", display: "inline-block", borderRadius: 2 }} />
            就绪
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 14, height: 4, background: "var(--ink-300)", display: "inline-block", borderRadius: 2 }} />
            待制作
          </span>
        </div>
      )}

      {/* 选中镜的 inline trim 详情 */}
      {selectedShot && (
        <SelectedShotTrim
          slug={slug}
          epId={epId}
          shot={selectedShot}
          onClose={() => setSelectedId(null)}
          onGoToShot={goToShot}
        />
      )}
    </div>
  );
}
