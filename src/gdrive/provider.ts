import { baseName, parentOf } from "../sync/paths";
import { PreconditionError, type KVStore, type RemoteFile, type RemoteProvider, type RemoteSnapshot } from "../sync/types";
import { FOLDER_MIME, type DriveApi, type DriveFile, type ResumableSession, type ResumableStore } from "./driveApi";
import { RemoteIndex } from "./remoteIndex";

function toRemoteFile(f: DriveFile, path: string): RemoteFile {
  return {
    path,
    id: f.id,
    md5: f.md5Checksum,
    size: f.size !== undefined ? Number(f.size) : 0,
    modifiedTime: f.modifiedTime ? Date.parse(f.modifiedTime) : 0,
  };
}

class KVResumableStore implements ResumableStore {
  constructor(private readonly kv: KVStore, private readonly ns: string) {}
  get(key: string) {
    return this.kv.get<ResumableSession>(`upload\u0000${this.ns}\u0000${key}`);
  }
  set(key: string, s: ResumableSession) {
    return this.kv.set(`upload\u0000${this.ns}\u0000${key}`, s);
  }
  remove(key: string) {
    return this.kv.remove(`upload\u0000${this.ns}\u0000${key}`);
  }
}

/** Google Drive implementation of the RemoteProvider contract. */
export class GoogleDriveProvider implements RemoteProvider {
  readonly index: RemoteIndex;
  private readonly sessions: ResumableStore;
  private folderIds = new Map<string, string>();
  private lastNotes = new Set<string>();

  constructor(private readonly api: DriveApi, kv: KVStore, readonly rootId: string, private readonly log: (level: "info" | "warn", msg: string) => void) {
    this.index = new RemoteIndex(api, kv, rootId);
    this.sessions = new KVResumableStore(kv, rootId);
  }

  async snapshot(preferredIds: Map<string, string>): Promise<RemoteSnapshot> {
    await this.index.refresh((m) => this.log("info", m));
    const snap = this.index.snapshot(preferredIds);
    this.folderIds = new Map(snap.folders);
    // Only log "skipping X" notes when they change, so the log doesn't fill up.
    const notes = new Set(this.index.notes);
    for (const n of notes) if (!this.lastNotes.has(n)) this.log("warn", n);
    this.lastNotes = notes;
    return snap;
  }

  async stat(id: string): Promise<RemoteFile | null> {
    const f = await this.api.getFile(id);
    if (!f || f.trashed) return null;
    return toRemoteFile(f, "");
  }

  download(id: string): Promise<ArrayBuffer> {
    return this.api.download(id);
  }

  async upload(path: string, data: ArrayBuffer, existingId?: string, md5?: string): Promise<RemoteFile> {
    const parentId = await this.mkdir(parentOf(path));
    const name = baseName(path);
    if (!existingId) {
      // Never create a second file with the same name.
      const clash = await this.api.findChildByName(parentId, name);
      if (clash.length > 0) throw new PreconditionError("a file with this name appeared in Drive during sync");
    }
    const f = await this.api.upload({ name, parentId, data, existingId, md5: md5 ?? "", sessionKey: existingId ?? path }, this.sessions);
    await this.index.upsert(f, parentId);
    return toRemoteFile(f, path);
  }

  async move(id: string, toPath: string): Promise<RemoteFile> {
    const it = this.index.item(id);
    const newParent = await this.mkdir(parentOf(toPath));
    const name = baseName(toPath);
    const clash = (await this.api.findChildByName(newParent, name)).filter((f) => f.id !== id);
    if (clash.length > 0) throw new PreconditionError("destination name already exists in Drive");
    const f = await this.api.move(id, name, newParent, it?.parentId);
    await this.index.upsert(f, newParent);
    return toRemoteFile(f, toPath);
  }

  /** mkdir -p; returns the folder ID. Reuses an existing folder of that name instead of creating a duplicate. */
  async mkdir(path: string): Promise<string> {
    if (path === "") return this.rootId;
    const known = this.folderIds.get(path);
    if (known) return known;
    const parentId = await this.mkdir(parentOf(path));
    const name = baseName(path);
    const existing = (await this.api.findChildByName(parentId, name)).filter((f) => f.mimeType === FOLDER_MIME);
    const f = existing.length > 0 ? existing.sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""))[0] : await this.api.createFolder(name, parentId);
    await this.index.upsert(f, parentId);
    this.folderIds.set(path, f.id);
    return f.id;
  }

  async trash(id: string): Promise<void> {
    await this.api.trash(id);
    await this.index.remove(id);
    for (const [p, fid] of this.folderIds) if (fid === id) this.folderIds.delete(p);
  }

  flush(): Promise<void> {
    return this.index.flush();
  }

  async folderIsEmpty(id: string): Promise<boolean> {
    const children = await this.api.list(`'${id.replace(/'/g, "\\'")}' in parents and trashed = false`, "id");
    return children.length === 0;
  }
}
