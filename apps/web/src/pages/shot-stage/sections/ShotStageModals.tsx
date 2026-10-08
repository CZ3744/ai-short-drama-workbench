// P1 #17 (2026-05-21): 4 个 modal 集合 — 从 ShotStagePage 拆出.
// PromptReviewModal (首帧/视频) + MediaLightbox + RegenModal + VideoRegenModal + CandidateCompareModal + InpaintCanvas.
// 纯展示: 通过 props 接所有 state / handler.
import type { ReactNode } from "react";
import { toast } from "sonner";
import { MediaLightbox } from "../../../components/shared/MediaLightbox";
import { PromptReviewModal, type ImplicitReferenceItem } from "../../../components/element/PromptReviewModal";
import { RegenModal } from "../../../components/shot-stage/RegenModal";
import { VideoRegenModal } from "../../../components/shot-stage/VideoRegenModal";
import { CandidateCompareModal } from "../../../components/shot-stage/CandidateCompareModal";
import { InpaintCanvas } from "../../../components/vault/InpaintCanvas";
import { labelOfSource, hasSourceLabel } from "../../../lib/sourceLabels";
import type { ShotCandidate, PromptPreview, VideoDryRunResult } from "../../../lib/shotApi";

type LightboxState = {
  open: boolean;
  src: string;
  kind: "image" | "video";
  metadata?: { provider?: string; time?: string; cost_cny?: number; seed?: number; duration_sec?: number };
};

// 2026-05-27 — 加 negativePromptPreview 让 RegenModal 显示真 negative (P1-1)
type RegenModalState = {
  open: boolean;
  cid: string;
  sourceUrl: string;
  sourceLabel?: string;
  promptPreview?: string;
  /** P1-1: 真 negative 预览, 让 RegenModal "排除内容"段显示实际 send 内容 */
  negativePromptPreview?: string;
  vaultId?: string;
  /** W11 A5: 默认 tab — 让"画笔局部修改"入口直接进 inpaint 模式 */
  defaultTab?: "i2i" | "inpaint";
};

export interface ShotStageModalsProps {
  slug: string;

  // === PromptReviewModal (首帧) ===
  imageReviewOpen: boolean;
  imageReviewLoading: boolean;
  imageReviewPrompt: string;
  imageReviewNegative: string;
  imageReviewSegments: PromptPreview["segments"];
  imageReviewManualRefs: Array<{ url: string; label: string }>;
  imageReviewImplicitRefs: ImplicitReferenceItem[];
  /**
   * 2026-07-22 Y7 (UP-8 收线): 成本预告一行 — 免费渠道 "本地免费渠道 · 不计费",
   * 付费渠道与确认门同源的预估文案 (ShotStagePage.refreshImageCostPreview 产出)。
   * null/undefined = 还没算出来或没选模型, 该行不显示 (PromptReviewModal 原有零回归行为)。
   */
  imageCostPreview?: ReactNode;
  onImageReviewClose: () => void;
  onImageReviewConfirm: (finalPrompt: string) => Promise<void>;
  onImageReviewPromptChange: (next: string) => void;
  onImageReviewToggleImplicit: (asset_id: string, nextActive: boolean) => void;
  onImageReviewManualImport: (files: FileList | File[] | null) => void;

  // === PromptReviewModal (视频) ===
  videoReviewOpen: boolean;
  videoReviewLoading: boolean;
  videoReviewPrompt: string;
  videoReviewNegative: string;
  videoReviewSegments: PromptPreview["segments"];
  videoReviewManualRefs: Array<{ url: string; label: string }>;
  videoReviewImplicitRefs: ImplicitReferenceItem[];
  /** 2026-07-22 Y7 (UP-8 收线): 同上, 视频侧 (ShotStagePage.refreshVideoCostPreview 产出)。 */
  videoCostPreview?: ReactNode;
  onVideoReviewClose: () => void;
  onVideoReviewConfirm: (finalPrompt: string) => Promise<void>;
  onVideoReviewPromptChange: (next: string) => void;
  onVideoReviewToggleImplicit: (asset_id: string, nextActive: boolean) => void;
  onVideoReviewManualImport: (files: FileList | File[] | null) => void;

