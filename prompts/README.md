# Prompt 模板库

本目录包含视频生成系统的所有 prompt 模板文件。

## 模板列表

### 保留并扩展的模板

| 模板 ID | 版本 | 输入槽位数 | 输出格式 | 说明 |
|---------|------|-----------|----------|------|
| script_expander | 2 | 2 | json | 灵感 → 剧本 |
| scene_planner | 2 | 5 | json | 剧本 → 分场 |
| visual_director | 2 | 1 | json | 分场 → 分镜首帧 prompt |
| revision_agent | 2 | 2 | json | 用户意见 → 修订计划 |
| qa_agent | 2 | 2 | json | 质量检查 |
| content_qa_agent | 2 | 2 | json | 内容质量检查 |
| publish_qa_agent | 2 | 3 | json | 发布质量检查 |
| metadata_agent | 2 | 2 | json | 生成平台发布元数据 |
| project_brief_builder | 2 | 8 | json | 用户模糊灵感 → brief |
| script_understanding | 2 | 3 | json | 剧本理解 |
| scene_prompt_rewriter | 2 | 6 | json | 场景 prompt 重写 |
| provider_prompt_adapter | 2 | 5 | json | Provider prompt 适配 |
| json_repair | 2 | 1 | json | JSON 修复 |
| script_revision | 2 | 5 | text | 剧本修订（纯文本输出） |

### 新建模板

| 模板 ID | 版本 | 输入槽位数 | 输出格式 | 说明 |
|---------|------|-----------|----------|------|
| storyboard_director | 2 | 18 | json | 剧本 + brief → 完整分镜 JSON (shot 级) |
| entity_extractor | 2 | 3 | json | 剧本 → 抽取角色/场景列表 |
| character_designer | 2 | 9 | json | 角色信息 → 人设图 prompt |
| scene_designer | 2 | 12 | json | 场景信息 → 场景图 prompt |
| first_frame_prompter | 2 | 17 | json | shot → 单张首帧图 prompt |
| video_prompter | 2 | 19 | json | shot + 首帧 → 图生视频 prompt |
| cover_designer | 2 | 11 | json | series + ep → 竖屏封面图 prompt |
| title_copywriter | 2 | 10 | json | 剧情 → 抖音爆款标题 (3-5 个候选) |
| beat_sheet_planner | 2 | 14 | json | 剧本 → 6 节拍骨架 |
| storyboard_critic | 2 | 6 | json | 节拍 + 分镜 → 质量审查 |

## 模板格式规范 (v2)

每个模板文件都遵循以下格式：

```markdown
---
id: template_id
version: 2
slots: [slot1, slot2, ...]
output_format: json
output_schema_ref: packages/drama/src/schema.ts#Type  # 可选
---

# 硬约束

- （重复 2 次，放在最前）

# 允许思考

你可以在回答前使用 <thinking>...</thinking> 进行内部推理...

# 角色
你是一位...

# 任务
...

# 输出格式
...（含 confidence 和 assumptions 字段）

# 范例（缩略版）
...

# 输入数据

<source>
...（用户数据用 XML 标签包裹）
</source>
```

### Frontmatter 字段

- `id`: 模板唯一标识符
- `version`: 模板版本号（当前 v2）
- `slots`: 输入槽位列表
- `output_format`: 输出格式（json/text）
- `output_schema_ref`: 输出 schema 引用（可选）

### v2 新增规范

1. **硬约束重复 2 次放最前** — 防止 LLM 遗漏关键约束
2. **每份加 1 条 good example（缩略版）** — 降低输出格式出错率
3. **数据段用 `<source>...</source>` XML 标签包裹** — 防 prompt injection + 告诉模型这是数据不是指令（至少 3 份模板有此标签）
4. **允许 `<thinking>...</thinking>` 前置 CoT** — 后端剥除，不暴露给用户
5. **schema 加 `confidence` 和 `assumptions` 字段** — 让下游知道输出置信度和隐含假设
6. **统一 frontmatter 格式** — id/version/slots/output_format

### 槽位语法

- 变量替换：`{{slot_name}}`
- 条件渲染：`{{#if slot_name}} ... {{/if}}`

## 槽位清单

详见 [_slots.md](_slots.md) 文件。

## 使用方式

```typescript
import { compilePrompt } from "../packages/providers/src/promptCompiler";

const result = await compilePrompt("storyboard_director", {
  series_title: "都市迷茫",
  // ... 其他槽位
}, {
  missing_slot_policy: "error",
  max_length_chars: 10000
});

console.log(result.text);
console.log(result.meta);
```

## 测试

运行 golden sample 测试：

```bash
npm run test:prompt-compiler
```

首次运行会自动生成 golden 文件，后续运行会验证编译结果一致性。

## 更新模板

1. 修改模板文件
2. 运行测试，查看 diff
3. 确认变更后，删除对应的 golden 文件
4. 重新运行测试，生成新的 golden 文件
5. 提交变更
