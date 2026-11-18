/**
 * Three-way sync planner (pure, no I/O).
 *
 * Inputs: what the vault looks like now (local), what Drive looks like now
 * (remote) and what both looked like after the last successful sync of each
 * path (base). Comparing each side against the base tells us *which side*
 * changed, so we never have to guess from timestamps:
 *
 *   local  remote  base   -> action
 *   ---------------------------------------------------------------
 *   yes    yes     yes    unchanged/unchanged -> nothing
 *                         changed/unchanged   -> upload
 *                         unchanged/changed   -> download
 *                         changed/changed     -> conflict (unless identical)
 *   yes    yes     no     identical -> adopt, else conflict (first sync!)
 *   yes    no      yes    local changed -> re-upload, else trash local
 *   yes    no      no     upload
 *   no     yes     yes    remote changed -> re-download, else trash remote
 *   no     yes     no     download
 *   no     no      yes    forget
 *
 * A deletion can only be planned when a base record exists, so the very first
 * sync (empty base) can never delete anything.
 *
 * Renames are detected before the table above: Drive file IDs survive a
 * rename, so a known ID at a new path is a remote rename; a locally missing
 * file whose exact content (MD5) re-appears at one new local path is a local
 * rename.
 */
import { depth, isUnder } from "./paths";
import type { Action, BaseEntry, LocalFile, LocalSnapshot, PlanOptions, RemoteFile, RemoteSnapshot, SyncPlan } from "./types";

export function localChanged(l: LocalFile, b: BaseEntry): boolean {
  if (l.mtime === b.localMtime && l.size === b.localSize) return false;
  if (l.md5 !== undefined && b.md5 !== undefined) return l.md5 !== b.md5;
  return true;
}

export function remoteChanged(r: RemoteFile, b: BaseEntry): boolean {
  if (r.md5 !== undefined && b.md5 !== undefined) return r.md5 !== b.md5;
  return r.id !== b.remoteId || r.modifiedTime !== b.remoteModifiedTime || r.size !== b.remoteSize;
}

function sameContent(l: LocalFile, r: RemoteFile): boolean {
  return l.md5 !== undefined && r.md5 !== undefined && l.md5 === r.md5;
}

function baseDrifted(l: LocalFile, r: RemoteFile, b: BaseEntry): boolean {
  return (
    l.mtime !== b.localMtime ||
    l.size !== b.localSize ||
    r.id !== b.remoteId ||
    r.md5 !== b.remoteMd5 ||
    r.modifiedTime !== b.remoteModifiedTime ||
    r.size !== b.remoteSize
  );
}

function fileBase(base: Map<string, BaseEntry>, p: string): BaseEntry | undefined {
  const b = base.get(p);
  return b && !b.isFolder ? b : undefined;
}

/**
 * Which local files must be hashed before planning. Hashing reads the whole
 * file, so we only do it where (mtime, size) can't decide on its own.
 */
export function pathsNeedingHash(local: LocalSnapshot, remote: RemoteSnapshot, base: Map<string, BaseEntry>): string[] {
  const missingLocalSizes = new Set<number>();
  for (const b of base.values()) {
    if (!b.isFolder && !local.files.has(b.path) && b.localSize !== undefined) missingLocalSizes.add(b.localSize);
  }
  const out: string[] = [];
  for (const l of local.files.values()) {
    if (remote.blocked.has(l.path)) continue;
    const b = fileBase(base, l.path);
    if (b) {
      if (l.mtime !== b.localMtime || l.size !== b.localSize) out.push(l.path);
    } else if (remote.files.has(l.path) || missingLocalSizes.has(l.size)) {
      out.push(l.path);
    }
  }
  return out;
}