  // === MediaLightbox ===
  lightbox: LightboxState;
  onCloseLightbox: () => void;

  // === RegenModal ===
  regenModal: RegenModalState;
  imageModelRef: string | null;
  onImageModelChange: (v: string | null) => void;
  busyTag: string | null;
  onRegenModalClose: () => void;
  onRegenConfirm: (extra: string, mode: "full" | "compact") => Promise<void>;
  onRegenPreviewPrompt: (currentExtra: string) => void;
  onRegenCopyForExternal: (extra: string) => void;
  onRegenInpainted: () => void;

  // === VideoRegenModal ===
  videoRegenCandidate: ShotCandidate | null;
  videoModelRef: string | null;
  onVideoModelChange: (v: string | null) => void;
  durationSec: number;
  videoBusy: boolean;
  videoExtraInstructionDefault: string;
  onVideoRegenDryRun: (extra: string, modelRef: string | null) => Promise<VideoDryRunResult>;
  onVideoRegenConfirm: (extra: string) => Promise<void>;
  onVideoRegenClose: () => void;

  // === CandidateCompareModal ===
  compareModalOpen: boolean;
  selectedCompareCandidates: ShotCandidate[];
  onCompareModalClose: () => void;
  onCompareModalPickAsMain: (c: ShotCandidate) => void;
  onCompareModalViewPrompt: () => void;

  // === InpaintCanvas ===
  inpaintState: { open: boolean; vaultId: string; sourceUrl: string };
  onInpainted: () => void;
  onInpaintClose: () => void;
}

