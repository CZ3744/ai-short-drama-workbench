/**
 * ElementModals — 详情页底部一组 modal 集合.
 *
 * 内容:
 *   · RejectPoolBrowserModal — 浏览全废案库
 *   · MediaLightbox — 候选图放大 + "用此图微调" 跳 RegenModal
 *   · RegenModal — 单张微调重抽
 *   · LibraryPickerModal — 跨 element 引用图选择
 *
 * 全部 props 显式传入, 不接触父 state 的 setter ref. 视觉零变更.
 *
 * 从 ElementWorkbench 拆出(Wave P2 解耦).
 */

import { Button } from "../../../components/ui/button";
import { RejectPoolBrowserModal } from "../../../components/element/RejectPoolBrowserModal";
import { LibraryPickerModal } from "../../../components/library-picker/LibraryPickerModal";
import { MediaLightbox } from "../../../components/shared/MediaLightbox";
import { RegenModal } from "../../../components/shot-stage/RegenModal";
import { labelOfSource } from "../../../lib/sourceLabels";
import type { ElementData, ElementImage, RejectItem } from "../../../lib/elementApi";

interface LightboxImage {
  url: string;
  sourceLabel?: string;
}

interface Props {
  slug: string;
  element: ElementData;

  // RejectPoolBrowserModal
  rejectBrowserOpen: boolean;
  rejectTier: "element" | "project" | "public";
  onRejectTierChange: (t: "element" | "project" | "public") => void;
  rejects: RejectItem[];
  onImportReject: (vaultId: string) => void;
  onPromoteReject: (vaultId: string, to: "project" | "public") => void;
  onPurgeReject: (item: RejectItem) => void;
  onCloseRejectBrowser: () => void;

  // MediaLightbox
  lightboxImage: LightboxImage | null;
  onLightboxClose: () => void;
  onCopyPrompt: (im: ElementImage) => void;
  onOpenRegen: (im: ElementImage) => void;
  onOpenLightbox: (img: LightboxImage) => void;  // 给 reject browser 内部转跳

  // RegenModal
  regenModalImage: ElementImage | null;
  regenBusy: boolean;
  defaultExtra: string;
  imageModelRef: string | null;
  onImageModelRefChange: (next: string | null) => void;
  onRegenConfirm: (extra: string) => void;
  onRegenClose: () => void;
  onRegenInpainted: (newVaultId: string) => void;
  onRegenPreviewPrompt: () => void;
  allRefImages: ElementImage[];
  selectedRefImageIds: string[];
  onSelectedRefImageIdsChange: (next: string[]) => void;
  onPickFromLibrary: () => void;

  // LibraryPickerModal
  crossRefPickerOpen: boolean;
  crossRefLoading: boolean;
  onCrossRefPickerClose: () => void;
  onCrossRefPickerConfirm: (ids: string[]) => void;
}

