/**
 * PromptReviewModal — 发送前提示词深度审核弹窗 (§11 共享组件)
 *
 * 兼容两种用法：
 * 1. ElementWorkbench: fullPrompt + negativePrompt + referenceImages + busy + onConfirm
 * 2. ShotStagePage:    fullPrompt + negativePrompt + segments(可选) + loading + onConfirm + onPromptChange(可选)
 *
 * title 可选：ElementWorkbench 用默认标题，ShotStagePage 传"审核 motion_prompt"
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../shared/Icon";
import { BaseDialog } from "../ui/BaseDialog";
import { copyPromptWithImages } from "../../lib/copyPromptWithImages";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { useConfirm } from "../ui/ConfirmModal";

export interface PromptPreviewSegment {
  label: string;
  text: string;
}

/**
 * Wave B-2 (2026-05-16): 系统自动建议的参考图(来自角色/场景/素材主图).
 *
 * 与"用户手选的 referenceImages"区分展示, 并给用户单张取消按钮(铁律 #2 可干预性).
 * 取消后通过 onToggleImplicitRef 回调通知 caller 把这张排除出最终 reference_images.
 */
export interface ImplicitReferenceItem {
  /** 后端 asset_id — caller 用它在 reference_images 里筛/合 */
  asset_id: string;
  url: string;
  /** 人类可读标签 — 例: "角色「小明」主图" */
  label: string;
  /** 是否当前激活(true=会发送给模型, false=用户已取消) */
  active: boolean;
  /** 来源分组 — 用于显示来源 chip.
   * 2026-05-28 P1#15+40: 扩 character_wardrobe / character_prop / shot_prop,
   * 跟 SuggestedReference 的 source enum 对齐.
   */
  source:
    | "character_primary"
    | "scene_primary"
    | "element_primary"
    | "character_wardrobe"
    | "character_prop"
    | "shot_prop";
  source_name: string;
}

export interface PromptReviewModalProps {
  open: boolean;
  /**
   * 2026-05-27 — kind 标识让内部 hover title / 占位文案按"生图 vs 生视频"区分,
   * 之前 hardcoded "生图模型" 视频弹窗也照搬, 用户看到首帧弹窗里说"视频" / 视频
   * 弹窗里说"生图" 都串过. 不传时按"图"兜底 (历史 caller).
   */
  kind?: "image" | "video";
  /** 完整提示词（可编辑） */
  fullPrompt: string;
  /** 负向提示词（可选，只读展示） */
  negativePrompt?: string;
  /** 用户手选的附带参考图（ElementWorkbench / ShotStagePage 用 — 永远会发送） */
  referenceImages?: Array<{ url: string; label: string }>;
  /**
   * Wave B-2: 系统从角色/场景/素材主图自动收集的"建议参考图".
   * 与用户手选分组显示, 各张可独立取消. 默认全部 active=true.
   */
  implicitReferences?: ImplicitReferenceItem[];
  /** 用户在 modal 内点取消/恢复时回调 — caller 用它更新 active 状态 */
  onToggleImplicitRef?: (asset_id: string, nextActive: boolean) => void;
  /** 拼接结构段落（ShotStagePage 用） */
  segments?: PromptPreviewSegment[];
  /** 是否正在生成/加载 */
  busy?: boolean;
  loading?: boolean;
  /** 弹窗标题（默认：发送前审核完整提示词） */
  title?: string;
  /** 确认回调，参数为用户可能已编辑的完整提示词 */
  onConfirm: (editedPrompt: string) => void;
  /** 导入用户在外部 AI 生成的图片/结果 */
  onManualImport?: (files: File[]) => Promise<void> | void;
  onClose: () => void;
  /** ShotStagePage 需要双向绑定提示词时使用 */
  onPromptChange?: (v: string) => void;
  /**
   * 2026-07-22 X9-1: 主确认按钮文案覆盖. 不传 → "确认生成"(历史 caller 行为不变).
   * InpaintCanvas 传"应用修改并返回"—— 该 caller 的 onConfirm 不触发生成, 只把弹窗里
   * 改过的文字解析回写到画布"这块换成"输入框, 回画布再点"生成"才真发起 (按钮文案与真实行为一致).
   */
  confirmLabel?: string;
  /**
   * 2026-07-22 X9-1: 顶部说明文案覆盖 (ReactNode). 不传 → 默认"①直接发送 / ②复制走自己生"双路说明.
   * 供 InpaintCanvas 这类"预览 + 应用修改"而非"直接发送"的 caller 讲清楚点主按钮会发生什么.
   */
  introHint?: ReactNode;
  /**
   * 2026-07-22 Y6 UP-8: 成本预告一行 — 就近决策(铁律 #4), 让 caller 把"这次生成大概花多少钱"
   * 直接塞进审核弹窗底部, 不必再另开一层"成本确认门"弹窗问同一件事.
   * 例: "预估 ¥0.12 · 本地 SDXL" 或 "免费 · 不计费(本地渠道)"。
   * 不传 = 不显示这一行(向后兼容, 现有 caller 行为不变 —— 这是纯新增可选能力, 需要 caller
   * 自行判断是否用它替代/合并原本独立的成本确认弹窗)。
   */
  costPreview?: ReactNode;
}

