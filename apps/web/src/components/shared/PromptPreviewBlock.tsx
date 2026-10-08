/**
 * PromptPreviewBlock — 提示词预览的单一展示组件.
 *
 * 2026-05-27 — 加视图切换: 段落视图(只读结构化) ↔ 全文视图(textarea 可编辑).
 * 用户原话: "能不能点击按钮切换结构化前端展示和完整文本两种提示词呢? 这样不是
 *           彻底把完整提示词预览砍了吗, 而且也不能手动修改微调".
 *
 * - 默认 "段落视图": segments 卡片分段渲染, 信息密度高, 不可编辑.
 * - 切到 "全文视图": composed_prompt 整段渲染到 textarea, 用户直接改.
 *   编辑后通过 onPromptOverrideChange 上报给 caller. 抽卡时 caller 拿这个
 *   override 替代默认拼接结果, 不用打开 modal 才能改.
 * - 想改参考图层面 (加/减代表图) 仍走 "审核后发送" 弹窗 (modal 那边能控参考图).
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Icon } from "./Icon";
import { Button } from "../ui/button";
import { ELEMENT_KIND_LABEL } from "../../lib/elementApi";
import type { PromptPreview } from "../../lib/shotApi";

export interface PromptPreviewBlockProps {
  /** 提示词预览数据 — 来自后端 preview-prompt endpoint */
  livePreview: PromptPreview | null;
  /** loading state — 渲染骨架/占位文案 */
  loading?: boolean;
  /** 给"修改并发送"按钮提示当前是首帧还是视频 (文案差一字) */
  previewKind?: "image" | "video";
  /** 复制按钮点击 — 默认走 navigator.clipboard, caller 可覆盖加 toast */
  onCopy?: () => void;
  /** "审核后发送" 按钮点击 — 打开 PromptReviewModal 真编辑参考图等高阶选项 */
  onEditAndSend?: () => void;
  /**
   * 2026-05-27 — 全文视图编辑后上报给 caller 的 override prompt.
   *   - null = 用户清空 / 没改 (用默认拼接)
   *   - string = 用户改过, caller 抽卡时用这个替代
   */
  onPromptOverrideChange?: (override: string | null) => void;
  /** 自定义 action — caller 想接管 footer 时用 */
  customActions?: React.ReactNode;
  /** 占位文案 (loading=false && livePreview=null 时显示) */
  placeholder?: string;
  /** 最大显示高度 (px), default 280 */
  maxHeight?: number;
}

type ViewMode = "structured" | "fulltext";

