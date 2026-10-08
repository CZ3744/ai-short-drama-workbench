/**
 * W1 组合性测试 — 2026-05-26
 *
 * 覆盖角色 ↔ 服装/道具 + 本镜独立道具 的提示词拼接和参考图清单逻辑.
 *
 * 不依赖 fs / repo — 纯 ShotPromptInput → CompiledShotPrompt 的函数行为.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compileShotImagePrompt,
  compileShotVideoPrompt,
  type ShotPromptInput,
} from "../application/generation/shotPromptCompiler";

const BASE: ShotPromptInput = {
  shot_index: 1,
  title: "茶馆里的对峙",
  action: "老张拿出怀表看时间, 慢慢起身",
  shot_type: "中景",
  camera_movement: "固定",
  style: "京味",
  duration_sec: 4,
  characters: [
    {
      name: "老张",
      description: "60 岁男性, 国字脸, 络腮胡, 浅灰短发",
      primary_image_note: "锁定主图: 茶馆坐姿",
      wardrobe: {
        name: "灰色中山装",
        description: "立领, 四口袋, 米色衬里",
      },
      props: [
        { name: "黄铜怀表", description: "怀表面盖有刻花" },
        { name: "棕色公文包", description: "牛皮老式" },
      ],
    },
  ],
  scene: { name: "老茶馆", description: "原木八仙桌, 红木大柜" },
  shot_props: [
    { name: "桌上一杯凉茶", description: "粗陶白瓷盏" },
  ],
};

describe("shotPromptCompiler 组合性 (W1)", () => {
  it("characters[i].wardrobe 拼进出场人物段", () => {
    const out = compileShotImagePrompt(BASE);
    assert.ok(out.full_prompt.includes("灰色中山装"), "wardrobe.name 应进 prompt");
    assert.ok(out.full_prompt.includes("立领, 四口袋"), "wardrobe.description 应进 prompt");
    assert.ok(out.full_prompt.includes("服装:"), "应有'服装:'前缀");
  });

  it("characters[i].props 拼进出场人物段", () => {
    const out = compileShotImagePrompt(BASE);
    assert.ok(out.full_prompt.includes("黄铜怀表"), "prop[0].name 应进 prompt");
    assert.ok(out.full_prompt.includes("棕色公文包"), "prop[1].name 应进 prompt");
    assert.ok(out.full_prompt.includes("常带道具:"), "应有'常带道具:'前缀");
  });

  it("shot_props 单独成段, 跟角色常带道具分开", () => {
    const out = compileShotImagePrompt(BASE);
    assert.ok(out.full_prompt.includes("桌上一杯凉茶"), "shot_prop.name 应进 prompt");
    assert.ok(
      out.full_prompt.includes("本镜独立道具"),
      "应有'本镜独立道具'段标题",
    );
  });

  it("无 wardrobe/props 时不阻塞 — 仅拼基本角色描述", () => {
    const noComp: ShotPromptInput = {
      ...BASE,
      characters: [{ name: "路人甲", description: "戴帽子的中年男" }],
      shot_props: undefined,
    };
    const out = compileShotImagePrompt(noComp);
    assert.ok(out.full_prompt.includes("路人甲"), "角色名应进");
    assert.ok(!out.full_prompt.includes("服装:"), "无 wardrobe 不应出现'服装:'前缀");
    assert.ok(!out.full_prompt.includes("常带道具:"), "无 props 不应出现'常带道具:'");
    assert.ok(!out.full_prompt.includes("本镜独立道具"), "无 shot_props 不应出现该段");
  });

  it("视频 prompt 同样拼组合性字段", () => {
    const out = compileShotVideoPrompt(BASE);
    assert.ok(out.full_prompt.includes("灰色中山装"), "video prompt 也含 wardrobe");
    assert.ok(out.full_prompt.includes("黄铜怀表"), "video prompt 也含 prop");
    assert.ok(out.full_prompt.includes("桌上一杯凉茶"), "video prompt 也含 shot_prop");
  });

  it("reference_images_layout 支持 character_wardrobe/character_prop/shot_prop 三个新 role", () => {
    const layout: ShotPromptInput["reference_images_layout"] = [
      { role: "character_primary", label: "角色「老张」主图" },
      { role: "character_wardrobe", label: "角色「老张」服装造型「灰色中山装」" },
      { role: "character_prop", label: "角色「老张」常带道具「黄铜怀表」" },
      { role: "shot_prop", label: "本镜独立道具「桌上一杯凉茶」" },
    ];
    const out = compileShotImagePrompt({ ...BASE, reference_images_layout: layout });
    assert.ok(
      out.full_prompt.includes("角色服装造型(用于服装外观一致性)"),
      "ROLE_LABEL.character_wardrobe 应解释",
    );
    assert.ok(
      out.full_prompt.includes("角色常带道具(用于道具外观一致性)"),
      "ROLE_LABEL.character_prop 应解释",
    );
    assert.ok(
      out.full_prompt.includes("本镜独立道具(本镜剧情特有,非角色常带)"),
      "ROLE_LABEL.shot_prop 应解释",
    );
    assert.ok(
      out.full_prompt.includes("灰色中山装"),
      "layout label 内的服装名应可见",
    );
  });

  it("一个角色只挂一套服装时正确拼出 (单值优先级)", () => {
    const single: ShotPromptInput = {
      ...BASE,
      characters: [
        {
          name: "老张",
          description: "60 岁男性",
          wardrobe: { name: "西装" },  // 只有 name 没 description
        },
      ],
      shot_props: undefined,
    };
    const out = compileShotImagePrompt(single);
    assert.ok(out.full_prompt.includes("服装: 西装"), "name-only wardrobe 也应拼");
    assert.ok(!out.full_prompt.includes("undefined"), "无描述不应漏 undefined");
  });
});
