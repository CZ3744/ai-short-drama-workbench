/**
 * ImageGenerationPanel — 全项目统一图像生成组件 (Phase 2, Wave 2, 2026-05-16).
 *
 * 一句话: caller (ElementWorkbench / ShotStagePage / LibraryPage / SeriesDetail)
 *         传 target + promptCompiler + onSuccess, 组件内部封装"模型选择 / 张数 / dry-run
 *         二级确认 / 提示词审核 (可改可复制) / 生图按钮 / 任务上报"全套 UI 逻辑.
 *
 * 2026-05-16 五件 UX:
 *  - 删除"生成 / 批量再抽" tab 切换 — 用户原话"批量再抽不该和生成并列"(铁律 #3 信息直接可见)
 *  - 统一为单一直线流程: textarea → 模型 → 张数 → 生图(N 张)
 *  - 上方加快捷参考图区(可选 prop): 折叠展开,展示当前 caller 的图库,勾选作生图参考
 *
 * 设计依据:
 *  - 12 条 UX 铁律 (CLAUDE.md "UX 设计铁律 12 条" + memory feedback_design_philosophy.md)
 *  - 用户偏好: 一键抽卡默认 1 张 (绝对)
 *  - 解耦信仰: 不知道 ElementData / ShotData / SeriesData 内部结构 — caller 在 onSuccess
 *    里自己 setState (component 只透传 target_state: unknown)
 *
 * 12 铁律对照 (每一条都有对应实现):
 *  1. 用户控制权 → 不强制跳转, 失败 toast 给文案不弹 modal 阻塞
 *  2. 可干预性 → "查看完整提示词 / AI 润色 + 审核" 两路按钮必有, 改完真发送修改版 (#12)
 *  3. 信息直接可见 → 单一直线流程, 不再 tab 切换
 *  4. 就近决策 → ModelPicker 贴在生图按钮旁; ReferencePicker 贴在 textarea 上方
 *  5. 真实保存 → useImageGeneration 内部完成 tasksStore upsert + onSuccess 回调
 *  6. 数据保留 → 本组件不涉及删除, 但 toast 文案明确"累加进图库"避免误以为覆盖
 *  7. 标准创作工具语义 → 张数 chip 1/4/8/16/32 + 自定义 input
 *  8. 视觉一致性 → 沿用 ElementGeneratePanel 同款 btnPrimary / btnSecondary / btnInfo 风格
 *  9. toC 兜底 → labelOfSource() 翻译 provider_id, 不暴露技术字段
 *  10. 优雅空状态 → "未选模型" 给 "去设置" CTA 而非 toast.error
 *  11. 每个按钮有名字 → 全部图标 + 文字, 不允许 icon-only
 *  12. 批改+发送一致 → PromptReviewModal 收编辑后 prompt, trigger 用编辑版而非缓存
 *
 * Usage example (Wave 3 替换 ElementWorkbench.doGenerate 时参考):
 *
 *   import { ImageGenerationPanel } from "../components/generation/ImageGenerationPanel";
 *
 *   <ImageGenerationPanel
 *     target={{ kind: "element", series_slug: slug, target_id: elementId }}
 *     promptCompiler={async ({ polish, user_instruction }) => {
 *       const r = await compileElementPrompt(slug, elementId, { polish, user_instruction });
 *       return {
 *         full_prompt: r.full_prompt,
 *         negative_prompt: r.negative_prompt,
 *         segments: r.segments,
 *       };
 *     }}
 *     defaultCount={1}                        // 用户铁律: 默认 1
 *     // 2026-05-16: 把当前 element 的图传进来,Panel 自带折叠 ReferencePicker
 *     availableReferenceImages={element.images}
 *     selectedReferenceIds={selectedRefImageIds}
 *     onSelectedReferenceChange={setSelectedRefImageIds}
 *     primaryReferenceImageId={element.primary_image_id}
 *     initialUserInstruction={userInstruction}
 *     displayName={element.name}              // 用户友好 toast 用
 *     onSuccess={(result) => {
 *       // target_state 是后端 adapter 返回的 ElementData
 *       const el = result.target_state as ElementData;
 *       setElement(el);                       // SWR mutate 或 setState
 *     }}
 *   />
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../shared/Icon";
import { ModelPicker } from "../studio/ModelPicker";
import { PromptReviewModal } from "../element/PromptReviewModal";
import { ReferencePicker } from "../element/ReferencePicker";
import { labelOfSource, isKeylessImageProvider } from "../../lib/sourceLabels";
import { ComposeBox } from "../shot-stage/ComposeBox";
import { Button } from "../ui/button";
import { useConfirm } from "../ui/ConfirmModal";
import {
  useImageGeneration,
  type GenerateImageTriggerInput,
  type ImageGenerationMode,
} from "../../hooks/useImageGeneration";
import { generateImageDryRun } from "../../lib/generationApi";
import type {
  GenerateImageResult,
  ImageGenerationTarget,
  ImageReferenceInput,
} from "../../lib/generationApi";
import type { ElementImage } from "../../lib/elementApi";

// ─── 类型契约 ───────────────────────────────────────────────────────

/** 提示词编译器产出 — 给 PromptReviewModal 看的, 也是真发送的入参。 */
export interface CompiledPromptForGeneration {
  full_prompt: string;
  negative_prompt: string;
  /** 拼接结构 (modal 上半部分展示) — 可选 */
  segments?: { label: string; text: string }[];
  /** 参考图 (modal 缩略图展示) — 可选 */
  reference_images?: Array<{ url: string; label?: string }>;
}

