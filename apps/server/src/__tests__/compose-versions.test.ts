import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createSeries, createEpisode } from "../api/v2/seriesStore";
import { listComposeVersions } from "../repositories/episodeRepo";
import { episodeDir } from "../repositories/_paths";
import { getFinalMp4, listEpisodeComposeVersions } from "../application/export/exportUseCases";

describe("compose output history", () => {
  let slug: string;
  let episodeId: string;
  let dir: string;

  before(async () => {
    assert.equal(process.env.NODE_ENV, "test");
    assert.equal(path.resolve(process.env.VIDEO_GENERATE_TEST_FIXTURE ?? ""), process.cwd());
    slug = (await createSeries({ title: "成片历史隔离回归" })).slug;
    episodeId = (await createEpisode(slug, { title: "只有最终输出可列入历史" })).id;
    dir = path.join(episodeDir(slug, episodeId), "compose");
  });

  it("returns an empty history before any render exists", async () => {
    assert.deepEqual(await listComposeVersions(slug, episodeId), []);
  });

  it("keeps intermediates on disk while exposing only completed outputs and numbered snapshots", async () => {
    await fs.mkdir(dir, { recursive: true });
    const completed = ["final.mp4", "final_v1.mp4", "final_v12.mp4", "rough_1780000000000.mp4"];
    const intermediates = ["source.mp4", "source_tts.mp4", "source_mixed.mp4", "final_replaced.mp4", "final_v2.mp4.tmp", "rough_1780000000000_source.mp4", "rough_1780000000000_sh01.mp4", "rough_notes.mp4"];
    const names = [...completed, ...intermediates];
    for (const [index, name] of names.entries()) {
      await fs.writeFile(path.join(dir, name), `fixture: ${name}`);
      await fs.utimes(path.join(dir, name), 1_780_000_000 + index, 1_780_000_000 + index);
    }
    // A directory with a valid-looking filename is not a downloadable version.
    await fs.mkdir(path.join(dir, "final_v99.mp4"));
    await fs.mkdir(path.join(dir, "_trash"));
    await fs.writeFile(path.join(dir, "_trash", "final_v0.mp4"), "retained trash fixture");

    const versions = await listComposeVersions(slug, episodeId);
    assert.deepEqual(versions.map(version => version.filename), [...completed].reverse());
    assert.equal(versions[0].mode, "rough");
    assert.ok(versions.slice(1).every(version => version.mode === "full" && version.size_bytes > 0));
    const result = await listEpisodeComposeVersions(slug, episodeId);
    assert.equal(result.kind, "json");
    if (result.kind === "json") {
      const listed = result.body.versions as Array<{ filename: string; url: string }>;
      assert.deepEqual(listed.map(version => version.filename), [...completed].reverse());
      assert.ok(listed.every(version => version.url.endsWith(`/compose-file/${version.filename}`)));
    }
    assert.deepEqual((await fs.readdir(dir)).filter(name => names.includes(name)).sort(), [...names].sort(), "listing must never remove internal media");
  });

  it("never serves an unfinished source as final after a failed or interrupted render", async () => {
    const final = path.join(dir, "final.mp4");
    assert.deepEqual(await getFinalMp4(slug, episodeId), { kind: "file", path: final });
    await fs.rename(final, `${final}.unfinished-fixture`);
    const result = await getFinalMp4(slug, episodeId);
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.status, 404);
      assert.equal((result.body.error as { code: string }).code, "FinalNotReady");
    }
    assert.ok(await fs.stat(path.join(dir, "source.mp4")), "unfinished source remains available for recovery");
  });
});
