/** A document owns its queue, so slow saves can never cross into another document. */
export function createScriptSaveQueue<T>(options: {
  persist: (content: string) => Promise<T>;
  onSaved?: (result: T, content: string, previous: string) => void;
  onChange?: () => void;
}) {
  let content = "";
  let savedContent = "";
  let loaded = false;
  let pending: Promise<void> | null = null;
  let error: unknown = null;
  const notify = () => options.onChange?.();

  const queue = {
    get content() { return content; },
    get dirty() { return loaded && content !== savedContent; },
    get saving() { return pending !== null; },
    get error() { return error; },
    load(value: string) {
      content = value;
      savedContent = value;
      loaded = true;
      error = null;
      notify();
    },
    edit(value: string) {
      content = value;
      if (content === savedContent && !pending) error = null;
      notify();
    },
    save(): Promise<void> {
      if (pending) return pending;
      if (!queue.dirty) return Promise.resolve();
      error = null;
      // Start on the next microtask so all callers observe the same pending promise.
      pending = Promise.resolve().then(async () => {
        while (queue.dirty) {
          const snapshot = content;
          const previous = savedContent;
          const result = await options.persist(snapshot);
          savedContent = snapshot;
          options.onSaved?.(result, snapshot, previous);
          notify();
        }
      }).catch((cause: unknown) => {
        error = cause;
        throw cause;
      }).finally(() => {
        pending = null;
        notify();
      });
      notify();
      return pending;
    },
  };
  return queue;
}
