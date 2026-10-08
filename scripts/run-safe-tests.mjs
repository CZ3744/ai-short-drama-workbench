/**
 * 一次性源码快照回归；不读取用户设置/数据库/素材，不继承真实 API Key。
 * 网络护栏防误调用，不是操作系统安全沙箱。
 * node scripts/run-safe-tests.mjs [测试文件名片段 ...]
 * node scripts/run-safe-tests.mjs --browser  # 先 npm run build
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 非隐藏目录：Express 的媒体文件下载会拒绝路径中包含 dotfile 的测试副本。
const scratch = path.join(root, 'tmp', 'quality-tests');
const reports = path.join(root, '.quality-reports');
const browserMode = process.argv.includes('--browser');
const filters = process.argv.slice(2).filter(arg => arg !== '--browser');
await fs.mkdir(scratch, { recursive: true });
await fs.mkdir(reports, { recursive: true });
const fixture = await fs.mkdtemp(path.join(scratch, browserMode ? 'browser-' : 'tests-'));
const stamp = path.basename(fixture);
const skippedNames = new Set(['node_modules', 'dist', 'coverage', '.git', '.cache', '__pycache__']);
let copied = 0;

async function copySources(relative) {
  const from = path.join(root, relative);
  const stat = await fs.lstat(from).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (skippedNames.has(path.basename(relative))) return;
    for (const entry of await fs.readdir(from)) await copySources(path.join(relative, entry));
  } else {
    if (/\.(db|sqlite|sqlite3)(?:-wal|-shm)?$|^\.env(?:\.|$)/i.test(path.basename(relative))) return;
    const to = path.join(fixture, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    copied++;
  }
}
async function findTests(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await findTests(p));
    else if (/\.test\.(ts|mjs)$/.test(entry.name)) found.push(p);
  }
  return found;
}

let exitCode = 1;
try {
  for (const area of ['packages', 'apps/server/src', 'apps/web/src', 'prompts', 'agent_handbooks', 'samples', 'scripts', 'package.json', 'tsconfig.json']) await copySources(area);
  for (const script of ['start-studio.ps1', 'studio-common.ps1', 'stop-studio.ps1']) await copySources(script);
  // HEAD 公共默认值作为稳定 fixture。工作树中的用户配置不进入测试副本。
  const cleanFixture = process.env.VIDEO_GENERATE_CLEAN_FIXTURE === root;
  const configFiles = cleanFixture ? (await fs.readdir(path.join(root, 'quality-default-config'), { recursive: true })).map(rel => `config/${rel.replaceAll('\\', '/')}`) : execFileSync('git', ['ls-files', '-z', 'config'], { cwd: root, windowsHide: true }).toString().split('\0').filter(Boolean);
  for (const rel of configFiles) {
    if (!rel.endsWith('.json') || /local-settings|backup|secret/i.test(rel)) continue;
    const content = cleanFixture ? await fs.readFile(path.join(root, 'quality-default-config', path.relative('config', rel))) : execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, windowsHide: true });
    await fs.mkdir(path.dirname(path.join(fixture, rel)), { recursive: true });
    await fs.writeFile(path.join(fixture, rel), content);
  }
  await fs.mkdir(path.join(fixture, 'config'), { recursive: true });
  await fs.writeFile(path.join(fixture, 'config/local-settings.json'), '{}\n');
  for (const dir of ['.tmp', '.home', '.home/AppData', 'data', 'outputs']) await fs.mkdir(path.join(fixture, dir), { recursive: true });
  if (browserMode) {
    await fs.access(path.join(root, 'dist/web/index.html')); // 不用过时的空页面冒充 UI 验收。
    await fs.cp(path.join(root, 'dist/web'), path.join(fixture, 'dist/web'), { recursive: true });
  }
  const tests = (await Promise.all(['packages', 'apps/server/src', 'apps/web/src'].map(p => findTests(path.join(fixture, p)))))
    .flat().sort().filter(p => !filters.length || filters.some(f => path.relative(fixture, p).replaceAll('\\', '/').includes(f)));
  if (!browserMode && !tests.length) throw new Error(`没有匹配的测试文件：${filters.join(', ')}`);

  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)) env[key] = value;
  }
  Object.assign(env, {
    NODE_ENV: 'test', NO_COLOR: '1', VIDEO_GENERATE_QUIET_PATHS: '1',
    HOME: path.join(fixture, '.home'), USERPROFILE: path.join(fixture, '.home'),
    APPDATA: path.join(fixture, '.home/AppData'), LOCALAPPDATA: path.join(fixture, '.home/AppData'),
    TMP: path.join(fixture, '.tmp'), TEMP: path.join(fixture, '.tmp'), TMPDIR: path.join(fixture, '.tmp'),
    VIDEO_GENERATE_TEST_FIXTURE: fixture,
  });
  // An explicit test interpreter is safe to pass through; real provider configuration stays excluded.
  if (process.env.VIDEO_GENERATE_TEST_PYTHON) env.VIDEO_GENERATE_TEST_PYTHON = process.env.VIDEO_GENERATE_TEST_PYTHON;
  if (browserMode && process.platform === 'win32' && process.env.LOCALAPPDATA) {
    // 仅复用已安装的浏览器二进制；新 profile 和用户目录仍在测试副本内。
    env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  }
  const args = ['--import', 'tsx', '--import', pathToFileURL(path.join(fixture, 'scripts/test-network-guard.mjs')).href,
    ...(browserMode ? ['scripts/browser-smoke.ts'] : ['--test', '--test-concurrency=1', '--test-timeout=45000', '--test-reporter=tap', ...tests])];
  console.log(`隔离${browserMode ? '浏览器验收' : '测试'}：${tests.length} 个测试文件；${copied} 个源码/公共 fixture 文件。无用户数据、无真实 Key。`);
  const child = spawn(process.execPath, args, { cwd: fixture, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  child.stdout.on('data', b => chunks.push(b));
  child.stderr.on('data', b => chunks.push(b));
  exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
  const output = Buffer.concat(chunks).toString('utf8');
  const log = path.join(reports, `${stamp}.${browserMode ? 'log' : 'tap'}`);
  await fs.writeFile(log, output);
  const summary = { at: new Date().toISOString(), node: process.version, files: tests.length, filters, exitCode, log: path.relative(root, log),
    counts: Object.fromEntries([...output.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (.+)$/gm)].map(m => [m[1], Number(m[2])])),
    failures: output.split(/\r?\n/).filter(line => /^\s*not ok\b/.test(line)).map(line => line.trim()) };
  if (browserMode) {
    const resultDir = path.join(fixture, 'browser-results');
    if (await fs.stat(resultDir).catch(() => null)) {
      await fs.cp(resultDir, path.join(reports, stamp), { recursive: true });
      summary.browser = JSON.parse(await fs.readFile(path.join(resultDir, 'summary.json'), 'utf8'));
    }
    await fs.writeFile(path.join(reports, 'browser-latest.json'), JSON.stringify(summary, null, 2) + '\n');
  } else {
    await fs.writeFile(path.join(reports, 'tests-latest.tap'), output);
    await fs.writeFile(path.join(reports, 'tests-latest.json'), JSON.stringify(summary, null, 2) + '\n');
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  // 只清理本次 mkdtemp 返回的测试副本，绝不清空用户 data/outputs。
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => {
    console.error(`测试副本清理失败，可手动删除 ${fixture}: ${error.message}`); exitCode = 1;
  });
}
process.exitCode = exitCode;
