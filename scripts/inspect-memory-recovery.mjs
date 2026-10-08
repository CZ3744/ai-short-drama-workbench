/** Preserve and inspect snapshots only. Never replace or open the live database for writing. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.quality-reports', `memory-recovery-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const preserved = [];
for (const suffix of ['', '-wal', '-shm']) {
  const source = path.join(root, 'data', `memory.db${suffix}`);
  if (!fs.existsSync(source)) continue;
  const before = hash(source);
  const target = path.join(out, 'original', `memory.db${suffix}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  if (hash(source) !== before || hash(target) !== before) throw new Error('Source changed during snapshot; original retained. Retry when idle.');
  preserved.push({ file: path.basename(source), bytes: fs.statSync(source).size, sha256: before });
}
function inspect(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    return { integrity: db.pragma('quick_check'), tables: tables.map(({ name }) => ({ name, rows: db.prepare(`SELECT count(*) n FROM "${name.replaceAll('"', '""')}"`).get().n })) };
  } catch (e) { return { error: e.code, message: e.message }; }
  finally { db?.close(); }
}
const attempts = [];
for (const mode of ['with-wal', 'database-only']) {
  const dir = path.join(out, mode); fs.mkdirSync(dir);
  for (const item of preserved.filter(p => mode === 'with-wal' || p.file === 'memory.db')) fs.copyFileSync(path.join(out, 'original', item.file), path.join(dir, item.file));
  const dbPath = path.join(dir, 'memory.db');
  attempts.push({ mode, ...inspect(dbPath) });
  if (!attempts.at(-1).error) continue;
  try {
    const sql = execFileSync('sqlite3', [dbPath, '.recover'], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.writeFileSync(path.join(dir, 'recovered.sql'), sql);
    const recovered = path.join(dir, 'recovered.db');
    execFileSync('sqlite3', [recovered], { input: sql, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    attempts.push({ mode: `${mode}-recover`, ...inspect(recovered) });
  } catch (e) { attempts.push({ mode: `${mode}-recover`, error: e.code || e.status, message: 'sqlite3 recovery failed; snapshot retained' }); }
}
const report = { at: new Date().toISOString(), originalUnchanged: true, preserved, attempts };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ out, ...report }, null, 2));