export function ElementModals({
  slug,
  element,
  rejectBrowserOpen,
  rejectTier,
  onRejectTierChange,
  rejects,
  onImportReject,
  onPromoteReject,
  onPurgeReject,
  onCloseRejectBrowser,
  lightboxImage,
  onLightboxClose,
  onCopyPrompt,
  onOpenRegen,
  onOpenLightbox,
  regenModalImage,
  regenBusy,
  defaultExtra,
  imageModelRef,
  onImageModelRefChange,
  onRegenConfirm,
  onRegenClose,
  onRegenInpainted,
  onRegenPreviewPrompt,
  allRefImages,
  selectedRefImageIds,
  onSelectedRefImageIdsChange,
  onPickFromLibrary,
  crossRefPickerOpen,
  crossRefLoading,
  onCrossRefPickerClose,
  onCrossRefPickerConfirm,
}: Props) {
  return (
    <>
      <RejectPoolBrowserModal
        open={rejectBrowserOpen}
        tier={rejectTier}
        rejects={rejects}
        onTierChange={onRejectTierChange}
        onImport={onImportReject}
        onPromote={onPromoteReject}
        onPurge={onPurgeReject}
        onClose={onCloseRejectBrowser}
        onOpenImage={(r) => onOpenLightbox({ url: r.url, sourceLabel: "废案" })}
      />

      {/* W8-sweep (2026-05-16): 候选图放大查看 — 与 ShotStagePage 对齐.
          actions slot 内插"用此图微调重抽" — 一键直跳 RegenModal.
          lightboxImage 是通用 payload, 通过 url 反查在 element.images 里是否能找到原始 ElementImage. */}
      <MediaLightbox
        open={!!lightboxImage}
        src={lightboxImage?.url ?? ""}
        kind="image"
        metadata={lightboxImage?.sourceLabel ? { provider: lightboxImage.sourceLabel } : undefined}
        actions={lightboxImage ? (
          <>
            {(() => {
              // 反查原始 ElementImage — 仅对 element.images 内的图启用"用此图微调"
              const matched = element.images.find((im) => im.url === lightboxImage.url);
              if (!matched) return null;
              return (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    iconLeft="sparkles"
                    title="用此图作参考底图 + 加修改意见 → 弹窗一步完成重抽"
                    onClick={() => {
                      onLightboxClose();
                      onOpenRegen(matched);
                    }}
                  >
                    用此图微调
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft="copy"
                    title="复制这张图生成时用的完整提示词"
                    onClick={() => onCopyPrompt(matched)}
                  >
                    复制提示词
                  </Button>
                </>
              );
            })()}
          </>
        ) : undefined}
        onClose={onLightboxClose}
      />

      {/* 2026-05-16 五件 UX: RegenModal 内嵌完整 ReferencePicker (反馈 2).
          删旧 extraReferences 只读 chip 透传, 改成 caller 传完整 picker 三件套, RegenModal
          内部直接展开勾选 UI. defaultExtra 当 handleRegenerateAngle 打开时预填角度提示词. */}
      <RegenModal
        open={!!regenModalImage}
        projectSlug={slug}
        sourceImageUrl={regenModalImage?.url ?? ""}
        sourceLabel={regenModalImage ? labelOfSource(regenModalImage.origin) : undefined}
        defaultExtra={defaultExtra}
        modelRef={imageModelRef}
        onModelRefChange={onImageModelRefChange}
        busy={regenBusy}
        onConfirm={(extra) => { onRegenConfirm(extra); }}
        inpaintVaultId={regenModalImage?.vault_id}
        onInpainted={onRegenInpainted}
        // 2026-05-19 Wave O Audit P1 #3: 用户在 element 微调路径上需要"查看完整提示词" 入口.
        //   ElementWorkbench 不像 ShotStage 有独立 PromptReviewModal — 它的完整 review 走
        //   ImageGenerationPanel 内嵌. 简化方案: toast 引导用户切换到 panel 入口.
        //   后续 Wave 抽 sharedReviewState 让 RegenModal 也能直接打开 review.
        onPreviewPrompt={onRegenPreviewPrompt}
        // 2026-05-16: 完整 ReferencePicker 嵌入 (替代旧 extraReferences chip)
        // P3-2: 用 allRefImages,支持展示跨 element 引用图
        availableReferenceImages={allRefImages}
        selectedReferenceIds={selectedRefImageIds}
        onSelectedReferenceChange={onSelectedRefImageIdsChange}
        primaryReferenceImageId={element.primary_image_id}
        onPickFromLibrary={onPickFromLibrary}
        onClose={onRegenClose}
      />

      {/* P3-2 (2026-05-18): 跨 element 引用图 — LibraryPickerModal
          用户选一批素材后, handlePickFromLibraryConfirm 取各素材的 typical 图 push 进 crossRefImages. */}
      <LibraryPickerModal
        open={crossRefPickerOpen}
        onClose={onCrossRefPickerClose}
        slug={slug}
        source="project"
        multi={true}
        title={crossRefLoading ? "加载素材图中…" : "引用其他素材的典型图作参考"}
        onConfirm={onCrossRefPickerConfirm}
      />
    </>
  );
}
