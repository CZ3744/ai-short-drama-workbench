/**
 * generation/ — 统一图像生成 UI (Phase 2, Wave 2, 2026-05-16).
 *
 * 对外入口:
 *  - <ImageGenerationPanel> — Element / Shot / Library / Vault 全部生图共用
 *  - 类型 / props 接口 — caller 接入时引用
 *
 * 注: VideoGenerationPanel 已于 2026-05-20 死代码清理移除 (0 caller).
 *     ShotStagePage 直接走 useVideoGeneration hook + ComposeBox.
 */

export { ImageGenerationPanel } from "./ImageGenerationPanel";
export type {
  ImageGenerationPanelProps,
  CompiledPromptForGeneration,
  PromptCompileOpts,
} from "./ImageGenerationPanel";
