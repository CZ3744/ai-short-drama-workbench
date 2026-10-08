# 全局槽位清单

本文档列出系统支持的所有变量槽位及其数据来源，供模板作者参考。

## 项目级槽位

| 槽位名 | 说明 | 数据来源 |
|--------|------|----------|
| `{{content_type_phrase}}` | 内容类型描述 | preset content_type.prompt_phrase |
| `{{platform_phrase}}` | 目标平台描述 | preset platform.prompt_phrase |
| `{{aspect_ratio}}` | 画面比例 | "9:16" / "16:9" / "1:1" |
| `{{visual_style_phrase}}` | 视觉风格描述 | preset visual_style.prompt_phrase |
| `{{audience_phrase}}` | 目标受众描述 | preset audience.prompt_phrase |
| `{{tone_phrase}}` | 语气描述 | preset tone.prompt_phrase |
| `{{pacing_phrase}}` | 节奏描述 | preset pacing.prompt_phrase |
| `{{camera_style_phrase}}` | 镜头风格描述 | preset camera_style.prompt_phrase |
| `{{ending_type_phrase}}` | 结尾类型描述 | preset ending_type.prompt_phrase |
| `{{target_duration_sec}}` | 目标时长(秒) | 项目配置 |
| `{{shot_count_hint}}` | 镜头数量建议 | 项目配置或算法计算 |
| `{{episode_count}}` | 总集数 | 系列配置 |
| `{{episode_index}}` | 当前集索引 | 系列配置 |
| `{{episode_title}}` | 当前集标题 | 用户输入或生成 |
| `{{episode_synopsis}}` | 当前集简介 | 用户输入或生成 |
| `{{series_title}}` | 系列标题 | 用户输入 |
| `{{series_synopsis}}` | 系列简介 | 用户输入 |

## 角色与场景槽位

| 槽位名 | 说明 | 数据来源 |
|--------|------|----------|
| `{{character_list}}` | 预渲染好的角色卡片文本 | entity_extractor 输出 |
| `{{scene_list}}` | 场景列表文本 | entity_extractor 输出 |
| `{{character_appearance_block}}` | 当前镜头出场角色的外观描述拼接 | character_designer 输出 |

## 镜头级槽位

| 槽位名 | 说明 | 数据来源 |
|--------|------|----------|
| `{{scene_atmosphere_block}}` | 场景氛围描述 | scene_designer 输出 |
| `{{shot_action}}` | 镜头动作描述 | storyboard_director 输出 |
| `{{shot_dialogue}}` | 镜头对话 | storyboard_director 输出 |
| `{{shot_voiceover}}` | 镜头旁白 | storyboard_director 输出 |
| `{{shot_type_phrase}}` | 镜头类型描述 | storyboard_director 输出 |
| `{{camera_movement_phrase}}` | 镜头运动描述 | storyboard_director 输出 |
| `{{shot_duration_sec}}` | 镜头时长(秒) | storyboard_director 输出 |

## 用户交互槽位

| 槽位名 | 说明 | 数据来源 |
|--------|------|----------|
| `{{user_note}}` | 用户最新修改意见 | Canvas 面板输入 |
| `{{revision_history}}` | 已批准的修改历史 | 系统记录 |
| `{{raw_inspiration}}` | 用户原始输入 | 用户输入 |

## 媒体相关槽位

| 槽位名 | 说明 | 数据来源 |
|--------|------|----------|
| `{{subtitle_style_phrase}}` | 字幕样式描述 | preset subtitle_style.prompt_phrase |
| `{{bgm_mood_phrase}}` | 背景音乐情绪描述 | preset bgm_mood.prompt_phrase |

## 旧版兼容槽位

以下槽位为旧版模板使用，新模板应使用上述规范命名：

| 旧槽位名 | 对应新槽位名 |
|----------|--------------|
| `{{PROJECT_BRIEF_JSON}}` | `{{project_brief}}` |
| `{{DURATION_TARGET}}` | `{{target_duration_sec}}` |
| `{{SCRIPT}}` | `{{full_script}}` |
| `{{UNDERSTANDING_JSON}}` | `{{script_understanding}}` |
| `{{MANIFEST_JSON}}` | `{{current_manifest}}` |
| `{{STYLE}}` | `{{visual_style_phrase}}` |
| `{{VISUAL_STRATEGY}}` | `{{camera_style_phrase}}` |
| `{{SCENES_JSON}}` | `{{scene_list}}` |
| `{{ENGINEERING_CHECKS_JSON}}` | `{{engineering_checks}}` |
