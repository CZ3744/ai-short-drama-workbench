import { test } from "node:test";
import assert from "node:assert/strict";
import { createScriptSaveQueue } from "./scriptSaveQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("manual save joins autosave and waits for edits made during the request", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const writes: string[] = [];
  const queue = createScriptSaveQueue({ persist: (content) => {
    writes.push(content);
    return writes.length === 1 ? first.promise : second.promise;
  } });
  queue.load("original");
  queue.edit("first edit");
  const saving = queue.save();
  await Promise.resolve();
  queue.edit("newer edit");
  assert.equal(queue.save(), saving);
  first.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(queue.dirty, true);
  assert.equal(queue.saving, true);
  assert.deepEqual(writes, ["first edit", "newer edit"]);
  second.resolve();
  await saving;
  assert.equal(queue.dirty, false);
  assert.equal(queue.saving, false);
});

test("save failure keeps the latest text dirty, rejects dependent work, and supports retry", async () => {
  let fail = true;
  const writes: string[] = [];
  const queue = createScriptSaveQueue({ persist: async (content) => {
    writes.push(content);
    if (fail) throw new Error("offline");
  } });
  queue.load("old");
  queue.edit("keep this");
  await assert.rejects(queue.save(), /offline/);
  assert.equal(queue.content, "keep this");
  assert.equal(queue.dirty, true);
  assert.ok(queue.error);
  fail = false;
  await queue.save();
  assert.equal(queue.error, null);
  assert.equal(queue.dirty, false);
  assert.deepEqual(writes, ["keep this", "keep this"]);
});

test("reverting to saved text is clean and empty text is saved intentionally", async () => {
  const writes: string[] = [];
  const queue = createScriptSaveQueue({ persist: async (content) => { writes.push(content); } });
  queue.load("original");
  queue.edit("temporary");
  queue.edit("original");
  await queue.save();
  assert.deepEqual(writes, []);
  queue.edit("");
  await queue.save();
  assert.deepEqual(writes, [""]);
});

test("a slow previous document save cannot change the next document", async () => {
  const oldWrite = deferred<void>();
  const old = createScriptSaveQueue({ persist: () => oldWrite.promise });
  const next = createScriptSaveQueue({ persist: async () => {} });
  old.load("old");
  old.edit("old edit");
  const saving = old.save();
  next.load("next document");
  next.edit("next edit");
  oldWrite.resolve();
  await saving;
  assert.equal(next.content, "next edit");
  assert.equal(next.dirty, true);
});

test("reverting an unsuccessful edit clears the obsolete failure state", async () => {
  const queue = createScriptSaveQueue({ persist: async () => { throw new Error("offline"); } });
  queue.load("saved");
  queue.edit("not saved");
  await assert.rejects(queue.save());
  queue.edit("saved");
  assert.equal(queue.dirty, false);
  assert.equal(queue.error, null);
});
