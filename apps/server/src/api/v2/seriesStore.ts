/**
 * v2 Series Store — Barrel re-export from repository modules
 *
 * Step 1 拆分 (2026-05-14): 原 2545 行上帝模块按聚合根拆到 ../../repositories/.
 * 这个文件现在只做 re-export, 让所有 controller / job / test 的 import 路径不破.
 * 后续 Step 1.5 会:
 *  (a) 把各 repo 里重复的 path helper 抽到 ../../repositories/_paths.ts
 *  (b) 把 controller 里的 import 直接迁到 repositories/*Repo, 然后删本文件
 *
 * 原文件备份: seriesStore.ts.bak (同目录, 不被 tsc 编译)
 *
 * 拆分映射:
 *   seriesRepo.ts     — Series / SeriesData / SeriesDefaults / listSeries / createSeries / ...
 *   episodeRepo.ts    — Episode / EpisodeData / ComposeVersion / version files
 *   characterRepo.ts  — Character / SeriesVariant / char variants
 *   sceneRepo.ts      — Scene + scene variants
 *   shotRepo.ts       — Shot / generation / prompt versions / locateShotById / failures-by-id
 *   assetRepo.ts      — Asset + resolveAssetFilePath
 *   templateRepo.ts   — Templates / builtin / storyboard skeleton
 *   moodboardRepo.ts  — MoodBoard
 *   ledgerRepo.ts     — LedgerEntry / queryLedger / aggregateLedger
 *   taskRepo.ts       — TaskRecord
 *   failureRepo.ts    — ScannedFailure / scanAllFailedGenerations / scanAllFailedTasks
 */

// ─── Series ────────────────────────────────────────────────────────
export type {
  SeriesScriptVersion,
  SeriesData,
  SeriesDefaults,
  SeriesListItem,
  ListSeriesOptions,
} from "../../repositories/seriesRepo";
export {
  isInternalTestSeries,
  listSeries,
  readSeries,
  createSeries,
  updateSeries,
  deleteSeries,
  cleanupTrash,
  duplicateSeries,
  listSamples,
  cloneSampleFromDisk,
  // 2026-05-19 Wave O 致命遗留 2: 系列回收站 UI 后端
  listTrashedSeries,
  restoreTrashedSeries,
  permanentDeleteTrashedSeries,
} from "../../repositories/seriesRepo";
export type { TrashedSeriesEntry } from "../../repositories/seriesRepo";

// ─── Episode ───────────────────────────────────────────────────────
export type {
  ComposeVersion,
  EpisodeVersion,
  EpisodeData,
} from "../../repositories/episodeRepo";
export {
  listComposeVersions,
  stripGeneratedFallbackNote,
  listEpisodes,
  readEpisode,
  createEpisode,
  updateEpisode,
  deleteEpisode,
  saveVersionFile,
  loadVersionFiles,
  readVersionFile,
  createVersion,
} from "../../repositories/episodeRepo";

// ─── Character ─────────────────────────────────────────────────────
export type { CharacterData, SeriesVariant } from "../../repositories/characterRepo";
export {
  importCharacterFromLibrary,
  listCharacters,
  readCharacter,
  createCharacter,
  updateCharacter,
  deleteCharacter,
  listSeriesCharVariants,
  createSeriesCharVariant,
  deleteSeriesCharVariant,
} from "../../repositories/characterRepo";

// ─── Scene ─────────────────────────────────────────────────────────
export type { SceneData } from "../../repositories/sceneRepo";
export {
  importSceneFromLibrary,
  listSeriesSceneVariants,
  createSeriesSceneVariant,
  deleteSeriesSceneVariant,
  listScenes,
  readScene,
  createScene,
  updateScene,
  deleteScene,
} from "../../repositories/sceneRepo";

// ─── Shot ──────────────────────────────────────────────────────────
export type {
  PromptVersion,
  ShotData,
  ShotGeneration,
  ShotLocator,
} from "../../repositories/shotRepo";
export {
  appendPromptVersion,
  addShot,
  listShots,
  readShot,
  updateShot,
  appendGeneration,
  pickGeneration,
  removeGenerationFromPools,
  moveGenerationToTrash,
  restoreGenerationFromTrash,
  renameGenerationLabel,
  permanentlyDeleteGeneration,
  setFrameAnchor,
  removeFrameAnchor,
  reorderFrameAnchors,
  trashShot,
  trashEpisodeShotFiles,
  restoreTrashedShot,
  listTrashedShots,
  permanentlyDeleteTrashedShot,
  reorderShots,
  locateShotById,
  locateShotMatches,
  readShotById,
  updateShotById,
  listShotFailuresWithId,
  appendShotFailure,
  dismissShotFailureById,
} from "../../repositories/shotRepo";

// ─── Asset ─────────────────────────────────────────────────────────
export type { AssetEntry } from "../../repositories/assetRepo";
export {
  resolveAssetFilePath,
  listAssets,
  readAsset,
  addAsset,
  deleteAsset,
  getAssetThumbnailPath,
} from "../../repositories/assetRepo";

// ─── Template ──────────────────────────────────────────────────────
export type {
  TemplateEntry,
  BuiltinTemplate,
  TemplatePlaceholder,
  StoryboardSkeleton,
  SkeletonEpisode,
  SkeletonShot,
} from "../../repositories/templateRepo";
export {
  listTemplates,
  listBuiltinTemplates,
  loadBuiltinTemplate,
  createTemplate,
  deleteTemplate,
  applyTemplate,
  applyTemplateSkeleton,
  saveSeriesAsTemplate,
} from "../../repositories/templateRepo";

// ─── MoodBoard ─────────────────────────────────────────────────────
export type {
  MoodBoardEntry,
  MoodBoardConfig,
} from "../../repositories/moodboardRepo";
export {
  listMoodBoard,
  addToMoodBoard,
  removeFromMoodBoard,
  updateMoodBoardEntry,
  reorderMoodBoard,
  getMoodBoardRefImages,
  isMoodBoardEnabled,
  setMoodBoardEnabled,
} from "../../repositories/moodboardRepo";

// ─── Ledger ────────────────────────────────────────────────────────
export type { LedgerEntry } from "../../repositories/ledgerRepo";
export {
  invalidateLedgerCache,
  queryLedger,
  aggregateLedger,
} from "../../repositories/ledgerRepo";

// ─── Task ──────────────────────────────────────────────────────────
export type { TaskRecord } from "../../repositories/taskRepo";
export {
  createTaskRecord,
  updateTaskRecord,
  restoreTasks,
  getTask,
  listTasks,
} from "../../repositories/taskRepo";

// ─── Failure ───────────────────────────────────────────────────────
export type { ScannedFailure } from "../../repositories/failureRepo";
export {
  scanAllFailedGenerations,
  scanAllFailedTasks,
} from "../../repositories/failureRepo";
