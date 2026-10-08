/**
 * Wave Z11: Unit tests for paths.ts centralized constants
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  repoRoot,
  outputsRoot,
  promptsRoot,
  samplesRoot,
  DATA_ROOT,
  VAULT_ROOT,
  TRASH_ROOT,
  jobDir,
  jobPath,
} from "../paths";

describe("paths constants", () => {
  it("repoRoot resolves to an absolute path", () => {
    assert.ok(path.isAbsolute(repoRoot), "repoRoot should be absolute");
    assert.ok(existsSync(path.join(repoRoot, "package.json")), "repoRoot should contain the root package.json");
    assert.ok(existsSync(path.join(repoRoot, "packages", "core", "src", "paths.ts")), "repoRoot should contain the core paths module");
  });

  it("outputsRoot is under repoRoot", () => {
    assert.ok(outputsRoot.startsWith(repoRoot));
    assert.ok(outputsRoot.endsWith("outputs"));
  });

  it("DATA_ROOT is under repoRoot", () => {
    assert.ok(DATA_ROOT.startsWith(repoRoot));
    assert.ok(DATA_ROOT.endsWith("data"));
  });

  it("VAULT_ROOT is under DATA_ROOT", () => {
    assert.ok(VAULT_ROOT.startsWith(DATA_ROOT));
    assert.ok(VAULT_ROOT.endsWith(path.join("data", "vault")));
  });

  it("TRASH_ROOT is under DATA_ROOT", () => {
    assert.ok(TRASH_ROOT.startsWith(DATA_ROOT));
    assert.ok(TRASH_ROOT.endsWith(path.join("data", "trash")));
  });

  it("promptsRoot and samplesRoot resolve correctly", () => {
    assert.ok(promptsRoot.endsWith("prompts"));
    assert.ok(samplesRoot.endsWith("samples"));
  });

  it("jobDir generates a valid job directory path", () => {
    const dir = jobDir("job_test123");
    assert.ok(dir.startsWith(outputsRoot));
    assert.ok(dir.endsWith("job_test123"));
  });

  it("jobDir rejects invalid job IDs", () => {
    assert.throws(() => jobDir("../escape"), /Invalid jobId/);
    assert.throws(() => jobDir("path/traversal"), /Invalid jobId/);
    assert.throws(() => jobDir("back\\slash"), /Invalid jobId/);
  });

  it("jobPath generates correct sub-paths", () => {
    const p = jobPath("job_test", "logs", "job.log");
    assert.ok(p.endsWith(path.join("job_test", "logs", "job.log")));
  });
});
