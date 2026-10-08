/**
 * TagSelect — chip 选项 + 自定义输入(关键参数区,景别/时间段/打光等).
 * 视觉零变更. 从 ShotStagePage 拆出 (P2 #16).
 */
import { inputStyle } from "./styles";

export function TagSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {options.map((o) => (
          // 保留原因: mk-chip 已建立的非-mk-btn 语义 class (规则 1) — tag 选项 chip 形态
          <button
            key={o}
            type="button"
            onClick={() => onChange(value === o ? "" : o)}
            className={value === o ? "mk-chip mk-chip--brand" : "mk-chip"}
            style={{ cursor: "pointer", height: 24, fontSize: 11, padding: "0 8px" }}
          >
            {o}
          </button>
        ))}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="自定义(直接输入)"
        style={{ ...inputStyle, height: 28, fontSize: 11.5 }}
      />
    </div>
  );
}
