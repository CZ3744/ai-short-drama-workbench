/**
 * v2 Orchestration — TTS routes
 *
 * Handlers:
 *   POST /tts/test    — 老接口,生成测试音频 (兼容)
 *   POST /tts/preview — 2026-05-17 voice-sync v1: ElementWorkbench 试听用 (testTts alias)
 *   GET  /tts/voices  — 2026-05-17 voice-sync v1: 列出可用声线 (按 provider 过滤)
 */

import { Router } from "express";

import { testTts } from "../../../application/tts/testTts";
import { listTtsVoices } from "../../../application/tts/listVoices";

export const ttsRouter = Router();

// ═══════════════════════════════════════════════════════════════════
// GET /tts/voices — 列出可用声线 (按 provider_id 可选过滤)
//   ?provider_id=edge_tts  → 只返 edge_tts 的声线 + 该 provider listVoices() 动态列表
//   (无参) → 全部 enabled 的 preset 声线
//
// 返回:
//   {
//     voices: TtsVoiceListed[],   // id + voice_id + provider_id + label_zh + gender + style ...
//     provider_label: string,     // 当指定 provider_id 时该 provider 的中文名
//     providers: Array<{ id, label_zh, requires_key }>, // 全部 enabled provider 简表
//   }
// ═══════════════════════════════════════════════════════════════════

ttsRouter.get("/tts/voices", async (req, res, next) => {
  try {
    const providerId = typeof req.query.provider_id === "string" && req.query.provider_id
      ? req.query.provider_id
      : undefined;
    const result = await listTtsVoices(providerId);
    res.json(result);
  } catch (err: unknown) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// POST /tts/test — voice test: generate a short audio clip (兼容老接口)
// POST /tts/preview — alias, 主文档 2026-05-17 voice-sync v1 命名
//
// body: { voice_id: string, text: string, provider_id?: string }
// 返回: audio buffer (Content-Type: audio/mpeg | audio/mp4)
// ═══════════════════════════════════════════════════════════════════

async function handleTtsSynth(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  try {
    const result = await testTts({ body: req.body });

    if (result.kind === "validation") {
      res.status(result.status).json({ errors: result.errors });
      return;
    }
    if (result.kind === "error") {
      res.status(result.status).json(result.body);
      return;
    }

    res.set("Content-Type", result.mime);
    res.set("Content-Length", String(result.buffer.length));
    res.send(result.buffer);
  } catch (err: unknown) {
    next(err);
  }
}

ttsRouter.post("/tts/test", handleTtsSynth);
ttsRouter.post("/tts/preview", handleTtsSynth);
