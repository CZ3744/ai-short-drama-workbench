/**
 * v2 Vault Controller — AssetVault API routes (split entry point)
 *
 * 挂载前缀: /vault (经由 v2Router.use("/vault", vaultRouter))
 *
 * 原 vaultController.ts 982 行按 endpoint domain 拆 6 个子文件:
 *   - crud.ts         基础 CRUD (list / stats / cost-stats / get / patch / trash / restore)
 *   - media.ts        媒体下载 (raw + thumbnail)
 *   - annotations.ts  批注 CRUD (add / list / delete)
 *   - remix.ts        改一版 (preview-prompt + remix)
 *   - inpaint.ts      局部重抽 (mask-based inpaint)
 *   - export.ts       导出 (zip export + download)
 *   - _shared.ts      共享 helper (display_name merge / SVG placeholder / annotation storage / entity ref)
 *
 * 装载顺序: static 路径在前 (crud 的 /stats, /cost-stats), 参数化路径在后.
 * 每个子 router 的路径互不冲突.
 *
 * 路由路径与行为 100% 不变 — 只搬运 + 调整 import.
 */

import { Router } from "express";
import { crudRouter } from "./crud";
import { annotationsRouter } from "./annotations";
import { mediaRouter } from "./media";
import { remixRouter } from "./remix";
import { inpaintRouter } from "./inpaint";
import { exportRouter } from "./export";

export const vaultRouter = Router();

// 装载顺序: 注释型 static 路径 (/stats, /cost-stats) 先挂, 避免被 /:id 吃掉.
// 注: crudRouter 内部 GET /stats 在 GET /:id 前面, 所以放在最前面是安全的.
vaultRouter.use(crudRouter);
vaultRouter.use(annotationsRouter);
vaultRouter.use(mediaRouter);
vaultRouter.use(remixRouter);
vaultRouter.use(inpaintRouter);
vaultRouter.use(exportRouter);
