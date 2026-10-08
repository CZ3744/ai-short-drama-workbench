/**
 * 验证跨项目素材深拷贝路径:
 *   1. importFromProject(): 项目资源 → 公共素材库 (写 assets 表, 带 source_project_slug + source_resource_id)
 *   2. importFromAsset() / exportToProject(): 公共素材库 → 目标项目 (写项目表如 characters / scenes, 带 source_asset_id 血脉)
 *
 * 同时验证:
 *   - 缩略图文件确实被复制到 projects/<target>/assets/imported/<type>/<id>/
 *   - source_asset_id 字段在目标项目表里正确写入
 *   - tags/description 等元数据保留
 *
 * 用 node:test (tsx --test) 运行, 和 packages/core/src/test/*.test.ts 同套件
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ulid } from "ulid";

import { getDb, closeDb } from "../database";
import { createProject, deleteProjectCascade } from "../projects";
import { importFromProject, importFromAsset, exportToProject } from "../assets";
import { projectDir, repoRoot } from "../../paths";

const PROJECT_NAMESPACE = `_assetXProjTest_${Date.now().toString(36)}`;
const SRC_SLUG = `${PROJECT_NAMESPACE}_src`;
const DST_SLUG = `${PROJECT_NAMESPACE}_dst`;

describe("assets cross-project deep-copy", () => {
  let createdAssetIds: string[] = [];

  before(async () => {
    // 提前清理上一次失败留下的残留 (slug 是固定的 namespace 前缀)
    try {
      await deleteProjectCascade(SRC_SLUG);
    } catch { /* not exist */ }
    try {
      await deleteProjectCascade(DST_SLUG);
    } catch { /* not exist */ }

    createProject({ slug: SRC_SLUG, title: "src-test", description: "fixture" });
    createProject({ slug: DST_SLUG, title: "dst-test", description: "fixture" });
  });

  after(async () => {
    const db = getDb();
    // 清掉测试期间插入的 assets 行
    for (const id of createdAssetIds) {
      try { db.prepare("DELETE FROM assets WHERE id = ?").run(id); } catch { /* ignore */ }
    }
    try { await deleteProjectCascade(SRC_SLUG); } catch { /* ignore */ }
    try { await deleteProjectCascade(DST_SLUG); } catch { /* ignore */ }
  });

  it("importFromProject: character 项目资源 → 公共素材库, 含 source 血脉", () => {
    const db = getDb();
    const srcProjectRow = db.prepare("SELECT * FROM projects WHERE slug = ?").get(SRC_SLUG) as { id: string };
    assert.ok(srcProjectRow, "src project should exist");

    // 直接在 src 项目里插一个 character (mimic 真实数据)
    const charId = ulid();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO characters (id, project_id, name, description, tags, thumbnail_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(charId, srcProjectRow.id, "测试角色", "测试描述", JSON.stringify(["tagA", "tagB"]), null, now, now);

    const asset = importFromProject(SRC_SLUG, "character", charId, "公共版命名");
    createdAssetIds.push(asset.id);

    assert.equal(asset.asset_type, "character");
    assert.equal(asset.name, "公共版命名", "newName 应覆盖原 name");
    assert.equal(asset.description, "测试描述", "description 应保留");
    assert.deepEqual(JSON.parse(asset.tags), ["tagA", "tagB"], "tags 应保留");
    assert.equal(asset.source_project_slug, SRC_SLUG, "source_project_slug 应记录来源项目");
    assert.equal(asset.source_resource_id, charId, "source_resource_id 应指向原 character id");
    assert.equal(asset.major_version, 1);
    assert.equal(asset.minor_version, 0);
  });

  it("importFromAsset: 公共素材 → 目标项目, source_asset_id 血脉正确写入", () => {
    const db = getDb();
    const srcProjectRow = db.prepare("SELECT * FROM projects WHERE slug = ?").get(SRC_SLUG) as { id: string };

    // 再插一个 character 当 source
    const charId = ulid();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO characters (id, project_id, name, description, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(charId, srcProjectRow.id, "血脉源角色", "for lineage test", JSON.stringify(["lineage"]), now, now);

    const asset = importFromProject(SRC_SLUG, "character", charId);
    createdAssetIds.push(asset.id);

    // 公共素材库 → DST 项目
    const result = importFromAsset(asset.id, DST_SLUG);
    assert.equal(result.ok, true);

    // 目标项目 characters 表里应有一行, source_asset_id = asset.id
    const dstProjectRow = db.prepare("SELECT * FROM projects WHERE slug = ?").get(DST_SLUG) as { id: string };
    const dstChars = db.prepare("SELECT * FROM characters WHERE project_id = ? AND source_asset_id = ?")
      .all(dstProjectRow.id, asset.id) as Array<{
        id: string; name: string; description: string; tags: string; source_asset_id: string;
        asset_library_id: string; major_version: number; minor_version: number;
      }>;

    assert.equal(dstChars.length, 1, "目标项目应恰有 1 行 character with this source_asset_id");
    const dst = dstChars[0];
    assert.equal(dst.source_asset_id, asset.id, "source_asset_id 必须 == 公共素材 id (血脉)");
    assert.equal(dst.asset_library_id, asset.id, "asset_library_id 也应指向 asset");
    assert.equal(dst.name, "血脉源角色", "name 应继承");
    assert.equal(dst.description, "for lineage test", "description 应继承");
    assert.deepEqual(JSON.parse(dst.tags), ["lineage"], "tags 应继承");
    assert.equal(dst.major_version, 1);
    assert.equal(dst.minor_version, 0);
    assert.notEqual(dst.id, charId, "新 character 应有新 id, 不能复用 source id");
  });

  it("exportToProject 是 importFromAsset 的别名 (内部) — 同等行为", () => {
    // 这一项是 sanity check, 保证 SDK 暴露的两个名字都好用
    const db = getDb();
    const srcProjectRow = db.prepare("SELECT * FROM projects WHERE slug = ?").get(SRC_SLUG) as { id: string };

    const charId = ulid();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO characters (id, project_id, name, description, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(charId, srcProjectRow.id, "测试别名", "alias check", JSON.stringify([]), now, now);

    const asset = importFromProject(SRC_SLUG, "character", charId);
    createdAssetIds.push(asset.id);

    const r1 = exportToProject(asset.id, DST_SLUG, "via exportToProject");
    assert.equal(r1.ok, true);
  });

  it("importFromProject: 缩略图存在时, 路径会被记录到 asset row", () => {
    const db = getDb();
    const srcProjectRow = db.prepare("SELECT * FROM projects WHERE slug = ?").get(SRC_SLUG) as { id: string };

    // 在 src 项目的目录里造一张假缩略图, 让 thumbnail_path 不为空
    const srcDir = projectDir(SRC_SLUG);
    fs.mkdirSync(path.join(srcDir, "fixtures"), { recursive: true });
    const thumbPath = path.join(srcDir, "fixtures", "thumb.png");
    fs.writeFileSync(thumbPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    const relThumb = path.relative(repoRoot, thumbPath).replace(/\\/g, "/");

    const charId = ulid();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO characters (id, project_id, name, description, tags, thumbnail_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(charId, srcProjectRow.id, "带缩略图", "thumb test", JSON.stringify([]), relThumb, now, now);

    const asset = importFromProject(SRC_SLUG, "character", charId);
    createdAssetIds.push(asset.id);
    assert.equal(asset.thumbnail_path, relThumb, "asset.thumbnail_path 必须等同源 character 的 thumbnail_path");

    // 用 importFromAsset 拷到目标项目, 验证缩略图被物理复制
    importFromAsset(asset.id, DST_SLUG);

    const dstProjectRow = db.prepare("SELECT * FROM projects WHERE slug = ?").get(DST_SLUG) as { id: string };
    const dstChar = db.prepare("SELECT * FROM characters WHERE project_id = ? AND source_asset_id = ?")
      .get(dstProjectRow.id, asset.id) as { thumbnail_path: string | null; id: string } | undefined;
    assert.ok(dstChar, "目标项目 character 应存在");
    assert.ok(dstChar!.thumbnail_path, "thumbnail_path 应被填充");

    // 物理文件应在目标项目目录下
    const absDest = path.join(repoRoot, dstChar!.thumbnail_path!);
    assert.ok(fs.existsSync(absDest), `缩略图文件应被复制到 ${absDest}`);
    assert.ok(
      absDest.includes(path.join("projects", DST_SLUG)),
      "复制目标必须在目标项目目录下",
    );
  });

  it("importFromProject: 抛 404 风格 error 如果资源不存在", () => {
    assert.throws(
      () => importFromProject(SRC_SLUG, "character", "nonexistent_id_xxx"),
      (err: any) => {
        return err instanceof Error && err.status === 404 && /不存在/.test(err.message);
      },
    );
  });

  it("importFromProject: 抛 400 风格 error 如果 assetType 不支持", () => {
    assert.throws(
      // @ts-expect-error 故意传非法 assetType
      () => importFromProject(SRC_SLUG, "unknown_type", "any"),
      (err: any) => err instanceof Error && err.status === 400,
    );
  });
});
