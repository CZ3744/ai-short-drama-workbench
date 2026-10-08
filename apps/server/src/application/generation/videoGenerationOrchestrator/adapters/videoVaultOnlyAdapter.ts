/**
 * videoVaultOnlyAdapter — raw /api/v2/videos/generate 用. 只入 vault, 不绑业务对象.
 */

import { saveToVault } from "../../../../../../../packages/library/src/assetVault";
import type { VideoTargetAdapter, PersistedVideo } from "../types";

export const videoVaultOnlyAdapter: VideoTargetAdapter = {
  async persist({ video, target, provider_id, request }): Promise<PersistedVideo> {
    const mime = video.mime || "video/mp4";
    const tags = [
      "vault_only",
      `provider:${provider_id}`,
      ...(request.extra_tags ?? []),
    ];

    const vault = await saveToVault({
      buffer: video.buffer,
      kind: "video",
      mime,
      context: {
        kind: "rough_cut",
        series_slug: target.series_slug,
        shot_id: typeof target.meta?.shot_id === "string" ? target.meta.shot_id : undefined,
        user_note: typeof target.meta?.user_note === "string" ? target.meta.user_note : undefined,
      },
      provider_id,
      width: video.width,
      height: video.height,
      duration_sec: video.duration_sec,
      tags,
    });

    return {
      generation_id: vault.vault_id,
      vault_id: vault.vault_id,
      url: `/api/v2/vault/${vault.vault_id}/raw`,
      width: video.width,
      height: video.height,
      duration_sec: video.duration_sec,
      mime,
      provider_id,
      prompt_snapshot: request.prompt,
    };
  },

  async readState(): Promise<undefined> {
    return undefined;
  },
};
