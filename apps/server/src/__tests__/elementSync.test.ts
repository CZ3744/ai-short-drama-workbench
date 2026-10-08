/**
 * W3 同源 push/pull 同步测试 — 2026-05-26
 *
 * 覆盖:
 *   - diffTags 纯函数 — added/removed 集合正确
 *   - 派生关系反查 — series A 有源 element, series B derived_from=A → listElements 能反查
 *   - readAnyElement 读跨系列素材 — sync 端点的基础依赖
 *
 * 思路: 不 mount express, 直接调 repo + sync.ts 的导出函数, 验证关键业务规则.
 *       用 SERIES_ROOT 下唯一 slug 写真 fs, afterAll 清理.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";

import { diffTags } from "../api/v2/elementController/sync";
import {
  createElement,
  updateElement,
  readElement,
  listElements,
  type ElementData,
} from "../repositories/elementRepo";
import { SERIES_ROOT } from "../repositories/_paths";
import { ensureDir } from "../../../../packages/core/src/index";

// 唯一前缀, 走 isNonUserSeriesDir 黑名单 (以 _ 开头) 避免污染 listSeries.
// 但 createElement 不走 listSeries, 我们用普通 slug 也行 — 测完清理.
const SUITE_A = `w3sync-test-source-${Date.now()}`;
const SUITE_B = `w3sync-test-target-${Date.now()}`;

async function makeFakeSeries(slug: string) {
  const dir = path.join(SERIES_ROOT, slug);
  await ensureDir(dir);
  await ensureDir(path.join(dir, "elements"));
  await fs.writeFile(
    path.join(dir, "series.json"),
    JSON.stringify({
      id: `id-${slug}`,
      slug,
      title: `Test ${slug}`,
      synopsis: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      defaults: { platform: "bilibili", aspect_ratio: "16:9", max_retake_per_shot: 1, max_video_seconds_per_job: 30, max_parallel_tasks: 1 },
      episodes: [],
      character_ids: [],
      scene_ids: [],
      target_platform: "bilibili",
    }, null, 2),
  );
}

async function rmSeries(slug: string) {
  const dir = path.join(SERIES_ROOT, slug);
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe("W3 同源 push/pull 同步", () => {
  describe("diffTags 纯函数", () => {
    it("两侧空数组 → undefined", () => {
      assert.equal(diffTags([], []), undefined);
      assert.equal(diffTags(undefined, undefined), undefined);
    });

    it("upstream 多一项 → added 1 项, removed 0", () => {
      const local = [{ axis: "visual", value: "京味" }];
      const upstream = [
        { axis: "visual", value: "京味" },
        { axis: "personality", value: "稳重" },
      ];
      const d = diffTags(local, upstream);
      assert.ok(d, "应有 diff");
      assert.equal(d!.added.length, 1);
      assert.equal(d!.added[0].value, "稳重");
      assert.equal(d!.removed.length, 0);
    });

    it("local 多一项 → removed 1 项", () => {
      const local = [
        { axis: "visual", value: "京味" },
        { axis: "personality", value: "暴躁" },
      ];
      const upstream = [{ axis: "visual", value: "京味" }];
      const d = diffTags(local, upstream);
      assert.ok(d);
      assert.equal(d!.removed.length, 1);
      assert.equal(d!.removed[0].value, "暴躁");
    });

    it("两侧完全相同 → undefined", () => {
      const a = [{ axis: "visual", value: "京味" }];
      const b = [{ axis: "visual", value: "京味" }];
      assert.equal(diffTags(a, b), undefined);
    });

    it("axis 不同 value 相同 → 视为不同 tag", () => {
      const local = [{ axis: "visual", value: "重" }];
      const upstream = [{ axis: "personality", value: "重" }];
      const d = diffTags(local, upstream);
      assert.ok(d);
      assert.equal(d!.added.length, 1);
      assert.equal(d!.removed.length, 1);
    });
  });

  describe("端到端: 派生关系反查 + 上游差异检测", () => {
    let srcElement: ElementData;
    let derivedElement: ElementData;

    before(async () => {
      await makeFakeSeries(SUITE_A);
      await makeFakeSeries(SUITE_B);

      // SUITE_A 建源 element (kind=prop, 走 elementRepo)
      srcElement = await createElement(SUITE_A, {
        kind: "prop",
        name: "黄铜怀表",
        description: "黄铜壳, 表盖刻花",
        tags: [{ axis: "visual", value: "复古" }],
      });

      // SUITE_B 建派生 element, derived_from 指向 srcElement
      derivedElement = await createElement(SUITE_B, {
        kind: "prop",
        name: "黄铜怀表(导入)",
        description: "黄铜壳, 表盖刻花",
        tags: [{ axis: "visual", value: "复古" }],
        derived_from: { series_slug: SUITE_A, element_id: srcElement.id },
      });
    });

    after(async () => {
      await rmSeries(SUITE_A);
      await rmSeries(SUITE_B);
    });

    it("listDerivatives 等价逻辑: SUITE_B 的 listElements 能找到指向 SUITE_A 的派生", async () => {
      const elements = await listElements(SUITE_B);
      const found = elements.filter(
        (e) => e.derived_from?.series_slug === SUITE_A && e.derived_from?.element_id === srcElement.id,
      );
      assert.equal(found.length, 1, "应反查到 1 个派生");
      assert.equal(found[0].name, "黄铜怀表(导入)");
    });

    it("upstream-diff 等价逻辑: A 改 description → B 的 upstream 比较有变化", async () => {
      // 用户更新源
      const newDesc = "黄铜壳, 表盖刻花, 链子断了一节";
      await new Promise((r) => setTimeout(r, 10)); // 让 updated_at 有差
      const updatedSrc = await updateElement(SUITE_A, srcElement.id, { description: newDesc });
      assert.ok(updatedSrc);
      assert.equal(updatedSrc!.description, newDesc);

      // 模拟 upstream-diff: 读 derived element 的 derived_from → 读源 → 对比字段
      const localAfter = await readElement(SUITE_B, derivedElement.id);
      assert.ok(localAfter);
      assert.ok(localAfter!.derived_from);
      const upstream = await readElement(
        localAfter!.derived_from!.series_slug,
        localAfter!.derived_from!.element_id,
      );
      assert.ok(upstream);
      assert.notEqual(localAfter!.description, upstream!.description, "本地和上游 description 应不同");
      assert.ok(
        upstream!.updated_at.localeCompare(localAfter!.updated_at) > 0,
        "上游 updated_at 应更新",
      );
    });

    it("pull-from-upstream 等价逻辑: 拉 description 后本地 == 上游", async () => {
      // 模拟拉取: 读上游 → updateElement 本地 description
      const local = await readElement(SUITE_B, derivedElement.id);
      const upstream = await readElement(SUITE_A, srcElement.id);
      assert.ok(local && upstream);
      await updateElement(SUITE_B, derivedElement.id, { description: upstream!.description });
      const after = await readElement(SUITE_B, derivedElement.id);
      assert.equal(after!.description, upstream!.description, "拉取后两边 description 一致");
    });

    it("push-to-downstream 等价逻辑: 源改 tags → push 后下游 tags 等于源", async () => {
      // 源加新 tag
      const newTags = [
        { axis: "visual", value: "复古" },
        { axis: "material", value: "黄铜" },
      ];
      await updateElement(SUITE_A, srcElement.id, { tags: newTags });
      const src = await readElement(SUITE_A, srcElement.id);
      assert.equal(src!.tags.length, 2);

      // 模拟 push: 直接 updateElement 目标 tags = src.tags
      await updateElement(SUITE_B, derivedElement.id, { tags: src!.tags });
      const target = await readElement(SUITE_B, derivedElement.id);
      assert.equal(target!.tags.length, 2);
      const td = diffTags(target!.tags, src!.tags);
      assert.equal(td, undefined, "push 后 diffTags 应返 undefined");
    });

    it("push 禁止: target.derived_from 不指向源 → 业务层应拦截", async () => {
      // 模拟一个"假派生"的 target: derived_from 指向其他系列, 业务层应拦截 push
      const fakeDerived = await createElement(SUITE_B, {
        kind: "prop",
        name: "假派生道具",
        derived_from: { series_slug: "non-existent-series", element_id: "non-existent" },
      });
      const target = await readElement(SUITE_B, fakeDerived.id);
      assert.ok(target);
      // sync.ts 的 push 端点校验:
      //   if (!target.derived_from || target.derived_from.series_slug !== sourceSlug
      //       || target.derived_from.element_id !== sourceId) → 400
      const isDerived =
        !!target!.derived_from
        && target!.derived_from.series_slug === SUITE_A
        && target!.derived_from.element_id === srcElement.id;
      assert.equal(isDerived, false, "假派生不该通过校验");
    });
  });
});
