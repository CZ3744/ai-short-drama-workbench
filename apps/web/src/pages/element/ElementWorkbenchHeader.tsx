/**
 * ElementWorkbenchHeader — 顶部栏 (Wave Z-8 拆分).
 *
 * 从 ElementWorkbench 抽离, 包裹 ElementHeader parts 组件.
 */

import { ElementHeader } from "./parts/ElementHeader";
import type { ElementData } from "../../lib/elementApi";

export interface ElementWorkbenchHeaderProps {
  element: ElementData;
  name: string;
  dirty: boolean;
  onNameChange: (next: string) => void;
  onSave: () => void;
  onBack: () => void;
  onDelete: () => void;
}

export function ElementWorkbenchHeader({
  element,
  name,
  dirty,
  onNameChange,
  onSave,
  onBack,
  onDelete,
}: ElementWorkbenchHeaderProps) {
  return (
    <ElementHeader
      element={element}
      name={name}
      dirty={dirty}
      onNameChange={onNameChange}
      onSave={onSave}
      onBack={onBack}
      onDelete={onDelete}
    />
  );
}
