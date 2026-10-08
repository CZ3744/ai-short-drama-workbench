/**
 * RegenModal — 在候选图上"用此图微调重抽"弹窗 (W7-cand-ux · 2026-05-15)
 *
 * 触发场景:
 *   - 候选卡 hover 出"用此图微调重抽" → 打开本 modal
 *   - 失败卡上"重新生成 + 修改意见" → 打开本 modal(可选)
 *   - Wave A (2026-05-16) ElementWorkbench Lightbox actions → "用此图微调" → 打开本 modal
 *
 * Wave A (2026-05-16) 重设计:
 *   - **两种模式 tab**: "整图微调"(i2i — 当前实现) / "局部涂抹"(inpaint — 嵌入 InpaintCanvas)
 *   - "整图微调"是默认 tab,文本/模型/参考图 state 两 tab 共享
 *   - "局部涂抹"启用时把局部参数(画笔/橡皮/mask)交给嵌入的 InpaintCanvas
 *
 * 设计原则 (对照 12 条 UX 铁律):
 *   - 铁律#2 可干预性: 提供 ModelPicker + "查看完整提示词" + "复制走外部生" 三种干预手段
 *   - 铁律#4 就近决策: ModelPicker 在 modal 内,不要求跳回主页
 *   - 铁律#11 按钮有名字: 所有按钮都是 icon + 文字
 *   - 铁律#12 批改+发送一致: textarea 最新值经 confirm 直接传出
 *
 * 后端契约:
 *   - 整图微调: 调用方拿到 (extraText, modelRef) 后调统一图像 endpoint(i2i_base + reference_images)
 *   - 局部涂抹: 调用方拿到 (extraText, maskBase64, modelRef) 后调 inpaint endpoint(vault_inpaint)
 *
 * 复用模式: 类似 PromptReviewModal,但**额外多一栏原图大缩略图 + 修改意见 textarea + 两 tab**.
 */

import { useEffect, useState } from "react";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { InpaintCanvas } from "../vault/InpaintCanvas";
import { ReferencePicker } from "../element/ReferencePicker";
import { ComposeBox } from "./ComposeBox";
import { BaseDialog } from "../ui/BaseDialog";
// W11 A3: 提示词预览渲染统一真理源
import { PromptPreviewBlock } from "../shared/PromptPreviewBlock";
import type { ElementImage } from "../../lib/elementApi";
import type { PromptPreview } from "../../lib/shotApi";

/** Wave A (2026-05-16): RegenModal 两种重抽模式 */
export type RegenMode = "i2i" | "inpaint";

/** Wave A: 模式 tab 描述 */
const REGEN_TABS: Array<{ value: RegenMode; label: string; hint: string }> = [
  {
    value: "i2i",
    label: "整图微调",
    hint: "把整张图作参考,加修改意见,模型重新生成一张完整新图",
  },
  {
    value: "inpaint",
    label: "局部涂抹",
    hint: "在图上涂抹要改的区域,只重抽这一块,其余地方保持不变",
  },
];

export interface RegenModalProps {
  open: boolean;
  /** 用于重抽参考的原图缩略图 url(必填,展示用) */
  sourceImageUrl: string;
  /** 原图来源标签(provider 翻译过的人话, 仅展示) */
  sourceLabel?: string;
  /** 当前 image_model_ref(可改) */
  modelRef: string | null;
  onModelRefChange: (v: string | null) => void;
  /** 用户填写的修改意见 */
  defaultExtra?: string;
  /** 已有的提示词预览(可选,有就在 modal 内展示;没有调用方拉一下) */
  promptPreview?: string;
  /**
   * 2026-05-27 P1-1 — 真 negative 预览. 之前 RegenModal 内硬塞 ""(违反铁律 #13
   * 完整提示词审核必含全部内容), 用户看到"无 negative" 但 orchestrator 实际发了
   * default + shot.negative_prompt. 现在 caller 传真值过来.
   */
  negativePromptPreview?: string;
  /** 是否正在重抽 */
  busy?: boolean;
  /**
   * 点击"开始重抽"确认(整图微调)
   * 2026-05-17: mode = "full"(默认,后端用 buildShotPromptInput 拼完整 prompt)
   *           / "compact"(简洁,仅用户追加要求 + @素材 + 原图)
   * 用户原话: "避免写大段初次生成的完整提示词,让模型误以为是重新生图"
   */
  onConfirm: (extra: string, mode: "full" | "compact") => void;
  /** "查看完整提示词"按钮 — 让父组件可以再开 PromptReviewModal */
  onPreviewPrompt?: (currentExtra: string) => void;
  /** "复制提示词 + 下载原图" — 父决定如何打包文本到剪贴板 */
  onCopyForExternal?: (extra: string) => void;
  onClose: () => void;

