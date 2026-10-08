// P1 #17 (2026-05-21): 右列(视频候选区 + 快捷参数 + 锚点 chips) — 从 ShotStagePage 拆出.
// 纯展示: 通过 props 接所有 state / handler. hook 与业务逻辑留在主页面.
import type { RefObject } from "react";
import { toast } from "sonner";
import { Icon } from "../../../components/shared/Icon";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Select } from "../../../components/ui/select";
import { ComposeBox } from "../../../components/shot-stage/ComposeBox";
import { VoiceSelector } from "../../../components/element/VoiceSelector";
import type { MentionAsset } from "../../../lib/mentionTypes";
import type {
  ShotCandidate, FrameAnchor, PromptPreview,
} from "../../../lib/shotApi";
import type { TaskRecord } from "../../../stores/tasksStore";
import { shotTypeDisplayLabel } from "../../../lib/shotMetaPresets";
import { cameraMovementDisplayLabel } from "../../../lib/cameraMovementPresets";
// 2026-05-28 P2#46: modelRefOrUndefined 共享版本
import { modelRefOrUndefined } from "../../../lib/modelRef";
import {
  DndContext, closestCenter,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions,
} from "@dnd-kit/core";
import {
  SortableContext, horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  Field, TagSelect, CameraMovementSelect,
  AnchorChipImg, SortableKeyAnchorChip,
  InlinePromptPreviewBody,
  VideoCandidateTile, PlaceholderTile, FailedTaskTile,
  ImportTile,
  inputStyle, candidateZoneStyle, candidateHeaderStickyStyle, zoneTitleStyle,
  inlinePreviewStyle, inlinePreviewSummaryStyle,
} from "../parts";

export interface VideoDraftSlice {
  duration_sec: number;
  shot_type: string;
  camera_movement: string;
  style: string;
  time_of_day: string;
  lighting: string;
  mood: string;
  emotion: string;
  transition_in: string;
  dialogue: string;
  voiceover: string;
  tts_voice_override: string;
  video_model_ref: string | null;
}

export interface VideoColumnProps {
  slug: string;
  /** 2026-05-29 P0(跨分镜状态泄漏): 透传给 InlinePromptPreviewBody 当 PromptPreviewBlock 的 remount key */
  shotId: string;
  epId: string;

  // navigation
  onNavigateCompose: () => void;

  // model / picker
  videoModelPickerRef: RefObject<HTMLDivElement | null>;
  videoPickerHighlight: boolean;

  // draft slice (video 关键参数 + model_ref)
  draft: VideoDraftSlice;
  updateDraft: (patch: Partial<VideoDraftSlice>) => void;

  // tts provider for VoiceSelector
  seriesTtsProviderId: string;

  // 用户补充 + 候选数
  videoExtraInstruction: string;
  onVideoExtraInstructionChange: (v: string) => void;
  videoCount: number;
  onVideoCountChange: (n: number) => void;

  // 候选数据 + 任务状态
  videoCandidates: ShotCandidate[];
  pickedVideoIdFromStore: string | undefined;
  pickedVideo: ShotCandidate | undefined;
  videoBusy: boolean;
  videoTask: TaskRecord | undefined;
  failedVideoTasks: TaskRecord[];
  runningVideoTasks: TaskRecord[];
  localPendingVideoCount: number;

  // 焦点
  pickedVideoId: string | null;

  // 锚点 (chips)
  firstAnchor: FrameAnchor | undefined;
  endAnchor: FrameAnchor | undefined;
  keyAnchors: FrameAnchor[];
  anchorCandidate: (a?: FrameAnchor) => ShotCandidate | undefined;
  dndSensors: SensorDescriptor<SensorOptions>[];
  onKeyAnchorDragEnd: (e: DragEndEvent) => void;
  onDropAnchor: (anchorId: string) => void;

  // 预览
  livePreview: PromptPreview | null;
  liveLoading: boolean;
  onPreviewKindVideo: () => void;

