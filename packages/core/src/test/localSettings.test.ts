import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "../paths";
import { getConfigValue, readLocalSettings, writeLocalSettings, clearSecret, invalidateEnvCache } from "../localSettings";

if (process.env.VIDEO_GENERATE_TEST_FIXTURE !== repoRoot) throw new Error("Configuration tests require isolated npm test runner");

test("serialized settings saves retain fields and cache cannot be mutated by callers", async () => {
  await Promise.all([writeLocalSettings({ TEST_ALPHA: "a" }), writeLocalSettings({ TEST_BETA: "b" })]);
  const values = readLocalSettings(); values.TEST_ALPHA = "mutated";
  assert.equal(getConfigValue("TEST_ALPHA"), "a"); assert.equal(getConfigValue("TEST_BETA"), "b");
});
test("explicit key removal masks inherited and dotenv credentials, saving a replacement works", async () => {
  process.env.OPENAI_API_KEY = "isolated-env-key";
  await fs.writeFile(path.join(repoRoot, ".env"), "OPENAI_API_KEY=isolated-dotenv-key\n");
  await writeLocalSettings({ OPENAI_API_KEY: "isolated-local-key" });
  assert.equal(getConfigValue("OPENAI_API_KEY"), "isolated-local-key");
  await clearSecret("openai");
  assert.equal(getConfigValue("OPENAI_API_KEY"), "");
  assert.equal(process.env.OPENAI_API_KEY, undefined);
  process.env.OPENAI_API_KEY = "isolated-env-key"; // restart-like inherited credential
  assert.equal(getConfigValue("OPENAI_API_KEY"), "");
  await writeLocalSettings({ OPENAI_API_KEY: "replacement-key" });
  assert.equal(getConfigValue("OPENAI_API_KEY"), "replacement-key");
  delete process.env.OPENAI_API_KEY;
});
test("removing env files invalidates cached values; non-secret env overrides are explicit", async () => {
  const file = path.join(repoRoot, ".env.local");
  await fs.writeFile(file, "TEST_ENV_VALUE=from-file\n"); invalidateEnvCache();
  assert.equal(getConfigValue("TEST_ENV_VALUE"), "from-file");
  process.env.TEST_ENV_VALUE = "override"; assert.equal(getConfigValue("TEST_ENV_VALUE"), "override");
  delete process.env.TEST_ENV_VALUE; await fs.unlink(file);
  assert.equal(getConfigValue("TEST_ENV_VALUE", "default"), "default");
});
test("malformed settings are not overwritten and failed saves do not poison the write queue", async () => {
  const file = path.join(repoRoot, "config/local-settings.json");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, "{broken");
  await assert.rejects(writeLocalSettings({ TEST_ALPHA: "overwrite" }));
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
  await fs.writeFile(file, original);
  await writeLocalSettings({ TEST_ALPHA: "recovered" });
  assert.equal(getConfigValue("TEST_ALPHA"), "recovered");
});
