/**
 * dialogueParser — 剧本对白语法解析器
 *
 * 识别两种格式:
 *   角色名(情绪): 内容
 *   角色名: 内容
 *
 * 返回 { character_name, emotion, text }[] 数组
 */

export interface DialogueLine {
  character_name: string;
  emotion: string | null;
  text: string;
}

/** 情绪标签中文 → 英文映射 (用于 voice_style_map key 匹配) */
const EMOTION_CN_TO_EN: Record<string, string> = {
  "哭": "crying",
  "哭泣": "crying",
  "悲伤": "sad",
  "伤心": "sad",
  "难过": "sad",
  "怒": "angry",
  "愤怒": "angry",
  "生气": "angry",
  "冷": "cold",
  "冷漠": "cold",
  "笑": "laugh",
  "大笑": "laugh",
  "开心": "happy",
  "高兴": "happy",
  "喜悦": "happy",
};

/** 正则: 角色名(可选情绪): 或 角色名：内容 */
const DIALOGUE_RE = /^([^(：:\n]+)(?:\(([^)]+)\))?[：:]\s*(.+)$/;

/**
 * 解析剧本纯文本, 提取对白行
 * @param scriptText - 完整剧本或对白段落文本
 * @returns 对白行数组, 格式 { character_name, emotion, text }
 */
export function parseDialogue(scriptText: string): DialogueLine[] {
  const lines = scriptText.split(/\r?\n/);
  const result: DialogueLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(DIALOGUE_RE);
    if (!match) continue;

    const rawEmotion = match[2]?.trim() ?? null;
    const emotion = rawEmotion
      ? (EMOTION_CN_TO_EN[rawEmotion] ?? rawEmotion.toLowerCase())
      : null;

    result.push({
      character_name: match[1].trim(),
      emotion,
      text: match[3].trim(),
    });
  }

  return result;
}

/**
 * 根据 emotion 和 voice_style_map 解析实际使用的 voice_id
 * 优先级: voice_style_map[emotion] > voice_style_map.default > fallbackVoiceId
 */
export function resolveVoiceForEmotion(
  voiceStyleMap: Record<string, string | undefined> | undefined,
  emotion: string | null,
  fallbackVoiceId: string,
): string {
  if (!voiceStyleMap) return fallbackVoiceId;

  if (emotion && voiceStyleMap[emotion]) {
    return voiceStyleMap[emotion]!;
  }

  if (voiceStyleMap.default) {
    return voiceStyleMap.default;
  }

  return fallbackVoiceId;
}
