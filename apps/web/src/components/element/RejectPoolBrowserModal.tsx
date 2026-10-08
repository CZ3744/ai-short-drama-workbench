/**
 * RejectPoolBrowserModal — 跨级浏览废案库并选择导入 (§11)
 *
 * 2026-05-17 P1.2: 重构为 `LibraryPickerModal` + itemActions 插槽实现, 不再独立维护
 * 弹窗 chrome (header / tabs / search / grid). 对外 props 保持不变.
 *
 * 支持三级: 本素材(element) / 本项目(project) / 公共(public).
 * 每张废案带初始信息, 可导入回当前素材、升级到上级废案库,或彻底清理 (回收站 90 天).
 *
 * 2026-05-16 五件 UX:
 *  - 按钮 icon + 文字 (铁律 #11), 文字明确"导入回当前素材 / 升级到项目库 / 升级到公共库 / 彻底清理"
 *  - "彻底清理" 红描边按钮 — 父组件做二次 confirm
 *  - 配色分级: 导入 → 品牌色; 升级 → 信息蓝; 彻底清理 → 危险红
 */

import { useMemo } from "react";
import { Button } from "../ui/button";
import { type RejectItem } from "../../lib/elementApi";
import { LibraryPickerModal, rejectItemToPickerItem, type PickerItem } from "../library-picker/LibraryPickerModal";

export interface RejectPoolBrowserModalProps {
  open: boolean;
  tier: "element" | "project" | "public";
  rejects: RejectItem[];
  onTierChange: (tier: "element" | "project" | "public") => void;
  /** 2026-05-18: caller 通常 async (importRejectToElement),返回 Promise 允许 modal 等待完成再 onClose */
  onImport: (vaultId: string) => void | Promise<void>;
  onPromote: (vaultId: string, to: "project" | "public") => void;
  /** 2026-05-16: 彻底清理 — 父组件应做 confirm + 调 trashRejectVaultEntry 后刷新列表 */
  onPurge?: (item: RejectItem) => void;
  onClose: () => void;
  /** W8-sweep (2026-05-16): 点击废案图缩略 → MediaLightbox 放大 */
  onOpenImage?: (item: RejectItem) => void;
  /** 2026-05-17 P1.2: caller 可传 slug 让内部 fetch reject 回退,可不传走 caller-fed 模式 */
  slug?: string;
}


export function RejectPoolBrowserModal(props: RejectPoolBrowserModalProps) {
  const { open, tier, rejects, onTierChange, onImport, onPromote, onPurge, onClose, onOpenImage, slug } = props;

  // 2026-05-17 P1.2: caller 已经预 fetch rejects, 映射成 PickerItem 喂给 LibraryPickerModal
  const items: PickerItem[] = useMemo(() => rejects.map(rejectItemToPickerItem), [rejects]);

  // tier tabs
  const customTabs = useMemo(() => ([
    { key: "element", label: "本素材" },
    { key: "project", label: "本项目" },
    { key: "public", label: "公共" },
  ]), []);

  return (
    <LibraryPickerModal
      open={open}
      onClose={onClose}
      slug={slug ?? ""}
      source="reject"
      title="浏览废案库"
      items={items}
      customTabs={customTabs}
      activeTab={tier}
      onTabChange={(t) => onTierChange(t as "element" | "project" | "public")}
      onConfirm={() => onClose()}
      hideConfirmFooter
      onItemClick={(item) => {
        const raw = item.raw as RejectItem | undefined;
        if (raw && onOpenImage) onOpenImage(raw);
      }}
      itemActions={(item) => {
        const raw = item.raw as RejectItem | undefined;
        if (!raw) return null;
        return (
          <>
            <Button
              variant="primary"
              size="xs"
              iconLeft="download"
              title="把这张废案复制回当前素材的图库 (作为候选)"
              onClick={async () => {
                // 2026-05-18: 用户原话"点击本地导入显示成功导入之后,要自动帮我关掉这个二级弹窗"
                // 等 caller importRejectToElement 完成 + toast 后关 modal
                try {
                  await onImport(raw.vault_id);
                } finally {
                  onClose();
                }
              }}
            >
              导入回当前素材
            </Button>
            {tier !== "project" ? (
              <Button
                variant="secondary"
                size="xs"
                iconLeft="arrowRight"
                onClick={() => onPromote(raw.vault_id, "project")}
                title="升级到本项目共享废案库 (项目内跨素材共享)"
              >
                升级到项目库
              </Button>
            ) : null}
            {tier !== "public" ? (
              <Button
                variant="secondary"
                size="xs"
                iconLeft="arrowRight"
                onClick={() => onPromote(raw.vault_id, "public")}
                title="升级到全局公共废案库 (跨项目共享)"
              >
                升级到公共库
              </Button>
            ) : null}
            {onPurge ? (
              <Button
                variant="danger"
                size="xs"
                iconLeft="trash"
                onClick={() => onPurge(raw)}
                title="彻底清理这张废案 — 真把源文件移入归档回收站 (90 天后系统自动删)"
              >
                彻底清理
              </Button>
            ) : null}
          </>
        );
      }}
    />
  );
}

export default RejectPoolBrowserModal;
