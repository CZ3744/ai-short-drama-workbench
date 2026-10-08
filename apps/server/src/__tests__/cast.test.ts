/**
 * W4 Cast / IP 容器跨系列复用测试 — 2026-05-26.
 *
 * 覆盖:
 *   - createCast → readCast → updateCast → 命中
 *   - addCastMemberElement → listCastElements 命中
 *   - 挂入 series (updateSeries cast_id) → series.cast_id 写入
 *   - getEffectiveElementsForSeries → 包含 cast 老张
 *   - series local 加同 id element → effective 列里 local 覆盖 cast (本剧 override)
 *   - cast 元素加 image → series 视角看到 (effective single read)
 *   - 软删 cast → effective-elements 不再含 cast 元素 (降级走 local-only)
 *
 * 风格: 直接调 repo / application helper (不 mount express), 跟 elementSync.test.ts 同套路.
 *       用 SERIES_ROOT / CASTS_ROOT 下唯一 slug/castId 写真 fs, after 清理.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";

import {
  createCast,
  readCast,
  updateCast,
  deleteCast,
  addCastMemberElement,
  listCastElements,
  readCastElement,
  addCastElementImage,
  CASTS_ROOT,
  castDir,
} from "../repositories/castRepo";
import { createElement } from "../repositories/elementRepo";
import { updateSeries, readSeries } from "../repositories/seriesRepo";
import { getEffectiveElementsForSeries, readEffectiveElement } from "../application/cast/effectiveElements";
import { SERIES_ROOT } from "../repositories/_paths";
import { ensureDir } from "../../../../packages/core/src/index";

// 唯一前缀 — 走完即清, 不污染主目录
const TS = Date.now();
const SERIES_A = `w4-cast-series-a-${TS}`;
const SERIES_B = `w4-cast-series-b-${TS}`;

async function makeFakeSeries(slug: string) {
  const dir = path.join(SERIES_ROOT, slug);
  await ensureDir(dir);
  await ensureDir(path.join(dir, "elements"));
  await fs.writeFile(
    path.join(dir, "series.json"),
    JSON.stringify(
      {
        id: `id-${slug}`,
        slug,
        title: `Test ${slug}`,
        synopsis: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        defaults: {
          platform: "bilibili",
          aspect_ratio: "16:9",
          max_retake_per_shot: 1,
          max_video_seconds_per_job: 30,
          max_parallel_tasks: 1,
        },
        episodes: [],
        character_ids: [],
        scene_ids: [],
        target_platform: "bilibili",
      },
      null,
      2,
    ),
  );
}

async function rmSeries(slug: string) {
  const dir = path.join(SERIES_ROOT, slug);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function rmCast(castId: string) {
  try {
    await fs.rm(castDir(castId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe("W4 Cast / IP 容器", () => {
  describe("castRepo CRUD", () => {
    let castId = "";
    before(async () => {
      await ensureDir(CASTS_ROOT);
    });
    after(async () => {
      if (castId) await rmCast(castId);
    });

    it("createCast + readCast + updateCast 全命中", async () => {
      const cast = await createCast({
        name: `老头们${TS}`,
        description: "持续 IP 老年喜剧角色组合",
      });
      castId = cast.id;
      assert.ok(cast.id, "应有 id");
      assert.equal(cast.name, `老头们${TS}`);
      assert.equal(cast.description, "持续 IP 老年喜剧角色组合");
      assert.deepEqual(cast.member_element_ids, []);

      const got = await readCast(cast.id);
      assert.ok(got);
      assert.equal(got!.id, cast.id);

      // 让 updated_at 有差
      await new Promise((r) => setTimeout(r, 5));
      const patched = await updateCast(cast.id, { description: "改了" });
      assert.ok(patched);
      assert.equal(patched!.description, "改了");
      assert.equal(patched!.name, `老头们${TS}`);
      assert.ok(
        patched!.updated_at.localeCompare(cast.updated_at) > 0,
        "updated_at 应更新",
      );
    });

    it("addCastMemberElement → listCastElements 命中, member_element_ids 倒排索引同步", async () => {
      const el = await addCastMemberElement(castId, {
        kind: "character",
        name: "老张",
        description: "60 岁老人, 国字脸",
      });
      assert.ok(el.id);
      assert.equal(el.name, "老张");
      assert.equal(el.series_slug, "__cast__", "cast member 用 __cast__ sentinel");
      assert.equal(el.kind, "character");

      const list = await listCastElements(castId);
      assert.equal(list.length, 1);
      assert.equal(list[0].id, el.id);

      // 倒排索引
      const cast = await readCast(castId);
      assert.ok(cast!.member_element_ids.includes(el.id));
    });
  });

  describe("series 挂入 cast + effective-elements 合并视图", () => {
    let castId = "";
    let castEl1Id = "";
    let castEl2Id = "";

    before(async () => {
      await ensureDir(CASTS_ROOT);
      await makeFakeSeries(SERIES_A);
      await makeFakeSeries(SERIES_B);

      const cast = await createCast({ name: `cast-merge-${TS}` });
      castId = cast.id;

      // cast 加 2 个 element
      const e1 = await addCastMemberElement(castId, {
        kind: "prop",
        name: "黄铜怀表",
        description: "表盖刻花",
      });
      castEl1Id = e1.id;
      const e2 = await addCastMemberElement(castId, {
        kind: "wardrobe",
        name: "灰色中山装",
        description: "立领四口袋",
      });
      castEl2Id = e2.id;
    });

    after(async () => {
      if (castId) await rmCast(castId);
      await rmSeries(SERIES_A);
      await rmSeries(SERIES_B);
    });

    it("PATCH series.cast_id 写入 (经 updateSeries)", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试故意传未在 PatchSeriesData 声明的 cast_id 字段, 验证后端兼容
      const updated = await updateSeries(SERIES_A, { cast_id: castId } as any);
      assert.ok(updated);
      assert.equal(updated!.cast_id, castId);
      const reloaded = await readSeries(SERIES_A);
      assert.equal(reloaded!.cast_id, castId, "落盘后应能再读出 cast_id");
    });

    it("getEffectiveElementsForSeries 应包含全部 cast member, _source=cast", async () => {
      const eff = await getEffectiveElementsForSeries(SERIES_A);
      const castMembers = eff.filter((e) => e._source === "cast");
      const ids = castMembers.map((e) => e.id).sort();
      assert.deepEqual(ids.sort(), [castEl1Id, castEl2Id].sort());
      // 都标记为 cast 来源
      assert.ok(castMembers.every((e) => e._source === "cast" && e._cast_id === castId));
    });

    it("series local 加同 id element → effective 列里 local 覆盖 cast (本剧 override)", async () => {
      // 在 SERIES_A 加一个跟 castEl1Id 同 id 的本剧专属 element
      // 注: createElement 用 slugify(name) 算 id, 想精确撞 id 需要源 name 一致或先建后改名
      //     这里走"先建后改名"的取巧办法: 建 element 后用 fs 改文件名达成同 id (简化测试).
      //     正式生产路径靠 promote-from-series 保留源 id 避免撞名.
      const fakeLocal = await createElement(SERIES_A, {
        kind: "prop",
        name: `本剧改版-${TS}`,
        description: "本剧专属覆盖版",
      });
      // 改文件名为 castEl1Id
      const fromPath = path.join(SERIES_ROOT, SERIES_A, "elements", `${fakeLocal.id}.json`);
      const toPath = path.join(SERIES_ROOT, SERIES_A, "elements", `${castEl1Id}.json`);
      // 同时改文件内 id 字段
      const raw = await fs.readFile(fromPath, "utf8");
      const obj = JSON.parse(raw);
      obj.id = castEl1Id;
      await fs.writeFile(toPath, JSON.stringify(obj, null, 2));
      await fs.unlink(fromPath);

      const eff = await getEffectiveElementsForSeries(SERIES_A);
      const same = eff.filter((e) => e.id === castEl1Id);
      assert.equal(same.length, 1, "同 id 仅出现一次");
      assert.equal(same[0]._source, "local", "本剧 local 覆盖 cast");
      assert.equal(same[0].description, "本剧专属覆盖版");
    });

    it("readEffectiveElement: series local 优先返 local 标记", async () => {
      const el = await readEffectiveElement(SERIES_A, castEl1Id);
      assert.ok(el);
      assert.equal(el!._source, "local");
    });

    it("readEffectiveElement: cast-only element 走 cast fallback", async () => {
      const el = await readEffectiveElement(SERIES_A, castEl2Id);
      assert.ok(el);
      assert.equal(el!._source, "cast");
      assert.equal(el!.name, "灰色中山装");
    });

    it("cast 元素加 image → series 视角 readEffectiveElement 能看到", async () => {
      const added = await addCastElementImage(castId, castEl2Id, {
        origin: "imported",
        url: "/test/fake.png",
        mime: "image/png",
        prompt_snapshot: "test snap",
      });
      assert.ok(added);
      assert.equal(added!.element.images.length, 1);

      // 从 SERIES_A 视角读 → 应看到 cast member 带 image
      const el = await readEffectiveElement(SERIES_A, castEl2Id);
      assert.ok(el);
      assert.equal(el!._source, "cast");
      assert.equal(el!.images.length, 1);
      assert.equal(el!.images[0].prompt_snapshot, "test snap");

      // 直接读 cast member 一致
      const direct = await readCastElement(castId, castEl2Id);
      assert.equal(direct!.images.length, 1);
    });

    it("软删 cast → effective-elements 不再含 cast 元素 (降级 local-only)", async () => {
      const ok = await deleteCast(castId);
      assert.equal(ok, true);

      // cast 已软删, readCast 返 null
      const got = await readCast(castId);
      assert.equal(got, null);

      const eff = await getEffectiveElementsForSeries(SERIES_A);
      const castMembers = eff.filter((e) => e._source === "cast");
      assert.equal(castMembers.length, 0, "软删 cast 后 effective view 不再含 cast 元素");

      // 但本剧 local 元素仍在
      const localMembers = eff.filter((e) => e._source === "local");
      assert.ok(localMembers.length >= 1, "本剧 local 元素不受影响");

      // series.cast_id 仍指向死 cast — 容错降级, 不报错
      const series = await readSeries(SERIES_A);
      assert.equal(series!.cast_id, castId, "cast_id 引用保留 (UI 可显示 toast 让用户决定是否清理)");
    });

    it("未挂 cast 的 series (SERIES_B) → effective-elements 仅 local", async () => {
      const eff = await getEffectiveElementsForSeries(SERIES_B);
      const castMembers = eff.filter((e) => e._source === "cast");
      assert.equal(castMembers.length, 0, "未挂 cast 不应有任何 cast 元素");
    });
  });
});
