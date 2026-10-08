// W8-D · CharacterVoiceTable
//
// 多角色 TTS 声线绑定表 — 给每个角色就近绑定独立 voice id, 缺省走"使用默认 (ttsVoice)"。
//
// 设计原则:
//   - 12 条铁律 #3 信息直接可见: 表格默认展开 (无折叠/无 expand 按钮),
//     传入即渲染。
//   - 铁律 #4 就近决策: voice picker 紧贴角色名同一行,不集中放页面顶部。
//   - 铁律 #11 按钮有名字: 没有 icon-only 按钮; "使用默认"通过 PresetSelect
//     的 placeholder 暗示, 用户主动改动才覆盖默认。
//   - 铁律 #9 toC 兜底: 字段名"声线"而不是 voice_id, "默认"而不是 fallback。
//
// 数据契约:
//   characters[]: useCharacters() 返回的角色列表 (含 id + name)
//   voicePerCharacter: 当前已设的覆盖 { [characterId]: voice_id }; 缺角色 = 用全局默认。
//   defaultVoice: 全局兜底 voice (ComposeSettingsDrawer 的 ttsVoice state)。
//   ttsProviderId: 决定 PresetSelect 的 tts_voice 字典走哪个 provider 的选项。
//   onChange: 触发回写, 缺省的 key 删掉而非传空串 — 让后端清楚知道用默认 vs 显式空。
//
// 上层 (ComposeSettingsDrawer / 触发 compose 时) 会把 voicePerCharacter 映射到
// 后端 voice_style_map 契约一起送过去。

import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
// 2026-05-29 P0-3: 每角色声线选择器换成 VoiceSelector(compact), 自带 ▶ 试听按钮 —
// 之前用无试听的 PresetSelect, 用户给每个角色配完 voice 只能等整集合成跑完才知道对不对路.
// VoiceSelector 走 /api/v2/tts/preview 后端合成 1 秒样本即时试听, 空值语义 = 跟随默认 (同 PresetSelect).
import { VoiceSelector } from "../element/VoiceSelector";

export interface CharacterVoiceTableCharacter {
  id: string;
  name: string;
}

export interface CharacterVoiceTableProps {
  characters: CharacterVoiceTableCharacter[];
  voicePerCharacter: Record<string, string>;
  defaultVoice?: string;
  ttsProviderId?: string;
  onChange: (next: Record<string, string>) => void;
}

export function CharacterVoiceTable({
  characters,
  voicePerCharacter,
  defaultVoice,
  ttsProviderId,
  onChange,
}: CharacterVoiceTableProps) {
  if (characters.length === 0) {
    return (
      <div
        style={{
          padding: "12px 14px",
          borderRadius: 10,
          border: "1px dashed var(--ink-200)",
          background: "var(--ink-25, rgba(0,0,0,0.02))",
          color: "var(--ink-500)",
          fontSize: 12.5,
        }}
      >
        本集还没角色 — 默认 voice 会用在所有字幕。可去角色页或剧本页先建角色。
      </div>
    );
  }

  function handleSet(charId: string, voiceId: string) {
    const next = { ...voicePerCharacter };
    if (!voiceId || voiceId === defaultVoice) {
      // 选回默认 = 删 override (清空记录,不传空串)
      delete next[charId];
    } else {
      next[charId] = voiceId;
    }
    onChange(next);
  }

  function handleClear(charId: string) {
    const next = { ...voicePerCharacter };
    delete next[charId];
    onChange(next);
  }

  // 2026-05-18: 单角色情形 — 改成紧凑 chip 横条, 节约 70% 高度
  // 用户截图显示只 1 个角色"小明"时,留白比内容多, 视觉低效.
  // 单角色用 grid 2 列 (角色名 + voice picker) inline, 不显示清除按钮.
  if (characters.length === 1) {
    const ch = characters[0];
    const current = voicePerCharacter[ch.id] || "";
    const isOverride = !!current;
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderRadius: 10,
          border: "1px solid var(--ink-150)",
          background: "var(--surface-card)",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "2px 8px",
            borderRadius: 999,
            background: "var(--ink-50)",
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ink-800)",
          }}
          title={isOverride ? `已设独立声线: ${current}` : "走全局默认音色"}
        >
          <Icon name="user" size={11} className="text-[var(--ink-500)]" />
          <span style={{ maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</span>
        </div>
        {/* 2026-05-29 P0-3: VoiceSelector compact 自带 ▶ 试听; 空 = 跟随默认音色 (语义同旧 PresetSelect) */}
        <VoiceSelector
          value={current}
          providerId={ttsProviderId}
          onChange={(v) => handleSet(ch.id, v)}
          previewText={`你好，我是${ch.name}，这是这个角色的配音试听。`}
          compact
        />
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--ink-150)",
        background: "var(--surface-card)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.06em",
          color: "var(--ink-500)",
          textTransform: "uppercase",
          marginBottom: 2,
        }}
      >
        <Icon name="users" size={12} />
        <span>每角色声线覆盖</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>
          缺省走默认 voice
        </span>
      </div>

      {/* 2026-05-29 P0-3: 多角色每行改"上名+清除 / 下整行 VoiceSelector"两行布局.
          原 3 列横排 (名|picker|清除) 在 280px 左栏塞 VoiceSelector compact (select+▶试听+查看请求)
          会挤爆. 竖排让试听按钮有空间, 每个角色当场能 ▶ 试听该 voice. */}
      {characters.map((ch) => {
        const current = voicePerCharacter[ch.id] || "";
        const isOverride = !!current;
        return (
          <div
            key={ch.id}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "8px 4px 4px",
              borderTop: "1px solid var(--ink-100)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <Icon name="user" size={12} className="text-[var(--ink-400)]" />
              <span
                style={{
                  fontSize: 13, fontWeight: 650, color: "var(--ink-900)",
                  flex: 1, minWidth: 0,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
              >
                {ch.name}
              </span>
              <Button
                variant="secondary"
                size="xs"
                iconLeft="refresh"
                disabled={!isOverride}
                title={isOverride ? "清除该角色的覆盖,改回默认 voice" : "未覆盖,无需清除"}
                onClick={() => handleClear(ch.id)}
              >
                清除覆盖
              </Button>
            </div>
            <VoiceSelector
              value={current}
              providerId={ttsProviderId}
              onChange={(v) => handleSet(ch.id, v)}
              previewText={`你好，我是${ch.name}，这是这个角色的配音试听。`}
              compact
            />
          </div>
        );
      })}
    </div>
  );
}

export default CharacterVoiceTable;
