/**
 * PromptReviewButton — 全局通用「发送前查看完整提示词」组件 (W5-B)
 *
 * UX 铁律 #2: 可干预性 > 自动化. 每一个 LLM / 图像 / 视频 / TTS 调用旁都必须挂一颗这种按钮:
 *   - 点击 → 加载即将发送的"自包含提示词"(prompt + 参考图 + system + messages)
 *   - 用户可改可复制可外送 (复制走到别的 AI 服务自己生, 然后粘贴回来作 manual import)
 *   - 改完按"用修改后版本发送"才真发起调用 (onSend 可选, 不传则只读)
 *
 * 这一颗按钮内部封装了 W4 已经做好的 components/element/PromptReviewModal:
 *   - 不重复造 Modal, 直接复用渲染层 (textarea / 复制按钮 / 参考图缩略图)
 *   - 此按钮自己额外吐:
 *       · 顶部 target_provider / model + 估费摘要
 *       · system_prompt / messages 分块只读展示
 *       · "复制参考图链接"按钮 (写出 JSON 数组到剪贴板)
 *
 * 后端约定: 调 preview-* / dryRun 端点 → 返 PromptPreview (字段见下方接口).
 */

import { useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { labelOfSource } from "../../lib/sourceLabels";
import { copyPromptWithImages } from "../../lib/copyPromptWithImages";

// ─── 数据契约 ────────────────────────────────────────────────────

export interface PromptPreviewMessage {
  role: string;
  content: string;
}

export interface PromptPreviewReferenceImage {
  url: string;
  label: string;
}

export interface PromptPreview {
  /** 用途种类, 影响默认标题与是否展示参考图 */
  kind: "text" | "image" | "video" | "tts";
  /** 完整自包含提示词 (用户可改的主体) */
  full_prompt: string;
  /** 负向提示词 (图像/视频), 只读 */
  negative_prompt?: string;
  /** system / user 分立时, system 段单独展示 */
  system_prompt?: string;
  /** 多轮对话场景, 展示 messages 数组 */
  messages?: PromptPreviewMessage[];
  /** 图像 i2i 参考图 */
  reference_images?: PromptPreviewReferenceImage[];
  /** 视频运镜参考视频 */
  reference_video?: { url: string; label: string };
  /** 即将调用的 provider id (展示用) */
  target_provider?: string;
  target_model?: string;
  /** 估费 (有则展示) */
  estimated_cost?: { cny?: number; note?: string };
}

// ─── Props ───────────────────────────────────────────────────────

export interface PromptReviewButtonProps {
  /** 异步拉取即将发送的完整 prompt — 通常调一个 /preview-*-prompt 或 /dry-run 端点 */
  loadPrompt: () => Promise<PromptPreview>;
  /**
   * 用户确认后真发送 (可选);
   * 参数是 textarea 当前值 (可能被用户改过).
   * 不传则隐藏 "用修改后版本发送" 按钮 — 此时只读纯审阅.
   */
  onSend?: (editedPrompt: string) => Promise<void> | void;
  /** 按钮文字, 默认 "查看完整提示词" (铁律 #11) */
  label?: string;
  size?: "sm" | "md";
  disabled?: boolean;
  /** 在 modal 外的"加载中"占位; 若传 false 由组件自己显示 "加载中" 文字 */
  busy?: boolean;
  /** 自定义按钮 className (允许外部覆写) */
  className?: string;
  /** 标题 — 默认按 kind 推 */
  title?: string;
  /** 导入用户在外部 AI 生成的图片/结果 */
  onManualImport?: (files: File[]) => Promise<void> | void;
}

// ─── 工具 ────────────────────────────────────────────────────────

const KIND_TITLE: Record<PromptPreview["kind"], string> = {
  text: "发送前审核 LLM 提示词",
  image: "发送前审核图像提示词",
  video: "发送前审核视频提示词",
  tts: "发送前审核 TTS 请求体",
};

const KIND_LABEL: Record<PromptPreview["kind"], string> = {
  text: "文本",
  image: "图像",
  video: "视频",
  tts: "配音",
};

function copyToClipboard(text: string): Promise<void> {
  return navigator.clipboard?.writeText(text) ?? Promise.resolve();
}

// ─── 组件 ────────────────────────────────────────────────────────

export function PromptReviewButton(props: PromptReviewButtonProps) {
  const {
    loadPrompt,
    onSend,
    label = "查看完整提示词",
    size = "sm",
    disabled = false,
    busy: externalBusy = false,
    className,
    title,
    onManualImport,
  } = props;

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  function flash(msg: string): void {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2200);
  }

  async function handleClick(): Promise<void> {
    if (disabled || loading || externalBusy) return;
    setError(null);
    setLoading(true);
    setOpen(true);
    try {
      const p = await loadPrompt();
      setPreview(p);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(editedPrompt: string): Promise<void> {
    if (!onSend) {
      setOpen(false);
      return;
    }
    setSending(true);
    try {
      await onSend(editedPrompt);
      setOpen(false);
    } catch (e: unknown) {
      flash(`发送失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setSending(false);
    }
  }

  async function copyFullJson(): Promise<void> {
    if (!preview) return;
    const payload = {
      kind: preview.kind,
      full_prompt: preview.full_prompt,
      negative_prompt: preview.negative_prompt ?? null,
      system_prompt: preview.system_prompt ?? null,
      messages: preview.messages ?? null,
      reference_images_count: preview.reference_images?.length ?? 0,
      target_provider: preview.target_provider ?? null,
      target_model: preview.target_model ?? null,
    };
    await copyToClipboard(JSON.stringify(payload, null, 2));
    flash("已复制完整提示词 JSON");
  }

  async function copyReferenceLinks(): Promise<void> {
    if (!preview?.reference_images || preview.reference_images.length === 0) return;
    const urls = preview.reference_images.map((r) => r.url);
    await copyToClipboard(JSON.stringify(urls, null, 2));
    flash(`已复制 ${urls.length} 个参考图链接`);
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={size}
        iconLeft="eye"
        onClick={handleClick}
        disabled={disabled || externalBusy}
        title="查看即将发送给模型的完整提示词 (可改可复制可外送)"
        className={className}
      >
        {label}
      </Button>

      {open ? (
        <PromptPreviewDialog
          preview={preview}
          loading={loading}
          error={error}
          sending={sending}
          title={title ?? (preview ? KIND_TITLE[preview.kind] : "发送前审核完整提示词")}
          onClose={() => setOpen(false)}
          onConfirm={onSend ? handleConfirm : undefined}
          onCopyFullJson={copyFullJson}
          onCopyReferenceLinks={copyReferenceLinks}
          onManualImport={onManualImport}
          feedback={feedback}
        />
      ) : null}
    </>
  );
}

// ─── 内部 Dialog: 包装 element/PromptReviewModal + 头部 + 元数据段 ───

interface DialogProps {
  preview: PromptPreview | null;
  loading: boolean;
  error: string | null;
  sending: boolean;
  title: string;
  onClose: () => void;
  onConfirm?: (edited: string) => void | Promise<void>;
  onCopyFullJson: () => void | Promise<void>;
  onCopyReferenceLinks: () => void | Promise<void>;
  onManualImport?: (files: File[]) => Promise<void> | void;
  feedback: string | null;
}

function PromptPreviewDialog(props: DialogProps) {
  const {
    preview, loading, error, sending, title,
    onClose, onConfirm, onCopyFullJson, onCopyReferenceLinks, onManualImport, feedback,
  } = props;

  // 错误 / 加载占位也是 modal — 不复用 element/PromptReviewModal 因为它假设 fullPrompt 必存
  if (loading || error || !preview) {
    return (
      <div
        style={{
          position: "fixed", inset: 0, background: "rgba(40,32,24,0.42)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
        }}
        onClick={onClose}
      >
        <div
          className="mk-card"
          onClick={(e) => e.stopPropagation()}
          style={{ width: 520, maxWidth: "92vw", padding: 22 }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--ink-900)" }}>{title}</h3>
            {/* W8-sweep (2026-05-16): icon-only → icon + 文字 (铁律 #11) */}
            <Button variant="ghost" size="sm" iconLeft="close" onClick={onClose} title="关闭审核窗">
              关闭
            </Button>
          </div>
          {error ? (
            <div style={{ color: "var(--err)", fontSize: 13 }}>
              拉取提示词失败:<br />
              <span style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12 }}>{error}</span>
            </div>
          ) : (
            <div style={{ color: "var(--ink-500)", fontSize: 13 }}>正在加载完整提示词…</div>
          )}
        </div>
      </div>
    );
  }

  // 正常态: 头部 meta + 复用 element/PromptReviewModal 渲染主体
  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(40,32,24,0.42)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        className="mk-card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 720, maxWidth: "94vw", maxHeight: "90vh", overflow: "auto", padding: 22 }}
      >
        {/* 头部 — provider/model/estimate */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--ink-900)" }}>{title}</h3>
          {/* W8-sweep (2026-05-16): icon-only → icon + 文字 (铁律 #11) */}
          <button className="mk-btn mk-btn--ghost mk-btn--sm" onClick={onClose} title="关闭审核窗">
            <Icon name="close" size={14} /> 关闭
          </button>
        </div>
        <p style={{ fontSize: 12, color: "var(--ink-500)", marginTop: 0, marginBottom: 10 }}>
          这是最终将发送给模型的完整内容。它是自包含的—你也可以复制走，到其它平台生成后再导入。
        </p>

        {/* meta 行: provider / model / cost */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12, fontSize: 11.5 }}>
          {preview.target_provider ? (
            <span className="mk-chip mk-chip--ghost" title={`即将调用: ${preview.target_provider}`}>
              调用 · {labelOfSource(preview.target_provider)}
            </span>
          ) : null}
          {preview.target_model ? (
            <span className="mk-chip mk-chip--ghost" title="模型 id">
              model · {preview.target_model}
            </span>
          ) : null}
          {preview.estimated_cost && preview.estimated_cost.cny != null ? (
            <span className="mk-chip mk-chip--ghost" title={preview.estimated_cost.note ?? "估费"}>
              估费 · ¥{preview.estimated_cost.cny.toFixed(4)}
            </span>
          ) : null}
          <span className="mk-chip mk-chip--ghost">用途 · {KIND_LABEL[preview.kind] ?? preview.kind}</span>
        </div>

        {/* system_prompt — 只读 */}
        {preview.system_prompt ? (
          <div style={{ marginBottom: 12 }}>
            <div className="mk-label" style={{ marginBottom: 4 }}>system prompt (只读)</div>
            <pre
              style={{
                margin: 0, padding: "8px 10px", background: "var(--ink-50)",
                borderRadius: 8, fontFamily: "ui-monospace, Consolas, monospace",
                fontSize: 11.5, color: "var(--ink-700)", whiteSpace: "pre-wrap",
                maxHeight: 180, overflow: "auto",
              }}
            >{preview.system_prompt}</pre>
          </div>
        ) : null}

        {/* messages — 多轮对话, 只读 */}
        {preview.messages && preview.messages.length > 0 ? (
          <div style={{ marginBottom: 12 }}>
            <div className="mk-label" style={{ marginBottom: 4 }}>对话历史 ({preview.messages.length} 条, 只读)</div>
            <div style={{ background: "var(--ink-50)", borderRadius: 8, padding: 8, maxHeight: 200, overflow: "auto" }}>
              {preview.messages.map((m, i) => (
                <div key={i} style={{ marginBottom: 6, fontSize: 11.5 }}>
                  <span style={{ fontWeight: 700, color: "var(--brand-700)" }}>{m.role}:</span>{" "}
                  <span style={{ color: "var(--ink-700)", whiteSpace: "pre-wrap" }}>{m.content}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* reference_video */}
        {preview.reference_video ? (
          <div style={{ marginBottom: 12 }}>
            <div className="mk-label" style={{ marginBottom: 4 }}>参考视频</div>
            <a
              href={preview.reference_video.url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, color: "var(--brand-600)" }}
            >
              {preview.reference_video.label || preview.reference_video.url}
            </a>
          </div>
        ) : null}

        {/* 主体 — 复用 element/PromptReviewModal (with onConfirm wrapper that bridges to outer onSend) */}
        <InlineEditablePromptBlock
          fullPrompt={preview.full_prompt}
          negativePrompt={preview.negative_prompt}
          referenceImages={preview.reference_images ?? []}
          sending={sending}
          onConfirm={onConfirm}
          onCopyFullJson={onCopyFullJson}
          onCopyReferenceLinks={onCopyReferenceLinks}
          onManualImport={onManualImport}
          onClose={onClose}
        />

        {feedback ? (
          <div
            style={{
              position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)",
              background: "var(--ink-900)", color: "#fff", padding: "8px 16px",
              borderRadius: 999, fontSize: 12.5, zIndex: 300,
            }}
          >{feedback}</div>
        ) : null}
      </div>
    </div>
  );
}

// ─── 主体 editable block — 不直接复用 PromptReviewModal 因为我们的 modal 外层已自渲染头部 ───
// 但保留 PromptReviewModal 已有的: 可编辑 textarea / 复制按钮 / 参考图缩略图 视觉与逻辑一致

interface EditableBlockProps {
  fullPrompt: string;
  negativePrompt?: string;
  referenceImages: PromptPreviewReferenceImage[];
  sending: boolean;
  onConfirm?: (edited: string) => void | Promise<void>;
  onCopyFullJson: () => void | Promise<void>;
  onCopyReferenceLinks: () => void | Promise<void>;
  onManualImport?: (files: File[]) => Promise<void> | void;
  onClose: () => void;
}

function InlineEditablePromptBlock(props: EditableBlockProps) {
  const {
    fullPrompt, negativePrompt, referenceImages,
    sending, onConfirm, onCopyFullJson, onCopyReferenceLinks, onManualImport, onClose,
  } = props;

  const [draft, setDraft] = useState<string>(fullPrompt);
  const manualImportRef = useRef<HTMLInputElement | null>(null);
  // 2026-05-20: 铁律 #13 — 复制含图 (base64 内联) — 与 PromptReviewModal 共用 helper
  const [copyingAll, setCopyingAll] = useState(false);
  const [copyAllStatus, setCopyAllStatus] = useState<string | null>(null);

  async function copyDraft(): Promise<void> {
    await copyToClipboard(draft);
  }

  async function copyNegative(): Promise<void> {
    if (!negativePrompt) return;
    await copyToClipboard(negativePrompt);
  }

  async function handleCopyAllWithImages(): Promise<void> {
    setCopyingAll(true);
    setCopyAllStatus(null);
    try {
      const result = await copyPromptWithImages({
        fullPrompt: draft,
        negativePrompt: negativePrompt || undefined,
        images: referenceImages.map(r => ({ url: r.url, label: r.label })),
      });
      setCopyAllStatus(result.message);
      setTimeout(() => setCopyAllStatus(null), 4000);
    } catch (e) {
      setCopyAllStatus(`复制失败: ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => setCopyAllStatus(null), 4000);
    } finally {
      setCopyingAll(false);
    }
  }

  return (
    <>
      <div className="mk-label" style={{ marginBottom: 4 }}>完整提示词 (可改)</div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-[220px] font-mono text-[12.5px]"
      />

      <div style={{ display: "flex", gap: 8, margin: "10px 0 14px", flexWrap: "wrap", alignItems: "center" }}>
        <Button variant="secondary" size="sm" iconLeft="doc" onClick={copyDraft}>
          复制提示词原文
        </Button>
        {/* 铁律 #13: 复制全部含图 (base64 内联) — 有参考图时展示此主按钮 */}
        {referenceImages.length > 0 ? (
          <Button
            variant="primary"
            size="sm"
            iconLeft="download"
            loading={copyingAll}
            onClick={() => void handleCopyAllWithImages()}
            title="把提示词 + 所有参考图打包成 markdown (图 base64 内联) 复制到剪贴板,直接粘到 ChatGPT/Claude/Gemini"
            style={{ background: "var(--brand-600)", color: "white", borderColor: "var(--brand-700)" }}
          >
            {copyingAll ? "打包中..." : `复制全部 (含 ${referenceImages.length} 张图)`}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onCopyFullJson}>
          复制完整 JSON
        </Button>
        {negativePrompt ? (
          <Button variant="ghost" size="sm" onClick={copyNegative} title="排除内容（告诉 AI 哪些元素不要画进去）">
            复制排除内容
          </Button>
        ) : null}
        {referenceImages.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={onCopyReferenceLinks}>
            复制参考图链接 ({referenceImages.length})
          </Button>
        ) : null}
        {copyAllStatus ? (
          <span style={{ fontSize: 12, color: copyAllStatus.includes("失败") ? "var(--err)" : "var(--ok)" }}>
            {copyAllStatus}
          </span>
        ) : null}
      </div>

      {negativePrompt ? (
        <div style={{ marginBottom: 14 }}>
          <div className="mk-label" style={{ marginBottom: 4 }} title="告诉 AI 哪些元素不要画进去">排除内容 (只读)</div>
          <div
            style={{
              fontSize: 11.5, color: "var(--ink-700)", background: "var(--ink-50)",
              padding: "8px 10px", borderRadius: 8, whiteSpace: "pre-wrap",
            }}
          >{negativePrompt}</div>
        </div>
      ) : null}

      {referenceImages.length > 0 ? (
        <>
          <div className="mk-label" style={{ marginBottom: 6 }}>附带参考图 ({referenceImages.length})</div>
          <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            {referenceImages.map((ref, i) => {
              // 铁律 #13: caller 在 label 里塞 "来自:xxx" / "角度:xxx" 等关键信息,
              // 不应只藏在 img alt 里 hover 才看见. 缩略图下方默认显示 label, 跨素材引用还要醒目标记.
              const isCrossElement = ref.label.includes("来自:");
              return (
                <div key={i} style={{ width: 96 }}>
                  <div style={{ position: "relative" }}>
                    <img
                      src={ref.url}
                      alt={ref.label}
                      style={{
                        width: 96, height: 96, objectFit: "cover",
                        borderRadius: 5,
                        border: isCrossElement
                          ? "2px solid var(--brand-500)"
                          : "1px solid var(--ink-200)",
                      }}
                      title={ref.label}
                    />
                    {isCrossElement ? (
                      <span
                        style={{
                          position: "absolute", top: 4, left: 4,
                          padding: "1px 5px", borderRadius: 999,
                          background: "rgba(217,119,87,0.92)",
                          color: "#fff", fontSize: 9, fontWeight: 700,
                          boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
                        }}
                        title="跨素材引用的参考图"
                      >借</span>
                    ) : null}
                  </div>
                  <div
                    style={{
                      marginTop: 4, fontSize: 10.5, lineHeight: 1.35,
                      color: isCrossElement ? "var(--brand-700, #c2410c)" : "var(--ink-600)",
                      fontWeight: isCrossElement ? 600 : 500,
                      wordBreak: "break-all", maxHeight: 30, overflow: "hidden",
                    }}
                    title={ref.label}
                  >
                    {ref.label}
                  </div>
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noreferrer"
                    download
                    style={{ fontSize: 11, color: "var(--brand-600)", display: "block", marginTop: 3 }}
                  >下载</a>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button
            variant="secondary"
            iconLeft="doc"
            onClick={async () => { await copyDraft(); onClose(); }}
            disabled={sending || !draft.trim()}
            title="复制完整提示词并关闭弹窗,可去外部 AI 生成"
          >
            复制后关闭(我自己生)
          </Button>
          {onManualImport ? (
            <>
              <input
                ref={manualImportRef}
                type="file"
                accept="image/*,video/*"
                multiple
                hidden
                onChange={async (e) => {
                  // 2026-05-18: 用户原话"点击本地导入显示成功导入之后,要自动帮我关掉这个二级弹窗"
                  // + "图片生成界面也要这样啊,都查一下一起修" — 与 PromptReviewModal 同款行为
                  const files = Array.from(e.currentTarget.files ?? []);
                  e.currentTarget.value = "";
                  if (files.length === 0) return;
                  try {
                    await onManualImport(files);
                  } finally {
                    onClose();
                  }
                }}
              />
              <Button
                variant="secondary"
                iconLeft="upload"
                onClick={() => manualImportRef.current?.click()}
                disabled={sending}
                title="把外部 AI 生成的图片导入候选池"
              >
                导入外部结果
              </Button>
            </>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={sending}>
            取消
          </Button>
          {onConfirm ? (
          <Button
            variant="primary"
            loading={sending}
            onClick={() => onConfirm(draft)}
            disabled={sending || !draft.trim()}
          >
            {sending ? "发送中…" : "用修改后版本发送"}
          </Button>
          ) : null}
        </div>
      </div>
    </>
  );
}

export default PromptReviewButton;