  // actions
  onGenerateVideo: () => void;
  onOpenVideoReview: () => void;
  /** 2026-05-27 bugfix: caller 注入按 kind 取对应 preview 的复制函数 (永远是 video preview) */
  onCopyVideoPrompt?: () => void;
  /** 2026-05-26 W8-D 兜底复制提示词 — 无需开 modal 直接复制走外部 AI 自己生 */
  onCopyPrompt: () => void;
  onMentionAsset: (asset: MentionAsset) => void;
  onSelectVideo: (c: ShotCandidate) => void;
  onRejectCandidate: (c: ShotCandidate) => void;
  onOpenVideoRegenModal: (c: ShotCandidate) => void;
  onRenameCandidate: (c: ShotCandidate, label: string) => Promise<void>;
  onOpenLightboxFromCandidate: (c: ShotCandidate) => void;
  onOpenLightboxFromAnchor: (c: ShotCandidate) => void;
  onSetPickedVideoId: (id: string) => void;
  onRemoveTask: (taskId: string) => void;

  // 2026-05-27 — 全文模式编辑后 caller 持有 video override 抽卡用
  onPromptOverrideChange?: (override: string | null) => void;

  // 2026-05-22 — 导入本地视频作候选 (用户原话: "如何在分镜页面导入本地生成好的视频?我没找到")
  // 复用 FirstFrameColumn 同一个 candidateImportRef + handleImportCandidate, 文件按 mime
  // 自动分流: image 进首帧池, video 进视频池. 这里加 UI 入口让用户在视频区也能直接点导入.
  candidateImportRef: RefObject<HTMLInputElement | null>;
  /** 2026-05-22: 缩略图比例 — 跟剧本身 aspect_ratio 一致 (用户原话: "这部剧的比例是什么, 视频、图片缩略图的比例就是什么"). */
  tileAspectRatio: string;

  // W11 A7: "只问不抽" 接入 ComposeBox
  onAsk?: (question: string) => void;
  asking?: boolean;
}

const MOOD_OPTIONS = ["中性", "兴奋", "紧张", "伤心", "愤怒", "浪漫", "压抑", "轻松", "幽默"];
const TRANSITION_OPTIONS = ["硬切", "淡入", "淡出", "叠化", "左划入", "右划入", "上划入", "下划入", "推镜接", "拉镜接"];
const SHOT_TYPES = ["特写", "近景", "中景", "远景", "全景", "俯拍", "仰拍", "过肩"];
const TIME_OPTIONS = ["清晨", "白天", "黄昏", "夜晚", "室内暖光", "雨夜", "霓虹夜景"];
const LIGHT_OPTIONS = ["柔光", "硬光", "逆光", "侧逆光", "窗边自然光", "低调光", "高调光", "电影感混合光"];