/** 编译器调用入参 */
export interface PromptCompileOpts {
  /** 是否走 LLM 润色 (false = 模板直拼) */
  polish: boolean;
  /** 用户在 textarea 输入的修改意见 */
  user_instruction?: string;
}

export interface ImageGenerationPanelProps {
  /** 业务目标 — 后端 Adapter 走哪条路径全靠这个 */
  target: ImageGenerationTarget;

  /**
   * 同步 vs 异步模式 (Wave 4-B):
   *  - "sync" (默认): 调统一 endpoint 等结果. ElementWorkbench / 小任务用.
   *  - "async": 调 scoped endpoint, 立即返 task_id + SSE 推真结果. ShotStagePage 主流量用.
   *            仅支持 target.kind = shot_first_frame / shot_last_frame.
   *
   * async 模式下点击生图按钮 → 任务立即入队 → 按钮显示"已加入队列, 等待中..." →
   * SSE task.done 推回来后 onSuccess (target_state = 最新 shot detail).
   */
  mode?: ImageGenerationMode;

  /**
   * 提示词编译函数 — caller 提供。可选实现:
   *   1. 调后端 compile-prompt 端点 (推荐 — 后端 assetPromptCompiler / shotPromptCompiler)
   *   2. 本地拼接 (vault_only 等简单场景)
   * 必须支持 polish=true / false 两种模式 (铁律 #2 "AI 润色 + 模板直拼" 双路径)。
   */
  promptCompiler: (opts: PromptCompileOpts) => Promise<CompiledPromptForGeneration>;

  /** 默认抽几张 — 默认 1 (用户铁律 — 一键抽卡默认 1) */
  defaultCount?: number;

  /** 模型选择器默认值 (可选, 不传则展示 "选择模型..." 占位) */
  defaultModelRef?: string;

  /** 模型变更回调 — caller 想持久化用户最近选用的模型时用 */
  onModelChange?: (modelRef: string | null) => void;

  /** LLM 润色用的文字模型 (可选 — 不传 = 隐藏 AI 润色行) */
  defaultLlmModelRef?: string;
  onLlmModelChange?: (modelRef: string | null) => void;

  /** 用户原始指令默认值 (回填到 textarea) */
  initialUserInstruction?: string;

  /**
   * 2026-05-16 五件 UX: 把 caller 的图库列表传进来, Panel 自带折叠 ReferencePicker.
   * 用户原话: "这个功能应该体现在我想添加/生成新图片的时候,而不是摆在主页"
   *
   * 默认折叠 (铁律 #3 信息直接可见, 但不抢生图按钮的视觉重心), 标题展示已勾选数.
   * 不传则 Panel 不渲染 ReferencePicker — caller (非 element 入口) 走 extraReferenceImages.
   */
  availableReferenceImages?: ElementImage[];
  /** 当前勾选的 image_id 列表 — caller 受控管理 */
  selectedReferenceIds?: string[];
  /** 勾选变化回调 — caller 决定如何持久化 */
  onSelectedReferenceChange?: (ids: string[]) => void;
  /** 主图 id (ReferencePicker 默认勾它) */
  primaryReferenceImageId?: string;

