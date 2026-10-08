/**
 * P11 - Drama 领域类型定义 (Step 2: 单源化 — 与 repo *Data 类型统一)
 * 覆盖 Series / Episode / Character / Scene / Shot / Asset / GenerationRecord 七种领域对象
 *
 * D6/Step2: drama/types.ts 是唯一权威。Series/Episode/Character/Shot/GenerationRecord
 * 五对类型以 apps/server/src/repositories/*Repo.ts 的 *Data 形态为准 (repo 是事实超集)。
 * repo 文件改为从这里 import + re-export。Scene / Asset 暂不动 (adapter 在用, 字段与 repo 系统性冲突)。
 */

// ─── Series ──────────────────────────────────────────────────────────────────

export interface SeriesDefaults {
  /** ref preset: content_type.json 里的 id */
  content_type?: string;
  /** ref preset: platform.json */
  platform?: string;
  /** ref preset: aspect_ratio.json */
  aspect_ratio?: string;
  /** ref preset: visual_style.json */
  visual_style?: string;
  audience?: string;
  tone?: string;
  pacing?: string;
  camera_style?: string;
  ending_type?: string;
  // provider 选择
  llm_provider_id?: string;
  image_provider_id?: string;
  video_provider_id?: string;
  tts_provider_id?: string;
  tts_voice_id?: string;
  // 运行限制
  /** 默认 5 */
  max_retake_per_shot?: number;
  /** 默认 300 */
  max_video_seconds_per_job?: number;
  /** 默认 3 */
  max_parallel_tasks?: number;
  default_template_id?: string;
  /** B2: Auto-retry when quality scores are below threshold (default true) */
  retry_on_low_quality?: boolean;
  // 2026-05-26 audit #9 — CreateSeriesDialog 6 个可选参数 (provider 模型 + 集数 + 时长目标).
  // tone / pacing 已在上面声明,这里只加新的 5 个:
  /** 集数预期 (1-30), undefined = 不指定 */
  episodes_target?: number;
  /** 单集时长目标秒 (5-600), expandScript DURATION_TARGET ctx 优先读这里 */
  duration_target_sec?: number;
  /**
   * 默认 LLM 模型 — provider_id 或 "provider_id:model_id".
   * 用户在 CreateSeriesDialog 高级参数里填的值. resolveLlmProviderId 优先读这里,
   * 留空 fallback 到 llm_provider_id (老字段) → 全局默认链.
   */
  default_llm?: string;
  /** 默认图像模型 — 同 default_llm. readSeries 会规范化为 image_provider_id 让下游沿用旧路径. */
  default_image?: string;
  /** 默认视频模型 — 同 default_llm. readSeries 会规范化为 video_provider_id. */
  default_video?: string;
}

/** 系列剧本版本记录 (与 seriesRepo.SeriesScriptVersion 同形) */
export interface SeriesScriptVersion {
  version: number;
  created_at: string;
  source: "ai_init" | "user_edit" | "ai_revise" | "revert";
  summary?: string;
  script_md: string;
}

export interface Series {
  /** 自动生成 ulid */
  id: string;
  /** 目录名, kebab-case */
  slug: string;
  /** 中文标题 */
  title: string;
  /** 中文简介 */
  synopsis: string;
  /** 相对路径 "script.md" */
  script_path?: string;
  /** 剧本 markdown 内容 */
  script_md?: string;
  /** 当前剧本版本号 */
  script_version?: number;
  /** 剧本版本历史 */
  script_versions?: SeriesScriptVersion[];
  /** ISO8601 */
  created_at: string;
  updated_at: string;
  /** 全系列默认参数(每集/每镜可覆盖) */
  defaults: SeriesDefaults;
  /** episode id 数组, 保持顺序 */
  episodes: string[];
  /** 跨集复用的角色 */
  character_ids: string[];
  scene_ids: string[];
  /** 与 defaults.platform 可重复 */
  target_platform: string;
  /** 软删标记 */
  _deleted?: boolean;
  publish_meta_template_id?: string;
  /**
   * 2026-05-21 — 系列封面图 vault_id (用户点 SeriesDetail "生成系列封面" 后落盘).
   * 首页 StudioHome 卡片优先用此, 没生成时 fallback 6 套渐变 CSS.
   */
  cover_vault_id?: string;
  /** 系列封面 prompt snapshot (审计 / 重新生成参考) */
  cover_prompt_snapshot?: string;
  /** 系列封面生成时使用的 provider id (用户可知 + 重新生成可保持一致) */
  cover_provider_id?: string;
  /**
   * 2026-05-26 W4: 单组遗留字段 — 引用一个 Cast id (本剧只共享一个素材组).
   * 已被 W7 多组字段 cast_ids 取代, 保留作向后兼容 + 数据迁移源.
   *
   * 启动时 migration 会把老 series.cast_id 自动迁到 cast_ids[0], 之后写操作只动 cast_ids.
   * 读操作走 effectiveElements 时也会兼容老字段 (若 cast_ids 空则 fallback 看 cast_id).
   *
   * @deprecated W7 起请用 cast_ids 数组
   */
  cast_id?: string;
  /**
   * 2026-05-26 W7: 引用多个素材组 — 系列共享这些组里的全部素材.
   *
   * 多组合并语义见 application/cast/effectiveElements.ts:
   *   union(每个 cast.elements) ∪ series local elements (本剧专属); 同 id 时 local 覆盖,
   *   多个 cast 同 id 时第一个出现的赢 (按 cast_ids 顺序).
   *
   * 典型场景:
   *   - "老头们" + "民国班底" 两组合用 → 跨剧共享所有老演员 + 所有民国场景
   *   - 空数组 / undefined = 本剧专属, 不与任何组共享
   */
  cast_ids?: string[];
  /**
   * 2026-05-28 — AI 出图打磨: 全剧美学指南 (自由文本, 0-600 字).
   *
   * 跨分镜风格一致性的关键 — 业内 (Runway / Sora / Higgsfield) 短剧工具的
   * 经验做法是 "Style Bible" + per-shot brief 双层注入. defaults.visual_style
   * 是 enum 预设 (动漫/写实/水墨等), 表达粗略风格; visual_style_guide 是用户
   * 自由文本, 可以写 "整剧深蓝-橙色调, 冷光低饱和, 玻璃质感的窗户/桌面反射,
   * 角色服装以毛呢/羊毛针织为主, 背景多用城市夜景剪影".
   *
   * shotPromptInput.deriveSeriesContextForShot 自动读这个字段喂每镜 prompt
   * (跟 episode_brief / prev/next_shot_brief 一起作"前后镜上下文 + 全剧锚定"),
   * 比单纯靠每镜 prompt 单镜随机出图一致性高很多.
   *
   * undefined / 空字符串 时跳过, fallback 到 defaults.visual_style preset
   * 的 prompt_phrase. 老 series 不破坏.
   */
  visual_style_guide?: string;
}

