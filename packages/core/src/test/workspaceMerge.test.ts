import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeWorkspaceRoot } from "../workspaceMerge";
import { resolveSafeFile } from "../safePath";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
  const source = path.join(root, "source"); const dest = path.join(root, "dest");
  fs.mkdirSync(source); fs.mkdirSync(dest);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source, dest, merge: (apply = true, options = {}) => mergeWorkspaceRoot(source, dest, path.join(dest, "conflicts"), apply, options) };
}
test("merge verifies copies, preserves conflicts and is idempotent", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "same"), "same"); fs.writeFileSync(path.join(f.dest, "same"), "same");
  fs.writeFileSync(path.join(f.source, "conflict"), "new"); fs.writeFileSync(path.join(f.dest, "conflict"), "old");
  fs.writeFileSync(path.join(f.source, "renamed"), "same");
  assert.equal(f.merge(false).copied, 2);
  assert.equal(fs.existsSync(path.join(f.dest, "renamed")), false);
  assert.equal(f.merge().copied, 2);
  assert.equal(fs.readFileSync(path.join(f.dest, "conflict"), "utf8"), "old");
  assert.equal(f.merge().copied, 0);
  assert.equal(fs.readdirSync(path.join(f.dest, "conflicts")).length, 1);
  assert.equal(fs.readdirSync(f.source).length, 3);
});
test("source changes and copy errors retain all source files and allow retry", t => {
  const f = fixture(t); const input = path.join(f.source, "a"); fs.writeFileSync(input, "a");
  assert.throws(() => f.merge(true, { copyFile: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /denied/);
  assert.equal(fs.readFileSync(input, "utf8"), "a");
  assert.throws(() => f.merge(true, { afterCopy: () => fs.writeFileSync(input, "changed") }), /源目录已改变/);
  assert.equal(f.merge().conflicts, 1);
  assert.equal(fs.readFileSync(input, "utf8"), "changed");
});

test("SQLite database and WAL conflicts stay together and never contaminate a destination database", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "memory.db"), "source database");
  fs.writeFileSync(path.join(f.source, "memory.db-wal"), "source transaction");
  fs.writeFileSync(path.join(f.dest, "memory.db"), "different database");
  const result = f.merge();
  assert.equal(result.conflicts, 2);
  assert.equal(fs.existsSync(path.join(f.dest, "memory.db-wal")), false);
  assert.equal(fs.readFileSync(path.join(f.dest, "memory.db"), "utf8"), "different database");
  const groups = fs.readdirSync(path.join(f.dest, "conflicts", "sqlite"));
  assert.equal(groups.length, 1);
  const bundle = path.join(f.dest, "conflicts", "sqlite", groups[0]);
  assert.deepEqual(fs.readdirSync(bundle).sort(), ["memory.db", "memory.db-wal"]);
  assert.equal(f.merge().copied, 0);
  fs.unlinkSync(path.join(f.source, "memory.db"));
  assert.throws(() => f.merge(), /没有主库/);
});
test("junction sources and destinations are rejected before copying", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.source, "a"), "a");
  fs.symlinkSync(f.dest, path.join(f.source, "link"), "junction");
  assert.throws(() => f.merge(), /链接|联接/);
  fs.unlinkSync(path.join(f.source, "link"));
  fs.symlinkSync(f.source, path.join(f.dest, "link"), "junction");
  assert.throws(() => mergeWorkspaceRoot(f.source, path.join(f.dest, "link"), path.join(f.dest, "link/conflicts"), true), /链接|联接/);
});
test("safe file resolution checks components, traversal, file URLs and real junction targets", t => {
  const f = fixture(t); const good = path.join(f.source, "a"); fs.writeFileSync(good, "ok");
  assert.equal(resolveSafeFile(f.source, good), fs.realpathSync(good));
  assert.equal(resolveSafeFile(f.source, pathToFileURL(good).href), fs.realpathSync(good));
  const sibling = `${f.source}-other`; fs.mkdirSync(sibling); fs.writeFileSync(path.join(sibling, "a"), "no");
  assert.throws(() => resolveSafeFile(f.source, path.join(sibling, "a")), /允许/);
  assert.throws(() => resolveSafeFile(f.source, path.join(f.source, "../source-other/a")), /允许/);
  fs.symlinkSync(sibling, path.join(f.source, "escape"), "junction");
  assert.throws(() => resolveSafeFile(f.source, path.join(f.source, "escape/a")), /目录外/);
});
