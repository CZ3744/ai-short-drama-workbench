// lastUsedModel — 用户上次在该 modality 选了哪个 model_ref.
//
// 用途: 仅作为"新建业务实体的默认值"建议. 不强制写实体, 不污染 fallback 链.
//   - 创建新 Shot / Episode / Generation 时, 父调用方可以 getLastUsedModel(kind) 拿建议
//   - ModelPicker.onChange 主动 rememberLastUsed, 调用方不用关心
//   - 用户切换实例没问题, 旧实体的 model_ref 不动 (它存在自己 row 上)
//
// 红线: 不做 fallback 链路由, 不参与生成时的真实模型选择. 仅 UX 建议.

import { createLastUsedByKey } from "./lastUsedRegistry";

type Kind = "text" | "image" | "video" | "tts";

const VALID_KINDS = ["text", "image", "video", "tts"] as const satisfies readonly Kind[];

export function isKind(k: string): k is Kind {
  return (VALID_KINDS as readonly string[]).includes(k);
}

const registry = createLastUsedByKey<Kind, string>({
  keyPrefix: "lastUsedModel.",
  validKeys: VALID_KINDS,
});

export function rememberLastUsed(kind: Kind, model_ref: string): void {
  if (!isKind(kind)) return;
  if (!model_ref) return;
  registry.set(kind, model_ref);
}

export function getLastUsedModel(kind: Kind): string | null {
  if (!isKind(kind)) return null;
  return registry.get(kind);
}

/** 清除某个 modality 的记忆 (例如用户在设置里删了对应的 instance). 可选用. */
export function clearLastUsedModel(kind: Kind): void {
  registry.clear(kind);
}
