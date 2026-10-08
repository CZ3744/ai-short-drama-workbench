/**
 * ComposeBox — ChatGPT 风格的通用生成输入框 (2026-05-18)
 *
 * 用户原话:
 * > "几个按钮应该放在 tab 的下方, 把上方的设置做好之后正好下面就是生成按钮,
 *    不用往回上滑去找, 再加一个类似 Claude 或者 ChatGPT 聊天框的框,
 *    可以再补充用户的意见 (同时允许 @ 素材), 并同步到提示词里,
 *    右下角放模型选择器和生成按钮"
 * > "图片生成界面也要这样啊, 都查一下一起修, 而且我之前不是说了这种逻辑完全可以
 *    复用的, 没必要一改改好几处"
 *
 * 2026-05-18 通用化: 之前 VideoComposeBox 只给视频用, 改 kind: "image" | "video" | "text"
 *   一个组件同时支持首帧/视频两个候选区, 以及未来 ImageGenerationPanel /
 *   VideoGenerationPanel / InboxPage / ScriptCanvasPage 等"AI 调用 + 用户补充意见"
 *   入口的统一视觉.
 *
 * 2026-05-18 PM 五个入口推广:
 *   - kind="text" 新增 — 给 LLM 文字生成场景用 (扩写剧本 / AI 改写),
 *     默认 ModelPicker kind="text", 候选数预设隐藏 (LLM 不抽 N 张).
 *   - onMentionAsset 改为可选 — InboxPage / ScriptCanvas 没有 shot 上下文,
 *     @ 召唤只插入文本不同步 ids (ShotStagePage 上下文里仍按以前同步).
 *
 * 设计:
 *  - 顶部 textarea: 用户补充本镜额外要求 (可选, @ 召唤角色/场景/物件)
 *  - 右下角嵌入式控件: ModelPicker + 候选数 + 查看完整提示词 + 抽卡按钮
 *  - @ 召唤复用 MentionSelector, 选中后:
 *    1) textarea 插入 token 文本 (@ 角色:小明)
 *    2) 通过 onMentionAsset 通知父组件同步 draft.character_ids 等 (可选)
 *  - mention 自管 state, 不污染 caller 全局 mention
 *  - Ctrl/Cmd + Enter 抽卡 (ChatGPT 一致)
 */
import { useState } from "react";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { MentionTextarea } from "../mention/MentionTextarea";
import type { MentionOption } from "../mention/mentionTokens";
import { ModelPicker } from "../studio/ModelPicker";
import type { MentionAsset, MentionAssetKind } from "../../lib/mentionTypes";

/** 默认候选数预设 — 图像便宜快, 给更多选择; 视频贵慢, 给精简数; 文本 LLM 不抽 N 份
 * 2026-05-27 audit P0 #10: video presets [1,2,3,5] 跟后端 GenerateVideoSchema max=3 不一致,
 * 用户选 5 段时 zod reject 400. 改成 [1,2,3] 跟后端对齐.
 */
const DEFAULT_PRESETS: Record<"image" | "video" | "text", number[]> = {
  image: [1, 2, 3, 5, 10],
  video: [1, 2, 3],
  text: [], // LLM 没"抽 N 份"概念, 隐藏候选数 row
};

const DEFAULT_PLACEHOLDER: Record<"image" | "video" | "text", string> = {
  image: "补充本镜首帧的额外要求(可选)。输入 @ 召唤角色 / 场景 / 物件,内容会拼到最终提示词。Ctrl/Cmd + Enter 抽首帧。",
  video: "补充本镜视频的额外要求(可选)。输入 @ 召唤角色 / 场景 / 物件,内容会拼到最终提示词。Ctrl/Cmd + Enter 抽视频。",
  text: "补充对剧本的额外要求或修改意见。Ctrl/Cmd + Enter 发送。",
};

const DEFAULT_DRAW_LABEL: Record<"image" | "video" | "text", string> = {
  image: "抽首帧",
  video: "抽视频",
  text: "发送",
};

