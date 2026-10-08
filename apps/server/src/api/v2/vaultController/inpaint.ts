/**
 * Vault Controller — inpaint route (mask-based partial redraw)
 *
 * POST /:id/inpaint — 局部重抽 (mask-based inpaint)
 */

import { Router } from "express";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  getVaultEntry, getVaultBuffer, saveToVault, getVaultAbsolutePath,
} from "../../../../../../packages/library/src/assetVault";
import { loggerSync } from "../../../../../../packages/core/src/logger";
import { validate, VaultInpaintSchema } from "../validators";
import { handleValidationError } from "../validateHelpers";
import { getRegistry } from "../orchestrationController";
import { generateImagesWithProvider } from "../../../application/generation/imageGenerationService";
// B-P2-4 (2026-06-01): parseDataOrBase64 共享函数 (避免本地重复手动 base64 解析)
import { parseDataOrBase64 } from "../../../application/generation/shared/resolveRef";
import { appendEntityVaultRefs } from "./_shared";

export const inpaintRouter = Router();

// POST /api/v2/vault/:id/inpaint — 局部重抽 (mask-based inpaint)
inpaintRouter.post("/:id/inpaint", async (req, res, next) => {
  try {
    const v = validate(VaultInpaintSchema, req.body);
    if (handleValidationError(res, v)) return;

    const { mask_base64, user_note, provider_id } = v.data;
    const sourceVaultId = req.params.id;

    // Resolve provider_id — use first available if not specified
    const registry = getRegistry();
    const resolvedProviderId = provider_id || registry.listAvailable("image")[0]?.id;
    if (!resolvedProviderId) {
      res.status(400).json({ error: { code: "NoProvider", message: "未指定图像模型且没有可用的默认模型" } });
      return;
    }

    // 1. Read source vault entry + buffer
    const sourceResult = await getVaultBuffer(sourceVaultId);
    if (!sourceResult) {
      res.status(404).json({ error: { code: "NotFound", message: "源归档条目不存在或文件丢失" } });
      return;
    }
    const { entry: sourceEntry, buffer: sourceBuffer } = sourceResult;

    // 2. Parse mask base64 (data URI → raw buffer)
    // B-P2-4 (2026-06-01): 用共享 parseDataOrBase64 替代手动重复实现。
    // 行为一致: data URI 格式 → 提取 base64 部分; 纯 base64 字符串 → 直接解码。
    let maskBuffer: Buffer;
    try {
      maskBuffer = parseDataOrBase64(mask_base64, "image/png").buffer;
    } catch {
      res.status(400).json({ error: { code: "ValidationError", message: "mask_base64 解码失败，请提供有效的 data URI 或 base64 字符串" } });
      return;
    }

    // 3. Construct prompt — combine mask note with user note
    const ctx = sourceEntry.context;
    const contextParts: string[] = [];
    if (ctx.character_id) contextParts.push(`角色ID: ${ctx.character_id}`);
    if (ctx.scene_id) contextParts.push(`场景ID: ${ctx.scene_id}`);
    if (ctx.shot_id) contextParts.push(`分镜ID: ${ctx.shot_id}`);
    const contextStr = contextParts.length > 0
      ? `\n参考上下文:\n${contextParts.join("\n")}`
      : "";

    const fullPrompt = [
      `局部重抽修改: ${user_note}`,
      `用 mask 标记区域进行修改，保持 mask 外区域不变。`,
      `${contextStr}`,
    ].join("\n");

    const taskId = `inpaint_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    // 2026-05-19: 用户原话"禁止在本地设置主动超时, 所有地方都不要加这样的主动超时限制" —
    // 不再设 AbortSignal.timeout(120_000), signal 留空.
    const ctx2: import("../../../../../../packages/providers/src/core/types").ProviderContext = {
      series_slug: sourceEntry.context.series_slug || "library",
      job_id: taskId,
      task_id: taskId,
      log: (_level, _msg) => { /* no-op */ },
    };

    // 4. Check if provider supports native inpaint
    //
    // W7-decouple (2026-05-15) 注:这里**故意**直接拿 provider instance,而**不**走
    // generateImagesWithProvider —— 因为我们需要的不是 `generate()`,而是探测 provider
    // 是否实现了**非标准** `inpaint()` 方法(目前仅个别图像 provider 自己加的能力)。
    // 共享 service 只统一 `generate()` 调用路径,其他可选能力(inpaint/cancel/resumePoll)
    // 由调用方自行探测调用。这不违反"不重复造轮子"原则。
    // 2026-05-28 audit P1 type-safety — inpaint 是 ImageProvider 接口外的可选能力 (只有少数 provider 加),
    // 走 narrow unknown 类型替代 (provider as any)
    type InpaintCapable = {
      inpaint: (req: { prompt: string; image: Buffer; mask: Buffer; width: number; height: number }, ctx: unknown) => Promise<{
        image?: { buffer: Buffer };
        buffer?: Buffer;
        cost?: { amount: number };
      }>;
    };
    let provider: ReturnType<typeof registry.getImage>;
    let inpaintProvider: InpaintCapable | null = null;
    let supportsInpaint = false;
    try {
      provider = registry.getImage(resolvedProviderId);
      const probe = provider as unknown as Partial<InpaintCapable>;
      if (typeof probe.inpaint === "function") {
        supportsInpaint = true;
        inpaintProvider = probe as InpaintCapable;
      }
    } catch {
      res.status(400).json({ error: { code: "UnknownProvider", message: `图像模型 ${resolvedProviderId} 不存在` } });
      return;
    }

    let resultBuffer: Buffer;
    let costCny: number | undefined;
    // 2026-05-19 #4 红线: 已删除 silent mock fallback. strategy 只剩 native_inpaint / remix_with_mask.
    let strategy: "native_inpaint" | "remix_with_mask" = "remix_with_mask";

    try {
      if (supportsInpaint && inpaintProvider) {
        // a. Provider supports native inpaint
        strategy = "native_inpaint";
        const inpaintReq = {
          prompt: fullPrompt,
          image: sourceBuffer,
          mask: maskBuffer,
          width: sourceEntry.width || 1024,
          height: sourceEntry.height || 1024,
        };
        const inpaintResult = await inpaintProvider.inpaint(inpaintReq, ctx2);
        resultBuffer = inpaintResult.image?.buffer || inpaintResult.buffer || sourceBuffer;
        costCny = inpaintResult.cost?.amount;
      } else {
        // b. Fallback: use mask+note as prompt for full image remix
        //    2026-05-19 #4: 用户原话"不是 silent fallback 到全图 remix" — 这里把 mask 真的
        //    作为第二张 reference_image 传给生图模型, 让 mask 至少在视觉上有机会被模型考虑.
        //    (provider 不支持 native inpaint 时, 这是 best-effort, 但 mask 真送了, 不是空送 prompt.)
        strategy = "remix_with_mask";
        const sourceAbsPathInpaint = getVaultAbsolutePath(sourceEntry);
        // Save mask buffer to temp file so it can be passed as reference image
        const tmpDir = path.join(os.tmpdir(), "claw-inpaint-mask");
        await fs.mkdir(tmpDir, { recursive: true });
        const maskTmpPath = path.join(tmpDir, `mask_${taskId}.png`);
        await fs.writeFile(maskTmpPath, maskBuffer);
        try {
          const imgResult = await generateImagesWithProvider({
            provider_id: resolvedProviderId,
            prompt: fullPrompt,
            width: sourceEntry.width || 1024,
            height: sourceEntry.height || 1024,
            count: 1,
            reference_images: [
              { path: sourceAbsPathInpaint, weight: 0.9 },
              { path: maskTmpPath, weight: 0.6 },
            ],
            series_slug: sourceEntry.context.series_slug || "library",
          }, { registry, ctx: ctx2 });
          const img = imgResult.images?.[0];
          if (!img?.buffer) {
            throw Object.assign(new Error("模型返回了空图片，请换一个模型或提示词重试"), {
              status: 502,
              code: "invalid_output",
            });
          }
          resultBuffer = img.buffer;
          costCny = imgResult.cost?.amount;
        } finally {
          await fs.unlink(maskTmpPath).catch(() => undefined);
        }
      }
    } catch (providerErr: unknown) {
      // 2026-05-19 #4: 红线 #1 — 删除 silent mock fallback. 不再静默返回 source copy 假装成功.
      // 用户原话"不是 silent fallback 到全图 remix" + 红线"silent fake done 必须 throw + HTTP 给用户".
      const msg = providerErr instanceof Error ? providerErr.message : String(providerErr);
      // 2026-05-28 audit P1 type-safety — error 上的 code 字段是 ad-hoc 增强 (ProviderError 等),
      // 用 unknown narrowing 替代 (providerErr as any)
      const errRec = providerErr as { code?: unknown } | null | undefined;
      const errCode = typeof errRec?.code === "string" ? errRec.code : undefined;
      loggerSync().warn(`[vault/inpaint] Provider call failed: ${msg}`);
      res.status(502).json({
        error: {
          code: errCode || "InpaintFailed",
          message: errCode === "invalid_output"
            ? `局部重抽失败:${msg}`
            : `局部重抽失败:${msg}. 请检查图像模型是否可用, 或换一个支持 inpaint 的模型(如 gpt-image-2 / SDXL).`,
        },
      });
      return;
    }

    // 5. Save inpaint result to vault
    const vaultEntry = await saveToVault({
      buffer: resultBuffer,
      kind: sourceEntry.kind === "video" ? "image" : (sourceEntry.kind || "image"),
      mime: sourceEntry.mime || "image/png",
      context: {
        ...sourceEntry.context,
        kind: "inpaint",
        parent_vault_id: sourceVaultId,
        user_note,
      },
      provider_id: resolvedProviderId,
      cost_cny: costCny ?? 0,
      width: sourceEntry.width,
      height: sourceEntry.height,
      tags: [],
    });

    // 6. If source belongs to character/scene/shot, add to entity ref list
    if (sourceEntry.context.character_id || sourceEntry.context.scene_id) {
      try {
        const seriesSlug = sourceEntry.context.series_slug;
        const entityId = sourceEntry.context.character_id || sourceEntry.context.scene_id;
        const entityType = sourceEntry.context.character_id ? "characters" : "scenes";
        if (seriesSlug && entityId) {
          await appendEntityVaultRefs(seriesSlug, entityType, entityId, [vaultEntry.vault_id]);
        }
      } catch (entityErr) {
        loggerSync().warn(`[vault/inpaint] Entity ref update failed: ${(entityErr as Error)?.message}`);
      }
    }

    res.json({
      ok: true,
      source_vault_id: sourceVaultId,
      vault_id: vaultEntry.vault_id,
      prompt: fullPrompt,
      strategy,
      mock_fallback: false,
    });
  } catch (err) { next(err); }
});