// ─── Cast (W4 2026-05-26 跨系列复用的 IP 角色阵容容器) ────────────────────────
//
// 设计目的: 让"一组角色 + 场景 + 服装 + 道具 + 语音"作为可复用 IP 容器存在,
// 多部剧 (Series) 都可以挂同一个 Cast 引用所有素材, 而不是每次从其他剧 fork
// 一份再独立长大.
//
// 类比: Cast = 演员阵容/IP 设定集; Series = 一部独立的剧/季. 同 Cast 多 Series = 持续 IP.
//
// 关键约束:
//   - Cast 是**可选**加层 — 现有 series-only element 路径保持工作 (不破坏老用户数据)
//   - series 可以"挂入" cast (新建系列 / 现有系列)
//   - cast 持有 element 主拷贝 (落 data/casts/<cast_id>/elements/<id>.json)
//   - 任何修改 cast 元素 → 所有挂载这个 cast 的 series 看到变更 (link, 不是 fork)
//
// 落盘:
//   data/casts/<cast_id>/cast.json
//   data/casts/<cast_id>/elements/<element_id>.json  (与 elementRepo 同构 ElementData)

/**
 * W6 (2026-05-26) — Cast 层角色语音资产.
 *
 * 持续 IP 痛点: 同一角色的"克隆配音样本 + provider voice_id"在多部剧之间是同一份,
 * 老架构每个 series 各传一遍, 切换 series 配音飘. 现在提升到 cast 层 — 一次配置全 IP 通用.
 *
 * 落盘: Cast.voice_assets 数组 (与 cast.json 同文件), 按 member_element_id 区分角色.
 * member_element_id 必须存在于 cast.member_element_ids 且 kind=character.
 *
 * 语音样本本身走 vault (SHA-256 dedup), voice_sample_vault_id 指向 vault 唯一一份;
 * 一个 cast 跨多 series 共享同一 sample 不重复落盘.
 *
 * 解析优先级 (compose/tts.ts resolveEffectiveVoiceForCharacter):
 *   1. shot.tts_voice_override            (单镜级)
 *   2. cast.voice_assets[cid].voice_style_map[emotion]   (cast 层情绪映射)
 *   3. cast.voice_assets[cid].provider_voice_ids[provider]  (cast 层 provider voice)
 *   4. character.voice_style_map[emotion]   (series-local character)
 *   5. character.voice_id                    (series-local)
 *   6. series.defaults.tts_voice_id          (系列默认)
 *   7. 全局默认
 */
