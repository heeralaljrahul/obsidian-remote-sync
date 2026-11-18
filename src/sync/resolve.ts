/**
 * Applying the user's choice for a conflict. Nothing is ever thrown away:
 *  - keep-local:  Drive file is updated IN PLACE (same file ID), so Drive's
 *                 version history still has the overwritten Drive version.
 *  - keep-remote: this device's version is moved to the vault's .trash first,
 *                 then the Drive version is written.
 *  - keep-both:   this device's version is renamed to
 *                 "Name (conflict YYYY-MM-DD HHmm).ext" and uploaded as a new
 *                 file; the Drive version takes the original name.
 *
 * Each choice first re-checks that neither side changed since the user looked
 * at the diff; if one did, nothing happens and the user is asked to re-check.
 */
import { errMsg, type SyncLog } from "../log";
import { assertSafeVaultPath, baseName, joinPath, parentOf } from "./paths";
import type { BaseStore } from "./store";
import { PreconditionError, type LocalFile, type LocalFs, type RemoteFile, type RemoteProvider } from "./types";

export type Resolution = "keep-local" | "keep-remote" | "keep-both";

export interface ConflictItem {
  path: string;
  type: "both-modified" | "both-created";
  local: LocalFile;
  remote: RemoteFile;
}

export interface ResolveDeps {
  local: LocalFs;
  remote: RemoteProvider;
  base: BaseStore;
  log: SyncLog;
  md5: (d: ArrayBuffer) => string;
  now?: () => number;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "Notes/Plan.md" -> "Notes/Plan (conflict 2026-11-18 1430).md", made unique with " 2", " 3"… */
export async function conflictCopyPath(path: string, when: Date, taken: (p: string) => Promise<boolean>): Promise<string> {
  const dir = parentOf(path);
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}${pad(when.getMinutes())}`;
  for (let i = 1; i < 100; i++) {
    const candidate = joinPath(dir, `${stem} (conflict ${stamp}${i > 1 ? ` ${i}` : ""})${ext}`);
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error("could not find a free name for the conflict copy");
}

async function expectLocalUnchanged(local: LocalFs, c: ConflictItem): Promise<void> {
  const st = await local.stat(c.path);
  if (!st || st.isFolder || st.mtime !== c.local.mtime || st.size !== c.local.size) {
    throw new PreconditionError("this device's version changed after you opened it — close and review again");
  }
}

export async function resolveConflict(c: ConflictItem, choice: Resolution, deps: ResolveDeps): Promise<string> {
  const { local, remote, base, md5, log } = deps;
  const now = deps.now ?? Date.now;
  assertSafeVaultPath(c.path);
  await expectLocalUnchanged(local, c);

  const putBase = async (path: string, hash: string, rf: RemoteFile, knownLocal?: { mtime: number; size: number }, expectSize?: number) => {
    const st = knownLocal ?? (await local.stat(path));
    if (!knownLocal && expectSize !== undefined && st?.size !== expectSize) {
      throw new PreconditionError("the file changed again right after it was written — run a sync to re-check");
    }
    await base.put({
      path,
      isFolder: false,
      md5: hash,
      localMtime: st?.mtime,
      localSize: st?.size,
      remoteId: rf.id,
      remoteMd5: rf.md5,
      remoteModifiedTime: rf.modifiedTime,
      remoteSize: rf.size,
      syncedAt: now(),
    });
  };

  const downloadRemote = async (): Promise<{ data: ArrayBuffer; hash: string }> => {
    const data = await remote.download(c.remote.id);
    const hash = md5(data);
    if (c.remote.md5 !== undefined && hash !== c.remote.md5) {
      throw new PreconditionError("the Drive version changed after you opened it — close and review again");
    }
    return { data, hash };
  };

  if (choice === "keep-local") {
    const data = await local.read(c.path);
    const hash = md5(data);
    if (c.local.md5 !== undefined && hash !== c.local.md5) throw new PreconditionError("this device's version changed after you opened it");
    const fresh = await remote.stat(c.remote.id);
    if (fresh && fresh.md5 !== c.remote.md5) throw new PreconditionError("the Drive version changed after you opened it — close and review again");
    const rf = await remote.upload(c.path, data, fresh ? c.remote.id : undefined, hash);
    // Use the stats we verified before reading, not a fresh stat (an edit in between must stay visible).
    await putBase(c.path, hash, rf, { mtime: c.local.mtime, size: c.local.size });
    log.info(`conflict ${c.path}: kept this device's version (previous Drive version is in Drive's version history)`);
    return "Kept this device's version. The previous Drive version is still in Drive's version history.";
  }

  if (choice === "keep-remote") {
    const { data, hash } = await downloadRemote();
    await local.trash(c.path);
    await local.write(c.path, data, c.remote.modifiedTime);
    await putBase(c.path, hash, c.remote, undefined, data.byteLength);
    log.info(`conflict ${c.path}: kept the Drive version (this device's version moved to .trash)`);
    return "Kept the Drive version. This device's version was moved to the vault's .trash folder.";
  }

  // keep-both
  const { data, hash } = await downloadRemote();
  const copy = await conflictCopyPath(c.path, new Date(now()), async (p) => (await local.stat(p)) !== null);
  assertSafeVaultPath(copy);
  await local.rename(c.path, copy);
  await local.write(c.path, data, c.remote.modifiedTime);
  await putBase(c.path, hash, c.remote, undefined, data.byteLength);
  log.info(`conflict ${c.path}: kept both; this device's version saved as ${copy}`);
  try {
    const copyData = await local.read(copy);
    const copyHash = md5(copyData);
    const copySt = await local.stat(copy);
    const rf = await remote.upload(copy, copyData, undefined, copyHash);
    await putBase(
      copy,
      copyHash,
      rf,
      copySt && copySt.size === copyData.byteLength ? { mtime: copySt.mtime, size: copySt.size } : undefined,
      copyData.byteLength
    );
  } catch (e) {
    // Not a problem: the next sync uploads it as a new file.
    log.warn(`conflict copy ${copy} will be uploaded on the next sync (${errMsg(e)})`);
  }
  return `Kept both. This device's version is now "${baseName(copy)}".`;
}
