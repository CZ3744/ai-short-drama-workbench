/**
 * sourceLabels.ts — T5: 技术字段 → 人话翻译表 (铁律 #9 toC 兜底)
 * 所有候选/废案/Vault 卡片显示 origin / source 时调用 labelOfSource / labelOfStatus
 */

export const SOURCE_LABEL: Record<string, string> = {
  // 图像 / 视频候选来源
  manual_import: "本地导入",
  generated: "AI 生成",
  i2i: "基于图重生",
  imported: "导入",
  from_shot: "分镜回收",
  legacy: "历史素材",
  cross_project_import: "跨项目导入",
  regen: "重新生成",
  cross_element_ref: "引用其他素材",
  // 剧本版本来源（VersionTimeline）
  ai_init: "AI 初版",
  user_edit: "用户编辑",
  ai_revise: "AI 改写",
  revert: "回滚",
  // Provider ID 友好名（ModelPicker / Settings 展示用）
  local_card_image: "本地图像",
  local_sdxl_openclaw: "本地 SDXL",
  chatgpt_codex_image: "ChatGPT 图像",
  local_mock_video: "本地演示视频",
  aliyun_wan_t2v: "阿里云万象",
  minimax_hailuo: "MiniMax 海螺",
  jimeng_video_3pro: "即梦 Pro",
  kling_3: "可灵 3.0",
  vidu_q3_ref: "Vidu Q3",
  zhipu_cogvideox: "智谱 CogVideoX",
  baidu_qianfan_video: "百度千帆视频",
  tencent_hunyuan_video: "腾讯混元视频",
  // 2026-07-09 audit C28: 补图像 provider 覆盖 (config/presets/image_provider.json 真实枚举),
  // 之前只覆盖了 3 个图像源, 消耗榜/锁持有者遇到其余图像 provider 会兜底显示"其他来源".
  jimeng_image_4: "即梦图像 4.0",
  aliyun_wanx_26: "阿里云万相 2.6",
  openai_gpt_image_2: "OpenAI 图像",
  openai_via_codex: "OpenAI (旧版网关)",
  openrouter_gemini_image: "Gemini 图像",
  openrouter_flux_11_pro: "FLUX 图像",
};

export function labelOfSource(s: string | undefined): string {
  if (!s) return "未知来源";
  // 铁律 #9 toC 兜底: 未命中 SOURCE_LABEL 时不再回退到原始 enum (如 "scoped_import" / "remote_clone"
  // 这些技术枚举直接显给用户). VaultPage / FirstFrameTile / ElementImageGrid / RejectPoolSection 均
  // 把本函数返回值当显示标签用, 这里是最后一道翻译关. 兜底走"其他来源"即可,
  // 真要补名字时去 SOURCE_LABEL 加.
  return SOURCE_LABEL[s] ?? "其他来源";
}

/**
 * 判断 source enum 是否有翻译条目 — caller 想做"origin 是否可信任作为显示"的判断时用,
 * 不要再用 `labelOfSource(s) !== "未知来源"` 这种字符串硬编码模式 (兜底字符串变了就误判).
 */
export function hasSourceLabel(s: string | undefined): boolean {
  return !!s && s in SOURCE_LABEL;
}

// 2026-07-22 Y5 (UP-4): 免费/本地图像 provider 口径 — 与后端 imageDryRun.ts 的
// IMAGE_KEYLESS_PROVIDERS 一致 (dry-run 的 is_keyless 正由该集合算出), 也是
// KEYLESS_PROVIDER_IDS (providerController/shared.ts:157) 的图像子集.
// 用途: 费用确认门文案分流 — 这三条渠道不计费, 任何弹窗绝不出现"扣费"字样.
// 免费性权威来源优先用后端 dry-run 返回的 `is_keyless`; 本前端集合仅在 dry-run
// 失败 (拿不到 is_keyless) 时按 model_ref 兜底判定, 二者口径保持一致.
const KEYLESS_IMAGE_PROVIDER_IDS = new Set([
  "local_card_image",
  "local_sdxl_openclaw",
  "chatgpt_codex_image",
]);

/**
 * 是否为"免费/本地、不计费"的图像 provider. 入参可为裸 provider id 或完整
 * model_ref ("local_card_image:xxx"). 命中即代表该渠道零费用, 确认门/预估失败
 * 文案不得出现"扣费/费用"恐吓 (UP-4).
 */
export function isKeylessImageProvider(providerOrModelRef: string | undefined | null): boolean {
  const trimmed = typeof providerOrModelRef === "string" ? providerOrModelRef.trim() : "";
  if (!trimmed) return false;
  const idx = trimmed.indexOf(":");
  const pid = (idx >= 0 ? trimmed.slice(0, idx) : trimmed).trim();
  return KEYLESS_IMAGE_PROVIDER_IDS.has(pid);
}

