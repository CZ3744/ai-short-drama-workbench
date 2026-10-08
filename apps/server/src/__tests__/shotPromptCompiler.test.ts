/**
 * shotPromptCompiler tests
 *
 * 覆盖:
 *   - full_prompt 自包含 (含 preamble + 关键参数 + 素材)
 *   - 关键参数进入 prompt 主体 (camera_movement / pace / duration / lighting / mood)
 *   - characters / scene / elements 的展开数据进 prompt (而非 id)
 *   - user_extra 单独成段
 *   - has_first_frame_ref / has_end_frame_ref 修改 preamble 语气
 *   - segments 分段, 给 UI 高亮
 *   - negative_prompt 兜底 + extra_negative 追加
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compileShotImagePrompt,
  compileShotVideoPrompt,
  buildShotLlmPolishMessages,
  type ShotPromptInput,
} from "../application/generation/shotPromptCompiler";

const BASE: ShotPromptInput = {
  shot_index: 3,
  title: "破晓时分主角凝望窗外",
  action: "主角缓缓走到窗边, 看着初升的太阳",
  dialogue: "终于,等到了天亮。",
  voiceover: "她已经在这里站了三个小时。",
  notes: "表情要克制, 不要过度悲伤",
  shot_type: "近景",
  camera_movement: "缓慢推进",
  style: "电影感",
  time_of_day: "清晨",
  lighting: "窗边自然光",
  mood: "宁静",
  duration_sec: 5,
  pace: "slow",
  characters: [
    {
      name: "林夏",
      description: "30 岁亚洲女性, 长发, 穿米色毛衣",
      primary_image_note: "锁定的角色主图: 中景半身",
    },
  ],
  scene: {
    name: "顶层公寓客厅",
    description: "高层落地窗, 远处城市天际线",
    primary_image_note: "锁定的场景图: 黄昏视角",
  },
  elements: [
    { kind: "prop", name: "白瓷咖啡杯", description: "手作磨砂质感" },
    { kind: "wardrobe", name: "米色羊毛衫" },
  ],
  user_extra: "请把光线再压暗一点, 突出剪影感",
  has_first_frame_ref: false,
};

describe("compileShotImagePrompt", () => {
  it("产出自包含 full_prompt — 含 preamble", () => {
    const out = compileShotImagePrompt(BASE);
    assert.ok(
      out.full_prompt.includes("你是一个图像生成工具"),
      "应有图像生成 preamble",
    );
    assert.ok(
      out.full_prompt.includes("AI 短剧"),
      "preamble 应明确 AI 短剧背景",
    );
  });

  it("关键参数进入 prompt 主体", () => {
    const out = compileShotImagePrompt(BASE);
    assert.ok(out.full_prompt.includes("近景"), "shot_type 进 prompt");
    assert.ok(out.full_prompt.includes("缓慢推进"), "camera_movement 进 prompt");
    assert.ok(out.full_prompt.includes("窗边自然光"), "lighting 进 prompt");
    assert.ok(out.full_prompt.includes("宁静"), "mood 进 prompt");
    assert.ok(out.full_prompt.includes("清晨"), "time_of_day 进 prompt");
    // 首帧图像 prompt 不含 duration (那是视频专属)
    assert.ok(!out.full_prompt.includes("时长:"), "image prompt 不含 duration");
  });

  it("characters 展开数据进 prompt, 不是 id", () => {
    const out = compileShotImagePrompt(BASE);
    assert.ok(out.full_prompt.includes("林夏"), "角色名进 prompt");
    assert.ok(
      out.full_prompt.includes("米色毛衣"),
      "角色描述进 prompt",
    );
    assert.ok(
      out.full_prompt.includes("锁定的角色主图"),
      "primary_image_note 进 prompt",
    );
  });

  it("scene + elements 展开数据进 prompt", () => {
    const out = compileShotImagePrompt(BASE);
    assert.ok(out.full_prompt.includes("顶层公寓客厅"), "scene 名进 prompt");
    assert.ok(out.full_prompt.includes("白瓷咖啡杯"), "element 名进 prompt");
    assert.ok(out.full_prompt.includes("米色羊毛衫"), "另一 element 也进");
  });

  it("user_extra 单独成段", () => {
    const out = compileShotImagePrompt(BASE);
    assert.ok(
      out.full_prompt.includes("请把光线再压暗"),
      "user_extra 进 prompt 主体",
    );
    const seg = out.segments.find((s) => s.label === "用户额外要求");
    assert.ok(seg, "应有用户额外要求段");
    assert.ok(seg!.text.includes("剪影感"));
  });

  it("has_first_frame_ref 修改 preamble 语气", () => {
    const off = compileShotImagePrompt({ ...BASE, has_first_frame_ref: false });
    const on = compileShotImagePrompt({ ...BASE, has_first_frame_ref: true });
    assert.ok(!off.full_prompt.includes("上传了参考图"));
    assert.ok(on.full_prompt.includes("上传了参考图"), "i2i 模式应明示参考图");
  });

  it("segments 至少含 preamble / shot_context / camera_params / 出场人物 / 场景", () => {
    const out = compileShotImagePrompt(BASE);
    const labels = out.segments.map((s) => s.label);
    assert.ok(labels.includes("通用启动词"));
    assert.ok(labels.includes("分镜上下文"));
    assert.ok(labels.includes("关键参数"));
    assert.ok(labels.includes("出场人物"));
    assert.ok(labels.includes("场景"));
  });

  it("negative_prompt 含兜底 + extra_negative 追加", () => {
    const out = compileShotImagePrompt({ ...BASE, extra_negative: "动漫脸, 卡通" });
    assert.ok(out.negative_prompt.includes("低分辨率"), "应含兜底负向");
    assert.ok(out.negative_prompt.includes("动漫脸"), "应追加 extra_negative");
  });

  it("空字段不出现空段", () => {
    const out = compileShotImagePrompt({
      action: "主角抬头",
      title: "",
      dialogue: "",
      voiceover: "",
      notes: "",
    });
    // 主体不应有 "对白: " 这种空字段
    assert.ok(!out.full_prompt.includes("对白:"));
    assert.ok(!out.full_prompt.includes("旁白:"));
    // 应仍有 preamble + action
    assert.ok(out.full_prompt.includes("AI 短剧"));
    assert.ok(out.full_prompt.includes("主角抬头"));
  });
});

describe("compileShotVideoPrompt", () => {
  it("产出自包含 full_prompt — 含视频 preamble + 时长", () => {
    const out = compileShotVideoPrompt(BASE);
    assert.ok(
      out.full_prompt.includes("你是一个视频生成工具"),
      "应有视频生成 preamble",
    );
    assert.ok(out.full_prompt.includes("5"), "应含时长数字");
  });

  it("视频专属 — duration_sec / pace 进 prompt 主体", () => {
    const out = compileShotVideoPrompt(BASE);
    assert.ok(out.full_prompt.includes("时长: 5 秒"), "duration 进视频 prompt");
    assert.ok(out.full_prompt.includes("slow"), "pace 进视频 prompt");
  });

  it("camera_movement 进 prompt 主体 (不只是独立字段)", () => {
    const out = compileShotVideoPrompt(BASE);
    assert.ok(out.full_prompt.includes("缓慢推进"));
    const seg = out.segments.find((s) => s.label.includes("关键参数"));
    assert.ok(seg, "应有关键参数段");
    assert.ok(seg!.text.includes("运镜"));
  });

  it("has_first_frame_ref + has_end_frame_ref 改 preamble", () => {
    const both = compileShotVideoPrompt({
      ...BASE,
      has_first_frame_ref: true,
      has_end_frame_ref: true,
    });
    const onlyFirst = compileShotVideoPrompt({
      ...BASE,
      has_first_frame_ref: true,
      has_end_frame_ref: false,
    });
    const neither = compileShotVideoPrompt({
      ...BASE,
      has_first_frame_ref: false,
      has_end_frame_ref: false,
    });
    assert.ok(both.full_prompt.includes("锁定首帧与尾帧"));
    assert.ok(onlyFirst.full_prompt.includes("锁定首帧"));
    assert.ok(!onlyFirst.full_prompt.includes("尾帧"));
    assert.ok(neither.full_prompt.includes("纯文本生视频"));
  });

  it("characters / scene / elements 进 prompt", () => {
    const out = compileShotVideoPrompt(BASE);
    assert.ok(out.full_prompt.includes("林夏"));
    assert.ok(out.full_prompt.includes("顶层公寓客厅"));
    assert.ok(out.full_prompt.includes("白瓷咖啡杯"));
  });

  it("user_extra (例如废案库再抽时的微调) 单独成段", () => {
    const out = compileShotVideoPrompt({
      ...BASE,
      user_extra: "节奏再放慢一点, 强调主角眨眼瞬间",
    });
    assert.ok(out.full_prompt.includes("节奏再放慢一点"));
    const seg = out.segments.find((s) => s.label === "用户额外要求");
    assert.ok(seg, "应有用户额外要求段");
  });

  it("negative_prompt 用视频专属兜底", () => {
    const out = compileShotVideoPrompt(BASE);
    assert.ok(out.negative_prompt.includes("画面抖动"));
    assert.ok(out.negative_prompt.includes("帧间跳变"));
  });

  it("dialogue / voiceover / notes 合并为 subtext 段", () => {
    const out = compileShotVideoPrompt(BASE);
    const seg = out.segments.find((s) =>
      s.label.includes("对白") || s.label.includes("潜台词"),
    );
    assert.ok(seg, "应有对白/潜台词段");
    assert.ok(seg!.text.includes("终于"));
    assert.ok(seg!.text.includes("三个小时"));
  });
});

// 2026-05-28 — AI 出图打磨: 新行为测试
describe("AI 出图打磨 — 强化 prompt 结构", () => {
  it("DEFAULT_NEGATIVE_IMAGE 含业内标准负向集合", () => {
    const out = compileShotImagePrompt(BASE);
    // 业内标准负向词 (FLUX/SD/MJ 都用)
    assert.ok(out.negative_prompt.includes("bad anatomy"), "应含 bad anatomy");
    assert.ok(out.negative_prompt.includes("missing fingers"), "应含 missing fingers");
    assert.ok(out.negative_prompt.includes("two faces") || out.negative_prompt.includes("multiple faces"), "应反多张脸");
    assert.ok(out.negative_prompt.includes("watermark"), "应反水印");
    // 中文同义
    assert.ok(out.negative_prompt.includes("多张脸"), "中文也反多张脸");
    assert.ok(out.negative_prompt.includes("身体畸形"), "应反身体畸形");
  });

  it("DEFAULT_NEGATIVE_VIDEO 含业内标准视频负向", () => {
    const out = compileShotVideoPrompt(BASE);
    assert.ok(out.negative_prompt.includes("character face drift") || out.negative_prompt.includes("角色面部漂移"), "应反角色面部漂移");
    assert.ok(out.negative_prompt.includes("flicker") || out.negative_prompt.includes("闪烁"), "应反闪烁");
    assert.ok(out.negative_prompt.includes("ghosting") || out.negative_prompt.includes("重影"), "应反重影");
  });

  it("image preamble 含中文短剧 5 段式 prefix", () => {
    const out = compileShotImagePrompt(BASE);
    assert.ok(out.full_prompt.includes("五段式"), "应明确告诉模型走 5 段式");
    assert.ok(out.full_prompt.includes("主体"), "5 段式应含主体");
    assert.ok(out.full_prompt.includes("氛围"), "5 段式应含氛围");
    assert.ok(out.full_prompt.includes("质量"), "5 段式应含质量");
  });

  it("reference_images_layout 按角色优先级排序 — 角色主图前于服装", () => {
    const out = compileShotImagePrompt({
      ...BASE,
      reference_images_layout: [
        { role: "character_wardrobe", label: "服装1" },
        { role: "character_primary", label: "角色1" },
        { role: "first_frame", label: "首帧" },
      ],
    });
    const seg = out.segments.find((s) => s.label.includes("参考图"));
    assert.ok(seg, "应有参考图段");
    // 优先级: first_frame < character_primary < character_wardrobe
    const idxFirst = seg!.text.indexOf("首帧");
    const idxChar = seg!.text.indexOf("角色1");
    const idxWar = seg!.text.indexOf("服装1");
    assert.ok(idxFirst < idxChar && idxChar < idxWar, "排序: first_frame → character_primary → character_wardrobe");
  });

  it("reference_images_layout 每张图带权重 + 约束说明", () => {
    const out = compileShotImagePrompt({
      ...BASE,
      reference_images_layout: [
        { role: "character_primary", label: "林夏主图" },
        { role: "character_wardrobe", label: "校服" },
      ],
    });
    const seg = out.segments.find((s) => s.label.includes("参考图"));
    assert.ok(seg, "应有参考图段");
    assert.ok(seg!.text.includes("推荐权重"), "应含权重表述");
    assert.ok(seg!.text.includes("约束说明"), "应含约束说明");
    assert.ok(seg!.text.includes("强约束") || seg!.text.includes("中等约束"), "应含强约束/中等约束分级");
  });

  it("0 张参考图时 prompt 写'未附参考图'", () => {
    const out = compileShotImagePrompt({
      ...BASE,
      reference_images_layout: [],
    });
    const seg = out.segments.find((s) => s.label.includes("参考图"));
    assert.ok(seg, "0 张也要有段");
    assert.ok(seg!.text.includes("未附参考图"));
  });
});

// 2026-05-28 — buildShotLlmPolishMessages: LLM 润色入口
describe("buildShotLlmPolishMessages — LLM 润色 meta-prompt", () => {
  it("image mode — system 教 5 段式 + 严禁分镜拼贴", () => {
    const msgs = buildShotLlmPolishMessages(BASE, "image");
    assert.ok(msgs.system.includes("五段式"), "system 应明确 5 段式");
    assert.ok(msgs.system.includes("主体"), "应含主体段");
    assert.ok(msgs.system.includes("场景"), "应含场景段");
    assert.ok(msgs.system.includes("氛围"), "应含氛围段");
    assert.ok(msgs.system.includes("镜头"), "应含镜头段");
    assert.ok(msgs.system.includes("质量"), "应含质量段");
    assert.ok(msgs.system.includes("故事板") || msgs.system.includes("分镜拼贴"), "应反故事板");
  });

  it("video mode — system 强调镜头运动 + 节奏", () => {
    const msgs = buildShotLlmPolishMessages(BASE, "video");
    assert.ok(msgs.system.includes("视频"), "应说明是视频");
    assert.ok(msgs.system.includes("镜头运动") || msgs.system.includes("运动"), "应强调运动");
    assert.ok(msgs.system.includes("节奏"), "应强调节奏");
  });

  it("user 含 entity 描述 (角色名 + 外观 + 场景 + 素材)", () => {
    const msgs = buildShotLlmPolishMessages(BASE);
    assert.ok(msgs.user.includes("林夏"), "应含角色名");
    assert.ok(msgs.user.includes("米色毛衣") || msgs.user.includes("亚洲女性"), "应含角色外观");
    assert.ok(msgs.user.includes("顶层公寓客厅"), "应含场景名");
    assert.ok(msgs.user.includes("白瓷咖啡杯"), "应含 element 名");
  });

  it("user 含全剧 / 本集 上下文 (当 caller 注入)", () => {
    const msgs = buildShotLlmPolishMessages({
      ...BASE,
      series_synopsis: "一部都市悬疑短剧",
      series_visual_style: "深蓝橙色调, 玻璃质感反射",
      episode_brief: "开场紧张, 末段揭示反转",
      shot_position: { current: 3, total: 12 },
    });
    assert.ok(msgs.user.includes("都市悬疑"), "应含全剧背景");
    assert.ok(msgs.user.includes("深蓝橙色调"), "应含视觉风格");
    assert.ok(msgs.user.includes("揭示反转"), "应含本集情绪");
    assert.ok(msgs.user.includes("第 3 / 12"), "应含本镜位置");
  });

  it("user_extra 注入到 user (最高优先级)", () => {
    const msgs = buildShotLlmPolishMessages({
      ...BASE,
      user_extra: "把光线再压暗, 突出剪影感",
    });
    assert.ok(msgs.user.includes("用户本次要求"), "应有用户要求段");
    assert.ok(msgs.user.includes("突出剪影感"), "应含用户的原文");
  });

  it("空 input 不崩 — fallback 通用 prompt", () => {
    const msgs = buildShotLlmPolishMessages({ action: "" });
    assert.ok(msgs.system.length > 100, "system 应仍有内容");
    assert.ok(msgs.user.length > 0, "user 应仍有内容");
  });
});
