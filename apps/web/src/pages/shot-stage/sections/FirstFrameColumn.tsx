// P1 #17 (2026-05-21): 中列(首帧候选区) — 从 ShotStagePage 拆出.
// 纯展示: 通过 props 接所有状态/handler. hook 与业务逻辑留在主页面.
import type { RefObject } from "react";
import { toast } from "sonner";
import { Icon } from "../../../components/shared/Icon";
import { Button } from "../../../components/ui/button";
import { ComposeBox } from "../../../components/shot-stage/ComposeBox";
import type { MentionAsset } from "../../../lib/mentionTypes";
import type {
  ShotCandidate, PromptPreview, FrameAnchor,
} from "../../../lib/shotApi";
import type { TaskRecord } from "../../../stores/tasksStore";
import {
  FirstFrameTile, PlaceholderTile, ImportTile, FailedTaskTile,
  InlinePromptPreviewBody,
  candidateZoneStyle, candidateHeaderStickyStyle, zoneTitleStyle, inlinePreviewStyle, inlinePreviewSummaryStyle,
} from "../parts";
// 2026-05-28 P2#46: modelRefOrUndefined 共享版本
import { modelRefOrUndefined } from "../../../lib/modelRef";

export interface FirstFrameColumnProps {
  slug: string;
  /** 2026-05-29 P0(跨分镜状态泄漏): 透传给 InlinePromptPreviewBody 当 PromptPreviewBlock 的 remount key */
  shotId: string;

  // 模型 + ref(用于 ComposeBox + WaitingModelTile + FailedTaskTile)
  imageModelRef: string | null;
  onImageModelChange: (next: string | null) => void;
  imageModelPickerRef: RefObject<HTMLDivElement | null>;
  imagePickerHighlight: boolean;

  // 用户补充 + 候选数
  imageExtraInstruction: string;
  onImageExtraInstructionChange: (v: string) => void;
  drawCount: number;
  onDrawCountChange: (n: number) => void;

  // 候选数据
  firstFrameCandidates: ShotCandidate[];
  firstAnchor: FrameAnchor | undefined;
  endAnchor: FrameAnchor | undefined;

  // 任务状态
  imageBusy: boolean;
  imageTask: TaskRecord | undefined;
  failedImageTasks: TaskRecord[];
  runningImageTasks: TaskRecord[];
  localPendingImageCount: number;

  // 推荐采纳
  recommendedCandidateId: string | null;
  recommendedCandidate: ShotCandidate | null;
  recommendedCandidateIndex: number | null;
  autoPickTopScore: string | null;

  // 对比
  compareSelection: string[];
  onClearCompareSelection: () => void;
  onOpenCompareModal: () => void;
  onToggleCompareSelection: (id: string) => void;

  // 焦点
  pickedFirstId: string | null;
  /**
   * 2026-05-27 bugfix: shotboard 用 shot.picked_first_frame_id 判定首帧,
   * 与 frame_anchors[role=first] 并存. caller 注入 detail?.picked_first_frame_id 让
   * isFirst 判定 fallback, 避免老数据/批量挑卡只写其一时单镜创作页看不到首帧标识.
   */
  pickedFirstFrameId?: string | null;

  // 预览 details
  livePreview: PromptPreview | null;
  liveLoading: boolean;
  onPreviewKindImage: () => void;

  // 导入候选 input ref
  candidateImportRef: RefObject<HTMLInputElement | null>;
  onImportCandidate: (files: FileList | null) => void;
  /** 2026-05-22: 缩略图比例 — 跟剧本身 aspect_ratio 一致 (用户原话: "这部剧的比例是什么, 视频、图片缩略图的比例就是什么"). */
  tileAspectRatio: string;

  // 候选 actions
  onDrawFirstFrame: () => void;
  onOpenImageReview: () => void;
  /** 2026-05-27 bugfix: caller 注入按 kind 取对应 preview 的复制函数 (永远是 image preview) */
  onCopyImagePrompt?: () => void;
  /** 2026-05-26 W8-D 兜底复制提示词 — 无需开 modal 直接复制走外部 AI 自己生 */
  onCopyPrompt: () => void;
  onMentionAsset: (asset: MentionAsset) => void;
  onApplyAnchor: (c: ShotCandidate, role: "first" | "end" | "key") => void;
  onRejectCandidate: (c: ShotCandidate) => void;
  /** 整图重抽 — 弹 RegenModal (默认 i2i tab) */
  onOpenRegenModal: (c: ShotCandidate) => void;
  /** W11 A5: 画笔局部修改 — 弹 RegenModal 并直接进 inpaint tab */
  onOpenInpaintModal?: (c: ShotCandidate) => void;
  onRenameCandidate: (c: ShotCandidate, label: string) => Promise<void>;
  onOpenLightboxFromCandidate: (c: ShotCandidate) => void;
  onSetPickedFirstId: (id: string) => void;

