/**
 * PolishPreviewModal — D-P1: AI 润色提示词预览弹窗 (2026-06-01)
 *
 * 可干预铁律: AI 润色结果先在此弹窗展示, 用户可编辑/确认后才回填到 prompt_img.
 * 不直接覆盖 (PRODUCT §3.1 #1).
 *
 * UI 复用现有 aiAsk UI 模式: 全屏居中 modal + before/after 对比 + 可编辑 textarea.
 */
import { useState, useEffect } from "react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Icon } from "../shared/Icon";

export interface PolishPreviewModalProps {
  open: boolean;
  /** 润色前的原始 prompt */
  originalPrompt: string;
  /** AI 润色后的 prompt (初始值) */
  polishedPrompt: string;
  /** 润色模式标识 */
  mode: "image" | "video";
  /** loading 状态 (LLM 调用中) */
  loading?: boolean;
  /** 错误信息 */
  error?: string | null;
  /** 用户确认接受润色结果 */
  onAccept: (finalText: string) => void;
  /** 用户取消 */
  onCancel: () => void;
}

export function PolishPreviewModal(props: PolishPreviewModalProps) {
  const { open, originalPrompt, polishedPrompt, mode, loading, error, onAccept, onCancel } = props;
  const [edited, setEdited] = useState(polishedPrompt);

  // 外部 polishedPrompt 变化时同步
  useEffect(() => {
    setEdited(polishedPrompt);
  }, [polishedPrompt]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  const modeLabel = mode === "video" ? "视频" : "首帧";

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 10000,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          width: "min(680px, 92vw)", maxHeight: "85vh",
          background: "var(--surface-card)", borderRadius: 14,
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "14px 18px 10px", borderBottom: "1px solid var(--ink-100)",
        }}>
          <Icon name="sparkles" size={16} style={{ color: "var(--brand-600)" }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--ink-900)" }}>
            AI 润色{modeLabel}提示词
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--ink-400)", padding: 4, borderRadius: 4,
            }}
            title="关闭 (Esc)"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "14px 18px" }}>
          {loading ? (
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", gap: 12, padding: "40px 0",
              color: "var(--ink-500)", fontSize: 13,
            }}>
              <div style={{
                width: 28, height: 28, border: "3px solid var(--ink-150)",
                borderTopColor: "var(--brand-500)", borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }} />
              AI 正在润色{modeLabel}提示词...
            </div>
          ) : error ? (
            <div style={{
              padding: "20px 14px", borderRadius: 8,
              background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
              color: "var(--red-700, #b91c1c)", fontSize: 13, lineHeight: 1.6,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>润色失败</div>
              {error}
            </div>
          ) : (
            <>
              {/* 原始 prompt */}
              <div style={{ marginBottom: 14 }}>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: "var(--ink-500)",
                  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6,
                }}>
                  原始提示词
                </div>
                <div style={{
                  fontSize: 12, lineHeight: 1.6, color: "var(--ink-600)",
                  background: "var(--ink-50)", borderRadius: 8, padding: "8px 10px",
                  maxHeight: 120, overflow: "auto",
                  whiteSpace: "pre-wrap", wordBreak: "break-word",
                }}>
                  {originalPrompt || <span style={{ color: "var(--ink-400)", fontStyle: "italic" }}>(空)</span>}
                </div>
              </div>

              {/* 润色后 (可编辑) */}
              <div>
                <div style={{
                  display: "flex", alignItems: "center", gap: 6,
                  fontSize: 11, fontWeight: 600, color: "var(--brand-700)",
                  textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6,
                }}>
                  <Icon name="sparkles" size={11} />
                  AI 润色结果 (可编辑)
                </div>
                <Textarea
                  value={edited}
                  onChange={(e) => setEdited(e.target.value)}
                  rows={8}
                  style={{
                    fontSize: 12, lineHeight: 1.6,
                    fontFamily: "inherit", resize: "vertical",
                  }}
                  placeholder="AI 润色结果将显示在此..."
                />
                <div style={{
                  fontSize: 10.5, color: "var(--ink-400)", marginTop: 4,
                }}>
                  编辑满意后点"采纳"回填到提示词
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {!loading && !error && (
          <div style={{
            display: "flex", justifyContent: "flex-end", gap: 8,
            padding: "10px 18px 14px", borderTop: "1px solid var(--ink-100)",
          }}>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              iconLeft="check"
              onClick={() => onAccept(edited)}
              disabled={!edited.trim()}
            >
              采纳润色
            </Button>
          </div>
        )}
        {(loading || error) && (
          <div style={{
            display: "flex", justifyContent: "flex-end", gap: 8,
            padding: "10px 18px 14px", borderTop: "1px solid var(--ink-100)",
          }}>
            <Button variant="ghost" size="sm" onClick={onCancel}>
              {error ? "关闭" : "取消"}
            </Button>
          </div>
        )}
      </div>
      {/* CSS animation for spinner */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
