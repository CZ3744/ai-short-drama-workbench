/** 显式注入测试专用 provider；不设置 Key、不回退真实模型、不发送网络请求。 */
import crypto from "node:crypto";
import { getRegistry } from "../../orchestration/_shared/registry";
import type { LlmCompleteRequest } from "../../../../../../../packages/providers/src/core/types";

export const scriptFixture = {
  title: "机器人工作台", hook: "一份完全离线的测试剧本",
  outline: [{ section_title: "开始", key_points: ["确认任务", "安全执行"] }],
  full_script: "# 机器人工作台\n\n机器人检查轨道，并在确认安全后开始搬运。",
  estimated_duration_sec: 30, style_notes: "测试用", source_assumptions: "自动测试的虚构素材",
};

export function installLlmFixture() {
  if (process.env.NODE_ENV !== "test") throw new Error("LLM fixture 仅限测试");
  const id = `fixture_llm_${crypto.randomUUID().replaceAll("-", "")}`;
  const requests: LlmCompleteRequest[] = [];
  let reply: unknown = scriptFixture;
  let failure: Error | undefined;
  getRegistry().register("llm", id, () => ({
    id,
    async complete(request, context) {
      context.signal?.throwIfAborted();
      requests.push(request);
      if (failure) throw failure;
      return { text: typeof reply === "string" ? reply : JSON.stringify(reply) };
    },
    async healthCheck() { return { ok: true }; },
  }));
  return {
    id, requests,
    reply(value: unknown) { reply = value; failure = undefined; },
    fail(error: Error) { failure = error; },
  };
}
