// ====================================================================
// voiceApi.ts — 角色语音克隆 (P1 wave 2 #11 解耦)
// ====================================================================
// 覆盖范围: 角色 voice clone sample upload / delete / 播放 URL helper
// ====================================================================

import { apiDelete, handleResponse } from "./_apiClient";

/**
 * 上传角色的语音克隆参考样本.
 * 写到 series/<slug>/assets/voices/, 角色字段 voice_clone_sample_url 指向 series-relative path.
 * 上传成功后返回的 voice_clone_sample_url 可拼成 `/api/v2/series/${slug}/${path}` 播放预览.
 */
export interface UploadVoiceCloneSampleResult {
  ok: boolean;
  voice_clone_sample_url: string;
  bytes: number;
  character: unknown;
}
export async function uploadCharacterVoiceCloneSample(input: {
  slug: string;
  charId: string;
  file: File;
}): Promise<UploadVoiceCloneSampleResult> {
  const form = new FormData();
  form.append("file", input.file, input.file.name);
  // 2026-05-19: 用户原话"禁止在本地设置主动超时" — 删 AbortSignal.timeout(60_000).
  const response = await fetch(
    `/api/v2/series/${encodeURIComponent(input.slug)}/characters/${encodeURIComponent(input.charId)}/voice-clone-sample`,
    {
      method: "POST",
      body: form,
    },
  );
  await handleResponse(response);
  return response.json() as Promise<UploadVoiceCloneSampleResult>;
}

/** 删除角色当前的语音克隆参考样本 */
export async function deleteCharacterVoiceCloneSample(input: { slug: string; charId: string }) {
  return apiDelete<{ ok: boolean; character: unknown }>(
    `/api/v2/series/${encodeURIComponent(input.slug)}/characters/${encodeURIComponent(input.charId)}/voice-clone-sample`,
  );
}

/** 拼成可播放的 URL — 后端走 /api/v2/series/:slug/assets/:kind/:filename 静态接口 */
export function voiceCloneSampleUrl(slug: string, relPath: string): string {
  return `/api/v2/series/${encodeURIComponent(slug)}/${relPath}`;
}
