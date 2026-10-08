// ====================================================================
// libraryApi.ts — Library Characters/Scenes + Variants + Vault + Mood Board
// (P1 wave 2 #11 解耦)
// ====================================================================
// 覆盖范围:
// - LibraryCharacter / LibraryScene / 详情 / CRUD / lock / refs URL
// - LibraryRefItem / ImageProviderOption / ImageProviderPreset
// - VariantData / Library / Series Character / Scene variants
// - Cross-project asset publish / load
// - Series Character / Scene (主工作台用)
// - C8 反向引用 (Usage)
// - Mood Board
// - VaultEntry / VaultRemix / VaultInpaint / VaultAnnotation
// ====================================================================

import {
  apiGet,
  apiPost,
  apiPatch,
  apiPut,
  apiDelete,
  handleResponse,
} from "./_apiClient";

// ====================================================================
// LIBRARY API (P120 Wave 2A)
// ====================================================================

export interface LibraryCharacter {
  id: string;
  name: string;
  role?: string;
  appearance?: string;
  personality?: string;
  tags?: string[];
  usage_count: number;
  thumb_path?: string;
  created_at: string;
  updated_at: string;
}

export interface LibraryScene {
  id: string;
  name: string;
  description?: string;
  visual_style?: string;
  location?: string;
  time_of_day?: string;
  mood?: string;
  usage_count: number;
  thumb_path?: string;
  created_at: string;
  updated_at: string;
}

export interface LibraryRefItem {
  ref_id: string;
  path: string;
  url: string;
}

export interface LibraryCharacterDetail {
  character: LibraryCharacter & {
    refs?: LibraryRefItem[];
    locked?: { ref_id: string; seed?: number };
    appearance?: string;
    personality?: string;
    tags?: string[];
    voice_id?: string;
    voice_style_map?: Record<string, string>;
  };
  vault_refs?: string[];
}

export interface LibrarySceneDetail {
  scene: LibraryScene & {
    refs?: LibraryRefItem[];
    locked?: { ref_id: string; seed?: number };
    description?: string;
    visual_style?: string;
    location?: string;
    time_of_day?: string;
    mood?: string;
    tags?: string[];
  };
  vault_refs?: string[];
}

export interface CreateLibraryCharacterInput {
  name: string;
  appearance?: string;
  personality?: string;
  tags?: string[];
}

export interface CreateLibrarySceneInput {
  name: string;
  description?: string;
  visual_style?: string;
  location?: string;
  time_of_day?: string;
  mood?: string;
}

export interface PatchLibraryCharacterInput {
  name?: string;
  appearance?: string;
  personality?: string;
  tags?: string[];
}

export interface PatchLibrarySceneInput {
  name?: string;
  description?: string;
  visual_style?: string;
  location?: string;
  time_of_day?: string;
  mood?: string;
}

// Wave 4-D (2026-05-16): GenerateLibraryRefsInput / GenerateLibraryRefsResult /
// generateLibraryRefs / generateLibrarySceneRefs 前端函数已删 — 0 caller (历史 caller
// LibraryEntityDetailDrawer / studio/library/GenerateRefsDialog / EntityDetailPage
// 全部废弃删除).
//
// Wave P (2026-05-20): 后端 /api/v2/library/characters/:id/generate-refs +
// /api/v2/library/scenes/:id/generate-refs + /series/:slug/characters/:id/generate-refs +
// /series/:slug/scenes/:id/generate-refs 四个 deprecated route 同步删除.
// 一律改走 /api/v2/generate/image (target.kind = character_ref | scene_ref | library_variant)
// + ImageGenerationPanel.

export interface ImageProviderOption {
  id: string;
  label_zh: string;
  label_en: string;
  prompt_phrase?: string;
  enabled: boolean;
  default: boolean;
  base_url?: string;
  model_id?: string;
  api_type?: string;
  env_key_name?: string;
  supports_reference_image?: boolean;
  max_resolution?: string;
  cost_per_image_cny?: number;
  notes?: string;
}

export interface ImageProviderPreset {
  version: string;
  options: ImageProviderOption[];
}

// Characters
export async function fetchLibraryCharacters() {
  return apiGet<{ characters: LibraryCharacter[] }>("/api/v2/library/characters");
}

export async function fetchLibraryCharacter(id: string) {
  return apiGet<LibraryCharacterDetail>(`/api/v2/library/characters/${id}`);
}

export async function createLibraryCharacter(data: CreateLibraryCharacterInput) {
  return apiPost<{ character: LibraryCharacter }>("/api/v2/library/characters", data);
}

