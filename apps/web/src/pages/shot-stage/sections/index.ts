// P1 #17 (2026-05-21): shot-stage 主入口拆出的 5 个 section 子组件.
// 视觉零变更, 纯展示, 所有 state / hook 留在主页面 ShotStagePage.
export { ShotStageHeader } from "./ShotStageHeader";
export { ShotPromptColumn } from "./ShotPromptColumn";
export { FirstFrameColumn } from "./FirstFrameColumn";
export { VideoColumn } from "./VideoColumn";
export { RejectPoolSection } from "./RejectPoolSection";
export { ShotStageModals } from "./ShotStageModals";

export type { ShotRejectLookup, RejectTier } from "./RejectPoolSection";
