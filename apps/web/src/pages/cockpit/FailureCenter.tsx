// v24-batch-all · cockpit/FailureCenter · 接真 API (getFailures + ignoreFailure)
// 数据源: GET /api/v2/failures?since=7d → FailuresResponse
// 操作: PATCH /api/v2/failures/:id/ignore · 跳去对应 shot-stage 或 series
//
// 2026-05-19 优化 6: 多选 + 批量重试. 失败列表加 checkbox 选中, 底部弹批量操作 bar.
// "重试选中的 X 项" → 按 series_slug+episode_id 分组 → 启 startAutoPipeline + shot_ids
// 限定子集. 支持只重抽首帧 / 只重抽视频, 避免整集重跑.
import { useEffect, useMemo, useState } from "react";
import { useToggleSet } from "../../hooks/useToggleSet";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../components/shared/Icon";
import { PageTransition } from "../../components/studio/PageTransition";
import { Empty } from "../../components/ui/empty";
import { getFailures, ignoreFailure, type FailureItem } from "../../lib/api";
import { showErrorToast } from "../../lib/errorTranslate";
import { labelOfSource, labelOfErrorCode, labelShotId, labelEpisodeId, friendlyTaskError } from "../../lib/sourceLabels";
import { startAutoPipeline } from "../../lib/autoPipelineApi";
import { useConfirm } from "../../components/ui/ConfirmModal";
import { Button } from "../../components/ui/button";
import { formatRelativeTime, beijingHourOf } from "../../lib/format";

type Range = "24h" | "7d" | "30d";
type BulkRetryKind = "firstframes" | "videos";

// 2026-07-09 audit C-failurecenter: 范围切换原样渲染 "24h"/"7d"/"30d" 英文缩写(铁律 #9),
// 与设置页用量 section 的中文措辞(今日/近 7 天/本月)风格不一致. 内部 value 仍用 24h/7d/30d
// (API 参数不变), 展示一律走这份中文映射.
const RANGE_LABEL: Record<Range, string> = {
  "24h": "近 24 小时",
  "7d": "近 7 天",
  "30d": "近 30 天",
};

// 2026-05-26 audit #4: 删本地实现, import sourceLabels.ts 单一真理源 (与 CockpitPage 一致).
// 老格式 "第 1 镜" → 改用统一的 "分镜 1" — 跟系统其它地方一致.

// 2026-05-26 audit #4: 走统一 lib/format.ts:formatRelativeTime, 不再各页面各自一份.
const relTime = formatRelativeTime;

/**
 * 2026-05-26 audit #4 修复 — embedded 模式 (嵌入 SystemStatusPage 时跳过 PageTransition + 自己头部).
 */
