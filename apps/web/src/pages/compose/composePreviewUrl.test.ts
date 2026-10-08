import { test } from "node:test";
import assert from "node:assert/strict";
import { composePreviewUrl, composeVersionUrl } from "./composePreviewUrl";

test("subtitle realignment token never becomes part of the video filename", () => {
  const url = composePreviewUrl("story", "ep 1", "compose/final.mp4?t=123", "job1");
  assert.ok(url.startsWith("/api/v2/series/story/episodes/ep%201/final.mp4?v="));
  assert.ok(!url.includes("compose-file"));
});

test("repeated composes of final.mp4 receive different browser cache revisions", () => {
  assert.notEqual(composePreviewUrl("story", "ep1", "final.mp4", "job1"), composePreviewUrl("story", "ep1", "final.mp4", "job2"));
  assert.ok(composePreviewUrl("story", "ep1", "C:\\output\\rough cut.mp4").includes("compose-file/rough%20cut.mp4?v="));
  assert.equal(composeVersionUrl("/video?kind=full", "2026-10-08"), "/video?kind=full&v=2026-10-08");
});
