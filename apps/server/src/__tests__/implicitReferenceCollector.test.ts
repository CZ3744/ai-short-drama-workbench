/**
 * Wave B-2 test: collectImplicitReferences — 验证 character / scene / element 主图被收集.
 *
 * 覆盖路径:
 *  1. 角色主图(character.primary_ref_image_id)出现在结果里
 *  2. 场景主图(scene.primary_ref_image_id)出现在结果里
 *  3. element 主图(prop kind, element.primary_image_id → image.asset_id)出现在结果里
 *  4. 主图缺失时跳过, 不报错(用户没锁主图是合法状态)
 *  5. 顺序: characters → scene → elements
 *  6. label 含人类可读名(不暴露 id)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  createSeries,
  deleteSeries,
  createCharacter,
  updateCharacter,
  createScene,
  updateScene,
} from "../api/v2/seriesStore";
import { createElement, updateElement } from "../repositories/elementRepo";
import { collectImplicitReferences } from "../application/generation/implicitReferenceCollector";

let slug = "";

describe("Wave B-2: implicitReferenceCollector", () => {
  before(async () => {
    const s = await createSeries({
      title: `B-2 test ${Date.now()}`,
      defaults: { aspect_ratio: "16:9" },
    });
    slug = s.slug;
  });

  after(async () => {
    await deleteSeries(slug).catch(() => false);
  });

  it("collects character primary_ref_image_id", async () => {
    const charWithPrimary = await createCharacter(slug, {
      name: "小明 has primary",
      role: "主角",
      appearance_prompt: "短发男孩",
      personality: "活泼",
    });
    await updateCharacter(slug, charWithPrimary.id, {
      primary_ref_image_id: "asset_minmin_main_1",
    });

    const refs = await collectImplicitReferences(slug, {
      character_ids: [charWithPrimary.id],
    });

    assert.equal(refs.length, 1, "exactly 1 suggested ref");
    assert.equal(refs[0].asset_id, "asset_minmin_main_1");
    assert.equal(refs[0].source, "character_primary");
    assert.equal(refs[0].source_id, charWithPrimary.id);
    assert.ok(refs[0].label.includes("小明"), `label must include name: ${refs[0].label}`);
    assert.ok(refs[0].label.includes("主图"), `label must include 主图: ${refs[0].label}`);
    assert.ok(refs[0].url.includes("asset_minmin_main_1"), `url must include asset_id: ${refs[0].url}`);
  });

  it("skips character without primary_ref_image_id (not error)", async () => {
    const charNoPrimary = await createCharacter(slug, {
      name: "小红 no primary",
      role: "配角",
      appearance_prompt: "长发女孩",
      personality: "内向",
    });
    // 注意: 没有 updateCharacter 设 primary_ref_image_id

    const refs = await collectImplicitReferences(slug, {
      character_ids: [charNoPrimary.id],
    });

    assert.equal(refs.length, 0, "char without primary contributes 0 refs");
  });

  it("collects scene primary_ref_image_id", async () => {
    const scene = await createScene(slug, {
      name: "客厅 livingroom",
      description: "暖色调家居",
    });
    await updateScene(slug, scene.id, {
      primary_ref_image_id: "asset_livingroom_main_1",
    });

    const refs = await collectImplicitReferences(slug, {
      scene_id: scene.id,
    });

    assert.equal(refs.length, 1);
    assert.equal(refs[0].source, "scene_primary");
    assert.equal(refs[0].asset_id, "asset_livingroom_main_1");
    assert.ok(refs[0].label.includes("客厅"), `label includes scene name: ${refs[0].label}`);
  });

  it("collects element primary_image_id (prop kind)", async () => {
    const el = await createElement(slug, {
      kind: "prop",
      name: "魔法剑",
      description: "发光银剑",
    });
    // 设置 images + primary_image_id (image_id 不是 asset_id, 但 images 内的 asset_id 才是 reference key)
    await updateElement(slug, el.id, {
      images: [
        {
          image_id: "img_magicsword_1",
          asset_id: "asset_magicsword_locked_1",
          url: "",
          mime: "image/png",
          origin: "generated",
          created_at: new Date().toISOString(),
        },
      ],
      primary_image_id: "img_magicsword_1",
    });

    const refs = await collectImplicitReferences(slug, {
      element_ids: [el.id],
    });

    assert.equal(refs.length, 1);
    assert.equal(refs[0].source, "element_primary");
    assert.equal(
      refs[0].asset_id,
      "asset_magicsword_locked_1",
      "element ref uses image.asset_id, not image_id",
    );
    assert.ok(refs[0].label.includes("魔法剑"));
  });

  it("preserves order: characters → scene → elements", async () => {
    const char = await createCharacter(slug, {
      name: "Order Char",
      role: "主角",
      appearance_prompt: "X",
      personality: "Y",
    });
    await updateCharacter(slug, char.id, { primary_ref_image_id: "order_char_asset" });
    const scene = await createScene(slug, { name: "Order Scene" });
    await updateScene(slug, scene.id, { primary_ref_image_id: "order_scene_asset" });
    const el = await createElement(slug, { kind: "prop", name: "Order Prop" });
    await updateElement(slug, el.id, {
      images: [
        {
          image_id: "img_orderprop",
          asset_id: "order_prop_asset",
          url: "",
          mime: "image/png",
          origin: "generated",
          created_at: new Date().toISOString(),
        },
      ],
      primary_image_id: "img_orderprop",
    });

    const refs = await collectImplicitReferences(slug, {
      character_ids: [char.id],
      scene_id: scene.id,
      element_ids: [el.id],
    });
    assert.equal(refs.length, 3);
    assert.equal(refs[0].source, "character_primary");
    assert.equal(refs[1].source, "scene_primary");
    assert.equal(refs[2].source, "element_primary");
  });

  it("handles unknown character_id gracefully", async () => {
    const refs = await collectImplicitReferences(slug, {
      character_ids: ["nonexistent-char-id"],
    });
    assert.equal(refs.length, 0, "unknown character does not throw");
  });

  it("returns empty when no character/scene/element ids supplied", async () => {
    const refs = await collectImplicitReferences(slug, {});
    assert.equal(refs.length, 0);
  });
});