// 2026-05-18: 修拼写 + 覆盖全 shot.status 枚举.
// 历史: `drafted` 拼错(实际后端 shotRepo.ts:123 是 `draft`), 漏 `planned` / `generated` / `approved`.
// 现: 覆盖 6 个真实 shot 状态 + 任务状态混合, fallback 不再回退到原 enum 而是显式 "未知".
export const STATUS_LABEL: Record<string, string> = {
  // 任务态 (image/video gen task)
  pending: "排队中",
  running: "生成中",
  done: "完成",
  failed: "失败",
  rejected: "已废弃",
  // 分镜 shot.status (apps/server/src/api/v2/shotRepo.ts 等)
  draft: "草稿",
  drafted: "草稿",          // 历史拼写保留兼容
  planned: "已规划",
  generating: "生成中",
  generated: "已生成",
  picked: "已挑卡",
  ready: "待挑选",
  approved: "已选定",
  locked: "已锁定",
  // 素材通用
  has_images: "有图",
};

export function labelOfStatus(s: string | undefined): string {
  if (!s) return "";
  return STATUS_LABEL[s] ?? "未知状态";
}

// 2026-05-18 SSE / 任务流 stage 字段翻译表 (铁律 #9 toC 兜底).
// 来源: orchestrator emit / composeEpisode emit / SSE event types.
// 用户在 GlobalQueuePanel / CockpitPage 看到 evt.stage / job.stage / queue.stage 字段.
export const STAGE_LABEL: Record<string, string> = {
  // 通用
  pending: "等待中",
  queued: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已中止",
  // 图像生成
  firstframe: "首帧生成",
  first_frame: "首帧生成",
  lastframe: "尾帧生成",
  last_frame: "尾帧生成",
  image: "图像生成",
  image_gen: "图像生成",
  reference: "参考图生成",
  // 视频生成
  video: "视频生成",
  video_gen: "视频生成",
  video_render: "视频渲染",
  // 剧本 / 分镜流水线
  scene_planning: "拆场",
  storyboard: "拆分镜",
  awaiting_storyboard_review: "等待分镜审批",
  script_expand: "剧本扩写",
  // 合成 / 导出
  compose: "合成中",
  "compose.start": "合成开始",
  "compose.stage": "合成阶段推进",      // SSE compose.stage 顶层事件
  "compose.progress": "合成进度更新",   // SSE compose.progress 百分比事件
  "compose.rough.start": "粗剪开始",
  "compose.rough.concat": "粗剪拼接",
  "compose.rough.burning": "字幕烧录(粗)",
  "compose.rough.done": "粗剪完成",
  "compose.tts": "配音生成",
  "compose.subtitle": "字幕生成",
  "compose.concat": "片段拼接",
  "compose.burn": "字幕烧录",
  "compose.burning": "字幕烧录",        // compose.stage 推 stage="burning"
  "compose.done": "合成完成",
  "compose.error": "合成失败",          // SSE 真实事件名
  "compose.failed": "合成失败",
  "compose.shot": "处理分镜",           // compose.shot 单镜事件
  export: "导出",
  render: "渲染",
  cover: "封面生成",
  // 质量检查
  quality_check: "质量评估",
};

// 2026-05-22 P0-D: SSE compose.stage 事件推的 data.stage 是裸值 ("concat"/"burning"/
// "shot"/"tts"/"render"), 不带 "compose." 前缀. labelOfStage 先查这张裸值表,
// 否则 "concat" 会走兜底变成笼统的"合成中" — 不够精确.
const BARE_STAGE_LABEL: Record<string, string> = {
  concat: "片段拼接",
  burning: "字幕烧录",
  burn: "字幕烧录",
  shot: "处理分镜",
  tts: "配音生成",
  subtitle: "字幕生成",
  render: "渲染导出",
  prepare: "准备素材",
  done: "合成完成",
  error: "合成失败",
};

