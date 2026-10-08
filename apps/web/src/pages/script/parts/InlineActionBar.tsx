import { useState, type ReactNode } from "react";
import { cn } from "../../../lib/cn";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { Separator } from "../../../components/ui/separator";
import { AnimatePresence, motion } from "framer-motion";
import { PromptReviewButton, type PromptPreview } from "../../../components/shared/PromptReviewButton";
import { apiPost } from "../../../lib/api";
import {
  PenLine,
  Maximize2,
  Minimize2,
  MessageSquare,
  Mic,
  BookOpen,
  Trash2,
  ChevronDown,
} from "../../../components/shared/LucideIcon";

// ====================================================================
// 语气预设
// ====================================================================

const TONE_PRESETS = [
  { id: "suspense", label: "悬疑" },
  { id: "romantic", label: "浪漫" },
  { id: "humorous", label: "幽默" },
  { id: "dramatic", label: "戏剧" },
  { id: "neutral", label: "中性" },
  { id: "poetic", label: "诗意" },
  { id: "tense", label: "紧张" },
];

// ====================================================================
// InlineActionBar
// ====================================================================

export type BarAction =
  | "rewrite"
  | "expand"
  | "condense"
  | "change_tone"
  | "set_dialogue"
  | "set_voiceover"
  | "delete";

export interface InlineActionBarProps {
  visible: boolean;
  /** 选中的文字 */
  selectedText?: string;
  /** 操作回调 */
  onAction: (action: BarAction, extra?: { tone?: string; customPrompt?: string }) => void;
  /** 所属系列 slug；传入后改写 / 扩写 / 缩写旁会显示发送前审核按钮 */
  seriesSlug?: string;
  /** 当前剧本文本上下文，用于 preview-ai-suggest-prompt */
  contextText?: string;
  /** 用户在页面上选择的 LLM 模型 */
  llmModelRef?: string | null;
  /** 关闭工具条 */
  onClose?: () => void;
  /** 定位 */
  style?: React.CSSProperties;
  className?: string;
}

