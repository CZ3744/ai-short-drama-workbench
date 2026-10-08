// v24-batch-all · PickerFullscreenView · 接真 API · 按 b2-3 视觉
// 数据源: useShots(slug, epId) 直接读 first_frame_candidates;
// 操作: shotApi.patchFirstFrameCandidate(sid, cid, action)
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../../components/shared/Icon";
import { Empty } from "../../components/ui/empty";
import { useShots, type Shot, type ShotCandidate } from "../../hooks/useShots";
import { candidateOriginalUrl } from "../../lib/imageThumb";
import { candidateRichLabel } from "../../components/shared/CandidateLabel";

export interface PickerFullscreenViewProps { slug: string; epId: string; className?: string; aspectRatio?: string; }

function findShotIdx(shots: Shot[], shotId: string | null): number {
  if (!shotId) return 0;
  const i = shots.findIndex((s) => s.id === shotId);
  return i >= 0 ? i : 0;
}

export function PickerFullscreenView({ slug, epId, className, aspectRatio = "16/9" }: PickerFullscreenViewProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { shots, isLoading } = useShots(slug, epId);

  const shotId = searchParams.get("shot");
  const shotIdx = useMemo(() => findShotIdx(shots, shotId), [shots, shotId]);
  const shot: Shot | undefined = shots[shotIdx];
  const cands: ShotCandidate[] = shot?.first_frame_candidates ?? [];
  const pickedId = shot?.picked_first_frame_id ?? null;
  const initialCandIdx = pickedId ? Math.max(0, cands.findIndex((c) => c.id === pickedId)) : 0;
  const [candIdx, setCandIdx] = useState(initialCandIdx);

  useEffect(() => { setCandIdx(initialCandIdx); }, [shot?.id, initialCandIdx]);

  const cur = cands[candIdx];

  const exitPicker = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("shot");
    next.set("view", "card");
    setSearchParams(next, { replace: true });
  };

  // 2026-05-17: 页面级键盘业务操作已移除,操作请走可见按钮(顶部"退出"/"上一张"/"下一张"等)。
  // BUG-19 fix: 用 ref 存储最新 exitPicker，避免 useEffect stale closure
  const exitPickerRef = useRef(exitPicker);
  exitPickerRef.current = exitPicker;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitPickerRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (isLoading) {
    return (
      <div className={"v24-picker-fullscreen " + (className ?? "")} style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", background: "var(--ink-950)", color: "#fff" }}>
        <span style={{ fontSize: 13 }}>加载中…</span>
      </div>
    );
  }

  if (!shot || cands.length === 0) {
    return (
      <div className={"v24-picker-fullscreen " + (className ?? "")} style={{ width: "100%", height: "100%", display: "grid", placeItems: "center", background: "var(--ink-950)" }}>
        <Empty title="暂无候选可挑选" description="请先在 Stage2 抽首帧" cta="退出挑卡" onCta={exitPicker} />
      </div>
    );
  }

  return (
    <div className={"v24-picker-fullscreen " + (className ?? "")} style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--ink-950)" }}>
      {/* 顶部条 */}
      <div style={{ padding: "12px 24px", background: "rgba(26,24,22,0.9)", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 14, color: "#fff" }}>
        {/* W8-sweep (2026-05-16): icon-only → icon + 文字 (铁律 #11) */}
        {/* 保留原因: dark-theme fullscreen picker 上下文 — 半透明白底 + 白字反色 ghost,Button 组件无对应变体 */}
        <button
          onClick={exitPicker}
          title="退出全屏挑卡"
          style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.18)", color: "#fff", borderRadius: 8, padding: "0 10px", height: 30, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12 }}
        >
          <Icon name="back" size={14} /> 退出
        </button>
        <div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)" }}>挑卡全屏 · 键盘流</div>
          <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "'Noto Serif SC', serif" }}>
            第 {shotIdx + 1} 镜 · {shot.action_description?.slice(0, 30) || "—"}
          </div>
        </div>
        <span style={{ marginLeft: 14, fontSize: 12, color: "rgba(255,255,255,0.5)" }}>
          {shotIdx + 1} / {shots.length} · cand {candIdx + 1} / {cands.length}
        </span>
        <span style={{ flex: 1 }} />
        {/* 保留原因: dark-theme 上下文 + 胶囊形 (borderRadius 999) + 半透明白底反色 */}
        <button onClick={exitPicker} style={{ height: 28, padding: "0 12px", borderRadius: 999, background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>退出 (Esc)</button>
      </div>

      {/* 主预览 */}
      <div style={{ flex: 1, display: "grid", placeItems: "center", position: "relative", minHeight: 0 }}>
        {/* A 类内容图:Picker 全屏主预览,用 img 支持右键复制 */}
        {/* 2026-05-27 bugfix: 走 candidateOriginalUrl 拿原图 /raw, 用户在挑卡全屏页
            做最终决策, cur.url 在 asset-only 候选下是 64px thumbnail — 跟 lightbox 同款 bug. */}
        {cur ? (
          <img
            src={candidateOriginalUrl(slug, cur)}
            alt={cur?.display_name?.trim() || `候选 ${candIdx + 1}`}
            title="点击放大 / 右键可复制图片"
            style={{ width: "62%", aspectRatio, borderRadius: 8, boxShadow: "0 16px 48px rgba(0,0,0,0.6)", objectFit: "cover", display: "block" }}
          />
        ) : (
          <div style={{ width: "62%", aspectRatio, borderRadius: 8, boxShadow: "0 16px 48px rgba(0,0,0,0.6)", background: "var(--ink-800)" }} />
        )}
        {/* 保留原因 (上/下一张): 绝对定位悬浮于主预览图两侧 (position: absolute, left/right + transform translateY) + 胶囊形 borderRadius 999 + dark-theme 反色 */}
        <button onClick={() => setCandIdx((i) => Math.max(0, i - 1))} disabled={candIdx === 0}
          aria-label="上一张候选" title="上一张"
          style={{ position: "absolute", left: 28, top: "50%", transform: "translateY(-50%)", width: "auto", height: 44, borderRadius: 999, background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.18)", color: "#fff", cursor: candIdx === 0 ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 16px", opacity: candIdx === 0 ? 0.4 : 1 }}>
          <Icon name="chevLeft" size={18} /><span style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>上一张</span>
        </button>
        <button onClick={() => setCandIdx((i) => Math.min(cands.length - 1, i + 1))} disabled={candIdx >= cands.length - 1}
          aria-label="下一张候选" title="下一张"
          style={{ position: "absolute", right: 28, top: "50%", transform: "translateY(-50%)", width: "auto", height: 44, borderRadius: 999, background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.18)", color: "#fff", cursor: candIdx >= cands.length - 1 ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 16px", opacity: candIdx >= cands.length - 1 ? 0.4 : 1 }}>
          <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap" }}>下一张</span><Icon name="chevRight" size={18} />
        </button>
        {cur?.prompt_used || cur?.prompt ? (
          <div style={{ position: "absolute", top: 20, left: 24, padding: "10px 14px", borderRadius: 12, background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: 12, lineHeight: 1.5, maxWidth: 360, backdropFilter: "blur(8px)" }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "rgba(255,255,255,0.5)", marginBottom: 4, textTransform: "uppercase" }}>当前 prompt</div>
            {(cur.prompt_used || cur.prompt).slice(0, 200)}
          </div>
        ) : null}
        {pickedId === cur?.id && (
          <div style={{ position: "absolute", top: 20, right: 24, padding: "6px 14px", borderRadius: 999, background: "var(--brand-500)", color: "#fff", fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Icon name="check" size={12} />已选定
          </div>
        )}
      </div>

      {/* 底部候选条 */}
      <div style={{ padding: "16px 24px", background: "rgba(26,24,22,0.9)", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", marginBottom: 12, flexWrap: "wrap" }}>
          {cands.map((c, i) => (
            <div key={c.id} onClick={() => setCandIdx(i)} style={{
              width: 120, aspectRatio, borderRadius: 5, overflow: "hidden", position: "relative", cursor: "pointer",
              border: c.id === pickedId ? "2px solid var(--brand-500)" : i === candIdx ? "2px solid rgba(255,255,255,0.6)" : "1px solid rgba(255,255,255,0.18)",
              background: !(c.thumbnail || c.url) ? "var(--ink-800)" : undefined,
            }}>
              {/* A 类内容图：底部候选缩略图条，用 img 支持右键复制 */}
              {(c.thumbnail || c.url) && (
                <img
                  src={c.thumbnail || c.url}
                  alt={c.display_name?.trim() || `候选 v${i + 1}`}
                  title="点击放大 / 右键可复制图片"
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              )}
              {c.id === pickedId && <span style={{ position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: 999, background: "var(--brand-500)", color: "#fff", fontSize: 10, fontWeight: 700, display: "grid", placeItems: "center" }}>✓</span>}
              {/* 2026-07-22 X5-1 (A4-2): 裸序号 v{i+1} → display_name 优先的 fallback 链 (铁律 #2), 长名截断 + title 兜底 */}
              <span
                title={candidateRichLabel(c, { index: i + 1, total: cands.length })}
                style={{
                  position: "absolute", bottom: 4, left: 4, right: 4,
                  padding: "1px 6px", borderRadius: 999,
                  background: "rgba(0,0,0,0.7)", color: "#fff", fontSize: 9,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  textAlign: "center",
                }}
              >
                {candidateRichLabel(c, { index: i + 1, total: cands.length })}
              </span>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}
