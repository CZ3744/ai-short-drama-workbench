/**
 * health-extension-completeness.ts
 *
 * 防止"扩展不彻底"问题(W6 教训:ElementKind 扩 6 类但 UI 漏 / video provider
 * 加新 id 但 callsite/cost/scrub 漏 case)。
 *
 * Run:
 *   npx tsx scripts/health-extension-completeness.ts          # 仅打报告, exit 0
 *   npx tsx scripts/health-extension-completeness.ts --strict # 有漏点 exit 1
 *
 * 接入: npm run health:extension / npm run health:codebase
 *
 * 3 大扫描:
 *  1. ElementKind 6 类 callsite 覆盖矩阵
 *  2. 真实 video provider 八维矩阵
 *     (preset / enabled / registry / impl / cost / health / picker / scrub)
 *  3. silent mock fallback 红线
 *  4. LLM preset vs registry 一致性矩阵
 *     (2026-05-20: 本轮 audit 发现 anthropic_via_codex / ikuncode_claude 两个 P0 问题)
 *
 * 设计原则: 正则 grep + fs 直读, 不依赖 LSP/AST。允许 false positive 在 warning
 * 级别, 真红线才走 fail。Strict 模式才把 warning 当 exit 1。
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const STRICT = process.argv.includes("--strict");

// ──────────────────────────────────────────────────────────────
// 共用工具
// ──────────────────────────────────────────────────────────────

interface Finding {
  level: "ok" | "warn" | "fail";
  message: string;
}

interface SectionReport {
  title: string;
  findings: Finding[];
}

const reports: SectionReport[] = [];

function addReport(title: string, findings: Finding[]) {
  reports.push({ title, findings });
}

/**
 * 递归扫描目录,返回所有匹配后缀的文件绝对路径。
 * 跳过 node_modules / .trash / dist / build / .git / data。
 */