export function ShotStageModals(props: ShotStageModalsProps) {
  const {
    slug,
    imageReviewOpen, imageReviewLoading, imageReviewPrompt, imageReviewNegative,
    imageReviewSegments, imageReviewManualRefs, imageReviewImplicitRefs, imageCostPreview,
    onImageReviewClose, onImageReviewConfirm, onImageReviewPromptChange,
    onImageReviewToggleImplicit, onImageReviewManualImport,
    videoReviewOpen, videoReviewLoading, videoReviewPrompt, videoReviewNegative,
    videoReviewSegments, videoReviewManualRefs, videoReviewImplicitRefs, videoCostPreview,
    onVideoReviewClose, onVideoReviewConfirm, onVideoReviewPromptChange,
    onVideoReviewToggleImplicit, onVideoReviewManualImport,
    lightbox, onCloseLightbox,
    regenModal, imageModelRef, onImageModelChange, busyTag,
    onRegenModalClose, onRegenConfirm, onRegenPreviewPrompt, onRegenCopyForExternal, onRegenInpainted,
    videoRegenCandidate, videoModelRef, onVideoModelChange, durationSec, videoBusy,
    videoExtraInstructionDefault, onVideoRegenDryRun, onVideoRegenConfirm, onVideoRegenClose,
    compareModalOpen, selectedCompareCandidates,
    onCompareModalClose, onCompareModalPickAsMain, onCompareModalViewPrompt,
    inpaintState, onInpainted, onInpaintClose,
  } = props;

  return (
    <>
      {/* 首帧提示词审核弹窗 — Wave B-2: 透传 implicit refs + 取消回调 */}
      <PromptReviewModal
        open={imageReviewOpen}
        kind="image"
        title="审核首帧提示词"
        fullPrompt={imageReviewPrompt}
        negativePrompt={imageReviewNegative}
        segments={imageReviewSegments}
        referenceImages={imageReviewManualRefs}
        implicitReferences={imageReviewImplicitRefs}
        onToggleImplicitRef={onImageReviewToggleImplicit}
        loading={imageReviewLoading}
        costPreview={imageCostPreview}
        onConfirm={onImageReviewConfirm}
        onClose={onImageReviewClose}
        onPromptChange={onImageReviewPromptChange}
        onManualImport={onImageReviewManualImport}
      />

      {/* 视频提示词审核弹窗 */}
      <PromptReviewModal
        open={videoReviewOpen}
        kind="video"
        title="审核视频提示词"
        fullPrompt={videoReviewPrompt}
        negativePrompt={videoReviewNegative}
        segments={videoReviewSegments}
        referenceImages={videoReviewManualRefs}
        implicitReferences={videoReviewImplicitRefs}
        onToggleImplicitRef={onVideoReviewToggleImplicit}
        loading={videoReviewLoading}
        costPreview={videoCostPreview}
        onConfirm={onVideoReviewConfirm}
        onClose={onVideoReviewClose}
        onPromptChange={onVideoReviewPromptChange}
        onManualImport={onVideoReviewManualImport}
      />

      {/* W7: MediaLightbox 全屏 */}
      <MediaLightbox
        open={lightbox.open}
        src={lightbox.src}
        kind={lightbox.kind}
        metadata={lightbox.metadata}
        onClose={onCloseLightbox}
      />

      {/* W7-cand-ux: 候选卡 i2i 微调重抽弹窗 */}
      {/* 2026-05-17 合并: 加 inpaintVaultId 让 RegenModal "局部涂抹" tab 可用,
          不再需要独立 FirstFrameTile onInpaint hover 按钮 */}
      <RegenModal
        open={regenModal.open}
        projectSlug={slug}
        enableCompactMode={true}
        sourceImageUrl={regenModal.sourceUrl}
        sourceLabel={regenModal.sourceLabel}
        modelRef={imageModelRef}
        onModelRefChange={onImageModelChange}
        promptPreview={regenModal.promptPreview}
        negativePromptPreview={regenModal.negativePromptPreview}
        busy={busyTag === `regen-${regenModal.cid}`}
        inpaintVaultId={regenModal.vaultId}
        onInpainted={onRegenInpainted}
        onConfirm={onRegenConfirm}
        onPreviewPrompt={onRegenPreviewPrompt}
        onCopyForExternal={onRegenCopyForExternal}
        onClose={onRegenModalClose}
        defaultTab={regenModal.defaultTab ?? "i2i"}
      />

      <VideoRegenModal
        open={!!videoRegenCandidate}
        projectSlug={slug}
        sourceVideoUrl={videoRegenCandidate?.url || videoRegenCandidate?.thumbnail || ""}
        sourceLabel={
          // 2026-05-28 P1#16: 用 hasSourceLabel 而非字符串比较 "未知来源"
          // (sourceLabels.ts 兜底文案变了 — 现在返 "其他来源" — 旧字符串比较永远 truthy)
          // 2026-05-28 audit P1: ShotCandidate 没有 origin 字段 (后端 toCandidate 不写),
          // 删除旧代码里 candidate.origin 强类型读取的死分支, 直接走 provider fallback.
          videoRegenCandidate
            ? (videoRegenCandidate.provider && hasSourceLabel(videoRegenCandidate.provider)
              ? labelOfSource(videoRegenCandidate.provider)
              : undefined)
            : undefined
        }
        sourceGenerationId={videoRegenCandidate?.generation_id || videoRegenCandidate?.id || ""}
        modelRef={videoModelRef}
        onModelRefChange={onVideoModelChange}
        durationSec={durationSec}
        busy={videoBusy}
        // 2026-05-20 Wave T hotfix — defaultExtra 继承 videoExtraInstruction(铁律 #12 批改+发送一致)
        defaultExtra={videoExtraInstructionDefault}
        onDryRun={onVideoRegenDryRun}
        onConfirm={onVideoRegenConfirm}
        onClose={onVideoRegenClose}
      />

      {/* W8-BC (2026-05-16): 候选并排对比 modal */}
      <CandidateCompareModal
        open={compareModalOpen}
        candidates={selectedCompareCandidates}
        slug={slug}
        onPickAsMain={onCompareModalPickAsMain}
        onViewPrompt={onCompareModalViewPrompt}
        onClose={onCompareModalClose}
      />

      {/* W8-BC (2026-05-16): 局部重抽 InpaintCanvas — 完成回调拉一遍 detail 即可,
          后端 inpaint 接口已写入 vault, 下次 refresh 会作为新候选回到列表 */}
      <InpaintCanvas
        open={inpaintState.open}
        vaultId={inpaintState.vaultId}
        sourceImageUrl={inpaintState.sourceUrl}
        onInpainted={(_res) => {
          toast.success(`局部重抽完成 · 新图已加入候选区`);
          onInpainted();
        }}
        onClose={onInpaintClose}
      />
    </>
  );
}
