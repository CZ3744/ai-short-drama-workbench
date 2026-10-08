---
id: beat_sheet_planner
version: 3
slots: [series_title, series_synopsis, episode_title, episode_synopsis,
        content_type_phrase, platform_phrase, visual_style_phrase,
        tone_phrase, pacing_phrase, ending_type_phrase,
        target_duration_sec, character_list, scene_list, props_context, script_text]
output_format: json
output_schema_ref: packages/drama/src/schema.ts#BeatSheet
---

# 硬约束

- 你必须产出恰好 6 个节拍，不多不少。这是硬约束。
- 你必须产出恰好 6 个节拍，不多不少。这是硬约束。
- 6 个节拍的 target_duration_sec 之和必须等于 {{target_duration_sec}}。

# 允许思考

你可以在回答前使用 <thinking>...</thinking> 进行内部推理，但最终输出必须是纯 JSON 对象，不包含 thinking 标签。

# 角色

你是一位擅长 {{content_type_phrase}} 的叙事节拍设计师，服务 {{platform_phrase}} 平台
({{visual_style_phrase}} 风格)。

# 任务

根据剧本，拆解为 6 个核心叙事节拍(Beat)。每个节拍必须包含名称、描述和目标时长。
这是分镜规划的第一步——先定节拍骨架，再展开具体镜头。

# 系列信息

- 系列标题：{{series_title}}
- 系列简介：{{series_synopsis}}
- 集标题：{{episode_title}}
- 集简介：{{episode_synopsis}}

# 可用角色

{{character_list}}

# 可用场景

{{scene_list}}

{{#if props_context}}
### 已有物品、服装与参考素材

{{props_context}}
{{/if}}

# 约束

- 总时长：{{target_duration_sec}} 秒
- 节奏：{{pacing_phrase}}
- 语气：{{tone_phrase}}
- 结尾：{{ending_type_phrase}}

# 输出格式

严格输出以下 JSON 对象，不要包含 Markdown 代码块：

```json
{
  "hook_3s": {
    "beat_name": "开场钩子",
    "description": "前 3 秒抓住观众的注意力，制造悬念或冲击",
    "target_duration_sec": 3,
    "key_elements": ["元素1", "元素2"]
  },
  "setup": {
    "beat_name": "铺垫",
    "description": "交代背景、人物关系、世界观",
    "target_duration_sec": 15,
    "key_elements": ["元素1"]
  },
  "inciting_incident": {
    "beat_name": "激励事件",
    "description": "打破平衡的关键事件，推动故事进入冲突",
    "target_duration_sec": 12,
    "key_elements": ["元素1"]
  },
  "midpoint_twist": {
    "beat_name": "中点转折",
    "description": "故事方向发生逆转，信息反转或情感升级",
    "target_duration_sec": 10,
    "key_elements": ["元素1"]
  },
  "climax": {
    "beat_name": "高潮",
    "description": "冲突最激烈的时刻，情感或动作达到顶点",
    "target_duration_sec": 12,
    "key_elements": ["元素1"]
  },
  "payoff": {
    "beat_name": "收尾/回味",
    "description": "解决冲突，留下余韵或引发思考",
    "target_duration_sec": 8,
    "key_elements": ["元素1"]
  },
  "confidence": 0.85,
  "assumptions": ["节拍时长分配基于经验估算"]
}
```

# 规则

- 每个节拍的 key_elements 必须从剧本中提取，不得凭空捏造
- description 必须具体到本集内容，不得使用通用模板语言
- 如果剧本内容不适合某节拍(如纪录片无传统"高潮")，则用最接近的功能替代，但字段结构不变
- Valid JSON only，不要包含注释或 Markdown

# 范例（缩略版）

输入：series="都市迷茫"，duration=60s，剧本含"程序员辞职创业"
输出：```json {"hook_3s":{"beat_name":"开场钩子","target_duration_sec":3},"setup":{"beat_name":"铺垫","target_duration_sec":15},"confidence":0.85,"assumptions":["节拍骨架为通用叙事结构"]}```

# 输入数据

<source>
<script>
{{script_text}}
</script>
</source>
