import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isPathWithin } from "./safePath";

type Entry = { relative: string; hash: string; size: number; mtime: number; ino: number };
export function hashFile(file: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

function rejectLinks(file: string): void {
  for (let cursor = path.resolve(file); ; cursor = path.dirname(cursor)) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`拒绝迁移链接或目录联接: ${cursor}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (path.dirname(cursor) === cursor) break;
  }
}

function inventory(root: string): Entry[] {
  rejectLinks(root);
  const result: Entry[] = [];
  function visit(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`拒绝迁移链接或目录联接: ${full}`);
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) {
        const hash = hashFile(full);
        const after = fs.statSync(full);
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino) throw new Error("清单扫描期间源文件已改变");
        result.push({ relative: path.relative(root, full), hash, size: stat.size, mtime: stat.mtimeMs, ino: stat.ino });
      } else throw new Error(`拒绝迁移特殊文件: ${full}`);
    }
  }
  visit(root);
  return result;
}

/** Copy and verify. Sources are deliberately retained: concurrent writers make automatic deletion unsafe. */
export function mergeWorkspaceRoot(source: string, destination: string, conflictRoot: string, apply: boolean,
  options: { copyFile?: typeof fs.copyFileSync; afterCopy?: () => void } = {}) {
  source = path.resolve(source); destination = path.resolve(destination); conflictRoot = path.resolve(conflictRoot);
  if (isPathWithin(source, destination) || isPathWithin(destination, source) || !isPathWithin(destination, conflictRoot)) {
    throw new Error("迁移源与目标必须独立，冲突目录必须位于目标内");
  }
  rejectLinks(destination); rejectLinks(conflictRoot);
  const before = inventory(source);
  const stats = { files: before.length, copied: 0, identical: 0, conflicts: 0, bytesCopied: 0, sourceRetained: true };
  // A database and its journal form one snapshot. Never copy a source WAL next
  // to an unrelated destination database, even when only the WAL name is free.
  const databaseTargets = new Map<string, string>();
  const groups = new Map<string, Entry[]>();
  for (const entry of before) {
    const match = entry.relative.match(/^(.*\.(?:db|sqlite|sqlite3))(?:-(?:wal|shm|journal))?$/i);
    if (match) { const group = groups.get(match[1]) ?? []; group.push(entry); groups.set(match[1], group); }
  }
  for (const [base, group] of groups) {
    if (!group.some(entry => entry.relative === base)) throw new Error("发现没有主库的 SQLite 日志文件，保留源目录并停止迁移");
    const occupied = ["", "-wal", "-shm", "-journal"].some(suffix => fs.existsSync(path.join(destination, `${base}${suffix}`)));
    const equal = group.every(entry => {
      const target = path.join(destination, entry.relative); rejectLinks(target);
      return fs.existsSync(target) && fs.statSync(target).isFile() && hashFile(target) === entry.hash;
    });
    if (occupied && !equal) {
      const digest = crypto.createHash("sha256").update(group.map(entry => `${entry.relative}:${entry.hash}`).join("\n")).digest("hex");
      for (const entry of group) databaseTargets.set(entry.relative, path.join(conflictRoot, "sqlite", `${base}.${digest}`, path.basename(entry.relative)));
    }
  }
  const verified: Array<{ file: string; hash: string }> = [];
  for (const entry of before) {
    let target = databaseTargets.get(entry.relative) ?? path.join(destination, entry.relative);
    if (databaseTargets.has(entry.relative)) stats.conflicts++;
    rejectLinks(target);
    if (fs.existsSync(target)) {
      if (fs.statSync(target).isFile() && hashFile(target) === entry.hash) {
        stats.identical++; verified.push({ file: target, hash: entry.hash }); continue;
      }
      stats.conflicts++;
      // Content addressed names allow safe, idempotent retries after a partial failure.
      target = path.join(conflictRoot, `${entry.relative}.${entry.hash}.preserved`);
      rejectLinks(target);
      if (fs.existsSync(target)) {
        if (!fs.statSync(target).isFile() || hashFile(target) !== entry.hash) throw new Error("冲突存档校验失败，保留源文件");
        verified.push({ file: target, hash: entry.hash }); continue;
      }
    }
    if (apply) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      rejectLinks(target);
      (options.copyFile ?? fs.copyFileSync)(path.join(source, entry.relative), target, fs.constants.COPYFILE_EXCL);
      if (hashFile(target) !== entry.hash) throw new Error("复制后哈希校验失败，保留源文件");
      verified.push({ file: target, hash: entry.hash });
    }
    stats.copied++; stats.bytesCopied += entry.size;
  }
  if (apply) {
    options.afterCopy?.();
    if (JSON.stringify(inventory(source)) !== JSON.stringify(before)) throw new Error("复制期间源目录已改变，保留全部源文件；请停止写入后重试");
    for (const entry of verified) {
      rejectLinks(entry.file);
      if (hashFile(entry.file) !== entry.hash) throw new Error("目标文件复核失败，保留源文件");
    }
  }
  return stats;
}
