/**
 * InlinePromptPreviewBody — 内嵌提示词预览 (候选区 header <details> 展开后的内容).
 *
 * W11 A3 (2026-05-27): 改成 PromptPreviewBlock 轻 wrapper — 内容渲染下沉到唯一真理源.
 * 老 caller (FirstFrameColumn / VideoColumn) 不用动 import, 行为完全一致.
 */
import { PromptPreviewBlock } from "../../../components/shared/PromptPreviewBlock";
import type { PromptPreview } from "../../../lib/shotApi";

export function InlinePromptPreviewBody({
  previewKind, shotId, livePreview, liveLoading, onCopy, onEditAndSend, onPromptOverrideChange,
}: {
  previewKind: "image" | "video";
  /**
   * 2026-05-29 P0 (跨分镜状态泄漏): 切镜时用 `previewKind-shotId` 当 key 强制 remount
   * PromptPreviewBlock, 清掉它内部的 userEditedRef / draft / viewMode —— 否则 A 镜在全文
   * 模式改过的文本会残留到 B 镜的全文编辑框("已修改" chip 常亮 + 显旧镜文本),
   * 用户基于旧文本继续编辑会污染 B 镜抽卡 prompt。违反 UX 铁律 #5/#7/#12。
   */
  shotId: string;
  livePreview: PromptPreview | null;
  liveLoading: boolean;
  onCopy: () => void;
  onEditAndSend: () => void;
  /** 2026-05-27 — 全文模式编辑后上报给 caller 的 override prompt (null=没改) */
  onPromptOverrideChange?: (override: string | null) => void;
}) {
  return (
    <PromptPreviewBlock
      key={`${previewKind}-${shotId}`}
      livePreview={livePreview}
      loading={liveLoading}
      previewKind={previewKind}
      onCopy={onCopy}
      onEditAndSend={onEditAndSend}
      onPromptOverrideChange={onPromptOverrideChange}
    />
  );
}
