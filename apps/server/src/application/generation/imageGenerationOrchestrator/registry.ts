/**
 * Adapter 注册表 — 把 target.kind 映射到具体 adapter 实现.
 *
 * 加新 kind 步骤: 在 types.ts 加 enum + 这里 import + 注册. 不改 controller 也不改
 * orchestrator 主流程. 这就是 TargetAdapter 模式的扩展点.
 */

import type { ImageTargetAdapter, ImageTargetKind } from "./types";
import { shotFirstFrameAdapter } from "./adapters/shotFirstFrameAdapter";
import { shotLastFrameAdapter } from "./adapters/shotLastFrameAdapter";
import { elementAdapter } from "./adapters/elementAdapter";
import { characterRefAdapter } from "./adapters/characterRefAdapter";
import { sceneRefAdapter } from "./adapters/sceneRefAdapter";
import { libraryVariantAdapter } from "./adapters/libraryVariantAdapter";
import { vaultOnlyAdapter } from "./adapters/vaultOnlyAdapter";

const REGISTRY: Record<ImageTargetKind, ImageTargetAdapter> = {
  shot_first_frame: shotFirstFrameAdapter,
  shot_last_frame: shotLastFrameAdapter,
  element: elementAdapter,
  character_ref: characterRefAdapter,
  scene_ref: sceneRefAdapter,
  library_variant: libraryVariantAdapter,
  vault_only: vaultOnlyAdapter,
};

export function getAdapterFor(kind: ImageTargetKind): ImageTargetAdapter {
  const adapter = REGISTRY[kind];
  if (!adapter) {
    throw new Error(`未注册的 ImageTargetKind: ${kind}`);
  }
  return adapter;
}