export interface CastVoiceAsset {
  /** cast member element id (kind=character) — 必须命中 cast.member_element_ids */
  member_element_id: string;
  /** vault_id 指向 voice clone 样本音频 (SHA-256 dedup, 跨 cast/series 唯一一份) */
  voice_sample_vault_id?: string;
  /** 不同 TTS provider 的 voice_id 字典 (例: { minimax_t2a: "xxx", elevenlabs: "yyy"}) */
  provider_voice_ids?: Record<string, string>;
  /** 情绪 → voice_id 映射 (优先于 provider_voice_ids; 跟 character.voice_style_map 同形) */
  voice_style_map?: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/**
 * Cast — 跨系列复用的 IP 角色阵容容器.
 *
 * member elements 主拷贝物理落盘于 data/casts/<cast_id>/elements/<id>.json,
 * 通过 castRepo.listCastElements 列举, 通过 application/cast/effectiveElements.ts
 * 与 series local elements 合并供 series 视角消费.
 */
export interface Cast {
  /** ulid / slug (createCast 用 slugify(name) 防撞自动 -2/-3 后缀) */
  id: string;
  /** 中文 IP 名 (e.g. "老头们", "侦探俱乐部") */
  name: string;
  /** IP 简介, 可选 */
  description?: string;
  /** ISO8601 */
  created_at: string;
  updated_at: string;
  /**
   * cast 持有的 element id 列表 (主拷贝落盘 data/casts/<cast_id>/elements/<id>.json).
   * 顺序无业务含义 (前端按 updated_at 排序), 但维护它便于审计 "cast 当前有几个 member".
   */
  member_element_ids: string[];
  /**
   * W6 (2026-05-26): cast 层角色语音资产 (跨 series 共享).
   *
   * 一项一个 cast member (kind=character), 包含 voice 样本 vault_id + provider voice_ids + 情绪映射.
   * 老的 series-local character.voice_clone_sample_url / voice_id / voice_style_map 仍保留作 fallback.
   */
  voice_assets?: CastVoiceAsset[];
  /** 软删标记 (与 series 同模式) */
  _deleted?: boolean;
  /** 软删时间戳 (将来过期清理用) */
  _deleted_at?: string;
}

// ─── Episode ─────────────────────────────────────────────────────────────────

export type EpisodeStatus =
  | "drafted"
  | "scripting"
  | "storyboarded"
  | "generating"
  | "assembled"
  | "exported";

/** Episode 剧本版本记录 (与 episodeRepo.EpisodeVersion 同形) */
export interface EpisodeVersion {
  version: number;
  created_at: string;
  source: "ai_init" | "user_edit" | "ai_revise" | "revert";
  summary?: string;
  script_md: string;
}

export interface Episode {
  /** ep01, ep02... */
  id: string;
  series_slug: string;
  /** 序号, 用户可改 */
  index: number;
  title: string;
  synopsis?: string;
  /** 相对路径 "episodes/ep01/script.md" */
  script_path?: string;
  /** 剧本 markdown 内容 */
  script_md?: string;
  /** 当前版本号 */
  version?: number;
  /** 版本历史 */
  versions?: EpisodeVersion[];
  target_duration_sec?: number;
  target_shot_count?: number;
  /** 结尾钩子类型 */
  hook_type?: string;
  /** repo 用 string, 这里向 repo 看齐。EpisodeStatus 联合类型仍 export 备用 */
  status: string;
  /** "episodes/ep01/storyboard.json" */
  storyboard_path?: string;
  /** 可覆盖 series.defaults 的局部参数 */
  overrides?: Record<string, any>;
  /**
   * 2026-05-21 — 集级封面图 vault_id (用户点 SeriesDetail 集卡片 "生成封面" 后落盘).
   * SeriesDetail 集卡片优先用此, 没生成时 fallback 6 套 gradient + icon.
   */
  cover_vault_id?: string;
  /** 集封面 prompt snapshot 文件名 (审计 / 重新生成参考) */
  cover_prompt_snapshot?: string;
  /** 集封面生成时使用的 provider id (用户可知 + 重新生成可保持一致) */
  cover_provider_id?: string;
}

// ─── Character ───────────────────────────────────────────────────────────────

export type CharacterStatus = "drafted" | "candidates_generated" | "locked";

export interface CharacterLocked {
  image_provider_id?: string;
  seed?: number;
  negative_prompt?: string;
  /**
   * Step2: repo CharacterData.locked 实际是松散 bag (旧 `Record<string,any>`)。
   * controller 会写入 ref_image / locked_at / provider 等键, 故保留 index signature
   * 向 repo 事实形态看齐, 不破坏运行时。
   */
  [key: string]: unknown;
}

/** 情绪 → voice_id 映射 */
export interface VoiceStyleMap {
  default?: string;
  crying?: string;
  angry?: string;
  cold?: string;
  laugh?: string;
  [emotion: string]: string | undefined;
}

export interface Character {
  /** ulid 或 slug */
  id: string;
  series_slug: string;
  /** 中文名 */
  name: string;
  /** 主角/配角/反派... */
  role: string;
  /**
   * Wave B-3 (2026-05-16): 旧版单字段, **仅向后兼容**老数据读取。
   * 新数据写 appearance + outfit;读取时若新字段缺失,fallback 到此字段。
   * @deprecated 使用 appearance / outfit 替代
   */
  appearance_prompt?: string;
  /**
   * Wave B-3 (2026-05-16):外貌 — 年龄/脸型/发型/身材等不随场合变的特征。
   * 主要给生图模型用,与 outfit 拼接成 visual description。
   */
  appearance?: string;
  /**
   * Wave B-3 (2026-05-16):服装基调 — 常穿什么风格的衣服。
   * 给生图模型用,可被分镜里的具体场景服装覆盖。
   */
  outfit?: string;
  /** 性格, 影响对白 — 给剧本 LLM 使用 */
  personality: string;
  /** tts voice ref */
  voice_id?: string;
  /** 情绪-音色映射, compose 阶段按角色+情绪选 voice */
  voice_style_map?: VoiceStyleMap;
  /** asset id 列表 */
  ref_image_ids?: string[];
  /**
   * Per-image metadata 字典 (key = asset_id).
   *
   * 解决 legacy character/scene 路径下 ref_image_ids 只存 string[] id 导致
   * prompt_snapshot / provider_id / seed / origin 等 per-image 元数据丢失的问题。
   *
   * 新生成的 ref image 在 characterRefAdapter.persist 写入时同步填字典；
   * resolveLegacyImages 读取时把字典展平到 ElementImage 各字段。
   * 老数据（2026-05-16 之前）字典缺失，展平后 prompt_snapshot 保持 undefined
   * （历史无法补回，前端 toast 文案宽松提示）。
   */
  ref_image_meta?: Record<string, {
    display_name?: string;
    available_for_shot?: boolean;
    prompt_snapshot?: string;
    provider_id?: string;
    seed?: number;
    origin?: "generated" | "i2i" | "imported";
    based_on_image_id?: string;
    created_at?: string;
  }>;
  /** 锁定的主图 */
  primary_ref_image_id?: string;
  /** 锁定后的 seed 和模型参数, 用于保持一致性 */
  locked?: CharacterLocked;
  status?: string;
  /** 来源资源库 id */
  library_id?: string;
  /** 资源库 locked.png 绝对路径 */
  locked_image_path?: string;
  /** 派生来源 (从其他系列角色复制) */
  derived_from?: {
    series_slug: string;
    character_id: string;
    vault_id?: string;
  };
  /** 用户上传的语音克隆样本相对路径 (series-relative) */
  voice_clone_sample_url?: string;