export interface ComposeBoxProps {
  /** 生成类型 — image (首帧/素材图) | video (视频) | text (LLM 文字生成 / 改写) */
  kind: "image" | "video" | "text";
  slug: string;
  /** 用户补充意见文本 (caller 持有, 不进 draft) */
  value: string;
  onChange: (v: string) => void;
  /** 图像/视频/文字模型 ref */
  modelRef: string | null;
  onModelChange: (v: string | null) => void;
  /** 抽几条 (text kind 默认隐藏) */
  count: number;
  onCountChange: (n: number) => void;
  /** 抽卡中 */
  busy: boolean;
  busyLabel?: string;
  /** 触发抽卡 */
  onDraw: () => void;
  /** 打开"完整提示词审核" modal */
  onPreviewPrompt?: () => void;
  /**
   * 2026-05-26 W8-D: 快速复制提示词 — 无需开 modal 直接复制当前完整提示词到剪贴板.
   * 适合没有 API key 的用户走外部 AI 生成 (Midjourney/Runway/Kling), 或想"先看一眼再决定"
   * 的用户. 传入 = 显示按钮; 不传 = 隐藏 (有些场景没有现成 prompt 可复制).
   */
  onCopyPrompt?: () => void;
  /**
   * 用户 @ 选了素材, 父组件同步 ids 到 caller draft.
   * 2026-05-18 可选化:
   *   - 传入 = ShotStagePage 等有 shot 上下文, 同步 character_ids / scene_id 等
   *   - 不传 = InboxPage / ScriptCanvas 等无 shot 上下文, @ 只插入文本不同步 ids
   */
  onMentionAsset?: (asset: MentionAsset) => void;
  /**
   * 2026-05-19 #6: 可选 — caller 接 BatchElementImageDialog 实现"一键补全".
   * 透传到 MentionSelector footer.
   */
  onTriggerBatchImage?: () => void;
  /** ModelPicker 引导高亮 (从父组件传, 复用"未选模型抖动"体验) */
  modelPickerHighlight?: boolean;
  /** override 默认 placeholder (默认按 kind 派生) */
  placeholder?: string;
  /** override 抽卡按钮文字 (默认 "抽首帧" / "抽视频" / "发送") */
  drawLabel?: string;
  /** override 候选数预设 (默认 image=[1,2,3,5,10] · video=[1,2,3,5] · text=[]) */
  countPresets?: number[];

  /**
   * W11 A7 (2026-05-27): "只问不抽" 模式 — caller 接通后顶部出现 toggle.
   *   - 生成模式: 点抽卡 → onDraw (现有行为)
   *   - 只问不抽模式: 点抽卡 → onAsk(value) 触发 LLM 问答, 答在下方 ComposeBox 之外的回答区显示
   * caller 需自己渲染 answer block; ComposeBox 不持答区, 因为 RegenModal 等场景没有答区位置.
   */
  onAsk?: (question: string) => void;
  /** "只问不抽" 模式下显示 "问 AI 中..." loading state */
  asking?: boolean;
  /**
   * D-P1 (2026-06-01): AI 润色提示词 — 点击后调后端 LLM 润色, 结果在预览弹窗展示,
   * 用户可编辑/确认后才回填到 prompt (可干预铁律). 传入 = 显示按钮; 不传 = 隐藏.
   */
  onPolish?: () => void;
  /** AI 润色 loading 状态 */
  polishBusy?: boolean;
}

