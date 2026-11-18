/**
 * Cached view of the vault folder on Drive: every item under the root folder,
 * keyed by Drive ID, plus the Changes API cursor.
 *
 *  - First run: get a changes cursor, then walk the folder tree breadth-first
 *    (children of up to 40 folders per files.list query, paginated).
 *  - Later runs: apply changes.list since the cursor; only new sub-trees that
 *    were moved into the vault are walked again.
 *  - The whole state (items + cursor) is saved in one write, so a crash can
 *    never leave a cursor that is ahead of the items.
 *
 * Drive allows several items with the same name in one folder, and Windows/iOS
 * file systems are case-insensitive, so `snapshot()` resolves name clashes:
 *   - the ID we synced last time wins (stable)
 *   - otherwise, identical copies (same MD5) -> the oldest one is used
 *   - otherwise the path is BLOCKED: never downloaded, uploaded or deleted
 *     until you clean up the duplicates in Drive.
 */
import { errMsg } from "../log";
import { foldKey, joinPath, normKey, unsafeNameReason } from "../sync/paths";
import type { KVStore, RemoteFile, RemoteSnapshot } from "../sync/types";
import { FOLDER_MIME, isGoogleNative, type DriveApi, type DriveFile } from "./driveApi";

export interface IndexItem {
  id: string;
  name: string;
  parentId: string;
  isFolder: boolean;
  md5?: string;
  size: number;
  modifiedTime: number;
  createdTime: number;
  /** Google Docs/Sheets/shortcuts etc. Kept so folders aren't seen as empty, never synced. */
  native?: boolean;
}

interface IndexState {
  version: 1;
  rootId: string;
  pageToken: string;
  items: Record<string, IndexItem>;
}

const BATCH = 40;

export function toItem(f: DriveFile, parentId: string): IndexItem {
  return {
    id: f.id,
    name: f.name,
    parentId,
    isFolder: f.mimeType === FOLDER_MIME,
    md5: f.md5Checksum,
    size: f.size !== undefined ? Number(f.size) : 0,
    modifiedTime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
    createdTime: f.createdTime ? Date.parse(f.createdTime) : 0,
    native: isGoogleNative(f.mimeType) || undefined,
  };
}

export class RemoteIndex {
  private state: IndexState | null = null;
  private readonly key: string;
  /** Messages for the sync log (unsyncable items etc.) produced by the last snapshot. */
  notes: string[] = [];

  constructor(
    private readonly api: DriveApi,
    private readonly kv: KVStore,
    readonly rootId: string
  ) {
    this.key = `index\u0000${rootId}`;
  }

  /** Bring the cache up to date with Drive. */
  async refresh(log?: (msg: string) => void): Promise<void> {
    if (!this.state) this.state = await this.kv.get<IndexState>(this.key);
    if (!this.state || this.state.version !== 1 || this.state.rootId !== this.rootId) {
      await this.fullScan(log);
      return;
    }
    try {
      await this.applyChanges(log);
    } catch (e) {
      // An expired/invalid cursor (or anything odd) -> rebuild from scratch.
      log?.(`incremental update failed (${errMsg(e)}); rescanning the whole folder`);
      await this.fullScan(log);
    }
  }

  async fullScan(log?: (msg: string) => void): Promise<void> {
    const root = await this.api.getFile(this.rootId);
    if (!root || root.trashed || root.mimeType !== FOLDER_MIME) {
      throw new Error("The Drive vault folder was not found (deleted, trashed or not visible with the current scope). Check the folder in settings.");
    }
    // Cursor first: anything that changes while we walk is replayed next time.
    const pageToken = await this.api.getStartPageToken();
    const items: Record<string, IndexItem> = {};
    await this.walk([this.rootId], items);
    this.state = { version: 1, rootId: this.rootId, pageToken, items };
    await this.save();
    log?.(`scanned Drive folder: ${Object.keys(items).length} items`);
  }

  private async walk(start: string[], items: Record<string, IndexItem>): Promise<void> {
    let queue = [...start];
    while (queue.length > 0) {
      const batch = queue.slice(0, BATCH);
      queue = queue.slice(BATCH);
      const batchSet = new Set(batch);
      for (const f of await this.api.listChildren(batch)) {
        const parentId = (f.parents ?? []).find((p) => batchSet.has(p));
        if (!parentId || items[f.id]) continue;
        const it = toItem(f, parentId);
        items[f.id] = it;
        if (it.isFolder) queue.push(it.id);
      }
    }
  }