export default function CockpitFailureCenter({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [range, setRange] = useState<Range>("7d");
  const [data, setData] = useState<{ failures: FailureItem[]; summary: Array<{ category: string; label: string; count: number }>; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 2026-05-19 优化 6: bulk retry — 多选 checkbox + 底部批量操作 bar
  const { ids: selectedIds, toggle: toggleSelected, clear: clearSelection, replace: replaceSelected, has: hasSelected, size: selectedCount } = useToggleSet<string>();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkToast, setBulkToast] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const res = await getFailures(range);
      setData({ failures: res.failures, summary: res.summary, total: res.total });
    } catch (err) {
      showErrorToast(err, "加载失败列表失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [range]);

  const hourDist = useMemo(() => {
    const arr = new Array(24).fill(0);
    if (!data) return arr;
    const now = new Date();
    for (const f of data.failures) {
      if (!f.created_at) continue;
      const t = new Date(f.created_at);
      if (isNaN(t.getTime())) continue;
      if (now.getTime() - t.getTime() > 86400 * 1000) continue;
      // 铁律(北京时间): 按小时分桶用北京时区, 不用浏览器本地时区
      const bh = beijingHourOf(t);
      if (bh >= 0) arr[bh] += 1;
    }
    return arr;
  }, [data]);
  const hourMax = Math.max(1, ...hourDist);

  const modelDist = useMemo(() => {
    if (!data) return [] as Array<{ n: string; fails: number }>;
    const m = new Map<string, number>();
    for (const f of data.failures) {
      // 2026-07-09 audit C-failurecenter: 之前按原始 provider 枚举分组、英文占位符 "(unknown)"
      // 兜底、渲染时原样显示技术 id(如 local_sdxl_openclaw), 违反铁律 #9. 改为直接按翻译后的
      // 中文名分组(labelOfSource 对 undefined 已返回"未知来源"), 避免不同技术 id 但同中文名
      // (如两个都落到"其他来源")被拆成重复行.
      const label = labelOfSource(f.provider);
      m.set(label, (m.get(label) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, fails]) => ({ n, fails }));
  }, [data]);

  const errCodes = useMemo(() => {
    if (!data) return [] as Array<{ code: string; n: number; pct: number; color: string }>;
    const total = data.total || 1;
    const colors = ["var(--err)", "var(--warn)", "var(--info)", "var(--brand-600)", "var(--ink-400)"];
    return data.summary.slice(0, 5).map((s, i) => ({
      code: s.label,
      n: s.count,
      pct: Math.round((s.count / total) * 100),
      color: colors[i] ?? "var(--ink-400)",
    }));
  }, [data]);

  const handleIgnore = async (id: string) => {
    setBusyId(id);
    try {
      await ignoreFailure(id);
      await reload();
    } catch (err) {
      showErrorToast(err, "忽略失败");
    } finally {
      setBusyId(null);
    }
  };

  const handleJumpTo = (f: FailureItem) => {
    if (f.series_slug && f.episode_id && f.shot_id) {
      navigate(`/studio/${f.series_slug}/shot-stage/${f.episode_id}/${f.shot_id}`);
    } else if (f.series_slug && f.episode_id) {
      navigate(`/studio/${f.series_slug}/storyboard/${f.episode_id}`);
    } else if (f.series_slug) {
      navigate(`/studio/${f.series_slug}`);
    }
  };

  // 2026-05-19 优化 6: 多选切换 + 全选 + 清空 — 现由 useToggleSet 提供

  // 2026-05-19 优化 6 + 2026-05-20 S8:
  // 批量重试选中的失败 — 按 series_slug+episode_id 分组, 每组启一个 pipeline.
  //
  // 设计:
  //   - 只有 shot_id+series_slug+episode_id 都有的 item 才能重试 (没分镜上下文的失败略过)
  //   - 按 episode 分组, 每组聚合 shot_ids 启一个 startAutoPipeline 调用
  //   - firstframes: only_firstframes=true, 只重抽选中的首帧
  //   - videos: only_videos=true, 只用已有首帧重抽选中的视频候选
  //   - 不带 provider_id — 让后端走 series.defaults; 用户改默认模型即生效
  //
  // 用户痛点 (任务原话): "整 stage 全重抽, 50 镜失败 2 镜也跑 50 次".
  const handleBulkRetry = async (kind: BulkRetryKind) => {
    const items = displayed.filter((f) => selectedIds.has(f.id) && f.series_slug && f.episode_id && f.shot_id);
    if (items.length === 0) {
      setBulkToast("选中的失败缺分镜上下文 — 无法重试");
      setTimeout(() => setBulkToast(null), 3000);
      return;
    }
    // 按 series_slug+episode_id 分组
    type Grp = { slug: string; epId: string; shotIds: string[]; count: number };
    const groups: Record<string, Grp> = {};
    for (const it of items) {
      const key = `${it.series_slug}::${it.episode_id}`;
      if (!groups[key]) groups[key] = { slug: it.series_slug!, epId: it.episode_id!, shotIds: [], count: 0 };
      if (!groups[key].shotIds.includes(it.shot_id!)) groups[key].shotIds.push(it.shot_id!);
      groups[key].count += 1;
    }
    const grpArr = Object.values(groups);
    const totalShots = grpArr.reduce((s, g) => s + g.shotIds.length, 0);

    const modeLabel = kind === "videos" ? "只重抽视频" : "只重抽首帧";
    const modeDescription = kind === "videos"
      ? "· 将启动后台生成任务, 用这些分镜已有首帧重抽视频候选\n· 不会重抽素材图 / 首帧, 也不会自动合成"
      : "· 将启动后台生成任务, 只重抽这些选中的分镜首帧\n· 不会动其他没失败的镜";
    const ok = await confirm({
      title: `${modeLabel}这 ${items.length} 项失败?`,
      description:
        `· 涉及 ${grpArr.length} 个剧集, 共 ${totalShots} 个分镜\n` +
        `${modeDescription}`,
      variant: "default",
      confirmLabel: `启动 ${grpArr.length} 个任务`,
    });
    if (!ok) return;

    setBulkBusy(true);
    let okCount = 0;
    let failCount = 0;
    for (const grp of grpArr) {
      try {
        await startAutoPipeline(grp.slug, grp.epId, {
          only_firstframes: kind === "firstframes" ? true : undefined,
          only_videos: kind === "videos" ? true : undefined,
          shot_ids: grp.shotIds,
          auto_pick_strategy: "quality_score",
        });
        okCount += 1;
      } catch (err) {
        failCount += 1;
        showErrorToast(err, `启动 ${grp.slug}/${grp.epId} 失败`);
      }
    }
    setBulkBusy(false);
    setBulkToast(`已启动 ${okCount} 个${modeLabel}任务${failCount > 0 ? ` · ${failCount} 个启动失败` : ""} — 在主界面进度面板查看`);
    setTimeout(() => setBulkToast(null), 5000);
    clearSelection();
  };

  const displayed = data?.failures ?? [];
  const retryTotal = displayed.filter((f) => f.retry_count > 0).length;
  // 2026-05-19 优化 6: 可重试 = 有分镜上下文(slug+ep+shot) 且 未忽略
  const retryableDisplayed = displayed.filter((f) => f.series_slug && f.episode_id && f.shot_id && !f.ignored);
  const allSelected = retryableDisplayed.length > 0 && retryableDisplayed.every((f) => hasSelected(f.id));

  const inner = (
      <div className="v24-failure-page" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-canvas)" }}>
        {/* 2026-05-26 audit #4: embedded 时由外壳渲染 mk-label/h1/title, 此处只保留功能性控件 (range / 全选 / refresh).
            非 embedded 时仍渲染完整 h2 + Icon 标题保持单页访问的语义. */}
        <div className="failure-toolbar" style={{ padding: "16px 24px", background: "#fff", borderBottom: "1px solid var(--ink-100)", display: "flex", alignItems: "center", gap: 12 }}>
          {!embedded && <Icon name="warning" size={18} style={{ color: "var(--err)" }} />}
          {!embedded && <h2 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 18, fontWeight: 600, color: "var(--ink-900)" }}>失败中心 · 全局</h2>}
          <span className="mk-pill mk-pill--failed" style={{ height: 22 }}>共 {data?.total ?? 0} 次 · 已重试 {retryTotal}</span>
          {/* 2026-05-19 优化 6: 全选 / 清空 — 只对"有分镜上下文 + 未忽略"的失败生效 */}
          {retryableDisplayed.length > 0 && (
            <label className="failure-select-all" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-600)", cursor: "pointer", userSelect: "none" }}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => {
                  if (allSelected) clearSelection();
                  else replaceSelected(retryableDisplayed.map((f) => f.id));
                }}
                style={{ accentColor: "var(--brand-600)", width: 14, height: 14 }}
              />
              <span>全选可重试 ({retryableDisplayed.length})</span>
            </label>
          )}
          <span className="failure-toolbar-spacer" style={{ flex: 1 }} />
          <div className="failure-range" aria-label="失败记录时间范围" style={{ display: "inline-flex", background: "var(--ink-50)", borderRadius: 8, padding: 2 }}>
            {(["24h", "7d", "30d"] as Range[]).map((r) => {
              const on = r === range;
              return (
                <button key={r} type="button" aria-pressed={on} onClick={() => setRange(r)} style={{
                  padding: "5px 12px", border: "none", background: on ? "#fff" : "transparent", borderRadius: 6,
                  fontSize: 11.5, fontWeight: 600, color: on ? "var(--ink-900)" : "var(--ink-500)", cursor: "pointer",
                }}>{RANGE_LABEL[r]}</button>
              );
            })}
          </div>
          <Button variant="secondary" size="sm" iconLeft="refresh" onClick={reload} disabled={loading} loading={loading}>
            {loading ? "加载中" : "刷新"}
          </Button>
        </div>

        <div className="mk-scroll" style={{ flex: 1, overflow: "auto", padding: 20 }}>
          <div className="failure-summary-grid" style={{ display: "grid", gap: 14, marginBottom: 18 }}>
            <div className="mk-card" style={{ padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-400)", textTransform: "uppercase", marginBottom: 10 }}>错误类目分布 · {RANGE_LABEL[range]}</div>
              {errCodes.length === 0 ? (
                <div style={{ fontSize: 11, color: "var(--ink-400)", padding: 10 }}>(暂无数据)</div>
              ) : errCodes.map((e, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, marginBottom: 3 }}>
                    <span style={{ flex: 1, color: "var(--ink-800)", fontWeight: 600 }}>{e.code}</span>
                    <span style={{ color: "var(--ink-500)", fontFamily: "ui-monospace, Consolas, monospace" }}>{e.n} · {e.pct}%</span>
                  </div>
                  <div style={{ height: 5, background: "var(--ink-100)", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: e.pct + "%", height: "100%", background: e.color, borderRadius: 999 }} />
                  </div>
                </div>
              ))}
            </div>

            <div className="mk-card" style={{ padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-400)", textTransform: "uppercase", marginBottom: 10 }}>失败模型分布</div>
              {modelDist.length === 0 ? (
                <div style={{ fontSize: 11, color: "var(--ink-400)", padding: 10 }}>(无)</div>
              ) : modelDist.map((m, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-800)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.n}</span>
                  <span style={{ fontSize: 10.5, color: "var(--ink-500)", fontFamily: "ui-monospace, Consolas, monospace" }}>{m.fails}</span>
                </div>
              ))}
            </div>

            <div className="mk-card" style={{ padding: 14 }}>
              {/* 2026-07-09 终验: 卡标题原硬编码裸英文缩写 "24h", 与本页范围切换按钮已改的
                  "近 24 小时" 中文措辞在同一屏自相矛盾(铁律 #8/#9), 这里同步改中文。 */}
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-400)", textTransform: "uppercase", marginBottom: 10 }}>近 24 小时分布</div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 80, marginBottom: 8 }}>
                {hourDist.map((h, i) => (
                  <div key={i} title={i + ":00 · " + h + " 次"} style={{ flex: 1, height: ((h / hourMax) * 100) + "%", minHeight: 2, background: h > 4 ? "var(--err)" : h > 0 ? "var(--brand-400)" : "var(--ink-100)", borderRadius: 1 }} />
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--ink-400)", fontFamily: "ui-monospace, Consolas, monospace" }}>
                <span>00:00</span><span>12:00</span><span>23:59</span>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="mk-card" style={{ padding: 40, textAlign: "center", color: "var(--ink-400)" }}>加载中…</div>
          ) : displayed.length === 0 ? (
            <Empty title="没有失败记录 · 稳" description="这个时间范围内所有任务都成功了" />
          ) : displayed.map((f) => {
            const retried = f.retry_count > 0;
            // 2026-05-19 优化 6: 可重试 = 有 slug+ep+shot 上下文 + 未忽略
            const canRetry = Boolean(f.series_slug && f.episode_id && f.shot_id && !f.ignored);
            const isSelected = hasSelected(f.id);
            const seriesLabel = f.series_title?.trim() || (f.series_slug ? "未命名系列" : "");
            return (
              <div key={f.id} className="mk-card failure-record" style={{ padding: 12, marginBottom: 8, display: "flex", alignItems: "center", gap: 12, background: isSelected ? "rgba(99,102,241,0.06)" : retried ? "#fff" : "rgba(200,60,60,0.02)", opacity: f.ignored ? 0.5 : 1, transition: "background 0.15s" }}>
                {/* 2026-05-19 优化 6: 多选 checkbox — 只对可重试的失败显示, 不可重试的位置留个占位免错位 */}
                {canRetry ? (
                  <input
                    className="failure-record-select"
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelected(f.id)}
                    style={{ accentColor: "var(--brand-600)", width: 16, height: 16, flexShrink: 0, cursor: "pointer" }}
                    aria-label={f.shot_id ? `选中失败的${labelShotId(f.shot_id)}` : "选中失败记录"}
                  />
                ) : (
                  <div className="failure-record-select" style={{ width: 16, height: 16, flexShrink: 0 }} />
                )}
                <div className="failure-record-icon" style={{ width: 36, height: 36, borderRadius: 999, background: retried ? "rgba(76,175,80,0.14)" : "rgba(244,67,54,0.14)", color: retried ? "var(--ok)" : "var(--err)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <Icon name={retried ? "check" : "close"} size={14} />
                </div>
                <div className="failure-record-context" style={{ width: 90, flexShrink: 0 }}>
                  <div style={{ fontSize: 10, color: "var(--ink-400)", fontFamily: "ui-monospace, Consolas, monospace" }}>{relTime(f.created_at)}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ink-600)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {seriesLabel ? `${seriesLabel} · ${labelEpisodeId(f.episode_id)}` : "—"}
                  </div>
                  {f.shot_id && <div style={{ fontSize: 10, color: "var(--brand-700)", fontWeight: 700 }}>{labelShotId(f.shot_id)}</div>}
                </div>
                <div className="failure-record-copy" style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: retried ? "var(--ink-700)" : "var(--ink-900)" }}>{f.category_label}</span>
                    {/* 2026-05-17 P2.3: error_code / provider 经 labelOfErrorCode / labelOfSource 翻成中文 (铁律 #9) */}
                    {f.error_code && <><span style={{ width: 3, height: 3, borderRadius: 3, background: "var(--ink-300)" }} /><span style={{ fontSize: 11, color: "var(--ink-600)" }}>{labelOfErrorCode(f.error_code)}</span></>}
                    {f.provider && <><span style={{ width: 3, height: 3, borderRadius: 3, background: "var(--ink-300)" }} /><span style={{ fontSize: 12, color: "var(--ink-700)" }}>{labelOfSource(f.provider)}</span></>}
                    {retried && <span className="mk-pill mk-pill--picked" style={{ height: 18, fontSize: 10 }}>已重试 {f.retry_count} 次</span>}
                    {f.ignored && <span className="mk-pill mk-pill--draft" style={{ height: 18, fontSize: 10 }}>已忽略</span>}
                  </div>
                  <div className="failure-record-message" style={{ fontSize: 11, color: "var(--ink-500)", lineHeight: 1.5, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {friendlyTaskError(f.error_message)}
                  </div>
                </div>
                <div className="failure-record-actions" style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {f.shot_id && <Button variant="secondary" size="sm" iconLeft="expand" onClick={() => handleJumpTo(f)}>查看</Button>}
                  {!f.ignored && <Button variant="ghost" size="sm" iconLeft="check" onClick={() => void handleIgnore(f.id)} disabled={busyId === f.id} loading={busyId === f.id}>忽略</Button>}
                </div>
              </div>
            );
          })}
        </div>

        {/* 2026-05-19 优化 6: 批量重试 — 底部固定操作栏, 仅在有选中时显示 */}
        {selectedCount > 0 && (
          <div
            className="failure-bulk-actions"
            style={{
              position: "sticky",
              bottom: 0,
              padding: "12px 24px",
              background: "rgba(255,255,255,0.96)",
              borderTop: "1px solid var(--ink-200)",
              boxShadow: "0 -4px 12px rgba(15,23,42,0.06)",
              display: "flex",
              alignItems: "center",
              gap: 12,
              zIndex: 10,
            }}
          >
            <span style={{ fontSize: 13, color: "var(--ink-700)", fontWeight: 600 }}>
              已选中 {selectedCount} 项
            </span>
            <Button variant="ghost" size="sm" iconLeft="close" onClick={clearSelection} disabled={bulkBusy}>
              清空选择
            </Button>
            <span style={{ flex: 1 }} />
            {bulkToast && (
              <span style={{ fontSize: 12, color: "var(--ink-600)" }}>{bulkToast}</span>
            )}
            {/* 铁律 #11: 按钮含图标 + 文字, 不允许 icon-only */}
            <Button
              variant="primary"
              size="sm"
              iconLeft="refresh"
              onClick={() => void handleBulkRetry("firstframes")}
              disabled={bulkBusy}
              loading={bulkBusy}
              title={`只重抽选中的 ${selectedCount} 镜首帧, 不影响其他没失败的镜`}
            >
              {bulkBusy ? "启动中…" : `只重抽首帧 ${selectedCount} 项`}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconLeft="video"
              onClick={() => void handleBulkRetry("videos")}
              disabled={bulkBusy}
              loading={bulkBusy}
              title={`只用已有首帧重抽选中的 ${selectedCount} 镜视频, 不重抽其他阶段`}
            >
              {bulkBusy ? "启动中…" : `只重抽视频 ${selectedCount} 项`}
            </Button>
          </div>
        )}
      </div>
  );

  // 2026-05-26 audit #4: 嵌入时跳过 PageTransition 避免双层 framer-motion 动画卡顿.
  return embedded ? inner : <PageTransition>{inner}</PageTransition>;
}
