import type { ElementKind } from "./types";

// Characters and scenes use their dedicated repositories. The other kinds share
// the element repository and the supporting-assets context sent to the planner.
const SUPPORTING_ELEMENT: Record<ElementKind, boolean> = {
  character: false,
  scene: false,
  prop: true,
  wardrobe: true,
  reference: true,
  misc: true,
};

export function isSupportingElement(element: { kind: ElementKind }): boolean {
  return SUPPORTING_ELEMENT[element.kind] === true;
}
