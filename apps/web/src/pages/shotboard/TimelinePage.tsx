// v24-batch-all · TimelinePage · 接真 API (useShots 派生时间线)
// 后端暂无独立 /timeline endpoint, 本页从 shots 聚合 (按 index 排序 · 累加 duration_sec)
// 来源视觉: design-skill/video-generate/src/batch3.jsx:1575-1695 (b4m-1)
import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Icon } from "../../components/shared/Icon";
import { PageTransition } from "../../components/studio/PageTransition";
import { Empty } from "../../components/ui/empty";
import { useShots, type Shot } from "../../hooks/useShots";
import { useEpisode } from "../../hooks/useEpisode";
import { useSeries } from "../../hooks/useSeries";
import { seriesAspectToCss } from "../../lib/aspectRatio";
import { Button } from "../../components/ui/button";

interface TrackSpec {
  key: "video" | "subtitle" | "tts" | "bgm";
  label: string;
  color: string;
  height: number;
}

const TRACKS: TrackSpec[] = [
  { key: "video",    label: "视频", color: "var(--brand-500)", height: 50 },
  { key: "subtitle", label: "字幕稿", color: "var(--info)",       height: 26 },
  { key: "tts",      label: "配音稿",  color: "var(--ok)",         height: 26 },
  { key: "bgm",      label: "背景音乐",  color: "#a14826",           height: 26 },
];

