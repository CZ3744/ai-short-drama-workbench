export { AssetStore } from "./assetStore.js";
export { findByCharacter, findCandidatesByShot, findByEpisode } from "./query.js";
export { compact, gc, verify } from "./maintenance.js";
export { sha256, sha256Prefix } from "./dedupe.js";
export { thumbnailImage, thumbnailVideo, thumbnailAudioPlaceholder } from "./thumbnail.js";
export {
  saveToVault,
  getVaultEntry,
  listVault,
  moveToTrash,
  restoreFromTrash,
  cleanupOldTrash,
  getVaultBuffer,
  exportToZip,
  getVaultStats,
  getVaultCostStats,
  getVaultAbsolutePath,
} from "./assetVault.js";
export type {
  VaultEntry,
  VaultKind,
  VaultStatus,
  VaultContext,
  VaultListFilter,
  TrashRecord,
  VaultStats,
  VaultCostStats,
  SaveToVaultParams,
} from "./assetVault.js";
export { CURRENT_SCHEMA_VERSION as VAULT_SCHEMA_VERSION } from "./jsonlIndex.js";
export {
  listLibraryCharacters,
  getLibraryCharacter,
  createLibraryCharacter,
  updateLibraryCharacter,
  deleteLibraryCharacter,
  lockLibraryCharacter,
  getLibraryCharacterLockedPng,
  getLibraryCharacterRefBuffer,
  listLibraryScenes,
  getLibraryScene,
  createLibraryScene,
  updateLibraryScene,
  deleteLibraryScene,
  lockLibraryScene,
  getLibrarySceneLockedPng,
  getLibrarySceneRefBuffer,
} from "./globalLibrary.js";
export type {
  LibraryCharacter,
  LibraryScene,
  LibraryCharacterMeta,
  LibrarySceneMeta,
  LibraryCharacterDetail,
  LibrarySceneDetail,
  RefEntry,
  RefResult,
  LockResult,
  LockData,
  GenerateFn,
} from "./globalLibrary.js";
export type {
  Asset,
  AssetKind,
  AssetSource,
  AssetMeta,
  AssetStats,
  AssetFilter,
  AddAssetParams,
  IndexSnapshot,
  JsonlOp,
  JsonlAddOp,
  JsonlTombstoneOp,
  JsonlRetagOp,
} from "./types.js";
