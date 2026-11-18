import type { KVStore } from "./sync/types";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  t: number;
  level: LogLevel;
  msg: string;
}

const LOG_KEY = "synclog";

/**
 * Small persistent ring buffer for troubleshooting on a phone (viewable in a
 * modal). Never log file contents or tokens here.
 */
export class SyncLog {
  private entries: LogEntry[] = [];
  private dirty = 0;

  constructor(private readonly kv: KVStore | null, private readonly max = 1500) {}

  async load(): Promise<void> {
    if (!this.kv) return;
    this.entries = (await this.kv.get<LogEntry[]>(LOG_KEY)) ?? [];
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  info(msg: string) {
    this.add("info", msg);
  }
  warn(msg: string) {
    this.add("warn", msg);
  }
  error(msg: string) {
    this.add("error", msg);
  }

  private add(level: LogLevel, msg: string) {
    this.entries.push({ t: Date.now(), level, msg });
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    if (level !== "info") console.warn(`[gdrive-sync] ${msg}`);
    // Persist regularly so a log survives iOS killing the app mid-sync.
    if (++this.dirty >= 20) void this.flush();
  }

  async flush(): Promise<void> {
    if (!this.kv || this.dirty === 0) return;
    this.dirty = 0;
    await this.kv.set(LOG_KEY, this.entries);
  }

  async clear(): Promise<void> {
    this.entries = [];
    this.dirty = 1;
    await this.flush();
  }
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
