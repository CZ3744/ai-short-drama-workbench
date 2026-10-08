/** Read-only inventory. Never starts the production server, imports repositories, or writes assets. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = []; const issues = [];
async function walk(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, item.name);
    if (item.isSymbolicLink()) { issues.push({ path: path.relative(root, full), issue: 'link retained, not followed' }); continue; }
    if (item.isDirectory()) await walk(full);
    else if (item.isFile()) { const stat = await fs.stat(full); files.push({ path: path.relative(root, full).replaceAll('\\', '/'), size: stat.size, mtime: stat.mtime.toISOString() }); }
  }
}
for (const area of ['data', 'outputs', 'data.legacy-20260527']) await walk(path.join(root, area));
const references = [];
function collect(value, from, key = '') {
  if (typeof value === 'string' && /(?:path|file|url)$/i.test(key) && value.length < 1024 && !/^(?:https?:|data:)/i.test(value)) references.push({ from, value });
  else if (Array.isArray(value)) value.forEach(v => collect(v, from, key));
  else if (value && typeof value === 'object') for (const [k,v] of Object.entries(value)) collect(v, from, k);
}
for (const file of files.filter(f => /\.jsonl?$/.test(f.path) && f.size < 8e6)) {
  const text = await fs.readFile(path.join(root, file.path), 'utf8');
  try {
    if (file.path.endsWith('.jsonl')) { for (const line of text.split(/\r?\n/).filter(Boolean)) { try { collect(JSON.parse(line), file.path); } catch {} } }
    else collect(JSON.parse(text), file.path);
  } catch { issues.push({ path: file.path, issue: 'invalid JSON' }); }
}
const oldAbsolute = [];
for (const ref of references.filter(ref => /video-generate-data|[/\\]MyApp[/\\]outputs[/\\]/i.test(ref.value))) {
  const mapped = ref.value.replace(/.*?video-generate-data[/\\]/i, `${root}/data/`).replace(/.*?MyApp[/\\]outputs[/\\]/i, `${root}/outputs/`);
  const exists = await fs.stat(mapped).then(s => s.isFile()).catch(() => false);
  oldAbsolute.push({ ...ref, mapped, exists });
}
const canonical = new Map();
for (const file of files.filter(f => /^(data|outputs)\//.test(f.path) && !f.path.includes('/_merge_conflicts/'))) {
  const hash = crypto.createHash('sha256').update(await fs.readFile(path.join(root, file.path))).digest('hex');
  const matches = canonical.get(hash) ?? []; matches.push(file.path); canonical.set(hash, matches);
}
const retained = [];
for (const file of files.filter(f => f.path.includes('/_merge_conflicts/') || f.path.startsWith('data.legacy-'))) {
  const hash = crypto.createHash('sha256').update(await fs.readFile(path.join(root, file.path))).digest('hex');
  retained.push({ ...file, hash, identicalCanonical: canonical.get(hash) ?? [], referencedBy: references.filter(r => r.value.replaceAll('\\', '/').endsWith(file.path)).map(r => r.from) });
}
const media = [];
for (const area of ['data/', 'outputs/', 'data.legacy-20260527/']) {
  for (const type of ['image', 'video']) {
    const candidates = files.filter(f => f.path.startsWith(area) && (type === 'image' ? /\.(png|jpe?g)$/i : /\.mp4$/i).test(f.path));
    // Spread sample across the full chronological range rather than selecting only new files.
    candidates.sort((a,b) => a.mtime.localeCompare(b.mtime));
    for (const index of [...new Set([0, Math.floor(candidates.length / 2), candidates.length - 1])].filter(i => i >= 0)) {
      const file = candidates[index]; if (!file) continue;
      try {
        if (type === 'image') { const result = await sharp(path.join(root, file.path)).metadata(); media.push({ path: file.path, type, width: result.width, height: result.height, format: result.format }); }
        else { const result = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', path.join(root, file.path)], { windowsHide: true, encoding: 'utf8' })); media.push({ path: file.path, type, ...result }); }
      } catch { media.push({ path: file.path, type, error: 'unable to decode/probe' }); }
    }
  }
}
const databases = [];
await fs.mkdir(path.join(root, '.quality-reports'), { recursive: true });
for (const file of ['config/projects.db', ...files.filter(f => f.path.endsWith('.db')).map(f => f.path)]) {
  const snapshot = await fs.mkdtemp(path.join(root, '.quality-reports', 'db-inspect-'));
  try {
    // SQLite readonly mode can still create/update SHM/WAL coordination files.
    // Inspect a verified snapshot so even those side effects stay outside assets.
    for (const suffix of ['', '-wal', '-shm']) {
      const source = path.join(root, `${file}${suffix}`);
      const bytes = await fs.readFile(source).catch(error => { if (suffix && error.code === 'ENOENT') return null; throw error; });
      if (!bytes) continue;
      await fs.writeFile(path.join(snapshot, `inspect.db${suffix}`), bytes);
      if (!bytes.equals(await fs.readFile(source))) throw new Error('database changed during snapshot; retry when idle');
    }
    const db = new Database(path.join(snapshot, 'inspect.db'), { readonly: true, fileMustExist: true });
    try { databases.push({ path: file, integrity: db.pragma('quick_check'), tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name) }); }
    finally { db.close(); }
  } catch (error) { databases.push({ path: file, error: error.code || 'READ_ERROR', message: error.message }); }
  finally {
    if (path.dirname(snapshot) === path.join(root, '.quality-reports') && path.basename(snapshot).startsWith('db-inspect-')) await fs.rm(snapshot, { recursive: true, force: true });
  }
}
const httpChecks = [];
if (process.argv.includes('--http')) {
  const candidates = files.flatMap(file => {
    let m = file.path.match(/^data\/series\/([^/]+)\/assets\/(images|videos)\/([^/]+)$/);
    if (m) return [{ ...file, route: `/api/v2/series/${encodeURIComponent(m[1])}/assets/${m[2]}/${encodeURIComponent(m[3])}` }];
    m = file.path.match(/^data\/series\/([^/]+)\/episodes\/([^/]+)\/compose\/([^/]+\.mp4)$/);
    return m ? [{ ...file, route: `/api/v2/series/${encodeURIComponent(m[1])}/episodes/${m[2]}/compose-file/${m[3]}` }] : [];
  });
  for (const video of [false, true]) {
    const group = candidates.filter(file => file.path.endsWith('.mp4') === video).sort((a,b) => a.mtime.localeCompare(b.mtime));
    for (const i of [...new Set([0, Math.floor(group.length / 2), group.length - 1])]) {
      const file = group[i]; if (!file) continue;
      try {
        const url = `http://127.0.0.1:8788${file.route}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        const digest = value => crypto.createHash('sha256').update(value).digest('hex');
        const check = { path: file.path, status: response.status, bytes: bytes.length, hashMatches: response.ok && digest(bytes) === digest(await fs.readFile(path.join(root, file.path))) };
        if (video) {
          const range = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(5_000) });
          check.rangeStatus = range.status; await range.body?.cancel();
          execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(root, file.path), '-map', '0:v:0', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          check.fullVideoDecode = true;
        }
        httpChecks.push(check);
      } catch (error) { httpChecks.push({ path: file.path, error: error.code || error.message }); }
    }
  }
}
const report = { at: new Date().toISOString(), readOnly: true, files: files.length, referencesExamined: references.length,
  oldAbsolute, retained, media, databases, httpChecks, issues,
  summary: { retained: retained.length, identical: retained.filter(f => f.identicalCanonical.length).length,
    uniqueRetained: retained.filter(f => !f.identicalCanonical.length).length, sampledMedia: media.length, failedMedia: media.filter(f => f.error).length, missingMappedReferences: oldAbsolute.filter(r => !r.exists).length } };
const output = path.join(root, '.quality-reports', 'historical-assets.json');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, ...report.summary, files: report.files, referencesExamined: report.referencesExamined, databaseChecks: databases.length }));