function formatTimecode(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function shotThumb(s: Shot): { url: string; displayName: string } | undefined {
  const p = s.first_frame_candidates.find((c) => c.id === s.picked_first_frame_id);
  const hit = p ?? s.first_frame_candidates[0];
  const url = hit?.thumbnail ?? hit?.url;
  if (!url) return undefined;
  return {
    url,
    displayName: hit?.display_name?.trim() || hit?.prompt?.slice(0, 20) || "首帧图",
  };
}

export default function TimelinePage() {
  const { slug, epId } = useParams<{ slug: string; epId: string }>();
  const navigate = useNavigate();
  const { shots, isLoading } = useShots(slug, epId);
  const { data: episode } = useEpisode(slug, epId);
  const { data: series } = useSeries(slug);
  const aspectRatio = seriesAspectToCss(series?.defaults?.aspect_ratio);
  const [cursorIdx, setCursorIdx] = useState(0);
  useEffect(() => setCursorIdx(0), [slug, epId]);

  const sorted = useMemo(() => shots.slice().sort((a, b) => a.index - b.index), [shots]);

  const aggregate = useMemo(() => {
    const segs: Array<{ shot: Shot; start: number; end: number }> = [];
    let cur = 0;
    for (const s of sorted) {
      const dur = s.duration_sec || 0;
      segs.push({ shot: s, start: cur, end: cur + dur });
      cur += dur;
    }
    return { segs, total: cur };
  }, [sorted]);

  const totalSec = aggregate.total;
  const readyCount = useMemo(
    () => sorted.filter((s) => s.picked_video_id && s.status === "approved").length,
    [sorted],
  );
  const selectedIdx = Math.min(cursorIdx, Math.max(0, sorted.length - 1));
  const cursor = aggregate.segs[selectedIdx];
  const cursorPct = totalSec > 0 && cursor ? (cursor.start / totalSec) * 100 : 0;
  const cursorTime = cursor?.start ?? 0;
  const currentShot = cursor?.shot;
  const currentThumbData = currentShot ? shotThumb(currentShot) : undefined;
  const currentThumb = currentThumbData?.url;

  if (!slug || !epId) {
    return <div className="flex min-h-screen items-center justify-center p-6"><Empty title="先选择一个剧集" description="从作品的分集列表进入，查看镜头顺序和计划时长。" cta="选择作品" onCta={() => navigate("/studio")} /></div>;
  }

  return (
    <PageTransition>
      <div className="v24-timeline-page" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-canvas)" }}>
        {/* TopBar */}
        <div style={{ padding: "14px 24px", background: "var(--surface-card)", borderBottom: "1px solid var(--ink-100)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 18, fontWeight: 600, color: "var(--ink-900)" }}>
            分镜时间线 · {episode?.title ?? "当前剧集"}
          </h2>
          <span className={`mk-pill ${sorted.length > 0 && readyCount === sorted.length ? "mk-pill--ready" : "mk-pill--draft"}`} style={{ height: 22 }}>{readyCount} / {sorted.length} 镜就绪</span>
          <span style={{ fontSize: 12, color: "var(--ink-500)" }} title="按镜头计划时长估算，实际成片时长以合成结果为准">计划时长 {formatTimecode(totalSec)}</span>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" size="sm" iconLeft="eye" onClick={() => navigate(`/studio/${slug}/storyboard/${epId}`)}>
            卡片视图
          </Button>
          <Button variant="primary" iconLeft="film" onClick={() => navigate(`/studio/${slug}/compose/${epId}`)}>
            去合成
          </Button>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* 预览区 */}
          <div style={{ flex: 1, background: currentThumb ? "var(--ink-900)" : "var(--surface-canvas)", display: "grid", placeItems: "center", position: "relative", minHeight: 260, padding: 24 }}>
            {isLoading ? (
              <span role="status" style={{ color: "var(--ink-500)", fontSize: 12 }}>正在载入镜头…</span>
            ) : !currentShot ? (
              <Empty icon={<Icon name="film" size={40} />} title="把故事排成镜头" description="添加或导入分镜后，就能在这里检查顺序、对白和计划节奏。" cta="去分镜板" onCta={() => navigate(`/studio/${slug}/storyboard/${epId}`)} />
            ) : (
              <>
                {/* A 类内容图：当前镜头主预览，用 img 支持右键复制 */}
                {currentThumb ? (
                  <img
                    src={currentThumb}
                    alt={currentThumbData?.displayName || `第 ${cursorIdx + 1} 镜`}
                    title="本镜首帧预览；右键可复制图片"
                    style={{ width: "100%", maxWidth: 680, maxHeight: "42vh", aspectRatio: aspectRatio, borderRadius: 12, objectFit: "contain", display: "block" }}
                  />
                ) : (
                  <div className="mk-card" style={{ width: "100%", maxWidth: 540, padding: "30px 24px", textAlign: "center" }}>
                    <Icon name="image" size={32} style={{ color: "var(--brand-500)", marginBottom: 12 }} />
                    <h3 style={{ margin: "0 0 8px", fontSize: 18, color: "var(--ink-900)" }}>{currentShot.title || `第 ${selectedIdx + 1} 镜`}</h3>
                    <p style={{ fontSize: 13, color: "var(--ink-600)", lineHeight: 1.7, margin: "0 0 8px" }}>{currentShot.action || "故事已规划好，接下来为这个镜头添加画面。"}</p>
                    <p style={{ fontSize: 12, color: "var(--ink-500)", margin: "0 0 18px" }}>本镜还没有首帧预览。可以生成画面，也可以导入已有素材。</p>
                    <Button iconLeft="image" onClick={() => navigate(`/studio/${slug}/shot-stage/${epId}/${currentShot.id}`)}>制作本镜</Button>
                  </div>
                )}
                {currentThumb && <div style={{ position: "absolute", top: 16, right: 20, padding: "4px 10px", background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: 11, borderRadius: 6 }}>
                  第 {selectedIdx + 1} 镜 · 计划位置 {formatTimecode(cursorTime)}
                </div>}
              </>
            )}
          </div>

          {/* 时间线轨道 */}
          <div style={{ flexShrink: 0, background: "var(--surface-card)", borderTop: "1px solid var(--ink-100)", padding: "12px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <Button variant="secondary" size="sm" iconLeft="back" onClick={() => setCursorIdx(Math.max(0, selectedIdx - 1))} disabled={selectedIdx === 0}>上一镜</Button>
              <Button variant="secondary" size="sm" iconLeft="chevRight" onClick={() => setCursorIdx(Math.min(sorted.length - 1, selectedIdx + 1))} disabled={selectedIdx >= sorted.length - 1}>下一镜</Button>
              <span style={{ fontSize: 12, color: "var(--ink-700)", fontFamily: "ui-monospace, Consolas, monospace", fontWeight: 600 }}>
                {formatTimecode(cursorTime)} / {formatTimecode(totalSec)}
              </span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: "var(--ink-400)" }}>点击镜头查看 · 此处显示计划，成片在合成页播放</span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 10, fontSize: 10.5 }}>
              {TRACKS.map((tr) => (
                <Fragment key={tr.key}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 8, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", color: "var(--ink-500)", textTransform: "uppercase" }}>{tr.label}</div>
                  <div style={{ position: "relative", height: tr.height, background: "var(--ink-50)", borderRadius: 6, overflow: "hidden" }}>
                    {/* 视频轨: 渲染每个镜头的缩略图 */}
                    {tr.key === "video" && aggregate.segs.map((seg, j) => {
                      const leftPct = totalSec > 0 ? (seg.start / totalSec) * 100 : 0;
                      const widthPct = totalSec > 0 ? ((seg.end - seg.start) / totalSec) * 100 : 0;
                      const thumbData = shotThumb(seg.shot);
                      const url = thumbData?.url;
                      const isCurrent = j === selectedIdx;
                      return (
                        <button type="button" aria-pressed={isCurrent}
                          key={seg.shot.id}
                          onClick={() => setCursorIdx(j)}
                          aria-label={`${seg.shot.title || `第 ${j + 1} 镜`}，计划 ${seg.shot.duration_sec} 秒`}
                          title={`${seg.shot.title || `第 ${j + 1} 镜`} · 计划 ${seg.shot.duration_sec} 秒`}
                          style={{ position: "absolute", left: leftPct + "%", top: 2, bottom: 2, width: widthPct + "%", padding: "0 1px", cursor: "pointer", border: 0, background: "transparent" }}
                        >
                          {/* A 类内容图：时间轴缩略图格，用 img 支持右键复制 */}
                          {url ? (
                            <img
                              src={url}
                              alt={thumbData?.displayName || `第 ${j + 1} 镜`}
                              title="点击放大 / 右键可复制图片"
                              style={{ width: "100%", height: "100%", borderRadius: 3, objectFit: "cover", display: "block", border: isCurrent ? "1.5px solid var(--brand-500)" : "1px solid var(--ink-200)" }}
                            />
                          ) : (
                            <div style={{ width: "100%", height: "100%", borderRadius: 5, border: isCurrent ? "1.5px solid var(--brand-500)" : "1px solid var(--ink-200)", background: "var(--ink-50)", display: "grid", placeItems: "center", color: "var(--ink-600)", overflow: "hidden", fontSize: 11 }}><span>第 {j + 1} 镜</span></div>
                          )}
                        </button>
                      );
                    })}

                    {/* 字幕轨: 有 dialogue/voiceover 的镜头显示色条 */}
                    {tr.key === "subtitle" && aggregate.segs.map((seg) => {
                      const has = Boolean(seg.shot.dialogue || seg.shot.voiceover);
                      if (!has || totalSec <= 0) return null;
                      const leftPct = (seg.start / totalSec) * 100;
                      const widthPct = ((seg.end - seg.start) / totalSec) * 100;
                      return (
                        <div key={seg.shot.id} style={{ position: "absolute", left: leftPct + "%", top: 5, bottom: 5, width: widthPct + "%", padding: "0 1px" }}>
                          <div style={{ width: "100%", height: "100%", background: tr.color, opacity: 0.7, borderRadius: 3 }} />
                        </div>
                      );
                    })}

                    {/* TTS 轨: 有 voiceover 的镜头显示 */}
                    {tr.key === "tts" && aggregate.segs.map((seg) => {
                      const has = Boolean(seg.shot.voiceover || seg.shot.dialogue);
                      if (!has || totalSec <= 0) return null;
                      const leftPct = (seg.start / totalSec) * 100;
                      const widthPct = ((seg.end - seg.start) / totalSec) * 100;
                      return (
                        <div key={seg.shot.id} style={{ position: "absolute", left: leftPct + "%", top: 5, bottom: 5, width: widthPct + "%", padding: "0 1px" }}>
                          <div style={{ width: "100%", height: "100%", background: tr.color, opacity: 0.5, borderRadius: 3 }} />
                        </div>
                      );
                    })}

                    {/* 2026-05-25 — BGM 轨原默认全时段棕色色条假占位, 但 BGM 库 B-5 Backlog 实际合成无 BGM,
                        用户看着像有实际没 → 违反铁律 #5 真实状态精确. 改成空状态引导文字, 让用户去
                        合成设置面板填"BGM 风格"才在时间线显出. (合成时后端真用 bgmMood 字段) */}
                    {tr.key === "bgm" && totalSec > 0 && (
                      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ fontSize: 9.5, color: "var(--ink-400)", fontStyle: "italic" }}>
                          到合成页选择音乐，在成片中试听
                        </span>
                      </div>
                    )}

                    {/* Playhead cursor */}
                    <div style={{ position: "absolute", left: cursorPct + "%", top: -3, bottom: -3, width: 2, background: "var(--ok)", zIndex: 2 }} />
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      </div>
    </PageTransition>
  );
}
