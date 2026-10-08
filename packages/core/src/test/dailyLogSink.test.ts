import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DailyLogSink } from "../dailyLogSink";

test("existing loggers rotate at midnight and drain all queued lines", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logs-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = new Date(2026, 8, 20, 23, 59);
  const sink = new DailyLogSink(dir, () => now);
  sink.write("before\n"); now = new Date(2026, 8, 21, 0, 1);
  for (let i = 0; i < 100; i++) sink.write(`${i}\n`);
  await sink.drain();
  assert.equal(await fs.readFile(path.join(dir, "app-20260920.jsonl"), "utf8"), "before\n");
  assert.equal((await fs.readFile(path.join(dir, "app-20260921.jsonl"), "utf8")).trim().split("\n").length, 100);
});
for (const code of ["ENOSPC", "EACCES"]) test(`logging survives ${code} and retries on later writes`, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "logs-fault-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let fail = true; let warnings = 0;
  const sink = new DailyLogSink(dir, () => new Date(), async (file, data) => {
    if (fail) throw Object.assign(new Error("IO"), { code });
    return fs.appendFile(file, data);
  }, () => { warnings++; });
  sink.write("failed\n"); await assert.rejects(sink.drain(), { code });
  fail = false; sink.write("recovered\n"); await sink.drain();
  assert.equal(warnings, 1);
});