export function ComposeBox(props: ComposeBoxProps) {
  const {
    kind, slug, value, onChange, modelRef, onModelChange,
    count, onCountChange, busy, busyLabel,
    onDraw, onPreviewPrompt, onCopyPrompt, onMentionAsset, onTriggerBatchImage, modelPickerHighlight,
    placeholder, drawLabel, countPresets,
    onAsk, asking,
    onPolish, polishBusy,
  } = props;

  // W11 A7: "只问不抽" 模式 — 只在 caller 接通 onAsk 时显示 toggle
  const [askMode, setAskMode] = useState(false);
  const canAsk = !!onAsk;

  const PRESETS = countPresets ?? DEFAULT_PRESETS[kind];
  const finalPlaceholder = placeholder ?? DEFAULT_PLACEHOLDER[kind];
  const finalDrawLabel = drawLabel ?? DEFAULT_DRAW_LABEL[kind];
  const modelPickerPlaceholder =
    kind === "image" ? "选择生图模型" : kind === "video" ? "选择生视频模型" : "选择文字模型";
  /** ModelPicker 的 kind — text 入口走 text 模型 (LLM), image/video 走对应媒体模型. */
  const modelPickerKind: "image" | "video" | "text" = kind;
  /** 候选数 row — text kind / 空预设时隐藏 (LLM 不抽 N 份) */
  const showCountRow = PRESETS.length > 0;

  // W11 A7: 主动作根据 askMode 切换 — 生成模式 → onDraw, 只问不抽 → onAsk
  function triggerPrimary() {
    if (askMode && onAsk) {
      if (!value.trim() || asking) return;
      onAsk(value);
    } else {
      onDraw();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Cmd/Ctrl + Enter 触发抽卡 / 问 AI (跟 ChatGPT 一致)
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !busy && !asking) {
      if (askMode || modelRef) {
        e.preventDefault();
        triggerPrimary();
      }
    }
  }

  function handleMentionPick(option: MentionOption) {
    if (!onMentionAsset || !option.resourceId) return;
    if (option.kind !== "character" && option.kind !== "scene" && option.kind !== "element") return;
    onMentionAsset({
      kind: option.kind as MentionAssetKind,
      id: option.resourceId,
      name: option.label,
      thumbnail: option.thumbnail,
      elementKindLabel: option.elementKind,
    } satisfies MentionAsset);
  }

  const canDraw = !!modelRef && !busy;

  return (
    <div
      style={{
        marginTop: 12,
        background: "var(--surface-card)",
        border: "1.5px solid var(--ink-150)",
        borderRadius: 14,
        boxShadow: "0 2px 10px rgba(0,0,0,0.04)",
        position: "relative",
        transition: "border-color 220ms ease, box-shadow 220ms ease",
      }}
      onFocusCapture={(e) => {
        const target = e.currentTarget;
        target.style.borderColor = "var(--brand-400)";
        target.style.boxShadow = "0 2px 14px rgba(217,119,87,0.12)";
      }}
      onBlurCapture={(e) => {
        const target = e.currentTarget;
        // 只在浮层完全失焦时恢复
        setTimeout(() => {
          if (!target.contains(document.activeElement)) {
            target.style.borderColor = "var(--ink-150)";
            target.style.boxShadow = "0 2px 10px rgba(0,0,0,0.04)";
          }
        }, 0);
      }}
    >
      {/* W11 A7 (2026-05-27): "只问不抽" 模式 toggle — 左栏顶部 "问 AI" 输入框删除合并到这里.
          只在 caller 传 onAsk 时显示, 跟"生成"两两切换. 不抽卡只让 LLM 答个问题. */}
      {canAsk && (
        <div style={{
          padding: "6px 12px 0",
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontSize: 11, color: "var(--ink-500)" }}>模式</span>
          <div role="radiogroup" aria-label="发送模式" style={{ display: "inline-flex", gap: 2, padding: 2, borderRadius: 6, background: "var(--ink-50)" }}>
            <button
              type="button"
              role="radio"
              aria-checked={!askMode}
              onClick={() => setAskMode(false)}
              style={{
                padding: "3px 10px", fontSize: 11, fontWeight: 600,
                border: "none", borderRadius: 4,
                background: !askMode ? "var(--surface-card)" : "transparent",
                color: !askMode ? "var(--brand-700)" : "var(--ink-500)",
                cursor: "pointer",
                boxShadow: !askMode ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
              }}
              title="生成模式 — 点按钮真抽卡 (消耗 API 额度)"
            >
              <Icon name="sparkles" size={10} /> 生成
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={askMode}
              onClick={() => setAskMode(true)}
              style={{
                padding: "3px 10px", fontSize: 11, fontWeight: 600,
                border: "none", borderRadius: 4,
                background: askMode ? "var(--surface-card)" : "transparent",
                color: askMode ? "var(--brand-700)" : "var(--ink-500)",
                cursor: "pointer",
                boxShadow: askMode ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
              }}
              title="只问 AI 一个问题 — 不修改分镜, 不抽卡 (省额度, 用于讨论思路)"
            >
              <Icon name="help" size={10} /> 只问不抽
            </button>
          </div>
        </div>
      )}
      <MentionTextarea
        projectSlug={slug}
        value={value}
        onChange={onChange}
        placeholder={finalPlaceholder}
        onKeyDown={handleKeyDown}
        onMentionPick={handleMentionPick}
        onTriggerBatchImage={onTriggerBatchImage}
        rows={3}
        editorClassName="rounded-[14px_14px_0_0]"
        editorStyle={{
          border: "none",
          fontFamily: "inherit",
          fontSize: 13,
          lineHeight: 1.55,
          background: "transparent",
          padding: "12px 14px 6px",
          minHeight: 72,
        }}
      />

      {/* 底部嵌入式控件栏 — 左:候选数预设 · 右:Model + 预览 + 抽卡 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 12px 10px",
          gap: 8,
          flexWrap: "wrap",
          borderTop: "1px solid var(--ink-100)",
        }}
      >
        {/* 左下 — 候选数预设 (text kind 隐藏: LLM 不抽 N 份) */}
        {showCountRow ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "var(--ink-500)" }}>候选数</span>
            <div className="mk-tab-group">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => onCountChange(p)}
                  className={count === p ? "mk-tab mk-tab--active" : "mk-tab"}
                  style={{ minWidth: 26, height: 24, fontSize: 11, padding: "0 6px" }}
                >{p}</button>
              ))}
              {/* 2026-05-27 audit P0 #10: max 跟 kind 走 — video 后端 schema max=3, image 上限 10 */}
              <input
                type="number"
                min={1}
                max={kind === "video" ? 3 : 10}
                value={count}
                onChange={(e) => onCountChange(Math.max(1, Math.min(kind === "video" ? 3 : 10, Number(e.target.value) || 1)))}
                style={{
                  width: 38, height: 24, padding: "0 4px", fontSize: 11,
                  border: "1px solid var(--ink-150)", borderRadius: 6, textAlign: "center",
                  background: "var(--surface-card)", color: "var(--ink-900)",
                }}
                title="自定义候选数(1-8)"
              />
            </div>
          </div>
        ) : <div />}

        {/* 右下 — ModelPicker + 主 CTA. 2026-05-27 — 用户反馈"两处复制提示词按钮重复".
            复制 / 审核完整提示词 入口下沉到上方 PromptPreviewBlock (常驻预览块底部, 就近决策).
            这里只留 ModelPicker + 抽卡 主操作, 减少视觉噪音. */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              borderRadius: 8,
              transition: "box-shadow 220ms ease, transform 220ms ease",
              boxShadow: modelPickerHighlight ? "0 0 0 3px rgba(245,158,11,0.45)" : "none",
              transform: modelPickerHighlight ? "scale(1.02)" : "none",
            }}
          >
            <ModelPicker
              kind={modelPickerKind}
              value={modelRef}
              onChange={onModelChange}
              size="sm"
              placeholder={modelPickerPlaceholder}
            />
          </div>
          {/* D-P1 (2026-06-01): AI 润色提示词按钮 — 仅 image/text kind 显示 (视频不润色) */}
          {onPolish && kind !== "video" && (
            <Button
              variant="ghost"
              size="sm"
              iconLeft="sparkles"
              onClick={onPolish}
              disabled={polishBusy}
              loading={polishBusy}
              title="AI 润色提示词 — 用 LLM 将零散字段润色成 5 段式自包含 prompt"
            >
              {polishBusy ? "润色中..." : "AI 润色"}
            </Button>
          )}
          {/* W11 A7: askMode 时改成"问 AI"按钮, 否则原"抽卡"按钮 */}
          {askMode && canAsk ? (
            <Button
              variant="primary"
              size="sm"
              iconLeft="help"
              onClick={triggerPrimary}
              disabled={!value.trim() || asking}
              loading={asking}
              title="只问 AI 不抽卡 — 答案显示在下方, 不修改分镜"
            >
              {asking ? "问 AI 中..." : "问 AI"}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              iconLeft="sparkles"
              onClick={triggerPrimary}
              disabled={!canDraw}
              loading={busy}
              title={
                !modelRef
                  ? `先选${kind === "image" ? "生图" : kind === "video" ? "生视频" : "文字"}模型`
                  : busy
                  ? "生成中..."
                  : showCountRow
                  ? `抽 ${count} 条候选`
                  : finalDrawLabel
              }
            >
              {busy
                ? (busyLabel || "生成中...")
                : showCountRow
                ? `${finalDrawLabel} ×${count}`
                : finalDrawLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
