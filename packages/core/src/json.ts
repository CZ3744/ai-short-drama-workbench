export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  const firstArray = trimmed.indexOf("[");
  const lastArray = trimmed.lastIndexOf("]");

  if (firstObject >= 0 && lastObject > firstObject) {
    return trimmed.slice(firstObject, lastObject + 1);
  }
  if (firstArray >= 0 && lastArray > firstArray) {
    return trimmed.slice(firstArray, lastArray + 1);
  }
  return trimmed;
}

export function parseMaybeJson<T>(text: string): T {
  const jsonText = extractJsonText(text);
  try {
    return JSON.parse(jsonText) as T;
  } catch {
    // v0.2.4: fall back to light repair (trailing commas + unterminated
    // brackets) before giving up. Mirrors schema.ts tryJsonRepair so MiMo
    // and other chatJson callers match IKunCode's robustness.
    try {
      const repaired = jsonText
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/[\r\n]+/g, "\n");
      return JSON.parse(repaired) as T;
    } catch {
      throw new Error("parseMaybeJson: content not valid JSON: " + jsonText.slice(0, 200));
    }
  }
}

export function compactSummary(value: unknown, max = 500): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    // circular references etc.
    text = "[unstringifiable]";
  }
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
