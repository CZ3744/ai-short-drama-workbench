import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReadiness, computeStages, composeExportBlockReason } from "./composeReadiness";
import type { Shot } from "../../hooks/useShots";

test("approved imported video can compose without a generated first frame", () => {
  const ready = computeReadiness({ id: "s1", index: 1, title: "Imported clip", duration_sec: 5, status: "approved", picked_video_id: "imported" } as Shot);
  assert.equal(ready.ready, true);
  assert.equal(ready.hasPickedFrame, false);
  assert.equal(ready.missingReason, null);
  assert.equal(computeStages([ready], false, false).current, "export");
  assert.ok(computeStages([ready], false, false).completed.includes("storyboard"));
  assert.deepEqual(computeStages([ready], false, false).details.storyboard, { completed: 1, total: 1 });
  assert.match(composeExportBlockReason(false, false, [ready])!, /合成成片/);
});
test("missing videos, unapproved shots and empty episodes remain distinguishable", () => {
  const empty = computeReadiness({ id: "s1", index: 1, status: "draft" } as Shot);
  assert.match(composeExportBlockReason(false, false, [empty])!, /生成视频/);
  const unapproved = computeReadiness({ id: "s1", index: 1, status: "draft", picked_video_id: "v1" } as Shot);
  assert.equal(unapproved.ready, false);
  assert.match(composeExportBlockReason(false, false, [unapproved])!, /未审批/);
  assert.match(composeExportBlockReason(false, false, [])!, /还没有分镜/);
  assert.equal(composeExportBlockReason(true, false, [unapproved]), null);
  assert.match(composeExportBlockReason(false, true, [unapproved])!, /进行中/);
});