export function InlineActionBar({
  visible,
  selectedText,
  onAction,
  seriesSlug,
  contextText,
  llmModelRef,
  onClose,
  style,
  className,
}: InlineActionBarProps) {
  const [toneMenuOpen, setToneMenuOpen] = useState(false);
  const [rewritePopoverOpen, setRewritePopoverOpen] = useState(false);
  const [customPrompt, setCustomPrompt] = useState("");

  const handleRewrite = () => {
    setRewritePopoverOpen(true);
  };

  const handleRewriteSubmit = () => {
    onAction("rewrite", { customPrompt: customPrompt || "改写这段内容" });
    setRewritePopoverOpen(false);
    setCustomPrompt("");
  };

  const selected = (selectedText || "").trim();
  const canPreviewSuggest = Boolean(seriesSlug && (selected || contextText?.trim()));

  const instructionFor = (action: BarAction, extra?: { customPrompt?: string }): string => {
    if (extra?.customPrompt?.trim()) return extra.customPrompt.trim();
    if (action === "expand") return "扩写这段内容，保留原意并增加细节";
    if (action === "condense") return "缩写这段内容，保留核心信息";
    return "改写这段内容，让表达更自然";
  };

  const loadSuggestPrompt = async (
    action: BarAction,
    extra?: { customPrompt?: string },
  ): Promise<PromptPreview> => {
    if (!seriesSlug) throw new Error("缺少系列信息，无法预览提示词");
    return apiPost<PromptPreview>(
      `/api/v2/series/${encodeURIComponent(seriesSlug)}/preview-ai-suggest-prompt`,
      {
        context: contextText || selected,
        instruction: instructionFor(action, extra),
        scope: { kind: "selection", action, selected_text: selected },
        llm_provider_id: llmModelRef ?? undefined,
      },
    );
  };

  const sendReviewed = (action: BarAction, editedPrompt: string, extra?: { tone?: string }) => {
    onAction(action, { ...extra, customPrompt: editedPrompt });
    setRewritePopoverOpen(false);
    setCustomPrompt("");
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 8, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.95 }}
          transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
          style={style}
          className={cn(
            "fixed z-50 inline-flex items-center gap-0.5 rounded-[var(--r-lg)] bg-[var(--surface-card)] p-1 shadow-[var(--shadow-lg)] border border-[var(--ink-100)]",
            className
          )}
        >
          {/* 改写 */}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRewrite}
              className="gap-1"
            >
              <PenLine className="h-3.5 w-3.5" />
              改写
            </Button>
            {rewritePopoverOpen && (
              <div className="absolute top-full left-0 mt-2 w-64 bg-white rounded-[var(--r-lg)] shadow-[var(--shadow-lg)] border border-[var(--ink-100)] p-3 z-50">
                <Textarea
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                  placeholder="输入改写想法..."
                  className="h-20 resize-none"
                  autoFocus
                />
                <div className="flex justify-end gap-2 mt-2">
                  <Button variant="ghost" size="sm" onClick={() => setRewritePopoverOpen(false)}>
                    取消
                  </Button>
                  {canPreviewSuggest && (
                    <PromptReviewButton
                      label="审核提示词"
                      size="sm"
                      loadPrompt={() => loadSuggestPrompt("rewrite", { customPrompt })}
                      onSend={(editedPrompt) => sendReviewed("rewrite", editedPrompt)}
                    />
                  )}
                  <Button variant="primary" size="sm" onClick={handleRewriteSubmit}>
                    改写
                  </Button>
                </div>
              </div>
            )}
          </div>

          <Separator orientation="vertical" className="mx-0.5 h-5" />

          {/* 扩写 */}
          <div className="inline-flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onAction("expand")}
              className="gap-1"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              扩写
            </Button>
            {canPreviewSuggest && (
              <PromptReviewButton
                label="审核"
                size="sm"
                loadPrompt={() => loadSuggestPrompt("expand")}
                onSend={(editedPrompt) => sendReviewed("expand", editedPrompt)}
              />
            )}
          </div>

          <Separator orientation="vertical" className="mx-0.5 h-5" />

          {/* 缩写 */}
          <div className="inline-flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onAction("condense")}
              className="gap-1"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              缩写
            </Button>
            {canPreviewSuggest && (
              <PromptReviewButton
                label="审核"
                size="sm"
                loadPrompt={() => loadSuggestPrompt("condense")}
                onSend={(editedPrompt) => sendReviewed("condense", editedPrompt)}
              />
            )}
          </div>

          <Separator orientation="vertical" className="mx-0.5 h-5" />

          {/* 换语气 */}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setToneMenuOpen(!toneMenuOpen)}
              className="gap-1"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              换语气
              <ChevronDown className="h-3 w-3" />
            </Button>
            {toneMenuOpen && (
              <div className="absolute top-full left-0 mt-2 w-32 bg-white rounded-[var(--r-lg)] shadow-[var(--shadow-lg)] border border-[var(--ink-100)] py-1 z-50">
                {TONE_PRESETS.map((tone) => (
                  <button
                    key={tone.id}
                    className="w-full text-left px-3 py-1.5 text-[var(--fs-sm)] text-[var(--ink-700)] hover:bg-[var(--ink-50)] transition-colors"
                    onClick={() => {
                      onAction("change_tone", { tone: tone.id });
                      setToneMenuOpen(false);
                    }}
                  >
                    {tone.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <Separator orientation="vertical" className="mx-0.5 h-5" />

          {/* 设为对白 */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onAction("set_dialogue")}
            className="gap-1"
          >
            <Mic className="h-3.5 w-3.5" />
            对白
          </Button>

          <Separator orientation="vertical" className="mx-0.5 h-5" />

          {/* 设为旁白 */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onAction("set_voiceover")}
            className="gap-1"
          >
            <BookOpen className="h-3.5 w-3.5" />
            旁白
          </Button>

          <Separator orientation="vertical" className="mx-0.5 h-5" />

          {/* 删除 — 2026-05-19 铁律 #11 补可见文字 */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onAction("delete")}
            className="gap-1 text-[var(--err)] hover:text-[var(--err)]"
            title="删除这一行"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>删除</span>
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
