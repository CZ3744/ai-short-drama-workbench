/**
 * BatchSeriesDialog — re-export 包装 (Wave Z-8 拆分后).
 *
 * 实体文件已移至 batch-series/BatchSeriesDialog.tsx,
 * 此文件保留向后兼容 re-export.
 */

export { BatchSeriesDialog, type BatchSeriesDialogProps } from "./batch-series/BatchSeriesDialog";
export { ProjectCard, type ProjectCardProps } from "./batch-series/ProjectCard";
export { GlobalDefaultsPanel, type GlobalDefaultsPanelProps } from "./batch-series/GlobalDefaultsPanel";
export { AutoRunPanel, type AutoRunPanelProps } from "./batch-series/AutoRunPanel";
export { computeBatchStats, type ProjectSlot, type GlobalDefaults, type BatchStats } from "./batch-series/batchStats";

// 默认导出保持向后兼容
export { BatchSeriesDialog as default } from "./batch-series/BatchSeriesDialog";
