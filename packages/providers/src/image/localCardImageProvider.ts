// P20: Local Card Image Provider — fallback using existing local_card_image logic

import type { PresetOption } from "../../../core/src/presetSchema";
import type { ImageProvider, ImageGenerateRequest, ImageGenerateResponse, ProviderContext, HealthCheckResult } from "../core/types";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapText(text: string, maxChars = 18): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return ["本地占位图"];
  const lines: string[] = [];
  for (let i = 0; i < cleaned.length && lines.length < 4; i += maxChars) {
    lines.push(cleaned.slice(i, i + maxChars));
  }
  return lines;
}

async function renderCardPng(req: ImageGenerateRequest, index: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const palettes = [
    ["#172033", "#3B82F6"],
    ["#1D2A22", "#22C55E"],
    ["#2D1B22", "#F97316"],
    ["#1F2336", "#A855F7"],
    ["#24211A", "#EAB308"],
  ];
  const [bg, accent] = palettes[index % palettes.length];
  const width = req.width;
  const height = req.height;
  const fontSize = Math.max(24, Math.floor(width / 24));
  const lines = wrapText(req.prompt, Math.max(12, Math.floor(width / 62)));
  const lineHeight = Math.floor(fontSize * 1.45);
  const totalHeight = lines.length * lineHeight;
  const startY = Math.floor((height - totalHeight) / 2);
  const textSvg = lines
    .map((line, i) => `<text x="50%" y="${startY + i * lineHeight}" text-anchor="middle">${escapeXml(line)}</text>`)
    .join("");

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="${bg}"/>
      <stop offset="1" stop-color="#0B1020"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="${Math.floor(width * 0.06)}" y="${Math.floor(height * 0.08)}" width="${Math.floor(width * 0.88)}" height="${Math.floor(height * 0.84)}" rx="${Math.floor(width * 0.025)}" fill="none" stroke="${accent}" stroke-width="${Math.max(3, Math.floor(width / 260))}" opacity="0.55"/>
  <circle cx="${Math.floor(width * 0.86)}" cy="${Math.floor(height * 0.16)}" r="${Math.floor(width * 0.055)}" fill="${accent}" opacity="0.25"/>
  <g fill="#F8FAFC" font-family="Microsoft YaHei, PingFang SC, Arial, sans-serif" font-size="${fontSize}" font-weight="700">
    ${textSvg}
  </g>
  <text x="${Math.floor(width * 0.08)}" y="${Math.floor(height * 0.9)}" fill="#CBD5E1" font-family="Arial, sans-serif" font-size="${Math.max(14, Math.floor(width / 52))}">local_card_image · draft ${index + 1}</text>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

export class LocalCardImageProvider implements ImageProvider {
  readonly id: string = "local_card_image";

  constructor(_cfg: PresetOption, _apiKey: string | null) {}

  async generate(req: ImageGenerateRequest, ctx: ProviderContext): Promise<ImageGenerateResponse> {
    const count = Math.max(1, Math.min(12, Math.floor(req.count || 1)));
    // 2026-05-16 渐进式落盘: 改 Promise.all 为 for await — 与 chatgpt_codex 一致,
    // 让 on_image_ready 能 "回来一张落盘一张".
    const images: ImageGenerateResponse["images"] = [];
    for (let i = 0; i < count; i += 1) {
      const img = {
        buffer: await renderCardPng(req, i),
        mime: "image/png",
        width: req.width,
        height: req.height,
      };
      images.push(img);
      if (req.on_image_ready) {
        try {
          await req.on_image_ready(img, i, count);
        } catch (cbErr) {
          ctx.log(
            "warn",
            `[local_card_image] on_image_ready 回调失败 (index=${i}): ${
              cbErr instanceof Error ? cbErr.message : cbErr
            }`,
          );
        }
      }
    }
    ctx.log("info", `[local_card_image] generated ${images.length} local fallback card(s)`);

    return {
      images,
      cost: { currency: "CNY", amount: 0, basis: "measured" },
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return { ok: true };
  }

  estimateCost(_req: ImageGenerateRequest): { cny: number; basis: "accurate" } {
    return { cny: 0, basis: "accurate" };
  }
}