export function plan(local: LocalSnapshot, remote: RemoteSnapshot, baseIn: Map<string, BaseEntry>, opts: PlanOptions): SyncPlan {
  const firstSync = baseIn.size === 0;
  const L = new Map(local.files);
  const R = new Map(remote.files);
  const B = new Map(baseIn);
  const blocked = remote.blocked;

  const moves: Action[] = [];
  const mkdirs: Action[] = [];
  const fileOps: Action[] = [];
  const folderTrash: Action[] = [];
  const forgets: Action[] = [];

  // ---- 1. remote renames (same Drive ID, new path) ----
  const remoteById = new Map<string, RemoteFile>();
  for (const r of R.values()) remoteById.set(r.id, r);
  for (const b of [...B.values()]) {
    if (b.isFolder || !b.remoteId) continue;
    const p = b.path;
    const atP = R.get(p);
    if (atP && atP.id === b.remoteId) continue;
    const r = remoteById.get(b.remoteId);
    if (!r || r.path === p) continue;
    const q = r.path;
    if (blocked.has(p) || blocked.has(q) || B.has(q) || L.has(q)) continue;
    const l = L.get(p);
    if (!l) continue; // gone locally as well: normal handling downloads q and forgets p
    moves.push({ kind: "moveLocal", from: p, to: q });
    L.delete(p);
    L.set(q, { ...l, path: q });
    B.delete(p);
    B.set(q, { ...b, path: q });
  }

  // ---- 2. local renames (content re-appears at exactly one new path) ----
  const missingByMd5 = new Map<string, BaseEntry[]>();
  for (const b of B.values()) {
    if (b.isFolder || !b.md5 || L.has(b.path) || blocked.has(b.path)) continue;
    const r = R.get(b.path);
    if (!r || r.id !== b.remoteId || remoteChanged(r, b)) continue;
    missingByMd5.set(b.md5, [...(missingByMd5.get(b.md5) ?? []), b]);
  }
  if (missingByMd5.size > 0) {
    const newByMd5 = new Map<string, LocalFile[]>();
    for (const l of L.values()) {
      if (!l.md5 || B.has(l.path) || R.has(l.path) || blocked.has(l.path)) continue;
      newByMd5.set(l.md5, [...(newByMd5.get(l.md5) ?? []), l]);
    }
    for (const [md5, olds] of missingByMd5) {
      const news = newByMd5.get(md5);
      if (olds.length !== 1 || !news || news.length !== 1) continue;
      const b = olds[0];
      const q = news[0].path;
      const r = R.get(b.path)!;
      moves.push({ kind: "moveRemote", from: b.path, to: q, remoteId: r.id });
      R.delete(b.path);
      R.set(q, { ...r, path: q });
      B.delete(b.path);
      B.set(q, { ...b, path: q });
    }
  }

  // ---- 3. files ----
  const filePaths = new Set<string>([...L.keys(), ...R.keys()]);
  for (const b of B.values()) if (!b.isFolder) filePaths.add(b.path);
  // Show blocked paths in the plan (dry run / log) even if they exist only in Drive.
  for (const p of blocked.keys()) filePaths.add(p);

  const keptFiles = new Set<string>();

  for (const p of [...filePaths].sort()) {
    const l = L.get(p);
    const r = R.get(p);
    const b = fileBase(B, p);

    if (blocked.has(p)) {
      if (l || r) keptFiles.add(p);
      fileOps.push({ kind: "skip", path: p, reason: blocked.get(p)! });
      continue;
    }
    if ((l && remote.folders.has(p)) || (r && local.folders.has(p))) {
      keptFiles.add(p);
      fileOps.push({ kind: "skip", path: p, reason: "is a file on one side and a folder on the other" });
      continue;
    }
    const max = opts.maxFileSize;
    if (max > 0 && ((l && l.size > max) || (r && r.size > max))) {
      if (l || r) keptFiles.add(p);
      fileOps.push({ kind: "skip", path: p, reason: `larger than the ${Math.round(max / 1024 / 1024)} MB limit` });
      continue;
    }

    if (l && r) {
      keptFiles.add(p);
      if (b) {
        const lc = localChanged(l, b);
        const rc = remoteChanged(r, b);
        if (!lc && !rc) {
          if (baseDrifted(l, r, b)) fileOps.push({ kind: "adopt", path: p, local: l, remote: r });
        } else if (lc && !rc) {
          fileOps.push({ kind: "upload", path: p, reason: "modified", remoteId: r.id, expectRemoteMd5: r.md5, local: l });
        } else if (!lc && rc) {
          fileOps.push({ kind: "download", path: p, reason: "modified", remote: r, local: l });
        } else if (sameContent(l, r)) {
          fileOps.push({ kind: "adopt", path: p, local: l, remote: r });
        } else {
          fileOps.push({ kind: "conflict", path: p, type: "both-modified", local: l, remote: r, base: b });
        }
      } else if (sameContent(l, r)) {
        fileOps.push({ kind: "adopt", path: p, local: l, remote: r });
      } else {
        fileOps.push({ kind: "conflict", path: p, type: "both-created", local: l, remote: r });
      }
    } else if (l && !r) {
      if (b) {
        if (localChanged(l, b)) {
          keptFiles.add(p);
          fileOps.push({ kind: "upload", path: p, reason: "restore", local: l });
        } else {
          fileOps.push({ kind: "trashLocal", path: p, local: l });
        }
      } else {
        keptFiles.add(p);
        fileOps.push({ kind: "upload", path: p, reason: "new", local: l });
      }
    } else if (!l && r) {
      if (b) {
        if (remoteChanged(r, b)) {
          keptFiles.add(p);
          fileOps.push({ kind: "download", path: p, reason: "restore", remote: r });
        } else {
          fileOps.push({ kind: "trashRemote", path: p, remote: r });
        }
      } else {
        keptFiles.add(p);
        fileOps.push({ kind: "download", path: p, reason: "new", remote: r });
      }
    } else if (b) {
      forgets.push({ kind: "forget", path: p });
    }
  }

  // ---- 4. folders (deepest first, so children are decided before parents) ----
  const folderPaths = new Set<string>([...local.folders, ...remote.folders.keys()]);
  for (const b of B.values()) if (b.isFolder) folderPaths.add(b.path);
  const keptFolders = new Set<string>();
  const hasKeptChild = (f: string) => {
    for (const k of keptFiles) if (isUnder(k, f)) return true;
    for (const k of keptFolders) if (isUnder(k, f)) return true;
    return false;
  };

  for (const f of [...folderPaths].sort((a, b) => depth(b) - depth(a) || a.localeCompare(b))) {
    if (f === "" || filePaths.has(f)) continue;
    const lf = local.folders.has(f);
    const rid = remote.folders.get(f);
    const bf = B.get(f)?.isFolder === true;
    if (lf && rid) {
      keptFolders.add(f);
      if (!bf) mkdirs.push({ kind: "adoptFolder", path: f, remoteId: rid });
    } else if (lf) {
      if (bf && !hasKeptChild(f)) {
        folderTrash.push({ kind: "trashLocalFolder", path: f });
      } else {
        keptFolders.add(f);
        mkdirs.push({ kind: "mkdirRemote", path: f });
      }
    } else if (rid) {
      if (bf && !hasKeptChild(f)) {
        folderTrash.push({ kind: "trashRemoteFolder", path: f, remoteId: rid });
      } else {
        keptFolders.add(f);
        mkdirs.push({ kind: "mkdirLocal", path: f });
      }
    } else if (bf) {
      forgets.push({ kind: "forget", path: f });
    }
  }
  mkdirs.sort((a, b) => depth(pathOf(a)) - depth(pathOf(b)));

  let actions = [...moves, ...mkdirs, ...fileOps, ...folderTrash, ...forgets];

  // Belt and braces: the first sync must never delete anything.
  if (firstSync) {
    actions = actions.filter((a) => !isDeletion(a));
  }
  return { firstSync, actions };
}

export function pathOf(a: Action): string {
  return "path" in a ? a.path : a.to;
}

export function isDeletion(a: Action): boolean {
  return a.kind === "trashLocal" || a.kind === "trashRemote" || a.kind === "trashLocalFolder" || a.kind === "trashRemoteFolder";
}

/** Counts per action kind, for dry-run summaries and logs. */
export function summarize(p: SyncPlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of p.actions) out[a.kind] = (out[a.kind] ?? 0) + 1;
  return out;
}
