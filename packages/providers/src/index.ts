// ── Old exports (deprecated — prefer core/* interfaces) ──
/** @deprecated Use core/types LlmProvider instead */
export * from "./config";
export * from "./mimo";
export * from "./mockLlm";
export * from "./prompt";
export * from "./aliyunWanClient";
export * from "./promptCompiler";
export * from "./agentRunner";

// Old module exports with conflict-prone names re-exported explicitly
/** @deprecated Use core/types LlmProvider instead */
export { OpenAiCompatibleProvider, type LlmProvider as OldLlmProvider, type JsonCallInput } from "./llm";
/** @deprecated Use core/types VideoProvider instead */
export { LocalMockVideoProvider as OldLocalMockVideoProvider, RealVideoApiTemplateProvider, createVideoProvider, generateMockClip, probeClipDuration, runCommand, parseResolution, aspectRatioToResolution, type VideoProviderName as OldVideoProviderName, type ClipJobInput, type ClipJobResult, type ClipJobStatus, type CostEstimate, type VideoProvider as OldVideoProvider } from "./video";
/** @deprecated Use video/minimaxHailuoProvider instead */
export { MiniMaxHailuoVideoProvider, clampPrompt, type MiniMaxClipJobResult } from "./minimaxVideo";
/** @deprecated Use video/aliyunWanProvider instead */
export { AliyunWanT2VProvider } from "./aliyunWanVideo";
/** @deprecated Use core/types ImageProvider instead */
export { LocalCardImageProvider as OldLocalCardImageProvider, FutureGptImage2Provider, FutureFluxProvider, FutureWanxProvider, FutureHunyuanImageProvider, createImageProvider, listImageProviders, type ImageProviderName, type ImageJobInput, type ImageJobResult, type ImageJobStatus, type ImageCostEstimate, type ImageProvider as OldImageProvider } from "./image";
/** @deprecated Use core/types TtsProvider instead */
export { createTtsProvider, getDefaultVoice, getAvailableVoices, getAudioDuration, type TtsProviderName, type TtsConfig, type TtsOptions, type TtsResult, type TtsProvider as OldTtsProvider } from "./tts";

// ── P20: Unified core interfaces + registry ──
export * from "./core";
export { registerDefaults } from "./core/registry";
export { IkunProvider } from "./llm/ikunProvider";
export { MimoLlmProvider } from "./llm/mimoProvider";
// v4 schema (cc-switch style) — accept ProviderInstance directly, no ENV/preset
export { OpenaiCompatProvider, type OpenaiCompatInstance } from "./llm/openaiCompatProvider";
export { AnthropicCompatProvider, type AnthropicCompatInstance } from "./llm/anthropicCompatProvider";
export { AliyunWanVideoProvider } from "./video/aliyunWanProvider";
export { MiniMaxHailuoVideoWrapper } from "./video/minimaxHailuoProvider";
export { LocalMockVideoProvider } from "./video/localMockVideoProvider";
export { EdgeTtsWrapper } from "./tts/edgeTtsProvider";
export { MiMoTtsWrapper } from "./tts/mimoTtsProvider";
export { WindowsSapiWrapper } from "./tts/windowsSapiProvider";
export { LocalCardImageProvider } from "./image/localCardImageProvider";
export { JimengImageProvider } from "./image/jimengImageProvider";
export { JimengImageClient } from "./image/jimengImageClient";

// ── P25: gpt-image-2 + OpenClaw local providers ──
export { OpenAIGptImage2Provider } from "./image/openaiGptImage2Provider";
export { OpenAIImageClient } from "./image/openaiImageClient";
export { OpenClawLocalImageProvider } from "./image/openclawLocalImageProvider";
export { OpenClawLocalVideoProvider } from "./video/openclawLocalVideoProvider";
export { runPythonScript } from "./core/localExec";
export type { RunPythonScriptOpts, RunPythonScriptResult } from "./core/localExec";

// ── P5A: burnSubtitles ──
export { burnSubtitles } from "./video/burnSubtitles";
export type { BurnSubtitlesOptions } from "./video/burnSubtitles";

// ── P24: Vidu Q3 Reference-to-Video ──
export { ViduRefVideoProvider } from "./video/viduRefVideoProvider";
export { ViduClient } from "./video/viduClient";

// ── P23: Kling 3.0 Image-to-Video ──
export { KlingVideoProvider } from "./video/klingVideoProvider";
export { KlingJwtManager, signKlingJwt, isJwtExpired } from "./video/klingJwt";
export { submitKlingI2V, queryKlingTask, pollKlingTask, downloadKlingVideo, loadKlingConfig, mapKlingErrorCode } from "./video/klingClient";
export { pollAsyncJob } from "./core/asyncJobPoller";

// ── P22: Jimeng Video 3.0 Pro / 720P ──
export { JimengVideoProvider } from "./video/jimengVideoProvider";
export { submitJimengVideoTask, queryJimengVideoTask, downloadJimengVideo, loadJimengVideoConfig, resolveModelVariant, mapApiErrorType } from "./video/jimengVideoClient";
export { buildSignedRequest, redactAuthHeader } from "./video/volcSign";

// ── P150 B3: CLIP quality scoring + continuity checking ──
export { scoreImage } from "./quality/clipScorer";
export { checkContinuity, type ContinuityResult } from "./quality/continuityChecker";
