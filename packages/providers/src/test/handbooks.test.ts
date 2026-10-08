import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compilePromptLegacy } from "../promptCompiler";

describe("published product handbooks", () => {
  for (const handbookName of ["content_planner", "storyboard_director", "visual_director", "provider_prompt_adapter"]) {
    it(`loads ${handbookName} into the actual generation prompt`, async () => {
      const userInstruction = "为一个雨夜咖啡馆镜头准备 JSON；保留我的用户要求。";
      const compiled = await compilePromptLegacy({ agentName: "handbook-packaging-check", handbookName, userInstruction });
      assert.ok(compiled.included_sections.includes(`handbook:${handbookName}`));
      assert.equal(compiled.warnings.some(warning => warning.startsWith("handbook_missing:")), false);
      assert.ok(compiled.system.includes("工作手册"));
      assert.ok(compiled.user.includes(userInstruction));
    });
  }
});
