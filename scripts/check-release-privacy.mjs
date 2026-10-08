/** Scan tracked release files; print locations only, never the matched secret. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd();
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, windowsHide: true, encoding: 'utf8' }).split('\0').filter(Boolean);
const failures = [];
for (const relative of files) {
  const basename = path.basename(relative);
  if ((/^\.env(?:\.|$)/i.test(basename) && relative !== '.env.example') || /\.local\.json$|\.(?:pem|key|p12|pfx)$/i.test(basename)) failures.push(`${relative}: private configuration file`);
  if (/(^|\/)(?:\.env(?:\.local)?|local-settings\.json|data|outputs|logs|\.ai-bridge)(\/|$)|\.(?:db|sqlite)(?:-(?:wal|shm))?$/.test(relative)) failures.push(`${relative}: private runtime file`);
  if (/\.(?:png|jpe?g|gif|webp|woff2?|ico|docx|pdf)$/.test(relative)) continue;
  const text = await fs.readFile(path.join(root, relative), 'utf8');
  if (/github_pat_[A-Za-z0-9_]{30,}/.test(text)) failures.push(`${relative}: credential pattern`);
  const patterns = [/gh[pousr]_[A-Za-z0-9]{30,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /sk-(?!YOUR|test|fixture|mock|fake)[A-Za-z0-9_-]{32,}/, /[A-Z]:[\\/]+Users[\\/]+(?!example|Public|Default|runner)[^\\/\s"']+/i];
  for (const pattern of patterns) if (pattern.test(text)) failures.push(`${relative}: credential or personal path pattern`);
}
console.log(JSON.stringify({ scannedFiles: files.length, failures }, null, 2));
if (!files.length || failures.length) process.exitCode = 1;