  /** 业务名 — 用于 toast / 失败 highlight 文案, 例: "蓝衣女孩" */
  displayName?: string;

  /** 生成成功 — caller 决定怎么用 target_state */
  onSuccess?: (result: GenerateImageResult) => void;

  /** 失败回调 (可选) — 默认 hook 内 toast.error */
  onError?: (err: unknown) => void;

  /**
   * 额外参考图 — 若 caller 需要把参考图透传给后端, 通过此 prop 传入.
   * i2i 重抽统一走 RegenModal 一站式入口, 不再通过 Panel 传 i2iBaseImage。
   */
  extraReferenceImages?: ImageReferenceInput[];

  /**
   * 2026-05-18: 给 PromptReviewModal 显示用的额外参考图 (带 url + label, 缩略图渲染).
   * extraReferenceImages 是 ImageReferenceInput union (asset_id/vault_id/...) 没 url 字段,
   * 不能直接喂给 modal. caller 同时拥有 url 信息时通过本 prop 显式补 url+label.
   */
  previewReferenceImages?: Array<{ url: string; label: string }>;

  /**
   * 2026-05-18: 系统隐式建议的参考图 (角色/场景主图等). 用户在 review modal 可单张取消.
   * caller (例如 ElementWorkbench) 知道当前 element 是 character/scene 时,
   * 把对应主图作 implicit 传入. 用户取消后, doGenerate 时由 caller 重组 final references.
   */
  previewImplicitReferences?: Array<{ asset_id: string; url: string; label: string; source: "character_primary" | "scene_primary" | "element_primary"; source_name: string; active: boolean }>;

  /** previewImplicitReferences 单张取消时回调, caller 用于重组 final references */
  onTogglePreviewImplicitRef?: (asset_id: string, nextActive: boolean) => void;

  /**
   * 2026-05-16 渐进式落盘 — caller 想在自己图库里渲染 skeleton 占位卡时订阅本回调.
   *
   * 用户原话: "一键抽 N 张按顺序发送, 回来一张落盘一张, 其他未完成请求在图库该落盘的
   * 地方做生成中占位, 方便我知道有多少张正在生成."
   *
   * 数据流:
   *   1. 用户点"生 N 张" → trigger 启动 → onProgress({ completed: 0, total: N })
   *   2. SSE image.partial 收到 → 后端落盘一张 → onProgress({ completed: 1, total: N })
   *   3. ... 累加到 N → trigger 完成 → onProgress({ completed: 0, total: 0 })(skeleton 消失)
   *
   * caller 用 (total - completed) 计算还要画几个 skeleton 占位卡(配合自己的图库列表).
   */
  onProgress?: (progress: { completed: number; total: number }) => void;

  /** 导入用户在外部 AI 生成的图片/结果 */
  onManualImport?: (files: File[]) => Promise<void> | void;

  /**
   * 2026-05-18: 编译提示词前的钩子 — caller 用来 flush autosave / 确保 backend 看到最新输入.
   *
   * 用户原话(怒): "我在左边填写了紧张, 右侧提示词根本没同步".
   * 真因: ElementWorkbench updateAttr 只动 local state, 不立即 patchElement →
   *       compileElementPrompt 读数据库旧 attrs → 完整提示词不含"紧张".
   * 修法: caller 传 onBeforeCompile = ensureElementSaved, Panel 调 promptCompiler 前 await 它.
   */
  onBeforeCompile?: () => Promise<void> | void;

  /**
   * P3-2 (2026-05-18): "引用其他素材图" — 跨 element 取典型图作参考.
   * 传入后 ReferencePicker 的 summary 行会出现"引用其他素材图..."按钮,
   * 点击由父组件(ElementWorkbench)弹 LibraryPickerModal 处理.
   */
  onPickFromLibrary?: () => void;
}

// 2026-05-21 Wave 2D: btnBase / btnInfo 本地副本已删 — AI 润色按钮迁到统一 Button 组件.
//   早期 btnPrimary / btnSecondary 已下沉 ComposeBox.

// ─── 组件 ────────────────────────────────────────────────────────────

