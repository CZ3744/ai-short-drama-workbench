// v24-batch-all · CockpitPage · 接真 API (useTasksStore + getFailures + getSecretsStatus + listVault)
// 数据源:
//   RUNNING / QUEUE      → useTasksStore.events (SSE 实时)
//   SHOT_STATES          → 未指定系列时显示全局 7 天失败 + Vault 概览
//   LOGS                 → useTasksStore.events 最近事件 + 最近 failures
//   本月开销             → listVault.entries cost_cny 汇总
//   Provider 状态        → getSecretsStatus (key 是否存在)
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../../components/shared/Icon";
import { PageTransition } from "../../components/studio/PageTransition";
import { useTasksStore, type TaskEvent } from "../../stores/tasksStore";
// 2026-07-09 audit C29/C32: 补 labelOfStatus (任务状态人话) + friendlyTaskError (原始报错人话).
import { labelOfStage, labelShotId, labelOfStatus, friendlyTaskError } from "../../lib/sourceLabels";
import {
  getFailures, listVault, getSecretsStatus, getRealVideoLockStatus,
  getVaultCostStats, listSeries,
  type FailureItem, type VaultEntry, type VaultCostStats,
} from "../../lib/api";
import { labelOfSource } from "../../lib/sourceLabels";
import { showErrorToast } from "../../lib/errorTranslate";
import { Button } from "../../components/ui/button";
import { formatRelativeTime, formatBeijingTime } from "../../lib/format";

const PROVIDER_NAMES: Record<string, string> = {
  dashscope: "DashScope · 通义",
  bytedance: "字节即梦",
  minimax: "MiniMax 海螺",
  bfl: "BFL · FLUX",
  anthropic: "Anthropic",
  ikuncode: "IKunCode",
  tencent: "腾讯元宝",
  volc: "火山引擎",
  replicate: "Replicate",
  openai: "OpenAI",
  ikuncode_claude: "IKunCode Claude",
  mimo: "MiMo",
  deepseek: "DeepSeek",
  custom_openai_compat: "自定义兼容接口",
  openrouter: "OpenRouter",
  codex: "订阅图像服务",
  jimeng: "即梦",
  kling: "可灵",
  vidu: "Vidu",
  video: "视频服务",
  image: "图像服务",
  aliyun_wan: "阿里万相",
};

function formatCny(n: number): string {
  return "¥" + n.toFixed(2);
}

// 2026-05-26 audit #4: 走统一 lib/format.ts:formatRelativeTime, 不再各页面各自一份.
const relTime = formatRelativeTime;

/**
 * 2026-05-26 audit #4 修复 — embedded 模式 (嵌入 SystemStatusPage 时跳过 PageTransition + 自己头部).
 */
