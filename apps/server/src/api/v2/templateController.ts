/**
 * v2 Template Controller — CRUD for user-saved + built-in templates
 */

import { Router } from "express";
import { handleValidationError } from "./validateHelpers";
import {
  listTemplates, createTemplate, deleteTemplate, applyTemplate,
  listBuiltinTemplates, loadBuiltinTemplate, applyTemplateSkeleton, saveSeriesAsTemplate,
} from "./seriesStore";
import { validate, CreateTemplateSchema, ApplyTemplateSchema } from "./validators";

export const templateRouter = Router();

// GET /templates → returns both user-saved and built-in templates
templateRouter.get("/templates", async (_req, res, next) => {
  try {
    const [userTemplates, builtinTemplates] = await Promise.all([
      listTemplates(),
      listBuiltinTemplates(),
    ]);
    res.json({
      templates: userTemplates,
      builtin_templates: builtinTemplates,
    });
  } catch (err) { next(err); }
});

// GET /templates/:id → get a single template (check built-in first, then user)
templateRouter.get("/templates/:id", async (req, res, next) => {
  try {
    // Try built-in first
    const builtin = await loadBuiltinTemplate(req.params.id);
    if (builtin) {
      res.json({ template: builtin, source: "builtin" });
      return;
    }
    // Then user templates
    const userTemplates = await listTemplates();
    const userTmpl = userTemplates.find(t => t.id === req.params.id);
    if (userTmpl) {
      res.json({ template: userTmpl, source: "user" });
      return;
    }
    res.status(404).json({ error: { code: "NotFound", message: "模板不存在" } });
  } catch (err) { next(err); }
});

// POST /templates
templateRouter.post("/templates", async (req, res, next) => {
  try {
    const v = validate(CreateTemplateSchema, req.body);
    if (handleValidationError(res, v)) return;
    const template = await createTemplate(v.data);
    res.status(201).json({ template });
  } catch (err) { next(err); }
});

// DELETE /templates/:id
templateRouter.delete("/templates/:id", async (req, res, next) => {
  try {
    const ok = await deleteTemplate(req.params.id);
    if (!ok) { res.status(404).json({ error: { code: "NotFound", message: "模板不存在" } }); return; }
    res.json({ ok: true, message: "模板已删除" });
  } catch (err) { next(err); }
});

// POST /templates/:id/apply (legacy, applies defaults only)
templateRouter.post("/templates/:id/apply", async (req, res, next) => {
  try {
    const v = validate(ApplyTemplateSchema, req.body);
    if (handleValidationError(res, v)) return;
    const series = await applyTemplate(req.params.id, v.data.target_series_slug);
    if (!series) { res.status(404).json({ error: { code: "NotFound", message: "模板不存在" } }); return; }
    res.json({ ok: true, series });
  } catch (err) { next(err); }
});

// POST /templates/from-series/:slug → save current series as a custom built-in template
templateRouter.post("/templates/from-series/:slug", async (req, res, next) => {
  try {
    const builtin = await saveSeriesAsTemplate(req.params.slug);
    res.status(201).json({ template: builtin });
  } catch (err) { next(err); }
});
