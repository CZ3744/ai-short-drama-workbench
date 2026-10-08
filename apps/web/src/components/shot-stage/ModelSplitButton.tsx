// 来源: design-skill/video-generate/src/batch2b.jsx:241-342 (ModelSplitButton)
// v24-batch-all · 双层模型选择器 (主按钮 + 右侧 caret 下拉)
// 下拉内容: 热路径 TOP 3 + 全部模型 + "仅本次生效" 提示
//
// 数据源: props.models (由父组件通过 shotApi.listModels() 获取) + props.hotPath (可选外传)
// 未传 hotPath 时从 lib/modelDict/hotPathFor() 读取静态表

import { useState, useRef, useEffect } from "react";
import { MODEL_DICT, hotPathFor, type ModelAction, type ModelDescriptor } from "../../lib/modelDict";
import { Icon } from "../shared/Icon";

export interface ModelSplitButtonProps {
  actionKey: ModelAction;
  label: string;
  /** 可选: 外部传入的模型列表 (通常来自 shotApi.listModels) */
  models?: ModelDescriptor[];
  /** 可选: 外部传入的热路径名 */
  hotPath?: string[];
  /** 当前选中的模型 id, 未传则取默认 */
  value?: string;
  defaultModel?: string;
  /** 生成按钮点击 */
  onGenerate?: (modelId: string) => void;
  /** 切换选中 */
  onChange?: (modelId: string) => void;
  /** 紧凑模式 — 文字更小 */
  compact?: boolean;
  disabled?: boolean;
  /** 模型选择是否 "仅本次生效" — 语义由父组件处理, 此处只显示提示 */
  oneShot?: boolean;
  onToggleOneShot?: (oneShot: boolean) => void;
}

export function ModelSplitButton(props: ModelSplitButtonProps) {
  const actionModels = (props.models ?? MODEL_DICT).filter((m) => m.actions.includes(props.actionKey));
  const hot = props.hotPath ?? hotPathFor(props.actionKey);

  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState<string>(
    props.defaultModel ?? actionModels[0]?.id ?? "",
  );
  const currentId = props.value ?? internalValue;
  const current = actionModels.find((m) => m.id === currentId) ?? actionModels[0];

  const popRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (ev: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  function selectModel(id: string) {
    if (props.value === undefined) setInternalValue(id);
    props.onChange?.(id);
    setOpen(false);
  }

  const hotModels = actionModels.filter((m) => hot.includes(m.name));
  const otherModels = actionModels.filter((m) => !hot.includes(m.name));

  return (
    <div className="v24-msb-wrap" ref={popRef}>
      {/* 保留原因 (4 处): split button 复合视觉 — v24-msb-main/caret/item 是建立好的非-mk-btn 语义 class,主按钮 + 右侧 caret 一体化,popover item 复合 dot+name+note+price 三行 layout */}
      <button
        type="button"
        className="v24-msb-main"
        disabled={props.disabled || !current}
        style={props.compact ? { height: 32, padding: "0 12px", fontSize: 13 } : undefined}
        onClick={() => current && props.onGenerate?.(current.id)}
      >
        <span>{props.label}</span>
        {current ? (
          <span className="v24-msb-chip">
            <Icon name="sparkles" size={10} />
            {current.name}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="v24-msb-caret"
        style={props.compact ? { width: 30, height: 32 } : undefined}
        onClick={() => setOpen((v) => !v)}
        aria-label="切换模型"
      >
        <Icon name="chevDown" size={14} />
      </button>

      {open ? (
        <div className="v24-msb-popover" role="menu">
          {hotModels.length > 0 ? (
            <>
              <div className="v24-msb-section">热路径 · 最近 5 分钟常用</div>
              {hotModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`v24-msb-item v24-msb-item--hot${m.id === currentId ? " v24-msb-item--on" : ""}`}
                  onClick={() => selectModel(m.id)}
                >
                  <span className={`v24-msb-item-dot${m.status === "coming" ? " v24-msb-item-dot--coming" : ""}`} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div className="v24-msb-item-name">
                      {m.name}
                      {m.hot ? <span style={{ fontSize: 10, color: "#d97757" }}>· 常用</span> : null}
                    </div>
                    <div className="v24-msb-item-note">{m.note}</div>
                    <div className="v24-msb-item-price">{m.price} · {m.eta}</div>
                  </span>
                </button>
              ))}
            </>
          ) : null}

          {otherModels.length > 0 ? (
            <>
              <div className="v24-msb-section">全部模型</div>
              {otherModels.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`v24-msb-item${m.id === currentId ? " v24-msb-item--on" : ""}`}
                  disabled={m.status === "coming"}
                  onClick={() => m.status !== "coming" && selectModel(m.id)}
                >
                  <span className={`v24-msb-item-dot${m.status === "coming" ? " v24-msb-item-dot--coming" : ""}`} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div className="v24-msb-item-name">
                      {m.name}
                      {m.status === "coming" ? <span style={{ fontSize: 10, color: "#a8a29a" }}>· 接入中</span> : null}
                    </div>
                    <div className="v24-msb-item-note">{m.note}</div>
                    <div className="v24-msb-item-price">{m.price} · {m.eta}</div>
                  </span>
                </button>
              ))}
            </>
          ) : null}

          <div className="v24-msb-foot">
            <Icon name="info" size={12} />
            <span>仅本次生效</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
