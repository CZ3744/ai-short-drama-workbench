// v24-batch-all · DiagnosticsPage · 接真 API (getDiagnostics + getFailures)
// 数据源:
//   GET /api/v2/diagnostics   → env/keys/tools/queue/inflight/budget/disk/recent_errors
//   GET /api/v2/failures?since=7d → summary (错误类目分布)
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/shared/Icon";
import { Button } from "../components/ui/button";
import { PageTransition } from "../components/studio/PageTransition";
import { Empty } from "../components/ui/empty";
import { getDiagnostics, getFailures, type DiagnosticsResponse, type FailuresResponse } from "../lib/api";
import { showErrorToast } from "../lib/errorTranslate";
import { labelOfSource, labelOfErrorCode } from "../lib/sourceLabels";
import { formatBytes, formatBeijingTime } from "../lib/format";

// 2026-05-19 toC 兜底:
//   - 日志级别 / Key 状态 / 错误 code 等技术字段都走翻译表
//   - 不再暴露 "ok / warn / err" / "recent_errors" / "/diagnostics.keys" 等内部字段名
const LEVEL_LABEL: Record<string, string> = {
  ok: "正常",
  warn: "提醒",
  err: "异常",
  error: "异常",
  info: "信息",
  debug: "调试",
};
function labelOfLevel(s: string): string {
  return LEVEL_LABEL[s.toLowerCase()] ?? s;
}


type Status = "ok" | "warn" | "err";

interface Check { k: string; v: string; sub: string; status: Status; }
interface ProviderView { n: string; ok: boolean; detail: string; }

function parseChecks(d: DiagnosticsResponse): Check[] {
  const out: Check[] = [];

  // 2026-07-09 终验: "Express" 是 Node 后端框架名, 对创作者是开发者黑话, 违反铁律 #9 toC 兜底。
  // 改成创作者能懂的"本地服务"(其余项如 FFmpeg/Python/Edge TTS 是用户需要自己装的外部工具, 保留工具名).
  const env = (d.env ?? {}) as Record<string, unknown>;
  out.push({
    k: "本地服务",
    v: "运行中",
    sub: String(env.node_version ?? "—") + " · pid " + String(env.pid ?? "—"),
    status: "ok",
  });

  // Tools
  const tools = (d.tools ?? {}) as Record<string, { found: boolean; version: string }>;
  const ffmpeg = tools.ffmpeg;
  out.push({
    k: "FFmpeg",
    v: ffmpeg?.found ? (ffmpeg.version.split(" ").slice(0, 2).join(" ") || "已安装") : "未找到",
    sub: ffmpeg?.found ? "音视频合成可用" : "无法合成成片, 需安装 ffmpeg",
    status: ffmpeg?.found ? "ok" : "err",
  });
  const python = tools.python;
  out.push({
    k: "Python",
    v: python?.found ? python.version : "未找到",
    sub: python?.found ? "本地脚本可用" : "本地脚本不可用",
    status: python?.found ? "ok" : "warn",
  });
  const edgeTts = tools.edge_tts ?? tools["edge-tts"];
  out.push({
    k: "Edge TTS",
    v: edgeTts?.found ? "已安装" : "未找到",
    sub: edgeTts?.found ? "TTS 后备就绪" : "可选 · 仅 SAPI fallback",
    status: edgeTts?.found ? "ok" : "warn",
  });

  // Disk
  const disk = (d.disk ?? {}) as { free_bytes?: number; total_bytes?: number; used_percent?: number };
  if (disk.total_bytes) {
    const used = disk.used_percent ?? 0;
    const status: Status = used > 90 ? "err" : used > 75 ? "warn" : "ok";
    out.push({
      k: "本机存储",
      v: used.toFixed(1) + "% 已用",
      sub: `剩余 ${formatBytes(disk.free_bytes ?? 0)} / ${formatBytes(disk.total_bytes)}`,
      status,
    });
  }

  // Queue
  const q = (d.queue ?? {}) as { pending?: number; running?: number; failed?: number };
  if (q.pending != null || q.running != null) {
    out.push({
      k: "任务队列",
      v: (q.running ?? 0) + " 跑 / " + (q.pending ?? 0) + " 排",
      sub: (q.failed ?? 0) > 0 ? `${q.failed} 个失败` : "队列正常",
      status: (q.failed ?? 0) > 5 ? "warn" : "ok",
    });
  }

  // Inflight
  const inf = (d.inflight ?? {}) as { count?: number };
  if (inf.count != null) {
    out.push({
      k: "真实视频 inflight",
      v: (inf.count ?? 0) + " 个",
      sub: (inf.count ?? 0) > 0 ? "有远端任务在轮询" : "无 inflight 任务",
      status: "ok",
    });
  }

  return out;
}

