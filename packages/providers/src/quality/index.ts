/**
 * Quality module — B3 Wave B
 *
 * CLIP-style scoring, continuity checking, prompt pre-check,
 * and post-generation quality checks for generated assets.
 */
export { scoreImage } from "./clipScorer";
export { checkContinuity, type ContinuityResult } from "./continuityChecker";
export { precheckPrompt, type PrecheckResult, type PrecheckIssue } from "./promptPrecheck";
export { postGenCheck, computeSharpness, type QualityScores, type PostGenCheckOptions } from "./postGenCheck";
