// v29 · P1 #17 (2026-05-21) 单镜创作页 — 主入口拆成 6 个 section 子组件
// 路由: /studio/:slug/shot-stage/:epId/:shotId
//
// 本轮变更(从 v28 → v29):
//   - JSX 拆 6 个 section: Header / PromptColumn / FirstFrameColumn / VideoColumn / RejectPoolSection / Modals
//   - 所有 hook / state / handler 仍在主组件 (避免 hook 顺序变化)
//   - 子组件纯展示, 通过 props 接 state / callback (零业务逻辑变更)
//   - 视觉零变更, smoke 通过
//
// 历史设计要点(继承):
//   - 顶栏 sticky:返回 + EP·S 标题 + 实时保存状态 + 前/后镜导航 + 前往合成 CTA
//   - 左栏 480px sticky:画面描述/关键参数/素材连接(3 个 section,从 5 减到 3)
//   - 右栏自由生长:首帧候选区 + 视频候选区 + 废案库(折叠) 同屏垂直堆叠
//   - 候选卡(图/视频/锚点)整张点击 → MediaLightbox 放大查看
//   - handleDrawFirstFrame / handleGenerateVideo 前置校验"未选模型"
//   - 12 条 UX 铁律全程对照
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { Empty } from "../../components/ui/empty";
import { useCharacters } from "../../hooks/useCharacters";
import { useScenes } from "../../hooks/useScenes";
import { useSeries } from "../../hooks/useSeries";
import { seriesAspectToCss } from "../../lib/aspectRatio";
import { patchShot, useShots, type Shot } from "../../hooks/useShots";
import { uploadSeriesAssets, type SeriesAssetRecord } from "../../lib/api";
import { listElements, type ElementData } from "../../lib/elementApi";
import { imageThumbUrl, candidateOriginalUrl } from "../../lib/imageThumb";
import {
  getScopedShotDetail,
  isNotImplemented,
  patchScopedFirstFrameCandidate,
  patchScopedVideoCandidate,
  listShotFailures,
  aiAsk,
  regenFromReject,
  setFrameAnchor,
  removeFrameAnchor,
  reorderKeyAnchors,
  getPromptPreview,
  promoteToRejectPool,
  listRejectPool,
  importFromRejectPool,
  importLocalImageAsCandidate,
  importLocalVideoAsCandidate,
  dryRunVideo,
  fileToBase64,
  polishPrompt,
  putShotPrompt,
  type ShotCandidate,
  type ShotDetail,
  type ShotFailure,
  type FrameAnchor,
  type PromptPreview,
  type SuggestedReference,
  type RejectPoolItem,
} from "../../lib/shotApi";
import { useImageGeneration } from "../../hooks/useImageGeneration";
import { useVideoGeneration } from "../../hooks/useVideoGeneration";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { ROUTES } from "../../lib/routes";
import { showErrorToast } from "../../lib/errorTranslate";
import { showErrorToastWithActions } from "../../lib/MultiActionToast";
import { useConfirm } from "../../components/ui/ConfirmModal";
// 2026-05-19 Wave O Entity-first Case B: 多 typical 图素材在 ShotStage 单镜级 override
// — 用户原话"如果素材里有多个图已选的时候怎么办" — 默认全 typical 喂模型,
// 用户可显式挑"本镜只用第 N 张"(铁律 #4 就近决策).
// 2026-05-20 删 ReferenceOverridePanel import — 跟 ChipDropdown 重复实现, 用户原话"这个 tab 就没有用了"
import type { ImplicitReferenceItem } from "../../components/element/PromptReviewModal";
// D-P1 (2026-06-01): AI 润色提示词预览弹窗
import { PolishPreviewModal } from "../../components/shot-stage/PolishPreviewModal";
import type { RejectItem } from "../../lib/elementApi";
// W10 (2026-05-26): isRealVideoProvider import 删除 — 顶栏 CTA 已删, hook 内部自带判定
import type { MentionOption } from "../../components/mention/mentionTokens";
// 2026-05-21 Wave Y P5/P6 — 富文本节点 derive + parse helpers
// 显示链路: 后端 nodes → nodesToShortText → 含 @ 短格式字符串 → MentionTextarea 自动 chip 化
// 回写链路: 用户改完字符串 → plainTextToNodes(ctx) → nodes → patchShot 写后端 (主真理源)
import { nodesToShortText, plainTextToNodes } from "../../../../../packages/drama/src/shotText";
import {
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { labelOfSource, hasSourceLabel, isKeylessImageProvider } from "../../lib/sourceLabels";
// 2026-07-22 Y7 (UP-8 收线): 视频成本预告需要跟 useVideoGeneration.trigger 内部
// needsConfirm 同一口径判定"是不是会扣费的真实 provider" — W10 删过顶栏 CTA 顺手删了这个
// import, 现补回(仅用于 PromptReviewModal 成本预告一行, 不涉及旧 CTA)。
import { isRealVideoProvider } from "../../lib/providerKind";
// W11 A4: 候选名字单一真理源 — fallback 顺序统一
import { candidateDisplayLabel } from "../../components/shared/CandidateLabel";
import { useTaskByShot, useTasksForShot, useTasksStore } from "../../stores/tasksStore";

// 2026-05-28 audit P1: 类型 guard helper — 替代旧代码里对 err 的 any 强转读 .code 写法
function getErrCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.code === "string") return e.code;
    if (e.body && typeof e.body === "object") {
      const bodyCode = (e.body as Record<string, unknown>).code;
      if (typeof bodyCode === "string") return bodyCode;
    }
  }
  return undefined;
}
import { useClipboardPaste } from "../../hooks/useClipboardPaste";
// P1 #17 (2026-05-21): JSX 拆 6 section
import {
  ShotStageHeader,
  ShotPromptColumn,
  FirstFrameColumn,
  VideoColumn,
  RejectPoolSection,
  ShotStageModals,
  type RejectTier,
} from "./sections";

type StageDetail = ShotDetail & { frame_anchors?: FrameAnchor[]; reference_notes?: Record<string, string> };

type Draft = {
  title: string;
  action: string;
  dialogue: string;
  voiceover: string;
  prompt_img: string;
  prompt_vid: string;
  /**
   * 2026-05-27 — 负向词 / 排除内容. orchestrator 真读这字段发模型, 之前用户在
   * 创作页改不了 (Draft 没字段 + PatchShot zod 没列), 等于死字段 — 现在打通.
   */
  negative_prompt: string;
  notes: string;
  duration_sec: number;
  shot_type: string;
  camera_movement: string;
  style: string;
  time_of_day: string;
  lighting: string;
  mood: string;
  emotion: string;
  transition_in: string;
  tts_voice_override: string;
  scene_id: string;
  character_ids: string[];
  element_ids: string[];
  reference_asset_ids: string[];
  reference_notes: Record<string, string>;
  /**
   * 2026-05-19 Wave O Entity-first Case B: 单镜级 reference 图 override.
   * 当用户在 ReferenceOverridePanel 给某素材挑"本镜用第 N 张"时,
   * 写入这里; orchestrator 拼 reference_images 时用 image_id 那张代替默认 primary.
   */
  reference_overrides: Array<{ element_id: string; image_id: string }>;
  /**
   * 2026-05-26 W2 组合性 — 本镜显式选的服装造型 element id (kind=wardrobe).
   * "" 代表走角色默认 (character.wardrobe_element_ids[0]); 显式指定时优先级最高.
   */
  wardrobe_id: string;
  /**
   * 2026-05-26 W2 组合性 — 本镜额外出现的道具 element id 列表 (kind=prop).
   * 与 character.prop_element_ids union 后才是本镜真实出现道具集.
   */
  prop_ids: string[];
  image_model_ref: string | null;
  video_model_ref: string | null;
};

// 2026-05-27 audit P2 #41: inpaintState 死字段, ShotStageModals interface 还要求.
// 走单例引用 (不会触发 React re-render). 真 InpaintCanvas 走 RegenModal 'inpaint' tab.
const EMPTY_INPAINT_STATE: { open: boolean; vaultId: string; sourceUrl: string } = {
  open: false, vaultId: "", sourceUrl: "",
};

const EMPTY_DRAFT: Draft = {
  title: "", action: "", dialogue: "", voiceover: "", prompt_img: "", prompt_vid: "",
  negative_prompt: "",
  notes: "", duration_sec: 5, shot_type: "", camera_movement: "", style: "",
  time_of_day: "", lighting: "", mood: "",
  emotion: "", transition_in: "", tts_voice_override: "",
  scene_id: "", character_ids: [],
  element_ids: [], reference_asset_ids: [], reference_notes: {},
  reference_overrides: [],
  wardrobe_id: "", prop_ids: [],
  image_model_ref: null, video_model_ref: null,
};

// 2026-05-17 精修: 删本地 REAL_VIDEO_PROVIDER_IDS + isLikelyRealVideoRef,改用 lib/providerKind.isRealVideoProvider
// (原本地列表写死 5 个 provider,漏了 jimeng_video_3_720p,导致 720p 真实视频不弹二次确认 — 顺手修真 bug)
// P1 #17: 各类选项 / preset 常量已下沉到对应 section 子组件
// 2026-05-28 P2#46: modelRefOrUndefined 抽到 lib/modelRef.ts (跟 FirstFrameColumn /
// VideoColumn 复用同一份实现, 避免三处本地拷贝不一致)
import { modelRefOrUndefined } from "../../lib/modelRef";

function buildDraft(shot?: Shot, detail?: StageDetail | null): Draft {
  const params = (detail?.params ?? {}) as Record<string, any>;
  // 2026-05-21 Wave Y P5 — 优先用 *_nodes 字段 derive 含 @ 短格式字符串给编辑器,
  // 没 nodes (老数据未 migrate / 用户手敲) 走老 plain text 字段兜底.
  // MentionTextarea 内部 parser 拿到 @ 短格式自动 chip 化, 不需要改它本身.
  //
  // 2026-05-22 修 race: 优先 detail 的 *_nodes (stage endpoint 已返), 再 fallback shot 的.
  // 之前只读 shot.*_nodes (useShots SWR), sourceShot 加载晚于 detail → 第一次 buildDraft
  // shot=undefined → actionFromNodes="" → fallback detail.action (plain text 无 @)
  // → MentionTextarea value 是 plain text → chip 不渲染. 用 detail nodes 优先消除依赖.
  const actionFromNodes = nodesToShortText(detail?.action_nodes) || nodesToShortText(shot?.action_nodes);
  const dialogueFromNodes = nodesToShortText(detail?.dialogue_nodes) || nodesToShortText(shot?.dialogue_nodes);
  const voiceoverFromNodes = nodesToShortText(detail?.voiceover_nodes) || nodesToShortText(shot?.voiceover_nodes);
  const promptImgFromNodes = nodesToShortText(detail?.prompt_img_nodes) || nodesToShortText(shot?.prompt_img_nodes);
  const promptVidFromNodes = nodesToShortText(detail?.prompt_vid_nodes) || nodesToShortText(shot?.prompt_vid_nodes);
  return {
    ...EMPTY_DRAFT,
    title: detail?.title || shot?.title || `分镜 ${shot?.index ?? ""}`,
    action: actionFromNodes || detail?.action || shot?.action || shot?.action_description || "",
    dialogue: dialogueFromNodes || detail?.dialogue || shot?.dialogue || "",
    voiceover: voiceoverFromNodes || detail?.voiceover || shot?.voiceover || "",
    prompt_img: promptImgFromNodes || detail?.prompt || shot?.prompt_img || "",
    prompt_vid: promptVidFromNodes || detail?.motion_prompt || shot?.prompt_vid || "",
    negative_prompt: String(detail?.negative_prompt ?? shot?.negative_prompt ?? ""),
    notes: detail?.notes || shot?.notes || "",
    duration_sec: Number(params.duration_sec ?? shot?.duration_sec ?? 5),
    shot_type: String(params.shot_type ?? shot?.shot_type ?? ""),
    camera_movement: String(params.camera_movement ?? shot?.camera_movement ?? ""),
    style: String(params.style ?? shot?.style ?? ""),
    time_of_day: String(params.time_of_day ?? shot?.time_of_day ?? ""),
    lighting: String(params.lighting ?? shot?.lighting ?? ""),
    mood: String(params.mood ?? shot?.mood ?? ""),
    emotion: String(params.emotion ?? shot?.emotion ?? ""),
    transition_in: String(params.transition_in ?? shot?.transition_in ?? ""),
    tts_voice_override: String((params.tts_voice_override ?? (shot as { tts_voice_override?: string } | undefined)?.tts_voice_override) ?? ""),
    scene_id: detail?.scene_id || shot?.scene_id || "",
    character_ids: detail?.character_ids || shot?.character_ids || [],
    element_ids: detail?.element_ids || shot?.element_ids || [],
    reference_asset_ids: detail?.reference_asset_ids || shot?.reference_asset_ids || [],
    reference_notes: detail?.reference_notes ?? {},
    reference_overrides: shot?.reference_overrides ?? [],
    // 2026-05-26 W2 组合性 — 单镜服装/独立道具
    wardrobe_id: shot?.wardrobe_id ?? "",
    prop_ids: shot?.prop_ids ?? [],
    image_model_ref: String(params.image_model_ref ?? shot?.image_model_ref ?? "") || null,
    video_model_ref: String(params.video_model_ref ?? shot?.video_model_ref ?? "") || null,
  };
}

// 2026-05-17 P1.1: candidateThumb helper 已删除 — 唯一 caller 是 inline 废案库,迁到 RejectPoolStrip 后不需要.

// W7: 候选→lightbox metadata(经 labelOfSource 翻译,绝不暴露技术字段)
// W11 A4: 用 candidateDisplayLabel 统一 — display_name > provider > "—" 兜底
function lightboxMetadataForCandidate(c: ShotCandidate): {
  provider?: string; time?: string; cost_cny?: number; seed?: number; duration_sec?: number;
} {
  // 老 lightbox 字段叫 "provider" 但展示的是给用户看的标签 (含 display_name 优先)
  const label = candidateDisplayLabel(c);
  return {
    provider: label === "—" ? undefined : label,
    time: c.created_at,
    cost_cny: typeof c.cost_cny === "number" ? c.cost_cny : undefined,
    seed: typeof c.seed === "number" ? c.seed : undefined,
    duration_sec: c.type === "video" && typeof c.duration_sec === "number" ? c.duration_sec : undefined,
  };
}

// W7: lightbox 状态(kind+src+meta)
type LightboxState = {
  open: boolean;
  src: string;
  kind: "image" | "video";
  metadata?: { provider?: string; time?: string; cost_cny?: number; seed?: number; duration_sec?: number };
};
const EMPTY_LIGHTBOX: LightboxState = { open: false, src: "", kind: "image" };

export default function ShotStageRoute() {
  const { slug, epId, shotId } = useParams();
  return <ShotStagePage key={JSON.stringify([slug, epId, shotId])} />;
}