export function labelOfStage(s: string | undefined): string {
  if (!s) return "";
  const hit = STAGE_LABEL[s];
  if (hit) return hit;
  const bareHit = BARE_STAGE_LABEL[s];
  if (bareHit) return bareHit;
  // 2026-05-22: fallback 不再回退原值 (违反铁律 #9 toC 兜底).
  // 旧版返 raw enum 像 "compose.progress" 直接暴露给用户.
  // 新: 按命名规律推中文人话:
  //   "compose.*" → "合成中"
  //   "generate.*" → "生成中"
  //   "*.done" → "已完成"
  //   "*.error" / "*.failed" → "失败"
  //   "*.progress" → "进度更新"
  //   兜底 "处理中"
  if (s.startsWith("compose.")) {
    if (s.endsWith(".done")) return "合成完成";
    if (s.endsWith(".error") || s.endsWith(".failed")) return "合成失败";
    if (s.endsWith(".progress")) return "合成进度更新";
    return "合成中";
  }
  if (s.startsWith("generate.") || s.startsWith("gen.")) {
    if (s.endsWith(".done")) return "已生成";
    if (s.endsWith(".error") || s.endsWith(".failed")) return "生成失败";
    return "生成中";
  }
  if (s.startsWith("task.")) {
    if (s.endsWith(".queued")) return "排队中";
    if (s.endsWith(".running") || s.endsWith(".progress")) return "进行中";
    if (s.endsWith(".succeeded") || s.endsWith(".done")) return "已完成";
    if (s.endsWith(".failed") || s.endsWith(".error")) return "失败";
    return "进行中";
  }
  if (s.endsWith(".done")) return "已完成";
  if (s.endsWith(".error") || s.endsWith(".failed")) return "失败";
  if (s.endsWith(".progress")) return "进度更新";
  return "处理中";
}

// 2026-05-17 P2.3: 失败中心的 error_code 翻成中文 (铁律 #9 toC 兜底)
// 来源:apps/server/src/{failureController,episodeUseCases,planEpisodeStoryboard,planSeriesStoryboard,orchestrator}.ts
export const ERROR_CODE_LABEL: Record<string, string> = {
  missing_key: "缺 API Key",
  insufficient_balance: "余额不足",
  timeout: "超时",
  content_filter: "内容审核拦截",
  invalid_output: "返回无效",
  invalid_request: "请求参数不合法",
  budget_exceeded: "预算超限",
  all_providers_failed: "全部模型不可用",
  provider_failed: "模型服务报错",
  local_fallback_used: "已用本地兜底",
  rate_limit: "调用过快(请稍后重试)",
  rate_limited: "调用过快(请稍后重试)",
  quota_exceeded: "配额已用完",
  network_error: "网络异常",
  parse_error: "返回内容无法解析",
  validation_error: "参数不合法",
  not_found: "资源不存在",
  forbidden: "权限不足",
  unauthorized: "未登录或鉴权失败",
  llm_unavailable: "AI 模型全部不可用",
  LLMUnavailable: "AI 模型全部不可用",
  provider_not_selected: "未选模型",
  unknown: "未知错误",
  // 2026-07-22 X5-2 (A4-7): 补 4 个真实会抛但漏翻译的 ProviderErrorCode (packages/providers/src/core/errors.ts).
  // server 是 50+ 处 provider 5xx/不可预期响应的通用兜底码, 出现频率最高, 之前一直显示"未知错误".
  server: "模型服务出错，稍后重试",
  content_policy: "内容审核拦截",
  invalid_prompt: "提示词参数不合法",
  model_warming: "模型预热中，请稍候",
};

export function labelOfErrorCode(s: string | undefined): string {
  if (!s) return "";
  // 2026-05-27 — toC 兜底 (铁律 #9): 没翻译表条目不暴露原始 enum (例 "rate_limit_v2" /
  // 后端新加的代码), 返回"未知错误"提示用户看下方详情. 想加新映射去补 ERROR_CODE_LABEL.
  return ERROR_CODE_LABEL[s] ?? "未知错误";
}

// 2026-07-22 X5-3 (A4-3): 原 SHOT_TYPE_LABEL/CAMERA_MOVEMENT_LABEL/TRANSITION_LABEL 三个常量表 +
// labelOfShotType/labelOfCameraMovement/labelOfTransition 三个函数已删除 — 全仓库 grep 确认 0 调用,
// 是 2026-05-26 引入后从未被接线的重复死代码(真正渲染路径是 shotMetaPresets.ts / cameraMovementPresets.ts
// 那一套 *DisplayLabel 函数, 且原实现 fallback 回裸 enum 值本身也违反铁律 #9, 一并清理避免以后接错翻译源).

// 2026-05-26 Codex P2-7: episode id "ep01" → "第 1 集" 让用户能读懂.
export function labelEpisodeId(epId: string | null | undefined): string {
  if (!epId) return "未知集";
  // "ep01" / "ep1" / "ep001" 这种格式 → 第 N 集
  const m = epId.match(/^ep0*(\d+)$/i);
  if (m) return `第 ${parseInt(m[1], 10)} 集`;
  return epId;
}

