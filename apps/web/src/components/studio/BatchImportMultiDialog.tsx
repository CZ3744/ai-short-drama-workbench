/**
 * BatchImportMultiDialog — 导入外部 AI 生成的多剧 JSON, 一键创建所有项目.
 *
 * 用户原话 (2026-05-19 后续, 三连击之 #3):
 * > "点击导入外部 json 之后,提示我自己去创建项目,这是不好的,我的意思是
 * >  在这里导入系统自动解析传入的 json 就能直接帮我创建好所有项目和里面的
 * >  剧本、分集、分镜、素材、所需调用关系...就近可以选定如何自动化"
 *
 * 关键设计:
 *   - 复用后端 BatchMultiEnvelopeSchema (跟 LLM 真生成走同一份 schema)
 *   - 复用 persistOneSeriesFromEnvelope 落盘 (跟 batch-generate 同份逻辑)
 *   - 容错: 接受 ```json fenced block 包裹, 自动剥离
 *   - 解析后给统计预览 "将创建 N 部剧 · M 集 · K 镜" — 让用户先看再确认
 *   - 就近自动化: 勾选后导入完立即对每部剧第 1 集启动 Auto Pipeline
 *
 * UX 铁律覆盖:
 *   - #1 用户控制权: 取消可关; 解析失败给清晰错误不强制走
 *   - #2 可干预性: 解析后展开"将创建什么"摘要让用户审核
 *   - #4 就近决策: 自动化模型选择器贴在这里, 不在全局
 *   - #9 toC 兜底: 错误消息翻人话, 不暴露 zod issue path
 *   - #11 按钮都有名字: icon + 文字
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { ModelPicker } from "./ModelPicker";
import { apiPost } from "../../lib/api";
import { showErrorToast } from "../../lib/errorTranslate";
import { startAutoPipeline } from "../../lib/autoPipelineApi";
import { parseUserJsonPayload } from "../../lib/parseUserJsonPayload";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { BaseDialog } from "../ui/BaseDialog";

export interface BatchImportMultiDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (info: { projects_created: number; series_slugs: string[] }) => void;
  /** 2026-05-21 — 已有系列 title 列表 (导入时检测哪些剧会撞重名) */
  existingTitles?: string[];
}

interface ImportResponse {
  ok: true;
  mode: "import-multi";
  projects_created: number;
  projects_failed: number;
  total_episodes: number;
  total_shots: number;
  total_characters: number;
  total_scenes: number;
  total_pending_image_briefs: number;
  series_slugs: string[];
  series: Array<{
    series_slug: string;
    series_title: string;
    episodes_created: number;
    total_shots: number;
    characters_created: number;
    scenes_created: number;
    pending_image_briefs: number;
  }>;
  duration_ms: number;
}

/** 解析前的本地预览统计 — 不调后端, 纯客户端 */
interface ParsedPreview {
  ok: true;
  projects_count: number;
  total_episodes: number;
  total_shots: number;
  total_characters: number;
  total_scenes: number;
  total_pending_image_briefs: number;
  /** 每部剧的简要 (展示用) */
  projects: Array<{
    title: string;
    episodes_count: number;
    shots_count: number;
    characters_count: number;
    scenes_count: number;
    pending_image_briefs: number;
  }>;
}

interface ParsedError {
  ok: false;
  message: string;
}

function countImageBriefs(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    if (!item || typeof item !== "object") return sum;
    const briefs = (item as { image_briefs?: unknown }).image_briefs;
    return sum + (Array.isArray(briefs) ? briefs.length : 0);
  }, 0);
}

/**
 * 容错解析 JSON 文本 — 剥掉 markdown 代码块、剥前后空白、容许尾逗号.
 * 不做严格 schema 校验 (那一步交给后端 zod), 这里只是为了给用户即时预览.
 */
