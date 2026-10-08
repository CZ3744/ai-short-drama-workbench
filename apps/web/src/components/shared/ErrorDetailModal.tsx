/**
 * ErrorDetailModal — 失败错误详情弹窗 (2026-05-27)
 *
 * 用户痛点: 候选卡 200px 宽放 HTML 502 body 看不清, 也无法看完整原文.
 * 解法: 卡片只显示翻译后的精简文案 + "看完整错误"按钮 → 打开此 modal.
 *
 * 内容三栏:
 *   1. 翻译后的人话 (大字)
 *   2. 排查建议 (针对错误类型 — 502 / 401 / 配额 / 余额 / 安全审核 / 超时)
 *   3. 后端原始错误 (代码块 + scroll, 完整可见 + 复制按钮)
 *
 * 通用 — 不绑定 kind: image / video, FailedTaskTile / 任何"想看原始错误"的位置都用.
 */
import { useMemo } from "react";
import { toast } from "sonner";
import { BaseDialog } from "../ui/BaseDialog";
import { Button } from "../ui/button";
import { Icon } from "./Icon";

interface ErrorDetailModalProps {
  open: boolean;
  onClose: () => void;
  /** 翻译后的人话 (来自 friendlyTaskError) */
  friendly: string;
  /** 后端原始错误体 (含 HTTP status / provider JSON / HTML body 等) */
  raw: string;
  /** 标题里出现的失败种类, 例 "首帧生成" / "视频生成" */
  kindLabel?: string;
  /** 点了"重新生成"的回调 — 关弹窗后由调用方 trigger retry */
  onRetry?: () => void;
}

/** 根据原文关键字给针对性排查建议 — 不重复 friendlyTaskError 已说过的 */
function getTroubleshootingHints(raw: string): string[] {
  const s = raw.toLowerCase();
  const hints: string[] = [];
  if (/502|bad gateway|503|service unavailable|504/i.test(s)) {
    hints.push("服务端 5xx — 模型方临时过载, 直接重新生成大概率能成功 (服务端 1-2 分钟内通常恢复).");
    hints.push("如果 5 分钟内连续多次 5xx, 切到另一个生图模型 (例如 ChatGPT 502 时切到本地 SDXL 或 Gemini).");
  }
  if (/401|unauthorized|forbidden/i.test(s)) {
    hints.push("Key 鉴权失败 — 去设置页确认 API Key / OAuth Token 没填错 / 过期.");
  }
  if (/usage[_ -]?limit|quota|429|too many requests/i.test(s)) {
    hints.push("ChatGPT 订阅按小时限额 — 等 30-60 分钟自动重置, 或切换模型.");
  }
  if (/safety|rejected by the safety/i.test(s)) {
    hints.push("被安全审核拦截 — 提示词里软化敏感词 (血腥/暴力/医学术语等), 或换更宽松的模型 (本地 SDXL).");
  }
  if (/insufficient.?balance|余额不足/i.test(s)) {
    hints.push("到对应模型平台 (智谱 / 即梦 / MiniMax 等) 充值后再试.");
  }
  if (/timeout|fetch failed|terminated|econnreset/i.test(s)) {
    hints.push("网络不稳 — 检查代理 / VPN. 也可能是服务端处理时间过长, 重试即可.");
  }
  if (/missing[_ ]?key|api[_ ]?key not configured|no api[_ ]?key/i.test(s)) {
    hints.push("去设置页填这个模型的 API Key (面板会标「未配置」提示).");
  }
  // 兜底: 没匹配到具体类型
  if (hints.length === 0) {
    hints.push("点底部「复制完整错误」, 粘到搜索引擎 / 反馈给开发. 大多数情况下直接重新生成能解决.");
  }
  return hints;
}

export function ErrorDetailModal({
  open, onClose, friendly, raw, kindLabel = "生成", onRetry,
}: ErrorDetailModalProps) {
  const hints = useMemo(() => getTroubleshootingHints(raw), [raw]);

  if (!open) return null;

  function copyRaw() {
    const text = raw || friendly;
    navigator.clipboard?.writeText(text).then(
      () => toast.success("已复制完整错误"),
      () => toast.error("复制失败"),
    );
  }

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      title={`${kindLabel}失败 — 详情`}
      iconName="warning"
      maxWidth={680}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={copyRaw} iconLeft="copy">
            复制完整错误
          </Button>
          {onRetry && (
            <Button
              variant="primary"
              size="sm"
              iconLeft="refresh"
              onClick={() => { onClose(); onRetry(); }}
              title="先关弹窗, 再用当前选定模型重新生成一次"
            >
              重新生成
            </Button>
          )}
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

        {/* 段 1: 翻译后的人话 — 主要给用户看的, 大字 */}
        <section>
          <div style={{
            fontSize: 10.5, fontWeight: 700, color: "var(--brand-700)",
            letterSpacing: "0.06em", textTransform: "uppercase",
            marginBottom: 5,
          }}>
            一句话原因
          </div>
          <div style={{
            fontSize: 14, lineHeight: 1.6, color: "var(--ink-900)",
            padding: "10px 12px",
            background: "rgba(220,38,38,0.05)",
            border: "1px solid rgba(220,38,38,0.2)",
            borderRadius: 8,
          }}>
            {friendly}
          </div>
        </section>

        {/* 段 2: 排查建议 — 根据错误类型给针对性提示 */}
        <section>
          <div style={{
            fontSize: 10.5, fontWeight: 700, color: "var(--brand-700)",
            letterSpacing: "0.06em", textTransform: "uppercase",
            marginBottom: 5,
          }}>
            排查建议
          </div>
          <ul style={{
            margin: 0,
            padding: "10px 14px 10px 28px",
            background: "var(--ink-50)",
            border: "1px solid var(--ink-100)",
            borderRadius: 8,
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            {hints.map((h, i) => (
              <li key={i} style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--ink-800)" }}>
                {h}
              </li>
            ))}
          </ul>
        </section>

        {/* 段 3: 后端原始错误体 — 完整可见, 滚动, 等宽字体 */}
        {raw && (
          <section>
            <div style={{
              display: "flex", alignItems: "center",
              fontSize: 10.5, fontWeight: 700, color: "var(--brand-700)",
              letterSpacing: "0.06em", textTransform: "uppercase",
              marginBottom: 5,
            }}>
              <span style={{ flex: 1 }}>后端原始错误 ({raw.length} 字符)</span>
              <button
                type="button"
                onClick={copyRaw}
                style={{
                  background: "none", border: "none", padding: 0,
                  fontSize: 10.5, color: "var(--brand-700)", textDecoration: "underline",
                  cursor: "pointer", fontWeight: 700, letterSpacing: "0.06em",
                  textTransform: "uppercase",
                }}
                title="复制完整错误到剪贴板"
              >
                <Icon name="copy" size={10} style={{ marginRight: 3 }} />
                复制
              </button>
            </div>
            <pre style={{
              margin: 0,
              padding: "10px 12px",
              fontSize: 11.5,
              lineHeight: 1.5,
              color: "var(--ink-800)",
              background: "var(--ink-50)",
              border: "1px solid var(--ink-100)",
              borderRadius: 8,
              maxHeight: 280,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              fontFamily: "ui-monospace, Consolas, monospace",
            }}>
              {raw}
            </pre>
          </section>
        )}

      </div>
    </BaseDialog>
  );
}