/**
 * 2026-05-28 P1#15+40: source 细分 → 人话 label.
 * 后端 implicitReferenceCollector 产 6 种 source, 前端给 UI 显示人类能看懂的分组.
 */
function sourceCategoryLabel(source: ImplicitReferenceItem["source"]): string {
  switch (source) {
    case "character_primary":
      return "角色主图";
    case "character_wardrobe":
      return "角色服装";
    case "character_prop":
      return "角色道具";
    case "scene_primary":
      return "场景主图";
    case "element_primary":
      return "素材主图";
    case "shot_prop":
      return "镜头道具";
    default:
      return "其他";
  }
}

export function PromptReviewModal(props: PromptReviewModalProps) {
  const {
    open,
    kind = "image",
    fullPrompt,
    negativePrompt = "",
    referenceImages = [],
    implicitReferences = [],
    onToggleImplicitRef,
    segments = [],
    busy = false,
    loading = false,
    title = "发送前审核完整提示词",
    onConfirm,
    onManualImport,
    onClose,
    onPromptChange,
    confirmLabel,
    introHint,
    costPreview,
  } = props;
  // 2026-05-27 — kind-aware 文案
  const kindLabel = kind === "video" ? "生视频模型" : "生图模型";

  const [draft, setDraft] = useState(fullPrompt);
  const manualImportRef = useRef<HTMLInputElement | null>(null);
  const confirm = useConfirm();
  // 2026-05-17: "复制全部含图" 状态 - 给外部 AI 直接发用
  const [copyingAll, setCopyingAll] = useState(false);
  const [copyAllStatus, setCopyAllStatus] = useState<string | null>(null);

  // 2026-05-26 W8-C 字段模式 — 按 segments (角色/场景/动作/镜头/运镜/光线/字幕/风格) 逐段编辑.
  // 与 "全文模式" 切换: 字段→全文时按固定顺序拼回完整 prompt; 全文→字段时若用户改过全文 (脱离了
  // 字段拼接结果) 弹提示保留全文优先 (铁律 #12 不丢用户改动).
  const [editMode, setEditMode] = useState<"full" | "fields">("full");
  // 字段模式下: 每段的编辑文本 (按 segment.label 索引). 初始化 = segments 原文.
  const [fieldEdits, setFieldEdits] = useState<Record<string, string>>({});
  // 切到字段模式时初始化 fieldEdits
  useEffect(() => {
    if (editMode === "fields") {
      const initial: Record<string, string> = {};
      for (const s of segments) initial[s.label] = s.text;
      setFieldEdits(initial);
    }
  }, [editMode, segments]);

  useEffect(() => {
    setDraft(fullPrompt);
  }, [fullPrompt, open]);

  // 字段模式 → 全文: 把所有字段按 segments 顺序拼回完整 prompt (与 shotPromptCompiler 同款格式).
  function recomposeFromFields(): string {
    return segments
      .map((s) => {
        const txt = (fieldEdits[s.label] ?? s.text).trim();
        if (!txt) return "";
        return `【${s.label}】\n${txt}`;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  // 切换模式时的处理
  async function toggleEditMode() {
    if (editMode === "fields") {
      // 字段→全文: 用字段拼回 draft (用户在字段里改的全部带回全文)
      const recomposed = recomposeFromFields();
      setDraft(recomposed);
      onPromptChange?.(recomposed);
      setEditMode("full");
    } else {
      // 全文→字段: 切之前比较 draft 跟"原拼接 fullPrompt"是否被改过.
      // 改过 = 用户在全文里加了不在 segments 里的内容, 切到字段会丢, 给提示.
      const originalComposed = segments
        .map((s) => `【${s.label}】\n${s.text}`)
        .join("\n\n");
      if (draft.trim() && draft.trim() !== originalComposed.trim() && draft.trim() !== fullPrompt.trim()) {
        // 2026-05-27 — 改 useConfirm() 网页级弹窗 (CLAUDE.md 铁律 #6 禁原生).
        const ok = await confirm({
          title: "切到字段模式会丢失全文改动?",
          description: "你在全文里加的、不在分段里的内容会丢. 建议先复制完整提示词留底, 或把额外修改写到「用户额外要求」字段里.",
          confirmLabel: "继续切换",
          cancelLabel: "留在全文",
          variant: "warning",
        });
        if (!ok) return;
      }
      setEditMode("fields");
    }
  }

  if (!open) return null;

  function copy(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  // 2026-05-17: 一键复制 文字+所有图片 markdown - 用户原话"发给其他 AI 复用"
  // 实现已抽到 lib/copyPromptWithImages.ts 共享 helper (铁律 #13)
  async function copyAllWithImages() {
    setCopyingAll(true);
    setCopyAllStatus(null);
    try {
      const allImages = [
        ...referenceImages.map(r => ({ url: r.url, label: r.label })),
        ...implicitReferences.filter(r => r.active).map(r => ({ url: r.url, label: r.label })),
      ];
      const result = await copyPromptWithImages({
        fullPrompt: draft,
        negativePrompt: negativePrompt || undefined,
        images: allImages,
      });
      setCopyAllStatus(result.message);
      setTimeout(() => setCopyAllStatus(null), 4000);
    } catch (e) {
      setCopyAllStatus(`复制失败: ${e instanceof Error ? e.message : String(e)}`);
      setTimeout(() => setCopyAllStatus(null), 4000);
    } finally {
      setCopyingAll(false);
    }
  }

  function handleChange(v: string) {
    setDraft(v);
    onPromptChange?.(v);
  }

  const isBusy = busy || loading;
  // 2026-05-22: loading (拉取提示词) 跟 busy (真生成) 区分 — loading 时关闭按钮可点 (用户不被困在 modal),
  // 只 busy=true 才锁定. 用户原话: "生成过程中不能关闭弹窗".
  const lockClose = busy;

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      title={title}
      ariaLabel={typeof title === "string" ? title : undefined}
      maxWidth={680}
      zIndex={250}
      busy={lockClose}
      footer={
        <>
          {/* 2026-07-22 Y6 UP-8: 成本预告一行 — 就近合并进审核弹窗底部(铁律 #4), 免得再单开一层
              "成本确认门"弹窗问同一件事. width:100% 在 flex-wrap footer 里强制独占一行, 排在
              按钮组上方. caller 不传 costPreview 时这里不渲染, 布局与原来完全一致(零回归). */}
          {costPreview ? (
            <div
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--ink-700)",
                paddingBottom: 8,
                marginBottom: 2,
                borderBottom: "1px dashed var(--ink-100)",
              }}
            >
              <Icon name="coin" size={12} style={{ color: "var(--brand-600)", flexShrink: 0 }} />
              {costPreview}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              variant="secondary"
              iconLeft="doc"
              disabled={isBusy || !draft.trim()}
              title="复制完整提示词并关闭弹窗,可去外部 AI 生成"
              onClick={() => { copy(draft); onClose(); }}
            >
              复制后关闭(我自己生)
            </Button>
            {onManualImport ? (
              <>
                <input
                  ref={manualImportRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  hidden
                  onChange={async (e) => {
                    const files = Array.from(e.currentTarget.files ?? []);
                    e.currentTarget.value = "";
                    if (files.length === 0) return;
                    try {
                      await onManualImport(files);
                    } finally {
                      onClose();
                    }
                  }}
                />
                <Button
                  variant="secondary"
                  iconLeft="upload"
                  disabled={isBusy}
                  title="把外部 AI 生成的图片或视频导入候选池"
                  onClick={() => manualImportRef.current?.click()}
                >
                  导入外部结果
                </Button>
              </>
            ) : null}
          </div>
          <span style={{ flex: 1 }} />
          {/* 2026-05-22: 取消按钮 — loading 时不锁(只 busy 时锁), 让用户能随时退出. */}
          <Button variant="ghost" disabled={lockClose} onClick={onClose}>
            {lockClose ? "生成中无法关闭" : "取消"}
          </Button>
          <Button
            variant="primary"
            loading={isBusy}
            disabled={isBusy || !draft.trim()}
            onClick={() => onConfirm(draft)}
          >
            {busy ? "生成中…" : loading ? "提示词加载中…" : (confirmLabel ?? "确认生成")}
          </Button>
        </>
      }
    >
        <p style={{ fontSize: 12, color: "var(--ink-500)", marginTop: 0, marginBottom: 12 }}>
          {introHint ?? (
            <>
              这是最终将发送给 API 的全部内容(自包含)。两条路:
              <br />
              <strong>① 直接发送</strong> — 改完点底部「确认生成」,系统调你选的模型;
              <br />
              <strong>② 复制走自己生</strong> — 点下方「复制提示词」+ 参考图下载到任意外部 AI 生成,完成后用「导入外部结果」带回候选区。
            </>
          )}
        </p>

        {/* W8-C: 模式切换 toggle — 全文模式 (改单一 textarea) / 字段模式 (按角色/场景/动作/镜头分段改)
            字段模式时把现有 segments (通用启动词 / 分镜上下文 / 关键参数 / 出场人物 / 场景 /
            选用素材 / 本镜独立道具 / 潜台词参考 / 用户额外要求) 各自变成一个 textarea. */}
        {segments.length > 0 && (
          <div style={{ marginBottom: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div className="mk-tab-group" role="tablist" aria-label="编辑模式">
              <button
                type="button"
                role="tab"
                aria-selected={editMode === "full"}
                className={editMode === "full" ? "mk-tab mk-tab--active" : "mk-tab"}
                onClick={() => editMode !== "full" && void toggleEditMode()}
                style={{ minWidth: 80, height: 28, fontSize: 12 }}
                title="把全部内容当一段长文本编辑 (适合大幅重写)"
              >
                <Icon name="doc" size={11} style={{ marginRight: 4 }} />全文模式
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={editMode === "fields"}
                className={editMode === "fields" ? "mk-tab mk-tab--active" : "mk-tab"}
                onClick={() => editMode !== "fields" && void toggleEditMode()}
                style={{ minWidth: 80, height: 28, fontSize: 12 }}
                title="按角色 / 场景 / 镜头 / 运镜 / 光线 / 风格等分段编辑 (适合微调某一项)"
              >
                <Icon name="settings" size={11} style={{ marginRight: 4 }} />字段模式
              </button>
            </div>
            <span style={{ fontSize: 11, color: "var(--ink-500)" }}>
              {editMode === "full"
                ? "整段编辑, 可大幅重写"
                : `分段微调 (${segments.length} 段) — 保存时按固定顺序拼回完整提示词`}
            </span>
          </div>
        )}

        {/* 提示词文本区 — 全文模式 */}
        {editMode === "full" && (
          <>
            <div className="mk-label" style={{ marginBottom: 4 }}>完整提示词(可改)</div>
            {loading ? (
              <div style={{ color: "var(--ink-500)", fontSize: 12, padding: "8px 0" }}>加载完整提示词中...</div>
            ) : (
              <Textarea
                value={draft}
                onChange={(e) => handleChange(e.target.value)}
                // 2026-07-22 Y6 UP-8: 原生 resize 手柄受 CSS max-height 硬顶约束 — 拖不过这个值,
                // 从根上杜绝"文本域拖到最大盖住底部取消按钮点击区"(journey D 次要观察实测复现).
                // 用 className(非 style prop) 加, 避免覆盖 Textarea 组件自带的 border/background 内联样式.
                className="min-h-[200px] max-h-[min(50vh,420px)] font-mono text-[12.5px]"
              />
            )}
          </>
        )}

        {/* 提示词文本区 — 字段模式: 按 segments 各段独立 textarea */}
        {editMode === "fields" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 4 }}>
            {loading ? (
              <div style={{ color: "var(--ink-500)", fontSize: 12, padding: "8px 0" }}>加载完整提示词中...</div>
            ) : (
              <>
                {segments.map((s, i) => {
                  const val = fieldEdits[s.label] ?? s.text;
                  return (
                    <div key={`${i}-${s.label}`} style={{
                      padding: "8px 10px", borderRadius: 7,
                      background: "var(--surface-card)", border: "1px solid var(--ink-100)",
                    }}>
                      <div style={{
                        display: "flex", alignItems: "center", gap: 6,
                        fontSize: 11, fontWeight: 700, color: "var(--brand-700)",
                        marginBottom: 4,
                      }}>
                        <span>{s.label}</span>
                        <span style={{ color: "var(--ink-400)", fontWeight: 500 }}>
                          ({val.length} 字)
                        </span>
                      </div>
                      <Textarea
                        value={val}
                        onChange={(e) => {
                          const next = { ...fieldEdits, [s.label]: e.target.value };
                          setFieldEdits(next);
                          // 实时同步全文 draft (拼好的) 给 onPromptChange — caller 拿最新版
                          const recomposed = segments
                            .map((ss) => {
                              const t = (ss.label === s.label ? e.target.value : (next[ss.label] ?? ss.text)).trim();
                              return t ? `【${ss.label}】\n${t}` : "";
                            })
                            .filter(Boolean)
                            .join("\n\n");
                          setDraft(recomposed);
                          onPromptChange?.(recomposed);
                        }}
                        // 2026-07-22 Y6 UP-8: 同全文模式 — 加 max-height 硬顶防拖大盖住 footer.
                        className="min-h-[60px] max-h-[min(30vh,240px)] font-mono text-[12px]"
                        style={{ fontSize: 12, lineHeight: 1.5 }}
                      />
                    </div>
                  );
                })}
                <div style={{ fontSize: 11, color: "var(--ink-500)", padding: "4px 2px" }}>
                  提示: 保存时各段按上面顺序拼回完整提示词. 切到 "全文模式" 可以看拼好的样子.
                </div>
              </>
            )}
          </div>
        )}

        {/* 2026-05-27 — 简化复制按钮区: 用户反馈"两处复制重复, 弹窗里又一份太乱".
            策略: 主操作是"复制全部 (含图)" — 复制走外部 AI 用最实用. 次操作是
            纯文字 / 负向词 — 装进一个紧凑的 dropdown 或者直接放小 ghost 按钮.
            视觉打磨: 整组放在浅卡里, 跟 footer 主 CTA 视觉分层. */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          margin: "8px 0 14px",
          borderRadius: 8,
          background: "rgba(252,250,247,0.6)",
          border: "1px dashed var(--ink-100)",
          flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 10.5, color: "var(--ink-500)", fontWeight: 600 }}>
            <Icon name="copy" size={11} style={{ marginRight: 4 }} />
            复制走外部 AI
          </span>
          {(referenceImages.length > 0 || implicitReferences.filter(r => r.active).length > 0) ? (
            <Button
              variant="primary"
              size="sm"
              iconLeft="download"
              loading={copyingAll}
              disabled={copyingAll}
              title="把提示词 + 所有参考图打包成 markdown (图 base64 内联) 复制到剪贴板, 直接粘到 ChatGPT / Claude / Gemini 等支持图片的 AI"
              onClick={() => void copyAllWithImages()}
            >
              {copyingAll ? "打包中..." : `含 ${referenceImages.length + implicitReferences.filter(r => r.active).length} 张图`}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            iconLeft="doc"
            onClick={() => copy(draft)}
            title="只复制提示词文字 (不含图)"
          >
            只复制文字
          </Button>
          {negativePrompt ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copy(negativePrompt)}
              title="排除内容 (告诉 AI 哪些元素不要画进去)"
            >
              排除内容
            </Button>
          ) : null}
          {copyAllStatus && (
            <span style={{
              fontSize: 11,
              color: copyAllStatus.includes("失败") ? "var(--err)" : "var(--ok)",
              marginLeft: "auto",
            }}>
              {copyAllStatus}
            </span>
          )}
        </div>

        {/* 排除内容只读展示（ShotStagePage 样式） */}
        {negativePrompt && segments.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-500)", marginBottom: 6 }} title="告诉 AI 哪些元素不要画进去(系统自动追加,只读)">
              排除内容(系统自动追加)
            </div>
            <div style={{ fontSize: 11.5, color: "var(--ink-700)", background: "var(--ink-50)", padding: "8px 10px", borderRadius: 8 }}>
              {negativePrompt}
            </div>
          </div>
        )}

        {/* Wave B-2: 系统建议的隐式参考图(角色/场景/素材主图)— 用户可单张取消 */}
        {implicitReferences.length > 0 ? (
          <>
            <div
              className="mk-label"
              style={{ marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}
            >
              <Icon name="sparkles" size={12} style={{ color: "var(--brand-600)" }} />
              系统自动附加({implicitReferences.filter((r) => r.active).length} / {implicitReferences.length})
            </div>
            <p style={{ fontSize: 11, color: "var(--ink-500)", margin: "0 0 8px 0", lineHeight: 1.5 }}>
              来自本镜引用的角色/场景/素材的"主图" — 让模型看到外观真相, 显著提升一致性.
              不需要某张时点"取消"即可.
            </p>
            <div style={{ display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
              {implicitReferences.map((ref) => {
                const active = ref.active;
                return (
                  <div
                    key={ref.asset_id}
                    style={{
                      width: 96,
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      opacity: active ? 1 : 0.4,
                      transition: "opacity 120ms",
                    }}
                  >
                    <div
                      style={{
                        position: "relative",
                        width: 96,
                        height: 96,
                        borderRadius: 5,
                        overflow: "hidden",
                        border: active
                          ? "2px solid var(--brand-600)"
                          : "1px dashed var(--ink-300)",
                        background: "var(--ink-50)",
                      }}
                    >
                      <img
                        src={ref.url}
                        alt={ref.label}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                      {active ? (
                        <div
                          style={{
                            position: "absolute",
                            top: 3,
                            left: 3,
                            padding: "1px 5px",
                            fontSize: 9.5,
                            fontWeight: 700,
                            color: "#fff",
                            background: "var(--brand-600)",
                            borderRadius: 3,
                          }}
                          title={`此图将作为参考图一起发送给${kindLabel}`}
                        >
                          自动
                        </div>
                      ) : (
                        <div
                          style={{
                            position: "absolute",
                            top: 3,
                            left: 3,
                            padding: "1px 5px",
                            fontSize: 9.5,
                            fontWeight: 700,
                            color: "#fff",
                            background: "var(--ink-500)",
                            borderRadius: 3,
                          }}
                          title={`此图已取消, 不会发送给${kindLabel}`}
                        >
                          已取消
                        </div>
                      )}
                    </div>
                    {/* 2026-05-28 P1#15+40: source 细分 chip — 让用户分清角色/场景/服装/道具 */}
                    <div
                      style={{
                        fontSize: 9.5,
                        color: "var(--ink-500)",
                        background: "var(--ink-100)",
                        padding: "1px 4px",
                        borderRadius: 3,
                        display: "inline-block",
                        alignSelf: "flex-start",
                        marginTop: 1,
                      }}
                    >
                      {sourceCategoryLabel(ref.source)}
                    </div>
                    <div
                      style={{
                        fontSize: 10.5,
                        color: "var(--ink-700)",
                        lineHeight: 1.3,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={ref.label}
                    >
                      {ref.label}
                    </div>
                    {onToggleImplicitRef ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        iconLeft={active ? "close" : "check"}
                        title={active ? "不让模型看这张" : "重新加回参考图列表"}
                        onClick={() => onToggleImplicitRef(ref.asset_id, !active)}
                      >
                        {active ? "取消" : "保留"}
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        {/* 参考图（ElementWorkbench 手选 / ShotStagePage 用户手选 — 永远会发送） */}
        {referenceImages.length > 0 ? (
          <>
            <div className="mk-label" style={{ marginBottom: 6 }}>
              {implicitReferences.length > 0 ? "你勾选的参考图" : "附带参考底图"}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              {referenceImages.map((ref, i) => (
                <div key={i} style={{ width: 88 }}>
                  <img
                    src={ref.url}
                    alt={ref.label}
                    style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 5, border: "1px solid var(--ink-200)" }}
                  />
                  <a
                    href={ref.url}
                    download
                    style={{ fontSize: 11, color: "var(--brand-600)", display: "block", marginTop: 3 }}
                  >
                    下载此图
                  </a>
                </div>
              ))}
            </div>
          </>
        ) : null}

    </BaseDialog>
  );
}

export default PromptReviewModal;