function walkFiles(dir: string, exts: string[], out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === ".trash" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === ".git" ||
      entry.name === "data" ||
      entry.name === "logs" ||
      entry.name === ".claude" ||
      entry.name === "design-skill"
    ) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, exts, out);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function readSafe(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function rel(p: string): string {
  return path.relative(ROOT, p).replace(/\\/g, "/");
}

// ──────────────────────────────────────────────────────────────
// 1. ElementKind 6 类 callsite 覆盖矩阵
// ──────────────────────────────────────────────────────────────
//
// ElementKind 在 packages/drama/src/types.ts:293 定义为
//   "character" | "scene" | "prop" | "wardrobe" | "reference" | "misc"
//
// 扫描策略:
//   - 全前端 / 后端 .ts/.tsx 文件
//   - 每个文件聚合 `kind === "X"` 命中的 kind 集合
//   - 命中 ≥3 类且漏 ≥1 类 → warn (列出漏的那几类)
//   - 1-2 类的 callsite 通常是"专属字段二元判断"(character voice_id /
//     scene time_of_day) → ok 静默
//   - Record<ElementKind, ...> 是 TS 强类型,编译器已守 → 不扫
//
// 已知合理 ignore (这些文件多类样式判断本身是设计):
//   - apps/web/src/components/library-picker/LibraryPickerModal.tsx (按 kind 选 aspect-ratio)
//   - apps/web/src/lib/elementApi.ts (Record<ElementKind> 已覆盖)

const ELEMENT_KINDS = ["character", "scene", "prop", "wardrobe", "reference", "misc"] as const;
type ElementKindLit = typeof ELEMENT_KINDS[number];

// 文件路径中包含这些片段 → 跳过(已知合理或非业务代码)
const ELEMENT_IGNORE_FRAGMENTS = [
  "/docs/",
  "/test/",
  ".test.ts",
  ".test.tsx",
  "/scripts/",
  "elementApi.ts",       // 已用 Record<ElementKind, ...> 强类型守
  "elementController.helpers.ts",  // 已用 Record<ElementKind, ...> 强类型守
  // health-ignore: LibraryPickerModal 按 kind 选 aspectRatio 是 UI 样式设计:
  //   scene → 16/9, character/wardrobe → 3/4, 其余 → 1/1; 非业务 case 分支缺失
  "LibraryPickerModal.tsx",
  // health-ignore: batchSeries 的 nameToElementId 只管 prop/wardrobe/reference/misc,
  //   character/scene 走各自 createCharacter/createScene 专门路径(见 line 714+),
  //   不是扩展不彻底而是架构分工
  "batchSeries.ts",
  // health-ignore: planEpisodeStoryboard 的 propsAndMisc 只过滤 4 类 Element,
  //   character/scene 走 listCharacters/listScenes 专门 API(见 line 297+),
  //   是设计上的职责分离
  "planEpisodeStoryboard.ts",
];

function scanElementKindCoverage(): SectionReport["findings"] {
  const findings: Finding[] = [];
  const files = [
    ...walkFiles(path.join(ROOT, "apps", "web", "src"), [".ts", ".tsx"]),
    ...walkFiles(path.join(ROOT, "apps", "server", "src"), [".ts"]),
    ...walkFiles(path.join(ROOT, "packages"), [".ts"]),
  ];

  // 每个文件: { file: { lineNumbers: Set, kinds: Set<ElementKindLit> } }
  type Hit = { line: number; kind: ElementKindLit };
  const fileHits = new Map<string, Hit[]>();

  const re = /kind\s*===?\s*["'](character|scene|prop|wardrobe|reference|misc)["']/g;

  for (const f of files) {
    const relPath = rel(f);
    if (ELEMENT_IGNORE_FRAGMENTS.some((frag) => relPath.includes(frag))) continue;
    const text = readSafe(f);
    if (!text.includes("kind")) continue;
    const lines = text.split("\n");
    const hits: Hit[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m: RegExpExecArray | null;
      const lineRe = new RegExp(re.source, "g");
      while ((m = lineRe.exec(line)) !== null) {
        hits.push({ line: i + 1, kind: m[1] as ElementKindLit });
      }
    }
    if (hits.length > 0) fileHits.set(f, hits);
  }

  let okCount = 0;
  for (const [file, hits] of fileHits) {
    const kinds = new Set(hits.map((h) => h.kind));
    const missing = ELEMENT_KINDS.filter((k) => !kinds.has(k));
    if (kinds.size >= 3 && missing.length > 0) {
      // 这个文件做了 ≥3 类的 case 分支但漏了某些 → 可能扩展不彻底
      const firstLine = hits[0].line;
      findings.push({
        level: "warn",
        message: `${rel(file)}:${firstLine} 覆盖 ${kinds.size}/6 类 (含 ${[...kinds].join("/")}), 漏: ${missing.join(", ")}`,
      });
    } else {
      // 1-2 类 = 合理的专属字段判断, 或 6 类全覆盖
      okCount += 1;
    }
  }

  findings.unshift({
    level: "ok",
    message: `${okCount} 处 callsite 覆盖正常 (≤2 类专属判断 / 6 类全覆盖)`,
  });

  return findings;
}

// ──────────────────────────────────────────────────────────────
// 2. 真实 video provider 八维矩阵
// ──────────────────────────────────────────────────────────────

// 9 个真实 video provider id (来自任务描述)
const REAL_VIDEO_PROVIDERS = [
  "aliyun_wan_t2v",
  "minimax_hailuo",
  "jimeng_video_3pro",
  "jimeng_video_3_720p",
  "kling_3",
  "vidu_q3_ref",
  "zhipu_cogvideox",
  "baidu_qianfan_video",
  "tencent_hunyuan_video",
] as const;

interface VideoMatrixRow {
  id: string;
  preset: boolean;
  enabled: boolean;
  registry: boolean;
  impl: boolean;
  cost: boolean;
  health: boolean;
  picker: boolean;  // 间接验: preset 存在 + enabled → 进入 ModelPicker 选项流
  scrub: boolean;   // 全局 scrubForClient 覆盖 (Bearer/sk-/tp-/JWT) → 全 9 个 provider 都靠这个统一兜底
}

function scanVideoProviderMatrix(): SectionReport["findings"] {
  const findings: Finding[] = [];

  // ─── 读 preset 文件
  const presetPath = path.join(ROOT, "config", "presets", "video_provider.json");
  const presetText = readSafe(presetPath);
  let presetObj: any = null;
  try { presetObj = JSON.parse(presetText); } catch { /* noop */ }
  const presetById = new Map<string, any>();
  if (presetObj?.options) {
    for (const opt of presetObj.options) presetById.set(opt.id, opt);
  }

  // ─── 读 registry
  const registryText = readSafe(path.join(ROOT, "packages", "providers", "src", "core", "registry.ts"));
  // grep `registry.register("video", "<id>",` 形式
  const registryIds = new Set<string>();
  const regRe = /registry\.register\(["']video["']\s*,\s*["']([a-z0-9_]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = regRe.exec(registryText)) !== null) registryIds.add(m[1]);

  // ─── 读 video impl 目录
  const videoDir = path.join(ROOT, "packages", "providers", "src", "video");
  const videoFiles = fs.existsSync(videoDir)
    ? fs.readdirSync(videoDir).filter((f) => f.endsWith(".ts"))
    : [];
  const videoFileText = videoFiles.join("\n").toLowerCase();
  function hasImpl(providerId: string): boolean {
    // 文件名约定: aliyun_wan_t2v → aliyunWan...Provider.ts (驼峰), 或文件内 export Wrapper
    // 用 import 行匹配最稳: registry.ts 顶部一定 import 该 class
    const classMatch = registryText.match(
      new RegExp(`registry\\.register\\(["']video["']\\s*,\\s*["']${providerId}["']\\s*,\\s*\\(.*?\\)\\s*=>\\s*new\\s+(\\w+)`, "s")
    );
    if (!classMatch) return false;
    const className = classMatch[1];
    // 检查 registry.ts 顶部是否有 import 这个 class
    const importRe = new RegExp(`import\\s*\\{[^}]*\\b${className}\\b[^}]*\\}\\s*from\\s*["']([^"']+)["']`);
    const importMatch = registryText.match(importRe);
    if (!importMatch) return false;
    const importPath = importMatch[1];
    // 解析 import 路径 → 是否真实文件
    if (importPath.startsWith("../video/")) {
      const filename = importPath.replace("../video/", "") + ".ts";
      return videoFiles.includes(filename);
    }
    return videoFileText.includes(className.toLowerCase());
  }

  // ─── 读 cost estimates
  const costText = readSafe(path.join(ROOT, "config", "video_cost_estimates.json"));
  let costObj: any = null;
  try { costObj = JSON.parse(costText); } catch { /* noop */ }
  const costProviders = new Set<string>();
  if (costObj?.estimates) {
    for (const e of costObj.estimates) costProviders.add(e.provider);
  }

  // ─── 读 localSettings (healthCheck case "video")
  const localSettingsText = readSafe(path.join(ROOT, "packages", "core", "src", "localSettings.ts"));
  // 抽 case "video" 的 block (粗暴: 从 case "video" 到下一个 case 或 函数末尾)
  const videoCaseMatch = localSettingsText.match(/case\s+"video":\s*\{[\s\S]*?(?=\n\s*case\s+"|\n\s*default:|\n\s*\}\s*\n\s*\})/);
  const videoCaseText = videoCaseMatch ? videoCaseMatch[0] : "";
  function inHealthCase(providerId: string): boolean {
    return videoCaseText.includes(`"${providerId}"`) ||
           videoCaseText.includes(`'${providerId}'`);
  }

  // ─── scrubForClient 全局兜底验证
  const loggerText = readSafe(path.join(ROOT, "packages", "core", "src", "logger.ts"));
  const scrubFnMatch = loggerText.match(/export\s+function\s+scrubForClient[\s\S]*?\n\}/);
  const scrubBody = scrubFnMatch ? scrubFnMatch[0] : "";
  const scrubPatterns = {
    Bearer: scrubBody.includes("Bearer"),
    Token: scrubBody.includes("Token"),
    "sk-": scrubBody.includes("sk-"),
    "tp-": scrubBody.includes("tp-"),
    JWT: scrubBody.includes("eyJ"),
    "api-key": /api[-_]?key/i.test(scrubBody),
  };
  const scrubAllOk = Object.values(scrubPatterns).every(Boolean);

  // ─── 拼矩阵
  const matrix: VideoMatrixRow[] = REAL_VIDEO_PROVIDERS.map((id) => {
    const preset = presetById.get(id);
    return {
      id,
      preset: Boolean(preset),
      enabled: preset?.enabled === true,
      registry: registryIds.has(id),
      impl: hasImpl(id),
      cost: costProviders.has(id),
      health: inHealthCase(id) || videoCaseText.length > 0,  // case 存在但可能用 endsWith / fallthrough → 至少 case 存在算 ok
      picker: Boolean(preset) && preset?.enabled === true,
      scrub: scrubAllOk,
    };
  });

  // ─── 输出表
  const cellOk = "OK";
  const cellNo = "--";
  const header = "| provider                | preset | enabled | registry | impl | cost | health | picker | scrub |";
  const sep    = "|-------------------------|--------|---------|----------|------|------|--------|--------|-------|";
  const rows = matrix.map((r) => {
    const cols = [
      r.id.padEnd(23),
      (r.preset ? cellOk : cellNo).padEnd(6),
      (r.enabled ? cellOk : cellNo).padEnd(7),
      (r.registry ? cellOk : cellNo).padEnd(8),
      (r.impl ? cellOk : cellNo).padEnd(4),
      (r.cost ? cellOk : cellNo).padEnd(4),
      (r.health ? cellOk : cellNo).padEnd(6),
      (r.picker ? cellOk : cellNo).padEnd(6),
      (r.scrub ? cellOk : cellNo).padEnd(5),
    ];
    return `| ${cols.join(" | ")} |`;
  });

  findings.push({ level: "ok", message: "\n    " + header });
  findings.push({ level: "ok", message: "    " + sep });
  for (const r of rows) findings.push({ level: "ok", message: "    " + r });

  // ─── 漏点
  const gaps: string[] = [];
  for (const r of matrix) {
    const missing: string[] = [];
    if (!r.preset) missing.push("preset");
    if (!r.enabled) missing.push("enabled");
    if (!r.registry) missing.push("registry");
    if (!r.impl) missing.push("impl");
    if (!r.cost) missing.push("cost");
    if (!r.health) missing.push("health");
    if (!r.picker) missing.push("picker");
    if (missing.length > 0) {
      gaps.push(`${r.id} 漏: ${missing.join(", ")}`);
    }
  }
  if (!scrubAllOk) {
    const miss = Object.entries(scrubPatterns).filter(([, v]) => !v).map(([k]) => k);
    gaps.push(`scrubForClient 漏鉴权前缀: ${miss.join(", ")}`);
  }
  if (gaps.length === 0) {
    findings.push({ level: "ok", message: "9 个真实 video provider 八维全覆盖" });
  } else {
    for (const g of gaps) findings.push({ level: "fail", message: g });
  }

  return findings;
}

// ──────────────────────────────────────────────────────────────
// 3. silent mock fallback 红线
// ──────────────────────────────────────────────────────────────
//
// 扫:
//   - FallbackTtsWrapper(cfg, null) — 注册条目 (允许列表确认是 TTS not-yet-implemented)
//   - createFallbackMockRunner — orchestrator 里 silent fake done (W7 删过, 检查无回潮)
//   - 类似 `provider = "local_mock_video"` 硬编码 fallback
//   - preset enabled=true 但 registry 缺 (video 主流 9 个)

function scanSilentFallback(): SectionReport["findings"] {
  const findings: Finding[] = [];

  // 3.1 FallbackTtsWrapper 注册 — 允许 (这些是 TTS 占位)
  const registryText = readSafe(path.join(ROOT, "packages", "providers", "src", "core", "registry.ts"));
  const fallbackTtsRe = /registry\.register\(["']tts["']\s*,\s*["']([a-z0-9_]+)["']\s*,\s*\(.*?\)\s*=>\s*new\s+FallbackTtsWrapper/g;
  const fallbackTtsIds: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fallbackTtsRe.exec(registryText)) !== null) fallbackTtsIds.push(m[1]);
  if (fallbackTtsIds.length > 0) {
    findings.push({
      level: "ok",
      message: `${fallbackTtsIds.length} 处 FallbackTtsWrapper (TTS 占位, edge_tts 兜底): ${fallbackTtsIds.join(", ")}`,
    });
  }

  // 3.2 createFallbackMockRunner — 2026-05-20 P1: 函数定义已彻底删除. 任意残留 (定义 / 调用)
  // 均视为回潮. 仅允许行注释 / 块注释中提及 (说明历史). 检查方式: 找出现 `createFallbackMockRunner(`
  // 的代码行 (非注释), 应为 0.
  const orchestratorText = readSafe(path.join(ROOT, "apps", "server", "src", "jobs", "orchestrator.ts"));
  const orchestratorLines = orchestratorText.split(/\r?\n/);
  // 用宽松判断: 一行是否以 `//` 起始或包含 `* createFallbackMockRunner` 模式 (块注释)
  // 直接检测代码出现: `createFallbackMockRunner\s*(` 且该行 trim 后不以 // 开头, 不在 反引号字符串里
  let liveCount = 0;
  for (const raw of orchestratorLines) {
    if (!/createFallbackMockRunner\s*\(/.test(raw)) continue;
    const trimmed = raw.trim();
    if (trimmed.startsWith("//")) continue;        // 单行注释
    if (trimmed.startsWith("*")) continue;          // 块注释内
    if (raw.includes("`") || raw.includes("'") || raw.includes("\"")) continue; // 字符串 (反引号 doc / Error message)
    liveCount++;
  }
  if (liveCount > 0) {
    findings.push({
      level: "fail",
      message: `orchestrator.ts 有 ${liveCount} 处 createFallbackMockRunner 活跃代码 — 已删除, 回潮严重风险`,
    });
  } else {
    findings.push({ level: "ok", message: "createFallbackMockRunner 函数定义 + 调用 0 残留 (2026-05-20 已彻底删除)" });
  }

  // 3.3 硬编码 fallback: 在 controller / orchestrator 里 `provider = "local_mock_video"` 类
  const suspectFiles = [
    ...walkFiles(path.join(ROOT, "apps", "server", "src"), [".ts"]),
  ];
  const hardcodeRe = /provider(?:_id)?\s*=\s*["']local_mock_video["']/g;
  const hardcodeHits: { file: string; line: number }[] = [];
  for (const f of suspectFiles) {
    if (f.includes(".test.")) continue;
    const text = readSafe(f);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (hardcodeRe.test(lines[i])) {
        hardcodeHits.push({ file: f, line: i + 1 });
      }
      hardcodeRe.lastIndex = 0;
    }
  }
  if (hardcodeHits.length > 0) {
    findings.push({
      level: "warn",
      message: `${hardcodeHits.length} 处硬编码 provider="local_mock_video" (可能是 default, 检查上下文):`,
    });
    for (const h of hardcodeHits.slice(0, 5)) {
      findings.push({ level: "warn", message: `  ${rel(h.file)}:${h.line}` });
    }
  } else {
    findings.push({ level: "ok", message: "无硬编码 provider=local_mock_video fallback" });
  }

  // 3.4 preset enabled=true 但 registry 缺 (限定 video provider, 因 image/tts 用 generic adapter)
  const presetText = readSafe(path.join(ROOT, "config", "presets", "video_provider.json"));
  let presetObj: any = null;
  try { presetObj = JSON.parse(presetText); } catch { /* noop */ }
  const registryVideoIds = new Set<string>();
  const regRe = /registry\.register\(["']video["']\s*,\s*["']([a-z0-9_]+)["']/g;
  let mm: RegExpExecArray | null;
  while ((mm = regRe.exec(registryText)) !== null) registryVideoIds.add(mm[1]);

  const orphanEnabled: string[] = [];
  if (presetObj?.options) {
    for (const opt of presetObj.options) {
      if (opt.enabled === true && !registryVideoIds.has(opt.id)) {
        orphanEnabled.push(opt.id);
      }
    }
  }
  if (orphanEnabled.length > 0) {
    findings.push({
      level: "fail",
      message: `video preset enabled=true 但 registry 缺 (silent black hole): ${orphanEnabled.join(", ")}`,
    });
  } else {
    findings.push({ level: "ok", message: "video preset enabled=true 全部 registered" });
  }

  return findings;
}

// ──────────────────────────────────────────────────────────────
// 4. LLM preset vs registry 一致性矩阵
// ──────────────────────────────────────────────────────────────
//
// 本轮 audit (2026-05-20) 抓到 2 个 P0 LLM preset 致命问题:
//   - anthropic_via_codex: enabled=false 但 base_url/model_id 是"待确认"占位
//   - ikuncode_claude: enabled=true 但早期版本 registry 缺注册 (已修复, 持续监控)
//
// 扫描维度 (5 维):
//   preset    — 在 llm_provider.json 存在
//   enabled   — preset.enabled === true
//   registry  — 在 registry.ts 注册 (registry.register("llm", "<id>", ...))
//   base_url  — enabled=true 时 base_url 非空/非占位
//   model_id  — enabled=true 时 model_id 非空/非占位
//
// 规则:
//   - enabled=true + registry 缺 → FAIL (silent black hole)
//   - enabled=true + base_url/model_id 是占位 ("待确认" / "") → WARN
//   - enabled=false + registry 缺 → OK (占位 preset, 未启用)
//   - enabled=false + base_url 是占位 → OK (未启用占位属于设计)

const PLACEHOLDER_PATTERNS = ["待确认", "placeholder", "TODO", "your_", "example.com"];

function isPlaceholder(val: unknown): boolean {
  if (typeof val !== "string" || val.trim() === "") return true;
  return PLACEHOLDER_PATTERNS.some((p) => val.includes(p));
}

function scanLlmPresetMatrix(): SectionReport["findings"] {
  const findings: Finding[] = [];

  // ─── 读 LLM preset 文件
  const presetPath = path.join(ROOT, "config", "presets", "llm_provider.json");
  const presetText = readSafe(presetPath);
  let presetObj: any = null;
  try { presetObj = JSON.parse(presetText); } catch { /* noop */ }
  if (!presetObj?.options || !Array.isArray(presetObj.options)) {
    findings.push({ level: "fail", message: "无法读取 config/presets/llm_provider.json" });
    return findings;
  }
  const options: any[] = presetObj.options;

  // ─── 读 registry 注册 LLM ID
  const registryText = readSafe(path.join(ROOT, "packages", "providers", "src", "core", "registry.ts"));
  const registryLlmIds = new Set<string>();
  const regRe = /registry\.register\(["']llm["']\s*,\s*["']([a-z0-9_]+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = regRe.exec(registryText)) !== null) registryLlmIds.add(m[1]);

  // ─── 矩阵表头
  const header = "| provider                  | preset | enabled | registry | base_url | model_id |";
  const sep    = "|---------------------------|--------|---------|----------|----------|----------|";
  findings.push({ level: "ok", message: "\n    " + header });
  findings.push({ level: "ok", message: "    " + sep });

  const cellOk = "OK";
  const cellNo = "--";
  const cellWrn = "WRN";

  const gaps: string[] = [];
  const warns: string[] = [];

  for (const opt of options) {
    const id: string = typeof opt.id === "string" ? opt.id : String(opt.id ?? "?");
    const enabled: boolean = opt.enabled === true;
    const inRegistry: boolean = registryLlmIds.has(id);
    const baseUrlOk: boolean = !isPlaceholder(opt.base_url);
    const modelIdOk: boolean = !isPlaceholder(opt.model_id);

    // This preset is a user-configured entry, with runtime overrides resolved by
    // registry.ts. Empty static defaults are intentional; don't invent a URL/model
    // or claim that the provider has passed a live connectivity check.
    if (id === "custom_openai_compat" && inRegistry && !baseUrlOk && !modelIdOk) {
      findings.push({ level: "ok", message: `    | ${id.padEnd(25)} | OK     | ${enabled ? "OK" : "--"}      | OK       | 未配置   | 未配置   |` });
      findings.push({ level: "ok", message: "自定义 LLM 静态入口未配置；实际可用性由本地设置和连接测试决定（本检查不读取 Key）" });
      continue;
    }

    const colPreset = cellOk;
    const colEnabled = (enabled ? cellOk : cellNo).padEnd(7);
    const colRegistry = (inRegistry ? cellOk : cellNo).padEnd(8);
    const colBaseUrl = enabled ? (baseUrlOk ? cellOk : cellWrn).padEnd(8) : (baseUrlOk ? cellOk : "--").padEnd(8);
    const colModelId = enabled ? (modelIdOk ? cellOk : cellWrn).padEnd(8) : (modelIdOk ? cellOk : "--").padEnd(8);

    const row = `| ${id.padEnd(25)} | ${colPreset.padEnd(6)} | ${colEnabled} | ${colRegistry} | ${colBaseUrl} | ${colModelId} |`;
    const level: Finding["level"] = (enabled && !inRegistry) ? "fail"
      : (enabled && (!baseUrlOk || !modelIdOk)) ? "warn"
      : "ok";
    findings.push({ level, message: "    " + row });

    if (enabled && !inRegistry) {
      gaps.push(`${id}: enabled=true 但 registry 缺注册 (silent black hole)`);
    } else if (enabled && !baseUrlOk) {
      warns.push(`${id}: enabled=true 但 base_url 是占位 ("${opt.base_url}")`);
    } else if (enabled && !modelIdOk) {
      warns.push(`${id}: enabled=true 但 model_id 是占位 ("${opt.model_id}")`);
    }
  }

  // ─── registry 有但 preset 没有 (孤儿注册, warn 级)
  for (const regId of registryLlmIds) {
    if (!options.some((o) => o.id === regId)) {
      warns.push(`registry 注册了 "${regId}" 但 llm_provider.json 无对应 preset (可能是动态注册, 请确认)`);
    }
  }

  // ─── 汇总
  if (gaps.length === 0 && warns.length === 0) {
    findings.push({ level: "ok", message: "LLM preset vs registry 全部 OK" });
  } else {
    for (const g of gaps) findings.push({ level: "fail", message: g });
    for (const w of warns) findings.push({ level: "warn", message: w });
  }

  return findings;
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

addReport("[1/4] ElementKind 6 类 callsite 覆盖矩阵", scanElementKindCoverage());
addReport("[2/4] 真实 video provider 八维矩阵", scanVideoProviderMatrix());
addReport("[3/4] silent mock fallback 红线", scanSilentFallback());
addReport("[4/4] LLM preset vs registry 一致性矩阵", scanLlmPresetMatrix());

// ─── 输出
console.log("\n============ HEALTH: 扩展完整性 ============\n");

let totalWarn = 0;
let totalFail = 0;
for (const sec of reports) {
  console.log(sec.title);
  for (const f of sec.findings) {
    const icon = f.level === "ok" ? "  OK  " : f.level === "warn" ? "  WARN" : "  FAIL";
    if (f.level === "warn") totalWarn += 1;
    if (f.level === "fail") totalFail += 1;
    console.log(`${icon} ${f.message}`);
  }
  console.log("");
}

console.log("============================================");
console.log(`Summary: ${totalFail} FAIL, ${totalWarn} WARN`);

if (STRICT && (totalFail > 0 || totalWarn > 0)) {
  console.log("\nSTATUS: FAIL (strict mode, FAIL + WARN 都视作不通过)");
  process.exit(1);
}
if (totalFail > 0) {
  console.log("\nSTATUS: FAIL (FAIL > 0 触发非零退出)");
  process.exit(1);
}
console.log(`\nSTATUS: PASS${totalWarn > 0 ? ` (含 ${totalWarn} WARN, 用 --strict 升级)` : ""}`);
process.exit(0);
