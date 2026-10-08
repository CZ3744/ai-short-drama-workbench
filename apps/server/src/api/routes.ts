/**
 * API Routes — Main Assembly Entry Point
 *
 * Route modules:
 *  - settingsRoutes: Health, Settings, Secrets, TTS, MiMo config/tests
 *  - toolsRoutes: Tool Registry, Provider Capabilities
 *  - chatgptOauthRoutes: ChatGPT OAuth (Codex gpt-image-2)
 *
 * 2026-05-26 audit #7:
 *  - 删除 ./routes/jobsRoutes (v1 Job CRUD / Scene CRUD / Approval / Project Bible 全部 1365 行)
 *    + ../../jobs/runner.ts (1072) + ../../jobs/qa.ts (498) + ../../jobs/agents/ (4 文件 201 行).
 *    前端 lib/jobsApi.ts 仅 getRealVideoLockStatus 真活用, 已迁到 settingsApi.
 *  - 删除 (2026-05-21):
 *    - imageRoutes (v1 legacy generate-image / image-versions / activate)
 *      → v2 /api/v2/images/generate + imageGenerationService
 *    - clipRoutes (v1 legacy generate-clip / clip-versions / retry / real-video/dry-run)
 *      → v2 /api/v2/shots/:sid/video/generate + videoGenerationService
 *    - 仅保留 /api/real-video/lock-status (前端 SettingsPage / CockpitPage 仍调用)
 *
 * Remaining in this file:
 *  - /api/real-video/lock-status                       ✅ 真活 (SettingsPage / CockpitPage)
 *  - T13 Projects API (CRUD, storage, backup, export/import) ✅ 真活 (storageApi / SettingsPage)
 *  - T06 Characters (deprecated 410 → v2)             ⚠️ HTTP 410, SQLite 旧 schema 保留
 *  - T07 Dependency Graph (dependency-graph/dependencies/mark-dirty) ⚠️ 2026-05-28 audit P2: 0 caller, 后续 wave 可整段删
 *  - T10 Subtitle Lab (subtitle-lab/templates 等)     ⚠️ 2026-05-28 audit P2: 0 caller, 后续 wave 可整段删
 *  - T08 Task Queue (/queue/*)                        ⚠️ 2026-05-28 audit P2: 0 caller, 后续 wave 可整段删
 *  - T15 Reference Resolver + Voice Resolution        ⚠️ 2026-05-28 audit P2: 0 caller (前端 2026-05-27 已迁), 后续 wave 可整段删
 *  - T14 Public Asset Library (/assets/*)             ✅ 真活 (libraryApi import/export-to-project)
 *  - Document Parsing (parse, parse-text)             ✅ 真活
 *  - Topic-to-Video (brief, expand-script)            ✅ 真活 (StudioHome 起点)
 *  - Video Cost Estimate                              ✅ 真活
 *
 * 2026-05-28 audit P2 死代码标注: 4 块 (T07 / T08 / T10 / T15 voice-resolution) 已 0 caller,
 * 留作下一波 audit wave 物理删除 — 此 wave 仅做严格文档对齐, 不动核心代码逻辑.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import {
  JobLogger,
  outputsRoot,
  pathExists,
  readJson,
  writeJson,
  isRealVideoLocked,
  getRealVideoLockHolder
} from "../../../../packages/core/src/index";
import {
  loadLlmConfig,
  MockLlmProvider,
  OpenAiCompatibleProvider,
  loadPrompt,
  fillTemplate
} from "../../../../packages/providers/src/index";
import { parseMultipleDocuments, saveDocumentParseResult, type DocumentInput } from "../../../../packages/document/src/index";

// Import route modules
import { settingsRouter } from "./routes/settingsRoutes";
import { toolsRouter } from "./routes/toolsRoutes";
import { chatgptOauthRouter } from "./routes/chatgptOauthRoutes";

// v0.2.4: MIME whitelist + filename sanitization on uploads.
const DOC_MIME_WHITELIST = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "text/plain",
  "text/markdown",
  "application/octet-stream" // many browsers send .md as octet-stream
]);
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const byExt = /\.(pdf|docx?|txt|md)$/i.test(file.originalname);
    if (DOC_MIME_WHITELIST.has(file.mimetype) || byExt) cb(null, true);
    else cb(new Error(`Unsupported document type: ${file.mimetype} (${file.originalname})`));
  }
});
const archiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const byExt = /\.(zip|vgproj)$/i.test(file.originalname);
    if (byExt || file.mimetype === "application/zip" || file.mimetype === "application/x-zip-compressed") cb(null, true);
    else cb(new Error(`Unsupported archive type: ${file.mimetype} (${file.originalname})`));
  }
});
export const router = express.Router();

// Mount route modules
router.use(settingsRouter);
router.use(toolsRouter);
router.use(chatgptOauthRouter);

// ====================================================================
// /api/real-video/lock-status — 真实视频生成全局锁状态
// (前端 SettingsPage / CockpitPage 仍调用,从已删除的 clipRoutes.ts 迁出)
// ====================================================================
router.get("/real-video/lock-status", (_req, res) => {
  res.json({
    locked: isRealVideoLocked(),
    holder: getRealVideoLockHolder()
  });
});

// ====================================================================
// T13: PROJECTS API — Multi-project data model
// ====================================================================

import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  deleteProjectCascade,
  summarizeProjectDeletion,
  ensureDefaultProject,
} from "../../../../packages/core/src/db/projects";
import {
  getStorageUsage,
  cleanupStorage,
  createBackupArchive,
  restoreBackupArchive,
  createProjectExportArchive,
  importProjectArchive,
} from "./dataManagement";
import { setLastBackupStatus } from "./backupStatus";

router.get("/projects", async (_req, res, next) => {
  try {
    ensureDefaultProject();
    res.json({ projects: listProjects() });
  } catch (error) { next(error); }
});

router.post("/projects", express.json(), async (req, res, next) => {
  try {
    const { slug, title, description } = req.body;
    if (!slug || !title) {
      res.status(400).json({ error: { code: "ValidationError", message: "slug 和 title 字段是必填项" } });
      return;
    }
    if (!/^[a-z0-9_-]+$/.test(slug)) {
      res.status(400).json({ error: { code: "ValidationError", message: "slug 只能包含小写字母、数字、下划线和连字符" } });
      return;
    }
    if (getProject(slug)) {
      res.status(409).json({ error: { code: "Conflict", message: `项目 "${slug}" 已存在` } });
      return;
    }
    const project = createProject({ slug, title, description });
    res.status(201).json({ project });
  } catch (error) { next(error); }
});

router.get("/projects/:slug", async (req, res, next) => {
  try {
    const project = getProject(req.params.slug);
    if (!project) {
      res.status(404).json({ error: { code: "NotFound", message: "项目不存在" } });
      return;
    }
    res.json({ project });
  } catch (error) { next(error); }
});

router.patch("/projects/:slug", express.json(), async (req, res, next) => {
  try {
    const { title, description, aspect_ratio, resolution, default_style } = req.body;
    const project = updateProject(req.params.slug, { title, description, aspect_ratio, resolution, default_style });
    if (!project) {
      res.status(404).json({ error: { code: "NotFound", message: "项目不存在" } });
      return;
    }
    res.json({ project });
  } catch (error) { next(error); }
});

router.get("/projects/:slug/delete-summary", async (req, res, next) => {
  try {
    const summary = await summarizeProjectDeletion(req.params.slug);
    res.json({ summary });
  } catch (error) { next(error); }
});

router.delete("/projects/:slug", async (req, res, next) => {
  try {
    const result = await deleteProjectCascade(req.params.slug);
    res.json({ ok: true, summary: result.summary, message: `项目 "${req.params.slug}" 已删除` });
  } catch (error) { next(error); }
});

router.get("/storage/usage", async (_req, res, next) => {
  try {
    res.json({ usage: await getStorageUsage() });
  } catch (error) { next(error); }
});

router.post("/storage/cleanup", async (_req, res, next) => {
  try {
    res.json({ ok: true, report: await cleanupStorage() });
  } catch (error) { next(error); }
});

router.post("/backup/create", async (_req, res, next) => {
  try {
    const backup = await createBackupArchive();
    // 2026-07-22 U-fix1: 手动备份成功也同步 healthz 的 last_backup, 否则 /healthz 只反映启动/cron 那次,
    // 与用户刚刚手动产出的真备份脱节 (EVIDENCE-api 项 6 尾注)。
    setLastBackupStatus({ ok: true, at: new Date().toISOString(), filename: backup.filename, error: null });
    res.json({ ok: true, backup });
  } catch (error) { next(error); }
});

router.post("/backup/restore", express.json({ limit: "2mb" }), async (req, res, next) => {
  try {
    const backupPath = typeof req.body?.backup_path === "string" ? req.body.backup_path : typeof req.body?.path === "string" ? req.body.path : "";
    if (!backupPath) {
      res.status(400).json({ error: { code: "ValidationError", message: "backup_path 是必填项" } });
      return;
    }
    const result = await restoreBackupArchive(backupPath);
    res.json({ ok: true, ...result });
  } catch (error) { next(error); }
});

router.get("/projects/:slug/export", async (req, res, next) => {
  try {
    const archive = await createProjectExportArchive(req.params.slug);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${archive.filename}"`);
    res.download(archive.path, archive.filename, async (err) => {
      try {
        await fs.rm(archive.path, { force: true });
      } catch {
        // best effort
      }
      if (err) next(err);
    });
  } catch (error) { next(error); }
});

router.post("/projects/import", archiveUpload.single("file"), async (req, res, next) => {
  try {
    const archivePath = typeof req.body?.archive_path === "string" ? req.body.archive_path : undefined;
    let tempPath: string | null = null;
    let sourcePath = archivePath?.trim();
    if (!sourcePath && req.file?.buffer) {
      tempPath = path.join(os.tmpdir(), `vgproj-${crypto.randomUUID()}.vgproj`);
      await fs.writeFile(tempPath, req.file.buffer);
      sourcePath = tempPath;
    }
    if (!sourcePath) {
      res.status(400).json({ error: { code: "ValidationError", message: "需要上传 .vgproj 文件或提供 archive_path" } });
      return;
    }
    const result = await importProjectArchive(sourcePath);
    if (tempPath) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
    res.status(201).json({ ok: true, ...result, message: `已导入项目 ${result.project.slug}` });
  } catch (error) { next(error); }
});

// ====================================================================
// T06: CHARACTERS API — 角色管理（含音色档案）
// ====================================================================
// A-1 (2026-05-12): 双轨 CRUD 收敛 — 之前 /api/projects/:slug/characters 写 SQLite,
// /api/v2/series/:slug/characters 写 seriesStore JSON, 同一个概念两套存储任一处更新
// 另一处看不到. 前端 useCharacters.ts 已只调 v2; 这里把 SQLite 那套全部返回 HTTP 410
// Gone + 指引 header, 任何旧脚本误用都会立即报错而不是静默写到看不见的表.
// 旧 SQLite 表 `characters` 保留, 不动 schema (担心其他模块 SELECT). 仅关闭 HTTP 入口.


function sendCharactersGone(_req: any, res: any) {
  res.setHeader("X-Replacement-Path", "/api/v2/series/:slug/characters");
  res.status(410).json({
    error: {
      code: "Gone",
      message: "此端点已废弃: /api/projects/:slug/characters → 请改用 /api/v2/series/:slug/characters (v2 seriesStore). 双轨写入会导致数据腐烂.",
    },
  });
}

router.get("/projects/:slug/characters", (req, res) => sendCharactersGone(req, res));
router.post("/projects/:slug/characters", express.json(), (req, res) => sendCharactersGone(req, res));
router.get("/projects/:slug/characters/:charId", (req, res) => sendCharactersGone(req, res));
router.patch("/projects/:slug/characters/:charId", express.json(), (req, res) => sendCharactersGone(req, res));
router.delete("/projects/:slug/characters/:charId", (req, res) => sendCharactersGone(req, res));


// ====================================================================
// T14: PUBLIC ASSET LIBRARY — Cross-project asset sharing
// ====================================================================

import {
  createAsset,
  getAsset,
  listAssets,
  updateAsset,
  deleteAsset,
  importFromProject,
  exportToProject,
  ASSET_TYPES,
  type AssetType,
} from "../../../../packages/core/src/db/assets";

const VALID_ASSET_TYPES: ReadonlySet<string> = new Set(ASSET_TYPES);

// GET /api/assets — list all assets with optional filters
router.get("/assets", async (req, res, next) => {
  try {
    const typeParam = typeof req.query.type === "string" ? req.query.type : undefined;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const tagsParam = typeof req.query.tags === "string" ? req.query.tags : undefined;

    if (typeParam && !VALID_ASSET_TYPES.has(typeParam)) {
      res.status(400).json({
        error: { code: "ValidationError", message: `type 必须是: ${ASSET_TYPES.join(", ")}` },
      });
      return;
    }

    const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const assets = listAssets(typeParam as AssetType | undefined, search, tags);
    res.json({ assets });
  } catch (error) {
    next(error);
  }
});

// POST /api/assets — create a new asset from scratch
router.post("/assets", express.json(), async (req, res, next) => {
  try {
    const { asset_type, name, description, tags, thumbnail_path } = req.body;
    if (!asset_type || !VALID_ASSET_TYPES.has(asset_type)) {
      res.status(400).json({
        error: { code: "ValidationError", message: `asset_type 是必填项，必须是: ${ASSET_TYPES.join(", ")}` },
      });
      return;
    }
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: { code: "ValidationError", message: "name 是必填项" } });
      return;
    }
    if (tags !== undefined && !Array.isArray(tags)) {
      res.status(400).json({ error: { code: "ValidationError", message: "tags 必须是字符串数组" } });
      return;
    }
    const asset = createAsset({
      asset_type: asset_type as AssetType,
      name: name.trim(),
      description: typeof description === "string" ? description : undefined,
      tags: Array.isArray(tags) ? tags.map(String) : undefined,
      thumbnail_path: typeof thumbnail_path === "string" ? thumbnail_path : undefined,
    });
    res.status(201).json({ asset });
  } catch (error) {
    next(error);
  }
});

// POST /api/assets/import-from-project — deep-copy project resource into public library
// (defined BEFORE /:id routes so Express won't match "import-from-project" as an id param)
router.post("/assets/import-from-project", express.json(), async (req, res, next) => {
  try {
    const { projectSlug, assetType, resourceId, newName } = req.body;
    if (!projectSlug || typeof projectSlug !== "string") {
      res.status(400).json({ error: { code: "ValidationError", message: "projectSlug 是必填项" } });
      return;
    }
    if (!assetType || !VALID_ASSET_TYPES.has(assetType)) {
      res.status(400).json({
        error: { code: "ValidationError", message: `assetType 是必填项，必须是: ${ASSET_TYPES.join(", ")}` },
      });
      return;
    }
    if (!resourceId || typeof resourceId !== "string") {
      res.status(400).json({ error: { code: "ValidationError", message: "resourceId 是必填项" } });
      return;
    }
    const asset = importFromProject(projectSlug.trim(), assetType as AssetType, resourceId.trim(), typeof newName === "string" ? newName.trim() : undefined);
    res.status(201).json({ ok: true, asset, message: "已导入公共素材库" });
  } catch (error) {
    next(error);
  }
});

// POST /api/assets/export-to-project — copy public asset to target project tables
router.post("/assets/export-to-project", express.json(), async (req, res, next) => {
  try {
    const { assetId, targetProjectSlug, newName } = req.body;
    if (!assetId || typeof assetId !== "string") {
      res.status(400).json({ error: { code: "ValidationError", message: "assetId 是必填项" } });
      return;
    }
    if (!targetProjectSlug || typeof targetProjectSlug !== "string") {
      res.status(400).json({ error: { code: "ValidationError", message: "targetProjectSlug 是必填项" } });
      return;
    }
    const result = exportToProject(assetId.trim(), targetProjectSlug.trim(), typeof newName === "string" ? newName.trim() : undefined);
    res.json({ ok: result.ok, message: "已导出到目标项目" });
  } catch (error) {
    next(error);
  }
});

// GET /api/assets/:id — get single asset
router.get("/assets/:id", async (req, res, next) => {
  try {
    const asset = getAsset(req.params.id);
    if (!asset) {
      res.status(404).json({ error: { code: "NotFound", message: "素材不存在" } });
      return;
    }
    res.json({ asset });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/assets/:id — update asset metadata
router.patch("/assets/:id", express.json(), async (req, res, next) => {
  try {
    const { name, description, tags, thumbnail_path } = req.body;
    if (tags !== undefined && !Array.isArray(tags)) {
      res.status(400).json({ error: { code: "ValidationError", message: "tags 必须是字符串数组" } });
      return;
    }
    const asset = updateAsset(req.params.id, {
      name: typeof name === "string" ? name.trim() : undefined,
      description: typeof description === "string" ? description : undefined,
      tags: Array.isArray(tags) ? tags.map(String) : undefined,
      thumbnail_path: thumbnail_path !== undefined ? (typeof thumbnail_path === "string" ? thumbnail_path : null) : undefined,
    });
    if (!asset) {
      res.status(404).json({ error: { code: "NotFound", message: "素材不存在" } });
      return;
    }
    res.json({ asset });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/assets/:id — delete asset
router.delete("/assets/:id", async (req, res, next) => {
  try {
    const ok = deleteAsset(req.params.id);
    if (!ok) {
      res.status(404).json({ error: { code: "NotFound", message: "素材不存在" } });
      return;
    }
    res.json({ ok: true, message: "素材已删除" });
  } catch (error) {
    next(error);
  }
});


// ====================================================================
// DOCUMENT PARSING
// ====================================================================

router.post("/documents/parse", docUpload.array("files", 10), async (req, res, next) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: { code: "ValidationError", message: "请上传至少一个文件" } });
      return;
    }

    const inputs: DocumentInput[] = files.map((file) => ({
      filename: file.originalname,
      buffer: file.buffer,
      mimeType: file.mimetype
    }));

    const result = await parseMultipleDocuments(inputs);

    const docJobId = `doc_${Date.now()}`;
    const outputDir = path.join(outputsRoot, "document_inputs", docJobId);
    const saved = await saveDocumentParseResult(result, outputDir);

    const docsWithPreview = result.documents.map((doc: any) => ({
      id: doc.id,
      name: doc.name,
      type: doc.type,
      status: doc.status,
      wordCount: doc.wordCount,
      warnings: doc.warnings,
      preview: doc.extractedText.slice(0, 500)
    }));

    res.json({
      success: result.success,
      jobId: docJobId,
      documents: docsWithPreview,
      totalWordCount: result.totalWordCount,
      mergedText: result.mergedText || "",
      mergedTextPath: saved.mergedTextPath,
      errors: result.errors
    });
  } catch (error) {
    next(error);
  }
});

router.post("/documents/parse-text", express.json({ limit: "5mb" }), async (req, res, next) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) {
      res.status(400).json({ error: { code: "ValidationError", message: "text 是必填字段" } });
      return;
    }
    const filename = String(req.body.filename || "pasted_text.md");

    const input: DocumentInput = {
      filename,
      buffer: Buffer.from(text, "utf8")
    };

    const result = await parseMultipleDocuments([input]);

    const docJobId = `doc_${Date.now()}`;
    const outputDir = path.join(outputsRoot, "document_inputs", docJobId);
    const saved = await saveDocumentParseResult(result, outputDir);

    const docsWithPreview = result.documents.map((doc: any) => ({
      id: doc.id,
      name: doc.name,
      type: doc.type,
      status: doc.status,
      wordCount: doc.wordCount,
      warnings: doc.warnings,
      preview: doc.extractedText.slice(0, 500)
    }));

    res.json({
      success: result.success,
      jobId: docJobId,
      documents: docsWithPreview,
      totalWordCount: result.totalWordCount,
      mergedText: result.mergedText || "",
      mergedTextPath: saved.mergedTextPath,
      errors: result.errors
    });
  } catch (error) {
    next(error);
  }
});

// ====================================================================
// TOPIC-TO-VIDEO
// ====================================================================

router.post("/projects/brief", express.json(), async (req, res, next) => {
  try {
    const topic = String(req.body.topic || "").trim();
    if (!topic) { res.status(400).json({ error: { code: "ValidationError", message: "topic 是必填字段" } }); return; }
    const platform = String(req.body.platform || "bilibili");
    const style = String(req.body.style || req.body.videoStyle || "knowledge_card");
    const durationTarget = Number(req.body.duration_target_sec) || 180;
    const audience = String(req.body.audience || "B站普通观众");
    const visualStrategy = String(req.body.visualStrategy || "自动");
    const generationMode = String(req.body.generationMode || "auto");
    const aspectRatio = String(req.body.aspectRatio || "16:9");

    const prompt = await loadPrompt("project_brief_builder.md");
    const filled = fillTemplate(prompt, {
      TOPIC: topic,
      PLATFORM: platform,
      STYLE: style,
      DURATION_TARGET: String(durationTarget),
      AUDIENCE: audience,
      VISUAL_STRATEGY: visualStrategy,
      GENERATION_MODE: generationMode,
      ASPECT_RATIO: aspectRatio
    });

    const config = loadLlmConfig();
    const logger = new JobLogger(path.join(outputsRoot, "logs"));
    const provider = config.mock ? new MockLlmProvider(config, logger) : new OpenAiCompatibleProvider(config, logger);

    const result = await provider.callJson<any>({
      agentName: "Project Brief Builder",
      promptFile: "project_brief_builder.md",
      inputSummary: topic.slice(0, 200),
      system: "你是一个视频项目策划专家。返回严格 JSON。",
      user: filled
    });

    res.json({ ok: true, brief: result });
  } catch (error) {
    next(error);
  }
});

router.post("/projects/expand-script", express.json(), async (req, res, next) => {
  try {
    const brief = req.body.brief;
    if (!brief) { res.status(400).json({ error: { code: "ValidationError", message: "brief 是必填字段" } }); return; }

    const prompt = await loadPrompt("script_expander.md");
    const filled = fillTemplate(prompt, {
      PROJECT_BRIEF_JSON: JSON.stringify(brief, null, 2),
      DURATION_TARGET: String(brief.duration_target_sec || 180)
    });

    const config = loadLlmConfig();
    const logger = new JobLogger(path.join(outputsRoot, "logs"));
    const provider = config.mock ? new MockLlmProvider(config, logger) : new OpenAiCompatibleProvider(config, logger);

    const result = await provider.callJson<any>({
      agentName: "Script Expander",
      promptFile: "script_expander.md",
      inputSummary: brief.topic?.slice(0, 200) || "topic",
      system: "你是一个专业的视频编剧。返回严格 JSON。",
      user: filled
    });

    res.json({ ok: true, script: result });
  } catch (error) {
    next(error);
  }
});



// ====================================================================
// COST ESTIMATE — 成本估算
// ====================================================================

router.post("/video/cost-estimate", express.json(), async (req, res) => {
  try {
    const { estimateVideoCost, formatCostDisplay } = await import("../../../../packages/core/src/videoCostEstimate");
    const { provider, model, resolution_tier, duration } = req.body;
    // W7 (2026-05-15) — Bug 1: 不再 silent fallback 到 local_mock_video。
    // 没传 provider 时返回 "未知" 而非按 mock 给免费假预估。
    if (typeof provider !== "string" || !provider.trim()) {
      res.json({ found: false, estimated_cny: null, currency: "CNY", note: "请先选择视频模型", display: "预计成本:未选择模型" });
      return;
    }
    const result = estimateVideoCost({ provider: provider.trim(), model: model || "", resolution_tier, duration });
    res.json({ ...result, display: formatCostDisplay(result) });
  } catch (error) {
    res.json({ found: false, estimated_cny: null, currency: "CNY", note: "估算失败", display: "预计成本：未知" });
  }
});


