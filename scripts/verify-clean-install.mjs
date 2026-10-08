import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { browserOsEnvironmentKey, captureBrowserOsEnvironment } from './browser-test-environment.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-tool-install-'));
const reports = path.join(root, '.quality-reports', `clean-install-${Date.now()}`);
await fs.mkdir(reports, { recursive: true });
const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)) env[key] = value;
}
Object.assign(env, { VIDEO_GENERATE_CLEAN_FIXTURE: fixture, HOME: path.join(fixture, '.home'), USERPROFILE: path.join(fixture, '.home'), APPDATA: path.join(fixture, '.home/AppData'), LOCALAPPDATA: path.join(fixture, '.home/AppData'), TEMP: path.join(fixture, '.tmp'), TMP: path.join(fixture, '.tmp'), NO_COLOR: '1' });
env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
if (process.env.VIDEO_GENERATE_TEST_PYTHON) env.VIDEO_GENERATE_TEST_PYTHON = process.env.VIDEO_GENERATE_TEST_PYTHON;
const summary = { at: new Date().toISOString(), node: process.version, npm: '', fixture, commands: [] };
async function run(args, name) {
  const commandEnv = { ...env };
  if (name === 'browser') {
    if (process.platform === 'win32') commandEnv[browserOsEnvironmentKey] = captureBrowserOsEnvironment(process.env);
    if (process.env.VIDEO_GENERATE_TEST_BROWSER === 'msedge') commandEnv.VIDEO_GENERATE_TEST_BROWSER = 'msedge';
  }
  const child = spawn(process.execPath, [npmCli, ...args], { cwd: fixture, env: commandEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = []; child.stdout.on('data', b => chunks.push(b)); child.stderr.on('data', b => chunks.push(b));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const output = Buffer.concat(chunks).toString('utf8');
  await fs.writeFile(path.join(reports, `${name}.log`), output);
  summary.commands.push({ command: `npm ${args.join(' ')}`, exitCode: code });
  console.log(`${name}: exit ${code}`);
  if (name === 'version') summary.npm = output.trim();
  if (code !== 0) throw new Error(`${name} failed; see ${reports}`);
}
try {
  for (const dir of ['.home/AppData', '.tmp', 'config', 'quality-default-config']) await fs.mkdir(path.join(fixture, dir), { recursive: true });
  for (const entry of ['apps', 'packages', 'prompts', 'agent_handbooks', 'samples', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', '.node-version', '.nvmrc', 'start-studio.ps1', 'stop-studio.ps1', 'studio-common.ps1']) {
    await fs.cp(path.join(root, entry), path.join(fixture, entry), { recursive: true, filter: async source => {
      if (/(?:^|[/\\])(?:node_modules|dist|\.git|data|outputs)(?:[/\\]|$)/.test(path.relative(root, source))) return false;
      if (/\.(?:db|sqlite)(?:-wal|-shm)?$|^\.env/.test(path.basename(source))) return false;
      return !(await fs.lstat(source)).isSymbolicLink();
    } });
  }
  const files = execFileSync('git', ['ls-files', '-z', 'config'], { cwd: root, windowsHide: true }).toString().split('\0').filter(rel => rel.endsWith('.json') && !/local-settings|secret|backup/i.test(rel));
  for (const rel of files) {
    const bytes = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, windowsHide: true });
    for (const target of [path.join(fixture, rel), path.join(fixture, 'quality-default-config', path.relative('config', rel))]) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); }
  }
  await run(['--version'], 'version');
  await run(['ci', '--no-audit', '--no-fund'], 'ci');
  await run(['run', 'build'], 'build');
  await run(['test'], 'test');
  await run(['run', 'test:browser'], 'browser');
} catch (error) {
  summary.error = String(error); process.exitCode = 1;
} finally {
  if (await fs.stat(path.join(fixture, '.quality-reports')).catch(() => null)) {
    await fs.cp(path.join(fixture, '.quality-reports'), path.join(reports, 'checks'), { recursive: true });
  }
  await fs.writeFile(path.join(reports, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  // Remove only the exact directory returned by mkdtemp, under the OS temp root.
  if (path.dirname(fixture) === path.resolve(os.tmpdir()) && path.basename(fixture).startsWith('creative-tool-install-')) await fs.rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
