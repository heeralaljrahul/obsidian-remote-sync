import SparkMD5 from "spark-md5";
import type { SyncLog } from "../log";
import { execute, type ExecResult } from "./executor";
import type { IgnoreFilter } from "./ignore";
import { pathsNeedingHash, plan, summarize } from "./planner";
import { BaseStore } from "./store";
import type { BaseEntry, KVStore, LocalFs, LocalSnapshot, PlanOptions, RemoteProvider, RemoteSnapshot, SyncPlan } from "./types";

export function md5Hex(data: ArrayBuffer): string {
  return SparkMD5.ArrayBuffer.hash(data);
}

export interface EngineDeps {
  local: LocalFs;
  /** Raw (unfiltered) scan of the local vault. */
  scanLocal: () => Promise<LocalSnapshot>;
  remote: RemoteProvider;
  kv: KVStore;
  /** Usually the Drive folder ID: separates base state per remote folder. */
  namespace: string;
  filter: IgnoreFilter;
  log: SyncLog;
  options: PlanOptions;
  shouldStop?: () => boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface Prepared {
  plan: SyncPlan;
  base: Map<string, BaseEntry>;
  local: LocalSnapshot;
  remote: RemoteSnapshot;
}

function filterLocal(s: LocalSnapshot, f: IgnoreFilter): LocalSnapshot {
  return {
    files: new Map([...s.files].filter(([p]) => !f.isIgnored(p, false))),
    folders: new Set([...s.folders].filter((p) => !f.isIgnored(p, true))),
  };
}

function filterRemote(s: RemoteSnapshot, f: IgnoreFilter): RemoteSnapshot {
  return {
    files: new Map([...s.files].filter(([p]) => !f.isIgnored(p, false))),
    folders: new Map([...s.folders].filter(([p]) => !f.isIgnored(p, true))),
    blocked: new Map([...s.blocked].filter(([p]) => !f.isIgnored(p, false))),
  };
}

/** Everything up to (and including) planning. Read-only on both sides: this is the dry run. */
export async function prepare(deps: EngineDeps): Promise<Prepared> {
  const store = new BaseStore(deps.kv, deps.namespace);
  const allBase = await store.loadAll();
  const base = new Map([...allBase].filter(([p, b]) => !deps.filter.isIgnored(p, b.isFolder)));

  const preferredIds = new Map<string, string>();
  for (const b of allBase.values()) if (b.remoteId) preferredIds.set(b.path, b.remoteId);

  const remote = filterRemote(await deps.remote.snapshot(preferredIds), deps.filter);
  const local = filterLocal(await deps.scanLocal(), deps.filter);

  const toHash = pathsNeedingHash(local, remote, base);
  if (toHash.length > 0) deps.log.info(`hashing ${toHash.length} local file(s)`);
  for (const p of toHash) {
    if (deps.shouldStop?.()) throw new Error("stopped while hashing");
    const f = local.files.get(p)!;
    f.md5 = md5Hex(await deps.local.read(p));
  }

  const result = plan(local, remote, base, deps.options);
  deps.log.info(
    `plan: ${result.firstSync ? "FIRST SYNC, " : ""}local ${local.files.size} files, remote ${remote.files.size} files, ` +
      `base ${base.size} -> ${JSON.stringify(summarize(result))}`
  );
  return { plan: result, base, local, remote };
}

export async function runPlan(deps: EngineDeps, p: SyncPlan): Promise<ExecResult> {
  return execute(p, {
    local: deps.local,
    remote: deps.remote,
    base: new BaseStore(deps.kv, deps.namespace),
    log: deps.log,
    md5: md5Hex,
    shouldStop: deps.shouldStop,
    onProgress: deps.onProgress ? (d, t) => deps.onProgress!(d, t) : undefined,
  });
}
