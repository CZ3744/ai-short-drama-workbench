import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { remapLegacyWorkspacePath, resolveWorkspaceMediaFile } from "../workspaceMedia";

test("legacy media resolves within the consolidated roots without modifying originals", t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-media-"));
  const workspace = path.join(temp, "workspace");
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const [legacy, current] of [["video-generate-data", "data"], ["outputs", "outputs"]]) {
    const target = path.join(workspace, current, "series", "example", "a.png");
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "preserved media");
    const old = path.join(temp, legacy, "series", "example", "a.png");
    assert.equal(resolveWorkspaceMediaFile(old, workspace), fs.realpathSync(target));
    assert.equal(resolveWorkspaceMediaFile(pathToFileURL(old).href, workspace), fs.realpathSync(target));
    assert.equal(fs.existsSync(path.join(temp, legacy)), false);
    const sibling = path.join(temp, `${legacy}-other`, "a.png");
    assert.equal(remapLegacyWorkspacePath(sibling, workspace), sibling);
    assert.throws(() => resolveWorkspaceMediaFile(sibling, workspace), /当前项目/);
  }
  const outside = path.join(temp, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "a.png"), "private");
  fs.symlinkSync(outside, path.join(workspace, "data", "link"), "junction");
  assert.throws(() => resolveWorkspaceMediaFile(path.join(workspace, "data", "link", "a.png"), workspace), /链接/);
});
