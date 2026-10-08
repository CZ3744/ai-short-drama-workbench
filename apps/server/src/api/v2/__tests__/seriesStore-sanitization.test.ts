import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createEpisode,
  createSeries,
  createVersion,
  readEpisode,
  readVersionFile,
  updateEpisode,
} from "../seriesStore";

const DIRTY_SCRIPT = [
  "# 测试兜底",
  "",
  "## 灵感原文",
  "",
  "一位年轻程序员在深夜发现了人工智能的真正潜力。",
  "",
  "> 注：LLM 调用链路全部失败（ikuncode_gpt55:服务器错误，备选1/1 mimo_v25pro:频率限制）。请检查设置 → Providers。以下为原始灵感文本。",
].join("\n");

const DIRTY_SUMMARY = "LLM 调用链路全部失败（ikuncode_gpt55:服务器错误，备选1/1 mimo_v25pro:频率限制）。请检查设置 → Providers";

describe("seriesStore fallback sanitization", () => {
  let slug = "";
  let epId = "";

  after(async () => {
    if (slug) {
      await fs.rm(path.join(process.cwd(), "data", "series", slug), { recursive: true, force: true }).catch(() => {});
    }
  });

  it("strips fallback notes before persisting episode and version files", async () => {
    const series = await createSeries({
      title: `兜底清理测试 ${Date.now()}`,
      synopsis: "验证失败兜底文本不会写进正文",
    });
    slug = series.slug;

    const episode = await createEpisode(slug, { title: "第 1 集", index: 1 });
    epId = episode.id;

    const updated = await updateEpisode(slug, epId, {
      script_md: DIRTY_SCRIPT,
      versions: [
        {
          version: 1,
          created_at: "2026-05-11T00:00:00.000Z",
          source: "ai_init",
          summary: DIRTY_SUMMARY,
          script_md: DIRTY_SCRIPT,
        },
      ],
    });

    assert.ok(updated);
    assert.ok(updated?.script_md);
    assert.ok(!updated!.script_md!.includes("LLM 调用链路全部失败"));
    assert.equal(updated!.versions?.[0].summary, "LLM 生成失败，已保留原始灵感文本");
    assert.ok(updated!.versions?.[0].script_md);
    assert.ok(!updated!.versions?.[0].script_md.includes("LLM 调用链路全部失败"));

    const episodeFile = path.join(process.cwd(), "data", "series", slug, "episodes", epId, "episode.json");
    const storedEpisode = await fs.readFile(episodeFile, "utf8");
    assert.ok(!storedEpisode.includes("LLM 调用链路全部失败"));

    const version = await createVersion(slug, epId, DIRTY_SCRIPT, "ai_init", DIRTY_SUMMARY);
    assert.ok(!version.script_md.includes("LLM 调用链路全部失败"));
    assert.equal(version.summary, "LLM 生成失败，已保留原始灵感文本");

    const versionFile = path.join(process.cwd(), "data", "series", slug, "episodes", epId, "versions", `v${version.version}.json`);
    const storedVersion = await fs.readFile(versionFile, "utf8");
    assert.ok(!storedVersion.includes("LLM 调用链路全部失败"));

    const rereadEpisode = await readEpisode(slug, epId);
    assert.ok(rereadEpisode);
    assert.ok(!rereadEpisode!.script_md!.includes("LLM 调用链路全部失败"));

    const rereadVersion = await readVersionFile(slug, epId, version.version);
    assert.ok(rereadVersion);
    assert.ok(!rereadVersion!.script_md.includes("LLM 调用链路全部失败"));
  });
});
