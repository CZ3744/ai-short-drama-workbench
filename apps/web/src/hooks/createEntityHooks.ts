/**
 * createEntityHooks — 通用 entity SWR hook factory
 *
 * 消除 useCharacters / useScenes 的重复 CRUD 模式。
 * 两者共享：
 *   - useList(slug)       — SWR 列表
 *   - useSingle(slug, id) — SWR 单项
 *   - create(slug, body)  — POST
 *   - patch(slug, id, body) — PATCH
 *   - remove(slug, id)    — DELETE (软删)
 *   - lock(slug, id, body) — POST /:id/lock (可选，传 undefined 则不暴露)
 *
 * @template TEntity  实体完整类型
 * @template TCreate  创建时的 body 类型
 * @template TPatch   PATCH 时的 body 类型
 * @template TLockBody lock 接口的 body 类型（不传则不生成 lock）
 */

import useSWR from "swr";
import { apiGet, apiPost, apiPatch, apiDelete } from "../lib/api";
import { showErrorToast } from "../lib/errorTranslate";

export interface EntityHooksConfig<TEntity, TCreate, TPatch, TLockBody = never> {
  /**
   * 集合路径，如 `/api/v2/series/${slug}/characters`
   * 接受 slug 返回字符串
   */
  listPath: (slug: string) => string;
  /**
   * 单项路径，如 `/api/v2/series/${slug}/characters/${id}`
   */
  itemPath: (slug: string, id: string) => string;
  /**
   * SWR cache key 前缀，如 "characters"
   * 最终 key 是 `${cacheKeyPrefix}:${slug}`
   */
  cacheKeyPrefix: string;
  /**
   * 列表响应中取数组的 key，如 "characters" / "scenes"
   */
  listResponseKey: keyof any;
  /**
   * 单项响应中取对象的 key，如 "character" / "scene"
   */
  itemResponseKey: keyof any;
  /**
   * lock 接口路径（可选）。传则生成 lock()，不传则 lock 为 undefined。
   */
  lockPath?: (slug: string, id: string) => string;
}

export function createEntityHooks<
  TEntity,
  TCreate,
  TPatch,
  TLockBody = Record<string, unknown>,
>(config: EntityHooksConfig<TEntity, TCreate, TPatch, TLockBody>) {
  const {
    listPath,
    itemPath,
    cacheKeyPrefix,
    listResponseKey,
    itemResponseKey,
    lockPath,
  } = config;

  // ── List hook ───────────────────────────────────────────────────────
  function useList(slug: string | undefined) {
    const key = slug ? `${cacheKeyPrefix}:${slug}` : null;
    const url = slug ? listPath(slug) : "";
    return useSWR<TEntity[]>(
      key,
      () =>
        apiGet<Record<string, TEntity[]>>(url).then(
          (r) => (r[listResponseKey as string] as TEntity[]) ?? [],
        ),
      {
        revalidateOnFocus: false,
        dedupingInterval: 3000,
        onError: (err) => {
          showErrorToast(err);
        },
      },
    );
  }

  // ── Single hook ─────────────────────────────────────────────────────
  function useSingle(slug: string | undefined, id: string | undefined) {
    const key = slug && id ? `${cacheKeyPrefix}-item:${slug}:${id}` : null;
    const url = slug && id ? itemPath(slug, id) : "";
    return useSWR<TEntity>(
      key,
      () =>
        apiGet<Record<string, TEntity>>(url).then(
          (r) => r[itemResponseKey as string] as TEntity,
        ),
      {
        revalidateOnFocus: false,
        onError: (err) => {
          showErrorToast(err);
        },
      },
    );
  }

  // ── create ──────────────────────────────────────────────────────────
  async function create(slug: string, body: TCreate): Promise<TEntity> {
    const res = await apiPost<Record<string, TEntity>>(listPath(slug), body);
    return res[itemResponseKey as string] as TEntity;
  }

  // ── patch ───────────────────────────────────────────────────────────
  async function patch(slug: string, id: string, body: TPatch): Promise<TEntity> {
    const res = await apiPatch<Record<string, TEntity>>(itemPath(slug, id), body);
    return res[itemResponseKey as string] as TEntity;
  }

  // ── remove ──────────────────────────────────────────────────────────
  async function remove(slug: string, id: string): Promise<void> {
    await apiDelete(itemPath(slug, id));
  }

  // ── lock (optional) ─────────────────────────────────────────────────
  const lock = lockPath
    ? async (slug: string, id: string, body: TLockBody): Promise<TEntity> => {
        const res = await apiPost<Record<string, TEntity>>(
          lockPath(slug, id),
          body,
        );
        return res[itemResponseKey as string] as TEntity;
      }
    : undefined;

  return { useList, useSingle, create, patch, remove, lock } as {
    useList: typeof useList;
    useSingle: typeof useSingle;
    create: typeof create;
    patch: typeof patch;
    remove: typeof remove;
    lock: typeof lockPath extends undefined ? undefined : typeof lock;
  };
}