  private async applyChanges(log?: (msg: string) => void): Promise<void> {
    const st = this.state!;
    const { changes, newStartPageToken } = await this.api.listChanges(st.pageToken);
    const items = { ...st.items };
    const newFolders: string[] = [];
    let applied = 0;

    const removeTree = (id: string) => {
      const doomed = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const it of Object.values(items)) {
          if (!doomed.has(it.id) && doomed.has(it.parentId)) {
            doomed.add(it.id);
            grew = true;
          }
        }
      }
      for (const d of doomed) delete items[d];
    };

    for (const c of changes) {
      if (c.fileId === this.rootId) {
        if (c.removed || c.file?.trashed) throw new Error("The Drive vault folder was deleted or trashed");
        continue;
      }
      const known = items[c.fileId];
      const f = c.file;
      const parentId = f?.parents?.find((p) => p === this.rootId || items[p]?.isFolder);
      if (c.removed || !f || f.trashed || !parentId) {
        if (known) {
          removeTree(c.fileId);
          applied++;
        }
        continue;
      }
      const it = toItem(f, parentId);
      if (it.isFolder && !known) newFolders.push(it.id);
      items[it.id] = it;
      applied++;
    }
    // Folders moved into the vault bring children that produce no change events.
    if (newFolders.length > 0) await this.walk(newFolders, items);

    this.state = { ...st, pageToken: newStartPageToken, items };
    await this.save();
    if (applied > 0) log?.(`applied ${applied} remote change(s) from Drive`);
  }

  private save(): Promise<void> {
    this.unsaved = 0;
    return this.kv.set(this.key, this.state);
  }

  private unsaved = 0;

  /**
   * Record the result of our own upload/move/mkdir in memory. Saved in batches
   * (every 200 changes and at the end of a sync), not per file: rewriting the
   * whole index after every file made big syncs quadratic. Losing unsaved
   * entries is harmless: the saved cursor predates them, so the Changes API
   * replays them on the next sync.
   */
  async upsert(f: DriveFile, parentId: string): Promise<void> {
    if (!this.state) return;
    this.state.items[f.id] = toItem(f, parentId);
    await this.noteChange();
  }

  async remove(id: string): Promise<void> {
    if (!this.state?.items[id]) return;
    delete this.state.items[id];
    await this.noteChange();
  }

  private async noteChange(): Promise<void> {
    if (++this.unsaved >= 200) await this.flush();
  }

  async flush(): Promise<void> {
    if (!this.state || this.unsaved === 0) return;
    this.unsaved = 0;
    await this.save();
  }

  item(id: string): IndexItem | undefined {
    return this.state?.items[id];
  }

  async reset(): Promise<void> {
    this.state = null;
    await this.kv.remove(this.key);
  }

  /** Build path maps and resolve duplicates. `preferredIds`: path -> ID we synced last time. */
  snapshot(preferredIds: Map<string, string>): RemoteSnapshot {
    if (!this.state) throw new Error("remote index not loaded");
    const items = Object.values(this.state.items);
    const notes: string[] = [];
    const byParent = new Map<string, IndexItem[]>();
    for (const it of items) byParent.set(it.parentId, [...(byParent.get(it.parentId) ?? []), it]);

    const files = new Map<string, RemoteFile>();
    const folders = new Map<string, string>();
    const blocked = new Map<string, string>();

    // Walk from the root; folders with clashing names are merged into one path.
    const visit = (folderIds: string[], path: string) => {
      const children = folderIds.flatMap((id) => byParent.get(id) ?? []);
      const groups = new Map<string, IndexItem[]>();
      for (const c of children) {
        const bad = unsafeNameReason(c.name);
        if (bad) {
          notes.push(`skipping Drive item ${JSON.stringify(c.name)} in "${path || "/"}": ${bad}`);
          continue;
        }
        if (c.native) {
          notes.push(`skipping Google Docs/Sheets/shortcut item: ${joinPath(path, c.name)}`);
          continue;
        }
        const k = foldKey(c.name);
        groups.set(k, [...(groups.get(k) ?? []), c]);
      }
      for (const group of groups.values()) {
        const subFolders = group.filter((g) => g.isFolder);
        const subFiles = group.filter((g) => !g.isFolder);
        if (subFolders.length > 0 && subFiles.length > 0) {
          const p = normKey(joinPath(path, subFolders[0].name));
          blocked.set(p, "Drive has a file and a folder with the same name here");
          continue;
        }
        if (subFolders.length > 0) {
          subFolders.sort((a, b) => a.createdTime - b.createdTime || a.id.localeCompare(b.id));
          const p = normKey(joinPath(path, subFolders[0].name));
          if (subFolders.length > 1) notes.push(`Drive has ${subFolders.length} folders named "${p}"; their contents are merged`);
          folders.set(p, subFolders[0].id);
          visit(
            subFolders.map((f) => f.id),
            p
          );
          continue;
        }
        const chosen = this.pickFile(subFiles, path, preferredIds);
        if (typeof chosen === "string") {
          blocked.set(normKey(joinPath(path, subFiles[0].name)), chosen);
          notes.push(`${normKey(joinPath(path, subFiles[0].name))}: ${chosen}`);
        } else {
          const p = normKey(joinPath(path, chosen.name));
          if (subFiles.length > 1) notes.push(`${p}: Drive has ${subFiles.length} identical copies; using the oldest/known one and leaving the others alone`);
          files.set(p, { path: p, id: chosen.id, md5: chosen.md5, size: chosen.size, modifiedTime: chosen.modifiedTime });
        }
      }
    };
    visit([this.rootId], "");
    this.notes = notes;
    return { files, folders, blocked };
  }

  /** Returns the file to use, or a reason string if the path must be blocked. */
  private pickFile(group: IndexItem[], parentPath: string, preferredIds: Map<string, string>): IndexItem | string {
    if (group.length === 1) return group[0];
    const p = normKey(joinPath(parentPath, group[0].name));
    const pref = preferredIds.get(p);
    const known = pref ? group.find((g) => g.id === pref) : undefined;
    if (known) return known;
    const names = new Set(group.map((g) => g.name));
    const md5s = new Set(group.map((g) => g.md5 ?? `?${g.id}`));
    if (names.size === 1 && md5s.size === 1) {
      return [...group].sort((a, b) => a.createdTime - b.createdTime || a.id.localeCompare(b.id))[0];
    }
    return names.size > 1
      ? `Drive has ${group.length} files whose names differ only by upper/lower case (${[...names].join(", ")}); rename one in Drive`
      : `Drive has ${group.length} different files with this same name; delete or rename the extras in Drive`;
  }
}
