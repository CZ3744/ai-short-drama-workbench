/**
 * v2 Preset Controller — List preset dictionaries and individual presets
 */

import { Router } from "express";
import { listDictIds, listPresets, getPreset } from "../../../../../packages/core/src/presets";

export const presetRouter = Router();

// GET /presets — return all dictionaries
presetRouter.get("/presets", async (_req, res, next) => {
  try {
    const dictIds = listDictIds();
    const dicts: Record<string, any> = {};
    for (const id of dictIds) {
      dicts[id] = listPresets(id);
    }
    res.json({ presets: dicts });
  } catch (err) { next(err); }
});

// GET /presets/:dictId
presetRouter.get("/presets/:dictId", async (req, res, next) => {
  try {
    const options = listPresets(req.params.dictId);
    if (options.length === 0) {
      res.status(404).json({ error: { code: "NotFound", message: `字典 "${req.params.dictId}" 不存在` } });
      return;
    }
    res.json({ dict_id: req.params.dictId, options });
  } catch (err) { next(err); }
});