export function PromptPreviewBlock({
  livePreview, loading, previewKind, onCopy, onEditAndSend,
  onPromptOverrideChange, customActions, placeholder, maxHeight = 280,
}: PromptPreviewBlockProps) {
  // kind 防串: caller hardcoded previewKind, 但 ShotStagePage 单 livePreview state.
  // 切 kind 时短暂错位, 显式 reject 让 caller 看 loading 占位.
  const kindMismatched =
    !!livePreview && !!previewKind && livePreview.kind && livePreview.kind !== previewKind;

  // 视图模式 — 默认结构化, 用户切到全文模式 textarea 可编辑
  const [viewMode, setViewMode] = useState<ViewMode>("structured");

  // 全文模式的可编辑 draft — caller 切 livePreview 时同步
  const baseComposed = livePreview?.composed_prompt ?? "";
  const [draft, setDraft] = useState<string>(baseComposed);
  const userEditedRef = useRef(false); // 用户改过 → 不被 livePreview 重置覆盖
  useEffect(() => {
    if (!userEditedRef.current) {
      setDraft(baseComposed);
    }
  }, [baseComposed]);

  function handleDraftChange(next: string) {
    userEditedRef.current = true;
    setDraft(next);
    // 上报 caller: 跟默认拼接一致就传 null (代表"没改"), 不同才传 override 字符串.
    onPromptOverrideChange?.(next === baseComposed ? null : next);
  }
  function handleResetDraft() {
    userEditedRef.current = false;
    setDraft(baseComposed);
    onPromptOverrideChange?.(null);
    toast.success("已恢复默认拼接");
  }

  const hasUserEdit = userEditedRef.current && draft !== baseComposed;

  if (!livePreview || kindMismatched) {
    const loadingLabel = previewKind === "image"
      ? "首帧提示词加载中..."
      : previewKind === "video"
        ? "视频提示词加载中..."
        : "加载拼接结果...";
    return (
      <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-400)" }}>
        {loading || kindMismatched ? loadingLabel : (placeholder ?? "填写画面描述、勾选素材、设置参数后这里会自动出现完整提示词。")}
      </div>
    );
  }

  const connectedCount = livePreview.connected_assets.length;
  // 2026-05-27 UI 打磨 #2 — 用户原话"三个框线叠加, UI 太难看".
  // 之前 PromptPreviewBlock 自带外层 mk-card (渐变背景 + 边框 + 阴影),
  // 但 caller (FirstFrameColumn / VideoColumn) 把它放在 <details inlinePreviewStyle>
  // 里, details 本身又是一层 mk-card. 双层 card 嵌套 + candidate zone 大边框 = 三层叠加.
  // 修: PromptPreviewBlock 不再包外卡, 内容平铺. caller 的 details 当唯一卡片视觉.
  // segments 各自小卡和负向词卡保留, 视觉层次靠"小卡" 单一图形给.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 4 }}>
      {/* meta 行 + 视图切换 toggle — 顶部一条横线感, 不带卡片包装 */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        fontSize: 10.5,
        color: "var(--ink-500)",
      }}>
        <span style={{ fontWeight: 600, color: "var(--ink-700)" }}>
          {Array.isArray(livePreview.segments) && livePreview.segments.length > 0
            ? `${livePreview.segments.length} 段`
            : "未拼接"}
        </span>
        {connectedCount > 0 && (
          <span style={{ color: "var(--ink-400)" }}>· 连了 {connectedCount} 个素材</span>
        )}
        {hasUserEdit && (
          <span
            className="mk-chip"
            style={{
              height: 18, fontSize: 10, padding: "0 6px",
              background: "var(--brand-50, rgba(217,119,87,0.08))",
              color: "var(--brand-700)",
              border: "1px solid var(--brand-300, rgba(217,119,87,0.4))",
            }}
            title="你改过全文模式的提示词, 抽卡时会用你改后的版本而不是默认拼接"
          >
            已修改
          </span>
        )}
        <div style={{ flex: 1 }} />
        {/* 视图切换 — 段视图 / 全文视图. 紧凑无边框, 跟 meta 行融为一体 */}
        <div
          role="tablist"
          style={{
            display: "inline-flex",
            background: "var(--ink-50)",
            borderRadius: 6,
            padding: 2,
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "structured"}
            onClick={() => setViewMode("structured")}
            title="按 角色 / 场景 / 动作 / 镜头 / 光线 等分段显示, 信息密度高"
            style={{
              padding: "3px 10px",
              fontSize: 10.5,
              fontWeight: 600,
              border: "none",
              borderRadius: 4,
              background: viewMode === "structured" ? "var(--surface-card)" : "transparent",
              color: viewMode === "structured" ? "var(--brand-700)" : "var(--ink-500)",
              boxShadow: viewMode === "structured" ? "0 1px 2px rgba(40,32,24,0.06)" : "none",
              cursor: "pointer",
              transition: "all 140ms",
            }}
          >
            段视图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "fulltext"}
            onClick={() => setViewMode("fulltext")}
            title="整段完整提示词 (可手动改, 改后抽卡用你的版本)"
            style={{
              padding: "3px 10px",
              fontSize: 10.5,
              fontWeight: 600,
              border: "none",
              borderRadius: 4,
              background: viewMode === "fulltext" ? "var(--surface-card)" : "transparent",
              color: viewMode === "fulltext" ? "var(--brand-700)" : "var(--ink-500)",
              boxShadow: viewMode === "fulltext" ? "0 1px 2px rgba(40,32,24,0.06)" : "none",
              cursor: "pointer",
              transition: "all 140ms",
            }}
          >
            全文编辑
          </button>
        </div>
      </div>

      {connectedCount > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {livePreview.connected_assets.map((a) => (
            <span key={`${a.kind}:${a.id}`} className="mk-chip" style={{ height: 22, fontSize: 10.5, padding: "0 8px" }}>
              {(ELEMENT_KIND_LABEL as Record<string, string>)[a.kind] ?? a.kind} · {a.name}
            </span>
          ))}
        </div>
      )}

      {/* 主体 — 段视图 / 全文视图 */}
      {viewMode === "structured" ? (
        Array.isArray(livePreview.segments) && livePreview.segments.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight, overflow: "auto" }}>
            {livePreview.segments.map((s, i) => (
              <div
                key={`${i}-${s.label}`}
                style={{
                  borderRadius: 8,
                  border: "1px solid var(--ink-100)",
                  padding: "8px 10px",
                  background: "var(--surface-card)",
                  transition: "border-color 120ms",
                }}
              >
                <div style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "var(--brand-700)",
                  letterSpacing: "0.06em",
                  textTransform: "uppercase" as const,
                  marginBottom: 5,
                }}>
                  {s.label}
                </div>
                <div style={{
                  fontSize: 12,
                  lineHeight: 1.65,
                  color: "var(--ink-800)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "'Noto Serif SC', serif",
                }}>
                  {s.text}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <pre style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 12,
            lineHeight: 1.65,
            color: "var(--ink-800)",
            background: "var(--surface-card)",
            border: "1px solid var(--ink-100)",
            borderRadius: 8,
            padding: "10px 12px",
            fontFamily: "'Noto Serif SC', serif",
            maxHeight,
            overflow: "auto",
          }}>
            {livePreview.composed_prompt || "(暂无内容)"}
          </pre>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <textarea
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            placeholder="提示词为空, 填了画面描述 / 勾选素材后, 这里会出现可编辑全文..."
            style={{
              width: "100%",
              minHeight: 180,
              maxHeight: maxHeight + 80,
              padding: "10px 12px",
              fontSize: 12,
              lineHeight: 1.65,
              fontFamily: "'Noto Serif SC', serif",
              color: "var(--ink-900)",
              background: "var(--surface-card)",
              border: hasUserEdit
                ? "1.5px solid var(--brand-500, #c2410c)"
                : "1px solid var(--ink-100)",
              borderRadius: 8,
              outline: "none",
              resize: "vertical",
              boxShadow: hasUserEdit ? "0 0 0 3px rgba(217,119,87,0.12)" : "none",
              transition: "border-color 120ms, box-shadow 120ms",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10.5, color: "var(--ink-500)" }}>
            <span>{draft.length} 字</span>
            {hasUserEdit && (
              <>
                <span style={{ color: "var(--brand-700)", fontWeight: 600 }}>
                  · 你已改过, 抽卡时会用你这个版本
                </span>
                <button
                  type="button"
                  onClick={handleResetDraft}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    fontSize: 10.5,
                    color: "var(--brand-700)",
                    textDecoration: "underline",
                    cursor: "pointer",
                  }}
                  title="恢复成系统按你的画面描述 + 素材自动拼接的版本"
                >
                  恢复默认
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 负向词 — 跟 segments 同款卡片视觉 */}
      {livePreview.negative_prompt && (
        <details open>
          <summary style={{
            fontSize: 10.5,
            color: "var(--ink-500)",
            cursor: "pointer",
            fontWeight: 600,
            letterSpacing: "0.04em",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}>
            <Icon name="info" size={10} />
            排除内容 / 负向词 · {livePreview.negative_prompt.length} 字
          </summary>
          <div style={{
            marginTop: 6,
            padding: "8px 10px",
            fontSize: 11.5,
            lineHeight: 1.55,
            color: "var(--ink-700)",
            background: "var(--surface-card)",
            border: "1px solid var(--ink-100)",
            borderRadius: 8,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}>
            {livePreview.negative_prompt}
          </div>
        </details>
      )}

      {/* footer 操作组 — 复制 (副) + 审核后发送 (主). 视觉跟 ComposeBox 主 CTA 呼应 */}
      {customActions ?? (
        <div style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          paddingTop: 4,
          borderTop: "1px dashed var(--ink-100)",
          marginTop: 2,
        }}>
          {onCopy && (
            <Button
              variant="secondary"
              size="sm"
              iconLeft="copy"
              onClick={onCopy}
              title={
                previewKind === "image"
                  ? "复制完整提示词, 可粘到 Midjourney / SDXL / Gemini 等任意生图渠道生成后再导入"
                  : previewKind === "video"
                    ? "复制完整提示词, 可粘到 Runway / Kling / 即梦 等任意生视频渠道生成后再导入"
                    : "复制完整提示词, 可粘到外部渠道生成后再导入"
              }
            >
              复制提示词
            </Button>
          )}
          {onEditAndSend && (
            <Button
              variant="primary"
              size="sm"
              iconLeft="edit"
              onClick={onEditAndSend}
              title="打开审核弹窗, 改各段文字 / 加减参考图 / 改完直接发送 (想细控参考图走这条)"
            >
              {previewKind === "image" ? "审核后发送(首帧)" : previewKind === "video" ? "审核后发送(视频)" : "审核后发送"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
