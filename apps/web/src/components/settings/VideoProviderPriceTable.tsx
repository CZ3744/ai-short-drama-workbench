/**
 * VideoProviderPriceTable — 设置页"视频模型"tab 顶部对照表.
 *
 * 用户原话:
 *   1. "把这个表完善一下做到设置页的视频模型那里方便我以后对照" (2026-05-27)
 *   2. "表格里加上每一条的开发者平台官网让我能直接点过去" (同日)
 *   3. "同一家的不同模型不能并列列, 和厂商一个层级了, 太乱" (同日)
 *
 * 重构: 厂商分组渲染 (VendorGroup) 替代原来的平铺 17 行. 每个厂商一个 section header
 * 含 控制台官网链接 + 充值方式 + 鉴权方式, 下面缩进列该厂商下的多个模型.
 *
 * 数据来源 (核实日期: 2026-05-27, audit pass 修正过 modelId):
 * - 阿里万相: https://www.aliyunbaike.com/bailian/9619/
 * - 字节豆包 Seedance 2.0: https://www.donews.com/news/detail/1/6452016.html
 * - 智谱 CogVideoX-Flash: https://docs.bigmodel.cn/cn/guide/models/free/cogvideox-flash
 * - Vidu 域名 .cn → .com: https://platform.vidu.com/docs/reference-to-video
 */
import { useState, useEffect } from "react";
import { Icon } from "../shared/Icon";

interface ModelRow {
  modelId: string;
  resolution?: string;
  pricePerSec: string;
  integration:
    | { status: "ready"; providerId: string }
    | { status: "ready_change_model"; providerId: string; note: string }
    | { status: "not_available"; reason: string }
    | { status: "needs_new_provider"; note: string };
  notes?: string;
}

interface VendorGroup {
  vendor: string;
  /** 开发者控制台 URL (点击新窗口打开) */
  consoleUrl: string;
  /** 充值方式 (厂商级, 不重复列) */
  payment: string;
  /** 鉴权方式 + 标签 [V/双Key/BCE/Token] */
  authBadge: string;
  /** 厂商整体备注 */
  vendorNote?: string;
  models: ModelRow[];
}

