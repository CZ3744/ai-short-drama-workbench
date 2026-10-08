// studio barrel — 2026-05-26 audit #7 清理后只剩在用的几个.
// 删除孤儿组件: CanvasEditor / CostBadge / CostPanel / GenerationCountBadge / ProviderSwitch /
//   QueueIndicator / SeriesPicker / StyleChip / ThumbGrid / Thumbnail / TimelineNav / WaitPanel / TopBar
//   (13 个无外部引用, git log 可查).
export { PresetSelect, type PresetSelectProps } from "./PresetSelect";
export { ProviderHealthDot, type ProviderHealthDotProps } from "./ProviderHealthDot";
export { StatusPill, type StatusPillProps, type StatusValue } from "./StatusPill";
export { InlineActionBar, type InlineActionBarProps } from "./InlineActionBar";
export { FileDropZone, type FileDropZoneProps } from "./FileDropZone";
