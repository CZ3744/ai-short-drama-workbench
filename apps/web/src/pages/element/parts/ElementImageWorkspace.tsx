/**
 * ElementImageWorkspace — 详情页右栏全部内容.
 *
 * 内容(从上到下):
 *   · ImageGenerationPanel — 生新图(prompt + 模型 + 参考图选 + AI 润色 + 提示词审核)
 *   · ElementImageGrid — 图库网格(含主图标记/角度/重抽/重命名/可用集等操作)
 *   · ConsistencyDriftPanel — 角色专属一致性体检(折叠在图库底部)
 *   · RejectPoolStrip — 废案库窄条(三层切换:本素材/本项目/公共)
 *
 * 视觉零变更. 所有 props 从父组件传递, 不直接持有任何 state.
 *
 * 从 ElementWorkbench 拆出(Wave P2 解耦).
 */

import {
  ImageGenerationPanel,
  type CompiledPromptForGeneration,
  type PromptCompileOpts,
} from "../../../components/generation/ImageGenerationPanel";
import { ElementImageGrid } from "../../../components/element/ElementImageGrid";
import { ConsistencyDriftPanel } from "../../../components/element/ConsistencyDriftPanel";
import { RejectPoolStrip } from "../../../components/element/RejectPoolStrip";
import { labelOfSource } from "../../../lib/sourceLabels";
import { imageOriginalUrl } from "../../../lib/imageThumb";
import type {
  ElementAngle,
  ElementData,
  ElementImage,
  RejectItem,
} from "../../../lib/elementApi";
import type { GenerateImageResult, ImageReferenceInput } from "../../../lib/generationApi";

interface LightboxImage {
  url: string;
  sourceLabel?: string;
}

interface Props {
  slug: string;
  elementId: string;
  element: ElementData;

  // ImageGenerationPanel
  imageModelRef: string | null;
  onImageModelChange: (next: string | null) => void;
  llmModelRef: string | null;
  onLlmModelChange: (next: string | null) => void;
  userInstruction: string;
  compilePromptForPanel: (opts: PromptCompileOpts) => Promise<CompiledPromptForGeneration>;
  buildSelectedReferenceImages: () => ImageReferenceInput[];

  allRefImages: ElementImage[];
  selectedRefImageIds: string[];
  onSelectedRefImageIdsChange: (next: string[]) => void;
  implicitRefDisabled: Set<string>;
  onToggleImplicitRef: (asset_id: string, nextActive: boolean) => void;

  onPickFromLibrary: () => void;
  onSetGenProgress: (p: { completed: number; total: number }) => void;
  onImportLocal: (files: FileList | File[] | null) => void;
  ensureElementSaved: () => Promise<void>;
  onGenerationSuccess: (result: GenerateImageResult) => void;
  genProgress: { completed: number; total: number };
  pendingSkeletonCount: number;

  // ElementImageGrid
  onSetPrimary: (imageId: string) => void;
  onClearPrimary: () => void;
  onCopyPrompt: (im: ElementImage) => void;
  onReject: (imageId: string) => void;
  onSetAngle: (imageId: string, angle: ElementAngle | null) => void;
  /** W2 (2026-05-26) — 维度标签 (pose/expression/outfit/lighting/free). */
  onSetImageTags?: (imageId: string, tags: import("../../../lib/elementApi").ImageTag[]) => Promise<void>;
  onOpenLightbox: (img: LightboxImage) => void;
  onOpenRegen: (im: ElementImage) => void;
  onRenameImage: (image: ElementImage, newName: string) => Promise<void>;
  onToggleAvailable: (image: ElementImage, next: boolean) => Promise<void>;
  onToggleTypical: (image: ElementImage, next: boolean) => Promise<void>;

  // ConsistencyDriftPanel
  onRegenerateAngle: (
    angle: ElementAngle | null,
    modelRef: string | null,
    baseImageId: string,
  ) => void;

  // RejectPoolStrip
  rejectTier: "element" | "project" | "public";
  onRejectTierChange: (t: "element" | "project" | "public") => void;
  rejects: RejectItem[];
  onImportReject: (vaultId: string) => void;
  onPromoteReject: (vaultId: string, to: "project" | "public") => void;
  onPurgeReject: (item: RejectItem) => void;
  onOpenRejectBrowser: () => void;
}

