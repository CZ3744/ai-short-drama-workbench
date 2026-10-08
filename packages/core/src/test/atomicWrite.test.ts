import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "../fs";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atomic-fixture-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "record.json");
  await fs.writeFile(file, "old-complete-data");
  return { dir, file };
}

it("retries a transient Windows rename lock while preserving the previous complete file", async t => {
  const { dir, file } = await fixture(t);
  const rename = fs.rename.bind(fs);
  let calls = 0;
  t.mock.method(fs, "rename", async (from: string, to: string) => {
    assert.equal(await fs.readFile(file, "utf8"), "old-complete-data");
    if (++calls <= 2) throw Object.assign(new Error("fixture temporary sharing lock"), { code: "EPERM" });
    return rename(from, to);
  });
  await atomicWrite(file, "new-complete-data");
  assert.equal(calls, 3);
  assert.equal(await fs.readFile(file, "utf8"), "new-complete-data");
  assert.deepEqual(await fs.readdir(dir), ["record.json"]);
});

it("surfaces a persistent sharing failure after bounded retries without replacing old data", async t => {
  const { dir, file } = await fixture(t);
  const failure = Object.assign(new Error("fixture persistent lock"), { code: "EBUSY" });
  let calls = 0;
  t.mock.method(fs, "rename", async () => { calls++; throw failure; });
  await assert.rejects(atomicWrite(file, "never-published"), error => error === failure);
  assert.equal(calls, 6);
  assert.equal(await fs.readFile(file, "utf8"), "old-complete-data");
  assert.deepEqual(await fs.readdir(dir), ["record.json"]);
});

it("does not retry unrelated write failures", async t => {
  const { file } = await fixture(t);
  let calls = 0;
  t.mock.method(fs, "rename", async () => { calls++; throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" }); });
  await assert.rejects(atomicWrite(file, "new"), /disk full/);
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(file, "utf8"), "old-complete-data");
});

it("gives concurrent writers separate temporary files and always publishes complete JSON", async t => {
  const { dir, file } = await fixture(t);
  const values = Array.from({ length: 12 }, (_, index) => JSON.stringify({ index, content: String(index).repeat(5000) }));
  await Promise.all(values.map(value => atomicWrite(file, value)));
  const actual = await fs.readFile(file, "utf8");
  assert.ok(values.includes(actual));
  assert.equal(typeof JSON.parse(actual).index, "number");
  assert.deepEqual(await fs.readdir(dir), ["record.json"]);
});