/**
 * 2026-05-21 P1: shot_id 技术字符串 → 人话 (铁律 #9 toC 兜底)
 *
 * 支持两种前缀:
 *   - "shot_001" → "分镜 1", "shot_abc123" → "分镜 abc123"
 *   - "s0001"    → "分镜 1", "s12" → "分镜 12"  (2026-05-26 audit #4: 合并 FailureCenter 本地实现)
 * 凡是把 shot_id 直接 render 给用户的位置都用此函数.
 *
 * @param shotId  e.g. "shot_001", "s0001", "shot_abc123", undefined
 */
export function labelShotId(shotId: string | null | undefined): string {
  if (!shotId) return "未知分镜";
  // 2026-05-27 扩支持 "s0001_49d1" 这种 ID + hash 后缀格式 (orchestrator 新生成的 shot id)
  // 之前 ^s0*\d+$ 严格匹配, 含 _hash 走 fallback 显示 "分镜 s0001_49d1" 暴露技术字段.
  const sMatchWithHash = shotId.match(/^s0*(\d+)(?:[_-][a-z0-9]+)?$/i);
  if (sMatchWithHash) return `分镜 ${parseInt(sMatchWithHash[1], 10)}`;
  // 再去掉前缀 "shot_", 再做数字检测, 纯数字 → "分镜 N"
  const raw = shotId.startsWith("shot_") ? shotId.slice(5) : shotId;
  const num = parseInt(raw, 10);
  if (!isNaN(num) && String(num) === raw) return `分镜 ${num}`;
  return "未编号分镜";
}

/**
 * 2026-05-27: 把 provider 抛的原始错误信息转成 toC 友好的人话.
 * 用户原话报告"失败明细显示了 HTTP 429 Too Many Requests + JSON 内部字段, 没 toC 化".
 *
 * 翻译策略 — 按关键词匹配, 优先级从严到松:
 *   - 429 / usage_limit / quota → ChatGPT 配额用完, 等待重置或换模型
 *   - 502 / Bad Gateway → 服务暂不可用, 稍后重试
 *   - safety / rejected → 触发安全审核, 软化敏感词或换模型
 *   - fetch failed / terminated → 网络中断, 稍后重试
 *   - timeout → 调用超时, 稍后重试
 *   - missing key → 缺 API Key
 *   - 其他: 取第一行 / 前 100 字, 不暴露 JSON 详情
 *
 * 用在 AutoPipelineProgressPanel 失败明细等任何展示 task.error 的位置.
 */