export function ElementImageWorkspace({
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
}: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ImageGenerationPanel
        target={{ kind: "element", series_slug: slug, target_id: elementId }}
        promptCompiler={compilePromptForPanel}
        defaultCount={1}
        defaultModelRef={imageModelRef ?? undefined}
        onModelChange={onImageModelChange}
        defaultLlmModelRef={llmModelRef ?? undefined}
        onLlmModelChange={onLlmModelChange}
        initialUserInstruction={userInstruction}
        displayName={element.name}
        extraReferenceImages={
          selectedRefImageIds.length > 0 ? buildSelectedReferenceImages() : undefined
        }
        // 2026-05-18 铁律 #13: PromptReviewModal 必须看到所有要发给模型的图.
        //   selectedRefImageIds 对应的图(用户主动勾选) → previewReferenceImages
        //   element 内 is_typical=true 但未被用户主动勾选的图 → previewImplicitReferences
        previewReferenceImages={
          selectedRefImageIds.length > 0
            ? selectedRefImageIds
                .map((id) => {
                  const im = allRefImages.find((x) => x.image_id === id);
                  if (!im?.url) return null;
                  const label = im.display_name?.trim() || im.note?.trim() || `用户参考图`;
                  return { url: im.url, label };
                })
                .filter((x): x is { url: string; label: string } => x !== null)
            : undefined
        }
        previewImplicitReferences={
          // element 内 typical=true 但用户没在 ReferencePicker 主动勾选的图 → 系统建议
          // 用户在 modal 内可单张取消, 取消的 asset_id 写进 implicitRefDisabled state
          element.images
            .filter((im) => im.is_typical && im.url && !selectedRefImageIds.includes(im.image_id))
            .map((im) => ({
              asset_id: im.asset_id || im.vault_id || im.image_id,
              url: im.url ?? "",
              label: `${element.name} 典型图${im.display_name ? ` · ${im.display_name}` : ""}`,
              source: "element_primary" as const,
              source_name: element.name,
              active: !implicitRefDisabled.has(im.asset_id || im.vault_id || im.image_id),
            }))
        }
        onTogglePreviewImplicitRef={onToggleImplicitRef}
        // 2026-05-16: Panel 内嵌折叠 ReferencePicker — 移入"想生新图的时候"
        // P3-2: 用 allRefImages (= element.images + crossRefImages 跨 element 引用图)
        availableReferenceImages={allRefImages}
        selectedReferenceIds={selectedRefImageIds}
        onSelectedReferenceChange={onSelectedRefImageIdsChange}
        primaryReferenceImageId={element.primary_image_id}
        onPickFromLibrary={onPickFromLibrary}
        onProgress={onSetGenProgress}
        onManualImport={onImportLocal}
        onBeforeCompile={ensureElementSaved}
        onSuccess={onGenerationSuccess}
      />

      {/* 图库区域 — ElementImageGrid + (角色专属) 一致性体检在图库底部 (2026-05-19 Fix #13) */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <ElementImageGrid
          images={element.images}
          primaryImageId={element.primary_image_id}
          slug={slug}
          elementId={elementId}
          showAngleControls={element.kind === "character"}
          onSetPrimary={onSetPrimary}
          onClearPrimary={onClearPrimary}
          onCopyPrompt={onCopyPrompt}
          onReject={onReject}
          onImportLocal={onImportLocal}
          onSetAngle={element.kind === "character" ? onSetAngle : undefined}
          onSetImageTags={onSetImageTags}
          // 2026-05-27 bugfix: 走 imageOriginalUrl 取原图 (/raw), 旧实现 im.url 可能是
          //   thumbnail / 空字符串, lightbox 显示缩略图 / 占位图 — 跟 VariantPicker 同 bug.
          onOpenImage={(im) =>
            onOpenLightbox({ url: imageOriginalUrl(slug, im), sourceLabel: labelOfSource(im.origin) })
          }
          onRegen={onOpenRegen}
          onRename={onRenameImage}
          onToggleAvailable={onToggleAvailable}
          onToggleTypical={onToggleTypical}
          rejectCount={rejects.length}
          pendingSkeletonCount={pendingSkeletonCount}
          pendingProgress={genProgress.total > 0 ? genProgress : undefined}
        />

        {/* 一致性体检折叠在图库底部, 角色专属, 用户手动展开才跑 */}
        {element.kind === "character" ? (
          <ConsistencyDriftPanel
            slug={slug}
            charId={elementId}
            images={element.images}
            onRegenerateAngle={onRegenerateAngle}
            onSetAngle={onSetAngle}
            // 2026-05-27 bugfix: 走 imageOriginalUrl 取原图 (/raw), 跟上方 ElementImageGrid
            //   入口同款修 (commit 57e2f743 漏了这一处). im.url ?? "" 在 im.url 是
            //   thumbnail 端点 / 空字符串时 lightbox 会显示模糊缩略图或空白.
            onOpenImage={(im) =>
              onOpenLightbox({ url: imageOriginalUrl(slug, im), sourceLabel: labelOfSource(im.origin) })
            }
          />
        ) : null}
      </div>

      <RejectPoolStrip
        tier={rejectTier}
        rejects={rejects}
        // 2026-05-17 P1.1: RejectPoolStrip 内部 tier 类型扩到 "shot",但 ElementWorkbench 只用 element/project/public,
        // 默认 tierOptions 不暴露 shot,所以这里 cast 安全。
        onTierChange={(t) => onRejectTierChange(t as "element" | "project" | "public")}
        onImport={onImportReject}
        onPromote={onPromoteReject}
        onPurge={onPurgeReject}
        onOpenBrowser={onOpenRejectBrowser}
        onOpenImage={(r) => onOpenLightbox({ url: r.url, sourceLabel: "废案" })}
      />
    </div>
  );
}
