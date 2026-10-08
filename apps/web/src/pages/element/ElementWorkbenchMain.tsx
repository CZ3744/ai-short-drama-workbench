/**
 * ElementWorkbenchMain — 中间内容区 (Wave Z-8 拆分).
 *
 * 从 ElementWorkbench 抽离, 包裹右列: ElementImageWorkspace (图像生成 / 图库 / 废案).
 */

import { ElementImageWorkspace } from "./parts/ElementImageWorkspace";
import type {
  CompiledPromptForGeneration,
  PromptCompileOpts,
} from "../../components/generation/ImageGenerationPanel";
import type { GenerateImageResult, ImageReferenceInput } from "../../lib/generationApi";
import type { ElementData, ElementImage, RejectItem, ElementAngle } from "../../lib/elementApi";

export interface ElementWorkbenchMainProps {
  slug: string;
  elementId: string;
  element: ElementData;
  imageModelRef: string | null;
  onImageModelChange: (v: string | null) => void;
  llmModelRef: string | null;
  onLlmModelChange: (v: string | null) => void;
  userInstruction: string;
  compilePromptForPanel: (opts: PromptCompileOpts) => Promise<CompiledPromptForGeneration>;
  buildSelectedReferenceImages: () => ImageReferenceInput[];
  allRefImages: Array<ElementImage & { sourceElementName?: string }>;
  selectedRefImageIds: string[];
  onSelectedRefImageIdsChange: (ids: string[]) => void;
  implicitRefDisabled: Set<string>;
  onToggleImplicitRef: (asset_id: string, nextActive: boolean) => void;
  onPickFromLibrary: () => void;
  onSetGenProgress: (p: { completed: number; total: number }) => void;
  onImportLocal: (files: FileList | File[] | null) => void;
  ensureElementSaved: () => Promise<void>;
  onGenerationSuccess: (result: GenerateImageResult) => void;
  genProgress: { completed: number; total: number };
  pendingSkeletonCount: number;
  onSetPrimary: (imageId: string) => void;
  onClearPrimary: () => void;
  onCopyPrompt: (im: ElementImage) => void;
  onReject: (imageId: string) => void;
  onSetAngle: (imageId: string, angle: ElementAngle | null) => void;
  /** W2 (2026-05-26) — 维度标签 (pose/expression/outfit/lighting/free). */
  onSetImageTags?: (imageId: string, tags: import("../../lib/elementApi").ImageTag[]) => Promise<void>;
  onOpenLightbox: (img: { url: string; sourceLabel?: string }) => void;
  onOpenRegen: (im: ElementImage) => void;
  onRenameImage: (image: ElementImage, newName: string) => Promise<void>;
  onToggleAvailable: (image: ElementImage, next: boolean) => Promise<void>;
  onToggleTypical: (image: ElementImage, next: boolean) => Promise<void>;
  onRegenerateAngle: (angle: ElementAngle | null, modelRef: string | null, baseImageId: string) => void;
  rejectTier: "element" | "project" | "public";
  onRejectTierChange: (t: "element" | "project" | "public") => void;
  rejects: RejectItem[];
  onImportReject: (vaultId: string) => void;
  onPromoteReject: (vaultId: string, to: "project" | "public") => void;
  onPurgeReject: (item: RejectItem) => void;
  onOpenRejectBrowser: () => void;
}

export function ElementWorkbenchMain({
  slug,
  elementId,
  element,
  imageModelRef,
  onImageModelChange,
  llmModelRef,
  onLlmModelChange,
  userInstruction,
  compilePromptForPanel,
  buildSelectedReferenceImages,
  allRefImages,
  selectedRefImageIds,
  onSelectedRefImageIdsChange,
  implicitRefDisabled,
  onToggleImplicitRef,
  onPickFromLibrary,
  onSetGenProgress,
  onImportLocal,
  ensureElementSaved,
  onGenerationSuccess,
  genProgress,
  pendingSkeletonCount,
  onSetPrimary,
  onClearPrimary,
  onCopyPrompt,
  onReject,
  onSetAngle,
  onSetImageTags,
  onOpenLightbox,
  onOpenRegen,
  onRenameImage,
  onToggleAvailable,
  onToggleTypical,
  onRegenerateAngle,
  rejectTier,
  onRejectTierChange,
  rejects,
  onImportReject,
  onPromoteReject,
  onPurgeReject,
  onOpenRejectBrowser,
}: ElementWorkbenchMainProps) {
  return (
    <ElementImageWorkspace
      slug={slug}
      elementId={elementId}
      element={element}
      imageModelRef={imageModelRef}
      onImageModelChange={onImageModelChange}
      llmModelRef={llmModelRef}
      onLlmModelChange={onLlmModelChange}
      userInstruction={userInstruction}
      compilePromptForPanel={compilePromptForPanel}
      buildSelectedReferenceImages={buildSelectedReferenceImages}
      allRefImages={allRefImages}
      selectedRefImageIds={selectedRefImageIds}
      onSelectedRefImageIdsChange={onSelectedRefImageIdsChange}
      implicitRefDisabled={implicitRefDisabled}
      onToggleImplicitRef={onToggleImplicitRef}
      onPickFromLibrary={onPickFromLibrary}
      onSetGenProgress={onSetGenProgress}
      onImportLocal={onImportLocal}
      ensureElementSaved={ensureElementSaved}
      onGenerationSuccess={onGenerationSuccess}
      genProgress={genProgress}
      pendingSkeletonCount={pendingSkeletonCount}
      onSetPrimary={onSetPrimary}
      onClearPrimary={onClearPrimary}
      onCopyPrompt={onCopyPrompt}
      onReject={onReject}
      onSetAngle={onSetAngle}
      onSetImageTags={onSetImageTags}
      onOpenLightbox={onOpenLightbox}
      onOpenRegen={onOpenRegen}
      onRenameImage={onRenameImage}
      onToggleAvailable={onToggleAvailable}
      onToggleTypical={onToggleTypical}
      onRegenerateAngle={onRegenerateAngle}
      rejectTier={rejectTier}
      onRejectTierChange={onRejectTierChange}
      rejects={rejects}
      onImportReject={onImportReject}
      onPromoteReject={onPromoteReject}
      onPurgeReject={onPurgeReject}
      onOpenRejectBrowser={onOpenRejectBrowser}
    />
  );
}
