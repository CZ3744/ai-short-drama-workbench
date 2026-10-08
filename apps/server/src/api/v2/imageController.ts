import { Router } from "express";
import { z } from "zod";
import { generateImagesWithProvider } from "../../application/generation/imageGenerationService";
import { getRegistry } from "./orchestration/_shared/registry";

export const imageRouter = Router();

const ImageInputRefSchema = z.object({
  asset_id: z.string().max(1000).optional(),
  vault_id: z.string().max(200).optional(),
  path: z.string().max(1000).optional(),
  data_url: z.string().max(50 * 1024 * 1024).optional(),
  base64: z.string().max(50 * 1024 * 1024).optional(),
  mime: z.string().max(100).optional(),
  weight: z.number().min(0).max(1).optional(),
});

const GenerateImageSchema = z.object({
  provider_id: z.string().max(200).optional(),
  model_ref: z.string().max(200).optional(),
  prompt: z.string().min(1).max(12000),
  negative_prompt: z.string().max(4000).optional(),
  width: z.number().int().min(256).max(4096).default(1024),
  height: z.number().int().min(256).max(4096).default(1024),
  count: z.number().int().min(1).max(16).default(1),
  seed: z.number().int().optional(),
  series_slug: z.string().max(128).optional(),
  reference_images: z.array(ImageInputRefSchema).max(8).optional(),
  strict_reference_images: z.boolean().optional(),
  extras: z.record(z.string(), z.unknown()).optional(),
}).refine(
  // W7 (2026-05-16): 红线 #1 — 禁止 silent fallback 到 local_card_image。
  // raw `/api/v2/images/generate` 没有 series/shot 上下文兜底,必须 body 里显式带
  // provider_id 或 model_ref,否则 400。
  (data) => Boolean((data.provider_id && data.provider_id.trim()) || (data.model_ref && data.model_ref.trim())),
  { message: "请显式选择图像模型,不可使用默认值", path: ["model_ref"] },
);

imageRouter.post("/images/generate", async (req, res, next) => {
  const started = Date.now();
  try {
    const parsed = GenerateImageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // 区分 provider 缺失 vs 一般 schema 错误,前端可以根据 code 路由到 ModelPicker
      const flat = parsed.error.flatten();
      const providerMissing = (flat.fieldErrors?.model_ref || []).some(
        (m) => typeof m === "string" && m.includes("请显式选择图像模型"),
      );
      res.status(400).json({
        error: providerMissing
          ? { code: "provider_not_selected", message: "请显式选择图像模型,不可使用默认值" }
          : { code: "ValidationError", message: "请求体校验失败", details: flat },
      });
      return;
    }

    const taskId = `image_generate_${Date.now()}`;
    const result = await generateImagesWithProvider({ ...parsed.data, task_id: taskId, job_id: taskId }, {
      registry: getRegistry(),
      log: (level, msg, meta) => {
        const line = `[image-generate] ${msg}`;
        if (level === "error") console.error(line, meta ?? "");
        else if (level === "warn") console.warn(line, meta ?? "");
        else console.log(line, meta ?? "");
      },
    });

    res.json({
      ok: true,
      provider_id: result.provider_id,
      elapsed_ms: Date.now() - started,
      images: result.images.map((img, index) => ({
        index,
        data_url: `data:${img.mime || "image/png"};base64,${img.buffer.toString("base64")}`,
        base64: img.buffer.toString("base64"),
        mime: img.mime || "image/png",
        bytes: img.buffer.length,
        width: img.width,
        height: img.height,
        seed: img.seed,
      })),
      cost: result.cost,
      task_id: taskId,
    });
  } catch (err) {
    next(err);
  }
});
