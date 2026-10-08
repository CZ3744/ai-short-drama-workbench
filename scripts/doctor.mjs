/** Read-only installation checks. No user settings, API keys, models, or network calls. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const json = process.argv.includes('--json');
const requireMedia = process.argv.includes('--require-media');
const checks = [];
const add = (name, status, detail, action) => checks.push({ name, status, detail, ...(action ? { action } : {}) });
const [major, minor] = process.versions.node.split('.').map(Number);
const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
add('Node.js', supported ? 'pass' : 'fail', process.version, major === 24 ? undefined : '推荐安装 Node.js 24 LTS。');
for (const dependency of ['tsx', 'vite', 'express', 'react']) {
  try { require.resolve(dependency); add(dependency, 'pass', '已安装'); }
  catch { add(dependency, 'fail', '未找到依赖', '在项目目录运行 npm ci。'); }
}
try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try {
    const result = db.prepare('SELECT 1 AS ok').get();
    if (result.ok !== 1) throw new Error('SQLite query failed');
    add('SQLite', 'pass', '内存数据库可用');
  } finally { db.close(); }
} catch {
  add('SQLite', 'fail', '原生数据库模块不可用', '切换 Node.js 版本后需重新运行 npm ci；勿删除 data/ 或 config/。');
}
for (const executable of ['ffmpeg', 'ffprobe']) {
  try {
    const output = execFileSync(executable, ['-version'], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    add(executable, 'pass', output.split(/\r?\n/, 1)[0]);
  } catch {
    add(executable, requireMedia ? 'fail' : 'warn', '未在 PATH 中找到可运行程序', '合成视频需要 FFmpeg 和 FFprobe；安装后重新打开终端。剧本编辑不受影响。');
  }
}
const result = {
  ok: checks.every(check => check.status !== 'fail'),
  platform: process.platform,
  checks,
  next: '通过后启动本地工作台；此检查不代替浏览器操作、模型连接或视频导出验收。',
};
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log('AI 短剧生成工作台 / AI Short Drama Workbench · 安装检查\n');
  for (const check of checks) {
    console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`);
    if (check.action) console.log(`  ${check.action}`);
  }
  console.log(`\n${result.next}`);
}
process.exitCode = result.ok ? 0 : 1;
