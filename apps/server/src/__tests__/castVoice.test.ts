/**
 * W6 Cast 层 Voice 资产 + Dashboard 聚合测试 — 2026-05-26.
 *
 * 覆盖:
 *   - setCastMemberVoice / getCastMemberVoice / removeCastMemberVoice 闭环
 *   - resolveEffectiveVoiceForCharacter 7 层优先级解析
 *   - dashboard 聚合: cast + 2 series 挂 cast + shots 引用 member → 返正确 series/episode/shot count
 *
 * 风格: 直接调 repo / application helper (不 mount express), 复用 cast.test.ts 套路.
 *       用 SERIES_ROOT / CASTS_ROOT 下唯一 slug/castId 写真 fs, after 清理.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";

import {
  createCast,
  readCast,
  deleteCast,
  addCastMemberElement,
  setCastMemberVoice,
  getCastMemberVoice,
  removeCastMemberVoice,
  CASTS_ROOT,
  castDir,
} from "../repositories/castRepo";
import { updateSeries } from "../repositories/seriesRepo";
import { createEpisode } from "../repositories/episodeRepo";
import { addShot, updateShot } from "../repositories/shotRepo";
import { SERIES_ROOT } from "../repositories/_paths";
import { ensureDir } from "../../../../packages/core/src/index";
import { resolveEffectiveVoiceForCharacter } from "../application/cast/effectiveVoice";
import type { Character } from "../../../../packages/drama/src/types";

// 唯一前缀 — 走完即清, 不污染主目录
const TS = Date.now();
const SERIES_C = `w6-cast-voice-series-c-${TS}`;
const SERIES_D = `w6-cast-voice-series-d-${TS}`;

async function makeFakeSeries(slug: string) {
  const dir = path.join(SERIES_ROOT, slug);
  await ensureDir(dir);
  await ensureDir(path.join(dir, "elements"));
  await ensureDir(path.join(dir, "episodes"));
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
  try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
async function rmCast(castId: string) {
  try { await fs.rm(castDir(castId), { recursive: true, force: true }); } catch { /* ignore */ }
}