function tryParseEnvelope(text: string): ParsedPreview | ParsedError {
  // 用统一 parseUserJsonPayload 处理 trim + ```json``` 包裹剥离 + 友好错误
  const r = parseUserJsonPayload<unknown>(text);
  if (!r.ok) return { ok: false, message: r.message };
  const parsed = r.data;

  // 顶层应是 { projects: [...] }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, message: "JSON 顶层必须是对象 (含 projects 数组)" };
  }
  const obj = parsed as { projects?: unknown };
  if (!Array.isArray(obj.projects)) {
    return {
      ok: false,
      message: "JSON 顶层缺少 projects 数组 — 期望: { projects: [{ series: {...}, episodes: [...] }, ...] }",
    };
  }
  if (obj.projects.length === 0) {
    return { ok: false, message: "projects 数组为空, 至少需要 1 部剧" };
  }
  if (obj.projects.length > 10) {
    return { ok: false, message: `projects 数组超出上限 10, 当前 ${obj.projects.length} — 请拆分多次导入` };
  }

  const projectsBrief: ParsedPreview["projects"] = [];
  let totalEpisodes = 0;
  let totalShots = 0;
  let totalCharacters = 0;
  let totalScenes = 0;
  let totalPendingImageBriefs = 0;

  for (let i = 0; i < obj.projects.length; i++) {
    const p = obj.projects[i] as {
      series?: { title?: unknown; characters?: unknown[]; scenes?: unknown[] };
      episodes?: Array<{ shots?: unknown[] }>;
    };
    if (!p || typeof p !== "object") {
      return { ok: false, message: `第 ${i + 1} 部剧不是对象` };
    }
    if (!p.series || typeof p.series !== "object") {
      return { ok: false, message: `第 ${i + 1} 部剧缺少 series 字段` };
    }
    if (typeof p.series.title !== "string" || !p.series.title.trim()) {
      return { ok: false, message: `第 ${i + 1} 部剧缺少 series.title` };
    }
    if (!Array.isArray(p.episodes) || p.episodes.length === 0) {
      return { ok: false, message: `第 ${i + 1} 部剧 (${p.series.title}) 缺少 episodes 数组或为空` };
    }
    const epCount = p.episodes.length;
    const shotsCount = p.episodes.reduce(
      (n, ep) => n + (Array.isArray(ep?.shots) ? ep.shots.length : 0),
      0,
    );
    const charactersCount = Array.isArray(p.series.characters) ? p.series.characters.length : 0;
    const scenesCount = Array.isArray(p.series.scenes) ? p.series.scenes.length : 0;
    const pendingImageBriefs = countImageBriefs(p.series.characters) + countImageBriefs(p.series.scenes);
    projectsBrief.push({
      title: p.series.title,
      episodes_count: epCount,
      shots_count: shotsCount,
      characters_count: charactersCount,
      scenes_count: scenesCount,
      pending_image_briefs: pendingImageBriefs,
    });
    totalEpisodes += epCount;
    totalShots += shotsCount;
    totalCharacters += charactersCount;
    totalScenes += scenesCount;
    totalPendingImageBriefs += pendingImageBriefs;
  }

  return {
    ok: true,
    projects_count: obj.projects.length,
    total_episodes: totalEpisodes,
    total_shots: totalShots,
    total_characters: totalCharacters,
    total_scenes: totalScenes,
    total_pending_image_briefs: totalPendingImageBriefs,
    projects: projectsBrief,
  };
}

