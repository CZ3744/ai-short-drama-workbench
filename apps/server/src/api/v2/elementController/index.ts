/**
 * v2 Element Controller — 装配各子文件 Router 到统一 elementRouter.
 *
 * 设计见 docs/ASSET_MANAGEMENT_REDESIGN.md (§3.3 §7 §10).
 *
 * 2026-05-21 P1 拆分: 原 elementController.ts 1548 行按 endpoint 类型拆 7 个子文件:
 *   - crud.ts        基础 CRUD (list / get / create / update / delete / usage)
 *   - images.ts      图片管理 (import-image / patch / batch / set/clear-primary / delete)
 *   - generation.ts  生成 (compile-prompt / generate-image / dry-run / autofill)
 *   - reject.ts      废案库 (reject / list / promote / import)
 *   - import.ts      跨项目导入 (import-from)
 *   - trash.ts       回收站 (list / restore / permanent-delete)
 *   - _shared.ts     共享 helper + 常量
 *
 * 装载顺序无关紧要 — 每个子 router 的路径互不冲突.
 */

import { Router } from "express";
import { crudRouter } from "./crud";
import { imagesRouter } from "./images";
import { generationRouter } from "./generation";
import { rejectRouter } from "./reject";
import { importRouter } from "./import";
import { trashRouter } from "./trash";
import { syncRouter } from "./sync";

export const elementRouter = Router();

elementRouter.use(crudRouter);
elementRouter.use(imagesRouter);
elementRouter.use(generationRouter);
elementRouter.use(rejectRouter);
elementRouter.use(importRouter);
elementRouter.use(trashRouter);
// W3 2026-05-26: 同源素材 push/pull 同步 (derivatives / upstream-diff / pull / push)
elementRouter.use(syncRouter);