  /** Wave A (2026-05-16): 局部涂抹依赖 vault_id — 没传则禁用局部 tab */
  inpaintVaultId?: string;
  /** 局部涂抹成功回调(InpaintCanvas onInpainted)— 没传则不允许进局部 tab */
  onInpainted?: (vaultId: string) => void;

  /** Wave A (2026-05-16): 附加参考图 chips(只读展示,父组件管理选择)*/
  extraReferences?: Array<{ url: string; label?: string }>;
  /** "管理参考图"按钮 — 点击通常让父滚到 ReferencePicker / 弹选图器 */
  onManageReferences?: () => void;

  /**
   * 2026-05-16 五件 UX: 把 caller 的图库列表传进来, RegenModal 直接渲染折叠 ReferencePicker.
   * 用户原话: "应该体现在我想添加/生成新图片的时候,而不是摆在主页"
   *
   * 不传则回退到原有 extraReferences 只读 chip 行为 (向后兼容 ShotStagePage).
   * 传了则在弹窗内显示完整勾选 UI, 用户在 modal 内直接挑参考图.
   */
  availableReferenceImages?: ElementImage[];
  selectedReferenceIds?: string[];
  onSelectedReferenceChange?: (ids: string[]) => void;
  primaryReferenceImageId?: string;
  /** P3-2 (2026-05-18): 跨 element 引用图回调 */
  onPickFromLibrary?: () => void;

  /**
   * 2026-05-17 精修:启用"修改意见" textarea 的 @ mention 素材引用浮层.
   * caller 传 series slug 即可启用,选中的素材会作为 token 插入 textarea 文本中.
   * 用户原话: "这个界面写 @ 没有弹窗,这里也要加上素材引用".
   * 与 ShotStagePage 同款 MentionSelector,数据源复用.
   */
  projectSlug?: string;

  /**
   * 2026-05-17: 是否显示"提示词模式"(完整/简洁)切换 UI.
   * 用户原话:"避免大段初次 prompt 误导模型"。
   * 当前 ShotStagePage 的 regen-from-reject endpoint 已支持 compact_mode 参数;
   * ElementWorkbench 走另一条 backend 路径,暂未接通 → 隐藏 toggle 避免误导.
   * caller 显式传 true 才启用.
   */
  enableCompactMode?: boolean;

  /**
   * W11 A5 (2026-05-27): 打开时默认进哪个 tab — "i2i"(整图微调, 默认) / "inpaint"(画笔局部修改).
   * 用户原话: "对已有图片进行提示词反馈重抽的功能哪儿去了? 之前有文字+画笔写修改意见的, 恢复一下".
   * 画笔实际上没删 — 进 RegenModal 后切第 2 tab 就是 InpaintCanvas, 但**入口太隐**用户找不到.
   * 让候选卡 ⋯ 菜单的"画笔局部修改"项调本 modal 时显式 defaultTab="inpaint", 一进来直接是画笔模式.
   */
  defaultTab?: RegenMode;
}