export default function CockpitPage({ embedded = false }: { embedded?: boolean } = {}) {
  const navigate = useNavigate();
  const events = useTasksStore((s) => s.events);
  const runningCount = useTasksStore((s) => s.runningCount);
  const queuedCount = useTasksStore((s) => s.queuedCount);

  const [failures, setFailures] = useState<FailureItem[]>([]);
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[]>([]);
  const [secrets, setSecrets] = useState<Record<string, boolean>>({});
  const [lock, setLock] = useState<{ locked: boolean; provider?: string; shot_id?: string } | null>(null);
  const [costStats, setCostStats] = useState<VaultCostStats | null>(null);
  const [loading, setLoading] = useState(true);
  // 2026-07-09 audit C-cockpit: by_series 只带 series_slug(技术标识), 铁律 #9 要求显示系列标题.
  // 试过复用 sessionStore.seriesList, 但它只在用户实际打开过 SeriesDetail 时才会被填充(StudioHome
  // 列表页并不写它), 覆盖率太低几乎等于没修. 改成跟其余数据一样, 页面自己拉一次权威的全量系列列表.
  const [seriesTitleBySlug, setSeriesTitleBySlug] = useState<Record<string, string>>({});

  const reload = async () => {
    setLoading(true);
    try {
      const [f, v, s, l, c, sr] = await Promise.allSettled([
        getFailures("24h"),
        listVault({ limit: 60, status: "active" }),
        getSecretsStatus(),
        getRealVideoLockStatus(),
        getVaultCostStats(),
        listSeries(),
      ]);
      if (f.status === "fulfilled") setFailures(f.value.failures);
      if (v.status === "fulfilled") setVaultEntries(v.value.entries);
      if (c.status === "fulfilled") setCostStats(c.value.stats);
      if (s.status === "fulfilled") {
        const status = s.value as unknown as Record<string, { key_present?: boolean }>;
        const flat: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(status)) {
          if (v == null || typeof v !== "object") continue;
          if ("key_present" in v && typeof v.key_present === "boolean") flat[k] = v.key_present;
        }
        setSecrets(flat);
      }
      if (l.status === "fulfilled") setLock(l.value as { locked: boolean; provider?: string; shot_id?: string });
      if (sr.status === "fulfilled") {
        const bySlug: Record<string, string> = {};
        for (const item of sr.value.series) bySlug[item.slug] = item.title;
        setSeriesTitleBySlug(bySlug);
      }
    } catch (err) {
      showErrorToast(err, "加载驾驶舱失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  const running: TaskEvent[] = useMemo(() => Object.values(events).filter((e) => e.status === "running").slice(0, 5), [events]);
  const queued: TaskEvent[] = useMemo(() => Object.values(events).filter((e) => e.status === "queued").slice(0, 8), [events]);
  const recentDone: TaskEvent[] = useMemo(() => Object.values(events).filter((e) => e.status === "completed" || e.status === "failed").sort((a, b) => b.timestamp - a.timestamp).slice(0, 8), [events]);

  // 2026-05-25 C1: 旧 monthCost 仅 60 条 limit, 用 costStats.this_month_cny / total_cny 替代 (覆盖全部活跃).
  // 保留兜底: 后端 stats 没回来时显示 vaultEntries 60 条求和 (不至于空白).
  const monthCostFallback = useMemo(() => vaultEntries.reduce((acc, e) => acc + (e.cost_cny ?? 0), 0), [vaultEntries]);
  const providers = useMemo(() => {
    const keys = Object.keys(secrets);
    if (keys.length === 0) return [] as Array<{ n: string; ok: boolean; err?: string }>;
    return keys.map((k) => ({
      n: PROVIDER_NAMES[k] ?? labelOfSource(k),
      ok: Boolean(secrets[k]),
      err: secrets[k] ? undefined : "未配置 key",
    }));
  }, [secrets]);

  const logLines = useMemo(() => {
    const lines: Array<{ t: string; lvl: "info" | "warn" | "err"; msg: string }> = [];
    for (const e of recentDone) {
      // 2026-07-09 audit C29: shot_id/stage/status 之前原样拼接英文枚举 + hash 后缀, 统一走
      // labelShotId/labelOfStage/labelOfStatus (与下方失败列表 line 213 单一真理源对齐).
      lines.push({
        t: formatBeijingTime(e.timestamp, { mode: "time" }),
        lvl: e.status === "failed" ? "err" : "info",
        msg: `${e.shot_id ? labelShotId(e.shot_id) + " " : ""}${labelOfStage(e.stage)} ${labelOfStatus(e.status)}${e.message ? " · " + e.message : ""}`,
      });
    }
    for (const f of failures.slice(0, 6)) {
      // 2026-07-09 audit C29: 之前这里拼 `分镜 ${f.shot_id}` 原样带 hash 后缀 (如 "分镜 s0001_49d1"),
      // 跟本注释承诺的"不显示 hash 片段"自相矛盾, 也跟下方"最近失败"列表(labelShotId)不一致.
      // 统一走 labelShotId, 真正做到不暴露 hash 片段.
      const subject = f.shot_id ? labelShotId(f.shot_id) : "(未知分镜)";
      lines.push({
        t: f.created_at ? formatBeijingTime(f.created_at, { mode: "time" }) : "--:--:--",
        lvl: "err",
        // 2026-07-09 audit C32: error_message 是后端原始报错 (可能含 HTTP 状态行/HTML/英文), 过
        // friendlyTaskError 翻人话, 不再裸截断.
        msg: `${subject} · ${f.category_label} · ${friendlyTaskError(f.error_message)}`,
      });
    }
    for (const e of running.slice(0, 4)) {
      lines.push({
        t: formatBeijingTime(e.timestamp, { mode: "time" }),
        lvl: "info",
        msg: `${e.shot_id ? labelShotId(e.shot_id) + " " : ""}${labelOfStage(e.stage)} progress=${Math.round((e.progress ?? 0) * 100)}%`,
      });
    }
    return lines.sort((a, b) => b.t.localeCompare(a.t)).slice(0, 12);
  }, [running, recentDone, failures]);

  const inner = (
      <div className="v24-cockpit-page" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-canvas)" }}>
        {/* 2026-05-26 audit #4: embedded 时由外壳 SystemStatusPage 统一渲染头部, 内部跳过双层. */}
        {!embedded && (
          <div style={{ padding: "16px 24px", background: "#fff", borderBottom: "1px solid var(--ink-100)", display: "flex", alignItems: "center", gap: 16 }}>
            <h2 style={{ margin: 0, fontFamily: "'Noto Serif SC', serif", fontSize: 18, fontWeight: 600, color: "var(--ink-900)" }}>生产驾驶舱</h2>
            <span className="mk-pill mk-pill--generating" style={{ height: 22 }}>{runningCount} 个进行中</span>
            <span style={{ fontSize: 12, color: "var(--ink-500)" }}>
              队列 {queuedCount} · 真实视频锁 {lock?.locked
                ? `占用 (${lock.provider ? (PROVIDER_NAMES[lock.provider] ?? lock.provider) : "生成中"})`
                : "空闲"}
            </span>
            <span style={{ flex: 1 }} />
            <Button variant="secondary" size="sm" iconLeft="refresh" onClick={reload} disabled={loading} loading={loading}>
              {loading ? "加载中" : "刷新"}
            </Button>
          </div>
        )}

        <div className="mk-scroll" style={{ flex: 1, overflow: "auto", padding: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 16 }}>
            {/* 左 · 进行中 + 队列 */}
            <div className="mk-card" style={{ padding: 14, height: "fit-content" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <Icon name="bolt" size={14} style={{ color: "var(--brand-600)" }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-800)" }}>进行中</span>
                <span className="mk-chip mk-chip--brand" style={{ height: 18, fontSize: 10 }}>{running.length}</span>
              </div>
              {running.length === 0 ? (
                <div style={{ fontSize: 11.5, color: "var(--ink-400)", padding: "10px 0" }}>(暂无任务在跑)</div>
              ) : running.map((j, i) => (
                <div key={j.jobId} style={{ padding: "10px 0", borderBottom: i < running.length - 1 ? "1px solid var(--ink-100)" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: "var(--brand-700)", background: "var(--brand-50)", padding: "2px 6px", borderRadius: 999 }}>{j.shot_id ? labelShotId(j.shot_id) : "任务"}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-800)" }}>{labelOfStage(j.stage)}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, color: "var(--ink-500)", marginBottom: 6 }}>
                    <span style={{ fontFamily: "ui-monospace, Consolas, monospace" }}>{Math.round((j.progress ?? 0) * 100)}%</span>
                    {j.message && <><span>·</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.message}</span></>}
                  </div>
                  <div style={{ height: 6, background: "var(--ink-100)", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: Math.round((j.progress ?? 0) * 100) + "%", height: "100%", background: "linear-gradient(90deg, var(--brand-400), var(--brand-600))", borderRadius: 999 }} />
                  </div>
                </div>
              ))}

              <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--ink-100)" }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-400)", textTransform: "uppercase", marginBottom: 8 }}>队列中 · {queued.length}</div>
                {queued.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--ink-400)" }}>(空)</div>
                ) : queued.map((q, i) => (
                  <div key={q.jobId} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 0", borderBottom: i < queued.length - 1 ? "1px solid var(--ink-50)" : "none" }}>
                    <span style={{ width: 18, height: 18, borderRadius: 999, background: "var(--ink-100)", color: "var(--ink-600)", display: "grid", placeItems: "center", fontSize: 9, fontWeight: 700, fontFamily: "ui-monospace, Consolas, monospace" }}>{i + 1}</span>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ink-600)" }}>{q.shot_id ? labelShotId(q.shot_id) : "任务"}</span>
                    <span style={{ fontSize: 11, color: "var(--ink-700)" }}>· {labelOfStage(q.stage)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 中 · 最近失败 + 实时日志 */}
            <div>
              <h3 style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, fontWeight: 600, color: "var(--ink-900)", margin: "0 0 10px" }}>最近 24 小时失败 · {failures.length}</h3>
              {failures.length === 0 ? (
                <div className="mk-card" style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--ink-400)", marginBottom: 18 }}>24 小时内没有失败,稳</div>
              ) : (
                <div className="mk-card" style={{ padding: "4px 10px", marginBottom: 18 }}>
                  {failures.slice(0, 6).map((f, i, arr) => (
                    <div key={f.id} className="cockpit-recent-failure" style={{ display: "flex", gap: 8, padding: "8px 4px", borderBottom: i < arr.length - 1 ? "1px solid var(--ink-50)" : "none" }}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--err)", background: "#fdecea", padding: "2px 6px", borderRadius: 999, height: 18 }}>{f.category_label}</span>
                      <span className="cockpit-failure-message" style={{ fontSize: 11.5, color: "var(--ink-800)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {/* 铁律 #9 toC 兜底: 不暴露 task_id UUID / hash; error_message 原始报错 2026-07-09 audit C32 过 friendlyTaskError 翻人话 */}
                        {f.shot_id ? labelShotId(f.shot_id) : "(未知分镜)"} · {friendlyTaskError(f.error_message)}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--ink-400)", fontFamily: "ui-monospace, Consolas, monospace" }}>{relTime(f.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}

              <h3 style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, fontWeight: 600, color: "var(--ink-900)", margin: "0 0 10px" }}>实时日志</h3>
              <div className="mk-card" style={{ background: "#1f1d1a", color: "#cdc6ba", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11, padding: 14, lineHeight: 1.65, maxHeight: 260, overflow: "auto" }}>
                {logLines.length === 0 ? (
                  <div style={{ color: "#6a655c" }}>(无日志 · SSE 未产生事件)</div>
                ) : logLines.map((l, i) => {
                  const lvlColor = l.lvl === "warn" ? "#f5c89a" : l.lvl === "err" ? "#ff8a8a" : "#9ed1ff";
                  const msgColor = l.lvl === "warn" ? "#f5c89a" : l.lvl === "err" ? "#ff8a8a" : "#cdc6ba";
                  return (
                    <div key={i} className="cockpit-log-line" style={{ display: "flex", gap: 10, marginBottom: 2 }}>
                      <span style={{ color: "#6a655c" }}>{l.t}</span>
                      <span style={{ color: lvlColor, width: 36 }}>{l.lvl}</span>
                      <span style={{ color: msgColor, flex: 1 }}>{l.msg}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 右 · KPI */}
            <div>
              {/* 2026-05-25 C1 — 成本统计多维卡 (替代旧"归档开销 60 条").
                  本月 + 累计 + Top 5 Provider + Top 5 Series + 近 6 月柱状图.
                  数据源 GET /api/v2/vault/cost-stats (后端 getVaultCostStats 全量聚合 cost_cny). */}
              <div className="mk-card" style={{ padding: 14, marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-400)", textTransform: "uppercase", marginBottom: 4 }}>本月开销</div>
                    <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 26, fontWeight: 700, color: "var(--brand-700)", fontFeatureSettings: '"tnum"' }}>
                      {formatCny(costStats?.this_month_cny ?? 0)}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-500)", marginTop: 1 }}>
                      {costStats?.this_month_entries ?? 0} 项付费产出
                    </div>
                  </div>
                  <div style={{ width: 1, height: 48, background: "var(--ink-100)" }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-400)", textTransform: "uppercase", marginBottom: 4 }}>累计开销</div>
                    <div style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 22, fontWeight: 600, color: "var(--ink-800)", fontFeatureSettings: '"tnum"' }}>
                      {formatCny(costStats?.total_cny ?? monthCostFallback)}
                    </div>
                    <div style={{ fontSize: 10.5, color: "var(--ink-500)", marginTop: 1 }}>
                      {costStats?.total_paid_entries ?? vaultEntries.length} 项归档
                    </div>
                  </div>
                </div>

                {/* 近 6 月趋势 mini bar */}
                {costStats && costStats.by_month.length > 0 && (
                  <div style={{ marginBottom: 10, paddingTop: 8, borderTop: "1px solid var(--ink-50)" }}>
                    <div style={{ fontSize: 10.5, color: "var(--ink-500)", marginBottom: 6 }}>近 6 月</div>
                    <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 40 }}>
                      {(() => {
                        const max = Math.max(1, ...costStats.by_month.map((m) => m.cost_cny));
                        return costStats.by_month.map((m) => {
                          const h = max > 0 ? Math.max(2, (m.cost_cny / max) * 40) : 2;
                          const labelMonth = m.month.slice(-2).replace(/^0/, "") + "月";
                          return (
                            <div key={m.month} title={`${m.month}: ${formatCny(m.cost_cny)} · ${m.count} 项`} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                              <div style={{ width: "100%", height: h, background: m.cost_cny > 0 ? "var(--brand-400)" : "var(--ink-100)", borderRadius: 2 }} />
                              <div style={{ fontSize: 9, color: "var(--ink-400)" }}>{labelMonth}</div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}
              </div>

              {/* Top Provider 成本 */}
              {costStats && costStats.by_provider.length > 0 && (
                <div className="mk-card" style={{ padding: 14, marginBottom: 12 }}>
                  {/* 2026-07-09 audit C-cockpit: 英文 "Provider" → 中文, 铁律 #9 toC 兜底. */}
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-800)", marginBottom: 8 }}>按模型来源累计</div>
                  {costStats.by_provider.slice(0, 5).map((p) => (
                    <div key={p.provider_id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0", fontSize: 11.5 }}>
                      <span style={{ flex: 1, color: "var(--ink-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.provider_id}>
                        {labelOfSource(p.provider_id)}
                      </span>
                      <span style={{ color: "var(--ink-500)", fontSize: 10.5 }}>{p.count} 项</span>
                      <span style={{ color: "var(--ink-900)", fontWeight: 600, fontFamily: "ui-monospace, Consolas, monospace" }}>{formatCny(p.cost_cny)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Top Series 成本 */}
              {costStats && costStats.by_series.length > 0 && (
                <div className="mk-card" style={{ padding: 14, marginBottom: 12 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-800)", marginBottom: 8 }}>按系列累计</div>
                  {costStats.by_series.slice(0, 5).map((s) => {
                    // 2026-07-09 audit C-cockpit: 之前直接渲染 series_slug(技术标识), 现映射成系列标题(铁律 #9).
                    // 映射不到时(如系列已被删除, listSeries 不再返回)兜底回退到原 slug, 不空白.
                    const displayLabel = s.series_slug === "(无项目)" ? "(无项目)" : (seriesTitleBySlug[s.series_slug] ?? s.series_slug);
                    return (
                      <div key={s.series_slug} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0", fontSize: 11.5 }}>
                        <span style={{ flex: 1, color: "var(--ink-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={displayLabel}>
                          {s.series_slug === "(无项目)" ? <span style={{ color: "var(--ink-400)" }}>(无项目)</span> : displayLabel}
                        </span>
                        <span style={{ color: "var(--ink-500)", fontSize: 10.5 }}>{s.count} 项</span>
                        <span style={{ color: "var(--ink-900)", fontWeight: 600, fontFamily: "ui-monospace, Consolas, monospace" }}>{formatCny(s.cost_cny)}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mk-card" style={{ padding: 14 }}>
                {/* 2026-07-09 audit C-cockpit: "Provider Key 状态" + 英文兜底 "(后端未返回 provider 清单)" 翻中文 (铁律 #9). */}
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-800)", marginBottom: 8 }}>模型 Key 状态</div>
                {providers.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--ink-400)" }}>(暂时拿不到模型列表, 请稍后刷新)</div>
                ) : providers.map((p, i, arr) => (
                  <div key={p.n} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: i < arr.length - 1 ? "1px solid var(--ink-50)" : "none" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: p.ok ? "var(--ok)" : "var(--err)" }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-800)", flex: 1 }}>{p.n}</span>
                    {p.ok ? <span style={{ fontSize: 10.5, color: "var(--ok)" }}>已配置</span> : <span style={{ fontSize: 10.5, color: "var(--err)" }}>{p.err}</span>}
                  </div>
                ))}
                <Button variant="secondary" size="xs" iconLeft="key" block style={{ marginTop: 10 }} onClick={() => navigate("/settings")}>
                  管理 Key
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
  );

  // 2026-05-26 audit #4: 嵌入时跳过 PageTransition 避免双层 framer-motion 动画卡顿.
  return embedded ? inner : <PageTransition>{inner}</PageTransition>;
}