export function ImageGenerationPanel(props: ImageGenerationPanelProps) {
  const {
    target,
    mode = "sync",
    promptCompiler,
    defaultCount = 1, // 用户铁律: 默认 1
    defaultModelRef,
    onModelChange,
    defaultLlmModelRef,
    onLlmModelChange,
    initialUserInstruction = "",
    displayName,
    onSuccess,
    onError,
    extraReferenceImages,
    previewReferenceImages,
    previewImplicitReferences,
    onTogglePreviewImplicitRef,
    onProgress,
    availableReferenceImages,
    selectedReferenceIds,
    onSelectedReferenceChange,
    primaryReferenceImageId,
    onManualImport,
    onBeforeCompile,
    onPickFromLibrary,
  } = props;

  const confirm = useConfirm();

  // ── state ──────────────────────────────────────────────────────
  const [count, setCount] = useState<number>(defaultCount);
  const [userInstruction, setUserInstruction] = useState<string>(initialUserInstruction);
  const [imageModelRef, setImageModelRef] = useState<string | null>(defaultModelRef ?? null);
  const [llmModelRef, setLlmModelRef] = useState<string | null>(defaultLlmModelRef ?? null);

  // 2026-05-18: @mention 浮层 state / handler 已由 ComposeBox 内部接管,
  //   panel 不再持有 mention state. ComposeBox 通过 onMentionAsset 把选中素材
  //   回传 — Element/Shot 入口可以通过 caller 进一步同步 ids; 这个 panel 默认
  //   只插入 token 文本到 userInstruction (符合 element 入口现状).

  // ── 提示词审核 modal ───────────────────────────────────────────
  const [compiling, setCompiling] = useState(false);
  const [compiled, setCompiled] = useState<CompiledPromptForGeneration | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  // 2026-07-22 Y7 (UP-8 收线): 审核弹窗成本预告一行 (PromptReviewModal.costPreview, Y6 已就绪).
  // 免费渠道 (isKeylessImageProvider) 零网络请求同步给静态文案; 付费渠道复用 dryRun()(与
  // doGenerate 里 count>=2 触发的确认门同一个函数, 不新造预估公式) 异步拿真实预估。
  // null = 不显示这一行(未选模型 / 还没算出来)。
  const [costPreviewText, setCostPreviewText] = useState<string | null>(null);

  // ── 错误高亮 (铁律 #10: 不弹 toast 阻塞, 而是 highlight model picker) ──
  const [highlightPicker, setHighlightPicker] = useState(false);

  // ── flash (轻量 toast) ─────────────────────────────────────────
  // BUG-26 fix: useRef 存储 timer ID，快速调用时 clearTimeout 前一个
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flashMsg, setFlashMsg] = useState<string | null>(null);
  const flash = useCallback((m: string) => {
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
    setFlashMsg(m);
    flashTimerRef.current = setTimeout(() => {
      setFlashMsg(null);
      flashTimerRef.current = null;
    }, 2200);
  }, []);

  // ── 同步 initialUserInstruction 变化 (caller prop drilling 时) ──
  useEffect(() => {
    if (initialUserInstruction !== userInstruction) {
      setUserInstruction(initialUserInstruction);
    }
    // 故意只在 initialUserInstruction 变化时同步, 不要把 userInstruction 加入依赖
    // 否则会陷入死循环。 eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUserInstruction]);

  // ── hook ───────────────────────────────────────────────────────
  const {
    trigger,
    dryRun,
    generating,
    estimating,
    awaiting,
    lastError,
    partialReceived,
    totalRequested,
  } = useImageGeneration({
    target,
    mode,
    onSuccess: (result) => {
      setReviewOpen(false);
      onSuccess?.(result);
    },
    onError,
    displayName,
    // Wave 4-D: Panel 自己已经在 doGenerate 里完整跑了 dry-run + confirm UX,
    // 不需要 hook 再弹一遍 (避免 double-confirm). caller (其他不渲染 Panel
    // 的入口) 默认走 hook 内置 count>=2 自动 dry-run + confirm.
    confirmBatch: false,
  });

  // 2026-05-16 渐进式落盘 — caller 想给图库渲染 skeleton 占位卡时, 通过 onProgress 拿到
  // 实时数据. 数据形式: { completed: N, total: M }. 父组件计算 skeleton 数 = total - completed.
  useEffect(() => {
    if (!onProgress) return;
    onProgress({ completed: partialReceived, total: totalRequested });
    // 仅在 partial 状态变化时通知, eslint 抱怨 onProgress ref 不稳定我们忽略
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partialReceived, totalRequested]);

  // ── 切换 modelPicker ───────────────────────────────────────────
  const handleImageModelChange = useCallback(
    (v: string | null) => {
      setImageModelRef(v);
      onModelChange?.(v);
      // 重新选了模型, 清掉错误 highlight
      setHighlightPicker(false);
    },
    [onModelChange],
  );

  const handleLlmModelChange = useCallback(
    (v: string | null) => {
      setLlmModelRef(v);
      onLlmModelChange?.(v);
    },
    [onLlmModelChange],
  );

  // 2026-07-22 Y7 (UP-8 收线): 成本预告刷新 — 免费/付费分流规则跟 doGenerate 里 count>=2
  // 触发的确认门(下方 costDescription)完全一致, 这里只是把同一份判断提前到"打开审核弹窗"
  // 这一刻展示. 复用同一个后端预估端点 generateImageDryRun(不新造预估公式), 但**不**走
  // hook 的 dryRun() 包装 —— 那个会翻 estimating=true, 而 estimating 同时喂给本 modal 的
  // busy 判定(下方)和主"生图"按钮(GenerateTab busy/composeBusyLabel). 若用它, 打开审核弹窗
  // 就会让取消键被锁+按钮误显示"生成中…"(用户实际还没点确认), 是状态失真(铁律 #5).
  // 直接调底层 API, 只用本地 costPreviewText 自己的 loading 文案, 零副作用泄漏到别处.
  const refreshCostPreview = useCallback(
    async (compiledResult: CompiledPromptForGeneration) => {
      if (!imageModelRef || !imageModelRef.trim()) {
        setCostPreviewText(null);
        return;
      }
      if (isKeylessImageProvider(imageModelRef)) {
        setCostPreviewText("本地免费渠道 · 不计费");
        return;
      }
      setCostPreviewText("预估费用中…");
      try {
        const dr = await generateImageDryRun({
          target,
          prompt: compiledResult.full_prompt,
          negative_prompt: compiledResult.negative_prompt,
          model_ref: imageModelRef,
          count,
          reference_images: extraReferenceImages,
        });
        if (dr.error === "key_missing") {
          setCostPreviewText(dr.message || "该模型还没配置 API Key");
          return;
        }
        setCostPreviewText(
          dr.is_keyless
            ? "本地免费渠道 · 不计费"
            : dr.estimated_cost_cny != null
              ? `预估 ¥${dr.estimated_cost_cny.toFixed(4)} (${dr.estimated_cost_note})`
              : "预估费用未知, 确认生成时会重新计算",
        );
      } catch {
        setCostPreviewText("预估费用失败, 确认生成时会重新计算");
      }
    },
    [imageModelRef, count, target, extraReferenceImages],
  );

  // ── 打开审核 modal (polish 决定走 LLM 还是模板) ──────────────────
  const openReview = useCallback(
    async (polish: boolean) => {
      // 铁律 #10: 没选模型时优雅 highlight 而不是 toast.error 一秒都不给
      if (!imageModelRef || !imageModelRef.trim()) {
        setHighlightPicker(true);
        flash("先选一个图像模型, 再继续");
        return;
      }
      setCompiling(true);
      // Y7: 每次重开先清空上一轮估价文案, 避免旧模型/旧张数的费用闪现一下再刷新.
      setCostPreviewText(null);
      try {
        // 2026-05-18: 编译前先 flush autosave - caller (ElementWorkbench) 用 onBeforeCompile
        //   把 dirty local state 保存到 backend, 这样 promptCompiler 调 backend 拿到最新 attrs.
        //   不传则 noop, 跟之前行为一致.
        if (onBeforeCompile) {
          try { await onBeforeCompile(); } catch { /* save 失败不阻塞编译, 显示旧 prompt 总比不出强 */ }
        }
        const r = await promptCompiler({ polish, user_instruction: userInstruction });
        setCompiled(r);
        setReviewOpen(true);
        void refreshCostPreview(r);
      } catch (e) {
        flash(`编译提示词失败: ${e instanceof Error ? e.message : e}`);
      } finally {
        setCompiling(false);
      }
    },
    [imageModelRef, userInstruction, promptCompiler, flash, onBeforeCompile, refreshCostPreview],
  );

  // ── 真发送 (review modal 里点"确认调用本地模型生成") ──────────────
  const doGenerate = useCallback(
    async (editedPrompt: string) => {
      if (!compiled) return;

      // 再次 guard (用户没选模型 / 中间点击切了模型) — 铁律 #5 真实保存
      if (!imageModelRef || !imageModelRef.trim()) {
        setHighlightPicker(true);
        flash("先选一个图像模型, 再继续");
        return;
      }

      // count ≥ 2 时强制 dry-run + 二级确认 — 避免大批量误触
      if (count >= 2) {
        try {
          const dr = await dryRun({
            prompt: editedPrompt,
            negative_prompt: compiled.negative_prompt,
            model_ref: imageModelRef,
            count,
            reference_images: extraReferenceImages,
          });
          if (dr.error === "key_missing") {
            // 铁律 #1 + #10: 给一个"去设置"二级确认, 不强制跳
            const goSettings = await confirm({
              title: `${labelOfSource(dr.provider_id)} 还没填 Key`,
              description: dr.message ? `${dr.message}\n\n现在去设置页配置吗?` : "现在去设置页配置吗?",
              variant: "warning",
              confirmLabel: "去设置",
            });
            if (goSettings) {
              // 用 location 而非 navigate hook — 这里不依赖 Router 上下文也能跑
              // (但实际所有调用方都在 Router 内, 安全)
              window.location.assign("/settings");
            }
            return;
          }
          // UP-4: 免费口径以后端 dry-run 的 is_keyless 为权威 — 不计费渠道零"费用/扣费"字样.
          const costDescription = dr.is_keyless
            ? `将用 ${labelOfSource(dr.provider_id)} 生成。\n本地免费渠道 · 不计费。`
            : `将用 ${labelOfSource(dr.provider_id)} 生成。\n` +
              `${dr.estimated_cost_cny != null ? `预估 ¥${dr.estimated_cost_cny.toFixed(4)}` : "预估费用未知"} (${dr.estimated_cost_note})`;
          const ok = await confirm({
            title: `抽 ${count} 张「${displayName ?? "素材"}」?`,
            description: costDescription,
            variant: "default",
            confirmLabel: `抽 ${count} 张`,
          });
          if (!ok) return;
        } catch (e) {
          // dry-run 失败不致命, 给用户决定要不要继续.
          // UP-4: 免费/本地渠道预估失败也绝不出现"费用预估失败/扣费"恐吓.
          const free = isKeylessImageProvider(imageModelRef);
          const ok = await confirm({
            title: free ? `抽 ${count} 张「${displayName ?? "素材"}」?` : "费用预估失败",
            description: free
              ? `本地免费渠道 · 不计费。\n\n仍要抽 ${count} 张吗?`
              : `${e instanceof Error ? e.message : e}\n\n仍要抽 ${count} 张吗?`,
            variant: free ? "default" : "warning",
            confirmLabel: `仍要抽 ${count} 张`,
          });
          if (!ok) return;
        }
      }

      const input: GenerateImageTriggerInput = {
        prompt: editedPrompt, // 铁律 #12: 用 modal 里改过的最新版而非缓存
        negative_prompt: compiled.negative_prompt,
        model_ref: imageModelRef,
        count,
        reference_images: extraReferenceImages,
      };
      try {
        await trigger(input);
      } catch {
        // hook 已经 toast.error, 这里不再重复
      }
    },
    [compiled, imageModelRef, count, dryRun, trigger, displayName, extraReferenceImages, flash],
  );

  // ── 渲染 ───────────────────────────────────────────────────────
  //
  // 2026-05-16 五件 UX: 单一直线流程 — 删除"生成 / 批量再抽" tab 切换 (用户原话"两者
  // 不该并列", 批量再抽本质就是 count > 1, 调整张数即可).

  return (
    <div className="mk-card" style={{ padding: 0, overflow: "hidden" }}>
      <GenerateTab
        slug={target.series_slug}
        userInstruction={userInstruction}
        imageModelRef={imageModelRef}
        llmModelRef={llmModelRef}
        showLlmRow={defaultLlmModelRef !== undefined || onLlmModelChange !== undefined}
        compiling={compiling}
        generating={generating}
        estimating={estimating}
        awaiting={awaiting}
        mode={mode}
        count={count}
        highlightPicker={highlightPicker}
        availableReferenceImages={availableReferenceImages}
        selectedReferenceIds={selectedReferenceIds}
        onSelectedReferenceChange={onSelectedReferenceChange}
        primaryReferenceImageId={primaryReferenceImageId}
        onUserInstructionChange={setUserInstruction}
        onImageModelChange={handleImageModelChange}
        onLlmModelChange={handleLlmModelChange}
        onCountChange={setCount}
        onOpenReview={openReview}
        onPickFromLibrary={onPickFromLibrary}
      />

      {/* 2026-05-18: @mention 浮层由 ComposeBox 内部接管, panel 不再渲染外层 MentionSelector */}

      {/* 提示词审核 modal — 复用 element/PromptReviewModal */}
      {compiled ? (
        <PromptReviewModal
          open={reviewOpen}
          fullPrompt={compiled.full_prompt}
          negativePrompt={compiled.negative_prompt}
          segments={compiled.segments}
          referenceImages={[
            // 2026-05-18 用户原话"复制提示词时所有图片一起放进来": compiled 内的 reference_images
            //   (promptCompiler 产出, 一般是用户主动选定的图) + caller 显式传入的 previewReferenceImages
            //   (extraReferenceImages 是 union 没 url, 补 url 数据走本 prop)
            ...(compiled.reference_images?.map((r) => ({ url: r.url, label: r.label ?? "" })) ?? []),
            ...(previewReferenceImages ?? []),
          ]}
          implicitReferences={previewImplicitReferences ?? []}
          onToggleImplicitRef={onTogglePreviewImplicitRef}
          busy={generating || estimating || awaiting}
          costPreview={costPreviewText}
          title="发送前审核图像提示词"
          onConfirm={(edited) => {
            void doGenerate(edited);
          }}
          onManualImport={onManualImport}
          onClose={() => setReviewOpen(false)}
        />
      ) : null}

      {/* 错误失败 banner — 铁律 #5 真实状态 (lastError 来自 hook) */}
      {lastError ? (
        <div
          style={{
            padding: "8px 16px",
            fontSize: 11.5,
            color: "var(--err, #b91c1c)",
            background: "var(--err-bg, #fef2f2)",
            borderTop: "1px solid var(--err-bd, #fee2e2)",
          }}
        >
          上次失败: {lastError}
        </div>
      ) : null}

      {/* 顶层 flash toast (轻量) */}
      {flashMsg ? (
        <div
          style={{
            position: "fixed",
            bottom: 28,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--ink-900)",
            color: "#fff",
            padding: "8px 16px",
            borderRadius: 999,
            fontSize: 12.5,
            zIndex: 300,
          }}
        >
          {flashMsg}
        </div>
      ) : null}
    </div>
  );
}

