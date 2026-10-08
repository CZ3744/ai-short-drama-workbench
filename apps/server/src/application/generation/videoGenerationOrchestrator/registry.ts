import type { VideoTargetAdapter, VideoTargetKind } from "./types";
import { shotVideoAdapter } from "./adapters/shotVideoAdapter";
import { videoVaultOnlyAdapter } from "./adapters/videoVaultOnlyAdapter";

const REGISTRY: Record<VideoTargetKind, VideoTargetAdapter> = {
  shot_video: shotVideoAdapter,
  vault_only: videoVaultOnlyAdapter,
};

export function getVideoAdapterFor(kind: VideoTargetKind): VideoTargetAdapter {
  const adapter = REGISTRY[kind];
  if (!adapter) {
    throw new Error(`未注册的 VideoTargetKind: ${kind}`);
  }
  return adapter;
}
