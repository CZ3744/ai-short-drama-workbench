/**
 * ElementWorkbenchSidebar — 侧边栏 (Wave Z-8 拆分).
 *
 * 从 ElementWorkbench 抽离, 包裹左列: 描述编辑 / 字段 / 标签 + 关联.
 */

import { ElementDescriptionEditor, type KindField } from "./parts/ElementDescriptionEditor";
import { ElementFields } from "./parts/ElementFields";
import { ElementSidebar } from "./parts/ElementSidebar";
// W2 (2026-05-26) — 角色组合性面板 (绑定服装造型 + 常带道具)
import { CharacterCompositionPanel } from "../../components/element/CharacterCompositionPanel";
// W3 (2026-05-26) — 同源派生 push/pull 同步面板
import { UpstreamDownstreamPanel } from "../../components/element/UpstreamDownstreamPanel";
// W7 (2026-05-26) — 共享到素材组 (替代独立"剧组"入口的就近决策面板)
import { ElementGroupBindingPanel } from "../../components/element/ElementGroupBindingPanel";
import type { ElementData, ElementTag, ElementUsage } from "../../lib/elementApi";

export interface ElementWorkbenchSidebarProps {
  slug: string;
  element: ElementData;
  elementId: string;
  description: string;
  kindFields: KindField[];
  attrs: Record<string, unknown>;
  tags: ElementTag[];
  relatableElements: Array<{ id: string; name: string }>;
  usage: ElementUsage[];
  seriesTtsProviderId: string;
  llmModelRef: string | null;
  autofillBusy: boolean;
  onDescriptionChange: (next: string) => void;
  onLlmModelChange: (ref: string | null) => void;
  onAutofillFromAi: () => void;
  onOpenPasteAutofill: () => void;
  onUpdateAttr: (key: string, value: string) => void;
  onUpdateVoiceCloneSampleUrl: (newUrl: string | undefined) => void;
  onFlash: (msg: string) => void;
  onReloadElement: () => void;
  onTagsChange: (t: ElementTag[]) => void;
  onOpenElement: (id: string) => void;
  onNavigateToShot: (epId: string, shotId: string) => void;
  /** W2 — character 组合面板写回 element 时调. 不传则不渲染 CharacterCompositionPanel. */
  onElementUpdated?: (next: ElementData) => void;
}

export function ElementWorkbenchSidebar({
  slug,
  element,
  elementId,
  description,
  kindFields,
  attrs,
  tags,
  relatableElements,
  usage,
  seriesTtsProviderId,
  llmModelRef,
  autofillBusy,
  onDescriptionChange,
  onLlmModelChange,
  onAutofillFromAi,
  onOpenPasteAutofill,
  onUpdateAttr,
  onUpdateVoiceCloneSampleUrl,
  onFlash,
  onReloadElement,
  onTagsChange,
  onOpenElement,
  onNavigateToShot,
  onElementUpdated,
}: ElementWorkbenchSidebarProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ElementDescriptionEditor
        slug={slug}
        element={element}
        description={description}
        onDescriptionChange={(next) => {
          onDescriptionChange(next);
        }}
        kindFields={kindFields}
        llmModelRef={llmModelRef}
        onLlmModelChange={onLlmModelChange}
        autofillBusy={autofillBusy}
        onAutofillFromAi={onAutofillFromAi}
        onOpenPasteAutofill={onOpenPasteAutofill}
      />

      <ElementFields
        slug={slug}
        element={element}
        elementId={elementId}
        attrs={attrs}
        kindFields={kindFields}
        seriesTtsProviderId={seriesTtsProviderId}
        onUpdateAttr={onUpdateAttr}
        onUpdateVoiceCloneSampleUrl={onUpdateVoiceCloneSampleUrl}
        onFlash={onFlash}
        onReloadElement={onReloadElement}
      />

      {/* W2 (2026-05-26) — 角色组合性: 仅 character 类型显示, 绑服装/道具 */}
      {element.kind === "character" && onElementUpdated ? (
        <CharacterCompositionPanel
          slug={slug}
          element={element}
          onElementUpdated={onElementUpdated}
          onFlash={onFlash}
        />
      ) : null}

      {/* W3 (2026-05-26) — 同源派生: 上游/下游 push/pull 同步, 只在有派生关系时渲染 */}
      {onElementUpdated ? (
        <UpstreamDownstreamPanel
          slug={slug}
          element={element}
          onElementUpdated={onElementUpdated}
          onFlash={onFlash}
        />
      ) : null}

      {/* W7 (2026-05-26) — 共享给素材组 (多选 chip): 让素材跨剧共享, 不再走独立"剧组"页面 */}
      <ElementGroupBindingPanel slug={slug} element={element} onChanged={onReloadElement} />

      <ElementSidebar
        tags={tags}
        onTagsChange={onTagsChange}
        relatableElements={relatableElements}
        onOpenElement={onOpenElement}
        usage={usage}
        onNavigateToShot={onNavigateToShot}
      />
    </div>
  );
}
