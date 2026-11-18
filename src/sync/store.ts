import type { BaseEntry, KVStore } from "./types";

/**
 * Per-path base state ("what both sides looked like after the last sync").
 *
 * Namespaced by the remote folder ID: if you point the plugin at a different
 * Drive folder, the old base is NOT reused — otherwise every file missing from
 * the new folder would look like a remote deletion.
 */
export class BaseStore {
  private readonly prefix: string;
  constructor(
    private readonly kv: KVStore,
    namespace: string
  ) {
    this.prefix = `base\u0000${namespace}\u0000`;
  }

  async loadAll(): Promise<Map<string, BaseEntry>> {
    const out = new Map<string, BaseEntry>();
    for (const [, v] of await this.kv.entries<BaseEntry>(this.prefix)) out.set(v.path, v);
    return out;
  }

  get(path: string): Promise<BaseEntry | null> {
    return this.kv.get<BaseEntry>(this.prefix + path);
  }

  put(e: BaseEntry): Promise<void> {
    return this.kv.set(this.prefix + e.path, e);
  }

  delete(path: string): Promise<void> {
    return this.kv.remove(this.prefix + path);
  }

  async clear(): Promise<void> {
    for (const [k] of await this.kv.entries(this.prefix)) await this.kv.remove(k);
  }
}

/** In-memory KVStore, used by tests. */
export class MemoryKV implements KVStore {
  readonly data = new Map<string, unknown>();
  get<T>(key: string): Promise<T | null> {
    return Promise.resolve(this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : null);
  }
  set<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
    return Promise.resolve();
  }
  remove(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
  entries<T>(prefix: string): Promise<Array<[string, T]>> {
    return Promise.resolve([...this.data.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T] as [string, T]));
  }
}
