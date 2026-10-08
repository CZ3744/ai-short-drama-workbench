/**
 * shot-stage parts — 从 ShotStagePage 拆出的内嵌子组件 (P2 #16).
 * 视觉零变更. 各文件独立 props, 不依赖父 closure.
 */
export { Field } from "./Field";
export { CollapsibleSection } from "./CollapsibleSection";
export { TagSelect } from "./TagSelect";
export { CameraMovementSelect } from "./CameraMovementSelect";
export { ImportTile } from "./ImportTile";
export { PlaceholderTile } from "./PlaceholderTile";
export { WaitingModelTile } from "./WaitingModelTile";
export { FailedTaskTile } from "./FailedTaskTile";
export { AnchorChipImg } from "./AnchorChipImg";
export { SortableKeyAnchorChip } from "./SortableKeyAnchorChip";
export { InlinePromptPreviewBody } from "./InlinePromptPreviewBody";
export { FirstFrameTile } from "./FirstFrameTile";
export { VideoCandidateTile } from "./VideoCandidateTile";
// 通用样式 — 主 ShotStagePage 与 parts 共用
export {
  inputStyle,
  textareaStyle,
  removeBadgeStyle,
  candidateZoneStyle,
  candidateHeaderStyle,
  candidateHeaderStickyStyle,
  zoneTitleStyle,
  candidateEmptyStyle,
  inlinePreviewStyle,
  inlinePreviewSummaryStyle,
  mentionHintStyle,
  pickStarBadge,
  overlayBtnPrimary,
  overlayBtnAmber,
  overlayBtnInfo,
  overlayBtnDanger,
  overlayBtnInpaint,
} from "./styles";