export async function updateLibraryCharacter(id: string, data: PatchLibraryCharacterInput) {
  return apiPatch<{ character: LibraryCharacter }>(`/api/v2/library/characters/${id}`, data);
}

export async function deleteLibraryCharacter(id: string) {
  return apiDelete<{ ok: boolean }>(`/api/v2/library/characters/${id}`);
}

// Wave 4-D: generateLibraryRefs() 已删 (zero caller).
// 新前端走 ImageGenerationPanel + /api/v2/generate/image (target.kind=library_variant).

export async function lockLibraryCharacter(id: string, ref_id: string) {
  return apiPost<{ ok: boolean; locked_path: string }>(
    `/api/v2/library/characters/${id}/lock`,
    { ref_id }
  );
}

/** Get the locked image URL for a library character */
export function libraryCharacterLockedUrl(id: string) {
  return `/api/v2/library/characters/${id}/locked.png`;
}

/** Get a specific ref image URL */
export function libraryCharacterRefUrl(id: string, refId: string) {
  return `/api/v2/library/characters/${id}/refs/${refId}`;
}

// Scenes
export async function fetchLibraryScenes() {
  return apiGet<{ scenes: LibraryScene[] }>("/api/v2/library/scenes");
}

export async function fetchLibraryScene(id: string) {
  return apiGet<LibrarySceneDetail>(`/api/v2/library/scenes/${id}`);
}

export async function createLibraryScene(data: CreateLibrarySceneInput) {
  return apiPost<{ scene: LibraryScene }>("/api/v2/library/scenes", data);
}

export async function updateLibraryScene(id: string, data: PatchLibrarySceneInput) {
  return apiPatch<{ scene: LibraryScene }>(`/api/v2/library/scenes/${id}`, data);
}

export async function deleteLibraryScene(id: string) {
  return apiDelete<{ ok: boolean }>(`/api/v2/library/scenes/${id}`);
}

// Wave 4-D: generateLibrarySceneRefs() 已删 (zero caller).
// 新前端走 ImageGenerationPanel + /api/v2/generate/image (target.kind=library_variant).

export async function lockLibraryScene(id: string, ref_id: string) {
  return apiPost<{ ok: boolean; locked_path: string }>(
    `/api/v2/library/scenes/${id}/lock`,
    { ref_id }
  );
}

export function librarySceneLockedUrl(id: string) {
  return `/api/v2/library/scenes/${id}/locked.png`;
}

export function librarySceneRefUrl(id: string, refId: string) {
  return `/api/v2/library/scenes/${id}/refs/${refId}`;
}

/** Fetch image provider options (for the generate dropdown) */
export async function getImageProviderPresets() {
  return apiGet<ImageProviderPreset>("/api/v2/presets/image_provider");
}

// ====================================================================
// VAULT REMIX
// ====================================================================

export interface VaultRemixInput {
  user_note: string;
  count?: number;
  provider_id?: string;
  context_override?: {
    keep_face?: boolean;
    keep_pose?: boolean;
    keep_style?: boolean;
  };
}

export interface VaultRemixResult {
  ok: boolean;
  source_vault_id: string;
  results: Array<{ vault_id: string; cost_cny?: number }>;
  count: number;
  prompt: string;
  mock_fallback: boolean;
}

export async function vaultRemix(vaultId: string, data: VaultRemixInput) {
  return apiPost<VaultRemixResult>(`/api/v2/vault/${vaultId}/remix`, data);
}

// 2026-05-19 Wave O Audit P0 #1: 零成本 preview-prompt — 让"查看完整提示词"按钮拿到
// 真实将要发给模型的 prompt + 源图 URL, 跟实际 remix 走的拼装路径完全一致 (铁律 #2 可干预性).
export interface VaultRemixPreviewResult {
  ok: boolean;
  source_vault_id: string;
  source_url: string;
  source_thumb_url: string;
  full_prompt: string;
  segments: Array<{ label: string; text: string }>;
  annotations_count: number;
}
export async function vaultRemixPreviewPrompt(vaultId: string, data: VaultRemixInput) {
  return apiPost<VaultRemixPreviewResult>(`/api/v2/vault/${vaultId}/remix/preview-prompt`, data);
}

// ====================================================================
// VAULT ANNOTATIONS
// ====================================================================

export interface Annotation {
  id: string;
  type: "pin" | "box";
  coords: { x: number; y: number; w?: number; h?: number };
  note: string;
  created_at: string;
}

export interface VaultAnnotationInput {
  type: "pin" | "box";
  coords: { x: number; y: number; w?: number; h?: number };
  note: string;
}

