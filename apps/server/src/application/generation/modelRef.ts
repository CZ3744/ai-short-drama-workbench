/**
 * model_ref contract: "<provider_or_instance_id>:<model>".
 *
 * Old callers may still pass a plain provider id. Backends that only need the
 * provider instance should depend on this helper instead of splitting inline.
 */
export function providerIdFromModelRef(ref: unknown): string | undefined {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return undefined;
  const idx = trimmed.indexOf(":");
  const providerId = idx >= 0 ? trimmed.slice(0, idx) : trimmed;
  return providerId.trim() || undefined;
}

/**
 * 2026-05-27 — 视频 model_ref instance id 提取器.
 *
 * ModelPicker 视频路径用 3 段 colon: "instance:<vmi_id>:<model_override>".
 * 取第 2 段 (vmi_id), 让 caller 通过 getVideoModelInstance(vmi_id) 拿 channel
 * 再 map 成真 provider_id.
 *
 * 非 instance 格式返回 null, caller 走 providerIdFromModelRef 老路径.
 */
export function videoInstanceIdFromModelRef(ref: unknown): string | null {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return null;
  const firstColon = trimmed.indexOf(":");
  if (firstColon < 0) return null;
  if (trimmed.slice(0, firstColon) !== "instance") return null;

  const rest = trimmed.slice(firstColon + 1);
  const colonIdx2 = rest.indexOf(":");
  const instanceId = (colonIdx2 >= 0 ? rest.slice(0, colonIdx2) : rest).trim();
  return instanceId || null;
}

/**
 * Extract the model id (colon-suffix) from a model_ref.
 *
 * Examples:
 *   "chatgpt_codex_image:gpt-image-2"  → "gpt-image-2"
 *   "openrouter_image:google/gemini-2.5-flash-image" → "google/gemini-2.5-flash-image"
 *   "local_card_image"                  → undefined  (no colon, no model id)
 *   ""                                  → undefined
 *
 * Adapters use this to override their default `cfg.model_id` based on the
 * ModelPicker selection. See packages/providers/src/core/types.ts → request.model_id.
 */
export function modelIdFromModelRef(ref: unknown): string | undefined {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return undefined;
  const idx = trimmed.indexOf(":");
  if (idx < 0) return undefined;
  const modelId = trimmed.slice(idx + 1).trim();
  return modelId || undefined;
}
