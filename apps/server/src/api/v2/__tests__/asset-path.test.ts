import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  addAsset,
  createSeries,
  deleteAsset,
  getAssetThumbnailPath,
  resolveAssetFilePath,
} from "../seriesStore";

describe("series asset path resolution", () => {
  let slug = "";

  after(async () => {
    if (!slug) return;
    await fs.rm(path.join(process.cwd(), "data", "series", slug), { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(process.cwd(), "outputs", "series", slug), { recursive: true, force: true }).catch(() => {});
  });

  it("serves relative series assets and absolute generated outputs without escaping the project", async () => {
    const series = await createSeries({
      title: `素材路径测试 ${Date.now()}`,
      synopsis: "验证 asset.path 相对/绝对路径兼容",
    });
    slug = series.slug;

    const relativeFile = path.join(process.cwd(), "data", "series", slug, "assets", "images", "relative.png");
    await fs.mkdir(path.dirname(relativeFile), { recursive: true });
    await fs.writeFile(relativeFile, Buffer.from("relative"));

    const relativeAsset = await addAsset(slug, {
      series_slug: slug,
      kind: "image",
      tags: [],
      path: "assets/images/relative.png",
      filename: "relative.png",
      mime: "image/png",
      size_bytes: 8,
    });

    assert.equal(await getAssetThumbnailPath(slug, relativeAsset.asset_id, 256), relativeFile);

    const outputFile = path.join(process.cwd(), "outputs", "series", slug, "episodes", "ep01", "assets", "generated.png");
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.writeFile(outputFile, Buffer.from("generated"));

    const generatedAsset = await addAsset(slug, {
      series_slug: slug,
      kind: "image",
      tags: [],
      path: outputFile,
      filename: "generated.png",
      mime: "image/png",
      size_bytes: 9,
    });

    assert.equal(await getAssetThumbnailPath(slug, generatedAsset.asset_id, 256), outputFile);
    assert.equal(resolveAssetFilePath(slug, path.join(process.cwd(), "outputs", "other-series", "x.png")), null);
    assert.equal(resolveAssetFilePath(slug, "../../outside.png"), null);

    assert.equal(await deleteAsset(slug, generatedAsset.asset_id), true);
    await assert.rejects(() => fs.access(outputFile));
  });
});