export async function vaultAddAnnotation(vaultId: string, data: VaultAnnotationInput) {
  return apiPost<{ ok: boolean; annotation: Annotation }>(`/api/v2/vault/${vaultId}/annotations`, data);
}

export async function vaultGetAnnotations(vaultId: string) {
  return apiGet<{ annotations: Annotation[] }>(`/api/v2/vault/${vaultId}/annotations`);
}

export async function vaultDeleteAnnotation(vaultId: string, annId: string) {
  return apiDelete<{ ok: boolean; deleted: string }>(`/api/v2/vault/${vaultId}/annotations/${annId}`);
}

// ====================================================================
// VAULT INPAINT
// ====================================================================

export interface VaultInpaintInput {
  mask_base64: string;
  user_note: string;
  provider_id?: string;
}

export interface VaultInpaintResult {
  ok: boolean;
  source_vault_id: string;
  vault_id: string;
  prompt: string;
  strategy: "native_inpaint" | "remix_with_mask" | "mock";
  mock_fallback: boolean;
}

export async function vaultInpaint(vaultId: string, data: VaultInpaintInput) {
  return apiPost<VaultInpaintResult>(`/api/v2/vault/${vaultId}/inpaint`, data);
}

// ====================================================================
// STYLE MOOD BOARD (Wave 4C)
// ====================================================================

export interface MoodBoardEntry {
  vault_id: string;
  weight: number;
  note: string;
  sort_order: number;
  added_at: string;
}

export interface MoodBoardData {
  entries: MoodBoardEntry[];
  enabled: boolean;
}

export async function getMoodBoard(slug: string) {
  return apiGet<MoodBoardData>(`/api/v2/series/${slug}/mood-board`);
}

export async function addMoodBoardEntry(slug: string, vault_id: string, weight?: number, note?: string) {
  return apiPost<{ entry: MoodBoardEntry }>(`/api/v2/series/${slug}/mood-board`, { vault_id, weight, note });
}

export async function removeMoodBoardEntry(slug: string, vaultId: string) {
  return apiDelete<{ ok: boolean }>(`/api/v2/series/${slug}/mood-board/${vaultId}`);
}

export async function updateMoodBoardEntry(slug: string, vaultId: string, patch: { weight?: number; note?: string; sort_order?: number }) {
  return apiPatch<{ entry: MoodBoardEntry }>(`/api/v2/series/${slug}/mood-board/${vaultId}`, patch);
}

export async function reorderMoodBoard(slug: string, order: string[]) {
  return apiPut<{ entries: MoodBoardEntry[] }>(`/api/v2/series/${slug}/mood-board/reorder`, { order });
}

export async function uploadMoodBoardFiles(slug: string, files: File[]) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const res = await fetch(`/api/v2/series/${slug}/mood-board/upload`, { method: "POST", body: form });
  await handleResponse(res);
  return res.json() as Promise<{ ok: boolean; count: number; results: Array<{ vault_id: string; entry: MoodBoardEntry }> }>;
}

export async function setMoodBoardConfig(slug: string, enabled: boolean) {
  return apiPut<{ config: { enabled: boolean } }>(`/api/v2/series/${slug}/mood-board/config`, { enabled });
}

// ====================================================================
// VARIANTS API (P130 Wave 2B)
// ====================================================================

export type VariantCategory = "outfit" | "emotion" | "pose" | "other";

export interface VariantData {
  id: string;
  label: string;
  category: VariantCategory;
  vault_id: string;
  parent: "locked" | string;
  user_note: string;
  created_at: string;
}

export interface CreateVariantInput {
  label: string;
  category: VariantCategory;
  source_vault_id?: string;
  user_note?: string;
  provider_id?: string;
}

export interface AutoPackInput {
  provider_id: string;
}

// ─── Library Character Variants ──────────────────────────────────

export async function fetchLibraryCharVariants(charId: string) {
  return apiGet<{ variants: VariantData[] }>(`/api/v2/library/characters/${charId}/variants`);
}

export async function createLibraryCharVariant(charId: string, input: CreateVariantInput) {
  return apiPost<{ variant: VariantData }>(`/api/v2/library/characters/${charId}/variants`, input);
}

export async function deleteLibraryCharVariant(charId: string, varId: string) {
  return apiDelete<{ ok: boolean }>(`/api/v2/library/characters/${charId}/variants/${varId}`);
}

export async function autoPackLibraryCharVariants(charId: string, input: AutoPackInput) {
  return apiPost<{ ok: boolean; variants: VariantData[]; count: number }>(
    `/api/v2/library/characters/${charId}/variants/auto-pack`,
    input,
  );
}

// ─── Library Scene Variants ─────────────────────────────────────