// ─── 生成主体 (2026-05-18: textarea + 图像生成 row 全部下沉到 ComposeBox) ─────

interface GenerateTabProps {
  slug: string;
  userInstruction: string;
  imageModelRef: string | null;
  llmModelRef: string | null;
  showLlmRow: boolean;
  compiling: boolean;
  generating: boolean;
  estimating: boolean;
  awaiting: boolean;
  mode: ImageGenerationMode;
  count: number;
  highlightPicker: boolean;
  /** 2026-05-16: 折叠 ReferencePicker — 不传则不渲染 */
  availableReferenceImages?: ElementImage[];
  selectedReferenceIds?: string[];
  onSelectedReferenceChange?: (ids: string[]) => void;
  primaryReferenceImageId?: string;
  onUserInstructionChange: (v: string) => void;
  onImageModelChange: (v: string | null) => void;
  onLlmModelChange: (v: string | null) => void;
  onCountChange: (n: number) => void;
  onOpenReview: (polish: boolean) => void;
  /** P3-2 (2026-05-18): 跨 element 引用图回调 */
  onPickFromLibrary?: () => void;
}

function GenerateTab(props: GenerateTabProps) {
  const {
    slug,
    userInstruction,
    imageModelRef,
    llmModelRef,
    showLlmRow,
    compiling,
    generating,
    estimating,
    awaiting,
    mode,
    count,
    highlightPicker,
    availableReferenceImages,
    selectedReferenceIds,
    onSelectedReferenceChange,
    primaryReferenceImageId,
    onUserInstructionChange,
    onImageModelChange,
    onLlmModelChange,
    onCountChange,
    onOpenReview,
    onPickFromLibrary,
  } = props;

  // busy = 任何阶段不可点 (含 async awaiting SSE 结果) — disable 按钮的统一判定.
  const busy = compiling || generating || estimating || awaiting;

  const showReferencePicker =
    !!availableReferenceImages &&
    availableReferenceImages.length > 0 &&
    !!onSelectedReferenceChange;

  // 2026-05-18 ChatGPT 风格 ComposeBox 用的 busy 标签 — async 模式优先显示队列等待
  const composeBusyLabel = generating
    ? "生图中..."
    : estimating
    ? "估算中..."
    : awaiting
    ? "已加入队列, 等待中..."
    : undefined;

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div className="mk-label" style={{ marginBottom: 0 }}>
          生图
        </div>
        <span style={{ fontSize: 11, color: "var(--ink-400)" }}>
          写指令 → 选模型 → 选张数 → 一键生图。提示词审核弹窗里可改可复制可外送。
        </span>
      </div>

      {/* 2026-05-16: 快捷参考图区 (折叠) — 用户原话"应该体现在我想添加/生成新图片的时候".
          仅在 caller 传 availableReferenceImages 时渲染. */}
      {showReferencePicker ? (
        <ReferencePicker
          images={availableReferenceImages!}
          selectedIds={selectedReferenceIds ?? []}
          primaryImageId={primaryReferenceImageId}
          onChange={onSelectedReferenceChange!}
          title="快捷参考已有图(勾上的图会一起发给模型作参考)"
          defaultOpen={false}
          onPickFromLibrary={onPickFromLibrary}
        />
      ) : null}

      {/* Row 1: LLM 润色行 (可选, 不传 llmModelChange 则隐藏) — 保留作可选 AI 润色入口 */}
      {showLlmRow ? (
        <div
          style={{
            padding: 10,
            background: "var(--surface-canvas, #fafafa)",
            borderRadius: 8,
            border: "1px solid var(--ink-100)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="sparkles" size={12} style={{ color: "var(--ink-500)" }} />
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ink-700)" }}>
              AI 润色提示词
            </span>
            <span
              style={{
                fontSize: 10.5,
                color: "var(--ink-400)",
                padding: "1px 6px",
                border: "1px dashed var(--ink-300)",
                borderRadius: 999,
              }}
            >
              可选
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <ModelPicker kind="text" value={llmModelRef} onChange={onLlmModelChange} size="sm" />
            <Button
              variant="secondary"
              size="sm"
              iconLeft="sparkles"
              onClick={() => onOpenReview(true)}
              disabled={busy}
              loading={compiling}
              title="先调文字模型把零散信息润色成自包含提示词, 再审核生图"
            >
              {compiling ? "润色中…" : "AI 润色 + 审核"}
            </Button>
          </div>
          <p style={{ fontSize: 10.5, color: "var(--ink-400)", margin: 0, lineHeight: 1.5 }}>
            润色 = LLM 把零散描述拼成自包含完整提示词。不选 LLM 模型也行 — 直接走下方"生图"用模板原文。
          </p>
        </div>
      ) : null}

      {/* 2026-05-18: ChatGPT 风格 ComposeBox — 替代原 textarea + Row 2 图像生成行.
          用户原话: "图片生成界面也要这样啊, 这种逻辑完全可以复用的, 没必要一改改好几处".
          textarea + @ 召唤 + 候选数 + ModelPicker + 抽卡按钮 全部融合在一个圆角卡里. */}
      <ComposeBox
        kind="image"
        slug={slug}
        value={userInstruction}
        onChange={onUserInstructionChange}
        modelRef={imageModelRef}
        onModelChange={onImageModelChange}
        count={count}
        onCountChange={onCountChange}
        busy={busy}
        busyLabel={composeBusyLabel}
        onDraw={() => onOpenReview(false)}
        onPreviewPrompt={() => onOpenReview(false)}
        modelPickerHighlight={highlightPicker}
        placeholder={
          mode === "async"
            ? "本次生图要求, 如「生成一个穿西服的全身照」。提交后立即返队列, SSE 推回结果。输入 @ 召唤素材。"
            : "本次生图要求, 如「生成一个穿西服的全身照」。可选 AI 润色或直接发原文。输入 @ 召唤素材。"
        }
        drawLabel="生图"
        countPresets={[1, 2, 3, 5, 10]}
      />
    </div>
  );
}

export default ImageGenerationPanel;
