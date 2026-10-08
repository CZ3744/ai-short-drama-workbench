/**
 * element_images stage runner.
 *
 * 从 autoPipelineRunner.ts 拆出.
 */

import { loggerSync } from "../../../../../../packages/core/src/logger";
import { listCharacters, updateCharacter } from "../../../repositories/characterRepo";
import { listScenes, updateScene } from "../../../repositories/sceneRepo";
import { listElements } from "../../../repositories/elementRepo";
import { appendFailure } from "../../../repositories/failureRepo";
import {
  readAnyElement,
  adaptCharacterData,
  adaptSceneData,
  patchAnyElementImageMeta,
} from "../../../api/v2/elementController.helpers";
import { generateImagesForTarget } from "../imageGenerationOrchestrator";
import { getRegistry } from "../../../api/v2/orchestrationController";
import {
  compileImagePrompt,
  type AssetElementKind,
} from "../assetPromptCompiler";
import type { ElementData, ImageBrief } from "../../../../../../packages/drama/src/types";
import { readSeries } from "../../../api/v2/seriesStore";
import type { AutoPipelineRecord } from "../autoPipelineRunner";
import { findStage, emitStage } from "./shared";

/**
 * 2026-05-19 #8c: element_images stage — 按 LLM 规划的 image_briefs 为每个 element 生图.
 *
 * 复用而非重写:
 *   - 调用 generateImagesForTarget (apps/server/src/application/generation/imageGenerationOrchestrator)
 *     — orchestrator 内部走 imageGenerationService + elementAdapter, 不重新写图像生成逻辑
 *   - getRegistry() 拿 provider registry (orchestrationController 提供)
 *   - compileImagePrompt 拼自包含 prompt(角色/场景/物品/服装/参考通用模板)
 *   - patchAnyElementImageMeta 标 is_typical=true (复用既有三池语义,
 *     让第 2+ 张抽卡时 elementController.generate-image 的 pushRef 自动接续)
 *
 * 流程:
 *   1) 列出 series 所有 element (characters + scenes + element repo 4 kinds)
 *   2) 跳过 image_briefs 为空 / undefined 的 element (用户手建的不强制)
 *   3) 串行遍历每个 element 的 briefs:
 *      - 第 1 张: 不传 reference_images, 走标准 t2i
 *      - 生成成功 → 自动标 is_typical=true (代表图), 让后续 brief 自动接续
 *      - 第 N (N≥2) 张: 直接调 generateImagesForTarget, elementAdapter 内部不知道
 *        "上一张是参考图", 这里依赖 elementController.generate-image 的 pushRef 逻辑.
 *        本 runner 直接调 orchestrator (绕过 elementController), 因此需要自己显式
 *        把 typical 图作为 reference_images 传进去. 简化: 把上一张刚 persist 的
 *        PersistedImage 作 reference 传给下一张. orchestrator 内 resolveReferenceImages
 *        会接受 asset_id / vault_id (PersistedImage 都有).
 *   4) 不同 element 之间串行 (本轮简化, 后续可改并行)
 *   5) SSE 推 pipeline.stage.progress { current, total }
 *
 * 失败容忍: 单张 brief 生成失败 → 计 stage.failed +1, 继续下一张. 不阻塞整个 stage.
 * 中断: signal.aborted → throw "pipeline_aborted", 让 fire-and-forget catch 处理.
 */