  // failed actions
  onRemoveTask: (taskId: string) => void;

  // 2026-05-27 — 全文模式编辑后 caller 持有 override 抽卡时用
  onPromptOverrideChange?: (override: string | null) => void;

  // W11 A7: "只问不抽" 入口 — 让 ComposeBox 上方多个 toggle 让用户切换"生成 / 只问不抽"
  onAsk?: (question: string) => void;
  asking?: boolean;

  // D-P1 (2026-06-01): AI 润色提示词 — ComposeBox 内按钮触发, 结果在预览弹窗展示
  onPolish?: () => void;
  polishBusy?: boolean;
}

export function FirstFrameColumn(props: FirstFrameColumnProps) {
  const {
    slug: _slug,
    imageModelRef, onImageModelChange, imageModelPickerRef, imagePickerHighlight,
    imageExtraInstruction, onImageExtraInstructionChange, drawCount, onDrawCountChange,
    firstFrameCandidates, firstAnchor, endAnchor,
    imageBusy, imageTask, failedImageTasks, runningImageTasks, localPendingImageCount,
    recommendedCandidateId, recommendedCandidate, recommendedCandidateIndex, autoPickTopScore,
    compareSelection, onClearCompareSelection, onOpenCompareModal, onToggleCompareSelection,
    pickedFirstId, pickedFirstFrameId,
    livePreview, liveLoading, onPreviewKindImage,
    candidateImportRef, onImportCandidate, tileAspectRatio,
    onDrawFirstFrame, onOpenImageReview, onCopyImagePrompt, onCopyPrompt, onMentionAsset, onApplyAnchor,
    onRejectCandidate, onOpenRegenModal, onOpenInpaintModal, onRenameCandidate, onOpenLightboxFromCandidate,
    onSetPickedFirstId,
    onRemoveTask,
    onPromptOverrideChange,
    onAsk, asking,
    onPolish, polishBusy,
  } = props;
  void _slug;

  const hasNoModelAndEmpty =
    !modelRefOrUndefined(imageModelRef) &&
    firstFrameCandidates.length === 0 &&
    runningImageTasks.length === 0 &&
    failedImageTasks.length === 0 &&
    localPendingImageCount === 0;

  return (
    <div style={candidateZoneStyle}>
      {/* W10: ComposeBox sticky — 滚动候选区时 header (含模型+ComposeBox) 始终可见 */}
      <header style={candidateHeaderStickyStyle}>
        {/* 2026-05-18 重构: 删 header 顶部的 ModelPicker + DrawCardRow + 提示行,
            全部下沉到 header 末尾的 ComposeBox kind="image"
            (跟视频候选区同款 ChatGPT 风格 — 用户原话"图片生成界面也要这样啊,
            这种逻辑完全可以复用的, 没必要一改改好几处"). */}
        <div ref={imageModelPickerRef} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3 style={zoneTitleStyle}>
            <Icon name="image" size={14} style={{ color: "var(--brand-600)" }} />
            首帧候选 <span style={{ color: "var(--ink-400)", fontWeight: 500 }}>({firstFrameCandidates.length})</span>
          </h3>
          <span style={{ fontSize: 10.5, color: "var(--ink-400)" }}>
            提示: 可直接粘贴剪贴板图片到候选区 · 也可拖入文件
          </span>
        </div>
        {/* W8-BC (2026-05-16): 候选对比 toolbar — 多选 2-4 张并排比较 */}
        {firstFrameCandidates.length >= 2 && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            padding: "6px 10px", borderRadius: 8,
            background: "var(--ink-50)", border: "1px solid var(--ink-100)",
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-700)" }}>对比:</span>
            <span style={{ fontSize: 11, color: "var(--ink-500)" }}>
              勾选 2-4 张候选并排查看大图 — 已选 {compareSelection.length} 张
            </span>
            <span style={{ flex: 1 }} />
            {compareSelection.length > 0 && (
              <Button
                variant="ghost"
                size="xs"
                iconLeft="close"
                onClick={onClearCompareSelection}
                title="清空对比选中"
              >
                清空
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              iconLeft="grid"
              onClick={onOpenCompareModal}
              disabled={compareSelection.length < 2}
              title={compareSelection.length < 2 ? "至少选 2 张候选" : `并排对比 ${compareSelection.length} 张候选大图`}
            >
              对比 ({compareSelection.length})
            </Button>
          </div>
        )}
        <input ref={candidateImportRef} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => onImportCandidate(e.currentTarget.files)} />
        {/* 2026-05-19 #5: 默认展开 — 用户原话"信息直接可见 > 模式切换". 提示词预览是核心信息. */}
        <details
          open
          onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) onPreviewKindImage(); }}
          style={inlinePreviewStyle}
        >
          <summary style={inlinePreviewSummaryStyle}>
            <Icon name="doc" size={11} style={{ color: "var(--brand-600)" }} />
            当前首帧提示词预览
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-400)" }}>实时随关键参数更新</span>
          </summary>
          <InlinePromptPreviewBody
            previewKind="image"
            shotId={props.shotId}
            livePreview={livePreview}
            liveLoading={liveLoading}
            // 2026-05-27 bugfix: 复制提示词必须是 image kind, 不能取 livePreview (可能当前是 video).
            // 走 caller (ShotStagePage handleCopyImagePrompt) 注入, 自带 kind 安全选择.
            onCopy={() => onCopyImagePrompt?.() ?? navigator.clipboard?.writeText(
              livePreview?.kind === "image" ? (livePreview.composed_prompt || "") : "",
            ).then(
              () => toast.success("已复制完整提示词"),
              () => toast.error("复制失败"),
            )}
            onEditAndSend={onOpenImageReview}
            onPromptOverrideChange={onPromptOverrideChange}
          />
        </details>

        {/* 2026-05-18 通用 ChatGPT 风格 ComposeBox — 与视频候选区视觉一致 (kind="image").
            用户原话"图片生成界面也要这样啊, 这种逻辑完全可以复用的". */}
        <ComposeBox
          kind="image"
          slug={_slug}
          value={imageExtraInstruction}
          onChange={onImageExtraInstructionChange}
          modelRef={imageModelRef}
          onModelChange={onImageModelChange}
          count={drawCount}
          onCountChange={onDrawCountChange}
          busy={imageBusy}
          busyLabel={imageTask?.status === "queued" ? "排队中..." : imageTask ? `生成中 (~${imageTask.eta_s ?? "?"}s)` : undefined}
          onDraw={onDrawFirstFrame}
          onPreviewPrompt={onOpenImageReview}
          onCopyPrompt={onCopyPrompt}
          onMentionAsset={onMentionAsset}
          modelPickerHighlight={imagePickerHighlight}
          onAsk={onAsk}
          asking={asking}
          onPolish={onPolish}
          polishBusy={polishBusy}
        />
      </header>

      {/* B-8: 自动挑卡推荐行 — 铁律 #1 推荐而非强制，用户可手动覆盖
          只在 ①有候选 ②有 quality_scores ③首帧锚点未锁定 时显示 */}
      {recommendedCandidateId && !firstAnchor && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          padding: "7px 12px", borderRadius: 8,
          background: "var(--brand-50, #fff7f2)", border: "1px solid var(--brand-200, #fbd0bc)",
          fontSize: 12, color: "var(--brand-700, #b94b24)",
        }}>
          <Icon name="star" size={13} style={{ flexShrink: 0 }} />
          <span style={{ fontWeight: 600 }}>
            自动推荐：第 {recommendedCandidateIndex} 张{autoPickTopScore ? `（评分 ${autoPickTopScore}）` : ""}
          </span>
          <span style={{ color: "var(--ink-500)", fontSize: 11 }}>
            基于图像质量综合评分（构图/清晰度/提示词匹配/主体完整性）
          </span>
          <span style={{ flex: 1 }} />
          <Button
            variant="primary"
            size="sm"
            iconLeft="check"
            onClick={() => recommendedCandidate && onApplyAnchor(recommendedCandidate, "first")}
            title="将推荐候选设为首帧锚点（仍可手动更换）"
          >
            采纳推荐
          </Button>
        </div>
      )}

      {/* W7-cand-ux: 统一 grid — 失败卡 → 真实候选 → 运行中骨架 → 本地点击瞬间骨架.
          2026-05-27 — 删 WaitingModelTile (同 VideoColumn 同款修复): ComposeBox header
          已有 ModelPicker + "抽首帧" 按钮, 这里再嵌一份 ModelPicker 是重复, 而且选完
          模型后整个 WaitingModelTile 消失给用户造成"突然不见"的错觉. 改成轻量引导
          banner + 导入卡, 引导用户去上方 header 的 ModelPicker. */}
      {hasNoModelAndEmpty ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
          <div style={{
            gridColumn: "1 / -1",
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(254,243,199,0.5)",
            border: "1px dashed rgba(245,158,11,0.6)",
            fontSize: 12,
            color: "var(--ink-700)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <Icon name="warning" size={14} style={{ color: "rgba(217,119,6,0.95)", flexShrink: 0 }} />
            <span>先在上方 <strong>选择生图模型</strong> 选一个模型, 然后点「抽首帧」就开始生成。也可以直接导入本地图片 →</span>
          </div>
          <ImportTile onClick={() => candidateImportRef.current?.click()} aspectRatio={tileAspectRatio} />
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 12 }}>
          {/* 失败卡 — 优先显示让用户看到失败的"图片位",可直接换模型重试 */}
          {failedImageTasks.map((t) => (
            <FailedTaskTile
              key={`failed-${t.task_id}`}
              task={t}
              modelRef={imageModelRef}
              onModelRefChange={onImageModelChange}
              onPreviewPrompt={onOpenImageReview}
              onRetry={() => {
                onRemoveTask(t.task_id);
                onDrawFirstFrame();
              }}
              onDismiss={() => onRemoveTask(t.task_id)}
              kind="image"
              aspectRatio={tileAspectRatio}
            />
          ))}
          {/* 已有候选 — 2026-05-27 加 displayIndex/Total: 按候选创建时间正序的稳定 #N,
              即使排序变了 (锚定的排前) 序号也不变, 用户能记得"#2 那张是上午抽的". */}
          {firstFrameCandidates.map((c) => {
            const indexByCreation =
              [...firstFrameCandidates]
                .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
                .findIndex((x) => x.id === c.id) + 1;
            return (
            <FirstFrameTile
              key={c.id}
              candidate={c}
              displayIndex={indexByCreation}
              displayTotal={firstFrameCandidates.length}
              // 2026-05-27 bugfix — 用户反馈"我之前设过的首帧状态怎么丢了, 但是分镜管理页面还有":
              //   shotboard 用 shot.picked_first_frame_id 判定首帧, shot-stage 只看 frame_anchors[role=first].
              //   两套字段不同步导致老数据/批量自动挑卡 流程只写一个, 另一边显示丢失.
              //   修法: 任一字段命中都显示已选首帧.
              isFirst={
                firstAnchor?.generation_id === c.id ||
                firstAnchor?.vault_id === c.vault_id ||
                pickedFirstFrameId === c.id
              }
              isEnd={endAnchor?.generation_id === c.id || endAnchor?.vault_id === c.vault_id}
              isFocused={pickedFirstId === c.id}
              isCompareSelected={compareSelection.includes(c.id)}
              isRecommended={recommendedCandidateId === c.id && !firstAnchor}
              onToggleCompare={() => onToggleCompareSelection(c.id)}
              onOpen={() => {
                onSetPickedFirstId(c.id);
                onOpenLightboxFromCandidate(c);
              }}
              onSetFirst={() => onApplyAnchor(c, "first")}
              onSetEnd={() => onApplyAnchor(c, "end")}
              onSetKey={() => onApplyAnchor(c, "key")}
              onReject={() => onRejectCandidate(c)}
              onRegen={() => onOpenRegenModal(c)}
              onInpaint={onOpenInpaintModal ? () => onOpenInpaintModal(c) : undefined}
              onRename={async (label) => { await onRenameCandidate(c, label); }}
              aspectRatio={tileAspectRatio}
              /* W11 A5: 画笔局部修改入口走 onInpaint → caller 弹 RegenModal defaultTab='inpaint' */
            />
            );
          })}
          {/* 运行中任务 → 骨架卡 */}
          {runningImageTasks.map((t) => (
            <PlaceholderTile
              key={`run-${t.task_id}`}
              kind="image"
              label={t.status === "queued" ? "首帧排队中..." : "首帧生成中"}
              startedAt={t.started_at}
              aspectRatio={tileAspectRatio}
            />
          ))}
          {/* 本地"点击瞬间到 API 返回前"骨架(网络窗口) */}
          {Array.from({ length: localPendingImageCount }).map((_, i) => (
            <PlaceholderTile
              key={`pending-img-${i}`}
              kind="image"
              label="正在排队..."
              aspectRatio={tileAspectRatio}
            />
          ))}
          {/* +导入卡 */}
          <ImportTile onClick={() => candidateImportRef.current?.click()} aspectRatio={tileAspectRatio} />
        </div>
      )}

      {/* W7-stage-reorg: 首帧候选区底部 "锚点状态行" 已删除 — 锚点显示整合到视频候选区 header chips */}
    </div>
  );
}

// 2026-05-28 P2#46: modelRefOrUndefined 已抽到 lib/modelRef.ts (跟 ShotStagePage /
// VideoColumn 复用), 这里 import 而非本地定义.