export function RegenModal(props: RegenModalProps) {
  const {
    open, sourceImageUrl, sourceLabel,
    modelRef, onModelRefChange,
    defaultExtra = "", promptPreview,
    negativePromptPreview = "",
    busy = false,
    onConfirm, onPreviewPrompt, onCopyForExternal,
    onClose,
    inpaintVaultId, onInpainted,
    extraReferences = [],
    onManageReferences,
    availableReferenceImages,
    selectedReferenceIds,
    onSelectedReferenceChange,
    primaryReferenceImageId,
    onPickFromLibrary,
    projectSlug,
    enableCompactMode = false,
    defaultTab = "i2i",
  } = props;

  // 2026-05-18: @mention 浮层 / textarea 处理全部下沉到 ComposeBox 内部.
  //   ComposeBox 通过 onMentionAsset (可选) 回调 — RegenModal 入口默认仅插入 token 文本.

  // 2026-05-16: 是否启用内嵌 ReferencePicker (caller 传了完整 picker 三件套就启用)
  const showInlineReferencePicker =
    !!availableReferenceImages &&
    availableReferenceImages.length > 0 &&
    !!onSelectedReferenceChange;

  const [extra, setExtra] = useState(defaultExtra);
  const [zoom, setZoom] = useState(false);
  // Wave A: tab 切换 — W11 A5 加 defaultTab 让 caller 控制 (画笔入口直接进 inpaint)
  const [mode, setMode] = useState<RegenMode>(defaultTab);
  // 2026-05-17: prompt 拼接模式 — full(默认完整) / compact(简洁,只发用户追加+原图+@素材)
  const [promptMode, setPromptMode] = useState<"full" | "compact">("full");

  useEffect(() => {
    if (open) {
      setExtra(defaultExtra);
      setMode(defaultTab);
      setPromptMode("full");
    }
  }, [open, defaultExtra, defaultTab]);

  // 2026-05-19 #4: 局部涂抹 tab 总能点 (用户原话"不论这张图存在哪个池都必须能开").
  // 进入 tab 后内部按 vault_id 是否存在分支: 有 → 真涂抹; 无 → 友好 CTA 引导用户先入档.
  const canInpaint = !!onInpainted;
  const hasVaultForInpaint = !!inpaintVaultId;

  if (!open) return null;

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      iconName="sparkles"
      title="用此图微调重抽"
      ariaLabel="用此图微调重抽"
      maxWidth={mode === "inpaint" ? 960 : 720}
      zIndex={220}
      busy={busy}
    >
        {/* Wave A (2026-05-16): 两 tab 切换 — 整图微调 / 局部涂抹 */}
        <div
          role="tablist"
          aria-label="重抽方式"
          style={{
            display: "flex",
            gap: 2,
            marginBottom: 12,
            borderBottom: "1px solid var(--ink-100)",
          }}
        >
          {REGEN_TABS.map((t) => {
            const active = mode === t.value;
            // 2026-05-19 #4: 局部涂抹 tab 总可点. 内部按 vault_id 是否存在分支兜底.
            const disabled = false;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={busy}
                onClick={() => setMode(t.value)}
                title={t.hint}
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  border: "none",
                  borderBottom: active
                    ? "2px solid var(--brand-600)"
                    : "2px solid transparent",
                  background: "transparent",
                  color: active
                    ? "var(--brand-700)"
                    : disabled
                      ? "var(--ink-300)"
                      : "var(--ink-500)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: disabled || busy ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <Icon
                  name={t.value === "i2i" ? "sparkles" : "edit"}
                  size={12}
                />
                {t.label}
              </button>
            );
          })}
        </div>

        <p style={{ fontSize: 12, color: "var(--ink-500)", marginTop: 0, marginBottom: 12 }}>
          {mode === "i2i"
            ? "以这张图作为参考底图,把你想要的差异填到下方\"修改意见\",系统会把\"原提示词 + 你的修改意见 + 此图作参考\"打包重抽一张新图。"
            : "在下方画布上涂抹你想改的区域,填修改意见,只重抽涂抹的部分,其它地方保持原样。"}
        </p>

        {/* 2026-05-19 #4: 局部涂抹 tab 内 inline 嵌入 InpaintCanvas. 没 vault_id 时给友好 CTA. */}
        {mode === "inpaint" ? (
          hasVaultForInpaint && canInpaint && inpaintVaultId ? (
            <InpaintCanvas
              inline
              open
              vaultId={inpaintVaultId}
              sourceImageUrl={sourceImageUrl}
              onClose={onClose}
              onInpainted={(result) => {
                onInpainted?.(result.vault_id);
                onClose();
              }}
            />
          ) : (
            <div style={{
              padding: "24px 20px", borderRadius: 10,
              background: "var(--ink-50)", color: "var(--ink-700)",
              fontSize: 13, lineHeight: 1.7,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <Icon name="info" size={16} style={{ color: "var(--brand-600)" }} />
                <strong style={{ fontSize: 14 }}>这张图还没存入资料库</strong>
              </div>
              <p style={{ margin: "4px 0 12px", color: "var(--ink-500)" }}>
                局部涂抹需要这张图先存入资料库才能用. 切到 <strong>"整图微调"</strong> tab 重抽一次, 新版本会自动入档, 之后这张新图就可以局部涂抹.
              </p>
              <Button
                variant="primary"
                iconLeft="sparkles"
                onClick={() => setMode("i2i")}
                style={{ marginTop: 4 }}
              >
                切到 整图微调
              </Button>
            </div>
          )
        ) : null}

        {/* 2026-05-17 整合: 以下内容只在"整图微调"tab 显示 */}
        {mode === "i2i" ? <>

        {/* 2026-05-16 五件 UX: 内嵌折叠 ReferencePicker (整图微调 tab + 父传完整 props 时启用).
            用户原话: "应该体现在我想添加/生成新图片的时候".
            ShotStagePage 等不传 picker props 的 caller 回退到下面只读 chip 行为 (向后兼容). */}
        {mode === "i2i" && showInlineReferencePicker ? (
          <div style={{ marginBottom: 12 }}>
            <ReferencePicker
              images={availableReferenceImages!}
              selectedIds={selectedReferenceIds ?? []}
              primaryImageId={primaryReferenceImageId}
              onChange={onSelectedReferenceChange!}
              title="附加参考图(勾上的图会和这张参考底图一起发给模型)"
              defaultOpen={false}
              onPickFromLibrary={onPickFromLibrary}
            />
          </div>
        ) : null}

        {/* Wave A: 附加参考图 chips(整图微调时显示,inpaint 局部涂抹时这些不参与)*/}
        {mode === "i2i" && !showInlineReferencePicker && extraReferences.length > 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              marginBottom: 12,
              background: "var(--brand-50, #fff7ed)",
              border: "1px solid var(--brand-200, rgba(217,119,87,0.3))",
              borderRadius: 6,
              flexWrap: "wrap",
            }}
          >
            <Icon name="image" size={12} style={{ color: "var(--brand-700)" }} />
            <span style={{ fontSize: 11.5, color: "var(--brand-700)", fontWeight: 700 }}>
              附加参考图 · {extraReferences.length} 张
            </span>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
              {extraReferences.slice(0, 8).map((r, i) => (
                <img
                  key={i}
                  src={r.url}
                  alt={r.label ?? "参考图"}
                  title={r.label ?? "参考图"}
                  style={{
                    width: 36,
                    height: 36,
                    objectFit: "cover",
                    borderRadius: 4,
                    border: "1px solid var(--ink-200)",
                  }}
                />
              ))}
            </div>
            {onManageReferences ? (
              <button
                type="button"
                className="mk-btn mk-btn--ghost mk-btn--sm"
                style={{ height: 26, fontSize: 11.5 }}
                onClick={onManageReferences}
                title="切换勾选其他图作参考"
              >
                <Icon name="settings" size={11} /> 管理参考图
              </button>
            ) : null}
          </div>
        ) : null}

        {/* 原图大缩略 */}
        <div style={{
          display: "grid", gridTemplateColumns: "200px 1fr", gap: 16,
          marginBottom: 14,
        }}>
          <div>
            {/* W7-regen-fix: 改用 <img> 而非 background-image, 让用户右键能"复制图片"到剪贴板,
               直接粘贴到外部 AI 渠道(此前 div + background-image 右键菜单没有"复制图片"). */}
            {sourceImageUrl ? (
              <img
                src={sourceImageUrl}
                alt="原图(将作为参考底图 — 右键可复制图片)"
                title="点击放大查看 / 右键可复制图片到剪贴板(直接粘贴到任意外部 AI)"
                onClick={() => setZoom(true)}
                style={{
                  width: 200, height: 200, objectFit: "cover",
                  borderRadius: 6, border: "1px solid var(--ink-150)",
                  cursor: "zoom-in", display: "block",
                }}
              />
            ) : (
              <div
                style={{
                  width: 200, height: 200, borderRadius: 6,
                  border: "1px solid var(--ink-150)", background: "var(--ink-50)",
                  display: "grid", placeItems: "center", color: "var(--ink-400)",
                }}
              >
                <Icon name="image" size={24} />
              </div>
            )}
            <div style={{
              fontSize: 11, color: "var(--ink-500)",
              marginTop: 6, textAlign: "center", fontWeight: 600,
            }}>
              {sourceLabel ? `来源: ${sourceLabel}` : "原图(将作为参考底图)"}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <div className="mk-label" style={{ marginBottom: 4, fontSize: 11.5, fontWeight: 700, color: "var(--ink-500)" }}>
                修改意见(描述你想怎么改这张图)
              </div>
              {/* 2026-05-18: ChatGPT 风格 ComposeBox 替代原 textarea + ModelPicker + 开始重抽按钮.
                  modelRef / extra / onModelRefChange 直接接到 caller 已有的双向绑定, 不破坏外部契约.
                  count 固定 1 (重抽一张), countPresets=[] 隐藏 row.
                  drawLabel = "开始重抽" — 抽卡按钮在 ComposeBox 右下角. */}
              <ComposeBox
                kind="image"
                slug={projectSlug ?? "_default"}
                value={extra}
                onChange={setExtra}
                modelRef={modelRef}
                onModelChange={onModelRefChange}
                count={1}
                onCountChange={() => { /* 重抽固定 1 张, 无需 caller 处理 */ }}
                busy={busy}
                onDraw={() => onConfirm(extra, promptMode)}
                placeholder={projectSlug
                  ? "比如: 把背景换成雨夜街头 · 人物表情更紧张 · 增加电影感颗粒 — 输 @ 可引用角色/场景/素材。空着也可以 (= 原提示词 + 这张参考底图再抽一张)。"
                  : "比如: 把背景换成雨夜街头 · 人物表情更紧张 · 增加电影感颗粒 · 镜头拉近一点。空着也可以 (= 原提示词 + 这张参考底图再抽一张)。"}
                drawLabel="开始重抽"
                countPresets={[]}
              />
            </div>

            {/* 2026-05-17: 提示词模式选择(完整 vs 简洁) — 用户原话"避免大段初次 prompt 误导模型"
                只在 caller 显式启用时显示(enableCompactMode=true),ElementWorkbench 走不同 backend 暂不显示 */}
            {enableCompactMode ? (
            <div>
              <div className="mk-label" style={{ marginBottom: 4, fontSize: 11.5, fontWeight: 700, color: "var(--ink-500)" }}>
                提示词模式
              </div>
              <div style={{ display: "flex", gap: 6 }} role="radiogroup" aria-label="提示词模式">
                <button
                  type="button"
                  role="radio"
                  aria-checked={promptMode === "full"}
                  onClick={() => setPromptMode("full")}
                  disabled={busy}
                  style={{
                    flex: 1, padding: "8px 10px", borderRadius: 6, fontSize: 12,
                    border: `1px solid ${promptMode === "full" ? "var(--brand-500)" : "var(--ink-200)"}`,
                    background: promptMode === "full" ? "var(--brand-50)" : "var(--surface-card)",
                    color: promptMode === "full" ? "var(--brand-700)" : "var(--ink-700)",
                    fontWeight: promptMode === "full" ? 700 : 500,
                    cursor: busy ? "not-allowed" : "pointer",
                    textAlign: "left",
                  }}
                  title="走完整 prompt 拼接(分镜上下文 + 角色 + 关键参数 + 你的修改意见)"
                >
                  <div>完整模式 <span style={{ fontSize: 10.5, color: "var(--ink-500)", fontWeight: 400 }}>· 默认</span></div>
                  <div style={{ fontSize: 10.5, color: "var(--ink-500)", fontWeight: 400, marginTop: 2 }}>
                    拼接分镜/角色/参数,模型完整了解上下文
                  </div>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={promptMode === "compact"}
                  onClick={() => setPromptMode("compact")}
                  disabled={busy}
                  style={{
                    flex: 1, padding: "8px 10px", borderRadius: 6, fontSize: 12,
                    border: `1px solid ${promptMode === "compact" ? "var(--brand-500)" : "var(--ink-200)"}`,
                    background: promptMode === "compact" ? "var(--brand-50)" : "var(--surface-card)",
                    color: promptMode === "compact" ? "var(--brand-700)" : "var(--ink-700)",
                    fontWeight: promptMode === "compact" ? 700 : 500,
                    cursor: busy ? "not-allowed" : "pointer",
                    textAlign: "left",
                  }}
                  title="只发用户追加 + @素材 + 原图给模型, 避免初次完整 prompt 让模型误以为是重新生图"
                >
                  <div>简洁模式</div>
                  <div style={{ fontSize: 10.5, color: "var(--ink-500)", fontWeight: 400, marginTop: 2 }}>
                    只发你的修改意见 + 原图 + @素材,微调更准
                  </div>
                </button>
              </div>
            </div>
            ) : null}
          </div>
        </div>

        {/* 2026-05-19 #5: 提示词预览默认展开 — 用户原话"信息直接可见 > 模式切换".
            W11 A3 (2026-05-27): 走共享 PromptPreviewBlock — 跟首帧/视频候选区 details 同一渲染规则.
            注: RegenModal 拿的是字符串 (caller 传 livePreview.composed_prompt), 这里包成 PromptPreview 形.
            actions 留给底部行(查看完整提示词 / 复制+下载原图按钮已在下方). */}
        {promptPreview && (
          <details open style={{ marginBottom: 14 }}>
            <summary style={{
              fontSize: 11.5, fontWeight: 700, color: "var(--ink-600)", cursor: "pointer",
              userSelect: "none",
            }}>
              查看将拼接的"原提示词"(只读,你只能改上面的修改意见)
            </summary>
            <PromptPreviewBlock
              livePreview={{
                ok: true,
                kind: "image",
                base: promptPreview,
                composed_prompt: promptPreview,
                segments: [],
                connected_assets: [],
                // 2026-05-27 P1-1: 真 negative 透给 PromptPreviewBlock (默认展开显示)
                negative_prompt: negativePromptPreview,
                suggested_references: [],
              } satisfies PromptPreview}
              customActions={null}
              maxHeight={180}
            />
          </details>
        )}

        {/* 2026-05-18: 底部辅助按钮 — 主"开始重抽"按钮已移入 ComposeBox 右下角.
            外送类按钮 (查看完整提示词 / 复制提示词 + 下载原图 / 取消) 仍在底部. */}
        <div style={{
          display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between",
          flexWrap: "wrap", marginTop: 10,
        }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {onPreviewPrompt && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft="doc"
                onClick={() => onPreviewPrompt(extra)}
                disabled={busy}
                title="打开完整提示词审核窗 — 把你的修改意见拼进 prompt 再深度编辑。关闭后会自动返回本窗"
              >
                查看完整提示词
              </Button>
            )}
            {onCopyForExternal && (
              <Button
                variant="secondary"
                size="sm"
                iconLeft="copy"
                onClick={() => onCopyForExternal(extra)}
                disabled={busy}
                title="复制提示词 + 下载原图,在外部 AI 渠道生成后回到候选区粘贴 / 拖入即可导入"
              >
                复制提示词 + 下载原图
              </Button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              iconLeft="close"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </Button>
          </div>
        </div>
        </> : null}

      {/* 2026-05-18: @mention 浮层由 ComposeBox 内部接管 */}

      {/* 二级 lightbox - 原图放大 (overlay 在 BaseDialog 内, zIndex 240 高于 dialog 220) */}
      {zoom && sourceImageUrl && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 240,
            background: "rgba(0,0,0,0.85)",
            display: "grid", placeItems: "center", padding: 24,
          }}
          onClick={() => setZoom(false)}
        >
          <img
            src={sourceImageUrl}
            alt="放大原图"
            style={{
              maxWidth: "92vw", maxHeight: "92vh",
              borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
              cursor: "zoom-out",
            }}
            onClick={(e) => { e.stopPropagation(); setZoom(false); }}
          />
        </div>
      )}
    </BaseDialog>
  );
}

export default RegenModal;
