import localforage from "localforage";
import type { KVStore } from "../sync/types";

/** IndexedDB-backed store (via localforage). One database per vault installation. */
export class LocalForageKV implements KVStore {
  private readonly db: LocalForage;
  constructor(instanceId: string) {
    this.db = localforage.createInstance({ name: "gdrive-vault-sync", storeName: `v_${instanceId.replace(/[^A-Za-z0-9_]/g, "_")}` });
  }
  get<T>(key: string): Promise<T | null> {
    return this.db.getItem<T>(key);
  }
  async set<T>(key: string, value: T): Promise<void> {
    await this.db.setItem(key, value);
  }
  remove(key: string): Promise<void> {
    return this.db.removeItem(key);
  }
  async entries<T>(prefix: string): Promise<Array<[string, T]>> {
    const out: Array<[string, T]> = [];
    await this.db.iterate<T, void>((value, key) => {
      if (key.startsWith(prefix)) out.push([key, value]);
    });
    return out;
  }
  async clear(): Promise<void> {
    await this.db.clear();
  }
}
