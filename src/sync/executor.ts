/**
 * Runs a SyncPlan, one action at a time.
 *
 * Resumability: the base record for a path is written right after its action
 * completes. If iOS suspends or kills Obsidian half-way, the next sync re-plans
 * from the real state of both sides plus this base, and every action is safe to
 * repeat:
 *   - an upload that finished but wasn't recorded shows up as "same content on
 *     both sides, no base" -> adopt (no duplicate, no re-upload)
 *   - a half-written download has a different hash -> conflict, nothing lost
 *   - a trash that finished but wasn't recorded -> "gone on both sides" -> forget
 *
 * Every destructive step re-checks its precondition right before acting
 * (local file unchanged since planning, remote MD5 unchanged since planning).
 * If the world moved on, the action is skipped and re-planned next time.
 */
import { errMsg, type SyncLog } from "../log";
import { assertSafeVaultPath } from "./paths";
import { isDeletion, pathOf } from "./planner";
import type { BaseStore } from "./store";
import { PreconditionError, type Action, type BaseEntry, type LocalFs, type RemoteFile, type RemoteProvider, type SyncPlan } from "./types";

export interface ExecutorDeps {
  local: LocalFs;
  remote: RemoteProvider;
  base: BaseStore;
  log: SyncLog;
  md5: (data: ArrayBuffer) => string;
  now?: () => number;
  /** Polled between actions; return true to stop cleanly (e.g. plugin unloading). */
  shouldStop?: () => boolean;
  onProgress?: (done: number, total: number, a: Action) => void;
  /** Abort after this many hard failures. */
  maxFailures?: number;
}

export interface ExecResult {
  done: number;
  skipped: Array<{ action: Action; reason: string }>;
  failed: Array<{ action: Action; error: string }>;
  conflicts: Action[];
  stopped: boolean;
}

export function describe(a: Action): string {
  switch (a.kind) {
    case "moveLocal":
    case "moveRemote":
      return `${a.kind} ${a.from} -> ${a.to}`;
    case "upload":
    case "download":
      return `${a.kind} (${a.reason}) ${a.path}`;
    case "conflict":
      return `conflict (${a.type}) ${a.path}`;
    case "skip":
      return `skip ${a.path}: ${a.reason}`;
    default:
      return `${a.kind} ${pathOf(a)}`;
  }
}

function remoteFields(r: RemoteFile): Pick<BaseEntry, "remoteId" | "remoteMd5" | "remoteModifiedTime" | "remoteSize"> {
  return { remoteId: r.id, remoteMd5: r.md5, remoteModifiedTime: r.modifiedTime, remoteSize: r.size };
}