export function BatchImportMultiDialog({ open, onClose, onCreated, existingTitles = [] }: BatchImportMultiDialogProps) {
  const navigate = useNavigate();
  const [jsonText, setJsonText] = useState("");
  const [enableAutopilot, setEnableAutopilot] = useState(false);
  const [imageProvider, setImageProvider] = useState<string | null>(null);
  const [videoProvider, setVideoProvider] = useState<string | null>(null);
  // 2026-05-22: 导入时默认参数 (用户原话: "以后导入的时候默认跟着选的参数走").
  // JSON envelope 没填 series.aspect_ratio / platform 时, 用 dialog 这里填的兜底.
  // 默认 9:16 短剧竖屏 (跟 BatchSeriesDialog 同款默认).
  const [defaultAspectRatio, setDefaultAspectRatio] = useState<string>("9:16");
  const [defaultPlatform, setDefaultPlatform] = useState<string>("bilibili");

  const preview = useMemo(() => tryParseEnvelope(jsonText), [jsonText]);

  // 2026-05-21 — 重名检测 (JSON 解析成功后, 用 existingTitles 反查哪些 import title 撞重名)
  const conflictingTitles = useMemo(() => {
    if (!preview.ok) return [];
    const existingLower = new Set(existingTitles.map((t) => t.trim().toLowerCase()));
    return preview.projects
      .filter((p) => existingLower.has(p.title.trim().toLowerCase()))
      .map((p) => p.title);
  }, [preview, existingTitles]);

  // useAsyncAction 管 busy + try/catch — 错误走 showErrorToast 翻译链路
  const submitAction = useAsyncAction(
    async (parsed: unknown) =>
      apiPost<ImportResponse>("/api/v2/series/batch-import-multi", parsed),
    { errorMessage: "导入失败" },
  );
  const busy = submitAction.busy;

  // open 由 BaseDialog 内部处理, 但 hooks 在此 caller 前已声明, 无需 early-return

  async function handleSubmit() {
    if (busy) return;
    if (!preview.ok) {
      toast.error(preview.message);
      return;
    }
    // 复用同 helper 拿到 parsed (前面 tryParseEnvelope 已经验过)
    const r = parseUserJsonPayload<unknown>(jsonText);
    if (!r.ok) {
      toast.error(r.message);
      return;
    }

    // 2026-05-22: 把 dialog 选的默认 aspect_ratio + platform 注入每个 envelope.series
    // (JSON 已填的优先, 没填的用 dialog 默认). 这样导入的剧 series.defaults.aspect_ratio
    // 跟用户选的一致, 不再 fallback 写死 16:9.
    const payload = r.data as { projects?: Array<{ series?: { aspect_ratio?: string; platform?: string } }> };
    if (payload?.projects && Array.isArray(payload.projects)) {
      for (const p of payload.projects) {
        if (p?.series) {
          if (!p.series.aspect_ratio) p.series.aspect_ratio = defaultAspectRatio;
          if (!p.series.platform) p.series.platform = defaultPlatform;
        }
      }
    }

    const result = await submitAction.run(payload);
    if (!result) return;
    const imageBriefSummary =
      result.total_pending_image_briefs > 0 ? ` · ${result.total_pending_image_briefs} 张素材图待生成` : "";
    const summary = `已创建 ${result.projects_created} 部剧 · 共 ${result.total_episodes} 集, ${result.total_shots} 个分镜${imageBriefSummary}`;
    toast.success(summary);

    // 就近自动化: 对每部剧第 1 集启动 Auto Pipeline (串行, 防止后端过载)
    if (enableAutopilot && (imageProvider || videoProvider)) {
      toast.message("正在为每部剧启动自动管线...", {
        description: `${result.series_slugs.length} 部剧 × 第 1 集`,
      });
      let autopilotStarted = 0;
      let autopilotFailed = 0;
      const failedSeriesNames: string[] = [];
      for (const slug of result.series_slugs) {
        if (slug.startsWith("__failed_")) continue;
        try {
          // 拉该 series 的第 1 集 id — 用 GET /series/:slug
          const seriesDetail = await fetch(`/api/v2/series/${encodeURIComponent(slug)}`).then(
            (r) => r.json() as Promise<{ episodes: Array<{ id: string }> }>,
          );
          const ep1 = seriesDetail.episodes?.[0];
          if (!ep1) {
            autopilotFailed += 1;
            failedSeriesNames.push(slug);
            continue;
          }
          const body: Parameters<typeof startAutoPipeline>[2] = {};
          if (imageProvider) body.image_provider_id = imageProvider;
          if (videoProvider) body.video_provider_id = videoProvider;
          await startAutoPipeline(slug, ep1.id, body);
          autopilotStarted += 1;
        } catch (e) {
          // eslint-disable-next-line no-console
          showErrorToast(e, `系列 ${slug} 分镜展开失败, 可手动重新规划`);
          autopilotFailed += 1;
          failedSeriesNames.push(slug);
        }
      }
      if (autopilotStarted > 0) {
        toast.success(
          `已为 ${autopilotStarted} 部剧启动自动管线${autopilotFailed > 0 ? ` (${autopilotFailed} 失败)` : ""}`,
        );
      }
      if (failedSeriesNames.length > 0) {
        toast.error(`以下 ${failedSeriesNames.length} 部剧自动管线启动失败：${failedSeriesNames.join("、")} — 请稍后到任务面板手动启动`);
      }
    }

    if (onCreated) {
      onCreated({
        projects_created: result.projects_created,
        series_slugs: result.series_slugs.filter((s) => !s.startsWith("__failed_")),
      });
    }
    onClose();
    navigate("/studio");
  }

  return (
    <BaseDialog
      open={open}
      onClose={onClose}
      busy={busy}
      zIndex={110}
      iconName="upload"
      title="导入外部 AI 生成的多剧 JSON"
      subtitle="一键创建所有项目 + 剧本 + 分集 + 分镜 + 素材"
      ariaLabel="导入外部 JSON 创建多部剧"
      footerLeft={
        <span style={{ fontSize: 11.5, color: "var(--ink-500)" }}>
          {preview.ok
            ? `准备就绪 — 将创建 ${preview.projects_count} 部剧${
                preview.total_pending_image_briefs > 0 ? ` · ${preview.total_pending_image_briefs} 张素材图待生成` : ""
              }`
            : "粘贴 JSON 后这里显示解析结果"}
        </span>
      }
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft="sparkles"
            onClick={() => void handleSubmit()}
            disabled={busy || !preview.ok}
            loading={busy}
          >
            {busy
              ? "导入中…"
              : preview.ok
              ? `解析并一键创建 ${preview.projects_count} 部剧`
              : "请先粘贴有效 JSON"}
          </Button>
        </>
      }
    >
          {/* 使用流程指引 */}
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              background: "linear-gradient(135deg, var(--brand-50), var(--brand-100))",
              border: "1px solid var(--brand-200)",
              fontSize: 12,
              color: "var(--brand-800)",
              lineHeight: 1.7,
              marginBottom: 16,
            }}
          >
            <strong style={{ display: "block", marginBottom: 4 }}>使用流程</strong>
            1. 在「批量 AI 生成系列」点「查看完整提示词」, 复制走<br />
            2. 粘到 ChatGPT / Claude / Gemini 让它生成 JSON<br />
            3. 把 AI 输出的 JSON 粘到下方<br />
            4. 点「解析并一键创建」, 系统自动创建所有剧 + 剧本 + 分集 + 分镜 + 素材
          </div>

          {/* JSON 输入框 */}
          <div style={{ marginBottom: 14 }}>
            <label
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.08em",
                color: "var(--ink-500)",
                textTransform: "uppercase",
                marginBottom: 6,
                display: "block",
              }}
            >
              粘贴 JSON ({jsonText.length} 字符)
            </label>
            <Textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder={`期望格式 (容许 \`\`\`json 代码块包裹):\n\n{\n  "projects": [\n    {\n      "series": {\n        "title": "第 1 部剧",\n        "synopsis": "...",\n        "characters": [{ "name": "..." }],\n        "scenes": [{ "name": "..." }]\n      },\n      "episodes": [\n        { "title": "第1集", "shots": [{ "index": 1, "action": "..." }] }\n      ]\n    }\n  ]\n}`}
              rows={12}
              disabled={busy}
              className="font-mono text-[12px] leading-[1.55] text-[var(--ink-800)] min-h-[220px]"
            />
          </div>

          {/* 解析预览 */}
          {jsonText.trim() && (
            <div style={{ marginBottom: 16 }}>
              {preview.ok ? (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    background: "var(--ok-50, #ecfdf5)",
                    border: "1px solid var(--ok-200, #a7f3d0)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--ok-700, #047857)",
                      marginBottom: 8,
                    }}
                  >
                    <Icon name="check" size={14} /> 解析通过 — 将创建 {preview.projects_count} 部剧 · 共{" "}
                    {preview.total_episodes} 集 · {preview.total_shots} 镜
                    {preview.total_characters + preview.total_scenes > 0 && (
                      <span style={{ fontWeight: 400, color: "var(--ok-600, #059669)" }}>
                        {" "}
                        · {preview.total_characters} 角色 · {preview.total_scenes} 场景
                      </span>
                    )}
                    {preview.total_pending_image_briefs > 0 && (
                      <span style={{ fontWeight: 700, color: "var(--brand-700)" }}>
                        {" "}
                        · {preview.total_pending_image_briefs} 张素材图待生成
                      </span>
                    )}
                  </div>
                  {/* 2026-05-21 — 重名警告 (跟现有系列撞同名): 不阻塞导入, 显式告知 + 列出冲突剧名 */}
                  {conflictingTitles.length > 0 && (
                    <div
                      style={{
                        padding: "8px 10px",
                        background: "rgba(217, 119, 6, 0.08)",
                        border: "1px solid rgba(217, 119, 6, 0.2)",
                        borderRadius: 8,
                        fontSize: 12,
                        color: "var(--ink-700)",
                        lineHeight: 1.5,
                        marginBottom: 8,
                      }}
                    >
                      <strong style={{ color: "var(--warn, #d97706)" }}>
                        ⚠ 其中 {conflictingTitles.length} 部跟现有系列同名
                      </strong>
                      <div style={{ marginTop: 2, color: "var(--ink-600)" }}>
                        重名剧: {conflictingTitles.map((t) => `「${t}」`).join("、")}.
                        继续导入会作为另一部独立系列(slug 加后缀 -2 区分)。
                        建议改 JSON 里的 title 字段或确认是有意的同名版本.
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {preview.projects.map((p, i) => (
                      <div
                        key={i}
                        style={{
                          fontSize: 11.5,
                          color: "var(--ink-700)",
                          padding: "3px 8px",
                          background: "rgba(255,255,255,0.6)",
                          borderRadius: 6,
                        }}
                      >
                        <strong style={{ color: "var(--brand-700)" }}>项目 {i + 1}</strong>
                        {" · "}
                        <span style={{ color: "var(--ink-900)" }}>{p.title}</span>
                        {" · "}
                        {p.episodes_count} 集 / {p.shots_count} 镜
                        {p.characters_count > 0 && ` / ${p.characters_count} 角色`}
                        {p.scenes_count > 0 && ` / ${p.scenes_count} 场景`}
                        {p.pending_image_briefs > 0 && ` / ${p.pending_image_briefs} 张素材图`}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    padding: 12,
                    borderRadius: 10,
                    background: "var(--err-50, #fef2f2)",
                    border: "1px solid var(--err-200, #fecaca)",
                    color: "var(--err-700, #b91c1c)",
                    fontSize: 13,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <Icon name="warning" size={14} />
                  {preview.message}
                </div>
              )}
            </div>
          )}

          {/* 2026-05-22 — 默认画面比例 + 投放平台 (用户原话: "以后导入的时候默认跟着选的参数走").
              JSON envelope 没填 series.aspect_ratio/platform 时, 用这俩 fallback. */}
          <div
            style={{
              padding: 14,
              borderRadius: 12,
              border: "1px solid var(--ink-100)",
              background: "var(--ink-50)",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "var(--ink-500)", textTransform: "uppercase", marginBottom: 5 }}>
                默认画面比例
              </div>
              <select
                value={defaultAspectRatio}
                onChange={(e) => setDefaultAspectRatio(e.target.value)}
                disabled={busy}
                style={{ width: "100%", height: 32, padding: "0 8px", fontSize: 12.5, borderRadius: 6, border: "1px solid var(--ink-200)", background: "var(--surface-card)" }}
              >
                <option value="9:16">9:16 竖屏 (短剧默认 · 抖音/小红书)</option>
                <option value="16:9">16:9 横屏</option>
                <option value="1:1">1:1 方形</option>
                <option value="4:3">4:3 经典</option>
                <option value="21:9">21:9 电影宽屏</option>
              </select>
              <div style={{ fontSize: 10.5, color: "var(--ink-500)", marginTop: 4 }}>JSON 里没填时用这个 · 候选缩略图按此显示</div>
            </div>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: "var(--ink-500)", textTransform: "uppercase", marginBottom: 5 }}>
                默认投放平台
              </div>
              <select
                value={defaultPlatform}
                onChange={(e) => setDefaultPlatform(e.target.value)}
                disabled={busy}
                style={{ width: "100%", height: 32, padding: "0 8px", fontSize: 12.5, borderRadius: 6, border: "1px solid var(--ink-200)", background: "var(--surface-card)" }}
              >
                <option value="bilibili">Bilibili</option>
                <option value="douyin">抖音 Douyin</option>
                <option value="xhs">小红书 XHS</option>
                <option value="youtube">YouTube</option>
                <option value="wechat_channels">视频号</option>
              </select>
              <div style={{ fontSize: 10.5, color: "var(--ink-500)", marginTop: 4 }}>影响 AI 拼镜头风格 · JSON 没填时用</div>
            </div>
          </div>

          {/* 就近自动化区 */}
          <div
            style={{
              padding: 14,
              borderRadius: 12,
              border: "1px solid var(--ink-100)",
              background: "var(--ink-50)",
            }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ink-900)",
                cursor: "pointer",
                marginBottom: enableAutopilot ? 10 : 0,
              }}
            >
              <input
                type="checkbox"
                checked={enableAutopilot}
                onChange={(e) => setEnableAutopilot(e.target.checked)}
                disabled={busy}
                style={{ width: 16, height: 16 }}
              />
              {/* 2026-05-19 toC 文案: 删 "(Auto Pipeline)" 技术词 — 用户原话"所有地方的表述要 toC" */}
              导入后立即开始自动生成
              <span style={{ fontWeight: 400, color: "var(--ink-500)", fontSize: 11 }}>
                · 每部剧第 1 集自动跑首帧 → 视频 → 合成
              </span>
            </label>
            {enableAutopilot && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      color: "var(--ink-500)",
                      textTransform: "uppercase",
                      marginBottom: 5,
                    }}
                  >
                    图像模型
                  </div>
                  <ModelPicker
                    kind="image"
                    value={imageProvider}
                    onChange={setImageProvider}
                    placeholder="选择图像模型"
                    size="sm"
                  />
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      color: "var(--ink-500)",
                      textTransform: "uppercase",
                      marginBottom: 5,
                    }}
                  >
                    视频模型
                  </div>
                  <ModelPicker
                    kind="video"
                    value={videoProvider}
                    onChange={setVideoProvider}
                    placeholder="选择视频模型"
                    size="sm"
                  />
                </div>
              </div>
            )}
          </div>
    </BaseDialog>
  );
}

export default BatchImportMultiDialog;
