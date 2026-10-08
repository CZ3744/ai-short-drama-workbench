import { useRef, useEffect, useState, useCallback } from "react";
import { cn } from "../../../lib/cn";
import { Card } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { Select } from "../../../components/ui/select";
import type { CoverAsset } from "../../../hooks/useCover";

export interface CoverEditorProps {
  cover: CoverAsset | null;
  titleText: string;
  fontSize?: "sm" | "md" | "lg";
  fontColor?: string;
  onExportImage?: (dataUrl: string) => void;
  className?: string;
}

const FONT_SIZE_MAP = { sm: 28, md: 40, lg: 56 };
const FONT_COLOR_OPTIONS = [
  { value: "var(--ink-50)", label: "白色" },
  { value: "var(--ink-950)", label: "黑色" },
  { value: "var(--warn)", label: "金色" },
];

function resolveCanvasColor(color: string): string {
  const match = color.match(/^var\((--[^)]+)\)$/);
  if (!match) return color;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
  return resolved || "rgb(26, 24, 22)";
}

/**
 * Canvas-based cover editor: overlays title text on cover image.
 * Used when backend doesn't support "image+text" composition.
 */
export function CoverEditor({ cover, titleText, fontSize: initFontSize = "md", fontColor: initColor = "var(--ink-50)", onExportImage, className }: CoverEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fontSize, setFontSize] = useState(initFontSize);
  const [fontColor, setFontColor] = useState(initColor);

  // Redraw canvas whenever inputs change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 1080;
    const H = 1440;
    canvas.width = W;
    canvas.height = H;

    // Clear
    ctx.clearRect(0, 0, W, H);

    // Draw cover image or placeholder
    if (cover?.path) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        ctx.drawImage(img, 0, 0, W, H);
        drawTitle(ctx, W, H);
      };
      img.onerror = () => {
        drawPlaceholder(ctx, W, H);
        drawTitle(ctx, W, H);
      };
      img.src = cover.path;
    } else {
      drawPlaceholder(ctx, W, H);
      drawTitle(ctx, W, H);
    }

    function drawPlaceholder(c: CanvasRenderingContext2D, w: number, h: number) {
      c.fillStyle = resolveCanvasColor("var(--ink-900)");
      c.fillRect(0, 0, w, h);
    }

    function drawTitle(c: CanvasRenderingContext2D, w: number, h: number) {
      if (!titleText) return;
      const px = FONT_SIZE_MAP[fontSize];
      c.font = `bold ${px}px "PingFang SC", "Microsoft YaHei", sans-serif`;
      c.fillStyle = resolveCanvasColor(fontColor);
      c.textAlign = "center";
      c.textBaseline = "bottom";

      // Shadow for readability
      c.shadowColor = "rgba(0,0,0,0.6)";
      c.shadowBlur = 8;
      c.shadowOffsetX = 2;
      c.shadowOffsetY = 2;

      // Word wrap
      const maxWidth = w - 80;
      const lines = wrapText(c, titleText, maxWidth);
      const lineHeight = px * 1.3;
      const totalH = lines.length * lineHeight;
      const startY = h - 60 - totalH + lineHeight;

      for (let i = 0; i < lines.length; i++) {
        c.fillText(lines[i], w / 2, startY + i * lineHeight);
      }

      // Reset shadow
      c.shadowColor = "transparent";
      c.shadowBlur = 0;
      c.shadowOffsetX = 0;
      c.shadowOffsetY = 0;
    }
  }, [cover, titleText, fontSize, fontColor]);

  const handleExport = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    onExportImage?.(dataUrl);
  }, [onExportImage]);

  return (
    <Card variant="outlined" className={cn("space-y-3", className)}>
      <h3 className="text-[var(--fs-md)] font-semibold text-[var(--ink-950)]">封面编辑</h3>

      {/* Canvas preview */}
      <div className="relative bg-[var(--ink-50)] rounded-[var(--r-md)] overflow-hidden" style={{ aspectRatio: "3/4" }}>
        <canvas
          ref={canvasRef}
          className="w-full h-full"
          style={{ aspectRatio: "3/4" }}
        />
      </div>

      {/* Font size control */}
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[var(--fs-xs)] text-[var(--ink-500)] mb-1 block">字号</span>
          <Select
            value={fontSize}
            onValueChange={(v) => setFontSize(v as "sm" | "md" | "lg")}
            options={[
              { value: "sm", label: "小" },
              { value: "md", label: "中" },
              { value: "lg", label: "大" },
            ]}
          />
        </label>
        <label className="block">
          <span className="text-[var(--fs-xs)] text-[var(--ink-500)] mb-1 block">字色</span>
          <Select
            value={fontColor}
            onValueChange={setFontColor}
            options={FONT_COLOR_OPTIONS}
          />
        </label>
      </div>

      <Button variant="secondary" size="sm" onClick={handleExport} className="w-full">
        导出封面图片
      </Button>
    </Card>
  );
}

/** Simple word-wrap for canvas text */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";

  for (const char of text) {
    const test = current + char;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = char;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}
