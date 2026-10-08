/**
 * createVersionedListHook — 通用版本列表 SWR hook factory
 *
 * 消除 useScriptVersions / useStoryboardVersions 的重复 SWR+CRUD 模式。
 * 生成 hook 提供：useList / activate / remove / create。
 *
 * @template TVersion  版本实体类型（必须含 id: string）
 * @template TCreateBody create() 的 body 类型
 */

import useSWR, { type KeyedMutator } from "swr";
import { apiDelete, apiGet, apiPost } from "../lib/api";
import { showErrorToast } from "../lib/errorTranslate";

export interface VersionedListHookConfig<TVersion, TCreateBody> {
  /**
   * SWR cache key，接受可变参数（多层级 key array）。
   * 例如 script-versions: (slug) => ["script-versions", slug]
   * 例如 storyboard-versions: (slug, epId) => ["storyboard-versions", slug, epId]
   */
  cacheKey: (...args: Array<string | undefined>) => Array<string | undefined> | null;

  /**
   * 列表 GET 路径
   */
  listPath: (...args: string[]) => string;

  /**
   * 单个版本激活 POST 路径
   */
  activatePath: (id: string, ...args: string[]) => string;

  /**
   * 单个版本删除 DELETE 路径
   */
  removePath: (id: string, ...args: string[]) => string;

  /**
   * 新建版本 POST 路径
   */
  createPath: (...args: string[]) => string;

  /**
   * 列表响应中取数组的 key，如 "versions"
   */
  listResponseKey: string;

  /**
   * 单项创建响应中取对象的 key，如 "version"
   */
  itemResponseKey: string;

  /**
   * 参数个数（slug 的个数 — 用于校验 guard）
   */
  requiredArgCount: number;
}

export type VersionedListHookResult<TVersion, TCreateBody> = {
  versions: TVersion[];
  loading: boolean;
  error: Error | undefined;
  activate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  create: (body: TCreateBody) => Promise<TVersion | null>;
  reload: KeyedMutator<{ versions: TVersion[] }>;
};

export function createVersionedListHook<TVersion, TCreateBody>(
  config: VersionedListHookConfig<TVersion, TCreateBody>,
) {
  const {
    cacheKey,
    listPath,
    activatePath,
    removePath,
    createPath,
    listResponseKey,
    itemResponseKey,
    requiredArgCount,
  } = config;

  // 稳定空数组引用 — 避免 useEffect([versions]) 无限循环（同 useShots.ts 修复）
  const EMPTY: TVersion[] = [];

  return function useVersionedList(...args: Array<string | undefined>): VersionedListHookResult<TVersion, TCreateBody> {
    const key = cacheKey(...args);
    const validArgs = args.slice(0, requiredArgCount);
    const allPresent = validArgs.every((a) => !!a);

    const { data, error, isLoading, mutate } = useSWR(
      allPresent ? key : null,
      async () =>
        apiGet<{ versions: TVersion[] }>(
          listPath(...(validArgs as string[])),
        ),
      {
        revalidateOnFocus: false,
        onError: (err) => showErrorToast(err),
      },
    );

    const activate = async (id: string) => {
      if (!allPresent) return;
      try {
        await apiPost(activatePath(id, ...(validArgs as string[])), {});
        await mutate();
      } catch (err) {
        showErrorToast(err);
      }
    };

    const remove = async (id: string) => {
      if (!allPresent) return;
      try {
        await apiDelete(removePath(id, ...(validArgs as string[])));
        await mutate();
      } catch (err) {
        showErrorToast(err);
      }
    };

    const create = async (body: TCreateBody): Promise<TVersion | null> => {
      if (!allPresent) return null;
      try {
        const res = await apiPost<Record<string, TVersion>>(
          createPath(...(validArgs as string[])),
          body,
        );
        await mutate();
        return res[itemResponseKey] as TVersion;
      } catch (err) {
        showErrorToast(err);
        return null;
      }
    };

    // data is { versions: TVersion[] } per apiGet type, but listResponseKey is user-configurable
    // so we widen to Record at access point (not the whole expression).
    const versionsList = (data as Record<string, TVersion[]> | undefined)?.[listResponseKey] ?? EMPTY;

    return {
      versions: versionsList,
      loading: isLoading,
      error,
      activate,
      remove,
      create,
      reload: mutate,
    };
  };
}