describe("W6 Cast Voice 资产", () => {
  describe("setCastMemberVoice / getCastMemberVoice / removeCastMemberVoice 闭环", () => {
    let castId = "";
    let memberId = "";
    before(async () => {
      await ensureDir(CASTS_ROOT);
      const cast = await createCast({ name: `w6-voice-${TS}` });
      castId = cast.id;
      const m = await addCastMemberElement(castId, {
        kind: "character",
        name: "老张",
      });
      memberId = m.id;
    });
    after(async () => { if (castId) await rmCast(castId); });

    it("set 后 voice_assets 中有该 member", async () => {
      const updated = await setCastMemberVoice(castId, memberId, {
        voice_sample_vault_id: "cast:foo:assets/voices/x.mp3",
        provider_voice_ids: { minimax_t2a: "voice-mm-001" },
        voice_style_map: { default: "voice-default", crying: "voice-cry" },
      });
      assert.ok(updated);
      const got = getCastMemberVoice(updated!, memberId);
      assert.ok(got);
      assert.equal(got!.voice_sample_vault_id, "cast:foo:assets/voices/x.mp3");
      assert.equal(got!.provider_voice_ids?.minimax_t2a, "voice-mm-001");
      assert.equal(got!.voice_style_map?.crying, "voice-cry");
      assert.ok(got!.created_at);
      assert.ok(got!.updated_at);
    });

    it("再次 set 同 memberId → 更新, 不重复 push", async () => {
      const updated = await setCastMemberVoice(castId, memberId, {
        voice_sample_vault_id: "cast:foo:assets/voices/x2.mp3",
      });
      assert.ok(updated);
      assert.equal(updated!.voice_assets?.length, 1, "同 member 只一条记录");
      assert.equal(getCastMemberVoice(updated!, memberId)?.voice_sample_vault_id, "cast:foo:assets/voices/x2.mp3");
    });

    it("getCastMemberVoice 找不到返 undefined", async () => {
      const cast = await readCast(castId);
      const got = getCastMemberVoice(cast, "不存在-id");
      assert.equal(got, undefined);
    });

    it("getCastMemberVoice 接收 null cast 不抛", () => {
      assert.equal(getCastMemberVoice(null, memberId), undefined);
      assert.equal(getCastMemberVoice(undefined, memberId), undefined);
    });

    it("removeCastMemberVoice 后 voice_assets 不再含该 member", async () => {
      const updated = await removeCastMemberVoice(castId, memberId);
      assert.ok(updated);
      assert.equal(getCastMemberVoice(updated!, memberId), undefined);
      // 唯一一条删完后 voice_assets 应 undefined (干净)
      assert.equal(updated!.voice_assets, undefined);
    });
  });

  describe("resolveEffectiveVoiceForCharacter 7 层优先级", () => {
    const fakeChar: Character = {
      id: "char-test",
      series_slug: "test",
      name: "老张",
      role: "主角",
      personality: "",
      voice_id: "voice-char-default",
      voice_style_map: { default: "voice-char-default", crying: "voice-char-cry" },
    };

    it("L1 shot override 最高", () => {
      const r = resolveEffectiveVoiceForCharacter({
        shotOverride: "voice-shot",
        character: fakeChar,
        seriesDefaultVoiceId: "voice-series",
      });
      assert.equal(r.voice_id, "voice-shot");
      assert.equal(r.source, "shot_override");
    });

    it("L4 cast voice_style_map[emotion] 在 character 之前", () => {
      const cast = {
        id: "c1",
        name: "ip",
        created_at: "", updated_at: "",
        member_element_ids: ["char-test"],
        voice_assets: [{
          member_element_id: "char-test",
          voice_style_map: { default: "voice-cast-default", crying: "voice-cast-cry" },
          created_at: "", updated_at: "",
        }],
      };
      const r = resolveEffectiveVoiceForCharacter({
        character: fakeChar,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试构造的 partial cast fixture, 不实现完整 Cast 接口
        cast: cast as any,
        emotion: "crying",
      });
      assert.equal(r.voice_id, "voice-cast-cry");
      assert.equal(r.source, "cast_style_map");
    });

    it("L5 cast provider voice_ids 在 character 之前", () => {
      const cast = {
        id: "c1", name: "ip", created_at: "", updated_at: "",
        member_element_ids: ["char-test"],
        voice_assets: [{
          member_element_id: "char-test",
          provider_voice_ids: { minimax_t2a: "voice-cast-minimax" },
          created_at: "", updated_at: "",
        }],
      };
      const r = resolveEffectiveVoiceForCharacter({
        character: fakeChar,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试构造的 partial cast fixture, 不实现完整 Cast 接口
        cast: cast as any,
        provider: "minimax_t2a",
      });
      assert.equal(r.voice_id, "voice-cast-minimax");
      assert.equal(r.source, "cast_provider_map");
    });

    it("无 cast 时 → L6 character.voice_style_map[emotion]", () => {
      const r = resolveEffectiveVoiceForCharacter({
        character: fakeChar,
        emotion: "crying",
      });
      assert.equal(r.voice_id, "voice-char-cry");
      assert.equal(r.source, "character_style_map");
    });

    it("character 无 style_map → L7 character.voice_id", () => {
      const r = resolveEffectiveVoiceForCharacter({
        character: { ...fakeChar, voice_style_map: undefined },
      });
      assert.equal(r.voice_id, "voice-char-default");
      assert.equal(r.source, "character_voice_id");
    });

    it("character 无 voice → L8 series default", () => {
      const r = resolveEffectiveVoiceForCharacter({
        character: { ...fakeChar, voice_id: undefined, voice_style_map: undefined },
        seriesDefaultVoiceId: "voice-series-fallback",
      });
      assert.equal(r.voice_id, "voice-series-fallback");
      assert.equal(r.source, "series_default");
    });

    it("全 undefined → L9 globalDefault", () => {
      const r = resolveEffectiveVoiceForCharacter({});
      // 默认 globalDefault
      assert.ok(r.voice_id.length > 0);
      assert.equal(r.source, "global_default");
    });
  });

  describe("Cast Dashboard 聚合 (端点逻辑)", () => {
    let castId = "";
    let charAId = "";
    let propBId = "";

    before(async () => {
      await ensureDir(CASTS_ROOT);
      await makeFakeSeries(SERIES_C);
      await makeFakeSeries(SERIES_D);
      const cast = await createCast({ name: `w6-dash-${TS}` });
      castId = cast.id;
      // cast 加 2 个 member
      const a = await addCastMemberElement(castId, { kind: "character", name: "老张" });
      charAId = a.id;
      const b = await addCastMemberElement(castId, { kind: "prop", name: "怀表" });
      propBId = b.id;
      // 挂 SERIES_C / SERIES_D 到 cast
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试故意传 cast_id (PatchSeriesData 没声明此字段)
      await updateSeries(SERIES_C, { cast_id: castId } as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
      await updateSeries(SERIES_D, { cast_id: castId } as any);
      // SERIES_C 加 1 集 2 镜 (镜 1 引用 charA, 镜 2 引用 charA + propB)
      const epC1 = await createEpisode(SERIES_C, { title: "C 第一集" });
      const sC1 = await addShot(SERIES_C, epC1.id, { character_ids: [charAId], duration_sec: 5 });
      await updateShot(SERIES_C, epC1.id, sC1.id, { character_ids: [charAId] });
      const sC2 = await addShot(SERIES_C, epC1.id, { character_ids: [charAId], duration_sec: 7 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 测试故意传未在 PatchShotData 声明的 prop_ids 字段, 验证 cast 联动
      await updateShot(SERIES_C, epC1.id, sC2.id, { character_ids: [charAId], prop_ids: [propBId] } as any);
      // SERIES_D 加 1 集 1 镜 (引用 charA)
      const epD1 = await createEpisode(SERIES_D, { title: "D 第一集" });
      const sD1 = await addShot(SERIES_D, epD1.id, { character_ids: [charAId], duration_sec: 3 });
      await updateShot(SERIES_D, epD1.id, sD1.id, { character_ids: [charAId] });
    });
    after(async () => {
      if (castId) await rmCast(castId);
      await rmSeries(SERIES_C);
      await rmSeries(SERIES_D);
    });

    it("dashboard 聚合应正确: 2 部剧 / 2 集 / 3 镜, charA 在 2 剧 2 集 3 镜, propB 在 1 剧 1 集 1 镜", async () => {
      // 直接 inline 复刻 dashboard 端点的聚合逻辑测 (controller 路由没 mount, 走 raw aggregate)
      // 复用 listSeries / listEpisodes / listShots
      const { listSeries, readSeries } = await import("../repositories/seriesRepo");
      const { listEpisodes } = await import("../repositories/episodeRepo");
      const { listShots } = await import("../repositories/shotRepo");
      const { listCastElements } = await import("../repositories/castRepo");

      const allSeries = await listSeries({ includeInternalTestSeries: false });
      const referencingSeries: Array<{ slug: string }> = [];
      for (const item of allSeries) {
        const s = await readSeries(item.slug);
        if (s?.cast_id === castId) referencingSeries.push({ slug: s.slug });
      }
      assert.equal(referencingSeries.length, 2, "应有 2 部剧挂 cast");

      const members = await listCastElements(castId);
      const memberIds = new Set(members.map((m) => m.id));

      let totalEpisodes = 0;
      let totalShots = 0;
      const memberAgg = new Map<string, { series: Set<string>; ep: Set<string>; shots: number }>();
      for (const m of members) memberAgg.set(m.id, { series: new Set(), ep: new Set(), shots: 0 });

      for (const sref of referencingSeries) {
        const eps = await listEpisodes(sref.slug);
        totalEpisodes += eps.length;
        for (const ep of eps) {
          const shots = await listShots(sref.slug, ep.id);
          totalShots += shots.length;
          for (const shot of shots) {
            const hits = new Set<string>();
            for (const cid of shot.character_ids ?? []) if (memberIds.has(cid)) hits.add(cid);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同 line 265, Shot 类型没声明 prop_ids, 测试动态读
            for (const pid of (shot as any).prop_ids ?? []) if (memberIds.has(pid)) hits.add(pid);
            for (const h of hits) {
              const a = memberAgg.get(h)!;
              a.series.add(sref.slug);
              a.ep.add(`${sref.slug}/${ep.id}`);
              a.shots += 1;
            }
          }
        }
      }

      assert.equal(totalEpisodes, 2);
      assert.equal(totalShots, 3);
      const aA = memberAgg.get(charAId)!;
      assert.equal(aA.series.size, 2, "charA 应在 2 剧中");
      assert.equal(aA.ep.size, 2, "charA 应在 2 集中");
      assert.equal(aA.shots, 3, "charA 应在 3 镜中");
      const aB = memberAgg.get(propBId)!;
      assert.equal(aB.series.size, 1, "propB 应只在 1 剧中");
      assert.equal(aB.ep.size, 1);
      assert.equal(aB.shots, 1);
    });

    // 软删 cast 不让 dashboard 数据扭曲 (测删后, readCast 返 null, dashboard 端点会 404, 这里测前置已覆盖)
    it("软删 cast 后 readCast 返 null", async () => {
      const ok = await deleteCast(castId);
      assert.equal(ok, true);
      const got = await readCast(castId);
      assert.equal(got, null);
    });
  });
});
