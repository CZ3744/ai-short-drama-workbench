/** Launch only this project's two development processes, without a command shell. */
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGTERM');
    } catch { /* A child may already have exited. No port-based or global process kill. */ }
  }
}
for (const args of [
  [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'watch', path.join(root, 'apps/server/src/index.ts')],
  [path.join(root, 'node_modules/vite/bin/vite.js'), path.join(root, 'apps/web'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
]) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