export function VideoColumn(props: VideoColumnProps) {
  const {
    slug, epId, onNavigateCompose,
    videoModelPickerRef, videoPickerHighlight,
    draft, updateDraft, seriesTtsProviderId,
    videoExtraInstruction, onVideoExtraInstructionChange, videoCount, onVideoCountChange,
    videoCandidates, pickedVideoIdFromStore, pickedVideo,
    videoBusy, videoTask, failedVideoTasks, runningVideoTasks, localPendingVideoCount,
    pickedVideoId,
    firstAnchor, endAnchor, keyAnchors, anchorCandidate, dndSensors, onKeyAnchorDragEnd, onDropAnchor,
    livePreview, liveLoading, onPreviewKindVideo,
    onGenerateVideo, onOpenVideoReview, onCopyVideoPrompt, onCopyPrompt, onMentionAsset,
    onSelectVideo, onRejectCandidate, onOpenVideoRegenModal, onRenameCandidate,
    onOpenLightboxFromCandidate, onOpenLightboxFromAnchor, onSetPickedVideoId,
    onRemoveTask,
    onPromptOverrideChange,
    candidateImportRef, tileAspectRatio,
    onAsk, asking,
  } = props;
  void epId;

  const hasNoModelAndEmpty =
    !modelRefOrUndefined(draft.video_model_ref) &&
    videoCandidates.length === 0 &&
    runningVideoTasks.length === 0 &&
    failedVideoTasks.length === 0 &&
    localPendingVideoCount === 0;

  return (
    // 2026-05-27 — data-section 锚点, 给 ShotStageBottomHint 的"去视频候选区"按钮做平滑滚定位
    <div style={candidateZoneStyle} data-section="video-column">
      {/* W10: ComposeBox sticky — 滚动候选区时 header (含快捷参数+ComposeBox) 始终可见 */}
      <header style={candidateHeaderStickyStyle}>
        {/* 2026-05-18 重构: 删 header 顶部的 ModelPicker + DrawCardRow, 改成简洁标题.
            ModelPicker + 候选数 + 抽视频按钮全部下沉到 header 末尾的 VideoComposeBox
            (ChatGPT 风格 — 用户配完上方设置后正下方就是生成按钮, 不用回滑找). */}
        <div ref={videoModelPickerRef} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <h3 style={zoneTitleStyle}>
            <Icon name="video" size={14} style={{ color: "var(--ok)" }} />
            视频候选 <span style={{ color: "var(--ink-400)", fontWeight: 500 }}>({videoCandidates.length})</span>
          </h3>
        </div>
        {/* 2026-05-17: 模式自动推断 — 用户原话"自己勾选或者 at 用不用图就行了" */}
        <div style={{ fontSize: 11, color: firstAnchor ? "var(--ink-500)" : "var(--ink-400)" }}>
          模式: <strong style={{ color: firstAnchor ? "var(--ok)" : "var(--brand-700)" }}>
            {firstAnchor ? "图生视频(基于首帧锚点)" : "文生视频(纯文字)"}
          </strong>
          <span style={{ marginLeft: 6, fontSize: 10.5 }}>
            {firstAnchor ? "↓ 想改成文生?清除首帧锚点即可" : "↓ 想改成图生?在首帧候选区点'设首帧'"}
          </span>
        </div>

        {/* 2026-05-17: 快捷参数 — 用户原话"把这些 tab 加入可选的视频生成界面提供快捷"
            原"关键参数" section 整体迁移至此(就近决策铁律 #4)
            2026-05-19 #5: 改为默认展开 — 用户原话"信息直接可见 > 模式切换" */}
        <details open style={inlinePreviewStyle}>
          <summary style={inlinePreviewSummaryStyle}>
            <Icon name="settings" size={11} style={{ color: "var(--brand-600)" }} />
            快捷参数(景别 / 运镜 / 时长 ...)
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-400)" }}>
              {[
                shotTypeDisplayLabel(draft.shot_type),
                cameraMovementDisplayLabel(draft.camera_movement),
                draft.time_of_day,
                `${draft.duration_sec}s`,
              ].filter(Boolean).join(" · ")}
            </span>
          </summary>
          <div style={{ padding: "8px 12px 10px", display: "flex", flexDirection: "column", gap: 8, borderTop: "1px solid var(--ink-100)" }}>
            {/* W11 B4 (2026-05-27): 常驻 4 字段 — 景别 / 运镜 / 时长 / 光线 (用户最常调).
                其他 7 (情绪 / 过渡 / 音色 / 时间段 / 风格 / 整体情绪 / 自定义过渡) 收进 "更多参数" 内层 details. */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Field label="景别">
                <TagSelect value={draft.shot_type} options={SHOT_TYPES} onChange={(v) => updateDraft({ shot_type: v })} />
              </Field>
              <Field label="运镜 / 镜头变化">
                <CameraMovementSelect value={draft.camera_movement} onChange={(v) => updateDraft({ camera_movement: v })} />
              </Field>
              <Field label="时长(秒)">
                <input type="number" min={1} max={120} value={draft.duration_sec}
                  onChange={(e) => updateDraft({ duration_sec: Number(e.target.value) || 5 })} style={inputStyle} />
              </Field>
              <Field label="打光风格">
                <TagSelect value={draft.lighting} options={LIGHT_OPTIONS} onChange={(v) => updateDraft({ lighting: v })} />
              </Field>
            </div>

            {/* W11 B4: 折叠 — 默认收起 7 个低频字段, 用户需要时再展开 */}
            <details>
              <summary style={{
                fontSize: 11, fontWeight: 600, color: "var(--ink-500)", cursor: "pointer",
                userSelect: "none", padding: "4px 0",
              }}>
                更多参数(情绪 / 过渡 / 音色 / 时间段 / 风格 ...)
              </summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 6 }}>
                {/* 4 个小字段一排 - 情绪 / 前置过渡 / 时间段 / 音色覆盖 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, alignItems: "end" }}>
                  <Field label="分镜情绪">
                    <Select
                      value={draft.emotion || "__none__"}
                      onChange={(v) => updateDraft({ emotion: v === "__none__" ? "" : v })}
                      options={[
                        { value: "__none__", label: "— 不指定 —" },
                        ...MOOD_OPTIONS.map((o) => ({ value: o, label: o })),
                      ]}
                      ariaLabel="分镜情绪"
                      className="w-full"
                    />
                  </Field>
                  <Field label="前置过渡">
                    <Select
                      value={TRANSITION_OPTIONS.includes(draft.transition_in) ? draft.transition_in : "__none__"}
                      onChange={(v) => updateDraft({ transition_in: v === "__none__" ? "" : v })}
                      options={[
                        { value: "__none__", label: "— 不指定 —" },
                        ...TRANSITION_OPTIONS.map((o) => ({ value: o, label: o })),
                      ]}
                      ariaLabel="前置过渡 (上一镜→本镜)"
                      className="w-full"
                    />
                  </Field>
                  <Field label="时间段">
                    <TagSelect value={draft.time_of_day} options={TIME_OPTIONS} onChange={(v) => updateDraft({ time_of_day: v })} />
                  </Field>
                  {/* 2026-05-17 voice-sync v1: 本镜对白音色覆盖
                      优先级最高:shot.tts_voice_override > character.voice_id > series.defaults.tts_voice_id */}
                  {(draft.dialogue.trim() || draft.voiceover.trim()) ? (
                    <Field label="本镜音色 (临时覆盖)">
                      <VoiceSelector
                        value={draft.tts_voice_override}
                        providerId={seriesTtsProviderId}
                        onChange={(voiceId) => updateDraft({ tts_voice_override: voiceId })}
                        previewText={(draft.dialogue || draft.voiceover || "你好,这是声音试听样本。").slice(0, 60)}
                        compact
                      />
                    </Field>
                  ) : <div />}
                </div>
                {/* 风格 + 情绪 + 自定义过渡输入 3 列一排 */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <Field label="画面风格">
                    <Input value={draft.style} onChange={(e) => updateDraft({ style: e.target.value })} placeholder="电影感 / 手绘 / 写实" className="h-9 text-[13px]" />
                  </Field>
                  <Field label="整体情绪">
                    <Input value={draft.mood} onChange={(e) => updateDraft({ mood: e.target.value })} placeholder="紧张 / 暧昧 / 轻松" className="h-9 text-[13px]" />
                  </Field>
                  <Field label="过渡自定义">
                    <Input value={draft.transition_in} onChange={(e) => updateDraft({ transition_in: e.target.value })} placeholder="或手动输入转场" className="h-9 text-[13px]" />
                  </Field>
                </div>
              </div>
            </details>

            <p style={{ margin: 0, fontSize: 10.5, color: "var(--ink-400)", lineHeight: 1.4 }}>
              chip 改后实时拼进视频提示词。也可在「画面描述 → 高级 → 视频运动提示词」直接写覆盖。
            </p>
          </div>
        </details>

        {/* W7-stage-reorg: 锚点 chips — 显示首/尾/关键 + 关键帧支持 dnd-kit 拖拽改顺序 */}
        <div style={{
          marginTop: 4, padding: "8px 10px", borderRadius: 8,
          background: "var(--ink-50)", border: "1px dashed var(--ink-150)",
          display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center",
        }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-700)" }}>锚点:</span>
          {/* 首帧 chip */}
          <AnchorChipImg
            label="首帧"
            anchor={firstAnchor}
            candidate={anchorCandidate(firstAnchor)}
            onOpen={(c) => onOpenLightboxFromAnchor(c)}
            onMissingClick={() => {
              toast("请在上方首帧候选区点 '设首帧'", { icon: "ℹ️" });
            }}
          />
          {/* 尾帧 chip */}
          <AnchorChipImg
            label="尾帧"
            anchor={endAnchor}
            candidate={anchorCandidate(endAnchor)}
            onOpen={(c) => onOpenLightboxFromAnchor(c)}
            onMissingClick={() => {
              toast("请在上方首帧候选区点 '设尾帧'", { icon: "ℹ️" });
            }}
          />
          {/* 关键帧 chips — dnd-kit 拖拽改顺序 */}
          {keyAnchors.length > 0 && (
            <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={onKeyAnchorDragEnd}>
              <SortableContext items={keyAnchors.map((a) => a.id)} strategy={horizontalListSortingStrategy}>
                <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                  {keyAnchors.map((a, i) => (
                    <SortableKeyAnchorChip
                      key={a.id}
                      anchor={a}
                      index={i}
                      candidate={anchorCandidate(a)}
                      onOpen={(c) => onOpenLightboxFromAnchor(c)}
                      onRemove={() => onDropAnchor(a.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
          {keyAnchors.length === 0 && (
            <span style={{ fontSize: 10.5, color: "var(--ink-400)", fontStyle: "italic" }}>
              还没添加关键帧 — 在下方挑选首帧候选,鼠标移到图上会出现「设为关键帧」按钮。
            </span>
          )}
        </div>

        {/* 2026-05-19 #5: 视频提示词预览改默认展开 — 信息直接可见 */}
        <details
          open
          onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) onPreviewKindVideo(); }}
          style={inlinePreviewStyle}
        >
          <summary style={inlinePreviewSummaryStyle}>
            <Icon name="doc" size={11} style={{ color: "var(--brand-600)" }} />
            当前视频提示词预览
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--ink-400)" }}>实时随关键参数更新</span>
          </summary>
          <InlinePromptPreviewBody
            previewKind="video"
            shotId={props.shotId}
            livePreview={livePreview}
            liveLoading={liveLoading}
            // 2026-05-27 bugfix: 复制提示词必须是 video kind, 不能取 livePreview (可能当前是 image)
            onCopy={() => onCopyVideoPrompt?.() ?? navigator.clipboard?.writeText(
              livePreview?.kind === "video" ? (livePreview.composed_prompt || "") : "",
            ).then(
              () => toast.success("已复制完整提示词"),
              () => toast.error("复制失败"),
            )}
            onEditAndSend={onOpenVideoReview}
            onPromptOverrideChange={onPromptOverrideChange}
          />
        </details>

        {/* 2026-05-18 ChatGPT 风格补充框 — 用户原话"几个按钮放在 tab 下方,
            上方设置做好之后正下面就是生成按钮, 再加一个聊天框可以补充用户的意见
            (允许 @ 素材), 同步到提示词里, 右下角放模型选择器和生成按钮". */}
        <ComposeBox
          kind="video"
          slug={slug}
          value={videoExtraInstruction}
          onChange={onVideoExtraInstructionChange}
          modelRef={draft.video_model_ref}
          onModelChange={(v) => updateDraft({ video_model_ref: v })}
          count={videoCount}
          onCountChange={(n) => onVideoCountChange(Math.max(1, Math.min(8, n)))}
          busy={videoBusy}
          busyLabel={videoTask?.status === "queued" ? "排队中..." : videoTask ? `生成中 (~${videoTask.eta_s ?? "?"}s)` : undefined}
          onDraw={onGenerateVideo}
          onPreviewPrompt={onOpenVideoReview}
          onCopyPrompt={onCopyPrompt}
          onMentionAsset={onMentionAsset}
          modelPickerHighlight={videoPickerHighlight}
          onAsk={onAsk}
          asking={asking}
        />
      </header>

      {/* W7-cand-ux: 视频候选 — 统一 grid 渲染 4 状态(失败/真候选/运行中/本地 pending) */}
      {/* 2026-05-27 — 删 WaitingModelTile (用户反馈"功能重复且 bug").
          ComposeBox header 里已经有 ModelPicker + "抽视频" 按钮, 这里再嵌一份
          ModelPicker 是重复, 而且选完后整个 WaitingModelTile 消失给用户造成
          "东西突然不见了"的错觉. 现在候选空 + 没模型时, 只展示 ImportTile (永远
          可见的导入入口) + 一行小引导文案指向 header 的 ModelPicker. */}
      {hasNoModelAndEmpty ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
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
            <span>先在上方 <strong>选择生视频模型</strong> 选一个模型, 然后点「抽视频」就开始生成。也可以直接导入本地视频 →</span>
          </div>
          <ImportTile onClick={() => candidateImportRef.current?.click()} aspectRatio={tileAspectRatio} />
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
          {failedVideoTasks.map((t) => (
            <FailedTaskTile
              key={`failed-${t.task_id}`}
              task={t}
              modelRef={draft.video_model_ref}
              onModelRefChange={(v) => updateDraft({ video_model_ref: v })}
              onPreviewPrompt={onOpenVideoReview}
              onRetry={() => {
                onRemoveTask(t.task_id);
                onGenerateVideo();
              }}
              onDismiss={() => onRemoveTask(t.task_id)}
              kind="video"
              aspectRatio={tileAspectRatio}
            />
          ))}
          {/* 2026-05-27 — displayIndex/Total 同 FirstFrameColumn: 按创建时间稳定 #N */}
          {videoCandidates.map((c) => {
            const indexByCreation =
              [...videoCandidates]
                .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
                .findIndex((x) => x.id === c.id) + 1;
            return (
              <VideoCandidateTile
                key={c.id}
                candidate={c}
                displayIndex={indexByCreation}
                displayTotal={videoCandidates.length}
                isPicked={c.id === pickedVideoIdFromStore}
                isFocused={pickedVideoId === c.id}
                onOpen={() => {
                  onSetPickedVideoId(c.id);
                  onOpenLightboxFromCandidate(c);
                }}
                onSelect={() => onSelectVideo(c)}
                onReject={() => onRejectCandidate(c)}
                onRegen={() => onOpenVideoRegenModal(c)}
                onRename={async (label) => { await onRenameCandidate(c, label); }}
                aspectRatio={tileAspectRatio}
              />
            );
          })}
          {runningVideoTasks.map((t) => (
            <PlaceholderTile
              key={`run-${t.task_id}`}
              kind="video"
              label={t.status === "queued" ? "视频排队中..." : "视频生成中"}
              startedAt={t.started_at}
              aspectRatio={tileAspectRatio}
            />
          ))}
          {Array.from({ length: localPendingVideoCount }).map((_, i) => (
            <PlaceholderTile
              key={`pending-vid-${i}`}
              kind="video"
              label="正在排队..."
              aspectRatio={tileAspectRatio}
            />
          ))}
          {/* 2026-05-22 — 导入本地视频作候选 (用户原话: "如何在分镜页面导入本地生成好的视频?")
              ImportTile 与 FirstFrameColumn 同款, 文件选择 accept="video/*", 走 ShotStagePage
              handleImportCandidate, mime 命中 video/* → importLocalVideoAsCandidate 进视频候选池. */}
          <ImportTile onClick={() => candidateImportRef.current?.click()} aspectRatio={tileAspectRatio} />
        </div>
      )}

      {/* 2026-05-27 — 删 "这一镜的视频历史" 条带 (用户反馈"上下两套不顺畅, 点下边
          上边顺序乱"). 上方候选卡已经是这一镜所有 active 视频的唯一展示位 + 操作位,
          下方条带等价信息冗余 + 操作错位. 想找"刚被废弃的旧版本"走右下角废案库,
          不在主候选区暴露二套 UI. */}

      {/* 当前选定视频 */}
      {pickedVideo && (
        <footer style={{
          marginTop: 12, padding: "8px 12px", borderRadius: 8,
          background: "rgba(16,185,129,0.07)", border: "1px solid rgba(16,185,129,0.25)",
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 11.5,
        }}>
          <span style={{ fontWeight: 700, color: "var(--ok, #059669)" }}>
            <Icon name="check" size={11} /> 已选定视频
          </span>
          <Button
            variant="ghost"
            size="xs"
            iconLeft="play"
            onClick={() => onOpenLightboxFromCandidate(pickedVideo)}
            title="放大查看选定视频"
          >
            查看选定视频
          </Button>
          <span style={{ flex: 1 }} />
          <Button
            variant="primary"
            size="xs"
            iconRight="arrowRight"
            onClick={onNavigateCompose}
            title="前往合成"
          >
            前往合成
          </Button>
        </footer>
      )}
    </div>
  );
}


// 2026-05-28 P2#46: modelRefOrUndefined 已抽到 lib/modelRef.ts (跟 ShotStagePage /
// FirstFrameColumn 复用), 这里 import 而非本地定义.

