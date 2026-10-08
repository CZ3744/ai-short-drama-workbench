// V6: inflightStore atomic write test
// 验证: 写入中途崩溃(只写 .tmp 不 rename)，loadAllInflight 应返回 0 条

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "../../../../core/src/paths";

const INFLIGHT_DIR = path.join(repoRoot, "data", "inflight");

async function ensureDir() {
  if (!fs.existsSync(INFLIGHT_DIR)) {
    await fsp.mkdir(INFLIGHT_DIR, { recursive: true });
  }
}

describe("inflightStore atomic write", () => {
  it("loadAllInflight skips .tmp files (crash simulation)", async () => {
    await ensureDir();

    // 模拟崩溃: 只写 .tmp 文件，不 rename
    const brokenTmp = path.join(INFLIGHT_DIR, "test-broken.json.tmp");
    await fsp.writeFile(brokenTmp, JSON.stringify({ inflight_id: "broken", provider_id: "test" }), "utf8");

    // 加载所有 inflight
    const { loadAllInflight } = await import("../inflightStore");
    const records = await loadAllInflight();

    // 不应包含破损的 .tmp
    const hasBroken = records.some(r => r.inflight_id === "broken");
    assert.strictEqual(hasBroken, false, ".tmp files should be skipped");

    // 清理
    await fsp.unlink(brokenTmp);
  });

  it("saveInflight writes complete records (happy path)", async () => {
    await ensureDir();

    const { saveInflight, removeInflight } = await import("../inflightStore");
    const record = await saveInflight({
      provider_id: "test-provider",
      provider_job_id: "job-123",
      submitted_at: new Date().toISOString(),
      context: { aspect_ratio: "16:9", duration_sec: 5 },
    });

    // 文件应存在且为 .json (非 .tmp)
    const jsonPath = path.join(INFLIGHT_DIR, `${record.inflight_id}.json`);
    const tmpPath = path.join(INFLIGHT_DIR, `${record.inflight_id}.json.tmp`);
    assert.strictEqual(fs.existsSync(jsonPath), true, ".json file should exist");
    assert.strictEqual(fs.existsSync(tmpPath), false, ".tmp file should not exist after rename");

    // 验证内容
    const content = JSON.parse(await fsp.readFile(jsonPath, "utf8"));
    assert.strictEqual(content.inflight_id, record.inflight_id);
    assert.strictEqual(content.provider_id, "test-provider");
    assert.strictEqual(content.context.aspect_ratio, "16:9");
    assert.strictEqual(content.context.duration_sec, 5);

    // 清理
    await removeInflight(record.inflight_id);
  });
});