export async function runElementImagesStage(record: AutoPipelineRecord, signal: AbortSignal): Promise<void> {
  const stage = findStage(record, "element_images");
  stage.status = "running";
  stage.started_at = new Date().toISOString();
  record.current_stage = "element_images";

  emitStage(record, "pipeline.stage.started", { stage: "element_images" });

  // 用户显式 skip
  if (record.options.skip_element_images === true) {
    stage.status = "skipped";
    stage.finished_at = new Date().toISOString();
    emitStage(record, "pipeline.stage.done", { stage: "element_images", succeeded: 0, failed: 0, skipped: true });
    return;
  }

  // 1) 列出所有 element (3 套 repo 都查)
  const slug = record.series_slug;
  loggerSync().info(`[autoPipeline:element_images] ${record.pipeline_id} 开始扫 ${slug} 全 element`);
  const allElements: ElementData[] = [];
  try {
    const chars = await listCharacters(slug);
    loggerSync().info(`[autoPipeline:element_images] listCharacters → ${chars.length} 个`);
    for (const c of chars) {
      const el = await adaptCharacterData(slug, c);
      if (el) allElements.push(el);
    }
  } catch (e) {
    loggerSync().warn(`[autoPipeline:element_images] listCharacters 失败: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const scenes = await listScenes(slug);
    loggerSync().info(`[autoPipeline:element_images] listScenes → ${scenes.length} 个`);
    for (const s of scenes) {
      const el = await adaptSceneData(slug, s);
      if (el) allElements.push(el);
    }
  } catch (e) {
    loggerSync().warn(`[autoPipeline:element_images] listScenes 失败: ${e instanceof Error ? e.message : e}`);
  }
  try {
    const others = await listElements(slug);
    loggerSync().info(`[autoPipeline:element_images] listElements → ${others.length} 个`);
    for (const el of others) allElements.push(el);
  } catch (e) {
    loggerSync().warn(`[autoPipeline:element_images] listElements 失败: ${e instanceof Error ? e.message : e}`);
  }
  loggerSync().info(`[autoPipeline:element_images] 共 ${allElements.length} 个 element`);

  // 2026-05-19 数据自愈
  for (const el of allElements) {
    const briefs = el.image_briefs ?? [];
    const dirty: number[] = [];
    briefs.forEach((b, idx) => {
      if (b.generated && b.image_id && !el.images.some((im) => im.image_id === b.image_id)) {
        dirty.push(idx);
      }
    });
    if (dirty.length === 0) continue;
    const fixedBriefs = briefs.map((b, idx) =>
      dirty.includes(idx) ? { ...b, generated: false, image_id: undefined } : b,
    );
    try {
      if (el.kind === "character") {
        await updateCharacter(slug, el.id, { image_briefs: fixedBriefs });
      } else if (el.kind === "scene") {
        await updateScene(slug, el.id, { image_briefs: fixedBriefs });
      } else {
        const { updateElement } = await import("../../../repositories/elementRepo");
        await updateElement(slug, el.id, { image_briefs: fixedBriefs });
      }
      el.image_briefs = fixedBriefs;
      loggerSync().warn(
        `[autoPipeline:element_images] 数据自愈: element=${el.id} 重置 ${dirty.length} 张 "标了 generated 但 image 不存在" 的脏 brief, 让其能重抽`,
      );
    } catch (selfHealErr) {
      loggerSync().warn(
        `[autoPipeline:element_images] 数据自愈失败 element=${el.id}: ${selfHealErr instanceof Error ? selfHealErr.message : selfHealErr}`,
      );
    }
  }

  // 2) 过滤出有 image_briefs 且至少 1 张未生成的 element
  const elementIdFilter = record.options.element_ids;
  const filteredElements = elementIdFilter && elementIdFilter.length > 0
    ? allElements.filter((el) => elementIdFilter.includes(el.id))
    : allElements;
  if (elementIdFilter && elementIdFilter.length > 0) {
    loggerSync().info(
      `[autoPipeline:element_images] 限定 element_ids=[${elementIdFilter.join(",")}], 过滤后剩 ${filteredElements.length} 个`,
    );
  }
  const queue = filteredElements.filter((el) => {
    const briefs = el.image_briefs ?? [];
    return briefs.some((b) => !b.generated);
  });

  const totalBriefs = queue.reduce(
    (acc, el) => acc + (el.image_briefs ?? []).filter((b) => !b.generated).length,
    0,
  );
  stage.total = totalBriefs;

  if (totalBriefs === 0) {
    stage.status = "skipped";
    stage.finished_at = new Date().toISOString();
    emitStage(record, "pipeline.stage.done", { stage: "element_images", succeeded: 0, failed: 0, skipped: true });
    return;
  }

  // 3) 解析图像 provider
  const seriesData = await readSeries(slug);
  const imageProviderRef =
    record.options.image_provider_id
    || seriesData?.defaults?.image_provider_id
    || "";

  loggerSync().info(
    `[autoPipeline:element_images] queue=${queue.length} totalBriefs=${totalBriefs} provider="${imageProviderRef}"`,
  );

  if (!imageProviderRef) {
    stage.status = "failed";
    stage.error = "图像 provider 未指定 — 请在弹窗选 ModelPicker, 或在系列设置默认图像模型";
    stage.finished_at = new Date().toISOString();
    emitStage(record, "pipeline.stage.done", { stage: "element_images", succeeded: 0, failed: totalBriefs, error: stage.error });
    throw new Error(stage.error);
  }

  const CONCURRENCY = 3;

  let completed = 0;
  let failed = 0;

  async function runOneElement(elInitial: ElementData): Promise<void> {
    let el = (await readAnyElement(slug, elInitial.id)) ?? elInitial;
    const briefs = el.image_briefs ?? [];

    for (let i = 0; i < briefs.length; i++) {
      if (signal.aborted) throw new Error("pipeline_aborted");
      const brief = briefs[i];
      if (brief.generated) continue;

      const compileInput = {
        element_kind: el.kind as AssetElementKind,
        element_name: el.name,
        element_description: el.description,
        element_tags: el.tags.map((t) => ({ axis: t.axis, value: t.value })),
        user_instruction: `视角: ${brief.angle}. 具体内容: ${brief.description}`,
        aspect_hint: "竖屏 9:16 短剧画幅",
      };
      const compiled = compileImagePrompt(compileInput);

      const referenceImages = el.images
        .filter((im) => im.is_typical === true)
        .slice(0, 8)
        .map((im) => (im.vault_id ? { vault_id: im.vault_id } : { asset_id: im.asset_id! }))
        .filter((r) => r.vault_id || r.asset_id);

      loggerSync().info(
        `[autoPipeline:element_images] 开始生第 ${i + 1} 张 (${el.kind}/${el.name}) angle="${brief.angle}"`,
      );
      const genStart = Date.now();
      try {
        const generationPromise = generateImagesForTarget(
          {
            prompt: compiled.full_prompt,
            negative_prompt: compiled.negative_prompt,
            provider_id: imageProviderRef || undefined,
            model_ref: imageProviderRef || undefined,
            width: 1024,
            height: 1024,
            count: 1,
            reference_images: referenceImages.length ? referenceImages : undefined,
            strict_reference_images: false,
            default_provider_id: seriesData?.defaults?.image_provider_id || undefined,
            target: {
              kind: "element",
              series_slug: slug,
              target_id: el.id,
              meta: {
                element_kind: el.kind,
                element_name: el.name,
                brief_angle: brief.angle,
                brief_index: i,
              },
            },
          },
          { registry: getRegistry() },
        );
        const result = await generationPromise;

        const persisted = result.images[0];
        if (!persisted) throw new Error("orchestrator 返回 0 张图");

        try {
          await patchAnyElementImageMeta(slug, el.id, persisted.image_id, {
            is_typical: true,
          });
        } catch (markErr) {
          loggerSync().warn(
            `[autoPipeline:element_images] 标 typical 失败 (继续): ${markErr instanceof Error ? markErr.message : markErr}`,
          );
        }

        const updatedBriefs: ImageBrief[] = briefs.map((b, idx) =>
          idx === i ? { ...b, generated: true, image_id: persisted.image_id } : b,
        );

        if (el.kind === "character") {
          await updateCharacter(slug, el.id, { image_briefs: updatedBriefs });
        } else if (el.kind === "scene") {
          await updateScene(slug, el.id, { image_briefs: updatedBriefs });
        } else {
          const { updateElement } = await import("../../../repositories/elementRepo");
          await updateElement(slug, el.id, { image_briefs: updatedBriefs });
        }

        el = (await readAnyElement(slug, el.id)) ?? el;
        (el as ElementData).image_briefs = updatedBriefs;

        completed += 1;
        loggerSync().info(
          `[autoPipeline:element_images] ✓ 第 ${i + 1} 张完成 (${Date.now() - genStart}ms) element=${el.id}`,
        );
      } catch (genErr) {
        if (genErr instanceof Error && genErr.message === "pipeline_aborted") throw genErr;
        failed += 1;
        const prev = stage.failed_ids ?? [];
        if (!prev.includes(el.id)) {
          stage.failed_ids = [...prev, el.id];
        }
        const errMsg = genErr instanceof Error ? genErr.message : String(genErr);
        const kindLabel = el.kind === "character" ? "角色" : el.kind === "scene" ? "场景" : "素材";
        const friendlyMsg = `${kindLabel}「${el.name}」第 ${i + 1} 张「${brief.angle}」生成失败: ${errMsg}`;
        loggerSync().warn(
          `[autoPipeline:element_images] ✗ 生图失败 element=${el.id} brief[${i}] angle="${brief.angle}" (${Date.now() - genStart}ms): ${errMsg}`,
        );
        // 2026-05-22 bug A 修: 失败必须写 failureRepo, 否则 FailureCenter UI 永远看不到, 用户无法重抽.
        appendFailure(slug, {
          kind: "element_image",
          code: "element_image_failed",
          message: friendlyMsg,
          provider: imageProviderRef,
          attempt_id: `pipeline_${record.pipeline_id}_element_${el.id}_brief_${i}`,
        }).catch(() => { /* fire-and-forget, 不阻塞 */ });
        // 2026-05-22 bug B 修: pipeline 数据加详细失败信息, UI 显示哪张 brief + 错误原因.
        const prevDetails = stage.failed_details ?? [];
        stage.failed_details = [
          ...prevDetails,
          {
            target_id: el.id,
            target_name: el.name,
            sub_label: brief.angle,
            sub_index: i,
            // 2026-05-26 单条重抽: brief 数据结构没有 id 字段, 前端用 sub_index 定位
            // (在前端 getElement 后取 image_briefs[sub_index] 拿到 angle/description).
            // brief_id 字段保留作向后兼容预留, 待 ImageBrief 加 id 时再填.
            error: errMsg.slice(0, 300),
            ts: new Date().toISOString(),
          },
        ];
      }

      stage.completed = completed;
      stage.failed = failed;
      emitStage(record, "pipeline.stage.progress", {
        stage: "element_images",
        completed,
        total: totalBriefs,
        failed,
        // 2026-05-26 修 "5 失败但只显示 4 条明细" — progress 事件也带 failed_ids / failed_details,
        // 让前端 reducer 同步明细数组. 之前只在 stage.done 才推, 用户看进行中态 details 永远落后.
        failed_ids: stage.failed_ids ?? [],
        failed_details: stage.failed_details ?? [],
      });
    }
  }

  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    if (signal.aborted) throw new Error("pipeline_aborted");
    const chunk = queue.slice(i, i + CONCURRENCY);
    loggerSync().info(
      `[autoPipeline:element_images] 启动批次 ${Math.floor(i / CONCURRENCY) + 1}, ${chunk.length} 个 element 入队 (实际并发受全局 imageGenSemaphore 限制 ≤ ${process.env.IMAGE_GEN_MAX_CONCURRENCY ?? 3})`,
    );
    await Promise.all(chunk.map((el) => runOneElement(el)));
  }

  stage.status = "done";
  stage.finished_at = new Date().toISOString();
  emitStage(record, "pipeline.stage.done", {
    stage: "element_images",
    succeeded: completed,
    failed,
    failed_ids: stage.failed_ids ?? [],
    // 2026-05-22 bug B: 推送 failed_details, 前端 UI 显示具体哪张 brief + 原因
    failed_details: stage.failed_details ?? [],
  });
}
