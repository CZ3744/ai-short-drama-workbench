/**
 * InpaintCanvas — 局部重抽 mask 绘制 + 提交
 *
 * 源图作为背景，上层 Canvas 画布半透明遮罩。
 * 用户涂抹红色半透明标记 mask 区域，输入修改意见后调 inpaint 端点。
 * 支持画笔/橡皮擦工具切换 + 画笔大小 slider + 清空 + 生成对比。
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { BaseDialog } from "../ui/BaseDialog";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Slider } from "../ui/slider";
import { Spinner } from "../ui/spinner";
import { toast } from "sonner";
import { showErrorToast } from "../../lib/errorTranslate";
import { cn } from "../../lib/cn";
import { vaultInpaint, type VaultInpaintResult } from "../../lib/api";
import { Brush, Eraser, Trash2, Wand2, FileText } from "../shared/LucideIcon";
// 2026-05-19 Wave O Audit P1 #1: 接 PromptReviewModal (铁律 #2 可干预性 + #13 含图片素材)
// 局部 inpaint 是付费图像调用,用户必须能在生成前看到完整 prompt + 源图 + mask.
import { PromptReviewModal } from "../element/PromptReviewModal";

// ─── Types ─────────────────────────────────────────────────────────

export interface InpaintCanvasProps {
  /** Open state */
  open: boolean;
  /** Called when dialog closes */
  onClose: () => void;
  /** Vault ID of the source image */
  vaultId: string;
  /** URL of the source image to load as background */
  sourceImageUrl: string;
  /** Called after successful inpaint with the new vault_id for comparison */
  onInpainted?: (result: VaultInpaintResult) => void;
  /**
   * 2026-05-17 整合: inline=true 时不渲染 Dialog 外壳,只返回内部 content (canvas + 工具 + textarea + 生成按钮).
   * 用法:caller 自己提供容器(如 RegenModal "局部涂抹" tab 内嵌),避免叠 2 层 modal.
   * 默认 false 保持原 Dialog 模式向后兼容.
   */
  inline?: boolean;
}

type ToolMode = "brush" | "eraser";

// ─── Constants ─────────────────────────────────────────────────────

const CANVAS_WIDTH = 512;
const CANVAS_HEIGHT = 512;
const DEFAULT_BRUSH_SIZE = 30;
const MIN_BRUSH_SIZE = 10;
const MAX_BRUSH_SIZE = 100;
const MASK_ALPHA = 0.45; // 半透明红色遮罩
const ESTIMATED_COST = 0.04;

// 2026-07-22 X9-1 (A4-5): 审核弹窗 fullPrompt 模板的两段样板 — handleOpenReview 用它们把
// userNote 包成"完整提示词"预览. 后端 inpaint 端点只吃 user_note (mask_base64 另传),
// 前缀/mask 行是前端对后端拼装的复现, 后端会自行重新补.
const REVIEW_PROMPT_PREFIX = "局部重抽修改:";
const REVIEW_PROMPT_MASK_LINE = "用 mask 标记区域进行修改，保持 mask 外区域不变。";

/**
 * 2026-07-22 X9-1 (A4-5): 从审核弹窗编辑后的完整提示词里解析回用户的"修改意见"(userNote).
 *
 * 策略: 只剥掉两段已知样板字面量 (前缀 + mask 行), 剩下的一律当作 userNote.
 *   - 用户只改核心那段 → 精确取回;
 *   - 用户新增/追加任意文字 → 折进 note 保留;
 *   - 用户删掉样板重写 → 整段当 note.
 * **任何情况下都不会静默丢弃用户输入** (只移除这两段样板, 而它们本就由后端重新拼).
 */
function parseUserNoteFromReviewDraft(draft: string): string {
  let note = draft.replace(REVIEW_PROMPT_MASK_LINE, ""); // 去样板 mask 行 (首个字面匹配)
  const lead = note.replace(/^\s+/, "");
  if (lead.startsWith(REVIEW_PROMPT_PREFIX)) {
    note = lead.slice(REVIEW_PROMPT_PREFIX.length);
  }
  return note.trim();
}

