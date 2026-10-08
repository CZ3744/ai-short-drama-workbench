import { z } from "zod";

// --- Base option schema (all options share this) ---

export const PresetOptionSchema = z.object({
  id: z.string().min(1),
  label_zh: z.string().min(1),
  label_en: z.string().min(1),
  prompt_phrase: z.string(),
  enabled: z.boolean(),
  notes: z.string(),
  default: z.boolean(),
  /** Z9 (2026-05-21): provider 是否支持多张参考图同时传入 */
  supports_multi_reference: z.boolean().optional(),
  /** Z9 (2026-05-21): provider 约定超时 ms (默认不设 = 无本地 timeout, 铁律 #1) */
  default_timeout_ms: z.number().int().positive().optional(),
  extras: z.record(z.string(), z.any()).optional(),
}).passthrough();

// --- Dictionary schema ---

export const PresetDictSchema = z.object({
  id: z.string().min(1),
  options: z.array(PresetOptionSchema).min(1),
});

// --- Type exports ---

export type PresetOption = z.infer<typeof PresetOptionSchema>;
export type PresetDict = z.infer<typeof PresetDictSchema>;