function ShotStagePage() {
  const { slug = "", epId = "", shotId = "" } = useParams();
  const navigateRouter = useNavigate();
  const navigationSaveRef = useRef<null | (() => Promise<boolean>)>(null);
  const navigate = useCallback(async (to: string | number) => {
    if (navigationSaveRef.current && !await navigationSaveRef.current()) return;
    if (typeof to === "number") navigateRouter(to); else navigateRouter(to);
  }, [navigateRouter]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const candidateImportRef = useRef<HTMLInputElement | null>(null);
  const imageModelPickerRef = useRef<HTMLDivElement | null>(null);
  const videoModelPickerRef = useRef<HTMLDivElement | null>(null);

  const { shots, refresh: refreshShots } = useShots(slug, epId);
  const sourceShot = useMemo(() => shots.find((s) => s.id === shotId), [shots, shotId]);
  const { data: characters = [] } = useCharacters(slug);
  const { data: scenes = [] } = useScenes(slug);
  // 2026-05-18 用户原话"出境素材应该同步素材管理里设置的主图":
  //   characters / scenes 接口已有 primary_ref_image_id (asset_id 字符串),
  //   这里转成 LibraryConnectPanel 能直接 <img src={url}> 渲染的 thumbnail URL.
  //   后端 /api/v2/series/:slug/assets/:asset_id/thumbnail?size=N 是标准缩略图端点.
  // Wave Z-10: Character/Scene = ElementData, 主图走 primary_image_id (原 primary_ref_image_id)
  // 2026-05-26 修 "未链接素材不显示主图" — 用户根本没主动设过主图(primary_image_id 为空),
  // 但素材库已有 typical 代表图. fallback 找 typical 图 / 第一张 image 当封面, 跟素材库 grid 行为一致.
  // BUG-29 fix: 用 useCallback 包裹，避免 useMemo deps 引用不稳定
  const pickEntityCoverUrl = useCallback((
    entity: {
      primary_image_id?: string | null;
      images?: Array<{ image_id?: string; asset_id?: string; vault_id?: string; is_typical?: boolean }>;
    },
  ): string | undefined => {
    if (!slug) return undefined;
    if (entity.primary_image_id) {
      return imageThumbUrl(slug, { asset_id: entity.primary_image_id ?? "" });
    }
    const imgs = entity.images ?? [];
    if (imgs.length === 0) return undefined;
    const cover = imgs.find((i) => i.is_typical) ?? imgs[0];
    if (cover?.vault_id) return imageThumbUrl(slug, { vault_id: cover.vault_id });
    if (cover?.asset_id) return imageThumbUrl(slug, { asset_id: cover.asset_id });
    if (cover?.image_id) return imageThumbUrl(slug, { asset_id: cover.image_id });
    return undefined;
  }, [slug]);
  const charactersWithPrimary = useMemo(
    () => characters.map((c) => ({ ...c, primary_image_url: pickEntityCoverUrl(c) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [characters, slug],
  );
  const scenesWithPrimary = useMemo(
    () => scenes.map((s) => ({ ...s, primary_image_url: pickEntityCoverUrl(s) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scenes, slug],
  );
  // 2026-05-17 voice-sync v1: 系列默认 TTS provider 给 VoiceSelector 过滤声线列表
  const { data: seriesData } = useSeries(slug);
  const seriesTtsProviderId = seriesData?.defaults?.tts_provider_id || "edge_tts";
  // 2026-05-22 — 用户原话: "这部剧的比例是什么, 视频、图片缩略图的比例就是什么".
  // 把 series.defaults.aspect_ratio ("16:9"/"9:16"/"1:1"/"4:3"/"21:9") → CSS aspectRatio.
  // 所有候选 tile (FirstFrameTile / VideoCandidateTile / ImportTile / Placeholder /
  // WaitingModel / FailedTask) 都用这个值, 不再写死 16/9.
  const tileAspectRatio = useMemo(
    () => seriesAspectToCss(seriesData?.defaults?.aspect_ratio, "16/9"),
    [seriesData?.defaults?.aspect_ratio],
  );

  // W7: 当前镜在分镜列表中的位置 → 前/后镜按钮
  const orderedShots = useMemo(
    () => [...shots].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
    [shots],
  );
  const currentIdx = orderedShots.findIndex((s) => s.id === shotId);
  const prevShot = currentIdx > 0 ? orderedShots[currentIdx - 1] : undefined;
  const nextShot = currentIdx >= 0 && currentIdx < orderedShots.length - 1
    ? orderedShots[currentIdx + 1] : undefined;

  // 2026-05-27 audit P0 #2 — confirm hook 给 generation hooks 注入页面级二级确认
  const confirm = useConfirm();

  const [detail, setDetail] = useState<StageDetail | null>(null);
  const [elements, setElements] = useState<ElementData[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // W7: lightbox 状态
  const [lightbox, setLightbox] = useState<LightboxState>(EMPTY_LIGHTBOX);
  const openLightbox = useCallback((s: LightboxState) => setLightbox({ ...s, open: true }), []);
  const closeLightbox = useCallback(() => setLightbox((s) => ({ ...s, open: false })), []);

  // W7: ModelPicker 高亮态(校验失败时短暂高亮)
  const [imagePickerHighlight, setImagePickerHighlight] = useState(false);
  const [videoPickerHighlight, setVideoPickerHighlight] = useState(false);

  // 2026-05-27 — AI 助手"插入到本镜"中转 banner
  // AIAssistantPanel.applyToShot 会写 localStorage["ai-suggestion-for:<slug>:<ep>:<shotId>"]
  // 这里 mount + 路由切换时检测一次, 把待应用建议显示成顶部 banner, 用户点"追加"才真改 draft.action.
  // 不直接 patch — 让用户保留控制权 + 真"追加"而非覆盖.
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  useEffect(() => {
    if (!slug || !epId || !shotId) return;
    try {
      const key = `ai-suggestion-for:${slug}:${epId}:${shotId}`;
      const raw = window.localStorage?.getItem(key);
      if (!raw) { setAiSuggestion(null); return; }
      const parsed = JSON.parse(raw) as { content?: string; ts?: number };
      const content = typeof parsed?.content === "string" ? parsed.content.trim() : "";
      if (content) setAiSuggestion(content);
      else setAiSuggestion(null);
    } catch {
      setAiSuggestion(null);
    }
  }, [slug, epId, shotId]);
  const dismissAiSuggestion = useCallback(() => {
    if (!slug || !epId || !shotId) return;
    try {
      const key = `ai-suggestion-for:${slug}:${epId}:${shotId}`;
      window.localStorage?.removeItem(key);
    } catch { /* noop */ }
    setAiSuggestion(null);
  }, [slug, epId, shotId]);

  // 任务状态 — 从 store 派生(SSE 推送的真实状态)
  // 2026-05-28 P0#12: 传 slug 防跨 series shotId 污染 (新 series 复用 shot_001
  // 会拿到老 series 的 task → 进度卡 / 错误消息串台)
  const imageTask = useTaskByShot(shotId, "image", slug);
  const videoTask = useTaskByShot(shotId, "video", slug);
  // W7-cand-ux (2026-05-15): 全量 task 列表 — 用于在候选区直接渲染失败/运行中占位
  const shotTasks = useTasksForShot(shotId, slug);
  const removeTask = useTasksStore((s) => s.removeTask);
  // 2026-05-17: backend task prefetch 已上移到 App.tsx 顶层 (一次拉全部页面共享),
  // 这里不再各自 fetch — 走 useTasksForShot 派生 store, store 由 App 顶层 + SSE 共同填充.

  // ── Wave 4-C: 统一 image / video generation hook (mode=async) ──────────
  // 注意: 这两个 hook 的 target.target_id 是 shotId — 在路由参数不变时稳定。
  // hook 内部通过 SSE buildTaskEventHandlers 自动监听 task.done 并调 onSuccess。
  // onSuccess → refreshAll 刷新候选区，让真实图片落盘后立即显示。
  // onError 在 hook 声明时引用 highlightImagePicker/handleDrawFirstFrame 等函数,
  // 这些都是 function 声明(hoist)，可以安全前向引用。
  // 2026-05-27 audit P0 #2: 之前两个 hook 都没传 confirmFn, 默认 Promise.resolve(true)
  // 直接放行真实 provider 弹窗. hook 注释 line 2014 说"内部做 dry-run + 二级确认, 用户不会
  // 误扣费", 完全相反. 注入 useConfirm + navigate 让 hook 真能弹页面级 modal.
  const generationConfirmFn = useCallback(async (message: string): Promise<boolean> => {
    // UP-4: 免费/本地渠道确认门绝不出现"扣费"字样. buildCostMessage (useImageGeneration)
    // 对免费渠道产出的 message 含"不计费"标记 → 用中性标题/按钮; 付费渠道 (真实视频 /
    // 需 Key 的图像) 才保留"费用/扣费"叙述. 免费视频渠道压根不进本确认门 (见 useVideoGeneration
    // isRealVideoProvider), 故这里只需照顾免费首帧图像批量分支.
    const isFree = message.includes("不计费");
    return confirm({
      title: isFree ? "确认生成" : "确认费用与扣费",
      description: message,
      confirmLabel: isFree ? "确认生成" : "确认扣费生成",
      cancelLabel: "取消",
      variant: isFree ? "default" : "warning",
    });
  }, [confirm]);
  const goSettingsFn = useCallback(() => { navigate("/settings"); }, [navigate]);

  const imageGenHook = useImageGeneration({
    target: {
      kind: "shot_first_frame",
      series_slug: slug,
      target_id: shotId,
      meta: { ep_id: epId },
    },
    mode: "async",
    onSuccess: () => { void refreshAfterTaskDone(); },
    onError: (err) => {
      const code = getErrCode(err);
      if (code === "provider_not_selected" || code === "model_required") {
        highlightImagePicker();
      } else {
        showErrorToastWithActions(err, "抽首帧失败", () => handleDrawFirstFrame());
      }
    },
    confirmFn: generationConfirmFn,
    onGoSettings: goSettingsFn,
    displayName: draft.title || `分镜 ${sourceShot?.index ?? ""}`,
  });

  const videoGenHook = useVideoGeneration({
    target: {
      kind: "shot_video",
      series_slug: slug,
      target_id: shotId,
      meta: { ep_id: epId },
    },
    mode: "async",
    onSuccess: () => { void refreshAfterTaskDone(); },
    onError: (err) => {
      const code = getErrCode(err);
      if (code === "provider_not_selected" || code === "model_required") {
        highlightVideoPicker();
      } else {
        showErrorToastWithActions(err, "生成视频失败", () => handleGenerateVideo());
      }
    },
    confirmFn: generationConfirmFn,
    onGoSettings: goSettingsFn,
    displayName: draft.title || `分镜 ${sourceShot?.index ?? ""}`,
  });

  // Wave 4-C: imageBusy / videoBusy 扩展 — 同时监听 hook 的 generating/awaiting
  // (旧的 busy === "firstframe" / busy === "video" 已删, setBusy 只剩 upload/regen/etc)
  const imageBusy =
    imageGenHook.generating || imageGenHook.awaiting ||
    !!(imageTask && (imageTask.status === "queued" || imageTask.status === "running"));
  const videoBusy =
    videoGenHook.generating || videoGenHook.awaiting ||
    !!(videoTask && (videoTask.status === "queued" || videoTask.status === "running"));

  // W7-sse-fix (2026-05-15): SSE 收 task.done 时, GlobalQueuePanel 已经 markShotDirty(shotId).
  // ShotStagePage detail 不走 SWR (是手动 setState), 所以 SWR mutate 对它无效.
  // 这里订阅 dirtyShotKeys, 看到自己 shotId 进列表立即 refreshAll + 清 dirty 标记.
  const dirtyShotKeys = useTasksStore((s) => s.dirtyShotKeys);
  const clearDirtyShot = useTasksStore((s) => s.clearDirtyShot);

  // W7-cand-ux: "点击瞬间到 generate API 返回真 task_id 之间"的网络窗口骨架卡
  //   - 用本地 state 避免引入"local-XXX 假 task_id"(W7-stuck-fix 教训:那种假 task_id
  //     后端不识别 → SSE 永不命中 → UI 卡死)
  //   - 数据仅存在于"点了 Draw → 后端 200 返回前"几百毫秒,返回后立即清掉,
  //     之后由 store 的真实 task 接管(running → done/failed)
  const [localPendingDraws, setLocalPendingDraws] = useState<{ image: number; video: number }>({ image: 0, video: 0 });

  // W7-cand-ux: 候选卡 i2i 微调重抽 modal
  // 2026-05-17 合并: vaultId 让 RegenModal 局部 tab 启用 (合二为一,删独立"局部重抽"按钮)
  // W11 A5 (2026-05-27): defaultTab 让"画笔局部修改"入口直接进 inpaint, 不藏在二级 tab
  const [regenModal, setRegenModal] = useState<{
    open: boolean;
    cid: string;
    sourceUrl: string;
    sourceLabel?: string;
    promptPreview?: string;
    /** 2026-05-27 P1-1 — 真 negative 预览, 之前 RegenModal 内硬塞 ""(违反铁律 #13) */
    negativePromptPreview?: string;
    vaultId?: string;
    defaultTab?: "i2i" | "inpaint";
  }>({ open: false, cid: "", sourceUrl: "" });
  const [videoRegenCandidate, setVideoRegenCandidate] = useState<ShotCandidate | null>(null);

  // W8-BC (2026-05-16): 键盘 UI focus picked + 候选对比 + 局部重抽
  // picked* = 当前 UI 高亮/选中的候选 id(用于键盘 R/U/Space/Enter 锚定),
  // 与"已批准的 first frame anchor / picked_video" 不同 — 这是临时焦点
  const [pickedFirstId, setPickedFirstId] = useState<string | null>(null);
  const [pickedVideoId, setPickedVideoId] = useState<string | null>(null);
  const [compareSelection, setCompareSelection] = useState<string[]>([]);
  const [compareModalOpen, setCompareModalOpen] = useState(false);
  const [inpaintState, setInpaintState] = useState<{ open: boolean; vaultId: string; sourceUrl: string }>({
    open: false, vaultId: "", sourceUrl: "",
  });

  // 用户铁律: 一键抽卡默认 1 张 (避免大批量误触, 用户可随时改成 2/3/5/10)
  const [drawCount, setDrawCount] = useState(1);
  const [videoCount, setVideoCount] = useState(1);
  // 2026-05-18: ChatGPT 风格生成框 — 用户补充意见(可 @ 召唤). 本地 state, 不进 draft.
  //   handleDrawFirstFrame / handleGenerateVideo 时拼到 prompt 末尾 [用户补充] 段.
  //   image / video 两套独立 state, 因为两个候选区独立操作.
  const [imageExtraInstruction, setImageExtraInstruction] = useState("");
  const [videoExtraInstruction, setVideoExtraInstruction] = useState("");

  // 2026-05-27 — 用户在 PromptPreviewBlock 全文模式编辑过的 prompt override.
  // null = 用户没改, 走默认拼接; string = 用 override 替代默认拼接抽卡.
  // 用户原话: "能不能点击按钮切换结构化前端展示和完整文本两种提示词呢? 也不能手动修改微调".
  // 之前要打开 PromptReviewModal 才能改, 现在常驻预览块直接切到全文模式就能改.
  const [imagePromptOverride, setImagePromptOverride] = useState<string | null>(null);
  const [videoPromptOverride, setVideoPromptOverride] = useState<string | null>(null);

  // W7: 拼接预览跟踪的 kind — 不再依赖 stage tab(已删除),用本地状态切换
  const [previewKind, setPreviewKind] = useState<"image" | "video">("image");

  // 常驻提示词预览
  const [livePreview, setLivePreview] = useState<PromptPreview | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  // 2026-05-22: 双 kind cache — 当前 previewKind 走主 livePreview, 另一 kind 后台预拉,
  // 让 openVideoReview / openImageReview 弹窗时秒命中, 不再 "加载完整提示词中..." 卡死.
  // 用户原话: "为什么要点了才生成? 应该早就自动随着参数更新吗?"
  const [previewCache, setPreviewCache] = useState<{ image?: PromptPreview; video?: PromptPreview }>({});

  // 提示词审核弹窗
  const [videoReviewOpen, setVideoReviewOpen] = useState(false);
  const [videoReviewLoading, setVideoReviewLoading] = useState(false);
  const [videoReviewPrompt, setVideoReviewPrompt] = useState("");
  const [videoReviewNegative, setVideoReviewNegative] = useState("");
  const [videoReviewSegments, setVideoReviewSegments] = useState<PromptPreview["segments"]>([]);
  // 2026-05-17: video review 也带参考图 (i2v 首帧 + 手选 @ refs + 系统建议)
  // 用户原话"复制提示词界面就应该有这个功能" — 直接发 ChatGPT 复用
  const [videoReviewImplicitRefs, setVideoReviewImplicitRefs] = useState<ImplicitReferenceItem[]>([]);
  const [videoReviewManualRefs, setVideoReviewManualRefs] = useState<Array<{ url: string; label: string }>>([]);
  // 2026-05-18: 首帧 review 同款加 manualRefs — 之前只 set implicitRefs, 用户 @ 召唤的额外
  //   reference 图和已生成的同 shot 候选作 i2i 参考都没显示, 复制走外部 AI 时图不全.
  const [imageReviewManualRefs, setImageReviewManualRefs] = useState<Array<{ url: string; label: string }>>([]);

  const [imageReviewOpen, setImageReviewOpen] = useState(false);
  const [imageReviewLoading, setImageReviewLoading] = useState(false);
  const [imageReviewPrompt, setImageReviewPrompt] = useState("");
  const [imageReviewNegative, setImageReviewNegative] = useState("");
  const [imageReviewSegments, setImageReviewSegments] = useState<PromptPreview["segments"]>([]);
  // Wave B-2 (2026-05-16): 系统建议的隐式参考图(角色/场景/素材主图) — 用户可单张取消.
  // 默认全部 active=true; 触发生图时只把 active 的 asset_id 与手选 reference_asset_ids 合并.
  const [imageReviewImplicitRefs, setImageReviewImplicitRefs] = useState<ImplicitReferenceItem[]>([]);

  // 2026-07-22 Y7 (UP-8 收线): 审核弹窗成本预告一行 — PromptReviewModal 的 costPreview prop
  // (Y6 已就绪) 接线. 免费渠道零网络请求同步给静态文案; 付费渠道复用 imageGenHook.dryRun /
  // videoGenHook.dryRun (与 handleDrawFirstFrame/handleGenerateVideo 内 count>=2 或真实视频
  // 触发的确认门同一个函数, 不新造预估公式) 异步拿真实预估. null = 不显示这一行.
  const [imageCostPreview, setImageCostPreview] = useState<string | null>(null);
  const [videoCostPreview, setVideoCostPreview] = useState<string | null>(null);

  // 2026-05-27 — P0 stale bug: 用户开过 PromptReviewModal 后, imageReviewImplicitRefs /
  // videoReviewImplicitRefs 保留 modal 内的勾选状态. 但若用户随后在 LibraryConnectPanel
  // 加了新角色/场景, 没人刷新这俩 state, 快速抽卡走 stale list → 新角色 implicit ref
  // silent skip ("加了林深为啥生图还是原来那个人").
  //
  // 修: 监听 character_ids / scene_id / element_ids / reference_asset_ids /
  //     wardrobe_id / prop_ids 任一变化, 清空 implicitRefs, 让下次抽卡走 fresh
  //     livePreview.suggested_references fallback (handleGenerateXxx 内分支已有).
  // BUG-32 fix: 用 JSON.stringify 替代 join(",") 比较数组，更健壮
  useEffect(() => {
    setImageReviewImplicitRefs([]);
    setVideoReviewImplicitRefs([]);
  }, [
    JSON.stringify(sourceShot?.character_ids ?? []),
    sourceShot?.scene_id ?? "",
    JSON.stringify(sourceShot?.element_ids ?? []),
    JSON.stringify(sourceShot?.reference_asset_ids ?? []),
    sourceShot?.wardrobe_id ?? "",
    JSON.stringify(sourceShot?.prop_ids ?? []),
  ]);

  // 三级废案库再抽微调输入
  const [rejectTuneMap, setRejectTuneMap] = useState<Record<string, string>>({});
  // 2026-05-17: 废案库 媒体类型 tab 状态 ("all" | "image" | "video"). 用户要求"图像/视频不要混"
  const [rejectMediaType, setRejectMediaType] = useState<"all" | "image" | "video">("all");
  function setTuneFor(id: string, text: string) {
    setRejectTuneMap((m) => ({ ...m, [id]: text }));
  }

  const [rejectTier, setRejectTier] = useState<RejectTier>("shot");
  const [projectPool, setProjectPool] = useState<RejectPoolItem[]>([]);
  const [publicPool, setPublicPool] = useState<RejectPoolItem[]>([]);

  const [failures, setFailures] = useState<ShotFailure[]>([]);
  // W11 A7: askText 输入框已删 — 问 AI 走 ComposeBox 的"只问不抽" toggle. askAnswer 仍在左栏底部显示.
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // D-P1 (2026-06-01): AI 润色提示词状态
  const [polishBusy, setPolishBusy] = useState(false);
  const [polishModalOpen, setPolishModalOpen] = useState(false);
  const [polishResult, setPolishResult] = useState<string>("");
  const [polishError, setPolishError] = useState<string | null>(null);

  // 2026-05-29 P0 修复(跨分镜状态泄漏): 路由 <Route shot-stage/:epId/:shotId> 无 key,
  //   仅 :shotId 变化时 React 复用同一 ShotStagePage 实例 (不 remount)。下列"当前镜临时
  //   编辑态"必须按 shotId 显式重置, 否则 A 镜在全文模式改过的 prompt / 补充意见, 切到 B 镜
  //   点抽卡会被 `?? imagePromptOverride` silent 套用 (B 镜画面描述被忽略, 无提示),
  //   违反 UX 铁律 #5(真实保存) / #7(标准创作语义) / #12(批改+发送一致)。
  //   注意: drawCount / videoCount 是批量抽卡偏好, 故意跨镜延续, 不在此重置。
  useEffect(() => {
    setImagePromptOverride(null);
    setVideoPromptOverride(null);
    setImageExtraInstruction("");
    setVideoExtraInstruction("");
    setPreviewCache({});
    setAskAnswer(null);
    setPolishModalOpen(false);
    setPolishResult("");
    setPolishError(null);
  }, [shotId]);

  // ── derived ──────────────────────────────────────────────────
  // 2026-05-27 — 必须 useMemo 稳定: 之前 inline `?? []` 每次 render 都 new 空数组,
  // 导致下面 firstFrameCandidates useMemo deps 引用每次变, useEffect (line ~708)
  // 监听 firstFrameCandidates 反复 trigger setCompareSelection → "Maximum update
  // depth exceeded". 加 useMemo + 内容稳定的 sentinel.
  const firstFrameCandidatesRaw = useMemo(
    () => (detail?.first_frame_candidates ?? sourceShot?.first_frame_candidates ?? []) as ShotCandidate[],
    [detail?.first_frame_candidates, sourceShot?.first_frame_candidates],
  );
  const videoCandidatesRaw = useMemo(
    () => (detail?.video_candidates ?? sourceShot?.video_candidates ?? []) as ShotCandidate[],
    [detail?.video_candidates, sourceShot?.video_candidates],
  );
  const trashedCandidates = useMemo(
    () => (detail?.trashed_candidates ?? sourceShot?.trashed_candidates ?? []) as ShotCandidate[],
    [detail?.trashed_candidates, sourceShot?.trashed_candidates],
  );

  // 2026-05-27 — 已锚定 / 已选用的素材排前面 (用户原话: "设为首帧/关键帧/尾帧/选用的
  // 素材要放在前面"). 候选数组保持引用稳定 (useMemo) 让下游 useEffect / SWR mutate
  // 不无脑重渲染. 排序优先级:
  //   firstFrame: isFirst > isKey(按 position) > isEnd > 其他 (原顺序, 后端按生成时间)
  //   video: isPicked > 其他 (原顺序)
  // Hotkey 1-9 选第 N 张候选会跟着新顺序走, 用户按 1 直接选锚定/已选用的素材 — 更直觉.
  const pickedVideoIdResolved = (detail?.picked_video_id ?? sourceShot?.picked_video_id) ?? undefined;
  const firstFrameCandidates = useMemo(() => {
    const _anchors = detail?.frame_anchors ?? [];
    const _first = _anchors.find((a) => a.role === "first");
    const _end = _anchors.find((a) => a.role === "end");
    const _keys = _anchors.filter((a) => a.role === "key").sort((a, b) => a.position - b.position);
    const isAnchorMatch = (a: FrameAnchor | undefined, c: ShotCandidate) =>
      !!a && (a.generation_id === c.id || a.vault_id === c.vault_id);
    const isFirst = (c: ShotCandidate) =>
      isAnchorMatch(_first, c) || (detail?.picked_first_frame_id ?? "") === c.id;
    const isEnd = (c: ShotCandidate) => isAnchorMatch(_end, c);
    const keyPosition = (c: ShotCandidate): number => {
      for (let i = 0; i < _keys.length; i++) {
        if (isAnchorMatch(_keys[i], c)) return i;
      }
      return -1;
    };
    const score = (c: ShotCandidate): number => {
      if (isFirst(c)) return 0;            // 0 = 最前
      const k = keyPosition(c);
      if (k >= 0) return 100 + k;          // 100..199 关键帧按 position
      if (isEnd(c)) return 500;            // 尾帧
      return 1000;                          // 普通候选
    };
    return [...firstFrameCandidatesRaw].sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sa !== sb) return sa - sb;
      return 0; // 同分保持原顺序 (stable sort)
    });
  }, [firstFrameCandidatesRaw, detail?.frame_anchors, detail?.picked_first_frame_id]);

  const videoCandidates = useMemo(() => {
    if (!pickedVideoIdResolved) return videoCandidatesRaw;
    return [...videoCandidatesRaw].sort((a, b) => {
      const aPicked = a.id === pickedVideoIdResolved ? 0 : 1;
      const bPicked = b.id === pickedVideoIdResolved ? 0 : 1;
      return aPicked - bPicked;
    });
  }, [videoCandidatesRaw, pickedVideoIdResolved]);

  // 2026-05-27 — 删 videoHistory 派生 (用户反馈"上下两套不顺畅"). 之前用来给
  // VideoColumn "视频历史" 条带渲染所有 active + trashed 视频缩略图, 让用户
  // 点缩略图切主视频. 现在条带删了, 唯一展示位是上方候选卡 (showing active 视频).
  // 想恢复废弃视频走右下角废案库; 想换主视频在候选卡上点 "选定".

  // 2026-05-17 P1.1: 把三 tier 数据 (trashedCandidates / projectPool / publicPool) 映射成 RejectItem[]
  // 供共享 RejectPoolStrip 渲染. itemActions 通过 lookup map 拿回原始数据做真实操作.
  type ShotRejectLookup =
    | { kind: "candidate"; candidate: ShotCandidate }
    | { kind: "pool"; item: RejectPoolItem };
  const { shotRejectItems, shotRejectLookup } = useMemo(() => {
    const lookup = new Map<string, ShotRejectLookup>();
    let items: RejectItem[] = [];
    if (rejectTier === "shot") {
      items = trashedCandidates.map((c) => {
        const vid = c.generation_id || c.id;
        lookup.set(vid, { kind: "candidate", candidate: c });
        return {
          vault_id: vid,
          kind: c.type === "video" ? "video" : "image",
          url: c.url,
          thumbnail: c.thumbnail || c.url,
          provider_id: c.provider,
          created_at: c.created_at,
          tags: [],
        } as RejectItem;
      });
    } else if (rejectTier === "project") {
      items = projectPool.map((it) => {
        lookup.set(it.vault_id, { kind: "pool", item: it });
        return {
          vault_id: it.vault_id,
          kind: it.kind,
          url: it.url,
          thumbnail: it.thumbnail || it.url,
          provider_id: it.provider_id,
          created_at: it.created_at,
          tags: it.tags ?? [],
        } as RejectItem;
      });
    } else {
      items = publicPool.map((it) => {
        lookup.set(it.vault_id, { kind: "pool", item: it });
        return {
          vault_id: it.vault_id,
          kind: it.kind,
          url: it.url,
          thumbnail: it.thumbnail || it.url,
          provider_id: it.provider_id,
          created_at: it.created_at,
          tags: it.tags ?? [],
        } as RejectItem;
      });
    }
    return { shotRejectItems: items, shotRejectLookup: lookup };
  }, [rejectTier, trashedCandidates, projectPool, publicPool]);

  // W7-cand-ux: 派生当前 shot 上"进行中"和"失败"的 image / video tasks(候选区直接显示占位/失败卡)
  const runningImageTasks = useMemo(
    () => shotTasks.filter((t) => t.kind === "image" && (t.status === "queued" || t.status === "running")),
    [shotTasks],
  );
  const runningVideoTasks = useMemo(
    () => shotTasks.filter((t) => t.kind === "video" && (t.status === "queued" || t.status === "running")),
    [shotTasks],
  );
  const failedImageTasks = useMemo(
    () => shotTasks.filter((t) => t.kind === "image" && t.status === "failed"),
    [shotTasks],
  );
  const failedVideoTasks = useMemo(
    () => shotTasks.filter((t) => t.kind === "video" && t.status === "failed"),
    [shotTasks],
  );
  const anchors = detail?.frame_anchors ?? [];
  const firstAnchor = anchors.find((a) => a.role === "first");
  const endAnchor = anchors.find((a) => a.role === "end");
  const keyAnchors = anchors.filter((a) => a.role === "key").sort((a, b) => a.position - b.position);

  const anchorCandidate = useCallback(
    (a?: FrameAnchor) => {
      if (!a) return undefined;
      return firstFrameCandidates.find((c) => c.id === a.generation_id || c.vault_id === a.vault_id);
    },
    [firstFrameCandidates],
  );

  // B-8: 自动挑卡 — 计算 quality_scores 均分最高的候选
  // 逻辑: (composition + sharpness + prompt_alignment + subject_completeness) / 4
  // 无评分候选算 0 分(不优先推荐)；仅在候选数 ≥ 2 且首帧锚点未锁定时激活
  const recommendedCandidateId = useMemo(() => {
    const scored = firstFrameCandidates.filter((c) => c.quality_scores);
    if (scored.length < 1) return null;
    if (firstFrameCandidates.length < 2) return null;
    const topCandidate = scored.reduce((best, c) => {
      const qs = c.quality_scores!;
      const avg =
        (qs.composition + qs.sharpness + qs.prompt_alignment + qs.subject_completeness) / 4;
      const bestQs = best.quality_scores!;
      const bestAvg =
        (bestQs.composition + bestQs.sharpness + bestQs.prompt_alignment + bestQs.subject_completeness) / 4;
      return avg > bestAvg ? c : best;
    });
    return topCandidate.id;
  }, [firstFrameCandidates]);

  const recommendedCandidate = useMemo(
    () =>
      recommendedCandidateId
        ? firstFrameCandidates.find((c) => c.id === recommendedCandidateId) ?? null
        : null,
    [firstFrameCandidates, recommendedCandidateId],
  );

  const autoPickTopScore = useMemo(() => {
    if (!recommendedCandidate?.quality_scores) return null;
    const qs = recommendedCandidate.quality_scores;
    return ((qs.composition + qs.sharpness + qs.prompt_alignment + qs.subject_completeness) / 4).toFixed(1);
  }, [recommendedCandidate]);

  // 首帧锚点索引(第几张, 1-based)
  const recommendedCandidateIndex = useMemo(() => {
    if (!recommendedCandidateId) return null;
    const idx = firstFrameCandidates.findIndex((c) => c.id === recommendedCandidateId);
    return idx >= 0 ? idx + 1 : null;
  }, [firstFrameCandidates, recommendedCandidateId]);
  const pickedVideo = videoCandidates.find((c) => c.id === (detail?.picked_video_id ?? sourceShot?.picked_video_id));

  // W8-BC: 候选变化时,如果当前 picked* id 不在列表里,清空(避免键盘锚错对象)
  useEffect(() => {
    if (pickedFirstId && !firstFrameCandidates.some((c) => c.id === pickedFirstId)) {
      setPickedFirstId(null);
    }
  }, [firstFrameCandidates, pickedFirstId]);
  useEffect(() => {
    if (pickedVideoId && !videoCandidates.some((c) => c.id === pickedVideoId)) {
      setPickedVideoId(null);
    }
  }, [videoCandidates, pickedVideoId]);
  // W8-BC: 候选区选择(对比用)— 候选变了过滤掉已不存在的 id
  //
  // 2026-05-27 修死循环: prev.filter(...) 即使内容相同也返新数组, setState 触发
  // re-render. firstFrameCandidates 是 useMemo, detail SWR refetch 后引用每次变 →
  // useEffect 跑 → setCompareSelection 新数组 → re-render → firstFrameCandidates
  // 又重算 → 死循环. 加内容比较: 过滤后元素 ids 跟原相同就返 prev (引用不变).
  useEffect(() => {
    setCompareSelection((sel) => {
      const next = sel.filter((id) => firstFrameCandidates.some((c) => c.id === id));
      if (next.length === sel.length) return sel; // 内容没变, 返原引用阻断 re-render
      return next;
    });
  }, [firstFrameCandidates]);

  // ── load ─────────────────────────────────────────────────────
  // 2026-05-17: 加 opts.silent + opts.candidatesOnly 让视频/首帧落盘后只刷候选区,
  // 不触发 setLoading=true (整个组件树进 loading 态) + 不覆盖 draft (吞用户输入).
  // 默认行为(初次 mount / 切 shot)仍走 full refresh.
  // 2026-05-27 — sourceShotRef: 用 ref 抓最新 sourceShot, 不让它出现在 refreshDetail
  // useCallback deps 里. 之前 deps 含 sourceShot → useShots SWR refetch 时 sourceShot
  // 引用变 → refreshDetail identity 变 → 下方 useEffect (依赖 refreshDetail) 触发,
  // 跑 refreshDetail() 无 opts → silent=false → setLoading(true) + setDetail 整页 re-render
  // → 用户看到"状态更新落盘时整页强制刷新". 改成 ref 后 SWR mutate 不再触发 detail
  // 重 fetch, ShotStagePage 自己的 dirtyShotKeys useEffect 单独跑 silent candidates-only.
  const sourceShotRef = useRef(sourceShot);
  useEffect(() => { sourceShotRef.current = sourceShot; }, [sourceShot]);

  const refreshDetail = useCallback(async (opts?: { silent?: boolean; candidatesOnly?: boolean }) => {
    if (!slug || !epId || !shotId) return;
    const silent = opts?.silent === true;
    const candidatesOnly = opts?.candidatesOnly === true;
    if (!silent) setLoading(true);
    try {
      const res = await getScopedShotDetail(slug, epId, shotId);
      if (!isNotImplemented(res)) {
        const detailRes = res as StageDetail;
        if (candidatesOnly) {
          // 只 patch 候选相关字段 (前端 DTO 字段名), 不动 draft / 不重建 buildDraft
          setDetail((prev) => prev ? ({
            ...prev,
            first_frame_candidates: detailRes.first_frame_candidates,
            video_candidates: detailRes.video_candidates,
            trashed_candidates: detailRes.trashed_candidates,
            frame_anchors: detailRes.frame_anchors,
            picked_first_frame_id: detailRes.picked_first_frame_id,
            picked_video_id: detailRes.picked_video_id,
            status: detailRes.status,
          }) : detailRes);
        } else {
          setDetail(detailRes);
          // 2026-05-18 bug 修复: SSE 触发图片落盘等单 shot 刷新时, buildDraft 会用 sourceShot
          //   (来自 useShots 列表 SWR cache, SSE 单 shot 事件不刷列表 cache) 兜底
          //   image_model_ref / video_model_ref. 用户刚选的 model_ref 还没回流到 sourceShot
          //   → buildDraft 拿到 stale 空值 → ModelPicker 被重置为未选状态.
          //
          // 修法: 用户偏好类字段 (image_model_ref / video_model_ref) 不被 SSE 刷新擦掉,
          //   保留 prev draft 的值. 这两个字段是 "用户的选择", 不是 "从 server 拉的状态".
          setDraft((prev) => {
            const fresh = buildDraft(sourceShotRef.current, detailRes);
            return {
              ...fresh,
              image_model_ref: prev?.image_model_ref ?? fresh.image_model_ref,
              video_model_ref: prev?.video_model_ref ?? fresh.video_model_ref,
            };
          });
          setDirty(false);
        }
      }
    } catch (err) {
      if (!silent) showErrorToast(err, "分镜详情加载失败");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [slug, epId, shotId]);

  useEffect(() => { void refreshDetail(); }, [refreshDetail]);

  useEffect(() => {
    if (!slug) return;
    let alive = true;
    listElements(slug)
      .then((res) => {
        if (!alive) return;
        setElements(res.elements.filter((el) => el.kind !== "character" && el.kind !== "scene"));
      })
      .catch(() => {
        if (alive) setElements([]);
      });
    return () => { alive = false; };
  }, [slug]);

  useEffect(() => {
    // 2026-05-18: 与 refreshDetail 同款 — image/video_model_ref 保留 prev (用户偏好不被覆盖).
    // 此处仅在 !detail 初次兜底时跑, prev 通常是 EMPTY_DRAFT, 加保护防未来改动踩坑.
    // 2026-05-27 audit Agent#1 P1 #30: buildDraft 走 sourceShotRef.current 而不是 sourceShot
    // 本帧值, 避免 setDraft 回调内引用 stale closure (sourceShot 在 useShots SWR 间隙可能
    // 是过期版本, ref 保最新; 跟上面 refreshDetail 同款做法).
    if (!detail && sourceShotRef.current) {
      setDraft((prev) => {
        const fresh = buildDraft(sourceShotRef.current, null);
        return {
          ...fresh,
          image_model_ref: prev?.image_model_ref ?? fresh.image_model_ref,
          video_model_ref: prev?.video_model_ref ?? fresh.video_model_ref,
        };
      });
    }
  }, [detail, sourceShot]);

  // A response from an earlier shot (or a page being unloaded) must not update this view.
  const auxiliaryScope = useRef<object | null>(null);
  useEffect(() => {
    auxiliaryScope.current = {};
    setFailures([]);
    const deactivate = () => { auxiliaryScope.current = null; };
    window.addEventListener("pagehide", deactivate);
    return () => {
      deactivate();
      window.removeEventListener("pagehide", deactivate);
    };
  }, [slug, epId, shotId]);

  const refreshFailures = useCallback(async () => {
    if (!shotId) return;
    const scope = auxiliaryScope.current;
    try {
      // 2026-05-26 walkthrough fix: shotId 不全局唯一, 必须传 slug+epId 显式定位.
      const res = await listShotFailures(shotId, slug ?? undefined, epId ?? undefined);
      if (scope && auxiliaryScope.current === scope && !isNotImplemented(res)) setFailures(res.failures ?? []);
    } catch (err) {
      if (!scope || auxiliaryScope.current !== scope) return;
      // 2026-05-27 audit P0 #11: 之前 catch 静默, 用户看不到失败列表刷新失败.
      // 改 console.error 留 trace + toast 提示, 但不阻塞主流量.
      console.error("[refreshFailures] 加载失败列表失败:", err);
    }
  }, [shotId, slug, epId]);
  useEffect(() => { void refreshFailures(); }, [refreshFailures]);

  const refreshPools = useCallback(async () => {
    if (!slug) return;
    const scope = auxiliaryScope.current;
    try {
      const [proj, pub] = await Promise.all([
        listRejectPool("project", slug),
        listRejectPool("public"),
      ]);
      if (!scope || auxiliaryScope.current !== scope) return;
      setProjectPool(proj.items ?? []);
      setPublicPool(pub.items ?? []);
    } catch (err) {
      if (!scope || auxiliaryScope.current !== scope) return;
      console.error("[refreshPools] 加载废案库失败:", err);
    }
  }, [slug]);
  useEffect(() => { void refreshPools(); }, [refreshPools]);

  async function refreshAll() {
    await Promise.all([refreshShots(), refreshDetail(), refreshFailures(), refreshPools()]);
  }

  // 2026-05-17: 任务完成专用 silent refresh — 只更新候选区数据, 不动 loading/draft/scroll
  // 用户原话"视频素材落盘后页面会自动刷新,能不能不自动刷新整个界面,只刷新素材".
  //
  // 2026-05-18 修复: 之前还调 refreshShots() (= SWR mutate 不传参 = 重 fetch 整个 shots
  //   列表) → sourceShot useMemo 依赖 shots 引用 → 引用变 → sourceShot 重算 → 树大面积
  //   re-render. 用户感受到"整页刷新"就是这条线.
  //   候选区显示用 (detail?.first_frame_candidates ?? sourceShot?.first_frame_candidates ?? [])
  //   detail 优先 sourceShot 兜底, 所以只刷 detail.candidates 就足够 — sourceShot 保持 stale
  //   不影响候选区显示, 只是 ShotboardPage 列表那边的缩略图旧, 用户切回去能看到 fresh.
  const refreshAfterTaskDone = useCallback(async () => {
    await refreshDetail({ silent: true, candidatesOnly: true });
  }, [refreshDetail]);

  // W7-sse-fix: SSE 推 task.done → tasksStore.dirtyShotKeys 加我的 shotId → silent refresh 候选区.
  useEffect(() => {
    if (!shotId) return;
    if (dirtyShotKeys.includes(shotId)) {
      void refreshAfterTaskDone();
      clearDirtyShot(shotId);
    }
  }, [dirtyShotKeys, shotId, clearDirtyShot, refreshAfterTaskDone]);

  // 2026-05-18 bug 修复: image/video_model_ref 改动后 debounce 1s 自动 patchShot 到后端.
  //   之前 ensureSaved 只在用户点生成按钮时触发, 用户改 ModelPicker 后没点按钮就走开,
  //   model_ref 只活在 React state. SSE 刷新时 sourceShot.video_model_ref 还是 stale 空值
  //   → buildDraft 拿空 → 用户偏好被擦. 加 autosave 让 model_ref 立即真存到后端.
  //   单独 useEffect 而非塞进 ensureSaved 链路, 避免每次小输入都 patch (其他字段在生成时
  //   ensureSaved 跑一次就够).
  useEffect(() => {
    if (!slug || !epId || !shotId) return;
    if (!draft.image_model_ref && !draft.video_model_ref) return;
    // 与从 server 拉的当前值一致就跳过(避免初次挂载就触发一次无意义 PATCH)
    // 2026-05-28 audit P1: params 是 Record<string, unknown>, 用 typeof === string guard
    // 替代旧代码里把 params 强转后读 .image_model_ref 的写法.
    const paramImg = detail?.params?.image_model_ref;
    const paramVid = detail?.params?.video_model_ref;
    const serverImg = (typeof paramImg === "string" ? paramImg : null) ?? sourceShot?.image_model_ref ?? null;
    const serverVid = (typeof paramVid === "string" ? paramVid : null) ?? sourceShot?.video_model_ref ?? null;
    if (
      (draft.image_model_ref || null) === (serverImg || null) &&
      (draft.video_model_ref || null) === (serverVid || null)
    ) return;
    const timer = setTimeout(() => {
      void patchShot(slug, epId, shotId, {
        image_model_ref: draft.image_model_ref || undefined,
        video_model_ref: draft.video_model_ref || undefined,
      } as Partial<Shot>).catch((e) => /* 后台日志: model_ref 自动保存失败, 下次打开页面可能恢复旧值, 非关键路径无需 toast */ console.warn("[ShotStagePage] model_ref autosave failed:", e));
    }, 1000);
    return () => clearTimeout(timer);
  }, [slug, epId, shotId, draft.image_model_ref, draft.video_model_ref, detail, sourceShot]);


  // 常驻预览 — draft / previewKind 变化时 debounce 250ms 自动调 prompt-preview
  // 2026-05-22: 主 previewKind 走 livePreview, 另一 kind 后台并行预拉缓存到 previewCache,
  // 让 modal 弹窗瞬间命中 (用户原话 "应该早就自动随着参数更新").
  useEffect(() => {
    if (!slug || !epId || !shotId) return;
    let cancelled = false;
    setLiveLoading(true);
    const otherKind: "image" | "video" = previewKind === "image" ? "video" : "image";
    const timer = setTimeout(async () => {
      try {
        const [resMain, resOther] = await Promise.all([
          getPromptPreview(slug, epId, shotId, previewKind),
          getPromptPreview(slug, epId, shotId, otherKind).catch(() => null),
        ]);
        if (cancelled) return;
        setLivePreview(resMain);
        setPreviewCache((prev) => ({
          ...prev,
          [previewKind]: resMain,
          ...(resOther ? { [otherKind]: resOther } : {}),
        }));
      } catch (err) {
        if (!cancelled) showErrorToast(err, "提示词预览加载失败");
      } finally {
        if (!cancelled) setLiveLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    slug, epId, shotId, previewKind,
    draft.action, draft.dialogue, draft.voiceover, draft.notes,
    draft.shot_type, draft.camera_movement, draft.style,
    draft.time_of_day, draft.lighting, draft.mood, draft.duration_sec,
    draft.scene_id, draft.character_ids.join(","), draft.element_ids.join(","),
    draft.reference_asset_ids.join(","),
  ]);

  // ── draft mutations ──────────────────────────────────────────
  function updateDraft(patch: Partial<Draft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }

  // 2026-05-27 — 应用 AI 助手暂存的"插入到本镜"建议
  // 行为: 追加到 draft.action 末尾(不覆盖) + 标记 dirty + 自动 toast + 清掉 banner
  const appendAiSuggestion = useCallback(() => {
    if (!aiSuggestion) return;
    setDraft((prev) => {
      const base = (prev.action ?? "").trim();
      const next = base ? `${base}\n\n${aiSuggestion}` : aiSuggestion;
      return { ...prev, action: next };
    });
    setDirty(true);
    toast.success("已追加到画面描述, 记得点保存");
    dismissAiSuggestion();
  }, [aiSuggestion, dismissAiSuggestion]);

  // 2026-05-21 Wave Y P6 — 编辑回写链路: 用户改完字符串后调 plainTextToNodes 转 nodes,
  // 5 个文本字段都跟 nodes 双写, 后端读 nodes 作真理源, plain text 字段作 derived 兼容.
  // mentionCtx 用 characters/scenes/elements 列表反查 entity_id, 让 nodes.mention.entity_id 正确填.
  const mentionCtx = useMemo(() => ({
    characters: characters.map((c) => ({ name: c.name, id: c.id })),
    scenes: scenes.map((s) => ({ name: s.name, id: s.id })),
    elements: elements.map((el) => ({ name: el.name, id: el.id })),
  }), [characters, scenes, elements]);

  // 2026-05-28 深度打磨 #5 — undo history stack.
  // 用户痛点: ShotStagePage 实时 autosave, 用户改坏 prompt 后没"撤销" — 必须手动重打,
  // 或回 trashedCandidates 找老候选 (但 candidates 不是文本字段, 撤不了 prompt 改动).
  // 改法: 每次 autosave 成功前先 push 当前 (即"上一次干净状态") 到 historyStack,
  //       最多保留 10 个 snapshot, 顶栏出"撤销" 按钮 (pop + setDraft + saveDraft).
  // 不依赖后端 history — 这是会话级 undo, 完全本地. 刷新页面后 stack 清空, 视为"重新开始".
  type DraftSnapshot = { draft: Draft; savedAt: number; label: string };
  const historyStackRef = useRef<DraftSnapshot[]>([]);
  const [historyDepth, setHistoryDepth] = useState(0);  // re-render trigger 让顶栏"撤销"按钮的可用态正确

  // useAsyncAction 接管 busy + 错误 toast — onSuccess 内做 dirty/lastSavedAt 状态更新
  const saveAction = useAsyncAction(
    async () => {
      if (!slug || !epId || !shotId) return;
      // P6: 5 个文本字段同步 parse 出 nodes 写后端 (主真理源)
      const actionNodes = plainTextToNodes(draft.action || "", mentionCtx);
      const dialogueNodes = plainTextToNodes(draft.dialogue || "", mentionCtx);
      const voiceoverNodes = plainTextToNodes(draft.voiceover || "", mentionCtx);
      const promptImgNodes = plainTextToNodes(draft.prompt_img || "", mentionCtx);
      const promptVidNodes = plainTextToNodes(draft.prompt_vid || "", mentionCtx);
      await patchShot(slug, epId, shotId, {
        title: draft.title,
        action: draft.action,
        dialogue: draft.dialogue,
        voiceover: draft.voiceover,
        prompt_img: draft.prompt_img,
        prompt_vid: draft.prompt_vid,
        negative_prompt: draft.negative_prompt || undefined,
        action_nodes: actionNodes,
        dialogue_nodes: dialogueNodes,
        voiceover_nodes: voiceoverNodes,
        prompt_img_nodes: promptImgNodes,
        prompt_vid_nodes: promptVidNodes,
        notes: draft.notes,
        duration_sec: draft.duration_sec,
        shot_type: draft.shot_type,
        camera_movement: draft.camera_movement,
        style: draft.style,
        time_of_day: draft.time_of_day,
        lighting: draft.lighting,
        mood: draft.mood,
        emotion: draft.emotion,
        transition_in: draft.transition_in,
        tts_voice_override: draft.tts_voice_override || undefined,
        scene_id: draft.scene_id || undefined,
        character_ids: draft.character_ids,
        element_ids: draft.element_ids,
        reference_asset_ids: draft.reference_asset_ids,
        reference_notes: draft.reference_notes,
        reference_overrides: draft.reference_overrides,
        // 2026-05-26 W2 组合性 — 落服装/独立道具
        wardrobe_id: draft.wardrobe_id || undefined,
        prop_ids: draft.prop_ids,
        image_model_ref: draft.image_model_ref || undefined,
        video_model_ref: draft.video_model_ref || undefined,
      } as Partial<Shot>);
      await refreshShots();
      await refreshDetail();
      return true;
    },
    {
      errorMessage: "保存分镜失败",
      onSuccess: () => {
        setDirty(false);
        setLastSavedAt(Date.now());
        toast.success("分镜已保存");
      },
    },
  );
  const saving = saveAction.busy;
  navigationSaveRef.current = async () => !dirty || (await saveAction.run()) === true;
  async function saveDraft() {
    if (await saveAction.run() !== true) throw new Error("分镜尚未保存成功，请稍后重试");
  }

  async function ensureSaved() {
    if (dirty) await saveDraft();
  }

  // 2026-05-27 audit Agent#1 P0 #4: 全字段 autosave (debounce 1.5s) — 修用户原话铁律 #5 状态精确
  // 之前只有 model_ref autosave, 用户改画面描述 / 对白 / 旁白等任何 draft 字段, 点上一镜/下一镜
  // 直接路由切, 所有文本改动丢失. header 删了 "保存" 按钮假装"自动同步" → 虚假承诺.
  // 现在加 dirty 判定 + debounce 1.5s 自动调 saveAction.run().
  // 注意: 跟 ensureSaved 链路并存 — 生成按钮触发的是 ensureSaved 立刻 flush, autosave 是兜底.
  //
  // 2026-05-28 深度打磨 #5: autosave 触发前 push 当前"上一次干净版" 进 historyStack.
  // 用 lastCleanDraftRef 跟踪上一次 saveAction 成功时的 draft 副本 — 那就是用户"撤销"
  // 想回到的版本. 每次 dirty=false (autosave 落盘) 更新这个 ref + push 进 stack.
  const saveActionRef = useRef(saveAction);
  useEffect(() => { saveActionRef.current = saveAction; }, [saveAction]);
  const lastCleanDraftRef = useRef<Draft | null>(null);
  // 初次 detail 加载完成时, 把 draft 当作起点 (不进 stack, 单独存为"baseline")
  useEffect(() => {
    if (!lastCleanDraftRef.current && detail && !loading) {
      lastCleanDraftRef.current = { ...draft };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, loading]);
  useEffect(() => {
    if (!slug || !epId || !shotId) return;
    if (!dirty) return;
    const timer = setTimeout(() => {
      // 触发 autosave — 之前 push 上一次干净版进 stack (用户"撤销"会回到这里)
      const baseline = lastCleanDraftRef.current;
      if (baseline) {
        historyStackRef.current.push({
          draft: baseline,
          savedAt: lastSavedAt ?? Date.now(),
          label: baseline.title || `第 ${sourceShot?.index ?? "?"} 镜`,
        });
        // 限 10 条 — 超出 shift 旧的
        if (historyStackRef.current.length > 10) historyStackRef.current.shift();
        setHistoryDepth(historyStackRef.current.length);
      }
      void saveActionRef.current.run().then(() => {
        // autosave 成功 → 这次 draft 变成新的"上一次干净版"
        lastCleanDraftRef.current = { ...draft };
      }).catch((e) => {
        console.warn("[ShotStagePage] draft autosave failed:", e);
      });
    }, 1500);
    return () => clearTimeout(timer);
  // BUG-22 fix: 移除 draft 整体（已包含个别字段），减少不必要的 effect 重触发
  }, [slug, epId, shotId, dirty, draft.action, draft.dialogue, draft.voiceover, draft.notes, draft.title, draft.prompt_img, draft.prompt_vid, draft.negative_prompt, lastSavedAt, sourceShot?.index]);

  // 撤销最近一次 autosave — pop stack + setDraft + 触发新一轮 autosave 落盘
  const handleUndoLastSave = useCallback(() => {
    const top = historyStackRef.current.pop();
    if (!top) return;
    setHistoryDepth(historyStackRef.current.length);
    setDraft(top.draft);
    setDirty(true);  // 触发 autosave 把"撤销后的版本" 真存盘
    toast.success("已撤销最近一次保存", {
      description: `回到 ${top.label} 的上一版本, 1.5 秒后自动落盘`,
      duration: 4000,
    });
  }, []);

  // W7: 实时显示保存状态(几秒前)
  const savedRelText = useMemo(() => {
    if (saving) return "保存中...";
    if (dirty) return "未保存";
    if (!lastSavedAt) return "已同步";
    const secs = Math.max(0, Math.floor((Date.now() - lastSavedAt) / 1000));
    if (secs < 5) return "刚刚已保存";
    if (secs < 60) return `已保存 ${secs}s 前`;
    return "已同步";
  }, [saving, dirty, lastSavedAt]);

  // 提示词审核弹窗
  // W7-regen-fix: 加 extraInstruction 参数 — 从 RegenModal "查看完整提示词" 调用时,
  // 把用户填写的修改意见拼到 prompt 末尾显示,让 PromptReviewModal 真同步用户输入
  async function openImageReview(extraInstruction?: string) {
    if (!slug || !epId || !shotId) return;
    setImageReviewOpen(true);
    const extra = (extraInstruction || "").trim();
    // 2026-05-22: 用 previewCache.image 秒打开 (用户原话: "应该早就自动随着参数更新")
    const cached = previewCache.image;
    if (cached) {
      const base = cached.composed_prompt || "";
      const merged = extra ? `${base}\n\n[此图作 i2i 参考 · 修改意见]\n${extra}` : base;
      setImageReviewPrompt(merged);
      setImageReviewNegative(cached.negative_prompt || "");
      setImageReviewSegments(cached.segments || []);
      // Y7 UP-8: 有缓存 → 秒给成本预告(免费静态文案 / 付费用缓存 prompt 先估一版, 下方 fetch 完再用新鲜数据兜底刷新)
      void refreshImageCostPreview(merged);
    } else {
      setImageReviewLoading(true);
      // Y7 UP-8: 无缓存时 prompt 还没就绪 — 免费渠道不需要 prompt 也能判定, 付费渠道
      // 先占位"预估费用中…", 避免对空提示词发注定 400 的 dry-run 请求 (同源 UP-4(b) 教训).
      void refreshImageCostPreview("");
    }
    try {
      await ensureSaved();
      const res = await getPromptPreview(slug, epId, shotId, "image");
      setPreviewCache((prev) => ({ ...prev, image: res }));
      const base = res.composed_prompt || "";
      const merged = extra
        ? `${base}\n\n[此图作 i2i 参考 · 修改意见]\n${extra}`
        : base;
      setImageReviewPrompt(merged);
      setImageReviewNegative(res.negative_prompt || "");
      setImageReviewSegments(res.segments || []);

      // 2026-05-18 用户原话"复制完整提示词时, 所有涉及到的图片素材都要一起放在界面".
      //   收集所有会发给生图模型的 manual refs (用户主动选定 + i2i base + 跨 shot 引用).
      const manualImages: Array<{ url: string; label: string }> = [];
      // 1. 用户 @ 召唤的 reference_asset_ids — 永远发送
      for (const aid of draft.reference_asset_ids ?? []) {
        const c = firstFrameCandidates.find((c) => c.vault_id === aid || c.asset_id === aid);
        const el = elements.flatMap((e) => e.images.map((img) => ({ ...img, parent: e })))
          .find((img) => img.asset_id === aid || img.vault_id === aid);
        const url = c?.url || el?.url;
        const label = c
          ? `用户参考图 · ${labelOfSource(c.provider)}`
          : el
            ? `素材图 · ${el.parent.name}`
            : "未命名参考图";
        if (url) manualImages.push({ url, label });
      }
      // 2. extraInstruction (RegenModal 进入时, 当前点击的源图就是 i2i base — 应作首要参考)
      //    这部分留给 RegenModal 调用方在 extraInstruction 里描述, 不在此函数自动加;
      //    如果有需要 caller 应通过 reference_asset_ids 显式塞入.
      setImageReviewManualRefs(manualImages);

      // Wave B-2: 从 preview 拿建议参考图, 排除用户已经手选的(避免重复显示).
      // 默认全部 active=true — 用户在 modal 内可逐张取消.
      const suggested = res.suggested_references ?? [];
      const manualSet = new Set(draft.reference_asset_ids);
      const implicitItems: ImplicitReferenceItem[] = suggested
        .filter((s: SuggestedReference) => !manualSet.has(s.asset_id))
        .map((s: SuggestedReference) => ({
          asset_id: s.asset_id,
          url: s.url,
          label: s.label,
          source: s.source,
          source_name: s.source_name,
          active: true,
        }));
      setImageReviewImplicitRefs(implicitItems);
      // Y7 UP-8: 用新鲜 prompt 再刷一次成本预告(免费幂等重设同一文案; 付费用最新数据修正/首次估价).
      void refreshImageCostPreview(merged);
    } catch (err) {
      setImageReviewOpen(false);
      showErrorToastWithActions(err, "拉取首帧提示词预览失败");
    } finally {
      setImageReviewLoading(false);
    }
  }

  // 2026-05-20 P2: 加 extraInstruction 参数 — ComposeBox 的用户补充意见需合并进 modal 显示的 prompt.
  // 2026-05-22: 用 previewCache.video 秒打开, 不再"加载完整提示词中..." 卡白屏. fetch 在后台
  // refresh, 避免 ensureSaved/network 慢用户看着干等. 用户原话"为什么要点了才生成".
  async function openVideoReview(extraInstruction?: string) {
    if (!slug || !epId || !shotId) return;
    setVideoReviewOpen(true);
    const extra = (extraInstruction || "").trim();
    const cached = previewCache.video;
    if (cached) {
      const base = cached.composed_prompt || "";
      const merged = extra ? `${base}\n\n[用户补充]\n${extra}` : base;
      setVideoReviewPrompt(merged);
      setVideoReviewNegative(cached.negative_prompt || "");
      setVideoReviewSegments(cached.segments || []);
      // 不 setVideoReviewLoading(true), modal 立刻可读
      // Y7 UP-8: 有缓存 → 秒给成本预告, 下方 fetch 完再用新鲜数据兜底刷新.
      void refreshVideoCostPreview(merged);
    } else {
      setVideoReviewLoading(true);
      // Y7 UP-8: 无缓存时先占位, 避免对空提示词发注定 400 的 dry-run 请求.
      void refreshVideoCostPreview("");
    }
    try {
      await ensureSaved();
      const res = await getPromptPreview(slug, epId, shotId, "video");
      setPreviewCache((prev) => ({ ...prev, video: res }));
      const base = res.composed_prompt || "";
      const merged = extra ? `${base}\n\n[用户补充]\n${extra}` : base;
      setVideoReviewPrompt(merged);
      setVideoReviewNegative(res.negative_prompt || "");
      setVideoReviewSegments(res.segments || []);

      // 2026-05-17: 收集视频 review 所有参考图给"复制提示词 + 图"用
      // 2026-05-18 bug 修复: 之前只看 firstAnchor, 漏掉 endAnchor (尾帧) + keyAnchors (关键帧).
      //   用户原话"复制完整提示词时, 为什么没把首尾帧和选定的额外图片一起放在复制提示词界面".
      //   尾帧给 i2v end frame 锚定, 关键帧给中间锚定 (i2v_with_keyframes).
      // 优先级 1: picked first frame (i2v 关键输入, 明确标记 "图生视频首帧")
      // 优先级 2: picked end frame (尾帧锚定, i2v 进阶模式)
      // 优先级 3: key frames (关键帧锚定, 按 position 排序)
      // 优先级 4: 用户 @ 进来的 reference_asset_ids → manualRefs (永远发送)
      // 优先级 5: 系统建议 (角色/场景主图) → implicitRefs (可单张取消)
      const manualImages: Array<{ url: string; label: string }> = [];
      if (firstAnchor) {
        const ffCandidate = anchorCandidate(firstAnchor);
        if (ffCandidate?.url) {
          manualImages.push({
            url: ffCandidate.url,
            label: "图生视频首帧 (picked first frame)",
          });
        }
      }
      // 2026-05-18: 尾帧 — i2v 进阶模式 (Kling/Vidu 等真实 API 支持 first+end frame 锚定)
      if (endAnchor) {
        const efCandidate = anchorCandidate(endAnchor);
        if (efCandidate?.url) {
          manualImages.push({
            url: efCandidate.url,
            label: "图生视频尾帧 (picked end frame)",
          });
        }
      }
      // 2026-05-18: 关键帧 — 按 position 排序, 标签带位置便于外部 AI 理解中间锚定
      for (const ka of keyAnchors) {
        const kaCandidate = anchorCandidate(ka);
        if (kaCandidate?.url) {
          manualImages.push({
            url: kaCandidate.url,
            label: `关键帧 #${ka.position} (key frame)`,
          });
        }
      }
      // shot.reference_asset_ids — 用户 @ 进来的图
      for (const aid of draft.reference_asset_ids ?? []) {
        // 找出该 asset 的 URL — 从 firstFrameCandidates / elements 中匹配
        const c = firstFrameCandidates.find((c) => c.vault_id === aid || c.asset_id === aid);
        const el = elements.flatMap((e) => e.images.map((img) => ({ ...img, parent: e })))
          .find((img) => img.asset_id === aid || img.vault_id === aid);
        const url = c?.url || el?.url;
        const label = c
          ? `用户参考图 · ${labelOfSource(c.provider)}`
          : el
            ? `素材图 · ${el.parent.name}`
            : "未命名参考图";
        if (url) manualImages.push({ url, label });
      }
      setVideoReviewManualRefs(manualImages);

      // 系统建议 — 跟 image review 一样,排除手选
      const suggested = res.suggested_references ?? [];
      const manualSet = new Set(draft.reference_asset_ids);
      const implicitItems: ImplicitReferenceItem[] = suggested
        .filter((s: SuggestedReference) => !manualSet.has(s.asset_id))
        .map((s: SuggestedReference) => ({
          asset_id: s.asset_id,
          url: s.url,
          label: s.label,
          source: s.source,
          source_name: s.source_name,
          active: true,
        }));
      setVideoReviewImplicitRefs(implicitItems);
      // Y7 UP-8: 用新鲜 prompt 再刷一次成本预告.
      void refreshVideoCostPreview(merged);
    } catch (err) {
      setVideoReviewOpen(false);
      showErrorToastWithActions(err, "拉取视频提示词预览失败");
    } finally {
      setVideoReviewLoading(false);
    }
  }

  // 2026-07-22 Y7 (UP-8 收线): 首帧成本预告 — 免费渠道 (isKeylessImageProvider) 零网络
  // 请求同步给静态文案(跟确认门 generationConfirmFn 的免费判定同一套"不计费"措辞);
  // 付费渠道复用 imageGenHook.dryRun (与 handleDrawFirstFrame 内 count>=2 时触发确认门
  // 用的同一个函数, 不新造预估公式) 异步拿真实预估. 失败/无提示词时优雅占位, 不阻塞弹窗.
  async function refreshImageCostPreview(promptForEstimate: string) {
    const modelRef = modelRefOrUndefined(draft.image_model_ref);
    if (!modelRef) { setImageCostPreview(null); return; }
    if (isKeylessImageProvider(modelRef)) {
      setImageCostPreview("本地免费渠道 · 不计费");
      return;
    }
    if (!promptForEstimate.trim()) {
      // 提示词还没就绪(无缓存, 等 getPromptPreview fetch 回来后的第二次调用补上) — 先占位,
      // 不对空提示词发一个注定 400 的 dry-run 请求 (同源 UP-4(b) 教训).
      setImageCostPreview("预估费用中…");
      return;
    }
    setImageCostPreview("预估费用中…");
    try {
      const dr = await imageGenHook.dryRun({
        prompt: promptForEstimate,
        model_ref: modelRef,
        count: drawCount,
      });
      if (dr.error === "key_missing") {
        setImageCostPreview(dr.message || "该模型还没配置 API Key");
        return;
      }
      setImageCostPreview(
        dr.is_keyless
          ? "本地免费渠道 · 不计费"
          : dr.estimated_cost_cny != null
            ? `预估 ¥${dr.estimated_cost_cny.toFixed(4)} (${dr.estimated_cost_note})`
            : "预估费用未知, 确认生成时会重新计算",
      );
    } catch {
      setImageCostPreview("预估费用失败, 确认生成时会重新计算");
    }
  }

  // 视频成本预告 — 免费(mock/本地)判定跟 useVideoGeneration.trigger 内部 needsConfirm 用的
  // 同一个 isRealVideoProvider 函数(免费视频压根不进确认门, 这里同口径零网络请求同步判定);
  // 真实 provider 复用 videoGenHook.dryRun 拿同源预估.
  async function refreshVideoCostPreview(promptForEstimate: string) {
    const modelRef = modelRefOrUndefined(draft.video_model_ref);
    if (!modelRef) { setVideoCostPreview(null); return; }
    if (!isRealVideoProvider(modelRef)) {
      setVideoCostPreview("本地免费渠道 · 不计费");
      return;
    }
    if (!promptForEstimate.trim()) {
      setVideoCostPreview("预估费用中…");
      return;
    }
    setVideoCostPreview("预估费用中…");
    try {
      const dr = await videoGenHook.dryRun({
        prompt: promptForEstimate,
        model_ref: modelRef,
        duration_sec: draft.duration_sec,
        count: videoCount,
      });
      if (dr.error === "key_missing") {
        setVideoCostPreview(dr.message || "该模型还没配置 API Key");
        return;
      }
      if (dr.real_lock_held_by) {
        setVideoCostPreview(
          `真实视频锁被占用 (${labelOfSource(dr.real_lock_held_by.provider)} 生成中), 确认生成时会重新检查`,
        );
        return;
      }
      setVideoCostPreview(
        dr.estimated_cost_cny != null
          ? `预估费用 ¥${dr.estimated_cost_cny.toFixed(2)} · 真实视频渠道会扣费`
          : "预估费用未知, 确认生成时会重新计算",
      );
    } catch {
      setVideoCostPreview("预估费用失败, 确认生成时会重新计算");
    }
  }

  // W7: 高亮 ModelPicker(短暂 ring 提示)
  // BUG-21 fix: 用 useRef 存储 timer ID，避免内存泄漏
  const imagePickerTimerRef = useRef<number | null>(null);
  const videoPickerTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (imagePickerTimerRef.current !== null) clearTimeout(imagePickerTimerRef.current);
      if (videoPickerTimerRef.current !== null) clearTimeout(videoPickerTimerRef.current);
    };
  }, []);
  function highlightImagePicker() {
    setImagePickerHighlight(true);
    imageModelPickerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (imagePickerTimerRef.current !== null) clearTimeout(imagePickerTimerRef.current);
    imagePickerTimerRef.current = window.setTimeout(() => {
      setImagePickerHighlight(false);
      imagePickerTimerRef.current = null;
    }, 2200);
  }
  function highlightVideoPicker() {
    setVideoPickerHighlight(true);
    videoModelPickerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (videoPickerTimerRef.current !== null) clearTimeout(videoPickerTimerRef.current);
    videoPickerTimerRef.current = window.setTimeout(() => {
      setVideoPickerHighlight(false);
      videoPickerTimerRef.current = null;
    }, 2200);
  }

  // ── generate ─────────────────────────────────────────────────
  // Wave 4-C: 函数体改用 useImageGeneration hook trigger,
  //   不再直接调 generateScopedFirstFrame + 手动 registerTasksFromResponse。
  //   函数签名保持不变(供 DrawCardRow / PromptReviewModal onConfirm / keyboard hook 调用)。
  async function handleDrawFirstFrame(promptOverride?: string, extraInstruction?: string) {
    if (!slug || !epId || !shotId || imageBusy) return;
    // 2026-05-27 — 没显式传 promptOverride 时, 用户可能在 PromptPreviewBlock 全文模式
    // 改过 prompt → imagePromptOverride 有值. 自动接入, 不需要再开 modal 才能用.
    const effectivePromptOverride = promptOverride ?? imagePromptOverride ?? undefined;

    // W7-cand-ux: 未选模型 — 静默 highlight + 占位卡引导,不弹 toast (铁律#10)
    if (!modelRefOrUndefined(draft.image_model_ref)) {
      highlightImagePicker();
      return;
    }

    // W7-cand-ux: 点击瞬间塞 N 张本地骨架卡 — 让用户立刻看到"开始干活了"
    // 2026-05-28 P1#22: 拍 snapshot — 用户在 await 期间改 drawCount, finally 减
    // 的数不等于加的数 → 计数泄漏永不归零. await 内的所有调用也用 snapshot.
    const snapDrawCount = drawCount;
    setLocalPendingDraws((p) => ({ ...p, image: p.image + snapDrawCount }));
    try {
      await ensureSaved();
      // Wave B-2 (2026-05-16): 合并"用户手选的 reference_asset_ids" + "implicit refs (active=true)".
      //   - 用户手选永远优先(放在前面)
      //   - implicit refs 优先用 modal 内确认的状态; 若用户走快速抽卡(没开过 modal),
      //     用 livePreview.suggested_references 作 fallback (默认全部 active)
      //   - 去重(实际 asset_id 唯一)
      //   - 后端 imageGenerationService 接受 ≤8 张, 这里截断防止超限
      const manualSet = new Set(draft.reference_asset_ids);
      let implicitAssetIds: string[];
      if (imageReviewImplicitRefs.length > 0) {
        // 用户通过 modal 审核过 — 按用户选择
        implicitAssetIds = imageReviewImplicitRefs
          .filter((r) => r.active && !manualSet.has(r.asset_id))
          .map((r) => r.asset_id);
      } else {
        // 快速抽卡路径 — 用 livePreview 拿到的建议, 默认全部应用
        const live = previewKind === "image" ? (livePreview?.suggested_references ?? []) : [];
        implicitAssetIds = live
          .filter((s) => !manualSet.has(s.asset_id))
          .map((s) => s.asset_id);
      }
      const manualRefs = draft.reference_asset_ids.map((id) =>
        id.startsWith("asset_") ? ({ asset_id: id }) : ({ vault_id: id }),
      );
      const implicitRefs = implicitAssetIds.map((id) => ({ asset_id: id }));
      const mergedRefs = [...manualRefs, ...implicitRefs].slice(0, 8);
      // Wave 4-C: 用统一 hook trigger 替换直接 fetch。
      //   hook 内部: 调 scoped endpoint → registerTasksFromResponse → SSE onSuccess → refreshAll。
      //   promptOverride 有值时传 prompt; 无值时传空字符串让 hook 走后端默认 compiler。
      // 2026-05-18: ChatGPT 风格 ComposeBox 用户补充 (extraInstruction / imageExtraInstruction)
      //   优先级: promptOverride (review modal 编辑过) > base + [用户补充] > 空字符串(后端 compiler).
      const baseImg = draft.prompt_img || draft.action || draft.title || "";
      const extra = (extraInstruction ?? imageExtraInstruction).trim();
      const finalImagePrompt = effectivePromptOverride?.trim()
        || (extra ? `${baseImg}\n\n[用户补充]\n${extra}` : "");
      // UP-4(b): finalImagePrompt 为空时真实发送走后端 compiler(正确), 但 count≥2 触发的
      // dry-run 端点 Zod 校验 prompt.min(1) 会 400 让费用预估翻车 + 弹出恐吓文案.
      // 把已编译预览提示词(composed_prompt, 与后端 compileShotImagePrompt 同源)作 dry-run
      // 兜底估价, 真实发送 prompt 仍空、行为不变 — 预估与真实发送同源.
      await imageGenHook.trigger({
        prompt: finalImagePrompt,
        model_ref: modelRefOrUndefined(draft.image_model_ref),
        count: snapDrawCount,
        reference_images: mergedRefs.length > 0 ? mergedRefs : undefined,
        dryRunPromptOverride: getPreviewByKind("image")?.composed_prompt || undefined,
      });
    } catch {
      // 错误已由 hook 内部 toast + onError 回调处理
    } finally {
      setLocalPendingDraws((p) => ({ ...p, image: Math.max(0, p.image - snapDrawCount) }));
    }
  }

  // Wave 4-D: dry-run + 二级 confirm 已由 useVideoGeneration hook 内置 (真实 provider /
  // confirmRealVideo=true 自动触发, 默认开). caller 直接 trigger 即可获得费用确认 UX —
  // hook 内部判定 isRealVideoProvider(model_ref) → 跑 dryRun → 弹 confirmFn 显示
  // 费用 + 锁状态 + 真实 provider 警告; 用户取消 → trigger 返 null 不进入真实生成.
  //
  // 历史: Wave 4-C 接入 hook 但漏了 dry-run + confirm 流程, 导致 ShotStagePage 这种
  // 不渲染 VideoGenerationPanel 的 caller 出现真实视频"无 confirm 直接扣费"回归.
  // 正解是把 dry-run + confirm 下沉到 hook 层 (memory feedback_decoupling.md).
  //
  // i2v 首帧校验保留 (铁律 #5 真实保存).
  function buildFinalVideoPrompt(promptOverride?: string, extraInstruction?: string) {
    const baseMotion = (promptOverride ?? "").trim() || draft.prompt_vid || draft.action || draft.title;
    const extra = (extraInstruction ?? videoExtraInstruction).trim();
    return extra && !promptOverride ? `${baseMotion}\n\n[用户补充]\n${extra}` : baseMotion;
  }

  function firstFrameIdForVideoRequest(): string | undefined {
    if (!firstAnchor) return undefined;
    return firstAnchor.asset_id ?? firstAnchor.vault_id ?? firstAnchor.generation_id ?? undefined;
  }

  async function handleGenerateVideo(promptOverride?: string, extraInstruction?: string, sourceVideoGenerationId?: string) {
    if (!slug || !epId || !shotId || videoBusy) return;
    // 2026-05-27 — 没传 promptOverride 时, 用户可能在 PromptPreviewBlock 全文模式
    // 改过 video prompt → videoPromptOverride 有值. 自动接入.
    const effectivePromptOverride = promptOverride ?? videoPromptOverride ?? undefined;

    // W7-cand-ux: 未选模型 — 静默 highlight + 占位卡引导,不弹 toast (铁律#10)
    if (!modelRefOrUndefined(draft.video_model_ref)) {
      highlightVideoPicker();
      return;
    }

    // 2026-05-17: video_mode UI 删除 — 改为根据 firstAnchor 自动推断 (i2v vs t2v)
    // 用户原话: "是文生视频还是图生视频这个在创作时我自己勾选或者 at 用不用图就行了,没必要额外选一次"
    // 不再阻止抽视频:有 firstAnchor → 走 i2v(用 firstFrameRef);无 → 走 t2v(纯文字)

    // 2026-05-28 P1#22: 同 image — snapshot videoCount 防 await 期间 state 变化
    // 导致计数加/减不对称 → 永远显示 N 段进行中.
    const snapVideoCount = videoCount;
    setLocalPendingDraws((p) => ({ ...p, video: p.video + snapVideoCount }));
    try {
      await ensureSaved();

      // 2026-05-18: ChatGPT 风格 VideoComposeBox 的 user 补充意见拼到 motion_prompt
      //   优先级: promptOverride (review modal 编辑过) > 基础 motion + [用户补充]
      //   extraInstruction 优先于 state, caller 没传时 fallback 到 ShotStagePage 持有的
      //   videoExtraInstruction (从 VideoComposeBox 同步过来).
      const motion = buildFinalVideoPrompt(effectivePromptOverride, extraInstruction);
      const firstFrameRef = firstAnchor
        ? (firstAnchor.asset_id
            ? { asset_id: firstAnchor.asset_id }
            : firstAnchor.vault_id
            ? { vault_id: firstAnchor.vault_id }
            : firstAnchor.generation_id
            ? { asset_id: firstAnchor.generation_id }
            : undefined)
        : undefined;

      await videoGenHook.trigger({
        prompt: motion,
        model_ref: modelRefOrUndefined(draft.video_model_ref),
        duration_sec: draft.duration_sec,
        first_frame: firstFrameRef,
        source_video_generation_id: sourceVideoGenerationId?.trim() || undefined,
        // 2026-05-27 — videoCount 透传后端, 之前 "抽 N 段" 选择器是死的 (后端 count
        // 写死 1). 视频贵, 用户选 3 段只抽 1 段 = 三倍交付时间.
        count: snapVideoCount,
      });
    } catch {
      // 错误已由 hook 内部 toast + onError 回调处理
    } finally {
      setLocalPendingDraws((p) => ({ ...p, video: Math.max(0, p.video - snapVideoCount) }));
    }
  }

  // ── candidate / anchor actions ───────────────────────────────
  async function rejectCandidate(c: ShotCandidate) {
    try {
      const res = c.type === "video"
        ? await patchScopedVideoCandidate(slug, epId, shotId, c.id, "reject")
        : await patchScopedFirstFrameCandidate(slug, epId, shotId, c.id, "reject");
      if (isNotImplemented(res)) showErrorToast(res.reason);
      await refreshDetail();
    } catch (err) {
      showErrorToast(err, "废弃候选失败");
    }
  }

  async function restoreCandidate(c: ShotCandidate) {
    try {
      const res = c.type === "video"
        ? await patchScopedVideoCandidate(slug, epId, shotId, c.id, "restore")
        : await patchScopedFirstFrameCandidate(slug, epId, shotId, c.id, "restore");
      if (isNotImplemented(res)) showErrorToast(res.reason);
      await refreshDetail();
    } catch (err) {
      showErrorToast(err, "恢复候选失败");
    }
  }

  async function selectVideo(c: ShotCandidate) {
    try {
      const res = await patchScopedVideoCandidate(slug, epId, shotId, c.id, "select");
      if (isNotImplemented(res)) showErrorToast(res.reason);
      await refreshAll();
    } catch (err) {
      showErrorToast(err, "选定视频失败");
    }
  }

  // 2026-05-17: inline rename - 给候选起自定义名 (视频 + 首帧公用)
  async function renameCandidate(c: ShotCandidate, label: string) {
    const isVideo = c.type === "video";
    try {
      const res = isVideo
        ? await patchScopedVideoCandidate(slug, epId, shotId, c.id, "rename", undefined, label)
        : await patchScopedFirstFrameCandidate(slug, epId, shotId, c.id, "rename", undefined, label);
      if (isNotImplemented(res)) {
        showErrorToast(res.reason);
        return;
      }
      await refreshAll();
      toast.success(label ? `已重命名为 "${label}"` : "已恢复默认名");
    } catch (err) {
      showErrorToast(err, "重命名失败");
      throw err; // 让 InlineLabel 回退 draft
    }
  }

  async function applyAnchor(c: ShotCandidate, role: "first" | "end" | "key") {
    try {
      await setFrameAnchor(slug, epId, shotId, {
        role,
        position: role === "key" ? 0.5 : undefined,
        generation_id: c.generation_id || c.id,
        vault_id: c.vault_id,
        asset_id: c.asset_id,
      });
      toast.success(role === "first" ? "已设为首帧" : role === "end" ? "已设为尾帧" : "已加为关键帧");
      await refreshDetail();
    } catch (err) {
      showErrorToast(err, "设置帧锚点失败");
    }
  }

  // 2026-05-27 — handleSelectFromHistory 删 (条带删了, 没人调). 想选主视频走候选卡 "选定" 按钮 → selectVideo.

  // 2026-05-26 W8-D 兜底复制提示词 — 无需 modal 直接复制 livePreview.composed_prompt 到剪贴板
  // 2026-05-27 bugfix — 按 kind 取对应 preview, 不依赖 previewKind 当前选项 (避免串 kind).
  function getPreviewByKind(kind: "image" | "video"): PromptPreview | null {
    const cached = previewCache[kind];
    if (cached) return cached;
    if (livePreview?.kind === kind) return livePreview;
    return null;
  }
  function handleCopyImagePrompt() {
    const text = getPreviewByKind("image")?.composed_prompt || "";
    if (!text) {
      toast("图像提示词还没拼好, 请稍等或填一些画面描述", { icon: "ℹ️" });
      return;
    }
    navigator.clipboard?.writeText(text).then(
      () => toast.success("已复制图像提示词 — 可粘到 Midjourney / Runway / Kling 等任意 AI"),
      () => toast.error("复制失败"),
    );
  }
  function handleCopyVideoPrompt() {
    const text = getPreviewByKind("video")?.composed_prompt || "";
    if (!text) {
      toast("视频提示词还没拼好, 请稍等或填一些画面描述", { icon: "ℹ️" });
      return;
    }
    navigator.clipboard?.writeText(text).then(
      () => toast.success("已复制视频提示词 — 可粘到外部视频 AI"),
      () => toast.error("复制失败"),
    );
  }

  async function dropAnchor(anchorId: string) {
    try {
      await removeFrameAnchor(slug, epId, shotId, anchorId);
      await refreshDetail();
    } catch (err) {
      showErrorToast(err, "移除帧锚点失败");
    }
  }

  async function promote(c: ShotCandidate, target: "project" | "public") {
    try {
      await promoteToRejectPool(slug, epId, shotId, c.generation_id || c.id, target);
      toast.success(target === "project" ? "已升级到项目废案库" : "已升级到公共废案库");
      await refreshAll();
    } catch (err) {
      showErrorToast(err, "升级废案库失败");
    }
  }

  // W7-stage-reorg: 关键帧 chips 拖拽改顺序
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  async function handleKeyAnchorDragEnd(e: DragEndEvent) {
    if (!e.active || !e.over || e.active.id === e.over.id) return;
    const ids = keyAnchors.map((a) => a.id);
    const oldIdx = ids.indexOf(String(e.active.id));
    const newIdx = ids.indexOf(String(e.over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const newOrder = arrayMove(ids, oldIdx, newIdx);
    // 乐观更新: 立刻刷一个本地 detail(用新顺序 + 临时重算 position)避免拖完闪一下
    const repositioned = newOrder.map((id, i) => {
      const original = keyAnchors.find((a) => a.id === id)!;
      const n = newOrder.length;
      const pos = n === 1 ? 0.5 : 0.1 + (0.8 * i) / (n - 1);
      return { ...original, position: Math.round(pos * 1000) / 1000 };
    });
    setDetail((prev) => prev ? {
      ...prev,
      frame_anchors: [
        ...(prev.frame_anchors ?? []).filter((a) => a.role !== "key"),
        ...repositioned,
      ],
    } : prev);
    try {
      await reorderKeyAnchors(slug, epId, shotId, newOrder);
      toast.success("已调整关键帧顺序");
      // 后端写完拉一次保证一致
      await refreshDetail();
    } catch (err) {
      showErrorToast(err, "调整关键帧顺序失败");
      await refreshDetail();
    }
  }

  function syncMentionOptionToDraft(option: MentionOption) {
    if (!option.resourceId) return;
    const patch: Partial<Draft> = {};
    if (option.kind === "character") {
      if (!draft.character_ids.includes(option.resourceId)) {
        patch.character_ids = [...draft.character_ids, option.resourceId];
      }
    } else if (option.kind === "scene") {
      patch.scene_id = option.resourceId;
    } else if (option.kind === "element") {
      if (!draft.element_ids.includes(option.resourceId)) {
        patch.element_ids = [...draft.element_ids, option.resourceId];
      }
    }
    if (Object.keys(patch).length > 0) updateDraft(patch);
  }

  async function handleChipImagePick(elementId: string, imageId: string | null) {
    const next = draft.reference_overrides.filter((o) => o.element_id !== elementId);
    if (imageId) next.push({ element_id: elementId, image_id: imageId });
    updateDraft({ reference_overrides: next });
    // 2026-05-21 Wave Y P6 双写一致性 — reference_overrides + nodes.image_id 必须同步,
    // 否则 saveAction 时 plainTextToNodes 会用 nodes 里的旧 image_id 覆盖 reference_overrides 新值.
    // 改 5 个 nodes 字段里所有 entity_id === elementId 的 mention 节点的 image_id.
    try {
      if (slug && epId && shotId) {
        const updateNodeImageId = (raw: unknown): unknown => {
          if (!Array.isArray(raw)) return raw;
          return raw.map((n) => {
            if (n && typeof n === "object") {
              const node = n as Record<string, unknown>;
              if (node.type === "mention" && node.entity_id === elementId) {
                const out = { ...node };
                if (imageId) out.image_id = imageId;
                else delete out.image_id;
                return out;
              }
            }
            return n;
          });
        };
        await patchShot(slug, epId, shotId, {
          reference_overrides: next,
          action_nodes: updateNodeImageId(sourceShot?.action_nodes) as Shot["action_nodes"],
          dialogue_nodes: updateNodeImageId(sourceShot?.dialogue_nodes) as Shot["dialogue_nodes"],
          voiceover_nodes: updateNodeImageId(sourceShot?.voiceover_nodes) as Shot["voiceover_nodes"],
          prompt_img_nodes: updateNodeImageId(sourceShot?.prompt_img_nodes) as Shot["prompt_img_nodes"],
          prompt_vid_nodes: updateNodeImageId(sourceShot?.prompt_vid_nodes) as Shot["prompt_vid_nodes"],
        } as Partial<Shot>);
      }
    } catch (e) {
      showErrorToast(e, "参考图覆盖保存失败");
    }
  }

  async function pullFromPool(item: RejectPoolItem) {
    try {
      await importFromRejectPool(slug, epId, shotId, item.vault_id);
      toast.success("已拉回作为本镜候选");
      await refreshAll();
    } catch (err) {
      showErrorToastWithActions(err, "从废案库导入失败");
    }
  }

  // W7-cand-ux: 候选卡 hover 出"用此图微调重抽" — 打开 RegenModal
  // 2026-05-17 合并: 传 c.vault_id 让 RegenModal "局部涂抹" tab 可用,不再需要独立"局部重抽"按钮
  // W11 A5 (2026-05-27): tab='inpaint' 时直接进画笔模式 — 恢复用户原话"文字+画笔写修改意见"显式入口
  //
  // 2026-05-27 bugfix — 用户截图: "为什么重抽图提示词是要求生成视频?"
  //   旧实现取 livePreview?.composed_prompt — livePreview 跟 previewKind 联动,
  //   用户在 video 预览 tab 时打开 i2i 重抽 → 拿到视频 prompt → 模型懵.
  //   修法: 重抽图永远拿 image 预览, 跟 previewKind 当前是 image 还是 video 无关.
  function openRegenModal(c: ShotCandidate, tab: "i2i" | "inpaint" = "i2i") {
    const cid = c.generation_id || c.id;
    const url = c.url || c.thumbnail || "";
    // W11 A4: 统一走 candidateDisplayLabel — display_name > provider > 兜底
    const label = candidateDisplayLabel(c);
    // bugfix: 强制拿 image 预览 (走 getPreviewByKind helper, 跟 handleCopyImagePrompt 一致)
    setRegenModal({
      open: true,
      cid,
      sourceUrl: url,
      sourceLabel: label,
      promptPreview: getPreviewByKind("image")?.composed_prompt || "",
      negativePromptPreview: getPreviewByKind("image")?.negative_prompt || "",
      vaultId: c.vault_id ?? undefined,
      defaultTab: tab,
    });
  }

  function openVideoRegenModal(c: ShotCandidate) {
    setPickedVideoId(c.id);
    setVideoRegenCandidate(c);
  }

  async function previewVideoRegen(extraText: string, modelRef: string | null) {
    const sourceId = videoRegenCandidate?.generation_id || videoRegenCandidate?.id || "";
    const motion = buildFinalVideoPrompt(undefined, extraText);
    return dryRunVideo(slug, epId, shotId, {
      model: modelRefOrUndefined(modelRef),
      motion_prompt: motion,
      prompt_override: motion,
      duration_s: draft.duration_sec,
      count: 1,
      first_frame_id: firstFrameIdForVideoRequest(),
      source_video_generation_id: sourceId,
    });
  }

  // W7-cand-ux: RegenModal "复制提示词 + 下载原图"按钮 — 把拼接好的"原 prompt + 修改意见"打包到剪贴板
  // 2026-05-27 bugfix: 跟 openRegenModal 一致, 永远拿 image 预览 (RegenModal 是图重抽)
  function copyRegenForExternal(cid: string, extra: string) {
    const base = getPreviewByKind("image")?.composed_prompt || "";
    const extraLine = extra.trim() ? `\n\n[修改意见]\n${extra.trim()}` : "";
    const payload = `${base}${extraLine}\n\n[i2i 参考图 cid] ${cid}\n[说明] 用候选 ${cid} 作为图生图(i2i)参考`;
    navigator.clipboard?.writeText(payload).then(
      () => toast.success("已复制提示词 + 修改意见 — 原图请右键另存"),
      () => toast.error("复制失败"),
    );
    // 用户外部生成完后回来粘贴/拖入即可作为新候选
    const a = document.createElement("a");
    a.href = regenModal.sourceUrl;
    a.download = `regen-source-${cid}.png`;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  }

  // 视频废案重抽 — 用同一首帧/shot 配置重抽一段, 用户微调意见拼到 motion 后.
  //
  // 2026-05-27 重写 — 之前 P0 bug:
  //   1. 拼 `[基于废案 ${cid.slice(0,12)} 微调]` 技术字段进 prompt 文本 (铁律 #9 违反)
  //   2. 没把废案视频本身作为 i2v ref/source 发后端 — 等于纯文生重抽, 模型完全
  //      不知道源视频长啥样, 用户期望"基于此视频微调"落空
  // 现在: cid 作为 source_video_generation_id 透传, 后端会抽该视频第一帧作 i2v 首帧
  // (跟 VideoRegenModal 走同一链路); prompt 文本只保留 base + 用户微调意见.
  async function regenVideoWithTune(cid: string, extraText: string) {
    if (!shotId) return;
    if (!modelRefOrUndefined(draft.video_model_ref)) {
      highlightVideoPicker();
      return;
    }
    setBusy(`regen-video-${cid}`);
    try {
      // 不再把 cid 拼进 prompt; 让 handleGenerateVideo 把 cid 作 source_video_generation_id
      // 透传后端, 后端抽源视频首帧做 i2v 参考.
      const trimmedExtra = extraText.trim();
      await handleGenerateVideo(undefined, trimmedExtra || undefined, cid);
      toast.success(trimmedExtra ? "已用微调意见重抽视频" : "已基于此视频重抽一段");
      setTuneFor(cid, "");
    } catch (err) {
      showErrorToastWithActions(err, "视频废案重抽失败", () => regenVideoWithTune(cid, extraText));
    } finally {
      setBusy(null);
    }
  }

  async function regenWithTune(cid: string, extraText: string, mode: "full" | "compact" = "full") {
    if (!shotId) return;

    // W7-cand-ux: 废案重抽未选模型 — 同样静默 highlight,不弹 toast
    if (!modelRefOrUndefined(draft.image_model_ref)) {
      highlightImagePicker();
      return;
    }

    setBusy(`regen-${cid}`);
    try {
      await ensureSaved();
      const res = await regenFromReject(shotId, cid, {
        count: 1,
        model: modelRefOrUndefined(draft.image_model_ref),
        extra_instruction: extraText.trim() || undefined,
        compact_mode: mode === "compact",
      });
      if (isNotImplemented(res)) {
        showErrorToastWithActions(res.reason);
      } else {
        toast.success(extraText.trim() ? "已用微调意见重抽" : "已用废案图重抽");
        setTuneFor(cid, "");
      }
      await refreshAll();
    } catch (err) {
      showErrorToastWithActions(err, "从废案重抽失败", () => regenWithTune(cid, extraText));
    } finally {
      setBusy(null);
    }
  }

  // ── imports ──────────────────────────────────────────────────
  async function handleImportReference(files: FileList | null) {
    if (!files || files.length === 0 || !slug) return;
    setBusy("upload");
    try {
      const res = await uploadSeriesAssets(slug, Array.from(files), [`shot:${shotId}`, "reference"]);
      const assets: SeriesAssetRecord[] = res.assets ?? [];
      const ids = assets.filter((a) => a.kind === "image").map((a) => a.asset_id);
      if (ids.length > 0) {
        updateDraft({ reference_asset_ids: [...new Set([...ids, ...draft.reference_asset_ids])] });
        toast.success("参考图已导入,记得保存分镜");
      }
    } catch (err) {
      showErrorToast(err, "导入参考图失败");
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleImportCandidate(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    const arr = Array.from(files as ArrayLike<File>);
    setBusy("import-candidate");
    try {
      // 2026-05-18 按 mime 分支: image 进首帧候选池, video 进视频候选池.
      //   用户原话"复制完整提示词到外部 AI 生成之后导入回来" — image / video 两条路径都要通.
      let imageCount = 0;
      let videoCount = 0;
      for (const file of arr) {
        const { base64, mime } = await fileToBase64(file);
        const isVideo = typeof file.type === "string" && file.type.startsWith("video/");
        if (isVideo) {
          await importLocalVideoAsCandidate(shotId, { video_base64: base64, mime: file.type || "video/mp4", note: file.name });
          videoCount++;
        } else {
          await importLocalImageAsCandidate(shotId, { image_base64: base64, mime, note: file.name });
          imageCount++;
        }
      }
      const parts: string[] = [];
      if (imageCount > 0) parts.push(`${imageCount} 张图`);
      if (videoCount > 0) parts.push(`${videoCount} 个视频`);
      toast.success(`已导入 ${parts.join(" + ")} 到对应候选池`);
      await refreshAll();
    } catch (err) {
      showErrorToast(err, "导入候选失败");
    } finally {
      setBusy(null);
      if (candidateImportRef.current) candidateImportRef.current.value = "";
    }
  }

  // 剪贴板图片粘贴 — W7: 删 stage tab 后改为始终落首帧候选池
  useClipboardPaste({
    globalListen: true,
    accept: "image",
    onPaste: (pastedFiles) => {
      if (pastedFiles.length === 0) return;
      toast.success(`检测到 ${pastedFiles.length} 张粘贴图片, 正在导入首帧候选...`);
      void handleImportCandidate(pastedFiles);
    },
  });

  // W7-element-ux: handleRetryWithModel 已迁到 GlobalQueuePanel(失败记录中心化)

  // W11 A7 (2026-05-27): handleAsk 接收 question 参数 — 走 ComposeBox "只问不抽" toggle 触发.
  async function handleAsk(question: string) {
    if (!question.trim() || asking) return;
    setAsking(true);
    setAskAnswer(null);
    try {
      const ctx = [draft.action, draft.dialogue, draft.voiceover, draft.notes].filter(Boolean).join("\n");
      const res = await aiAsk({ context: ctx, question, scope: { kind: "shot", id: shotId } });
      if (isNotImplemented(res)) showErrorToast(res.reason);
      else setAskAnswer(res.answer);
    } catch (err) {
      showErrorToast(err, "提问失败");
    } finally {
      setAsking(false);
    }
  }

  // D-P1 (2026-06-01): AI 润色提示词 — ComposeBox 按钮触发, 结果在预览弹窗展示.
  // 可干预铁律: 不直接覆盖 prompt_img, 用户可编辑/确认后才回填.
  async function handlePolish() {
    if (polishBusy) return;
    setPolishBusy(true);
    setPolishError(null);
    setPolishResult("");
    setPolishModalOpen(true);
    try {
      const res = await polishPrompt(shotId, "image");
      setPolishResult(res.polished_prompt);
    } catch (err) {
      setPolishError(err instanceof Error ? err.message : "润色失败, 请稍后重试");
    } finally {
      setPolishBusy(false);
    }
  }

  /** 用户在润色预览弹窗点"采纳" — 把编辑后的文本回填到 prompt_img + 版本记录 */
  async function handleAcceptPolish(finalText: string) {
    // 先更新本地 draft.prompt_img — 用户立刻看到回填
    updateDraft({ prompt_img: finalText });
    setPolishModalOpen(false);
    // 同步到后端 (putShotPrompt 会追加版本)。2026-06-01 收尾自查: 原来 .catch(()=>{}) 静默吞保存失败,
    // 用户看到"已采纳"但后端实际没存(违反真实保存 + 禁 silent swallow 铁律)。改 await + 失败显式告知。
    try {
      await putShotPrompt(shotId, finalText);
      toast.success("已采纳 AI 润色结果");
    } catch (err) {
      showErrorToast(err, "润色结果已填入,但保存到后端失败 — 请重试或手动改一下再保存");
    }
  }

  // 2026-05-18: toggleElement 函数已移除 — element 绑定/解绑现在由 LibraryConnectPanel 内部
  //             toggleElement 完整接管(写入 shot.element_ids,同时清理对应 reference_asset_ids).

  // W10 (2026-05-26): 单镜创作页键盘快捷键 — 切镜 + 选候选 + 设首帧/视频.
  //   ← / J: 前一镜
  //   → / K: 后一镜
  //   Esc:   返回分镜板
  //   1-9:   把焦点候选定位到第 N 张 (按当前 previewKind 路由到首帧或视频候选区)
  //   F:     把当前焦点候选设为首帧
  //   V:     把当前焦点候选设为视频
  //
  // 焦点候选 = pickedFirstId / pickedVideoId (默认是已 picked 那张).
  // 焦点在 input/textarea/contentEditable 时跳过快捷键 (避免吞用户输入).
  // 2026-07-09 audit C15: 页面级快捷键必须在任何 overlay/lightbox 打开时整体短路.
  // 根因: 下方 shouldSkipShortcut 只判 focus 是否落在 [role="dialog"] 内, 但 MediaLightbox 无
  // role="dialog" 且 CandidateCompareModal 等不把 focus 移进弹窗 → 关预览时的 Esc 冒泡到本 handler
  // → e.preventDefault()+navigate 把用户强制踢回分镜板 (违反铁律 #1 用户控制权 > 系统智能).
  // 改判 open-state: 页面本就持有每个 overlay 的打开标志; ref 每 render 同步, handler 内读 .current
  // (不进 effect deps, 免频繁挂卸且无 stale 闭包).
  const overlayOpenRef = useRef(false);
  overlayOpenRef.current =
    lightbox.open ||
    compareModalOpen ||
    regenModal.open ||
    !!videoRegenCandidate ||
    imageReviewOpen ||
    videoReviewOpen ||
    inpaintState.open;
  useEffect(() => {
    if (!slug || !epId || !shotId) return;
    function shouldSkipShortcut(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      // input / textarea / contentEditable 不触发
      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return true;
      if (target.isContentEditable) return true;
      // modal / dialog 打开时跳过 (避免和 modal 内部 input 冲突)
      // 通过查找 closest 有 role="dialog" 来探测 (BaseDialog / RegenModal / etc 都用)
      if (target.closest('[role="dialog"]')) return true;
      return false;
    }
    function onKeyDown(e: KeyboardEvent) {
      // 2026-07-09 audit C15: 有 overlay/lightbox 打开时页面快捷键(含 Esc→返回分镜板)全部短路,
      // Esc 交由最顶层 overlay 自身 onClose 处理, 不再冒泡触发导航. 见组件内 overlayOpenRef 说明.
      if (overlayOpenRef.current) return;
      // 2026-05-28 深度打磨 #5: Ctrl+Z / Cmd+Z 撤销最近一次自动保存. 处理在 ctrlKey 短路前.
      // 输入框内不抢 Ctrl+Z (浏览器原生 undo 该字段). shouldSkipShortcut 已挡 input/textarea.
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        if (shouldSkipShortcut(e.target)) return; // 在输入框内放给浏览器
        e.preventDefault();
        handleUndoLastSave();
        return;
      }
      if (e.altKey || e.ctrlKey || e.metaKey) return; // 留给浏览器/系统组合键
      if (shouldSkipShortcut(e.target)) return;

      const key = e.key;
      // 切镜
      if (key === "ArrowLeft" || key === "j" || key === "J") {
        if (prevShot) {
          e.preventDefault();
          navigate(`/studio/${slug}/shot-stage/${epId}/${prevShot.id}`);
        }
        return;
      }
      if (key === "ArrowRight" || key === "k" || key === "K") {
        if (nextShot) {
          e.preventDefault();
          navigate(`/studio/${slug}/shot-stage/${epId}/${nextShot.id}`);
        }
        return;
      }
      if (key === "Escape") {
        // 无 overlay 打开时才返回分镜板 (overlay 打开已被顶部 overlayOpenRef 短路, 2026-07-09 audit C15).
        e.preventDefault();
        navigate(ROUTES.storyboard(slug, epId));
        return;
      }
      // 1-9 选候选 — 按 previewKind 路由 (首帧 or 视频), 也支持 numeric keypad
      if (/^[1-9]$/.test(key)) {
        const idx = Number(key) - 1;
        if (previewKind === "image") {
          const c = firstFrameCandidates[idx];
          if (c) {
            e.preventDefault();
            setPickedFirstId(c.id);
          }
        } else {
          const c = videoCandidates[idx];
          if (c) {
            e.preventDefault();
            setPickedVideoId(c.id);
          }
        }
        return;
      }
      // F: 当前焦点首帧候选 → 设首帧锚点
      if (key === "f" || key === "F") {
        if (pickedFirstId) {
          const c = firstFrameCandidates.find((x) => x.id === pickedFirstId);
          if (c) {
            e.preventDefault();
            void applyAnchor(c, "first");
          }
        }
        return;
      }
      // V: 当前焦点视频候选 → 选定视频
      if (key === "v" || key === "V") {
        if (pickedVideoId) {
          const c = videoCandidates.find((x) => x.id === pickedVideoId);
          if (c) {
            e.preventDefault();
            void selectVideo(c);
          }
        }
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // 依赖里只放真正影响 handler 的, 防止 effect 频繁挂卸
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, epId, shotId, prevShot?.id, nextShot?.id, previewKind,
      firstFrameCandidates, videoCandidates, pickedFirstId, pickedVideoId, navigate]);

  // 2026-05-17: 页面级键盘业务操作已移除,所有动作请走前端可见按钮(铁律#5 真实保存)。
  // 输入框内 @ 召唤 mention 与 modal Escape 关闭等浏览器/无障碍标准行为仍保留.

  // W8-BC: 切复选(对比用)
  function toggleCompareSelection(id: string) {
    setCompareSelection((sel) => {
      if (sel.includes(id)) return sel.filter((x) => x !== id);
      // 最多 4 张
      if (sel.length >= 4) {
        toast("最多对比 4 张候选", { icon: "ℹ️" });
        return sel;
      }
      return [...sel, id];
    });
  }
  function openCompareModal() {
    if (compareSelection.length < 2) {
      toast("至少选 2 张候选才能对比", { icon: "ℹ️" });
      return;
    }
    setCompareModalOpen(true);
  }
  const selectedCompareCandidates = useMemo(
    () => compareSelection
      .map((id) => firstFrameCandidates.find((c) => c.id === id))
      .filter((c): c is ShotCandidate => !!c),
    [compareSelection, firstFrameCandidates],
  );

  // W8-BC: 局部重抽 — FirstFrameTile 第 5 按钮 hover 弹 InpaintCanvas
  // P1 #17 留作未来 caller (InpaintCanvas 现走 RegenModal 内"局部涂抹" tab)
  function openInpaintCanvas(c: ShotCandidate) {
    const vid = c.vault_id;
    if (!vid) {
      toast.error("此候选还没归档到资料库，局部重抽暂不可用");
      return;
    }
    const url = c.url || c.thumbnail || "";
    if (!url) {
      toast.error("此候选缺少源图,局部重抽暂不可用");
      return;
    }
    setInpaintState({ open: true, vaultId: vid, sourceUrl: url });
  }
  void openInpaintCanvas; // P1 #17: silence "unused" lint — 保留为未来 caller 入口

  // ── guards ───────────────────────────────────────────────────
  if (!slug || !epId || !shotId) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "60vh", padding: 24 }}>
        <Empty title="缺少分镜参数" description="请从分镜列表重新进入。" cta="回分镜页" onCta={() => navigate(-1)} />
      </div>
    );
  }
  // 2026-05-27 — 早返 loading skeleton 彻底删. 之前刷新页面时会闪一下"加载分镜中..."
  // 再切到真实 ShotStagePage 主结构, 用户原话: "刷新页面之后会有几个 tab 加载然后
  // 弹出, 比较影响观感". 现在直接渲染主结构, 各子区块自己显示 loading 子占位
  // (PromptPreviewBlock 显"加载拼接结果...", 候选区显空状态 / Skeleton 等),
  // 整体布局稳定不再"整页突变". 数据到位陆续填充, 视觉更稳.

  const failureCount = failures.length;

  // W7: 状态徽章(toC 兜底)
  const statusBadge = (() => {
    if (pickedVideo) return { text: "视频已选定", tone: "ok" as const };
    if (videoCandidates.length > 0) return { text: "等待选定视频", tone: "warn" as const };
    if (firstAnchor) return { text: "已挑首帧 · 视频未生成", tone: "ok" as const };
    if (firstFrameCandidates.length > 0) return { text: "等待挑首帧", tone: "warn" as const };
    return { text: "等待生成", tone: "ink" as const };
  })();

  // W10: 顶栏一键 CTA / oneClickLabel / isRealVideoCTA 删除 — 跟下方 ComposeBox 重复了 (就近决策铁律).
  // isRealVideoProvider 仍由 useVideoGeneration hook 内部做 dry-run + 二级确认, 用户不会因此误扣费.

  // P1 #17 helper: 候选 → lightbox (跨子组件复用)
  // 2026-05-27 bugfix: src 必须走 candidateOriginalUrl 拿原图 /raw,
  //   c.url 在 asset-only 候选下是 thumbnail 端点 (默认 64px),
  //   lightbox 直接显示会变成模糊缩略图 — 跟 VariantPicker / ElementImageWorkspace 同款 bug.
  const openLightboxForCandidate = (c: ShotCandidate) => {
    openLightbox({
      open: true,
      src: candidateOriginalUrl(slug, c),
      kind: c.type === "video" ? "video" : "image",
      metadata: lightboxMetadataForCandidate(c),
    });
  };
  const openLightboxForAnchor = (c: ShotCandidate) => {
    openLightbox({
      open: true,
      src: candidateOriginalUrl(slug, c),
      kind: "image",
      metadata: lightboxMetadataForCandidate(c),
    });
  };

  // ComposeBox 内 @ 召唤素材 → 同步 ids 到 draft (image + video 复用)
  const handleComposeBoxMention = (asset: import("../../lib/mentionTypes").MentionAsset) => {
    const patch: Partial<Draft> = {};
    if (asset.kind === "character") {
      if (!draft.character_ids.includes(asset.id)) {
        patch.character_ids = [...draft.character_ids, asset.id];
      }
    } else if (asset.kind === "scene") {
      patch.scene_id = asset.id;
    } else if (asset.kind === "element") {
      if (!draft.element_ids.includes(asset.id)) {
        patch.element_ids = [...draft.element_ids, asset.id];
      }
    }
    if (asset.imageId && asset.refId) {
      const refIds = new Set(draft.reference_asset_ids);
      refIds.add(asset.refId);
      patch.reference_asset_ids = Array.from(refIds);
      patch.reference_notes = {
        ...draft.reference_notes,
        [asset.refId]: asset.parentName && asset.imageLabel
          ? `${asset.parentName} · ${asset.imageLabel}`
          : asset.name,
      };
    }
    if (Object.keys(patch).length > 0) updateDraft(patch);
  };

  return (
    <fieldset disabled={loading && !detail} aria-busy={loading && !detail} aria-label="单镜创作"
      style={{ border: 0, padding: 0, margin: 0, minWidth: 0, width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--surface-canvas)", overflow: "hidden" }}>

      <ShotStageHeader
        slug={slug}
        epId={epId}
        sourceShot={sourceShot}
        title={draft.title}
        onTitleChange={(next) => updateDraft({ title: next })}
        dirty={dirty}
        saving={saving}
        savedRelText={savedRelText}
        failureCount={failureCount}
        statusBadge={statusBadge}
        prevShot={prevShot}
        nextShot={nextShot}
        onNavigatePrev={() => prevShot && navigate(`/studio/${slug}/shot-stage/${epId}/${prevShot.id}`)}
        onNavigateNext={() => nextShot && navigate(`/studio/${slug}/shot-stage/${epId}/${nextShot.id}`)}
        onNavigateStoryboard={() => navigate(ROUTES.storyboard(slug, epId))}
        onNavigateCompose={() => navigate(ROUTES.compose(slug, epId))}
        onSave={saveDraft}
        hasPickedVideo={!!pickedVideo}
        undoDepth={historyDepth}
        onUndoLastSave={handleUndoLastSave}
      />

      {/* 2026-05-27 — AI 助手"插入到本镜"建议 banner
          AIAssistantPanel 点"插入到本镜"会把内容写 localStorage, ShotStagePage mount 时检测.
          用户在这里点"追加"才真改 draft.action — 不直接 patch, 保留用户控制权 (UX 铁律 #1+#2). */}
      {aiSuggestion && (
        <div style={{
          margin: "10px 24px 0",
          padding: "10px 14px",
          borderRadius: 10,
          border: "1px solid rgba(217,119,87,0.35)",
          background: "linear-gradient(135deg, rgba(217,119,87,0.08) 0%, rgba(217,119,87,0.03) 100%)",
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
        }}>
          <div style={{
            width: 26, height: 26, borderRadius: 999,
            background: "var(--brand-600)", color: "#fff",
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>AI</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-900)", marginBottom: 4 }}>
              AI 助手给了一条建议想插入到本镜画面描述
            </div>
            <div style={{
              fontSize: 12, color: "var(--ink-700)", lineHeight: 1.55,
              whiteSpace: "pre-wrap", wordBreak: "break-word",
              maxHeight: 88, overflowY: "auto",
              padding: "6px 8px",
              borderRadius: 6,
              background: "var(--surface-card)",
              border: "1px solid var(--ink-100)",
            }}>
              {aiSuggestion}
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
              <button
                type="button"
                onClick={appendAiSuggestion}
                style={{
                  padding: "5px 12px",
                  borderRadius: 6,
                  background: "var(--brand-600)",
                  color: "#fff",
                  border: "1px solid var(--brand-700)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
                title="追加到当前画面描述末尾(不覆盖原内容), 还要点保存"
              >
                追加到画面描述
              </button>
              <button
                type="button"
                onClick={dismissAiSuggestion}
                style={{
                  padding: "5px 12px",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--ink-700)",
                  border: "1px solid var(--ink-200)",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
                title="丢弃这条建议"
              >
                忽略
              </button>
              <span style={{ fontSize: 10.5, color: "var(--ink-400)", marginLeft: "auto" }}>
                来自 AI 润色助手 · 追加后请点顶栏「保存」
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          2026-05-17 T6: 主体 — 左侧素材/输入收窄,右侧候选获得更多空间
          ═══════════════════════════════════════════════════════════ */}
      <div className="mk-scroll shot-stage-scroll" style={{
        flex: 1, overflowY: "auto", overflowX: "hidden",
        // 2026-05-27 四次修 — 之前 grid + gridTemplateRows: minmax(100%, auto) + alignItems:
        // stretch 用户实测仍有白条 (CSS grid 在 overflow:auto 容器里的百分比 row 有浏览器 quirk).
        // 改最朴实的双层 flex 嵌套, 不靠任何百分比, 绝对可靠:
        //   外层: flex column (这层是 scroll 容器, 内容垂直堆)
        //   内层 .stage-row: flex: 1 0 auto + flex row, 撑到容器全高 (短) 或自然 grow (长)
        //   内层两个子项: aside / section, 都是 flex column, align-self stretch
        //   section 内部 flex spacer 推 footer 沉底
        display: "flex",
        flexDirection: "column",
        padding: "16px 24px 24px",
      }}>
      <div className="shot-stage-columns" style={{
        flex: "1 0 auto",
        display: "flex",
        flexDirection: "row",
        gap: 20,
        alignItems: "stretch",
        minHeight: 0,
      }}>

        {/* ═════════ 左栏 ═════════ */}
        <div className="shot-stage-inputs" style={{ flex: "0 0 400px", maxWidth: 400, minWidth: 360, display: "flex", flexDirection: "column" }}>
        <ShotPromptColumn
          slug={slug}
          draft={draft}
          charactersWithPrimary={charactersWithPrimary}
          scenesWithPrimary={scenesWithPrimary}
          elements={elements}
          updateDraft={updateDraft}
          syncMentionOptionToDraft={syncMentionOptionToDraft}
          onChipImagePick={handleChipImagePick}
          fileInputRef={fileInputRef}
          onImportReference={(files) => void handleImportReference(files)}
          askAnswer={askAnswer}
        />
        </div>

        {/* ═════════ 右栏(候选瀑布流) ═════════ */}
        <section style={{ flex: "1 1 0", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          {/* ── 首帧候选区 ── */}
          <FirstFrameColumn
            slug={slug}
            shotId={shotId}
            imageModelRef={draft.image_model_ref}
            onImageModelChange={(v) => updateDraft({ image_model_ref: v })}
            imageModelPickerRef={imageModelPickerRef}
            imagePickerHighlight={imagePickerHighlight}
            imageExtraInstruction={imageExtraInstruction}
            onImageExtraInstructionChange={setImageExtraInstruction}
            drawCount={drawCount}
            onDrawCountChange={setDrawCount}
            firstFrameCandidates={firstFrameCandidates}
            firstAnchor={firstAnchor}
            endAnchor={endAnchor}
            imageBusy={imageBusy}
            imageTask={imageTask}
            failedImageTasks={failedImageTasks}
            runningImageTasks={runningImageTasks}
            localPendingImageCount={localPendingDraws.image}
            recommendedCandidateId={recommendedCandidateId}
            recommendedCandidate={recommendedCandidate}
            recommendedCandidateIndex={recommendedCandidateIndex}
            autoPickTopScore={autoPickTopScore}
            compareSelection={compareSelection}
            onClearCompareSelection={() => setCompareSelection([])}
            onOpenCompareModal={openCompareModal}
            onToggleCompareSelection={toggleCompareSelection}
            pickedFirstId={pickedFirstId}
            pickedFirstFrameId={detail?.picked_first_frame_id ?? null}
            // 2026-05-27 — 按 column kind 传对应 preview, 避免 ShotStagePage 单
            // livePreview state 在切换 kind 时让首帧位显示视频提示词 (反之亦然).
            // cache 优先 (无 loading 闪烁), 没 cache 时只有当 livePreview.kind 真
            // 是 image 才用; 完全没数据时 column 自己显示 loading 占位.
            livePreview={getPreviewByKind("image")}
            liveLoading={liveLoading && !getPreviewByKind("image")}
            onPreviewKindImage={() => setPreviewKind("image")}
            candidateImportRef={candidateImportRef}
            onImportCandidate={(files) => void handleImportCandidate(files)}
            tileAspectRatio={tileAspectRatio}
            onDrawFirstFrame={() => void handleDrawFirstFrame()}
            onOpenImageReview={() => void openImageReview(imageExtraInstruction || undefined)}
            onCopyImagePrompt={handleCopyImagePrompt}
            onCopyPrompt={handleCopyImagePrompt}
            onMentionAsset={handleComposeBoxMention}
            onApplyAnchor={(c, role) => void applyAnchor(c, role)}
            onRejectCandidate={(c) => void rejectCandidate(c)}
            onOpenRegenModal={(c) => openRegenModal(c, "i2i")}
            onOpenInpaintModal={(c) => openRegenModal(c, "inpaint")}
            onRenameCandidate={renameCandidate}
            onOpenLightboxFromCandidate={openLightboxForCandidate}
            onSetPickedFirstId={setPickedFirstId}
            onRemoveTask={removeTask}
            onPromptOverrideChange={setImagePromptOverride}
            onAsk={handleAsk}
            asking={asking}
            onPolish={handlePolish}
            polishBusy={polishBusy}
          />

          {/* ── 视频候选区 ── */}
          <VideoColumn
            slug={slug}
            shotId={shotId}
            epId={epId}
            onNavigateCompose={() => navigate(ROUTES.compose(slug, epId))}
            videoModelPickerRef={videoModelPickerRef}
            videoPickerHighlight={videoPickerHighlight}
            draft={draft}
            updateDraft={updateDraft}
            seriesTtsProviderId={seriesTtsProviderId}
            videoExtraInstruction={videoExtraInstruction}
            onVideoExtraInstructionChange={setVideoExtraInstruction}
            videoCount={videoCount}
            onVideoCountChange={setVideoCount}
            videoCandidates={videoCandidates}
            pickedVideoIdFromStore={(detail?.picked_video_id ?? sourceShot?.picked_video_id) ?? undefined}
            pickedVideo={pickedVideo}
            videoBusy={videoBusy}
            videoTask={videoTask}
            failedVideoTasks={failedVideoTasks}
            runningVideoTasks={runningVideoTasks}
            localPendingVideoCount={localPendingDraws.video}
            pickedVideoId={pickedVideoId}
            firstAnchor={firstAnchor}
            endAnchor={endAnchor}
            keyAnchors={keyAnchors}
            anchorCandidate={anchorCandidate}
            dndSensors={dndSensors}
            onKeyAnchorDragEnd={handleKeyAnchorDragEnd}
            onDropAnchor={(id) => void dropAnchor(id)}
            // 2026-05-27 — 同款按 kind 取 (见 FirstFrameColumn 上注释)
            livePreview={getPreviewByKind("video")}
            liveLoading={liveLoading && !getPreviewByKind("video")}
            onPreviewKindVideo={() => setPreviewKind("video")}
            onGenerateVideo={() => void handleGenerateVideo()}
            onOpenVideoReview={() => void openVideoReview(videoExtraInstruction || undefined)}
            onCopyVideoPrompt={handleCopyVideoPrompt}
            onCopyPrompt={handleCopyVideoPrompt}
            onMentionAsset={handleComposeBoxMention}
            candidateImportRef={candidateImportRef}
            tileAspectRatio={tileAspectRatio}
            onAsk={handleAsk}
            asking={asking}
            onSelectVideo={(c) => void selectVideo(c)}
            onRejectCandidate={(c) => void rejectCandidate(c)}
            onOpenVideoRegenModal={openVideoRegenModal}
            onRenameCandidate={renameCandidate}
            onOpenLightboxFromCandidate={openLightboxForCandidate}
            onOpenLightboxFromAnchor={openLightboxForAnchor}
            onSetPickedVideoId={setPickedVideoId}
            onRemoveTask={removeTask}
            onPromptOverrideChange={setVideoPromptOverride}
          />

          {/* ── 废案库 ── */}
          <RejectPoolSection
            rejectTier={rejectTier}
            onTierChange={setRejectTier}
            rejectMediaType={rejectMediaType}
            onMediaTypeChange={setRejectMediaType}
            trashedCandidatesCount={trashedCandidates.length}
            projectPoolCount={projectPool.length}
            publicPoolCount={publicPool.length}
            shotRejectItems={shotRejectItems}
            shotRejectLookup={shotRejectLookup}
            imageModelRef={draft.image_model_ref}
            videoModelRef={draft.video_model_ref}
            onImageModelChange={(v) => updateDraft({ image_model_ref: v })}
            onVideoModelChange={(v) => updateDraft({ video_model_ref: v })}
            rejectTuneMap={rejectTuneMap}
            onSetTune={setTuneFor}
            busyTag={busy}
            onOpenImage={(lookup) => {
              // 2026-05-27 bugfix: 走 candidateOriginalUrl 拿原图 /raw, 不再用 c.url
              // (asset-only 时是 64px thumbnail) — 跟 openLightboxForCandidate 同款修.
              if (lookup.kind === "candidate") {
                openLightbox({
                  open: true,
                  src: candidateOriginalUrl(slug, lookup.candidate),
                  kind: lookup.candidate.type === "video" ? "video" : "image",
                  metadata: lightboxMetadataForCandidate(lookup.candidate),
                });
              } else {
                openLightbox({
                  open: true,
                  src: candidateOriginalUrl(slug, lookup.item),
                  kind: lookup.item.kind === "video" ? "video" : "image",
                  metadata: { provider: labelOfSource(lookup.item.provider_id) },
                });
              }
            }}
            onRestoreCandidate={(c) => void restoreCandidate(c)}
            onPromote={(c, target) => void promote(c, target)}
            onRegenImage={(cid, tune) => void regenWithTune(cid, tune)}
            onRegenVideo={(cid, tune) => void regenVideoWithTune(cid, tune)}
            onPullFromPool={(item) => void pullFromPool(item)}
            getLabelFromProvider={labelOfSource}
          />

          {/* 2026-05-27 — 右栏 footer hint, 占满短列下方白屏 + 给用户清晰的"下一步"引导.
              空 spacer 在前, footer 卡片在底 — 让 hint 沉在最下方贴底, 不在中间漂.
              典型场景: 用户刚抽完首帧, 还没生视频, 右栏短, 这块原本是白屏, 现在变成
              "首帧满意了? 这里点生成视频 / 满意所有镜后顶栏前往合成"的引导. */}
          <div style={{ flex: "1 0 auto" }} />
          <ShotStageBottomHint
            hasFirstFrameCandidates={firstFrameCandidates.length > 0}
            hasVideoCandidates={videoCandidates.length > 0}
            onJumpToVideoArea={() => {
              // 在主滚动容器内滚到视频候选区 (RegenVideo 按钮所在 section)
              const el = document.querySelector('[data-section="video-column"]') as HTMLElement | null;
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            onNavigateStoryboard={() => navigate(ROUTES.storyboard(slug, epId))}
            onNavigateCompose={() => navigate(ROUTES.compose(slug, epId))}
            prevShotId={prevShot?.id}
            nextShotId={nextShot?.id}
            onNavigatePrev={() => prevShot && navigate(`/studio/${slug}/shot-stage/${epId}/${prevShot.id}`)}
            onNavigateNext={() => nextShot && navigate(`/studio/${slug}/shot-stage/${epId}/${nextShot.id}`)}
          />
        </section>
      </div>
      </div>

      <ShotStageModals
        slug={slug}
        imageReviewOpen={imageReviewOpen}
        imageReviewLoading={imageReviewLoading}
        imageReviewPrompt={imageReviewPrompt}
        imageReviewNegative={imageReviewNegative}
        imageReviewSegments={imageReviewSegments}
        imageReviewManualRefs={imageReviewManualRefs}
        imageReviewImplicitRefs={imageReviewImplicitRefs}
        imageCostPreview={imageCostPreview}
        onImageReviewClose={() => setImageReviewOpen(false)}
        onImageReviewConfirm={async (finalPrompt) => {
          setImageReviewOpen(false);
          await handleDrawFirstFrame(finalPrompt);
        }}
        onImageReviewPromptChange={setImageReviewPrompt}
        onImageReviewToggleImplicit={(asset_id, nextActive) => {
          setImageReviewImplicitRefs((prev) =>
            prev.map((r) => (r.asset_id === asset_id ? { ...r, active: nextActive } : r)),
          );
        }}
        onImageReviewManualImport={handleImportCandidate}
        videoReviewOpen={videoReviewOpen}
        videoReviewLoading={videoReviewLoading}
        videoReviewPrompt={videoReviewPrompt}
        videoReviewNegative={videoReviewNegative}
        videoReviewSegments={videoReviewSegments}
        videoReviewManualRefs={videoReviewManualRefs}
        videoReviewImplicitRefs={videoReviewImplicitRefs}
        videoCostPreview={videoCostPreview}
        onVideoReviewClose={() => setVideoReviewOpen(false)}
        onVideoReviewConfirm={async (finalPrompt) => {
          setVideoReviewOpen(false);
          await handleGenerateVideo(finalPrompt);
        }}
        onVideoReviewPromptChange={setVideoReviewPrompt}
        onVideoReviewToggleImplicit={(asset_id, nextActive) => {
          setVideoReviewImplicitRefs((prev) =>
            prev.map((r) => (r.asset_id === asset_id ? { ...r, active: nextActive } : r)),
          );
        }}
        onVideoReviewManualImport={handleImportCandidate}
        lightbox={lightbox}
        onCloseLightbox={closeLightbox}
        regenModal={regenModal}
        imageModelRef={draft.image_model_ref}
        onImageModelChange={(v) => updateDraft({ image_model_ref: v })}
        busyTag={busy}
        onRegenModalClose={() => setRegenModal((s) => ({ ...s, open: false }))}
        onRegenConfirm={async (extra, mode) => {
          const cid = regenModal.cid;
          setRegenModal((s) => ({ ...s, open: false }));
          await regenWithTune(cid, extra, mode);
        }}
        onRegenPreviewPrompt={(currentExtra) => {
          // W7-regen-fix:不再 close RegenModal,只叠加 PromptReviewModal(z-index 250 高于 220).
          void openImageReview(currentExtra);
        }}
        onRegenCopyForExternal={(extra) => copyRegenForExternal(regenModal.cid, extra)}
        onRegenInpainted={() => { void refreshAll(); }}
        videoRegenCandidate={videoRegenCandidate}
        videoModelRef={draft.video_model_ref}
        onVideoModelChange={(v) => updateDraft({ video_model_ref: v })}
        durationSec={draft.duration_sec}
        videoBusy={videoBusy}
        videoExtraInstructionDefault={videoExtraInstruction}
        onVideoRegenDryRun={previewVideoRegen}
        onVideoRegenConfirm={async (extra) => {
          const sourceId = videoRegenCandidate?.generation_id || videoRegenCandidate?.id || "";
          setVideoRegenCandidate(null);
          await handleGenerateVideo(undefined, extra, sourceId);
        }}
        onVideoRegenClose={() => setVideoRegenCandidate(null)}
        compareModalOpen={compareModalOpen}
        selectedCompareCandidates={selectedCompareCandidates}
        onCompareModalClose={() => setCompareModalOpen(false)}
        onCompareModalPickAsMain={(c) => {
          if (c.type === "video") void selectVideo(c);
          else void applyAnchor(c, "first");
          setCompareModalOpen(false);
        }}
        onCompareModalViewPrompt={() => void openImageReview()}
        // 2026-05-27 audit P2 #41: inpaintState 死代码 — 真 InpaintCanvas 走 RegenModal defaultTab='inpaint'
        inpaintState={EMPTY_INPAINT_STATE}
        onInpainted={() => { void refreshAll(); }}
        onInpaintClose={() => { /* no-op (死代码) */ }}
      />

      {/* D-P1 (2026-06-01): AI 润色提示词预览弹窗 — 可干预铁律: 用户可编辑/确认后才回填 */}
      <PolishPreviewModal
        open={polishModalOpen}
        originalPrompt={draft.prompt_img ?? ""}
        polishedPrompt={polishResult}
        mode="image"
        loading={polishBusy}
        error={polishError}
        onAccept={handleAcceptPolish}
        onCancel={() => setPolishModalOpen(false)}
      />
    </fieldset>
  );
}

// ─── 子组件: 右栏底部引导卡 (2026-05-27) ────────────────────────────
// 触发场景: 左栏提示词长, 右栏 (首帧+视频候选) 短 → 右栏下方一大块白屏.
// 修法: alignItems:stretch + 右栏末尾 flex-grow spacer + 这张卡贴底 — 把白屏
// 变成"清晰的下一步"引导, 顺手收尾本镜创作循环.
function ShotStageBottomHint({
  hasFirstFrameCandidates,
  hasVideoCandidates,
  onJumpToVideoArea,
  onNavigateStoryboard,
  onNavigateCompose,
  prevShotId,
  nextShotId,
  onNavigatePrev,
  onNavigateNext,
}: {
  hasFirstFrameCandidates: boolean;
  hasVideoCandidates: boolean;
  onJumpToVideoArea: () => void;
  onNavigateStoryboard: () => void;
  onNavigateCompose: () => void;
  prevShotId: string | undefined;
  nextShotId: string | undefined;
  onNavigatePrev: () => void;
  onNavigateNext: () => void;
}) {
  // 根据创作进度给不同主提示 — 让用户知道"接下来该干啥"
  let headline: string;
  let subline: string;
  if (!hasFirstFrameCandidates) {
    headline = "先抽首帧";
    subline = "上面填好画面描述, 点'抽首帧'让 AI 出几张候选, 满意的设为'首帧'.";
  } else if (!hasVideoCandidates) {
    headline = "首帧满意了? 接着抽视频";
    subline = "下方'视频候选'区域点'生成视频', AI 会让首帧动起来 (5 秒一段).";
  } else {
    headline = "本镜创作完成";
    subline = "满意了点顶栏'前往合成', 或先去下一镜继续创作.";
  }

  const btnStyle: CSSProperties = {
    padding: "6px 12px",
    borderRadius: 7,
    border: "1px solid var(--ink-200)",
    background: "var(--surface-card)",
    color: "var(--ink-800)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.15s",
    whiteSpace: "nowrap",
  };
  const primaryBtnStyle: CSSProperties = {
    ...btnStyle,
    background: "linear-gradient(135deg, var(--brand-600), var(--brand-500))",
    color: "#fff",
    border: "1px solid var(--brand-700)",
  };

  return (
    <div
      style={{
        marginTop: 8,
        // 2026-05-27 — paddingRight 16 → 132, 给右下角 fixed 浮按钮 (AI 助手 96px + 任务
        // bubble 48px + 24px 间距) 让位, 避免最右的"快捷键提示" 文字被遮挡.
        // 主按钮 (前往合成 / 上一镜 / 下一镜) 在左侧, 不受影响.
        padding: "14px 132px 14px 16px",
        borderRadius: 10,
        border: "1px dashed var(--ink-200)",
        background: "linear-gradient(180deg, rgba(252,250,247,0.6) 0%, var(--ink-50) 100%)",
      }}
    >
      <div style={{
        fontSize: 13,
        fontWeight: 700,
        color: "var(--ink-900)",
        marginBottom: 2,
      }}>
        {headline}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-500)", marginBottom: 10 }}>
        {subline}
      </div>
      <div style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
      }}>
        {/* 主操作: 根据状态 — 没首帧 → 滚回顶 / 没视频 → 滚到视频区 / 都齐 → 合成 */}
        {!hasFirstFrameCandidates && (
          <button
            type="button"
            style={primaryBtnStyle}
            onClick={() => {
              // 滚到页顶 (画面描述输入框)
              const scroller = document.querySelector(".mk-scroll") as HTMLElement | null;
              scroller?.scrollTo({ top: 0, behavior: "smooth" });
            }}
            title="滚回顶部填画面描述"
          >
            ↑ 回顶部填画面描述
          </button>
        )}
        {hasFirstFrameCandidates && !hasVideoCandidates && (
          <button type="button" style={primaryBtnStyle} onClick={onJumpToVideoArea} title="滚到视频候选区">
            ↓ 去视频候选区生成视频
          </button>
        )}
        {hasFirstFrameCandidates && hasVideoCandidates && (
          <button type="button" style={primaryBtnStyle} onClick={onNavigateCompose} title="前往合成页">
            前往合成 →
          </button>
        )}

        {/* 次操作: 邻镜跳转 + 回分镜板 */}
        {prevShotId && (
          <button type="button" style={btnStyle} onClick={onNavigatePrev} title="上一镜 (← / J)">
            ← 上一镜
          </button>
        )}
        {nextShotId && (
          <button type="button" style={btnStyle} onClick={onNavigateNext} title="下一镜 (→ / K)">
            下一镜 →
          </button>
        )}
        <button type="button" style={btnStyle} onClick={onNavigateStoryboard} title="回分镜板 (Esc)">
          回分镜板
        </button>

        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--ink-400)" }}>
          快捷键: F 设首帧 · V 设最终视频 · ←/→ 切镜 · Esc 回板
        </span>
      </div>
    </div>
  );
}