const VENDORS: VendorGroup[] = [
  {
    vendor: "智谱 BigModel",
    consoleUrl: "https://open.bigmodel.cn",
    payment: "支付宝",
    authBadge: "Bearer 单 Key",
    vendorNote: "历史记录采用按次计费，最新价格与规格请在开发者控制台确认。",
    models: [
      {
        modelId: "cogvideox-3",
        resolution: "5/10s · 最高 4K · 30/60fps · 支持 i2v + 首尾帧",
        pricePerSec: "¥1/次 (≈¥0.1-0.2/秒)",
        integration: { status: "ready", providerId: "zhipu_cogvideox" },
        notes: "通过智谱视频连接配置；模型可用性请以控制台为准。",
      },
      {
        modelId: "cogvideox-flash",
        resolution: "最高 4K · 60fps",
        pricePerSec: "免费",
        integration: { status: "ready_change_model", providerId: "zhipu_cogvideox", note: "ZHIPU_VIDEO_MODEL=cogvideox-flash" },
        notes: "免费版有调用限速 · 代码已加字段过滤 (flash 不传 quality/size/fps). 文档没明说 Flash 是否仍在售, 切之前先去开放平台确认",
      },
    ],
  },
  {
    vendor: "阿里通义万相",
    consoleUrl: "https://bailian.console.aliyun.com",
    payment: "微信 + 支付宝",
    authBadge: "Bearer 单 Key",
    vendorNote: "先开通「百炼大模型」才能签 DASHSCOPE Key",
    models: [
      {
        modelId: "wan2.2-t2v-plus",
        resolution: "1080P · 5s",
        pricePerSec: "~¥0.7/秒",
        integration: { status: "ready", providerId: "aliyun_wan_t2v" },
        notes: "通过阿里万相连接配置；模型规格请以控制台为准。",
      },
      {
        modelId: "wan2.6-t2v",
        resolution: "720P · 多镜头 · 2-15s",
        pricePerSec: "¥0.6/秒",
        integration: { status: "ready_change_model", providerId: "aliyun_wan_t2v", note: "ALIYUN_WAN_MODEL=wan2.6-t2v" },
        notes: "新用户开通 90 天内免费 50 秒 · 模型 ID 以百炼控制台为准",
      },
      {
        modelId: "wan2.6-t2v",
        resolution: "1080P · 多镜头 · 2-15s",
        pricePerSec: "¥1.0/秒",
        integration: { status: "ready_change_model", providerId: "aliyun_wan_t2v", note: "同上 + resolution=1080P" },
      },
      {
        modelId: "wan2.7-t2v",
        resolution: "720/1080P · 多镜头 · 含音频",
        pricePerSec: "待官方核",
        integration: { status: "needs_new_provider", note: "schema 改 resolution+ratio, client 需升级" },
        notes: "⚠ 2.7 改 schema, 项目 client 还在传 size, 暂用 2.6",
      },
      {
        modelId: "wanx2.1-t2v-turbo",
        resolution: "480/720P · 5s",
        pricePerSec: "~¥0.4-0.5/秒",
        integration: { status: "ready_change_model", providerId: "aliyun_wan_t2v", note: "ALIYUN_WAN_MODEL=wanx2.1-t2v-turbo" },
        notes: "旧版便宜但质量较弱",
      },
    ],
  },
  {
    vendor: "字节豆包 (火山方舟)",
    consoleUrl: "https://console.volcengine.com/ark",
    payment: "微信 + 支付宝",
    authBadge: "—",
    vendorNote: "走火山方舟 ark.cn-beijing 端点, 跟即梦 visual API 不是一条线",
    models: [
      {
        modelId: "doubao-seedance-2.0",
        resolution: "1080P · ≤15s",
        pricePerSec: "~¥1.0/秒 (46 元/百万 tokens)",
        integration: { status: "not_available", reason: "大陆暂不开放公开 API · 仅企业内部接入" },
        notes: "海外版 Seedance 2.0 Fast = $0.09/秒 · 项目若要接需新写 ARK provider",
      },
    ],
  },
  {
    vendor: "字节即梦 (火山引擎)",
    consoleUrl: "https://console.volcengine.com/cv",
    payment: "微信 + 支付宝",
    authBadge: "双 Key · HMAC 签名",
    vendorNote: "需 access_key + secret_key 不是单 api_key · 控制台开通「即梦视频 3.0」后授权 req_key",
    models: [
      {
        modelId: "jimeng_high_aes_general_v30pro",
        resolution: "1080P · 5-10s",
        pricePerSec: "~¥1.0/秒",
        integration: { status: "ready", providerId: "jimeng_video_3pro" },
      },
      {
        modelId: "jimeng_high_aes_general_v30",
        resolution: "720P · 5-10s",
        pricePerSec: "~¥0.7/秒",
        integration: { status: "ready", providerId: "jimeng_video_3_720p" },
      },
    ],
  },
  {
    vendor: "MiniMax",
    consoleUrl: "https://platform.minimaxi.com",
    payment: "支付宝",
    authBadge: "Bearer 单 Key",
    vendorNote: "国内走 api.minimaxi.com (不要 api.minimax.io 国际版)",
    models: [
      {
        modelId: "MiniMax-Hailuo-2.3",
        resolution: "720/1080P · 6/10s",
        pricePerSec: "~¥1.0-1.5/秒",
        integration: { status: "ready_change_model", providerId: "minimax_hailuo", note: "MINIMAX_VIDEO_MODEL=MiniMax-Hailuo-2.3" },
        notes: "官方最新示例代码用的模型",
      },
      {
        modelId: "MiniMax-Hailuo-02",
        resolution: "720P · 6s",
        pricePerSec: "~¥1.0-1.3/秒",
        integration: { status: "ready", providerId: "minimax_hailuo" },
        notes: "经典稳定版",
      },
    ],
  },
  {
    vendor: "快手可灵 Kling",
    consoleUrl: "https://app.klingai.com/cn/dev",
    payment: "支付宝",
    authBadge: "双 Key · JWT 自签 (30 分钟有效期)",
    vendorNote: "需 access_key + secret_key, 项目内 klingJwt.ts 自动签 token",
    models: [
      {
        modelId: "kling-v2-1-master",
        resolution: "1080P · 5/10s · i2v",
        pricePerSec: "~¥0.7-1.1/秒",
        integration: { status: "ready_change_model", providerId: "kling_3", note: "KLING_MODEL=kling-v2-1-master" },
      },
      {
        modelId: "kling-v2-5-turbo-pro",
        resolution: "1080P · 5/10s",
        pricePerSec: "待官方核",
        integration: { status: "ready_change_model", providerId: "kling_3", note: "KLING_MODEL=kling-v2-5-turbo-pro" },
        notes: "2026 新版, model ID 以可灵控制台为准",
      },
    ],
  },
  {
    vendor: "百度千帆",
    consoleUrl: "https://console.bce.baidu.com/qianfan",
    payment: "微信 + 支付宝",
    authBadge: "BCE V3 鉴权 (非普通 Bearer)",
    vendorNote: "需先开通千帆大模型平台 + 签 BCE V3 token, 用户拿普通 api_key 调不通",
    models: [
      {
        modelId: "VQ3-Pro",
        resolution: "720P · ≤16s",
        pricePerSec: "~¥0.5-1.0/秒",
        integration: { status: "ready", providerId: "baidu_qianfan_video" },
      },
    ],
  },
  {
    vendor: "腾讯混元",
    consoleUrl: "https://console.cloud.tencent.com/vclm",
    payment: "微信 + 支付宝",
    authBadge: "双 Key · TC3-HMAC-SHA256 签名",
    vendorNote: "需 SecretId + SecretKey + region (默认 ap-guangzhou)",
    models: [
      {
        modelId: "hunyuan-video",
        resolution: "1080P · 5s",
        pricePerSec: "~¥1.0+/秒",
        integration: { status: "not_available", reason: "Action SubmitHunyuanToVideoJob 公开文档查不到, 大概率 422 · 待去 vclm 控制台确认 Action 名后再启用" },
      },
    ],
  },
  {
    vendor: "生数 Vidu",
    consoleUrl: "https://platform.vidu.com",
    payment: "支付宝",
    authBadge: "Token 鉴权 (不是 Bearer)",
    vendorNote: "域名 api.vidu.com (代码已修正, 之前误用 .cn)",
    models: [
      {
        modelId: "viduq1",
        resolution: "1080P · 4/8s · 含参考图",
        pricePerSec: "~¥0.6/秒",
        integration: { status: "ready", providerId: "vidu_q3_ref" },
        notes: "当前在售: viduq1 / viduq2(-pro) / viduq3(-turbo/-mix)",
      },
    ],
  },
];