export function friendlyTaskError(raw: string | null | undefined): string {
  if (!raw) return "未知错误";
  const s = String(raw);
  // 高频 ChatGPT 报错 (按关键词排序)
  if (/usage[_ -]?limit|usage_limit_reached|quota|429|Too Many Requests/i.test(s)) {
    return "ChatGPT 配额已用完,请等待重置(通常 1 小时)或在设置切换为本地 SDXL / Gemini / 即梦";
  }
  if (/safety_violations|rejected by the safety|safety system/i.test(s)) {
    return "触发了安全审核拦截(常见于暴力/血腥/医学敏感描述), 请软化提示词或换模型";
  }
  if (/502|Bad Gateway|503|Service Unavailable|504/i.test(s)) {
    return "图像服务暂时不可用 (服务端 5xx), 稍后重试";
  }
  if (/fetch failed|terminated|ECONNRESET|ETIMEDOUT|socket hang up/i.test(s)) {
    return "网络中断或被服务端断开, 请稍后重试";
  }
  if (/timeout/i.test(s)) {
    return "调用超时, 请稍后重试";
  }
  // 2026-05-27 扩匹配 — 后端 provider 抛 "Zhipu API key not configured" / "MiniMax API key not configured"
  // 这类无 underscore 的英文短句, 老正则 missing[_ ]?key 不命中导致兜底乱码. 增三个 pattern:
  //   1. "api key not configured" / "api_key not present"
  //   2. "no api key" / "no api_key"
  //   3. "401" / "unauthorized" — 但仅在含 key/认证 关键词时
  if (/missing[_ ]?key|认证失败|令牌过期|invalid api[_ ]?key|api[_ \-]?key (not |未)(configured|present|set|配置|填|提供)|no api[_ ]?key/i.test(s)) {
    return "缺 API Key 或令牌过期, 请去设置页填写对应模型的 Key";
  }
  if (/401\b|unauthorized|forbidden/i.test(s) && /key|token|认证|授权/i.test(s)) {
    return "API Key 鉴权失败 (401 / 未授权), 请到设置页检查 Key 是否正确";
  }
  // 视频锁占用 (P0 真实视频锁) — 单独识别给清晰提示
  if (/real[_ ]?lock|视频锁|lock held|lock acquired/i.test(s)) {
    return "真实视频锁被其他任务占用, 等当前生成完成后再试";
  }
  // 配额 / 余额
  if (/insufficient.?balance|余额不足|余额[不未]|balance[ _-]?(low|exhausted)/i.test(s)) {
    return "账户余额不足, 请到对应模型平台充值";
  }
  if (/budget|预算/i.test(s) && /exceed|超|耗尽|out of/i.test(s)) {
    return "已超过本日 / 本作业预算上限, 请到设置页调高或等待重置";
  }
  if (/invalid_request|参数无效|ValidationError/i.test(s)) {
    return "请求参数不合法, 提示词或模型配置可能有问题";
  }
  // 2026-07-22 Y5 (UP-5): 引用素材文件缺失 — journey 实景 leak 就在这条 task error
  // ("无法读取参考资源 asset asset_xxx: F:\..."). Y2 已把源头 resolveRef 改人话无路径,
  // 此处再兜底旧格式 raw, 保证展示层零"参考资源+路径+id"泄漏.
  if (/无法读取参考资源|无法读取.{0,6}参考|参考资源.{0,4}(缺失|不存在|无法读取)|reference (image |asset )?(not found|missing|unreadable)/i.test(s)) {
    return "引用的素材文件缺失了, 请重新导入或重新挑选参考图";
  }
  // 2026-07-22 Y5 (UP-5): 本地 SDXL 未配置 — 防御英文裸串 (Y1 源头已中文人话).
  if (/python_path|executor\.(python|script)|not configured in preset/i.test(s)) {
    return "本地 SDXL 图像模型还没配置好, 请到设置页补全本地图像模型配置, 或先选「本地卡片图 · 免费」出图";
  }
  // 兜底: 取第一行, 截断到 100 字, 不暴露 JSON / stack / 内网绝对路径 / 内部 asset id
  const firstLine = s.split(/\r?\n/)[0] || s;
  const cleaned = firstLine
    .replace(/\{.*\}/g, "")  // 去 JSON 块
    .replace(/请求使用 Responses 顶层模型[^—]*—\s*/g, "")  // 去内部模型 ID
    // UP-5: 内网绝对路径 (Windows 盘符 + 反斜杠) / 内部 asset id → 人话占位, 防糊脸
    .replace(/[A-Za-z]:\\[^\s"'<>|)\]]+/g, "[本地文件]")
    .replace(/\basset_\d{6,}_[A-Za-z0-9-]+/g, "素材")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 100 ? cleaned.slice(0, 100) + "…" : cleaned;
}

/**
 * resolveTaskFailureMessage — 2026-05-27 公共失败错误解析器 (解耦点).
 *
 * 用户痛点: 之前 useVideoGeneration 和 useImageGeneration 各自写了一份"failed
 * 分支拉 error_message + friendlyTaskError"的逻辑, 视频侧改了图像侧没改, 用户
 * 截图就出现"首帧生成失败" + 一坨 HTML 502 body, 跟视频侧不一致.
 *
 * 现在收敛到一处: 两个 hook 都调这个函数, 改这一份等于两边都改.
 *
 * 返回 { friendly, raw } — friendly 是人话翻译 (toC 兜底, 给 toast / 卡片精简显
 * 示用), raw 是后端原始字符串 (给"看完整错误"modal 用). raw 为空字符串表示
 * tasksStore 里没拿到, 此时 friendly 走默认占位.
 *
 * Reactless 调用 (useTasksStore.getState()) — 在 hook 的 SSE 回调 / event handler
 * 里就能用, 不需要 React 上下文.
 */
import { useTasksStore, shotIndexKey } from "../stores/tasksStore";

export function resolveTaskFailureMessage(
  targetId: string,
  kind: "image" | "video" | "tts" | "llm" | "compose",
  fallbackFriendly: string,
  // 2026-05-28 P0#12: 接 seriesSlug 防跨 series shotId 污染. 老 caller 不传时
  // 走 shotIndexKey(undefined, ...) 兜底 key, 兼容旧 task.
  seriesSlug?: string,
): { friendly: string; raw: string } {
  let raw = "";
  try {
    const store = useTasksStore.getState();
    const key = shotIndexKey(seriesSlug, targetId, kind as Parameters<typeof shotIndexKey>[2]);
    const tid = store.taskKindByShot[key];
    if (tid) raw = store.tasks[tid]?.error_message ?? "";
  } catch { /* noop — tasksStore 取错就走 fallback */ }
  const friendly = raw ? friendlyTaskError(raw) : fallbackFriendly;
  return { friendly, raw };
}
