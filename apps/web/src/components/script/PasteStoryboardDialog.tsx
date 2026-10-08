/**
 * PasteStoryboardDialog — 粘贴外部 AI 生成的分镜 JSON 一键导入.
 *
 * 2026-05-18 EVE-4 (用户原话):
 * > "评估一下可以跳过灵感生成剧本直接粘贴分镜吗? ... 我的应用场景:
 * >  直接在其他地方让 AI 给我生成完整分镜脚本, 并且在那里我直接通过
 * >  提示词要求他生成可以一键导入的文本结构, 这就需要前端放一个如果用户
 * >  自己导入, 导入的文字需要什么样的结构的指示方便后端处理"
 *
 * 提取自 ScriptCanvasPage 内部 dialog, 共享给 ScriptCanvasPage + ShotboardPage 双入口.
 *
 * UX 优化:
 *   - 顶部加显眼格式提示行 (不再藏在 details 折叠里)
 *   - JSON schema 示例默认展开, 用户能直接看到字段
 *   - 加 "复制 Prompt 模板给 AI" 按钮 — 直接给 ChatGPT/Claude/Gemini 用的提示词模板
 *
 * 后端端点 (2026-05-18 EVE-4 补完):
 *   - POST /api/v2/series/:slug/episodes/:epId/import-storyboard  (episode 级)
 *   - POST /api/v2/series/:slug/import-storyboard                  (series 级 fallback)
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Icon } from "../shared/Icon";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { apiPost, ApiError } from "../../lib/api";
import { parseUserJsonPayload } from "../../lib/parseUserJsonPayload";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { useConfirm } from "../ui/ConfirmModal";
import { BaseDialog } from "../ui/BaseDialog";

const STORYBOARD_SCHEMA_EXAMPLE = JSON.stringify(
  {
    episodes: [
      {
        title: "第一集",
        synopsis: "一句话剧情",
        shots: [
          {
            index: 1,
            action: "画面描述 — 必填,例如 '昏暗服务器机房,镜头跟随主角从画面外走入,主角神情焦虑'",
            shot_type: "近景",
            camera_movement: "缓慢推进",
            duration_sec: 5,
            dialogue: "台词(可选)",
            voiceover: "旁白(可选)",
            // 2026-05-19: 让导入后一键抽首帧能复用素材库已有的 typical 图保持五官/外形一致
            character_refs: ["角色名 — 必须与素材库中已有的角色 name 完全一致"],
            scene_ref: "场景名 — 必须与素材库中已有的场景 name 完全一致",
          },
        ],
      },
    ],
  },
  null,
  2,
);

// 直接给外部 AI 用的提示词模板 — 用户复制走粘到 ChatGPT 等
const PROMPT_TEMPLATE_FOR_AI = `请按以下严格的 JSON Schema 输出短剧分镜数据。我会把你的输出直接粘贴到我的本地 AI 短剧工作台一键导入,所以请只输出 JSON,不要任何 markdown 包裹、注释、说明文字。

要求:
- 围绕主题 [在这里写你的剧本主题或灵感]
- 每个镜头必须有 index (从 1 开始递增) 和 action (画面描述)
- shot_type 可选值: 远景 / 全景 / 中景 / 近景 / 特写 / 大特写 / 插入镜
- camera_movement 可选值: 固定 / 缓慢推进 / 缓慢拉远 / 横移左 / 横移右 / 跟随 / 手持
- duration_sec 是秒数(正整数)
- dialogue / voiceover 可选,有台词或旁白才填
- character_refs / scene_ref (重要 — 关系到一键抽首帧能否复用素材库 typical 图):
   * 如果镜头里出现的角色/场景已经在我的素材库中创建过, 写出对应的 name 数组/字符串
   * 这样一键抽首帧时, 系统会自动把素材库里这些角色/场景的 typical 图作 reference 喂给生图模型, 保持五官 / 外形 / 风格一致
   * 如果不确定素材库有没有这个名字, 留空也行, 但强烈建议写

输出 JSON Schema:
\`\`\`json
${STORYBOARD_SCHEMA_EXAMPLE}
\`\`\`

注意:
- 直接输出 JSON 对象,不要用 markdown 代码块包裹
- 不要写 "好的我来帮你..." 之类的开场白
- 不要在 JSON 外加任何说明文字`;

export interface PasteStoryboardDialogProps {
  slug: string;
  /** 不传 = series 级 import-storyboard (后端自动选 ep01 或创建);传了 = episode 级 */
  epId?: string;
  onClose: () => void;
  onImported: () => void;
}

