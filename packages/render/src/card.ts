import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ensureDir, resolveVideoFormat, type JobLogger, type SceneManifest, type SceneManifestScene } from "../../core/src/index";

export async function generateSceneAssets(manifest: SceneManifest, jobRoot: string, logger: JobLogger, sceneIds?: number[]) {
  const assetsDir = path.join(jobRoot, "assets");
  await ensureDir(assetsDir);
  const format = resolveVideoFormat({ resolution: manifest.resolution, aspectRatio: manifest.aspect_ratio });
  const selected = sceneIds?.length ? new Set(sceneIds) : null;
  for (const scene of manifest.scenes) {
    const existingAsset = scene.asset_path ? path.join(jobRoot, scene.asset_path) : "";
    const shouldRender = !selected || selected.has(scene.scene_id) || !(await exists(existingAsset));
    if (!shouldRender) {
      await logger.line(`Asset kept for scene ${scene.scene_id}: ${scene.asset_path}`);
      continue;
    }
    const svg = renderSceneSvg(manifest, scene, format.width, format.height);
    const svgPath = path.join(assetsDir, `scene-${pad(scene.scene_id)}.svg`);
    const pngPath = path.join(assetsDir, `scene-${pad(scene.scene_id)}.png`);
    await fs.writeFile(svgPath, svg, "utf8");
    await sharp(Buffer.from(svg)).png({ quality: 96 }).toFile(pngPath);
    scene.asset_path = relative(jobRoot, pngPath);
    scene.status = "asset_ready";
    await logger.line(`Asset ready for scene ${scene.scene_id}: ${scene.asset_path}`);
  }
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function renderSceneSvg(manifest: SceneManifest, scene: SceneManifestScene, width = 1920, height = 1080) {
  const palette = paletteFor(scene.scene_id);
  const minDim = Math.min(width, height);
  const s = minDim / 1080;
  const titleWrap = Math.max(8, Math.round(15 * (width / 1920)));
  const titleLines = wrap(scene.scene_title, titleWrap, 2);
  const bulletWrap = Math.max(10, Math.round(18 * (width / 1920)));
  const bullets = scene.screen_text.slice(0, 4).map((item) => wrap(item, bulletWrap, 2).join(""));
  const narrWrap = Math.max(18, Math.round(34 * (width / 1920)));
  const narrationLines = wrap(scene.narration_text, narrWrap, 3);
  const keywords = scene.keywords.slice(0, 6);
  const progress = Math.max(0.05, scene.scene_id / Math.max(1, manifest.scenes.length));
  const isDiagram = scene.visual_type === "diagram";
  const sceneLabel = `${scene.chapter} / Scene ${scene.scene_id.toString().padStart(2, "0")}`;
  const pad = Math.round(minDim * 0.08);
  const cardX = pad;
  const cardY = Math.round(pad * 0.82);
  const cardW = width - 2 * pad;
  const cardH = height - 2 * cardY;
  const innerPad = Math.round(pad * 0.43);
  const innerX = cardX + innerPad;
  const innerY = cardY + innerPad;
  const innerW = cardW - 2 * innerPad;
  const innerH = cardH - 2 * innerPad;
  const fs34 = Math.round(34 * s);
  const fs24 = Math.round(24 * s);
  const titleFs = Math.round((titleLines.length > 1 ? 66 : 74) * s);
  const titleGap = Math.round(82 * s);
  const titleY = Math.round(328 * s);
  const progressY = Math.round(908 * s);
  const progressW = Math.round(860 * s);
  const progressH = Math.round(12 * s);
  const progressR = Math.round(6 * s);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette.bg1}"/>
      <stop offset="0.52" stop-color="${palette.bg2}"/>
      <stop offset="1" stop-color="${palette.bg3}"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${palette.accent}"/>
      <stop offset="1" stop-color="${palette.accent2}"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="22" stdDeviation="28" flood-color="#7B5D4D" flood-opacity="0.16"/>
    </filter>
    <filter id="tinyShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#7B5D4D" flood-opacity="0.12"/>
    </filter>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <circle cx="${Math.round(width * 0.86)}" cy="${Math.round(height * 0.12)}" r="${Math.round(230 * s)}" fill="${palette.accent}" opacity="0.08"/>
  <circle cx="${Math.round(width * 0.11)}" cy="${Math.round(height * 0.815)}" r="${Math.round(280 * s)}" fill="${palette.accent2}" opacity="0.09"/>
  <path d="M0 ${Math.round(height * 0.76)} C${Math.round(width * 0.2)} ${Math.round(height * 0.7)} ${Math.round(width * 0.3)} ${Math.round(height * 0.86)} ${Math.round(width * 0.484)} ${Math.round(height * 0.8)} C${Math.round(width * 0.656)} ${Math.round(height * 0.745)} ${Math.round(width * 0.755)} ${Math.round(height * 0.606)} ${width} ${Math.round(height * 0.68)} L${width} ${height} L0 ${height} Z" fill="#FFFFFF" opacity="0.22"/>

  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="${Math.round(52 * s)}" fill="#fffaf2" fill-opacity="0.74" stroke="#ffffff" stroke-opacity="0.9" filter="url(#softShadow)"/>
  <rect x="${innerX}" y="${innerY}" width="${innerW}" height="${innerH}" rx="${Math.round(38 * s)}" fill="#ffffff" fill-opacity="0.38" stroke="#ffffff" stroke-opacity="0.72"/>

  <text x="${Math.round(154 * s)}" y="${Math.round(170 * s)}" font-family="${fontFamily()}" font-size="${fs34}" font-weight="650" fill="#7C665B">${escapeXml(sceneLabel)}</text>
  <text x="${Math.round(154 * s)}" y="${Math.round(221 * s)}" font-family="${fontFamily()}" font-size="${fs24}" font-weight="500" fill="#9A867A">${escapeXml(manifest.style)} · ${escapeXml(scene.visual_type)}</text>
  <rect x="${Math.round(154 * s)}" y="${progressY}" width="${progressW}" height="${progressH}" rx="${progressR}" fill="#E9DED5"/>
  <rect x="${Math.round(154 * s)}" y="${progressY}" width="${Math.round(progressW * progress)}" height="${progressH}" rx="${progressR}" fill="url(#accent)"/>

  ${titleLines
    .map(
      (line, index) =>
        `<text x="${Math.round(154 * s)}" y="${titleY + index * titleGap}" font-family="${fontFamily()}" font-size="${titleFs}" font-weight="760" fill="#2D2521">${escapeXml(line)}</text>`
    )
    .join("\n  ")}

  <g transform="translate(${Math.round(154 * s)} ${Math.round(520 * s)})">
    ${keywords
      .map((keyword, index) => {
        const x = (index % 3) * Math.round(226 * s);
        const y = Math.floor(index / 3) * Math.round(82 * s);
        const w = Math.min(Math.round(194 * s), Math.round(70 * s) + [...keyword].length * Math.round(24 * s));
        return `<rect x="${x}" y="${y}" width="${w}" height="${Math.round(52 * s)}" rx="${Math.round(26 * s)}" fill="#FFFFFF" fill-opacity="0.7" stroke="${palette.line}" filter="url(#tinyShadow)"/>
    <text x="${x + Math.round(28 * s)}" y="${y + Math.round(35 * s)}" font-family="${fontFamily()}" font-size="${Math.round(24 * s)}" font-weight="650" fill="${palette.text}">${escapeXml(keyword)}</text>`;
      })
      .join("\n    ")}
  </g>

  <g transform="translate(${Math.round(154 * s)} ${Math.round(716 * s)})">
    <text x="0" y="0" font-family="${fontFamily()}" font-size="${Math.round(24 * s)}" font-weight="700" fill="#8A7062">Narration Focus</text>
    ${narrationLines
      .map((line, index) => `<text x="0" y="${Math.round(46 * s) + index * Math.round(42 * s)}" font-family="${fontFamily()}" font-size="${Math.round(30 * s)}" font-weight="520" fill="#4A3A33">${escapeXml(line)}</text>`)
      .join("\n    ")}
  </g>

  ${
    isDiagram
      ? renderDiagram(scene, palette, s)
      : renderKeywordPanel(scene, bullets, palette, s)
  }
</svg>`;
}

function renderKeywordPanel(scene: SceneManifestScene, bullets: string[], palette: ReturnType<typeof paletteFor>, s: number) {
  return `<g transform="translate(${Math.round(1088 * s)} ${Math.round(260 * s)})">
    <rect x="0" y="0" width="${Math.round(570 * s)}" height="${Math.round(518 * s)}" rx="${Math.round(44 * s)}" fill="#FFFFFF" fill-opacity="0.74" stroke="#FFFFFF" filter="url(#softShadow)"/>
    <rect x="${Math.round(46 * s)}" y="${Math.round(48 * s)}" width="${Math.round(84 * s)}" height="${Math.round(84 * s)}" rx="${Math.round(26 * s)}" fill="url(#accent)" opacity="0.92"/>
    <text x="${Math.round(88 * s)}" y="${Math.round(104 * s)}" text-anchor="middle" font-family="${fontFamily()}" font-size="${Math.round(36 * s)}" font-weight="800" fill="#FFFFFF">${scene.scene_id}</text>
    <text x="${Math.round(154 * s)}" y="${Math.round(82 * s)}" font-family="${fontFamily()}" font-size="${Math.round(28 * s)}" font-weight="760" fill="#332B27">屏幕重点</text>
    <text x="${Math.round(154 * s)}" y="${Math.round(123 * s)}" font-family="${fontFamily()}" font-size="${Math.round(22 * s)}" font-weight="500" fill="#9B877B">Screen text for this beat</text>
    ${bullets
      .map((bullet, index) => {
        const y = Math.round(188 * s) + index * Math.round(78 * s);
        return `<circle cx="${Math.round(64 * s)}" cy="${y - Math.round(8 * s)}" r="${Math.round(11 * s)}" fill="${index % 2 ? palette.accent2 : palette.accent}"/>
    <text x="${Math.round(94 * s)}" y="${y}" font-family="${fontFamily()}" font-size="${Math.round(34 * s)}" font-weight="650" fill="#3A302B">${escapeXml(bullet)}</text>`;
      })
      .join("\n    ")}
    <rect x="${Math.round(46 * s)}" y="${Math.round(430 * s)}" width="${Math.round(478 * s)}" height="${Math.max(1, Math.round(1.5 * s))}" fill="#E8DCD2"/>
    <text x="${Math.round(46 * s)}" y="${Math.round(474 * s)}" font-family="${fontFamily()}" font-size="${Math.round(22 * s)}" font-weight="550" fill="#9B877B">${escapeXml(scene.visual_goal.slice(0, 30))}</text>
  </g>`;
}

function renderDiagram(scene: SceneManifestScene, palette: ReturnType<typeof paletteFor>, s: number) {
  const nodes = (scene.screen_text.length ? scene.screen_text : scene.keywords).slice(0, 4);
  return `<g transform="translate(${Math.round(1036 * s)} ${Math.round(238 * s)})">
    <rect x="0" y="0" width="${Math.round(650 * s)}" height="${Math.round(560 * s)}" rx="${Math.round(46 * s)}" fill="#FFFFFF" fill-opacity="0.72" stroke="#FFFFFF" filter="url(#softShadow)"/>
    <text x="${Math.round(56 * s)}" y="${Math.round(72 * s)}" font-family="${fontFamily()}" font-size="${Math.round(31 * s)}" font-weight="760" fill="#332B27">结构关系</text>
    <text x="${Math.round(56 * s)}" y="${Math.round(112 * s)}" font-family="${fontFamily()}" font-size="${Math.round(21 * s)}" font-weight="520" fill="#9B877B">${escapeXml(scene.layout_suggestion.slice(0, 32))}</text>
    ${nodes
      .map((node, index) => {
        const y = Math.round(174 * s) + index * Math.round(82 * s);
        return `<rect x="${Math.round(68 * s)}" y="${y}" width="${Math.round(506 * s)}" height="${Math.round(58 * s)}" rx="${Math.round(22 * s)}" fill="${index === 0 ? "url(#accent)" : "#FFF8EF"}" stroke="${palette.line}"/>
    <text x="${Math.round(96 * s)}" y="${y + Math.round(38 * s)}" font-family="${fontFamily()}" font-size="${Math.round(27 * s)}" font-weight="700" fill="${index === 0 ? "#FFFFFF" : "#3A302B"}">${escapeXml(node.slice(0, 20))}</text>
    ${index < nodes.length - 1 ? `<path d="M${Math.round(321 * s)} ${y + Math.round(64 * s)} L${Math.round(321 * s)} ${y + Math.round(82 * s)}" stroke="${palette.accent}" stroke-width="${Math.round(5 * s)}" stroke-linecap="round"/><path d="M${Math.round(309 * s)} ${y + Math.round(74 * s)} L${Math.round(321 * s)} ${y + Math.round(86 * s)} L${Math.round(333 * s)} ${y + Math.round(74 * s)}" fill="none" stroke="${palette.accent}" stroke-width="${Math.round(5 * s)}" stroke-linecap="round" stroke-linejoin="round"/>` : ""}`;
      })
      .join("\n    ")}
  </g>`;
}

function paletteFor(index: number) {
  const palettes = [
    { bg1: "#F9F3EA", bg2: "#F5EEE8", bg3: "#EEEAF7", accent: "#E88C6E", accent2: "#9C8AEF", line: "#EEDDD1", text: "#7A5748" },
    { bg1: "#FAF4EB", bg2: "#F3EFE9", bg3: "#EAF1F3", accent: "#D9795F", accent2: "#76A7A0", line: "#E8DCD1", text: "#6C5A4D" },
    { bg1: "#FBF6EF", bg2: "#F2EBE7", bg3: "#F2EAF5", accent: "#C884D8", accent2: "#F0A064", line: "#E8D8E6", text: "#60495C" }
  ];
  return palettes[index % palettes.length];
}

function wrap(text: string, maxChars: number, maxLines = 3) {
  const chars = [...String(text).replace(/\s+/g, " ").trim()];
  const lines: string[] = [];
  let current = "";
  for (const char of chars) {
    if ([...current].length >= maxChars && /[，。！？；、,.!?;\s]/.test(char)) {
      lines.push(current.trim());
      current = "";
    } else if ([...current].length >= maxChars) {
      lines.push(current.trim());
      current = char;
    } else {
      current += char;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current.trim());
  if (chars.length > maxChars * maxLines && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1].replace(/[。！？,.!?]?$/, "")}...`;
  return lines.filter(Boolean);
}

function escapeXml(value: string) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fontFamily() {
  return "Microsoft YaHei, PingFang SC, Noto Sans CJK SC, Arial, sans-serif";
}

function pad(value: number) {
  return value.toString().padStart(3, "0");
}

function relative(root: string, target: string) {
  return path.relative(root, target).replace(/\\/g, "/");
}
