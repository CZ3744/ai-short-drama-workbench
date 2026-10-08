/**
 * autoPipelineRetry — 单条失败项的"独立重抽"helper.
 *
 * 背景 (2026-05-26 Codex 反馈): AutoPipelineProgressPanel 的"重抽这一条"按钮
 * 之前走 POST /auto-pipelines/:id/retry-stage, 后端会 force abort 整条 pipeline
 * 然后从 element_images stage 重启 — 中断 12 张正在跑的图. 用户期望"加入队列",
 * 实际是"打断全部重启".
 *
 * 新方案: 单条重抽走独立的 element/shot 生成 API, **跟 pipeline 完全并行**, 不动
 * pipeline 状态. 体验跟"加入队列"一致. retryStage 仅用于"pipeline 完成态时整批重抽"
 * (那个时候 abort 一个没在跑的 pipeline 没副作用).
 */

import { apiPost } from "./_apiClient";
import { getElement } from "./elementApi";

/**
 * 独立重抽 element 的某一张 brief (按 brief 在 image_briefs 数组的 index 定位).
 *
 *   1) GET element 拿 brief.angle / brief.description (失败明细只携带 angle, 缺 description)
 *   2) POST /elements/:id/generate-image 走独立 orchestrator (同步 await 生图)
 *
 * 不动 auto-pipeline 状态. 调用方负责 toast 成功/失败.
 *
 * @param slug         系列 slug
 * @param elementId    素材 id (failed_details.target_id)
 * @param briefIndex   brief 在 element.image_briefs 的 index (failed_details.sub_index)
 * @param modelRef     可选, 覆盖系列默认图像模型 (用户在 panel 选了 ModelPicker 时)
 */
export async function retryFailedElementBriefIndependent(
  slug: string,
  elementId: string,
  briefIndex: number | undefined,
  modelRef?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    let userInstruction = "";
    if (briefIndex !== undefined) {
      const { element } = await getElement(slug, elementId);
      // image_briefs 不在前端 ElementData 类型上 (后端 ElementData 有). cast 兜底.
      const briefs = ((element as unknown as { image_briefs?: Array<{ angle: string; description: string }> }).image_briefs) ?? [];
      const brief = briefs[briefIndex];
      if (brief) {
        userInstruction = `视角: ${brief.angle}. 具体内容: ${brief.description}`;
      }
    }

    // 后端 buildCompileInput 读 body.user_instruction 拼提示词 (asset_prompt_compiler).
    // 不传 full_prompt → 后端用 element 默认信息 + user_instruction 拼.
    await apiPost(`/api/v2/series/${slug}/elements/${elementId}/generate-image`, {
      user_instruction: userInstruction,
      image_model_ref: modelRef || undefined,
      count: 1,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 独立重抽 shot 的首帧 (firstframes stage 失败时用).
 *
 * 走 POST /series/:slug/episodes/:epId/shots/:sid/stage/firstframe/generate
 * 后端 dispatchFirstFrameGenerate → orchestrator, 跟 pipeline 内部首帧路径同源.
 * 不动 auto-pipeline.
 */
export async function retryFailedShotFirstframeIndependent(
  slug: string,
  episodeId: string,
  shotId: string,
  modelRef?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await apiPost(
      `/api/v2/series/${slug}/episodes/${episodeId}/shots/${shotId}/stage/firstframe/generate`,
      {
        count: 1,
        model: modelRef || undefined,
      },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 独立重抽 shot 的视频 (videos stage 失败时用).
 */
export async function retryFailedShotVideoIndependent(
  slug: string,
  episodeId: string,
  shotId: string,
  modelRef?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await apiPost(
      `/api/v2/series/${slug}/episodes/${episodeId}/shots/${shotId}/stage/video/generate`,
      {
        count: 1,
        model: modelRef || undefined,
      },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