export function PasteStoryboardDialog({ slug, epId, onClose, onImported }: PasteStoryboardDialogProps) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [pasteText, setPasteText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  // 用 useAsyncAction 统一管 busy + try/catch/finally, 错误走 inline parseError UI 不弹 toast
  const importAction = useAsyncAction(
    async (parsed: unknown) => {
      const url = epId
        ? `/api/v2/series/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(epId)}/import-storyboard`
        : `/api/v2/series/${encodeURIComponent(slug)}/import-storyboard`;
      type ImportResult = {
        episode_id: string;
        version_id: string;
        imported_shots: number;
        skipped_extra_episodes?: number;
        created_script_stub?: boolean;
      };
      const doImport = (force: boolean) =>
        apiPost<ImportResult>(url, { storyboard: parsed, ...(force ? { force: true } : {}) });
      try {
        return await doImport(false);
      } catch (err) {
        // 2026-07-22 X3-4 (A6-3): 目标集已有分镜 → 后端 409 确认门. 弹 toC 确认(不暴露 force=true 技术细节),
        // 讲清"旧分镜整套进垃圾桶(可恢复)、已生成文件仍在归档柜", 用户确认后带 force 重发.
        if (err instanceof ApiError && err.status === 409 && err.code === "StoryboardAlreadyExists") {
          const d = (err.details ?? {}) as { existing_count?: number; generation_count?: number };
          const total = d.existing_count ?? 0;
          const gen = d.generation_count ?? 0;
          const ok = await confirm({
            title: "这一集已经有分镜了",
            description: [
              `目标集已有 ${total} 个分镜${gen > 0 ? `,其中 ${gen} 镜已经生成过首帧/视频结果` : ""}。`,
              "",
              "继续导入会把现有分镜整体移入「分镜垃圾桶」(可恢复) — 你之前挑选的候选、裁剪、命名会一起进垃圾桶;已生成的图片/视频文件仍然保留在归档柜。",
            ].join("\n"),
            variant: "warning",
            confirmLabel: "移入垃圾桶并导入",
            cancelLabel: "保留现有分镜",
          });
          if (!ok) throw Object.assign(new Error("已取消导入"), { __userCancelled: true });
          return await doImport(true);
        }
        throw err;
      }
    },
    {
      silent: true, // 错误显示在 inline parseError, 不弹 toast
      onSuccess: (result) => {
        const episodeId = result.episode_id;
        const detailPath = `/studio/${encodeURIComponent(slug)}/storyboard/${episodeId}`;
        // 铁律 #1 用户控制权: 不强制跳转, toast + action 让用户决定
        toast.success(
          `已导入 ${result.imported_shots} 个镜头到「${episodeId}」` +
            (result.skipped_extra_episodes ? ` (跳过 ${result.skipped_extra_episodes} 个额外集)` : "") +
            (result.created_script_stub ? " · 已自动创建占位剧本" : ""),
          {
            duration: 8000,
            action: {
              label: "查看分镜",
              onClick: () => navigate(detailPath),
            },
          },
        );
        onImported();
      },
      onError: (err) => {
        // 用户在 409 确认门点了"保留现有分镜" → 主动取消, 不当作错误展示
        if (err && typeof err === "object" && (err as { __userCancelled?: boolean }).__userCancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setParseError(`导入失败: ${msg}`);
      },
    },
  );
  const busy = importAction.busy;

  async function handleImport() {
    if (busy || !pasteText.trim()) return;
    setParseError(null);

    // 用 parseUserJsonPayload 统一处理 ```json``` 包裹 + 友好错误
    const r = parseUserJsonPayload<unknown>(pasteText);
    if (!r.ok) {
      setParseError(
        `${r.message}\n请检查粘贴内容是不是被 markdown 代码块包裹了, 或者用 "复制 Prompt 模板" 按钮重新让 AI 生成纯 JSON`,
      );
      return;
    }

    await importAction.run(r.data);
  }

  async function copyPromptTemplate() {
    try {
      await navigator.clipboard.writeText(PROMPT_TEMPLATE_FOR_AI);
      toast.success("Prompt 模板已复制 — 粘到 ChatGPT/Claude/Gemini, 让它生成分镜 JSON 再粘回来");
    } catch {
      toast.error("剪贴板复制失败, 请手动选中复制");
    }
  }

  return (
    <BaseDialog
      open={true}
      onClose={onClose}
      busy={busy}
      zIndex={100}
      title="粘贴 AI 生成的分镜 JSON"
      subtitle="跳过本地灵感→剧本步骤, 直接从外部 AI 一键导入分镜"
      ariaLabel="粘贴 AI 输出导入分镜"
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            iconLeft="arrowRight"
            loading={busy}
            disabled={busy || !pasteText.trim()}
            onClick={handleImport}
          >
            {busy ? "解析中…" : "解析并导入"}
          </Button>
        </>
      }
    >
        {/* 工作流提示 — 醒目 */}
        <div
          style={{
            display: "flex", flexDirection: "column", gap: 8,
            padding: "12px 14px", marginBottom: 14,
            background: "var(--brand-25, rgba(217,119,87,0.06))",
            border: "1px solid var(--brand-200, rgba(217,119,87,0.2))",
            borderRadius: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Icon name="sparkles" size={13} style={{ color: "var(--brand-600)" }} />
            <span style={{ fontSize: 12.5, fontWeight: 650, color: "var(--brand-700)" }}>
              使用流程
            </span>
          </div>
          <ol style={{ margin: 0, paddingLeft: 22, fontSize: 12, color: "var(--ink-700)", lineHeight: 1.7 }}>
            <li>点 <strong>「复制 Prompt 模板」</strong> 拿到给外部 AI 用的提示词</li>
            <li>粘到 ChatGPT / Claude / Gemini, 替换"剧本主题"占位文字</li>
            <li>让 AI 输出 JSON, 复制 AI 输出</li>
            <li>粘到下方文本框, 点 <strong>「解析并导入」</strong></li>
          </ol>
          <Button
            variant="secondary"
            size="sm"
            iconLeft="doc"
            style={{ alignSelf: "flex-start" }}
            onClick={copyPromptTemplate}
          >
            复制 Prompt 模板给外部 AI
          </Button>
        </div>

        {/* JSON 格式说明 — 默认展开, 不再折叠 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <Icon name="code" size={12} style={{ color: "var(--ink-500)" }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-500)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              JSON 期望格式 (字段说明)
            </span>
          </div>
          <pre
            style={{
              margin: 0, padding: "10px 12px",
              background: "var(--ink-50)", borderRadius: 8,
              fontSize: 11.5, fontFamily: "ui-monospace, Consolas, monospace",
              color: "var(--ink-700)", whiteSpace: "pre-wrap",
              lineHeight: 1.5, maxHeight: 180, overflowY: "auto",
              border: "1px solid var(--ink-100)",
            }}
          >
            {STORYBOARD_SCHEMA_EXAMPLE}
          </pre>
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--ink-500)", lineHeight: 1.5 }}>
            必填字段: <code>episodes[].shots[].index</code> + <code>episodes[].shots[].action</code> ·
            可选: shot_type / camera_movement / duration_sec / dialogue / voiceover ·
            多集时取第 1 集导入到当前 episode, 其余跳过
          </div>
        </div>

        {/* JSON 粘贴区 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-400)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
            粘贴 AI 输出的 JSON
          </div>
          <Textarea
            value={pasteText}
            onChange={(e) => { setPasteText(e.target.value); setParseError(null); }}
            placeholder={'{\n  "episodes": [\n    {\n      "title": "第一集",\n      "shots": [\n        { "index": 1, "action": "...",\n          "image_overrides": { "character:角色名": 1 }\n        }\n      ]\n    }\n  ]\n}\n\n— 也支持 ```json ... ``` markdown 代码块, 会自动剥掉\n— image_overrides 可选, 指定每个素材用第几张图(1-based), 不写则用代表图'}
            rows={10}
            autoFocus
            spellCheck={false}
            error={!!parseError}
            className="font-mono text-[12px] leading-[1.5]"
            style={{ background: parseError ? "var(--err-bg, #fff5f5)" : undefined }}
          />
          {parseError && (
            <div style={{ marginTop: 6, fontSize: 12, color: "var(--err)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {parseError}
            </div>
          )}
        </div>
    </BaseDialog>
  );
}
