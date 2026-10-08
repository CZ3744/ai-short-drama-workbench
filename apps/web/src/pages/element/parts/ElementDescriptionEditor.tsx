/**
 * ElementDescriptionEditor — 文字描述 textarea + AI 智能填表工具栏.
 *
 * 内容:
 *   · textarea 输入(会拼进生图提示词)
 *   · 若有字段 schema(character/scene),底部 toolbar:
 *     - ModelPicker kind="text" 选 LLM
 *     - "AI 一键填字段" 按钮 → 父组件 handleAutofillFromAi
 *     - "复制完整提示词" PromptReviewButton(走 previewAutofillPrompt)
 *     - "导入外部 AI 结果" 按钮 → 父组件触发粘贴对话框
 *
 * 从 ElementWorkbench 拆出(Wave P2 解耦). 视觉零变更.
 */

import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { ModelPicker } from "../../../components/studio/ModelPicker";
import { PromptReviewButton } from "../../../components/shared/PromptReviewButton";
import {
  ELEMENT_KIND_LABEL,
  previewAutofillPrompt,
  type ElementData,
  type ElementKind,
} from "../../../lib/elementApi";

export type KindField = {
  key: string;
  label: string;
  type?: "text" | "number" | "textarea";
  placeholder?: string;
  hint?: string;
};

interface Props {
  slug: string;
  element: ElementData;
  description: string;
  onDescriptionChange: (next: string) => void;
  kindFields: KindField[];
  llmModelRef: string | null;
  onLlmModelChange: (next: string | null) => void;
  autofillBusy: boolean;
  onAutofillFromAi: () => void;
  onOpenPasteAutofill: () => void;
}

export function ElementDescriptionEditor({
  slug,
  element,
  description,
  onDescriptionChange,
  kindFields,
  llmModelRef,
  onLlmModelChange,
  autofillBusy,
  onAutofillFromAi,
  onOpenPasteAutofill,
}: Props) {
  return (
    <div className="mk-card" style={{ padding: 16 }}>
      <div className="mk-label" style={{ marginBottom: 6 }}>
        文字描述（会拼进生图提示词）
      </div>
      <Textarea
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        placeholder={
          kindFields.length > 0
            ? `描述这个${ELEMENT_KIND_LABEL[element.kind]}的外观、材质、风格特征……\n点击下方"AI 一键填字段"可智能拆成下方表单`
            : "描述这个素材的外观、材质、风格特征……"
        }
        className="min-h-[110px] text-[13px]"
      />
      {/*
        2026-05-19 反馈 #2: AI 智能填表工具栏
        用户原话:"在这个文本框下方添加一个功能, 调用我选择的模型直接通过智能来提取和补全角色信息"
        复用:
          - ModelPicker kind="text" 选 LLM (与项目其他 LLM 用同一组件)
          - PromptReviewButton 走"零成本预览 + 复制提示词 + 手动粘贴导入"路径
        UX 铁律 #2 (可干预): 每一颗 LLM 调用都给"查看完整提示词" 按钮.
        UX 铁律 #11 (按钮有名字): 所有按钮 icon+文字, 无 icon-only.
        仅在该 kind 有字段表 (kindFields.length>0) 时展示, 否则 toolbar 没意义.
      */}
      {kindFields.length > 0 ? (
        <div
          style={{
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px dashed var(--ink-200)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--ink-500)" }}>用 LLM 智能拆分:</span>
            <ModelPicker
              kind="text"
              value={llmModelRef}
              onChange={onLlmModelChange}
              size="sm"
              placeholder="选文字模型"
            />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Button
              variant="primary"
              size="sm"
              iconLeft="sparkles"
              loading={autofillBusy}
              disabled={autofillBusy || !description.trim()}
              title="把上方描述发给 AI, 自动提取并填到下方各字段"
              onClick={onAutofillFromAi}
            >
              {autofillBusy ? "AI 解析中…" : "AI 一键填字段"}
            </Button>
            <PromptReviewButton
              label="复制完整提示词"
              size="sm"
              disabled={!description.trim()}
              title="复制 AI 智能填表的完整提示词"
              loadPrompt={async () => {
                const r = await previewAutofillPrompt(slug, element.kind as ElementKind, description.trim());
                return {
                  kind: "text",
                  full_prompt: r.combined,
                  system_prompt: r.system,
                  target_provider: llmModelRef ?? undefined,
                };
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              iconLeft="upload"
              title="把外部 AI 返回的 JSON 粘贴进来, 自动填到下方字段"
              onClick={onOpenPasteAutofill}
            >
              导入外部 AI 结果
            </Button>
          </div>
          <p style={{ fontSize: 10.5, color: "var(--ink-400)", margin: 0, lineHeight: 1.4 }}>
            把这段描述发给 AI 解析成「
            {kindFields.filter((f) => f.key !== "voice_id").map((f) => f.label).join(" / ")}
            」等字段, 自动填到下方表单. 也可"复制提示词" 走外部 AI 后再"导入结果".
          </p>
        </div>
      ) : null}
    </div>
  );
}