// This archival reference is secondary to current model setup. Remember explicit expansion.
const LS_KEY = "video-generate.settings.video-price-reference-collapsed.v2";

export function VideoProviderPriceTable() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LS_KEY) !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, collapsed ? "1" : "0");
    } catch { /* localStorage unavailable */ }
  }, [collapsed]);

  const totalModels = VENDORS.reduce((acc, v) => acc + v.models.length, 0);

  return (
    <div
      className="mk-card"
      style={{
        marginBottom: 16,
        padding: 0,
        overflow: "hidden",
      }}
    >
      {/* Header — 点击折叠 */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          padding: "12px 16px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
        title={collapsed ? "展开历史价格参考" : "收起历史价格参考"}
        aria-expanded={!collapsed}
      >
        <Icon name={collapsed ? "chevRight" : "chevDown"} size={14} style={{ color: "var(--ink-500)" }} />
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink-900)" }}>
          视频服务历史价格参考
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-500)", fontWeight: 400 }}>
          2026-05-27 记录 · {VENDORS.length} 家厂商 · {totalModels} 个模型
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: "var(--ink-400)" }}>
          {collapsed ? "展开参考" : "收起"}
        </span>
      </button>

      {!collapsed && (
        <div style={{ borderTop: "1px solid var(--ink-100)" }}>
          {/* 简介 */}
          <div style={{
            padding: "10px 16px",
            fontSize: 11.5,
            color: "var(--ink-600)",
            lineHeight: 1.6,
            background: "var(--ink-50)",
          }}>
            以下为 2026 年 5 月整理的历史参考，价格、模型可用性与规格可能已变化。
            实际计费以各厂商控制台为准，请在本页的模型设置中配置和测试自己的连接。
          </div>

          {/* 厂商分组 */}
          {VENDORS.map((vendor) => (
            <VendorSection key={vendor.vendor} vendor={vendor} />
          ))}
        </div>
      )}
    </div>
  );
}