function parseProviders(d: DiagnosticsResponse): ProviderView[] {
  // 2026-05-19 toC: Provider 名走 labelOfSource 翻译 (openai → "OpenAI", chatgpt_codex_image → "ChatGPT 图像" 等)
  // "Key 缺失" 文案改成人话, 不出现 "Key" 英文字 (用户大概率不知道 Key=API Key)
  const keys = (d.keys ?? {}) as Record<string, "present" | "missing">;
  return Object.entries(keys).map(([k, v]) => ({
    n: labelOfSource(k.toLowerCase()),
    ok: v === "present",
    detail: v === "present" ? "已连接" : "未配置 · 去设置页填入密钥",
  }));
}

/**
 * 2026-05-26 audit #4 修复 — embedded 模式 (嵌入 SystemStatusPage 时跳过 PageTransition + 自己头部).
 * embedded=true: 不渲染 PageTransition 包装, 不渲染顶部 mk-label/h2/refresh 按钮 (外壳已经有了一份).
 */
export default function DiagnosticsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [diag, setDiag] = useState<DiagnosticsResponse | null>(null);
  const [failures, setFailures] = useState<FailuresResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const reload = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [d, f] = await Promise.allSettled([getDiagnostics(), getFailures("7d")]);
      if (d.status === "fulfilled") setDiag(d.value);
      if (f.status === "fulfilled") setFailures(f.value);
      if (d.status === "rejected" || f.status === "rejected") setLoadError(true);
    } catch (err) {
      showErrorToast(err, "加载诊断数据失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  const checks = useMemo(() => diag ? parseChecks(diag) : [], [diag]);
  const providers = useMemo(() => diag ? parseProviders(diag) : [], [diag]);
  const okCount = checks.filter((c) => c.status === "ok").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const errCount = checks.filter((c) => c.status === "err").length;
  const connectedProviderCount = providers.filter((p) => p.ok).length;

  const errCodes = useMemo(() => {
    if (!failures) return [] as Array<{ code: string; n: number; pct: number; color: string }>;
    const total = failures.total || 1;
    const colors = ["var(--err)", "var(--warn)", "var(--info)", "var(--brand-600)", "var(--ink-400)"];
    return failures.summary.slice(0, 5).map((s, i) => ({
      code: s.label, n: s.count, pct: Math.round((s.count / total) * 100),
      color: colors[i] ?? "var(--ink-400)",
    }));
  }, [failures]);

  const recentLogs = useMemo(() => {
    const arr = diag?.recent_errors ?? [];
    return arr.slice(0, 12);
  }, [diag]);

  const overviewCards = useMemo(() => [
    {
      label: "正常项",
      value: okCount,
      sub: checks.length > 0 ? `共 ${checks.length} 项体检` : "等待检查",
      color: "var(--ok)",
      bg: "rgba(76,175,80,0.14)",
      icon: "check",
    },
    {
      label: "需要留意",
      value: warnCount,
      sub: warnCount > 0 ? "建议今天看一眼" : "暂无提醒",
      color: "var(--warn)",
      bg: "rgba(245,158,11,0.16)",
      icon: "warning",
    },
    {
      label: "异常项",
      value: errCount,
      sub: errCount > 0 ? "会影响生成链路" : "没有阻断项",
      color: "var(--err)",
      bg: "rgba(244,67,54,0.14)",
      icon: "close",
    },
    {
      label: "模型已连接",
      value: providers.length > 0 ? `${connectedProviderCount}/${providers.length}` : "—",
      sub: failures ? `近 7 日失败 ${failures.total} 次` : "等待失败统计",
      color: "var(--brand-600)",
      bg: "var(--brand-50)",
      icon: "bolt",
    },
  ], [okCount, warnCount, errCount, checks.length, providers.length, connectedProviderCount, failures]);

  const inner = (
      <div className="v24-diagnostics-page" style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-canvas)" }}>
        {/* 2026-05-26 audit #4: embedded 时由外壳 SystemStatusPage 统一渲染头部, 内部跳过双层. */}
        {!embedded && (
          <div style={{ padding: "16px 24px", background: "#fff", borderBottom: "1px solid var(--ink-100)", display: "flex", alignItems: "center", gap: 14 }}>
            <Icon name="stetho" size={18} style={{ color: "var(--brand-600)" }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--brand-700)", textTransform: "uppercase" }}>系统状态</div>
              <h2 style={{ margin: "2px 0 0", fontFamily: "'Noto Serif SC', serif", fontSize: 18, fontWeight: 600, color: "var(--ink-900)" }}>本机环境 · 模型连通 · 近期错误</h2>
            </div>
            {/* 2026-05-19 toC: "ok / warn / err" 英文不直显, 改成"正常 / 提醒 / 异常" + 仅高亮非零项 */}
            <span className={errCount > 0 ? "mk-pill mk-pill--failed" : warnCount > 0 ? "mk-pill mk-pill--draft" : "mk-pill mk-pill--picked"} style={{ height: 22 }}>
              {errCount > 0 ? `${errCount} 项异常` : warnCount > 0 ? `${warnCount} 项提醒` : `全部正常 (${okCount} 项)`}
            </span>
            <span style={{ flex: 1 }} />
            <Button variant="secondary" size="sm" iconLeft="refresh" onClick={reload} disabled={loading} loading={loading}>
              {loading ? "加载中" : "立即检查"}
            </Button>
          </div>
        )}

        <div className="mk-scroll" data-diagnostics-state={loading ? "loading" : "ready"} style={{ flex: 1, overflow: "auto", padding: 24 }}>
          {loadError && <div role="alert" className="mk-card" style={{ padding: 16, marginBottom: 16 }}>部分检查暂时没有完成，请重试。<Button variant="secondary" size="sm" onClick={reload}>重新检查</Button></div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: 14, marginBottom: 22 }}>
            {overviewCards.map((card) => (
              <div
                key={card.label}
                className="mk-card"
                style={{
                  padding: 18,
                  display: "grid",
                  gridTemplateColumns: "44px minmax(0, 1fr)",
                  gap: 12,
                  alignItems: "center",
                  minHeight: 104,
                }}
              >
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 8,
                    background: card.bg,
                    color: card.color,
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <Icon name={card.icon} size={18} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--ink-400)", textTransform: "uppercase", marginBottom: 4 }}>
                    {card.label}
                  </div>
                  <div style={{ fontSize: 30, lineHeight: 1, fontWeight: 750, color: "var(--ink-900)", fontFamily: "ui-monospace, Consolas, monospace", marginBottom: 6 }}>
                    {diag ? card.value : "—"}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-500)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {card.sub}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <h3 style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, fontWeight: 600, color: "var(--ink-900)", margin: "0 0 10px" }}>系统组件健康</h3>
          {checks.length === 0 && !loading ? (
            <div className="mk-card" style={{ padding: 30, textAlign: "center", color: "var(--ink-400)", marginBottom: 24 }}>无诊断数据</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 12, marginBottom: 24 }}>
              {(loading && checks.length === 0 ? Array.from({ length: 6 }) : checks).map((c, i) => {
                if (!c) return <div key={i} className="mk-card" style={{ height: 72, background: "var(--ink-50)" }} />;
                const item = c as Check;
                const dotColor = item.status === "ok" ? "var(--ok)" : item.status === "warn" ? "var(--warn)" : "var(--err)";
                const bgColor = item.status === "ok" ? "rgba(76,175,80,0.12)" : item.status === "warn" ? "rgba(245,158,11,0.14)" : "rgba(244,67,54,0.14)";
                return (
                  <div key={i} className="mk-card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 999, background: bgColor, color: dotColor, display: "grid", placeItems: "center", flexShrink: 0 }}>
                      <Icon name={item.status === "ok" ? "check" : "warning"} size={16} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-900)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.k}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: dotColor, fontFamily: "ui-monospace, Consolas, monospace" }}>{item.v}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "var(--ink-500)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.sub}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 14, marginBottom: 24 }}>
            <div className="mk-card" style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <Icon name="bolt" size={14} style={{ color: "var(--brand-600)" }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-800)" }}>模型连接状态</span>
                <span style={{ flex: 1 }} />
                <span className="mk-chip mk-chip--brand" style={{ height: 18, fontSize: 10 }}>{providers.filter((p) => p.ok).length}/{providers.length}</span>
              </div>
              {providers.length === 0 ? (
                <div style={{ fontSize: 11.5, color: "var(--ink-400)", padding: 10 }}>暂无模型连接信息</div>
              ) : providers.map((p, i) => (
                <div key={p.n} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: i < providers.length - 1 ? "1px solid var(--ink-50)" : "none" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: p.ok ? "var(--ok)" : "var(--err)" }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-800)", flex: 1 }}>{p.n}</span>
                  <span style={{ fontSize: 10.5, color: p.ok ? "var(--ok)" : "var(--err)" }}>{p.detail}</span>
                </div>
              ))}
            </div>

            <div className="mk-card" style={{ padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <Icon name="warning" size={14} style={{ color: "var(--err)" }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-800)" }}>近 7 日错误类目</span>
                <span style={{ flex: 1 }} />
                <span className="mk-pill mk-pill--failed" style={{ height: 18, fontSize: 10 }}>{failures?.total ?? 0} 次</span>
              </div>
              {errCodes.length === 0 ? (
                <Empty title={failures ? "暂无失败记录" : "等待检查记录"} description={failures ? "近 7 天没有记录到失败任务" : "检查完成后会显示近期任务状态"} />
              ) : errCodes.map((e, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, marginBottom: 3 }}>
                    {/* 2026-05-19 toC: 错误 code 走 labelOfErrorCode 翻译 (missing_key → "缺 API Key" 等) */}
                    <span style={{ flex: 1, color: "var(--ink-800)", fontWeight: 600 }} title={e.code}>{labelOfErrorCode(e.code) || e.code}</span>
                    <span style={{ color: "var(--ink-500)", fontFamily: "ui-monospace, Consolas, monospace" }}>{e.n} 次 · {e.pct}%</span>
                  </div>
                  <div style={{ height: 5, background: "var(--ink-100)", borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ width: e.pct + "%", height: "100%", background: e.color, borderRadius: 999 }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 2026-05-19 toC: "最近错误 · recent_errors" 后端字段名删 + 黑底终端风格保留 (信息密度高合适) */}
          <h3 style={{ fontFamily: "'Noto Serif SC', serif", fontSize: 17, fontWeight: 600, color: "var(--ink-900)", margin: "0 0 10px" }}>最近错误</h3>
          <div className="mk-card" style={{ background: "#1f1d1a", color: "#cdc6ba", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11, padding: 14, lineHeight: 1.65, maxHeight: 280, overflow: "auto" }}>
            {recentLogs.length === 0 ? (
              <div style={{ color: "#6a655c" }}>暂无错误记录 — 系统运行正常</div>
            ) : recentLogs.map((l, i) => {
              const lvl = l.level || "info";
              const lvlColor = lvl === "warn" ? "#f5c89a" : lvl === "error" || lvl === "err" ? "#ff8a8a" : "#9ed1ff";
              const msgColor = lvl === "warn" ? "#f5c89a" : lvl === "error" || lvl === "err" ? "#ff8a8a" : "#cdc6ba";
              const time = l.timestamp ? formatBeijingTime(l.timestamp, { mode: "time" }) : "--:--:--";
              return (
                <div key={i} style={{ display: "flex", gap: 10, marginBottom: 2 }}>
                  <span style={{ color: "#6a655c" }}>{time}</span>
                  <span style={{ color: lvlColor, width: 48 }}>{labelOfLevel(lvl)}</span>
                  <span style={{ color: msgColor, flex: 1 }}>{l.message}{l.source ? " · " + l.source : ""}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
  );

  // 2026-05-26 audit #4: 嵌入时跳过 PageTransition 避免双层 framer-motion 动画卡顿.
  return embedded ? inner : <PageTransition>{inner}</PageTransition>;
}
