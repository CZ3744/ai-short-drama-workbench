/**
 * Codebase health check script.
 * Run: npm run health:codebase
 *
 * Checks for common code hygiene issues and outputs pass/warning/fail.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

interface CheckResult {
  name: string;
  status: "pass" | "warning" | "fail";
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, status: "pass" | "warning" | "fail", detail: string) {
  results.push({ name, status, detail });
}

// 1. Check if config/local-settings.json is git-tracked
function checkGitTrackedSecrets() {
  const gitignorePath = path.join(ROOT, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    check("gitignore exists", "fail", ".gitignore not found");
    return;
  }
  const gitignore = fs.readFileSync(gitignorePath, "utf8");
  const hasLocalSettings = gitignore.includes("config/local-settings.json") || gitignore.includes("local-settings.json");
  const hasEnv = gitignore.includes(".env");
  const hasOutputs = gitignore.includes("outputs");
  check("local-settings.json gitignored", hasLocalSettings ? "pass" : "fail", hasLocalSettings ? "config/local-settings.json is gitignored" : "config/local-settings.json is NOT gitignored — risk of key leak");
  check(".env gitignored", hasEnv ? "pass" : "fail", hasEnv ? ".env is gitignored" : ".env is NOT gitignored — risk of key leak");
  check("outputs gitignored", hasOutputs ? "pass" : "warning", hasOutputs ? "outputs/ is gitignored" : "outputs/ is NOT gitignored");
}

// 2. Check for duplicate interface names in frontend api.ts
function checkDuplicateInterfaces() {
  const apiPath = path.join(ROOT, "apps", "web", "src", "lib", "api.ts");
  if (!fs.existsSync(apiPath)) {
    check("frontend api.ts exists", "fail", "apps/web/src/lib/api.ts not found");
    return;
  }
  const content = fs.readFileSync(apiPath, "utf8");
  const interfaces = [...content.matchAll(/export\s+interface\s+(\w+)/g)].map(m => m[1]);
  const counts = new Map<string, number>();
  for (const name of interfaces) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const dupes = [...counts.entries()].filter(([, c]) => c > 1);
  if (dupes.length > 0) {
    check("no duplicate interfaces", "warning", `Duplicate interface names: ${dupes.map(([n, c]) => `${n}(${c}x)`).join(", ")}`);
  } else {
    check("no duplicate interfaces", "pass", "No duplicate interface names found");
  }
}

// 3. Check for required docs
// FIX (2026-05-14 cleanup): CURRENT_STATUS.md 与 CODEBASE_AUDIT.md 在前次清理后被搬到 docs/_to_delete/,
// 这里改成检查实际还存在的权威文档 (PRODUCT/USAGE/API_ROUTE_MAP/DEVELOPER_GUIDE/ROADMAP)。
function checkRequiredDocs() {
  const required = [
    "README.md",
    "docs/GETTING_STARTED.md",
    "docs/DISTRIBUTION.md",
    "docs/RELEASE_NOTES.md",
    "docs/VISUAL_REVIEW.md",
  ];
  for (const doc of required) {
    const exists = fs.existsSync(path.join(ROOT, doc));
    check(`doc: ${doc}`, exists ? "pass" : "warning", exists ? `${doc} exists` : `${doc} missing`);
  }
}

// 4. Check for scattered TEST_REPORT_*.md in root
function checkScatteredTestReports() {
  const entries = fs.readdirSync(ROOT);
  const reports = entries.filter(e => e.startsWith("TEST_REPORT_") && e.endsWith(".md"));
  if (reports.length > 0) {
    check("test reports archived", "warning", `${reports.length} TEST_REPORT_*.md still in root: ${reports.slice(0, 5).join(", ")}${reports.length > 5 ? "..." : ""}`);
  } else {
    check("test reports archived", "pass", "No TEST_REPORT_*.md scattered in root");
  }
}

// 5. Check required package.json scripts
function checkPackageScripts() {
  const pkgPath = path.join(ROOT, "package.json");
  if (!fs.existsSync(pkgPath)) {
    check("package.json exists", "fail", "package.json not found");
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const required = ["build", "dev", "smoke:stable"];
  const recommended = ["health:codebase"];
  for (const script of required) {
    const exists = Boolean(pkg.scripts?.[script]);
    check(`script: ${script}`, exists ? "pass" : "fail", exists ? `"${script}" defined` : `"${script}" missing in package.json scripts`);
  }
  for (const script of recommended) {
    const exists = Boolean(pkg.scripts?.[script]);
    check(`script: ${script}`, exists ? "pass" : "warning", exists ? `"${script}" defined` : `"${script}" missing (recommended)`);
  }
}

// 6. Check for TODO/future_api without skeleton explanation
function checkUndocumentedFutures() {
  const routesPath = path.join(ROOT, "apps", "server", "src", "api", "routes.ts");
  if (!fs.existsSync(routesPath)) return;
  const content = fs.readFileSync(routesPath, "utf8");
  const futureMatches = content.match(/future_api|future_gpt|future_flux|future_wanx|future_hunyuan/g) ?? [];
  const skeletonNote = content.includes("skeleton") || content.includes("待接入") || content.includes("尚未实现");
  if (futureMatches.length > 0 && !skeletonNote) {
    check("future providers documented", "warning", `${futureMatches.length} future_* references found but no skeleton/future explanation`);
  } else {
    check("future providers documented", "pass", "Future provider references have skeleton explanations");
  }
}

// Run all checks
checkGitTrackedSecrets();
checkDuplicateInterfaces();
checkRequiredDocs();
checkScatteredTestReports();
checkPackageScripts();
checkUndocumentedFutures();

// Output
console.log("\n=== Codebase Health Check ===\n");
const grouped = { pass: [] as CheckResult[], warning: [] as CheckResult[], fail: [] as CheckResult[] };
for (const r of results) {
  grouped[r.status].push(r);
  const icon = r.status === "pass" ? "PASS" : r.status === "warning" ? "WARN" : "FAIL";
  console.log(`  ${icon.padEnd(5)} ${r.name}`);
  if (r.status !== "pass") console.log(`        ${r.detail}`);
}

console.log(`\n=== Summary ===`);
console.log(`  Pass: ${grouped.pass.length}  Warning: ${grouped.warning.length}  Fail: ${grouped.fail.length}`);
if (grouped.fail.length > 0) {
  console.log(`\n  STATUS: FAIL — ${grouped.fail.length} critical issues found`);
  process.exit(1);
} else if (grouped.warning.length > 0) {
  console.log(`\n  STATUS: PASS (with ${grouped.warning.length} warnings)`);
  process.exit(0);
} else {
  console.log(`\n  STATUS: PASS — all checks passed`);
  process.exit(0);
}