function VendorSection({ vendor }: { vendor: VendorGroup }) {
  return (
    <div style={{ borderTop: "1px solid var(--ink-100)" }}>
      {/* 厂商头部 — 名称 + 控制台链接 + 鉴权 + 充值 */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        background: "var(--ink-50, #f8f8f8)",
        flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-900)" }}>
          {vendor.vendor}
        </span>
        <a
          href={vendor.consoleUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            padding: "2px 7px",
            borderRadius: 5,
            background: "var(--brand-50, rgba(217,119,87,0.08))",
            color: "var(--brand-700, #c2410c)",
            fontSize: 11,
            fontWeight: 600,
            textDecoration: "none",
            border: "1px solid var(--brand-200, transparent)",
          }}
          onClick={(e) => e.stopPropagation()}
          title={`打开开发者控制台: ${vendor.consoleUrl}`}
        >
          <Icon name="globe" size={10} />
          开发者控制台
          <Icon name="external-link" size={9} />
        </a>
        <span style={{
          fontSize: 10.5,
          padding: "2px 7px",
          borderRadius: 5,
          background: "var(--ink-100)",
          color: "var(--ink-700)",
        }}>
          {vendor.authBadge}
        </span>
        <span style={{ fontSize: 10.5, color: "var(--ink-600)" }}>
          充值: {vendor.payment}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10.5, color: "var(--ink-400)" }}>
          {vendor.models.length} 个模型
        </span>
      </div>

      {/* 厂商整体备注 */}
      {vendor.vendorNote && (
        <div style={{
          padding: "6px 16px 8px",
          fontSize: 10.5,
          color: "var(--ink-500)",
          lineHeight: 1.5,
          background: "var(--ink-50, #f8f8f8)",
          borderBottom: "1px solid var(--ink-100)",
        }}>
          <Icon name="info" size={10} style={{ marginRight: 4, color: "var(--ink-400)" }} />
          {vendor.vendorNote}
        </div>
      )}

      {/* 模型行列表 — 不用表格, 用卡片式行布局, 避免模型 ID 列宽小被强行换行 */}
      <div>
        {vendor.models.map((row, idx) => (
          <ModelRowItem key={`${row.modelId}-${idx}`} row={row} isEven={idx % 2 === 0} />
        ))}
      </div>
    </div>
  );
}

function ModelRowItem({ row, isEven }: { row: ModelRow; isEven: boolean }) {
  return (
    <div
      style={{
        padding: "10px 16px",
        borderTop: "1px solid var(--ink-100)",
        background: isEven ? "transparent" : "var(--ink-50, #fafafa)",
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 12,
        alignItems: "center",
      }}
    >
      {/* 列 1: 模型 ID */}
      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <code style={{
          fontSize: 11.5,
          background: "var(--ink-100)",
          padding: "2px 7px",
          borderRadius: 4,
          color: "var(--ink-800)",
          fontWeight: 600,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }} title={row.modelId}>
          {row.modelId}
        </code>
      </div>

      {/* 列 2: 规格 */}
      <div style={{ fontSize: 11, color: "var(--ink-600)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={row.resolution}>
        {row.resolution ?? "—"}
      </div>

      {/* 列 3: 单价 (强调) */}
      <div style={{
        fontSize: 12,
        fontWeight: 600,
        color: "var(--ink-700)",
      }}>
        历史参考：{row.pricePerSec}
      </div>

      {/* 列 4: 状态徽章 + 备注合并显示 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <IntegrationBadge integration={row.integration} />
        {row.notes && (
          <div style={{
            fontSize: 10.5,
            color: "var(--ink-500)",
            lineHeight: 1.45,
            wordBreak: "break-word",
          }}>
            {row.notes}
          </div>
        )}
      </div>
    </div>
  );
}

function IntegrationBadge({ integration }: { integration: ModelRow["integration"] }) {
  switch (integration.status) {
    case "ready":
      return (
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          borderRadius: 4,
          background: "rgba(34, 197, 94, 0.12)",
          color: "var(--ok)",
          fontSize: 10.5,
          fontWeight: 600,
          width: "fit-content",
        }}>
          已提供对应连接方式
        </span>
      );
    case "ready_change_model":
      return (
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          borderRadius: 4,
          background: "var(--brand-50, rgba(217,119,87,0.1))",
          color: "var(--brand-700)",
          fontSize: 10.5,
          fontWeight: 600,
          width: "fit-content",
        }} title={integration.note}>
          需在模型设置中指定
        </span>
      );
    case "not_available":
      return (
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          borderRadius: 4,
          background: "rgba(220, 38, 38, 0.10)",
          color: "var(--err)",
          fontSize: 10.5,
          fontWeight: 600,
          width: "fit-content",
        }} title={integration.reason}>
          历史接入限制
        </span>
      );
    case "needs_new_provider":
      return (
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          borderRadius: 4,
          background: "rgba(184, 134, 11, 0.12)",
          color: "var(--warn, #b8860b)",
          fontSize: 10.5,
          fontWeight: 600,
          width: "fit-content",
        }} title={integration.note}>
          ⚠ 需要升级
        </span>
      );
  }
}

// (Th/Td 已删 — 改用 grid 列布局, 不再用 table)
