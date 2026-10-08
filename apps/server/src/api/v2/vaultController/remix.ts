/**
 * Vault Controller — remix routes (iterative remix + preview-prompt)
 *
 * POST /:id/remix/preview-prompt  — preview the full prompt without calling provider
 * POST /:id/remix                 — "改一版" iterative remix
 */

import { Router } from "express";
import { getVaultEntry, getVaultBuffer, getVaultAbsolutePath } from "../../../../../../packages/library/src/assetVault";
import { loggerSync } from "../../../../../../packages/core/src/logger";
import { validate, VaultRemixSchema } from "../validators";
import { handleValidationError } from "../validateHelpers";
import { getRegistry } from "../orchestrationController";
import { generateImagesForTarget } from "../../../application/generation/imageGenerationOrchestrator";
import { readAnnotations, appendEntityVaultRefs } from "./_shared";

export const remixRouter = Router();

// 2026-05-19 Wave O Audit P0 #1: vault remix preview-prompt 端点
// 让前端"查看完整提示词"按钮拿到真实将要发给模型的 prompt + 源图 URL,
// 跟实际 remix 走的拼装路径一致 (铁律 #2 可干预性 + 铁律 #13 含图片素材).
// 零成本: 只构造 prompt 字符串, 不调 provider, 不写盘.
remixRouter.post("/:id/remix/preview-prompt", async (req, res, next) => {
  try {
    const v = validate(VaultRemixSchema, req.body);
    if (handleValidationError(res, v)) return;

    const { user_note, context_override } = v.data;
    const sourceVaultId = req.params.id;

    const sourceEntry = await getVaultEntry(sourceVaultId);
    if (!sourceEntry) {
      res.status(404).json({ error: { code: "NotFound", message: "源归档条目不存在" } });
      return;
    }

    const sourceAnnotations = await readAnnotations(sourceVaultId);
    let annotationPrompt = "";
    if (sourceAnnotations.length > 0) {
      const lines = sourceAnnotations.map((a: { coords: { x: number; y: number; w?: number; h?: number }; type: string; note: string }) => {
        const coordParts: string[] = [`${a.coords.x}`, `${a.coords.y}`];
        if (a.type === "box" && a.coords.w && a.coords.h) {
          coordParts.push(`w=${a.coords.w}`, `h=${a.coords.h}`);
        }
        return `- 在 (${coordParts.join(",")}): "${a.note}"`;
      });
      annotationPrompt = `参考图批注:\n${lines.join("\n")}\n请在新图里保留批注为好的部分，避免批注为不好的部分。`;
    }

    const overrides = context_override || {};
    const keepFace = overrides.keep_face ?? false;
    const keepPose = overrides.keep_pose ?? false;
    const keepStyle = overrides.keep_style ?? false;

    const basePromptParts: string[] = [];
    const ctx = sourceEntry.context;
    if (ctx.character_id) basePromptParts.push(`角色ID: ${ctx.character_id}`);
    if (ctx.scene_id) basePromptParts.push(`场景ID: ${ctx.scene_id}`);
    if (ctx.shot_id) basePromptParts.push(`分镜ID: ${ctx.shot_id}`);
    if (ctx.user_note) basePromptParts.push(`上次修改意见: ${ctx.user_note}`);
    if (sourceEntry.kind) basePromptParts.push(`类型: ${sourceEntry.kind}`);
    const basePrompt = basePromptParts.length > 0
      ? `参考以下信息:\n${basePromptParts.join("\n")}`
      : "根据参考图进行修改";

    const constraintParts: string[] = [];
    if (keepFace) constraintParts.push("保留面部特征不变");
    if (keepPose) constraintParts.push("保留姿势/构图不变");
    if (keepStyle) constraintParts.push("保留整体风格不变");
    const constraints = constraintParts.length > 0
      ? constraintParts.join("; ")
      : "无特殊约束";

    const promptSegments = [basePrompt];
    if (annotationPrompt) promptSegments.push(annotationPrompt);
    promptSegments.push(`修改意见: ${user_note}`, `约束条件: ${constraints}`);
    const fullPrompt = promptSegments.join("\n");

    res.json({
      ok: true,
      source_vault_id: sourceVaultId,
      source_url: `/api/v2/vault/${sourceVaultId}/raw`,
      source_thumb_url: `/api/v2/vault/${sourceVaultId}/thumbnail?size=512`,
      full_prompt: fullPrompt,
      segments: [
        { label: "源图上下文", text: basePrompt },
        ...(annotationPrompt ? [{ label: "源图批注", text: annotationPrompt }] : []),
        { label: "修改意见", text: user_note },
        { label: "约束条件", text: constraints },
      ],
      annotations_count: sourceAnnotations.length,
    });
  } catch (err) { next(err); }
});