export async function execute(plan: SyncPlan, deps: ExecutorDeps): Promise<ExecResult> {
  const { local, remote, base, log, md5 } = deps;
  const now = deps.now ?? Date.now;
  const maxFailures = deps.maxFailures ?? 5;
  const res: ExecResult = { done: 0, skipped: [], failed: [], conflicts: [], stopped: false };

  const work = plan.actions.filter((a) => a.kind !== "skip" && a.kind !== "conflict");
  for (const a of plan.actions) {
    if (a.kind === "skip") {
      res.skipped.push({ action: a, reason: a.reason });
      log.warn(describe(a));
    } else if (a.kind === "conflict") {
      res.conflicts.push(a);
      log.warn(`${describe(a)} — left untouched on both sides`);
    }
  }

  if (plan.firstSync && work.some(isDeletion)) {
    throw new Error("Refusing to delete anything on the first sync");
  }

  const expectLocal = async (path: string, want: { mtime: number; size: number } | undefined) => {
    const st = await local.stat(path);
    if (!want) {
      if (st) throw new PreconditionError("a local file appeared at this path during sync");
      return;
    }
    if (!st || st.isFolder || st.mtime !== want.mtime || st.size !== want.size) {
      throw new PreconditionError("local file changed during sync");
    }
  };

  const run = async (a: Action): Promise<void> => {
    // Defence in depth: never act on a path that could escape the vault.
    if (a.kind === "moveLocal" || a.kind === "moveRemote") {
      assertSafeVaultPath(a.from);
      assertSafeVaultPath(a.to);
    } else {
      assertSafeVaultPath(a.path);
    }
    switch (a.kind) {
      case "upload": {
        await expectLocal(a.path, a.local);
        const data = await local.read(a.path);
        const hash = md5(data);
        if (a.local.md5 !== undefined && hash !== a.local.md5) throw new PreconditionError("local file changed during sync");
        if (a.remoteId) {
          const fresh = await remote.stat(a.remoteId);
          if (!fresh) throw new PreconditionError("remote file disappeared during sync");
          if (a.expectRemoteMd5 !== undefined && fresh.md5 !== a.expectRemoteMd5) throw new PreconditionError("remote file changed during sync");
        }
        const rf = await remote.upload(a.path, data, a.remoteId, hash);
        if (rf.md5 !== undefined && rf.md5 !== hash) {
          throw new Error(`upload checksum mismatch (local ${hash}, Drive ${rf.md5})`);
        }
        await base.put({ path: a.path, isFolder: false, md5: hash, localMtime: a.local.mtime, localSize: a.local.size, ...remoteFields(rf), syncedAt: now() });
        return;
      }
      case "download": {
        await expectLocal(a.path, a.local);
        const data = await remote.download(a.remote.id);
        const hash = md5(data);
        if (a.remote.md5 !== undefined && hash !== a.remote.md5) throw new PreconditionError("remote file changed during sync");
        await local.write(a.path, data, a.remote.modifiedTime);
        const st = await local.stat(a.path);
        if (!st) throw new Error("file missing right after writing it");
        // Edited again in the instant after writing? Don't record it as in sync.
        if (st.size !== data.byteLength) throw new PreconditionError("local file changed right after download");
        await base.put({ path: a.path, isFolder: false, md5: hash, localMtime: st.mtime, localSize: st.size, ...remoteFields(a.remote), syncedAt: now() });
        return;
      }
      case "adopt": {
        await base.put({
          path: a.path,
          isFolder: false,
          md5: a.remote.md5 ?? a.local.md5,
          localMtime: a.local.mtime,
          localSize: a.local.size,
          ...remoteFields(a.remote),
          syncedAt: now(),
        });
        return;
      }
      case "trashLocal": {
        await expectLocal(a.path, a.local);
        await local.trash(a.path);
        await base.delete(a.path);
        return;
      }
      case "trashRemote": {
        const fresh = await remote.stat(a.remote.id);
        if (fresh) {
          if (fresh.md5 !== a.remote.md5 || fresh.modifiedTime !== a.remote.modifiedTime) {
            throw new PreconditionError("remote file changed during sync");
          }
          await remote.trash(a.remote.id);
        }
        await base.delete(a.path);
        return;
      }
      case "moveLocal": {
        if (await local.stat(a.to)) throw new PreconditionError("destination already exists locally");
        await local.rename(a.from, a.to);
        // Keep the OLD local mtime/size in the base: if the file had unsynced local
        // edits, they must still look like edits after the rename (found by fuzzing:
        // recording the current stats here made a later download overwrite them).
        const b = await base.get(a.from);
        if (b) await base.put({ ...b, path: a.to, syncedAt: now() });
        await base.delete(a.from);
        return;
      }
      case "moveRemote": {
        const rf = await remote.move(a.remoteId, a.to);
        // Same rule as moveLocal: never refresh local stats without re-checking content.
        const b = await base.get(a.from);
        if (b) await base.put({ ...b, path: a.to, ...remoteFields(rf), syncedAt: now() });
        await base.delete(a.from);
        return;
      }
      case "mkdirLocal": {
        await local.mkdir(a.path);
        await base.put({ path: a.path, isFolder: true, syncedAt: now() });
        return;
      }
      case "mkdirRemote": {
        const id = await remote.mkdir(a.path);
        await base.put({ path: a.path, isFolder: true, remoteId: id, syncedAt: now() });
        return;
      }
      case "adoptFolder": {
        await base.put({ path: a.path, isFolder: true, remoteId: a.remoteId, syncedAt: now() });
        return;
      }
      case "trashLocalFolder": {
        const ls = await local.listFolder(a.path);
        if (ls.files.length > 0 || ls.folders.length > 0) throw new PreconditionError("folder is not empty");
        await local.trash(a.path);
        await base.delete(a.path);
        return;
      }
      case "trashRemoteFolder": {
        // Checks the real folder, including Google Docs and ignored files we never synced.
        if (!(await remote.folderIsEmpty(a.remoteId))) throw new PreconditionError("remote folder is not empty");
        await remote.trash(a.remoteId);
        await base.delete(a.path);
        return;
      }
      case "forget": {
        await base.delete(a.path);
        return;
      }
      case "conflict":
      case "skip":
        return;
    }
  };

  let i = 0;
  for (const a of work) {
    if (deps.shouldStop?.()) {
      res.stopped = true;
      log.warn(`sync stopped after ${res.done} of ${work.length} actions; it will resume next time`);
      break;
    }
    i++;
    deps.onProgress?.(i, work.length, a);
    try {
      await run(a);
      res.done++;
      log.info(describe(a));
    } catch (e) {
      if (e instanceof PreconditionError) {
        res.skipped.push({ action: a, reason: e.message });
        log.warn(`${describe(a)} — skipped: ${e.message}`);
      } else {
        res.failed.push({ action: a, error: errMsg(e) });
        log.error(`${describe(a)} — FAILED: ${errMsg(e)}`);
        if (res.failed.length >= maxFailures) {
          log.error(`too many failures (${res.failed.length}), stopping this sync`);
          res.stopped = true;
          break;
        }
      }
    }
  }
  await log.flush();
  return res;
}
