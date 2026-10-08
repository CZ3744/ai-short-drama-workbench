/** Self-contained storage/preview fixture; never relies on a user's historical demo. */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { repoRoot } from "../../../core/src/paths";
import { isSupportingElement } from "../elementKinds";
import { ShotSchema } from "../schema";
import type { ElementKind } from "../types";
import { createSeries, readSeries, createEpisode, listEpisodes, createCharacter, listCharacters, createScene, listScenes, addShot, readShot } from "../../../../apps/server/src/api/v2/seriesStore";
import { createElement, listElements } from "../../../../apps/server/src/repositories/elementRepo";
import { previewPlanStoryboardPrompt } from "../../../../apps/server/src/application/preview/previewPrompts";

assert.equal(path.resolve(process.env.VIDEO_GENERATE_TEST_FIXTURE ?? ""), repoRoot, "run through npm test isolation");
let slug: string, episodeId: string, shotId: string, characterId: string, sceneId: string;
const supportingKinds = ["prop", "wardrobe", "reference", "misc"] as const;
before(async () => {
  const series = await createSeries({ title: "quality-fixture-six-kinds", synopsis: "A robot assembles a toy." });
  slug = series.slug;
  const character = await createCharacter(slug, { name: "FixturePilot", role: "lead", personality: "careful", appearance_prompt: "robot" });
  characterId = character.id;
  const scene = await createScene(slug, { name: "FixtureWorkshop", location: "workshop" });
  sceneId = scene.id;
  const ids: string[] = [];
  for (const kind of supportingKinds) ids.push((await createElement(slug, { kind, name: `Fixture_${kind}`, description: `Context_${kind}` })).id);
  const episode = await createEpisode(slug, { title: "FixtureEpisode" });
  episodeId = episode.id;
  const shot = await addShot(slug, episodeId, { action: "Robot moves the toy", character_ids: [character.id], scene_id: scene.id, element_ids: ids });
  shotId = shot.id;
});

describe("isolated six-kind fixture", () => {
  it("persists all six kinds once and retains shot/episode references", async () => {
    const chars = await listCharacters(slug), scenes = await listScenes(slug), elements = await listElements(slug);
    assert.deepEqual(chars.map(c => c.id), [characterId]);
    assert.deepEqual(scenes.map(s => s.id), [sceneId]);
    assert.deepEqual(elements.map(e => e.kind).sort(), [...supportingKinds].sort());
    const series = await readSeries(slug);
    assert.deepEqual(series?.character_ids, [characterId]);
    assert.deepEqual(series?.scene_ids, [sceneId]);
    assert.deepEqual(series?.episodes, (await listEpisodes(slug)).map(e => e.id));
    const shot = ShotSchema.parse(await readShot(slug, episodeId, shotId));
    assert.deepEqual(shot.character_ids, [characterId]);
    assert.equal(shot.scene_id, sceneId);
    assert.deepEqual([...shot.element_ids].sort(), elements.map(e => e.id).sort());
    for (const kind of ["character", "scene", ...supportingKinds] as ElementKind[]) {
      assert.equal(isSupportingElement({ kind }), kind !== "character" && kind !== "scene", kind);
    }
  });
  it("includes all six kinds in the real planner prompt preview without a provider call", async () => {
    const result = await previewPlanStoryboardPrompt({ slug, episodeId, body: {} });
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") throw new Error("preview failed");
    const prompt = String(result.body.full_prompt);
    for (const name of ["FixturePilot", "FixtureWorkshop", ...supportingKinds.map(k => `Fixture_${k}`)]) {
      assert.ok(prompt.includes(name), `missing ${name}`);
    }
  });
});