// ─── Component ─────────────────────────────────────────────────────

export function InpaintCanvas({
  open,
  onClose,
  vaultId,
  sourceImageUrl,
  onInpainted,
  inline = false,
}: InpaintCanvasProps) {
  // ── Refs ──
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  // 2026-05-28 audit P1: 用 useRef 存 draw params 替代 canvas DOM 字段挂载 (canvas.__drawParams) 类型谎言.
  // 这些坐标只服务于 handleClear / exportMaskDataUri, 不需要响应式; useRef 简洁稳定.
  const drawParamsRef = useRef<{ dx: number; dy: number; dw: number; dh: number }>({
    dx: 0,
    dy: 0,
    dw: CANVAS_WIDTH,
    dh: CANVAS_HEIGHT,
  });

  // ── Drawing state ──
  const [tool, setTool] = useState<ToolMode>("brush");
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
  const [isDrawing, setIsDrawing] = useState(false);

  // ── Input state ──
  const [userNote, setUserNote] = useState("");

  // ── Loading state ──
  const [generating, setGenerating] = useState(false);
  // 2026-05-17: 源图加载状态(从 vault 拉 raw 可能慢 1-3s, 期间显示 spinner 而不是空白 canvas)
  const [imageLoading, setImageLoading] = useState(true);

  // ── Result state ──
  const [result, setResult] = useState<VaultInpaintResult | null>(null);

  // 2026-05-19 Wave O Audit P1 #1: PromptReviewModal 状态 (铁律 #13)
  // 局部 inpaint prompt 拼装与后端 vaultController inpaint 端点保持一致(line 611-625):
  //   局部重抽修改: <user_note>
  //   用 mask 标记区域进行修改，保持 mask 外区域不变。
  //   参考上下文: 角色ID/场景ID/分镜ID (仅当 source vault context 存在时)
  //
  // 这里前端无 source vault context(只在 vaultId 字符串), context 行省略 — 真实端点会补.
  // referenceImages 包含 [源图 + mask 涂抹缩略图] 两张, 让用户一站式审核.
  const [reviewModal, setReviewModal] = useState<{
    open: boolean;
    fullPrompt: string;
    maskDataUri: string;
  }>({ open: false, fullPrompt: "", maskDataUri: "" });

  // ── Initialize canvas when source image loads ──
  useEffect(() => {
    if (!open || !sourceImageUrl) return;

    setImageLoading(true);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      bgImageRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) {
        setImageLoading(false);
        return;
      }

      // Scale to fit canvas while keeping aspect ratio
      const scale = Math.min(
        CANVAS_WIDTH / img.naturalWidth,
        CANVAS_HEIGHT / img.naturalHeight,
      );
      const dw = img.naturalWidth * scale;
      const dh = img.naturalHeight * scale;
      const dx = (CANVAS_WIDTH - dw) / 2;
      const dy = (CANVAS_HEIGHT - dh) / 2;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setImageLoading(false);
        return;
      }

      // Clear and draw background image
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      ctx.drawImage(img, dx, dy, dw, dh);

      // Store draw params for mask coordinate mapping
      drawParamsRef.current = { dx, dy, dw, dh };
      setImageLoading(false);
    };
    img.onerror = () => {
      setImageLoading(false);
      toast.error("加载源图失败");
    };
    img.src = sourceImageUrl;

    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [open, sourceImageUrl]);

  // ── Reset state on open ──
  useEffect(() => {
    if (open) {
      setUserNote("");
      setResult(null);
      setTool("brush");
      setBrushSize(DEFAULT_BRUSH_SIZE);
    }
  }, [open]);

  // ── Drawing helpers ──
  const getCanvasPos = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const scaleX = CANVAS_WIDTH / rect.width;
      const scaleY = CANVAS_HEIGHT / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      };
    },
    [],
  );

  const drawDot = useCallback(
    (cx: number, cy: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.beginPath();
      ctx.arc(cx, cy, brushSize / 2, 0, Math.PI * 2);

      if (tool === "brush") {
        // Draw red semi-transparent mask
        ctx.fillStyle = `rgba(220, 38, 38, ${MASK_ALPHA})`;
        ctx.fill();
      } else {
        // Eraser: clear mask (restore background)
        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "rgba(0,0,0,1)";
        ctx.fill();
        ctx.restore();
      }
    },
    [tool, brushSize],
  );

  // ── Event handlers ──
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      setIsDrawing(true);
      const { x, y } = getCanvasPos(e);
      drawDot(x, y);
    },
    [getCanvasPos, drawDot],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawing) return;
      const { x, y } = getCanvasPos(e);
      drawDot(x, y);
    },
    [isDrawing, getCanvasPos, drawDot],
  );

  const handleMouseUp = useCallback(() => {
    setIsDrawing(false);
  }, []);

  // ── Clear mask ──
  const handleClear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = bgImageRef.current;
    if (!img) return;

    const params = drawParamsRef.current;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.drawImage(img, params.dx, params.dy, params.dw, params.dh);
  }, []);

  // ── Export mask to base64 data URI ──
  const exportMaskDataUri = useCallback((): string => {
    const canvas = canvasRef.current;
    if (!canvas) return "";

    // Create a temporary canvas to extract only the mask layer
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = CANVAS_WIDTH;
    tempCanvas.height = CANVAS_HEIGHT;
    const tempCtx = tempCanvas.getContext("2d");
    if (!tempCtx) return "";

    // Draw the current canvas content
    tempCtx.drawImage(canvas, 0, 0);

    // Remove the background image: compare with original background
    const img = bgImageRef.current;
    if (img) {
      const params = drawParamsRef.current;
      tempCtx.save();
      tempCtx.globalCompositeOperation = "destination-out";
      tempCtx.drawImage(img, params.dx, params.dy, params.dw, params.dh);
      tempCtx.restore();
    }

    return tempCanvas.toDataURL("image/png");
  }, []);

  // ── Submit ──
  const handleGenerate = useCallback(async () => {
    if (!userNote.trim()) {
      toast.error("请输入修改意见");
      return;
    }

    const maskDataUri = exportMaskDataUri();
    if (!maskDataUri) {
      toast.error("请在图片上涂抹标记需要修改的区域");
      return;
    }

    setGenerating(true);
    try {
      const res = await vaultInpaint(vaultId, {
        mask_base64: maskDataUri,
        user_note: userNote.trim(),
      });
      setResult(res);
      const strategyLabel =
        res.strategy === "native_inpaint"
          ? "原生 inpaint"
          : res.strategy === "remix_with_mask"
            ? "全图 remix 降级"
            : "mock 模式";
      const mockNote = res.mock_fallback ? " (mock 模式)" : "";
      toast.success(`局部重抽完成 · ${strategyLabel}${mockNote}`);
      onInpainted?.(res);
    } catch (err: any) {
      showErrorToast(err);
    } finally {
      setGenerating(false);
    }
  }, [userNote, vaultId, exportMaskDataUri, onInpainted]);

  // 2026-05-19 Wave O Audit P1 #1: "查看完整提示词" 处理函数 (铁律 #2 可干预性 + #13 含图片素材)
  // 不调任何 API, 前端拼装 prompt 模板 + 收集源图 + mask 涂抹快照给 PromptReviewModal.
  // prompt 模板与后端 vaultController inpaint 端点 (line 611-625) 拼装逻辑保持一致.
  const handleOpenReview = useCallback(() => {
    if (!userNote.trim()) {
      toast.info("先填修改意见, 再预览完整提示词");
      return;
    }
    const maskDataUri = exportMaskDataUri();
    if (!maskDataUri) {
      toast.info("请在图片上涂抹标记需要修改的区域, 再预览");
      return;
    }
    const fullPrompt = [
      `${REVIEW_PROMPT_PREFIX} ${userNote.trim()}`,
      REVIEW_PROMPT_MASK_LINE,
    ].join("\n");
    setReviewModal({ open: true, fullPrompt, maskDataUri });
  }, [userNote, exportMaskDataUri]);

  // ── Check if mask has content ──
  const hasMaskDrawn = (() => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    const imageData = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    // Check if any pixel has non-zero alpha in mask layer
    // We look for the red-tinted mask pixels (R > 200, G < 100, B < 100, A > 150)
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] < 100 && data[i + 2] < 100 && data[i + 3] > 150) {
        return true;
      }
    }
    return false;
  })();

  // 2026-05-17 整合: inline 模式去掉 Dialog 包装,只返回内部 content
  // caller (RegenModal "局部涂抹" tab) 自己提供容器,避免叠 2 层 modal
  const innerContent = (
    <>
      <div className="flex gap-[var(--sp-4)] min-w-0 flex-wrap">
          {/* ── Left: Canvas area ── */}
          <div className="flex flex-col gap-[var(--sp-3)] min-w-0 flex-shrink-0">
            {/* Tool switcher */}
            <div className="flex items-center gap-[var(--sp-2)]">
              <button
                className={cn(
                  "flex items-center gap-1 rounded-[var(--r-md)] px-3 py-1.5 text-[var(--fs-sm)] font-medium border transition-colors",
                  tool === "brush"
                    ? "bg-[var(--brand-500)] text-white border-[var(--brand-500)]"
                    : "bg-white text-[var(--ink-700)] border-[var(--ink-200)] hover:bg-[var(--ink-50)]",
                )}
                onClick={() => setTool("brush")}
                title="画笔 — 涂抹标记要修改的区域"
              >
                <Brush className="h-3.5 w-3.5" />
                画笔
              </button>
              <button
                className={cn(
                  "flex items-center gap-1 rounded-[var(--r-md)] px-3 py-1.5 text-[var(--fs-sm)] font-medium border transition-colors",
                  tool === "eraser"
                    ? "bg-[var(--brand-500)] text-white border-[var(--brand-500)]"
                    : "bg-white text-[var(--ink-700)] border-[var(--ink-200)] hover:bg-[var(--ink-50)]",
                )}
                onClick={() => setTool("eraser")}
                title="橡皮擦 — 擦除已涂抹的标记"
              >
                <Eraser className="h-3.5 w-3.5" />
                橡皮擦
              </button>

              {/* Separator */}
              <div className="w-px h-6 bg-[var(--ink-200)] mx-1" />

              {/* Brush size slider */}
              <label className="text-[var(--fs-xs)] font-medium text-[var(--ink-500)] whitespace-nowrap">
                大小
              </label>
              <Slider
                value={[brushSize]}
                onValueChange={([v]) => setBrushSize(v ?? DEFAULT_BRUSH_SIZE)}
                min={MIN_BRUSH_SIZE}
                max={MAX_BRUSH_SIZE}
                step={1}
                className="w-24"
              />
              <span className="text-[var(--fs-xs)] text-[var(--ink-400)] w-8 text-right">
                {brushSize}px
              </span>

              {/* Clear button */}
              <button
                className="flex items-center gap-1 rounded-[var(--r-md)] px-2 py-1.5 text-[var(--fs-xs)] font-medium text-[var(--ink-500)] border border-[var(--ink-200)] hover:bg-[var(--err-bg)] hover:text-[var(--err)] hover:border-[var(--err)] transition-colors ml-auto"
                onClick={handleClear}
                title="清空所有涂抹标记"
              >
                <Trash2 className="h-3 w-3" />
                清空
              </button>
            </div>

            {/* Canvas */}
            <div
              className="relative rounded-[var(--r-lg)] overflow-hidden border border-[var(--ink-200)] bg-[var(--ink-50)] max-w-full"
              style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
            >
              <canvas
                ref={canvasRef}
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
                className={cn(
                  "cursor-crosshair block",
                  tool === "eraser" && "cursor-cell",
                )}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              />
              {/* 2026-05-17: 源图加载状态(vault raw 从硬盘读 + 网络传输 1-3s,显式 spinner) */}
              {imageLoading ? (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-2"
                  style={{ background: "rgba(255,255,255,0.85)", backdropFilter: "blur(4px)" }}
                >
                  <Spinner className="h-6 w-6 text-[var(--brand-600)]" />
                  <span className="text-[var(--fs-xs)] text-[var(--ink-600)]">加载源图...</span>
                </div>
              ) : null}
            </div>

            {/* Hint */}
            <p className="text-[var(--fs-xs)] text-[var(--ink-400)]">
              {tool === "brush"
                ? "在图上涂抹标记需要修改的区域"
                : "擦除不需要修改的标记"}
            </p>
          </div>

          {/* ── Right: Input panel ── */}
          <div className="flex flex-col gap-[var(--sp-3)] flex-1 min-w-[220px]">
            {/* Prompt textarea */}
            <div className="flex flex-col gap-1">
              <label className="text-[var(--fs-sm)] font-medium text-[var(--ink-700)]">
                这块换成:
              </label>
              <Textarea
                value={userNote}
                onChange={(e) => setUserNote(e.target.value)}
                placeholder="比如：变成古装、换成短发、背景换成星空"
                rows={5}
                disabled={generating}
                className="min-h-[120px]"
              />
            </div>

            {/* Cost estimate */}
            <div className="flex items-center justify-between text-[var(--fs-xs)] text-[var(--ink-500)]">
              <span>预计费用</span>
              <span className="font-medium text-[var(--brand-600)]">
                &yen;{ESTIMATED_COST.toFixed(2)}
              </span>
            </div>

            {/* 2026-05-21 X-6: sticky bottom footer — 滚动时按钮始终可见 (参考 AutoPipelineLauncher:366) */}
            <div className="sticky bottom-0 bg-[var(--surface-card)] pt-3 mt-auto border-t border-[var(--ink-100)] flex flex-col gap-2">
            {/* 2026-05-19 Wave O Audit P1 #1: "查看完整提示词" 按钮 (铁律 #2 可干预性 + #13 含图片素材).
                局部 inpaint 是付费图像调用,生成前必须能审核完整 prompt + 源图 + mask. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpenReview}
              disabled={generating || !userNote.trim()}
              className="w-full"
              title="预览完整提示词 + 源图 + mask 缩略图, 可一键复制到外部 AI 用"
            >
              <FileText className="h-4 w-4" />
              查看完整提示词
            </Button>

            {/* Generate button */}
            <Button
              variant="primary"
              size="md"
              onClick={handleGenerate}
              loading={generating}
              disabled={generating || !userNote.trim()}
              className="w-full"
            >
              <Wand2 className="h-4 w-4" />
              {generating ? "生成中..." : "生成"}
            </Button>
            </div>

            {generating && (
              <Spinner size="sm" label="正在局部重抽..." />
            )}

            {/* Result preview */}
            {result && (
              <div className="flex flex-col gap-[var(--sp-2)] p-[var(--sp-2)] rounded-[var(--r-md)] bg-[var(--ink-50)] border border-[var(--ink-100)]">
                <p className="text-[var(--fs-xs)] font-medium text-[var(--ink-700)]">
                  生成完成
                </p>
                <p className="text-[var(--fs-xs)] text-[var(--ink-500)]">
                  策略: {result.strategy === "native_inpaint" ? "原生 inpaint" : result.strategy === "remix_with_mask" ? "全图 remix 降级" : "mock"}
                </p>
                {/* 2026-05-18 (铁律 #9 toC 兜底):
                    "mock 回退模式" 是技术内部状态名 — 改成用户能理解的"演示效果(未真实生成)"红字提醒,
                    让用户明确知道当前结果不是付费 AI 模型生成的, 避免误以为已扣费成功. */}
                {result.mock_fallback && (
                  <p className="text-[var(--fs-xs)] text-[var(--err)] font-medium">
                    ⚠ 当前为演示效果(非真实生成)— 后端 inpaint 服务不可用, 请检查 Key
                  </p>
                )}
                {/* 2026-05-18: vault_id 是内部存储 ID, 用户不感知; 改成"已保存到素材库"提示更人话. */}
                <p className="text-[var(--fs-xs)] text-[var(--ink-400)]">
                  已保存到素材库 · 可在「素材库」页面查看
                </p>
              </div>
            )}
          </div>
        </div>
    </>
  );

  // 2026-05-19 Wave O Audit P1 #1: PromptReviewModal — 局部 inpaint 提示词审核中心 (铁律 #13).
  // referenceImages 包含 [源图 + mask 涂抹缩略图] 两张, 一站式审核 + "复制全部含图".
  const reviewModalNode = (
    <PromptReviewModal
      open={reviewModal.open}
      fullPrompt={reviewModal.fullPrompt}
      referenceImages={[
        ...(sourceImageUrl ? [{ url: sourceImageUrl, label: "源图 (inpaint 起点)" }] : []),
        ...(reviewModal.maskDataUri ? [{ url: reviewModal.maskDataUri, label: "Mask 涂抹区域 (红色区域将被改写)" }] : []),
      ]}
      title="局部涂抹 — 完整提示词预览"
      confirmLabel="应用修改并返回"
      introHint={
        <>
          这是最终会发给局部重抽 (inpaint) 的完整内容。在下方文本框改动措辞后,点
          「应用修改并返回」会把修改写回画布的「这块换成」输入框;
          <strong>回画布点「生成」才真正发起局部重抽(可能扣费)</strong>。
          也可用下方「复制走外部 AI」拿去自己生。
        </>
      }
      onConfirm={(editedPrompt) => {
        // 2026-07-22 X9-1 (A4-5) 方案(a): onConfirm 真接编辑后文本 → 解析回写 userNote,
        // 绝不静默丢弃用户在弹窗里改的字 (硬性验收). 仍不直接触发生成 —— 保留"回画布可再
        // 调 mask / 文案后点生成"的既有设计意图 (按钮文案"应用修改并返回"与真实行为一致).
        const parsedNote = parseUserNoteFromReviewDraft(editedPrompt);
        const changed = parsedNote !== userNote.trim();
        setUserNote(parsedNote);
        setReviewModal((s) => ({ ...s, open: false }));
        if (changed) {
          toast.success("已把修改写回「这块换成」,回画布点「生成」发起局部重抽");
        }
      }}
      onClose={() => setReviewModal((s) => ({ ...s, open: false }))}
    />
  );

  // inline 模式: 不渲染 Dialog 外壳, 直接返回内容(给 RegenModal "局部涂抹" tab 用)
  if (inline) {
    return open ? (
      <div className="w-full">
        {innerContent}
        {reviewModalNode}
      </div>
    ) : null;
  }

  // 默认 Dialog 模式 — 2026-05-21 迁 BaseDialog 统一架构.
  // innerContent 自己已含 sticky bottom footer (兼容 inline=true 模式), 在 BaseDialog body 区
  // 也能正常浮在底部 (BaseDialog body 自带 overflowY: auto 滚动容器).
  return (
    <>
      <BaseDialog
        open={open}
        onClose={onClose}
        title="局部涂抹重抽"
        iconName="wand"
        maxWidth={920}
        busy={generating}
      >
        {innerContent}
      </BaseDialog>
      {reviewModalNode}
    </>
  );
}
