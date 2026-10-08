/**
 * v2 Orchestration — memory / preference / feedback routes
 *
 * Step 3a batch 1 extraction — verbatim from orchestrationController.ts.
 * Handlers:
 *   POST   /memory/record-action
 *   GET    /memory/profile/:stage
 *   DELETE /memory/clear
 *   POST   /series/:slug/feedback
 *   GET    /series/:slug/preferences
 *   GET    /preferences/projects
 *   POST   /series/:slug/script-edit
 *   POST   /series/:targetSlug/copy-preferences
 */

import { Router, type Response } from "express";
import {
  clearMemory,
  copyPreferences,
  getMemoryProfile,
  getSeriesPreferences,
  listPreferenceProjects,
  recordMemoryAction,
  recordScriptEdit,
  recordSeriesFeedback,
  type MemoryUseCaseResult,
} from "../../../application/memory/memoryUseCases";

export const memoryRouter = Router();

function sendMemoryResult(res: Response, result: MemoryUseCaseResult): void {
  if (result.kind === "validationBare") {
    res.status(result.status).json({ errors: result.errors });
    return;
  }
  if (result.kind === "error") {
    res.status(result.status).json(result.body);
    return;
  }
  res.json(result.body);
}

// ═══════════════════════════════════════════════════════════════════
// B4: Memory / Preference API Endpoints
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /memory/record-action
 * Record a user action on an LLM output (redo / manual_edit / reject).
 * Body: { stage, input_text, output_text, action }
 */
memoryRouter.post("/memory/record-action", async (req, res, next) => {
  try {
    sendMemoryResult(res, await recordMemoryAction(req.body));
  } catch (err) { next(err); }
});

/**
 * GET /memory/profile/:stage
 * Get the stored user preference profile for a stage.
 */
memoryRouter.get("/memory/profile/:stage", async (req, res, next) => {
  try {
    sendMemoryResult(res, await getMemoryProfile(req.params.stage));
  } catch (err) { next(err); }
});

/**
 * DELETE /memory/clear
 * Clear all learning data (events + profiles). Privacy button.
 */
memoryRouter.delete("/memory/clear", async (_req, res, next) => {
  try {
    sendMemoryResult(res, await clearMemory());
  } catch (err) { next(err); }
});

// ─── B5: Feedback & Preferences endpoints ──────────────────────────

/**
 * POST /series/:slug/feedback
 * Record a micro-feedback event from the shot feedback toast.
 */
memoryRouter.post("/series/:slug/feedback", async (req, res, next) => {
  try {
    sendMemoryResult(res, await recordSeriesFeedback(req.params.slug, req.body));
  } catch (err) { next(err); }
});

/**
 * GET /series/:slug/preferences
 * Load the project_preferences.json for a series (if it exists).
 */
memoryRouter.get("/series/:slug/preferences", async (req, res, next) => {
  try {
    sendMemoryResult(res, await getSeriesPreferences(req.params.slug));
  } catch (err) { next(err); }
});

/**
 * GET /preferences/projects
 * List all series that have project_preferences.json (for the "reuse preferences" dialog).
 */
memoryRouter.get("/preferences/projects", async (_req, res, next) => {
  try {
    sendMemoryResult(res, await listPreferenceProjects());
  } catch (err) { next(err); }
});

/**
 * POST /series/:slug/script-edit
 * Record a script edit event with diff summary (B5: 偏好档案闭环).
 * Called by frontend when user saves/edits the script.
 */
memoryRouter.post("/series/:slug/script-edit", async (req, res, next) => {
  try {
    sendMemoryResult(res, await recordScriptEdit(req.params.slug, req.body));
  } catch (err) { next(err); }
});

/**
 * POST /series/:targetSlug/copy-preferences
 * Copy project_preferences.json from an existing series to a new one (B5: 偏好复用).
 */
memoryRouter.post("/series/:targetSlug/copy-preferences", async (req, res, next) => {
  try {
    sendMemoryResult(res, await copyPreferences(req.params.targetSlug, req.body));
  } catch (err) { next(err); }
});
