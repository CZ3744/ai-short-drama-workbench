/**
 * P11 - Drama 包统一导出
 */
export * from "./types.js";
export * from "./schema.js";
export * from "./layout.js";
export { parseDialogue, resolveVoiceForEmotion } from "./dialogueParser.js";
export type { DialogueLine } from "./types.js";
// Wave B-3 (2026-05-16): 角色 appearance/outfit/personality 拆分后的拼接 helper
export { resolveVisualDescription, formatCharacterForLlmContext } from "./characterPrompt.js";
// 2026-05-17 精修: @ mention 共享解析 (前后端单点定义)
// 2026-05-20: 短格式 short token 支持 — chip 显示 "@林深" 而非 "@角色:林深" (用户偏好)
export {
  mentionTokenOf,
  parseMentionTokens,
  parseMentionTokensFromTexts,
  shortMentionTokenOf,
  parseShortMentionTokens,
  parseShortMentionTokensFromTexts,
  KIND_LABEL,
  type MentionKind,
  type ParsedMentionToken,
  type MentionLookupContext,
} from "./mentionParser.js";
// 2026-05-21 Wave Y: ShotTextNode 富文本节点工具集 (替代 @ token 字符串老架构)
export {
  nodesToPlainText,
  nodesToShortText,
  plainTextToNodes,
  extractMentionRefs,
  getNodesOrDerive,
} from "./shotText.js";
export * from "./memory/preferenceStore.js";
export * from "./memory/profileBuilder.js";

// P150-B1: IntentClarifier + DirectorAgent
export { clarify, type ClarifyResult, type ClarifyQuestion, type ClarifyDimension, DIMENSION_LABELS } from "./agents/clarifier.js";
export type { ClarifyInput } from "./agents/clarifier.js";
export { runDirectorLoop, type DirectorDecision, type DirectorTool, type DirectorAgentOptions, type DirectorRunResult, type ProjectManifest, type QualitySignals, type DirectorStage } from "./agents/directorAgent.js";

// C5: 输出前质检
export { runOutputCheck, type OutputQualityReport, type QualityCheckItem, type CheckLevel } from "./quality/outputCheck.js";