export async function fetchLibrarySceneVariants(sceneId: string) {
  return apiGet<{ variants: VariantData[] }>(`/api/v2/library/scenes/${sceneId}/variants`);
}

export async function createLibrarySceneVariant(sceneId: string, input: CreateVariantInput) {
  return apiPost<{ variant: VariantData }>(`/api/v2/library/scenes/${sceneId}/variants`, input);
}

export async function deleteLibrarySceneVariant(sceneId: string, varId: string) {
  return apiDelete<{ ok: boolean }>(`/api/v2/library/scenes/${sceneId}/variants/${varId}`);
}

export async function autoPackLibrarySceneVariants(sceneId: string, input: AutoPackInput) {
  return apiPost<{ ok: boolean; variants: VariantData[]; count: number }>(
    `/api/v2/library/scenes/${sceneId}/variants/auto-pack`,
    input,
  );
}

// ─── Series Character Variants ──────────────────────────────────

export async function fetchSeriesCharVariants(slug: string, charId: string) {
  // Deprecated: 分镜素材池已改读 /series/:slug/elements 的 character.images。
  // 该 variants 端点仅保留给 auto-pack/历史套装路径向后兼容。
  return apiGet<{ variants: VariantData[] }>(`/api/v2/series/${slug}/characters/${charId}/variants`);
}

export async function createSeriesCharVariant(slug: string, charId: string, input: CreateVariantInput) {
  return apiPost<{ variant: VariantData }>(`/api/v2/series/${slug}/characters/${charId}/variants`, input);
}

export async function deleteSeriesCharVariant(slug: string, charId: string, varId: string) {
  return apiDelete<{ ok: boolean }>(`/api/v2/series/${slug}/characters/${charId}/variants/${varId}`);
}

export async function autoPackSeriesCharVariants(slug: string, charId: string, input: AutoPackInput) {
  return apiPost<{ ok: boolean; variants: VariantData[]; count: number }>(
    `/api/v2/series/${slug}/characters/${charId}/variants/auto-pack`,
    input,
  );
}

// ─── Series Scene Variants ──────────────────────────────────────

export async function fetchSeriesSceneVariants(slug: string, sceneId: string) {
  // Deprecated: 分镜素材池已改读 /series/:slug/elements 的 scene.images。
  // 该 variants 端点仅保留给 auto-pack/历史套装路径向后兼容。
  return apiGet<{ variants: VariantData[] }>(`/api/v2/series/${slug}/scenes/${sceneId}/variants`);
}

export async function createSeriesSceneVariant(slug: string, sceneId: string, input: CreateVariantInput) {
  return apiPost<{ variant: VariantData }>(`/api/v2/series/${slug}/scenes/${sceneId}/variants`, input);
}

export async function deleteSeriesSceneVariant(slug: string, sceneId: string, varId: string) {
  return apiDelete<{ ok: boolean }>(`/api/v2/series/${slug}/scenes/${sceneId}/variants/${varId}`);
}

export async function autoPackSeriesSceneVariants(slug: string, sceneId: string, input: AutoPackInput) {
  return apiPost<{ ok: boolean; variants: VariantData[]; count: number }>(
    `/api/v2/series/${slug}/scenes/${sceneId}/variants/auto-pack`,
    input,
  );
}

// ─── C8: 反向引用 — 角色/场景出现在哪些镜头 ────────────────────────

export interface UsageShot {
  episode_id: string;
  shot_id: string;
  shot_index: number;
  first_frame_url: string | null;
}

export async function fetchCharacterUsage(slug: string, charId: string) {
  return apiGet<{ shots: UsageShot[]; total_count: number }>(
    `/api/v2/series/${slug}/characters/${charId}/usage`,
  );
}

export async function fetchSceneUsage(slug: string, sceneId: string) {
  return apiGet<{ shots: UsageShot[]; total_count: number }>(
    `/api/v2/series/${slug}/scenes/${sceneId}/usage`,
  );
}

// ====================================================================
// T05: 公共素材库 ↔ 项目 跨项目素材导入导出
// 注: 这两个 helper 直接对接 packages/core/src/db/assets.ts 的 importFromProject /
// exportToProject (本质都是深拷贝, 写入 source_asset_id 血脉). Backend route 名字
// 是历史遗留 — 含义不要被名字误导:
//   POST /api/assets/import-from-project  公共素材库 "导入" 一个项目资源 (= 发布)
//   POST /api/assets/export-to-project    公共素材库 "导出" 给目标项目 (= 加载到项目)
// ====================================================================

export type CrossProjectAssetType = "character" | "scene" | "style" | "voice" | "vault";