// POST /api/v2/vault/:id/remix — "改一版" iterative remix
remixRouter.post("/:id/remix", async (req, res, next) => {
  try {
    const v = validate(VaultRemixSchema, req.body);
    if (handleValidationError(res, v)) return;

    const { user_note, count, provider_id, context_override } = v.data;
    const sourceVaultId = req.params.id;

    // Resolve provider_id — use first available if not specified
    const registry = getRegistry();
    const resolvedProviderId = provider_id || registry.listAvailable("image")[0]?.id;
    if (!resolvedProviderId) {
      res.status(400).json({ error: { code: "NoProvider", message: "未指定图像模型且没有可用的默认模型" } });
      return;
    }

    const overrides = context_override || {};
    const keepFace = overrides.keep_face ?? false;
    const keepPose = overrides.keep_pose ?? false;
    const keepStyle = overrides.keep_style ?? false;

    // 1. Read source vault entry + buffer
    const sourceResult = await getVaultBuffer(sourceVaultId);
    if (!sourceResult) {
      res.status(404).json({ error: { code: "NotFound", message: "源归档条目不存在或文件丢失" } });
      return;
    }
    const { entry: sourceEntry, buffer: sourceBuffer } = sourceResult;

    // 2. Read annotations on the source image
    const sourceAnnotations = await readAnnotations(sourceVaultId);
    let annotationPrompt = "";
    if (sourceAnnotations.length > 0) {
      const lines = sourceAnnotations.map(a => {
        const coordParts = [`${a.coords.x}`, `${a.coords.y}`];
        if (a.type === "box" && a.coords.w && a.coords.h) {
          coordParts.push(`w=${a.coords.w}`, `h=${a.coords.h}`);
        }
        return `- 在 (${coordParts.join(",")}): "${a.note}"`;
      });
      annotationPrompt = `参考图批注:\n${lines.join("\n")}\n请在新图里保留批注为好的部分，避免批注为不好的部分。`;
    }

    // 3. Construct prompt
    // Base: source context info
    const basePromptParts: string[] = [];
    const ctx = sourceEntry.context;
    if (ctx.character_id) basePromptParts.push(`角色ID: ${ctx.character_id}`);
    if (ctx.scene_id) basePromptParts.push(`场景ID: ${ctx.scene_id}`);
    if (ctx.shot_id) basePromptParts.push(`分镜ID: ${ctx.shot_id}`);
    if (ctx.user_note) basePromptParts.push(`上次修改意见: ${ctx.user_note}`);
    if (sourceEntry.kind) basePromptParts.push(`类型: ${sourceEntry.kind}`);
    const basePrompt = basePromptParts.length > 0
      ? `参考以下信息:\n${basePromptParts.join("\n")}`
      : "根据参考图进行修改";

    // Constraints from context_override
    const constraintParts: string[] = [];
    if (keepFace) constraintParts.push("保留面部特征不变");
    if (keepPose) constraintParts.push("保留姿势/构图不变");
    if (keepStyle) constraintParts.push("保留整体风格不变");
    const constraints = constraintParts.length > 0
      ? constraintParts.join("; ")
      : "无特殊约束";

    const promptSegments = [basePrompt];
    if (annotationPrompt) promptSegments.push(annotationPrompt);
    promptSegments.push(`修改意见: ${user_note}`, `约束条件: ${constraints}`);

    const fullPrompt = promptSegments.join("\n");

    // 3. Call image provider — pass source image as reference input.
    //
    // W7-decouple: fail-fast preflight 探针,纯为给用户友好的 HTTP 400 + 中文文案。
    // 实际 generate 走下面 generateImagesWithProvider(共享 service)。两次都查 registry
    // 看起来重复,但这一次是"early return 路由层 400";service 内部那一次是"运行时找不到 throw"。
    try {
      registry.getImage(resolvedProviderId);
    } catch {
      res.status(400).json({ error: { code: "UnknownProvider", message: `图像模型 ${resolvedProviderId} 不存在` } });
      return;
    }

    // W8 Phase 1 解耦: vault remix 每次一张图, 走 vault_only adapter 统一 saveToVault.
    // context propagation (character_id/scene_id/shot_id/parent_vault_id) 通过 target.meta 传.
    const results: Array<{ vault_id: string; cost_cny?: number }> = [];
    for (let i = 0; i < count; i++) {
      try {
        // D5: 先解析 vault 绝对路径再传 reference_images
        const sourceAbsPath = getVaultAbsolutePath(sourceEntry);
        const remixResult = await generateImagesForTarget(
          {
            prompt: fullPrompt,
            provider_id: resolvedProviderId,
            model_ref: resolvedProviderId,
            width: sourceEntry.width || 1024,
            height: sourceEntry.height || 1024,
            count: 1,
            reference_images: [{ path: sourceAbsPath, weight: 0.8 }],
            strict_reference_images: false,
            target: {
              kind: "vault_only",
              series_slug: sourceEntry.context.series_slug || "library",
              meta: {
                vault_context_kind: "variant",
                character_id: sourceEntry.context.character_id,
                scene_id: sourceEntry.context.scene_id,
                shot_id: sourceEntry.context.shot_id,
                parent_vault_id: sourceVaultId,
                user_note,
              },
            },
            extra_tags: ["remix", `parent:${sourceVaultId}`],
          },
          { registry },
        );
        for (const persisted of remixResult.images) {
          if (!persisted.vault_id) {
            console.error("[vault/remix] vault_only adapter 未返回 vault_id");
            throw new Error("图片生成未完成，请稍后重试");
          }
          results.push({
            vault_id: persisted.vault_id,
            cost_cny: remixResult.cost?.amount,
          });
        }
      } catch (providerErr: unknown) {
        // Provider failed — return error immediately, no mock fallback
        const providerMsg = providerErr instanceof Error ? providerErr.message : String(providerErr);
        loggerSync().warn(`[vault/remix] Provider call ${i + 1}/${count} failed (${providerMsg})`);
        res.status(502).json({ ok: false, reason: "provider_unavailable", detail: providerMsg });
        return;
      }
    }

    // 5. If source belongs to character/scene/shot, add new results to entity ref list
    // For series characters/scenes, update their JSON metadata
    if (sourceEntry.context.character_id || sourceEntry.context.scene_id) {
      try {
        const seriesSlug = sourceEntry.context.series_slug;
        const entityId = sourceEntry.context.character_id || sourceEntry.context.scene_id;
        const entityType = sourceEntry.context.character_id ? "characters" : "scenes";
        if (seriesSlug && entityId) {
          await appendEntityVaultRefs(
            seriesSlug,
            entityType,
            entityId,
            results.map(r => r.vault_id),
          );
        }
      } catch (entityErr) {
        // Non-blocking: entity ref update failure does not fail the remix
        loggerSync().warn(`[vault/remix] Entity ref update failed: ${(entityErr as Error)?.message}`);
      }
    }

    res.json({
      ok: true,
      source_vault_id: sourceVaultId,
      results,
      count: results.length,
      prompt: fullPrompt,
    });
  } catch (err) { next(err); }
});
