/**
 * v2 Element Controller — 已拆分到 ./elementController/ 子目录.
 *
 * 2026-05-21 P1 拆分: 原 1548 行单文件按 endpoint 类型拆 7 个子文件
 * (见 ./elementController/index.ts). 本文件保留只作 re-export shim,
 * 让 `import { elementRouter } from "./elementController"` 的 caller 零感知.
 */

export { elementRouter } from "./elementController/index";