  // ── B4 一致性三件套 ──────────────────────────────────────────
  /** 多角度参考图 vault id 列表 (3-5 张不同角度), 用于一致性生成 */
  reference_image_set?: string[];
  /** 锁定 seed, 确保每次生成使用相同随机种子 */
  locked_seed?: number;
  /** style_prompt 指纹, 用于检测 prompt 变更导致的风格漂移 */
  style_prompt_fingerprint?: string;
  /** LoRA 模型路径 (v2 占位, 当前未实现训练) */
  lora_path?: string;
  /**
   * 2026-05-20 P2: 是否为 LLM 拆分镜时自动建的占位角色.
   * 替代 fragile 的 role === "auto-extracted" 字符串判断.
   */
  is_placeholder?: boolean;
  /**
   * 2026-05-19 #8: LLM 规划的「需要几张图」列表(可选),
   * 由 batchSeries 写入, autoPipelineRunner.runElementImagesStage 消费.
   */
  image_briefs?: ImageBrief[];

  // ── W1 2026-05-26 角色组合性 ───────────────────────────────────
  /**
   * 该角色绑定的"服装造型" element id 列表 (kind=wardrobe).
   *
   * 分镜可在 shot.wardrobe_id 单选其中一套作本镜服装;
   * 不选则默认 wardrobe_element_ids[0] (兜底), 都没有则 fallback character.outfit 文本.
   *
   * 用例: 一个角色有"西装" / "运动服" / "睡衣" 三套常用造型, 每集挑一套.
   * 通用性: 不局限短剧, 任何"主体 + 多形态"组合都适用 (产品/玩具/吉祥物等).
   */
  wardrobe_element_ids?: string[];
  /**
   * 该角色常带的"道具" element id 列表 (kind=prop).
   *
   * 跟 shot.prop_ids 互补: character.prop_element_ids 是"角色身上常出现的"道具 (老张的怀表/公文包),
   *                       shot.prop_ids 是"本镜单独出现的"额外道具 (本镜桌上的茶杯).
   * 提示词编译 / 隐式 reference 时, 两者 union 去重.
   */
  prop_element_ids?: string[];
}

/** 对白解析结果 */
export interface DialogueLine {
  character_name: string;
  emotion: string | null;
  text: string;
}

// ─── Scene (Step2: 暂不动 — adapter 在用, 字段与 repo 系统性冲突, 留待以后) ────

export type SceneStatus = "drafted" | "candidates_generated" | "locked";

export interface SceneLocked {
  image_provider_id?: string;
  seed?: number;
  negative_prompt?: string;
}

export interface Scene {
  id: string;
  series_slug: string;
  name: string;
  location: string;
  time_of_day: string;
  weather: string;
  /** 中文气氛描述 */
  atmosphere_prompt: string;
  lighting: string;
  /** 风格锚点 */
  style_anchor: string;
  ref_image_ids: string[];
  /**
   * Per-image metadata 字典 (key = asset_id)。
   * 与 Character.ref_image_meta 同模式，保存 prompt_snapshot / provider_id 等。
   */
  ref_image_meta?: Record<string, {
    display_name?: string;
    available_for_shot?: boolean;
    prompt_snapshot?: string;
    provider_id?: string;
    seed?: number;
    origin?: "generated" | "i2i" | "imported";
    based_on_image_id?: string;
    created_at?: string;
  }>;
  primary_ref_image_id?: string;
  locked: SceneLocked;
  status: SceneStatus;
  /**
   * 2026-05-20 P2: 是否为 LLM 拆分镜时自动建的占位场景.
   * 替代 fragile 的 description === "auto-extracted placeholder" 字符串判断.
   */
  is_placeholder?: boolean;
}

// ─── Element (统一素材元素, 见 docs/ASSET_MANAGEMENT_REDESIGN.md §2.1) ─────

export type ElementKind = "character" | "scene" | "prop" | "wardrobe" | "reference" | "misc";

export interface ElementTag {
  /** 标签维度: personality / relationship / visual / free ... */
  axis: string;
  value: string;
  /** 关系类标签可关联另一个 element id */
  ref_element_id?: string;
}

/**
 * 2026-05-26 W1 — 图片维度标签 (image-level tag, 不是 element-level).
 *
 * 给单张 ElementImage 打"姿态/表情/造型/光线/自由"等维度标签, 让 ReferencePicker
 * 能按维度过滤典型图. 用户原话推导: "角色固定几套形态 (笑/沉思/坐着), 每集挑合适的".
 *
 * 与 ElementTag 区别: ElementTag 是给 element 整体的 (角色性格 / 场景气氛),
 *                     ImageTag 是给某一张图的 (这张图里角色在笑 / 那张在哭).
 *
 * axis 约定 (松散字符串, 不强约束 enum 让上层快速演化):
 *   - pose: 站立 / 坐 / 走 / 躺 / 跑
 *   - expression: 笑 / 哭 / 沉思 / 愤怒 / 平静
 *   - outfit: 西装 / 运动服 / 睡衣 (跨 wardrobe element 的快速维度)
 *   - lighting: 顺光 / 逆光 / 侧光 / 夜景
 *   - angle: 正面 / 侧面 / 背面 / 俯视
 *   - free: 自由文本
 */
export interface ImageTag {
  axis: string;
  value: string;
}

export interface ElementImage {
  image_id: string;
  vault_id?: string;
  asset_id?: string;
  origin: "generated" | "i2i" | "imported" | "from_shot" | "legacy";
  /** 生成类: 完整自包含提示词快照 */
  prompt_snapshot?: string;
  /** i2i 类: 基于本元素的哪张图 */
  based_on_image_id?: string;
  provider_id?: string;
  seed?: number;
  url?: string;
  mime?: string;
  created_at: string;
  note?: string;
  /** 用户可改的展示名,不等于真实文件名 */
  display_name?: string;
  /**
   * 2026-05-18 三池模型:是否在「真素材池」(可被分镜引用 / 出现在 LibraryConnectPanel + MentionSelector).
   * - false / undefined = "原始" 池(抽卡落盘但用户没主动晋升 — 犹豫未决)
   * - true             = "真素材池"(用户认证"确定要的",可被分镜挑选)
   * 历史数据默认 true(向后兼容,把所有历史图当真池处理).
   */
  available_for_shot?: boolean;
  /**
   * 2026-05-18 三池模型第 3 层:是否「典型代表图」(自动作 reference_images 发给生图模型).
   * - typical 必然 available_for_shot=true(典型图属于真池子集)
   * - implicitReferenceCollector 收集时:优先返回所有 is_typical=true 的图, 没有时 fallback 到 primary_image_id 单张
   * - 历史数据 + primary_image_id 指向的图会被 elementRepo 迁移逻辑自动标 is_typical=true
   * 视觉:typical 图带金色边框 + ⭐ 角标;real 图带蓝边 + ✓ 角标;raw 图普通灰边.
   */
  is_typical?: boolean;
  /**
   * 2026-05-26 W1 — 图片维度标签 (pose/expression/outfit/lighting/angle/free).
   *
   * 让用户给单张典型图标"姿态/表情/造型", 分镜挑图时按维度过滤
   * (例: "老张 + 笑 + 西服" 一键挑出符合的典型图作 reference).
   *
   * 注意: 跟 ElementTag (element 整体标签) 不同, ImageTag 是 image 级.
   *       同一 element 的不同图可以有不同维度标签 (老张-笑-站立 vs 老张-哭-坐).
   */
  image_tags?: ImageTag[];
}

export interface ElementUsage {
  episode_id: string;
  shot_id: string;
  shot_index: number;
  first_frame_url?: string | null;
}

/**
 * 2026-05-19 反馈 #8 — ImageBrief: 单个素材的「需要几张图、每张画什么」规划.
 *
 * 来源:
 *   - batchSeries.batchGenerateSeries LLM 一次性产出 — 角色 / 场景与剧本同步给出图规划
 *   - 用户手填(单独 element 创建时也可补充)
 *
 * 消费方:
 *   - autoPipelineRunner.runElementImagesStage 按 briefs 顺序为每个 element 生图
 *   - 第 1 张默认作典型代表图(is_typical=true), 第 2+ 张自动以前张为 i2i 参考
 *
 * 生成完成后, brief.generated=true + brief.image_id 关联到 ElementImage.image_id,
 * 让用户可以在 UI 上看到「这张 brief 已落地为这张图」.
 */
export interface ImageBrief {
  /** 视角 / 场景关键词 ("正面" / "侧面" / "全身" / "宽景" / "近景" 等) */
  angle: string;
  /** 这张图要画什么 (自包含描述, 喂给空上下文图像模型也能独立画出) */
  description: string;
  /** 是否已被生成过 (autoPipelineRunner 完成后标 true) */
  generated?: boolean;
  /** 关联到 ElementImage.image_id (生成成功后写入) */
  image_id?: string;
  /**
   * 是否由系统自动生成的默认 brief (手建素材无 briefs 时兜底塞入, 2026-05-20).
   * true = 系统默认; undefined/false = 用户填写 / LLM 规划.
   */
  auto_generated?: boolean;
}

export interface ElementData {
  id: string;
  series_slug: string;
  kind: ElementKind;
  name: string;
  description: string;
  tags: ElementTag[];
  images: ElementImage[];
  /** 锁定的主图 = 全项目对齐的「真相」 */
  primary_image_id?: string;
  /** kind 专属字段的松散袋子 */
  attrs: Record<string, unknown>;
  status: "drafted" | "has_images" | "locked";
  created_at: string;
  updated_at: string;
  derived_from?: { series_slug: string; element_id: string };
  /**
   * 2026-05-20 P2: 是否为 LLM 拆分镜时自动建的占位素材.
   * true = 系统自动占位, 用户尚未填充描述/图像; false/undefined = 用户手建或已完善.
   * 替代 fragile 的 description === "auto-extracted placeholder" 字符串判断.
   */
  is_placeholder?: boolean;
  /**
   * 2026-05-19 #8: LLM 规划的「需要几张图」列表(可选,通常由 batchSeries 写入).
   * autoPipelineRunner.runElementImagesStage 会按顺序生图, 第 1 张默认作典型代表.
   * 用户手建素材时可以不填(整阶段对该 element 自动跳过).
   */
  image_briefs?: ImageBrief[];
}

// ─── GenerationRecord (D6: unified with storage ShotGeneration) ───────────────

// 2026-05-18: 改为 number | undefined 与 packages/providers/src/quality/postGenCheck.ts 对齐.
// undefined = 未评分 (缺 Key / decoder / 异常), QualityBadge 必须显示灰色"未评分"态而不是假"中性 0.6 分".
export interface QualityScores {
  composition?: number;
  sharpness?: number;
  prompt_alignment?: number;
  subject_completeness?: number;
  checked_at: string;
}

export interface GenerationRecord {
  generation_id: string;
  type: "first_frame" | "video";
  provider: string;
  asset_id?: string;
  vault_id?: string;
  path?: string;
  picked?: boolean;
  created_at: string;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  /** 兼容旧/新前端候选 DTO */
  seed?: number;
  prompt?: string;
  prompt_used?: string;
  /** C4: 关联 PromptVersion.version, 记录生成时用的 prompt 版本号 */
  prompt_version?: number;
  quality_scores?: QualityScores;
  // ── B2: Generation record 详尽字段 ─────────────────────────
  provider_job_id?: string;
  provider_file_id?: string;
  model_id?: string;
  /** sha1(JSON.stringify(request payload)) */
  request_payload_digest?: string;
  /** 实际发送给 provider 的最终 prompt */
  prompt_final?: string;
  negative_prompt?: string;
  duration_sec_requested?: number;
  duration_sec_actual?: number;
  width?: number;
  height?: number;
  fps?: number;
  bytes?: number;
  cost_cny?: number;
  submitted_at?: string;
  completed_at?: string;
  downloaded_at?: string;
  error_code?: string;
  error_message?: string;
  /**
   * 2026-05-17: 用户手填的候选名 (inline rename).
   * 2026-05-20: 字段名从 user_label 改为 display_name (display_name 体系统一).
   *
   * 给生成的视频/首帧候选起一个易记的名字, 例如 "粗剪 v1" / "高质量版" / "测试".
   * 显示在候选卡片底下, 默认是 provider 名 (e.g. "本地 AnimateDiff 快版").
   * 设了 display_name 优先显示 display_name.
   *
   * 兼容性: 历史 user_label 数据由 readShot 时映射进 display_name.
   */
  display_name?: string;
  /** @deprecated 2026-05-20 兼容老数据: 读时映射到 display_name, 不再新写. */
  user_label?: string;
}

export interface FrameAnchor {
  id: string;
  role: "first" | "end" | "key";
  position: number;
  vault_id?: string;
  asset_id?: string;
  generation_id?: string;
  created_at: string;
}

// ─── Shot (D6: unified with storage ShotData) ─────────────────────────────────

export type ShotStatus = string; // "drafted" | "generating" | "ready" | "picked" | "approved" | "failed"

export interface ShotFailure {
  at: string;
  stage: string;
  error: string;
}

/** C4: Prompt 版本历史记录 (从 shotRepo 搬入) */
export interface PromptVersion {
  version: number;
  content: string;
  created_at: string;
  created_by: "ai" | "user";
}

/**
 * 2026-05-21 Wave Y — Shot 富文本节点 (替代纯文本 + @ token parser 老架构).
 *
 * 用户原话 (撞到画面描述里识别的实体没 chip 化):
 *   "为什么用纯文本? 不应该在 json 里有单独的结构化数据指定这里有引用吗?
 *    单靠@解析文本太不可靠了"
 *
 * 老架构: shot.action = string ("XX 走进 @场景:茶水间, 抓走 @角色:林深"),
 *   每个出入口都要 parser/humanize/strip,边界 case 层出不穷.
 * 新架构: shot.action_nodes = ShotTextNode[],单一真理源:
 *   - 编辑安全 (改 mention.display 不会脏字符串 indices)
 *   - LLM/TTS/字幕出口直接用 derived plain text 不需再 parse
 *   - 前端渲染直接 nodes.map → chip 准确无歧义
 *   - 重名/substring 误匹配/IME 等边界自动消除 (entity_id 是 ID 不是字符串)
 *
 * shot.action 字段保留作 derived plain text (向后兼容 + TTS/字幕直读),
 * 落盘时由 nodesToPlainText(nodes) 自动反 derive.
 */
export type ShotTextNode =
  | { type: "text"; text: string }
  | {
      type: "mention";
      entity_id: string;
      kind: "character" | "scene" | "element";
      display: string;
      /** 单镜级 override: 用这个 entity 的某张特定图作 reference (而非默认 primary) */
      image_id?: string;
    };

export interface Shot {
  id: string;
  series_slug: string;
  episode_id: string;
  index: number;
  duration_sec: number;
  character_ids: string[];
  scene_id?: string;
  /** 统一素材体系: prop/wardrobe/reference 等非角色/场景素材引用 */
  element_ids?: string[];
  /**
   * 2026-05-26 W1 — 本镜出场角色穿的服装造型 element id (kind=wardrobe).
   *
   * 优先级:
   *   shot.wardrobe_id (显式选)
   *   > character.wardrobe_element_ids[0] (角色默认第一套)
   *   > character.outfit 文本 fallback
   *   > 不拼服装描述
   *
   * 注: 本期单镜级单值 (一镜一套), 若需"多角色每人不同套"再做 wardrobe_overrides[].
   *     蕴含约束: shot.character_ids 多角色时, 此值表示"主出场角色"穿的服装.
   */
  wardrobe_id?: string;
  /**
   * 2026-05-26 W1 — 本镜额外出现的道具 element id 列表 (kind=prop).
   *
   * 与 character.prop_element_ids union 后得到本镜真实出现道具集.
   * 用例: 角色平时不带枪, 本镜剧情需要桌上有把枪 → shot.prop_ids 加这把枪.
   */
  prop_ids?: string[];
  shot_type?: string;
  camera_movement?: string;
  /**
   * 2026-05-21 Wave Y — 5 个文本字段的 derived plain text (向后兼容老 caller).
   * 真理源是 *_nodes 字段, 由 nodesToPlainText 自动反 derive.
   * 出口路径 (TTS / 字幕 / display / 字符串 API) 直读这些字段,不需再 parse.
   */
  action?: string;
  dialogue?: string;
  voiceover?: string;
  prompt_img?: string;
  prompt_vid?: string;
  /**
   * 2026-05-21 Wave Y — 5 个文本字段的富文本节点数组 (主存储).
   * 老数据 *_nodes 为 undefined 时, caller 用 plainTextToNodes(action, ctx) 兜底.
   */
  action_nodes?: ShotTextNode[];
  dialogue_nodes?: ShotTextNode[];
  voiceover_nodes?: ShotTextNode[];
  prompt_img_nodes?: ShotTextNode[];
  prompt_vid_nodes?: ShotTextNode[];
  notes?: string;
  style?: string;
  time_of_day?: string;
  lighting?: string;
  mood?: string;
  /** W5-D: 分镜情绪(中性/兴奋/紧张/伤心/愤怒等),进 shotPromptCompiler */
  emotion?: string;
  /** W5-D: 前置过渡(硬切/淡入/叠化等),用于合成时镜间转场 */
  transition_in?: string;
  /** P1-1: 单镜转场持续时间(秒,默认 0.5;与 transition_in 配合使用) */
  transition_duration?: number;
  /**
   * 2026-05-17 voice-sync v1: 单镜级 TTS 声线覆盖.
   *
   * 在 composeEpisode 解析对白做 TTS 时, 优先级最高:
   *   shot.tts_voice_override
   *   > character.voice_style_map[emotion]
   *   > character.voice_id
   *   > series.defaults.tts_voice_id
   *   > 全局默认.
   *
   * 取值为 `tts_voice.json` preset 里的 voice_id (例如 "zh-CN-YunxiNeural").
   * 主要给"这一镜想换个声线"的场景, 不影响其他镜的角色 voice.
   */
  tts_voice_override?: string;
  reference_asset_ids?: string[];
  /** v25: 导入参考图的逐张备注 (asset_id/vault_id -> 用户填的"这是什么") */
  reference_notes?: Record<string, string>;
  /**
   * 2026-05-19 Wave O Entity-first: 单镜级 reference 图 override.
   *
   * 默认 orchestrator 在 buildReferenceSet 用每个 entity (character/scene/element)
   * 的 primary_image 作 reference. 但用户原话考核 case B: 同一素材有多张已 typical
   * 的图时, 这一镜想用第 N 张而不是默认那张 → 在 ShotStage 单镜创作页就近选 (铁律 #4),
   * 选完存到这里, 让本镜 reference 用指定那张图.
   *
   * 数据结构:
   *   - element_id: character.id / scene.id / element.id
   *   - image_id: element.images[i].image_id (asset_id 也行)
   *
   * orchestrator 在拼 reference_images 时, 检查到本字段非空, 该 element 的 reference
   * 用 image_id 对应那张图, 而不是 element.primary_image_id 默认那张.
   * 见 memory feedback_entity_first.md "Case B: 同一素材多张已选的图怎么办".
   */
  reference_overrides?: Array<{
    element_id: string;
    image_id: string;
  }>;
  keyframe_asset_id?: string;
  image_model_ref?: string;
  video_model_ref?: string;
  /** C4: Prompt 版本历史 */
  prompt_img_versions?: PromptVersion[];
  prompt_vid_versions?: PromptVersion[];
  negative_prompt?: string;
  aspect_ratio?: string;
  generations?: GenerationRecord[];
  /** Wave 1C: 分离活动生成与废案箱 */
  active_generations?: GenerationRecord[];
  trashed_generations?: GenerationRecord[];
  frame_anchors?: FrameAnchor[];
  picked_generation_id?: string;
  /** P180 A3: 拆分首帧/视频 pick，各自独立 */
  picked_first_frame_generation_id?: string | null;
  picked_video_generation_id?: string | null;
  /** Wave 1C: 视频生成模式 i2v(图生视频,需首帧) / t2v(文生视频,不需首帧) */
  video_mode?: "i2v" | "t2v";
  status: string;
  failures?: ShotFailure[];
  /** Wave 3B: 是否使用上一镜末帧作为参考 */
  use_prev_last_frame?: boolean;
  /** Wave 3B: 是否已从上一镜末帧生成 */
  first_frame_from_prev?: boolean;
  /** Wave 3B: 本镜视频末帧的 vault_id（供下一镜串联使用） */
  last_frame_vault_id?: string;
  /** P170 metadata generate: 前端展示用 */
  title?: string;
  scene_label?: string;
  visual_prompt?: string;
  /** B3: CLIP 质量警告 — 首帧与 prompt 匹配度 < 0.22 */
  quality_warning?: { score: number; at: string };
  /** B3: 连续性警告 — 与上一镜视觉不一致 */
  continuity_warning?: { reason?: string; at: string };
  /** W7 Phase 4: 单镜入帧裁剪起点(秒,默认 0;留空 = 不裁) */
  trim_start_sec?: number;
  /** W7 Phase 4: 单镜出帧裁剪终点(秒,默认 = duration_sec;留空 = 不裁) */
  trim_end_sec?: number;
  /**
   * @deprecated 2026-05-26 W8 双阶段提交锁已下线 — 用户反馈"这个功能没什么用,
   * 而且让人误以为之前设过的首帧状态丢了". 字段保留以兼容老 db 数据, 但服务端 /
   * 前端均不再读写. 设了首帧就可以直接生视频, 不再要求二次确认.
   */
  ready_for_video?: boolean;
}

// ─── Asset (Step2: 暂不动) ───────────────────────────────────────────────────

export type AssetKind = "image" | "video" | "audio" | "doc";

export interface AssetSource {
  /** 生成类资源 */
  provider_id?: string;
  generation_id?: string;
  /** 用户上传类 */
  upload_original_name?: string;
}

export interface Asset {
  id: string;
  series_slug: string;
  kind: AssetKind;
  mime: string;
  /** "assets/images/xxx.png" 相对 series 根 */
  relative_path: string;
  bytes: number;
  width?: number;
  height?: number;
  /** 视频/音频用 */
  duration_sec?: number;
  /** 角色 id / 场景 id / episode id / 自由标签 */
  tags: string[];
  source: AssetSource;
  created_at: string;
}

// ─── Storyboard (索引文件) ───────────────────────────────────────────────────

export interface StoryboardEntry {
  shot_id: string;
  index: number;
}

export interface Storyboard {
  episode_id: string;
  series_slug: string;
  shots: StoryboardEntry[];
  updated_at: string;
}

// ─── W6-B Multi-version: ScriptVersion / StoryboardVersion ───────────────────
//
// 解决用户痛点 #11 "灵感可以有多条,可以自选其中的哪些条一起生成剧本。剧本可以生产多个版本,
// 每个版本对应的分集分镜也要能分别管理,不要每次生成就把之前生成的覆盖掉了。"
//
// 与既有 SeriesScriptVersion / EpisodeVersion 的区别:
//   - SeriesScriptVersion / EpisodeVersion 是"单线时间轴"(version 数字 + 历史快照),覆盖原 script_md。
//   - ScriptVersion / StoryboardVersion 是"独立命名的多版本",允许并行存在并显式切换 active。
//   - 旧字段继续保留作为"当前激活版本的镜像 / v0 历史",新数据落到 script_versions/ 目录。

/**
 * 剧本版本（W6-B 新版多版本管理）
 *
 * 一个系列可同时存在多个 ScriptVersion 并行 → 用户挑哪个 active。
 * 落盘：data/series/<slug>/script_versions/<id>.json
 */
export interface ScriptVersion {
  /** ulid / nanoid */
  id: string;
  series_slug: string;
  /** 用户可见名称（默认 "剧本 v{N} — {首段}"） */
  title: string;
  /** Markdown 正文 */
  content_md: string;
  /** 用于生成此版本的灵感 ID 列表（对应 inspirations.json 中的 id） */
  source_inspirations: string[];
  /** 用户输入的额外提示词（可选） */
  user_prompt?: string;
  created_at: string;
  /** 是否为当前激活版本（每个 series 同时只有一个 is_active=true） */
  is_active: boolean;
  /** fork 自哪个版本（手动创建新版本时记录） */
  parent_version_id?: string;
  /** 软删标记 */
  _deleted?: boolean;
  /** 软删时间戳 (W-3.4: 用于 180 天过期清理) */
  _deleted_at?: string;
}

/**
 * 分镜版本（W6-B 新版多版本管理）
 *
 * 一个剧集可同时存在多个 StoryboardVersion 并行（绑定不同 script_version）。
 * 落盘：data/series/<slug>/episodes/<ep>/storyboard_versions/<id>.json
 */
export interface StoryboardVersion {
  /** ulid / nanoid */
  id: string;
  series_slug: string;
  episode_id: string;
  /** 用户可见名称 */
  name: string;
  /** 绑定的剧本版本 id（来源） */
  script_version_id: string;
  /** 包含的 shot id 列表（按顺序） */
  shot_ids: string[];
  created_at: string;
  /** 是否为当前激活版本 */
  is_active: boolean;
  /**
   * 2026-07-10 Fable P0-1 — 创建本版本时把上一版旧分镜整批移入垃圾桶的批次 id.
   * "回滚到旧分镜版本"可据此把那批文件从垃圾桶按批搬回(减配版快照, 不整份存 shot 内容).
   */
  trashed_batch_id?: string;
  /** 软删标记 */
  _deleted?: boolean;
  /** 软删时间戳 (W-3.4: 用于 180 天过期清理) */
  _deleted_at?: string;
}

// ─── Storage *Data aliases (Step2: 让 repo re-export 旧名字不破) ──────────────

export type SeriesData = Series;
export type EpisodeData = Episode;
export type CharacterData = Character;
export type ShotData = Shot;
export type ShotGeneration = GenerationRecord;
