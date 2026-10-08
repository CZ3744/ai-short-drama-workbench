import fs from "node:fs/promises";
import path from "node:path";

export function logFileForDate(dir: string, date: Date): string {
  return path.join(dir, `app-${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}.jsonl`);
}

/** Ordered async appends, no long-lived file descriptor; each write captures its own day. */
export class DailyLogSink {
  private pending = Promise.resolve();
  private failure: Error | undefined;
  constructor(private readonly dir: string, private readonly now = () => new Date(),
    private readonly append: (file: string, data: string) => Promise<unknown> = (file, data) => fs.appendFile(file, data, "utf8"),
    private readonly onError: (error: Error) => void = error => process.stderr.write(`[logger] 写入失败 (${(error as NodeJS.ErrnoException).code ?? "IO"})，后续日志将重试\n`)) {}

  write(data: string): void {
    const file = logFileForDate(this.dir, this.now());
    this.pending = this.pending.then(async () => {
      try {
        await fs.mkdir(this.dir, { recursive: true });
        await this.append(file, data);
        this.failure = undefined;
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.onError(this.failure);
      }
    });
  }

  flush(callback?: (error?: Error) => void): void {
    void this.drain().then(() => callback?.(), error => callback?.(error));
  }

  async drain(): Promise<void> {
    await this.pending;
    if (this.failure) throw this.failure;
  }
}
