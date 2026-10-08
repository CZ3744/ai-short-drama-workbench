/**
 * SystemStatusPage — 系统状态合页 (2026-05-26 audit #8).
 *
 * 之前 3 页内容 70% 重叠:
 *   /cockpit       (生产驾驶舱) — Provider Key 状态 / 队列 / 实时日志 / 本月开销 / 失败摘要
 *   /failures      (失败中心)   — 详细失败列表 + 多选批量重试
 *   /diagnostics   (系统诊断)   — env / FFmpeg / Python / Provider 健康 / 异常上报
 *
 * 合并为 /status, 3 tab "健康 / 失败 / 日志":
 *   "健康" → 原 DiagnosticsPage (env / tools / providers / disk / budget)
 *   "失败" → 原 FailureCenter (详细列表 + 批量重试)
 *   "日志" → 原 CockpitPage (实时事件流 + 队列 + 开销)
 *
 * 实现策略: 不重写 3 个页的内部, 套一层 SystemStatusPage 外壳 tab 切换, 内嵌原 3 个组件
 * 子节点. 这样未来 deprecate 哪个 tab 直接删, 不破内部逻辑.
 *
 * 旧路由 /cockpit / /failures / /diagnostics 仍 redirect 到 /status?tab=...
 */

import { useMemo, useCallback } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { PageTransition } from "../../components/studio/PageTransition";
import { Button } from "../../components/ui/button";
import CockpitPage from "../cockpit/CockpitPage";
import FailureCenter from "../cockpit/FailureCenter";
import DiagnosticsPage from "../DiagnosticsPage";

type TabId = "health" | "failures" | "logs";

const TABS: Array<{ id: TabId; label: string; hint: string }> = [
  { id: "health", label: "健康", hint: "FFmpeg / Python / Provider Key / 磁盘 / 预算" },
  { id: "failures", label: "失败", hint: "近期失败列表 + 多选批量重试" },
  { id: "logs", label: "日志", hint: "实时任务事件 / 队列 / 本月开销" },
];

export default function SystemStatusPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const tab = useMemo<TabId>(() => {
    const t = searchParams.get("tab");
    if (t === "health" || t === "failures" || t === "logs") return t;
    return "health";
  }, [searchParams]);

  const handleTabChange = useCallback((id: TabId) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", id);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <PageTransition>
      <div style={{ minHeight: "100%", background: "var(--surface-canvas)", display: "flex", flexDirection: "column" }}>
        {/* Header + tab bar — 跟 3 个原页面的顶 banner 风格统一 */}
        <div style={{ padding: "24px 40px 12px", background: "#fff", borderBottom: "1px solid var(--ink-100)" }}>
          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
            <div>
              <div className="mk-label" style={{ marginBottom: 6 }}>SYSTEM STATUS</div>
              <h1 style={{ fontSize: 26, lineHeight: 1.18, margin: "0 0 4px", color: "var(--ink-950)", fontWeight: 600, fontFamily: '"Noto Serif SC", serif' }}>
                系统状态
              </h1>
              <div style={{ fontSize: 13, color: "var(--ink-500)" }}>
                查看服务配置、处理失败任务，随时了解工作台运行情况。
              </div>
            </div>
            <Button variant="secondary" iconLeft="arrowLeft" onClick={() => navigate("/studio")}>
              返回工作站
            </Button>
          </div>
          <div className="mk-tab-group" style={{ flexWrap: "wrap" }}>
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tab === t.id}
                className={`mk-tab ${tab === t.id ? "mk-tab--active" : ""}`}
                onClick={() => handleTabChange(t.id)}
                title={t.hint}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* 内容区 — 嵌入 3 个原页, 各自管自己 fetch / state.
            2026-05-26 audit #4 修复: 子页 embedded=true 跳过自己的 PageTransition 包装 + 跳过头部 mk-label/h2/refresh
            (外壳已经给了同一份). FailureCenter 保留功能性控件 (全选 / range / refresh). */}
        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === "health" && <DiagnosticsPage embedded />}
          {tab === "failures" && <FailureCenter embedded />}
          {tab === "logs" && <CockpitPage embedded />}
        </div>
      </div>
    </PageTransition>
  );
}
