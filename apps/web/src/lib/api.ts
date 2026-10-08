// ====================================================================
// lib/api.ts — Barrel re-export (P1 Wave 2 #11 解耦)
// ====================================================================
//
// 2026-05-20 P1 解耦: 原 2927 行的上帝文件按职责拆分到独立 modality 文件,
// 本文件仅作 barrel re-export, **零 caller 变更**(所有 import 路径不变).
//
// 拆分清单:
// - _apiClient    — fetch 核心 (ApiError, apiGet/Post/Patch/Put/Delete, seriesPath, ...)
// - settingsApi   — MimoConfig / TtsSettings / SecretsStatus / V2Settings / Budget / RealVideoLockStatus
// - voiceApi      — 角色语音克隆 (upload / delete sample / 播放 URL)
// - storageApi    — StorageUsage / Backup / 项目导入导出
// - seriesApi     — Series CRUD / Inspirations / Clarify / Templates / Preferences / expandScriptV2
// - libraryApi    — Library Characters/Scenes / Variants / Vault / Mood Board / Cross-project
// - providerApi   — Provider Health / Chain / CRUD / cc-switch helpers / Preset / Ping
// - chatgptOauthApi — ChatGPT OAuth (Codex gpt-image-2)
// - diagnosticsApi  — Failures / Diagnostics / Raw Image / SSE reader
//
// 新代码可以选择从单独的 modality file 直接 import (更小的依赖图),
// 但旧代码 import { X } from "../lib/api" 完全保持兼容.
// ====================================================================

export * from "./_apiClient";
// 2026-05-26 audit #7: jobsApi v1 文件整个删 (Job CRUD / Scene CRUD / Manifest / Clip 等
// 全是 v1 死代码, 前端只剩 getRealVideoLockStatus 在用, 已迁到 settingsApi).
// 2026-05-28 P1-3: queueApi 整文件 86 行死代码删除. 前端从无 caller, 后端 task_queue
// 直接用 packages/core/src/db/taskQueue 不经此层. 同时清掉 barrel re-export.
export * from "./settingsApi";
export * from "./voiceApi";
export * from "./storageApi";
export * from "./seriesApi";
export * from "./libraryApi";
export * from "./providerApi";
export * from "./chatgptOauthApi";
export * from "./diagnosticsApi";
