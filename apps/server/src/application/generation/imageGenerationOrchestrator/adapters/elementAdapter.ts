/**
 * element adapter — 把生成结果写进 elementRepo / characterRepo / sceneRepo.
 *
 * 调用入口: elementController POST /elements/:id/generate-image
 *
 * 对应原 elementController 678-731 行 53 行 post-处理. 走完整链路:
 *   1. 写 series 文件 + saveToVault + addAsset (走 _shared.persistImageBuffer)
 *   2. 调 elementController 现有的 addAnyElementImage helper (适配 character/scene 旧 repo)
 *
 * adapter 不复制 characterRepo 内部逻辑, 而是借助已有 addAnyElementImage. element 的
 * kind=character 时它会把 asset_id 同时 push 到 character.ref_image_ids.
 */

import { persistImageBuffer, buildImageUrl } from "./_shared";
import type { ImageTargetAdapter, PersistedImage } from "../types";

export const elementAdapter: ImageTargetAdapter = {
  async persist({ image, target, provider_id, request, batch_index }): Promise<PersistedImage> {
    if (!target.target_id) throw new Error("element adapter 需要 target.target_id (element id)");

    // 把 element kind 和 i2i 标记从 meta 里取出. meta 由 controller 调用时填.
    const elKind = typeof target.meta?.element_kind === "string" ? target.meta.element_kind : "element";
    const elName = typeof target.meta?.element_name === "string" ? target.meta.element_name : "";
    const isI2i = request.i2i_base?.image_id !== undefined;
    // 2026-05-20 Wave T Phase 5 — caller (elementController) 可传 image_brief.angle 当默认名,
    // 让用户在素材库看到"标准像"/"伸手抢夺" 等有意义的名字,而非"小林 #1".
    const briefAngle = typeof target.meta?.brief_angle === "string" ? target.meta.brief_angle.trim() : "";

    const tags = [
      `element:${target.target_id}`,
      `${elKind}:${target.target_id}`,
      "ref_image",
      `provider:${provider_id}`,
      ...(request.extra_tags ?? []),
    ];

    const { vault, asset } = await persistImageBuffer({
      image,
      series_slug: target.series_slug,
      filename_prefix: `element_${target.target_id}`,
      vault_context: {
        kind: "variant",
        series_slug: target.series_slug,
        user_note: elName ? `element:${elKind}:${elName}` : undefined,
      },
      tags,
      provider_id,
      cost_cny: undefined,
      batch_index,
    });

    // 通过 elementController 的 addAnyElementImage 写业务对象 (含 character/scene 适配).
    // 动态 import 避免 controller 反向依赖 adapter 而成循环.
    const { addAnyElementImage } = await import("../../../../api/v2/elementController.helpers");
    const added = await addAnyElementImage(target.series_slug, target.target_id, {
      vault_id: vault.vault_id,
      asset_id: asset.asset_id,
      origin: isI2i ? "i2i" : "generated",
      prompt_snapshot: request.prompt,
      based_on_image_id: request.i2i_base?.image_id,
      provider_id,
      seed: image.seed,
      url: buildImageUrl({ series_slug: target.series_slug, vault_id: vault.vault_id }),
      mime: image.mime || "image/png",
      // Phase 5: 若 caller 显式传了 brief_angle (e.g. "标准像"/"伸手抢夺"), 用它当默认名,
      // 否则走 addAnyElementImage 内部的 "{element.name} #N" 兜底
      display_name: briefAngle || undefined,
    });
    if (!added) {
      throw Object.assign(new Error(`element ${target.target_id} 不存在或写入图片失败`), {
        status: 404,
        code: "NotFound",
      });
    }
    return {
      image_id: added.image.image_id,
      asset_id: asset.asset_id,
      vault_id: vault.vault_id,
      url: added.image.url ?? buildImageUrl({ series_slug: target.series_slug, vault_id: vault.vault_id }),
      width: image.width,
      height: image.height,
      seed: image.seed,
      mime: image.mime || "image/png",
      provider_id,
      prompt_snapshot: request.prompt,
    };
  },

  async readState(target): Promise<unknown> {
    if (!target.target_id) return undefined;
    const { readAnyElement } = await import("../../../../api/v2/elementController.helpers");
    return await readAnyElement(target.series_slug, target.target_id);
  },
};
