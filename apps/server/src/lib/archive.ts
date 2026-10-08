import { createRequire } from "node:module";
import type { Archiver } from "archiver";

// 2026-07-22 XT-T1 (X7-2 兄弟点收口): 版本无关 zip archiver 工厂, 从
// apps/server/src/api/dataManagement.ts 抽到这个中立共享模块 —— api 层与 application 层
// (apps/server/src/application/export/exportUseCases.ts) 都要用同一份工厂, 但两层之间禁止
// 互相 import (api ↔ application 不许交叉引用), 所以落在 api/ 和 application/ 的共同兄弟目录
// apps/server/src/lib/ 下, 二者都能正向 import。
//
// 背景 (X7-2 记录的真根因): archiver@8 是 ESM-only 破坏性重写, 抛弃了旧的可调用工厂
// `archiver("zip", opts)`, 只导出具名类 `{ ZipArchive, TarArchive, JsonArchive }`。
// `require("archiver")` 拿到的是模块 namespace (对象、不可调用) → 老写法
// `archiverFactory("zip", opts)` 运行时炸 "archiver is not a function"。而
// `@types/archiver@7.0.0` 仍描述旧工厂签名 `export = archiver` → 类型能过 tsc、运行时挂
// (经典类型/运行时不一致坑, tsc 看不出来)。
// dataManagement.ts 当时已用这套三路兜底修好; exportUseCases.ts (2026-05-28 P0-17 引入) 是
// 完全相同的坏 createRequire 写法, 用户点"导出剧集"就会踩同一个 "archiver is not a function"。
//
// 三路兜底: v8 具名类 / v7(及更早) 可调用工厂 / interop default 导出, 全部无法识别才抛清晰错误
// (不 silent fallback — 铁律 #3)。
const nodeRequire = createRequire(import.meta.url);

type ZipArchiveCtor = new (opts?: { zlib?: { level?: number } }) => Archiver;
type ArchiverFactory = (format: string, opts?: { zlib?: { level?: number } }) => Archiver;
interface ArchiverModuleShape {
  ZipArchive?: ZipArchiveCtor;
  default?: ArchiverFactory;
}

const archiverModule = nodeRequire("archiver") as ArchiverModuleShape | ArchiverFactory;

export function createZipArchive(options?: { zlib?: { level?: number } }): Archiver {
  const mod = archiverModule;
  if (typeof mod === "function") return mod("zip", options); // archiver@≤7 可调用工厂
  if (typeof mod.ZipArchive === "function") return new mod.ZipArchive(options); // archiver@8 具名类
  if (typeof mod.default === "function") return mod.default("zip", options); // interop default
  throw new Error("archiver 模块无法识别: 既非可调用工厂也无 ZipArchive 具名类 (检查 archiver 版本)");
}
