/**
 * orchestrationController.ts — Step 3a barrel
 *
 * 原 4755 行的巨型 controller 已物理拆分到 ./orchestration/:
 *   _shared/   — registry / paths / llmJson / sse / scriptText / fallbacks / media / schemas
 *   *Routes.ts — 9 个 routes 文件 (30 个 handler 按工作流分组)
 *   index.ts   — 组装成单一 orchestrationRouter
 *
 * 这个文件现在只做 re-export, 保持下游 import 路径不破:
 *   - orchestrationRouter ← apps/server/src/api/v2/index.ts
 *   - getRegistry         ← ai/character/library/scene/vaultController + apps/server/src/index.ts
 *
 * 后续 Step 3b 会把 controller 里的业务逻辑进一步提取成 application/ 用例纯函数。
 * 原文件备份: orchestrationController.ts.bak (同目录, 不被 tsc 编译)
 */

export { orchestrationRouter } from "./orchestration";
export { getRegistry } from "./orchestration/_shared/registry";
