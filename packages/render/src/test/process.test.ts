import { it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runProcess, activeChildProcessCount } from "../process";

it("reports a missing optional executable without an uncaught asynchronous error", async () => {
  const result = await runProcess(path.join(process.cwd(), ".tmp", "nonexistent-media-tool"), []);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT|not found/i);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(activeChildProcessCount(), 0);
});