/** 将一个项目内的资源 (character / scene / style / voice / vault) 深拷贝到公共素材库 */
export interface PublishAssetToLibraryInput {
  projectSlug: string;
  assetType: CrossProjectAssetType;
  resourceId: string;
  newName?: string;
}

export interface PublishAssetToLibraryResult {
  ok: boolean;
  message: string;
  asset: {
    id: string;
    asset_type: CrossProjectAssetType;
    name: string;
    description: string;
    tags: string[];
    thumbnail_path: string | null;
    source_project_slug: string;
    source_resource_id: string;
    source_asset_id: string | null;
    version: number;
    major_version: number;
    minor_version: number;
    created_at: string;
    updated_at: string;
  };
}

/** 将一个项目资源发布(深拷贝)到公共素材库 */
export async function publishAssetToLibrary(input: PublishAssetToLibraryInput) {
  return apiPost<PublishAssetToLibraryResult>("/api/assets/import-from-project", input);
}

/** 将一个公共素材库资源深拷贝到目标项目 (生成独立副本, 通过 source_asset_id 保留血脉) */
export interface LoadAssetToProjectInput {
  assetId: string;
  targetProjectSlug: string;
  newName?: string;
}

export interface LoadAssetToProjectResult {
  ok: boolean;
  message: string;
}

/** 从公共素材库深拷贝资源到目标项目 */
export async function loadAssetToProject(input: LoadAssetToProjectInput) {
  return apiPost<LoadAssetToProjectResult>("/api/assets/export-to-project", input);
}

// ─────── Vault 列表 / 归档柜 ───────

export interface VaultEntry {
  vault_id: string;
  schema_version?: number;
  kind: "image" | "video";
  path: string;
  bytes: number;
  mime: string;
  width?: number;
  height?: number;
  duration_sec?: number;
  sha256?: string;
  provider_id?: string;
  model_id?: string;
  cost_cny?: number;
  created_at: string;
  /** 2026-05-20 display_name 体系统一: 用户可改的展示名 (单一真理源, 由 assetMeta 合并) */
  display_name?: string;
  context: {
    series_slug?: string;
    episode_id?: string;
    shot_id?: string;
    character_id?: string;
    scene_id?: string;
    source?: string;
    note?: string;
    user_note?: string;
  };
  tags: string[];
  status: "active" | "trashed";
  trashed_at?: string;
  quality_scores?: {
    composition: number;
    sharpness: number;
    prompt_alignment: number;
    subject_completeness: number;
    checked_at: string;
  };
}

export interface VaultStats {
  total: number;
  images: number;
  videos: number;
  trashed: number;
  total_bytes: number;
}

/** 2026-05-25 C1: 成本统计聚合 (前后端对称, packages/library/src/assetVault.ts VaultCostStats) */
export interface VaultCostStats {
  total_cny: number;
  total_paid_entries: number;
  this_month_cny: number;
  this_month_entries: number;
  by_provider: Array<{ provider_id: string; cost_cny: number; count: number }>;
  by_series: Array<{ series_slug: string; cost_cny: number; count: number }>;
  by_month: Array<{ month: string; cost_cny: number; count: number }>;
}

export async function getVaultCostStats(opts: { series_slug?: string; since?: string; until?: string } = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return apiGet<{ stats: VaultCostStats }>(`/api/v2/vault/cost-stats${qs ? "?" + qs : ""}`);
}

export interface VaultListOpts {
  kind?: "image" | "video";
  series_slug?: string;
  character_id?: string;
  scene_id?: string;
  shot_id?: string;
  status?: "active" | "trashed";
  since?: string;
  limit?: number;
  offset?: number;
}

export async function listVault(opts: VaultListOpts = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return apiGet<{ entries: VaultEntry[]; stats: VaultStats; has_more?: boolean; offset?: number; limit?: number }>(`/api/v2/vault${qs ? "?" + qs : ""}`);
}

export function vaultThumbUrl(vaultId: string, size = 256): string {
  return `/api/v2/vault/${encodeURIComponent(vaultId)}/thumbnail?size=${size}`;
}

export function vaultRawUrl(vaultId: string): string {
  return `/api/v2/vault/${encodeURIComponent(vaultId)}/raw`;
}

export async function vaultTrash(vaultId: string, reason?: string) {
  return apiPost<{ ok: boolean }>(`/api/v2/vault/${encodeURIComponent(vaultId)}/trash`, { reason });
}

export async function vaultRestore(vaultId: string) {
  return apiPost<{ ok: boolean }>(`/api/v2/vault/${encodeURIComponent(vaultId)}/restore`, {});
}
