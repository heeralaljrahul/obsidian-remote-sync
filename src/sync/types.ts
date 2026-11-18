/**
 * Core types shared by the planner, the executor and the remote provider.
 *
 * Paths are vault-relative, use "/" separators, never start or end with "/",
 * and are Unicode NFC-normalised (iOS can hand back NFD names; Drive keeps
 * whatever the uploader sent). See `normKey` in ./paths.ts.
 *
 * Nothing in src/sync may import "obsidian" at runtime, so the whole engine can
 * be unit-tested under Node with in-memory fakes.
 */

/** A file as it currently exists in the local vault. */
export interface LocalFile {
  path: string;
  mtime: number;
  size: number;
  /** Hex MD5 of the content. Only filled in when the planner needs it (see `pathsNeedingHash`). */
  md5?: string;
}

/** A file as it currently exists in the remote folder. */
export interface RemoteFile {
  path: string;
  id: string;
  /** Hex MD5 reported by the remote (Drive's md5Checksum). */
  md5?: string;
  size: number;
  /** ms since epoch */
  modifiedTime: number;
}

export interface LocalSnapshot {
  files: Map<string, LocalFile>;
  folders: Set<string>;
}

export interface RemoteSnapshot {
  files: Map<string, RemoteFile>;
  /** folder path -> remote folder id */
  folders: Map<string, string>;
  /**
   * Paths that must not be touched this sync on EITHER side, with the reason
   * (e.g. two different files with the same name in one Drive folder).
   */
  blocked: Map<string, string>;
}

/**
 * What both sides looked like the last time this path was successfully synced.
 * One record per path, written immediately after each completed action, so an
 * interrupted sync resumes from exactly where it stopped.
 */
export interface BaseEntry {
  path: string;
  isFolder: boolean;
  /** content hash that both sides agreed on */
  md5?: string;
  localMtime?: number;
  localSize?: number;
  remoteId?: string;
  remoteMd5?: string;
  remoteModifiedTime?: number;
  remoteSize?: number;
  syncedAt: number;
}

export type ConflictType =
  /** edited on both sides since the last sync */
  | "both-modified"
  /** created on both sides (or first sync) with different content */
  | "both-created";

export type Action =
  | { kind: "upload"; path: string; reason: "new" | "modified" | "restore"; remoteId?: string; expectRemoteMd5?: string; local: LocalFile }
  | { kind: "download"; path: string; reason: "new" | "modified" | "restore"; remote: RemoteFile; local?: LocalFile }
  /** both sides already hold identical content: just record the base */
  | { kind: "adopt"; path: string; local: LocalFile; remote: RemoteFile }
  | { kind: "trashLocal"; path: string; local: LocalFile }
  | { kind: "trashRemote"; path: string; remote: RemoteFile }
  | { kind: "moveLocal"; from: string; to: string }
  | { kind: "moveRemote"; from: string; to: string; remoteId: string }
  | { kind: "mkdirLocal"; path: string }
  | { kind: "mkdirRemote"; path: string }
  | { kind: "adoptFolder"; path: string; remoteId: string }
  | { kind: "trashLocalFolder"; path: string }
  | { kind: "trashRemoteFolder"; path: string; remoteId: string }
  /** gone on both sides: drop the base record */
  | { kind: "forget"; path: string }
  | { kind: "conflict"; path: string; type: ConflictType; local: LocalFile; remote: RemoteFile; base?: BaseEntry }
  | { kind: "skip"; path: string; reason: string };

export type ActionKind = Action["kind"];

export interface SyncPlan {
  firstSync: boolean;
  actions: Action[];
}

export interface PlanOptions {
  /** Files larger than this (bytes) are skipped. 0 = no limit. */
  maxFileSize: number;
}

/** Minimal local file system used by the executor. Implemented over Obsidian's vault in src/obsidian/localFs.ts. */
export interface LocalFs {
  read(path: string): Promise<ArrayBuffer>;
  /** Write content, creating parent folders. Must set mtime when possible. */
  write(path: string, data: ArrayBuffer, mtime: number): Promise<void>;
  stat(path: string): Promise<{ mtime: number; size: number; isFolder: boolean } | null>;
  rename(from: string, to: string): Promise<void>;
  /** Move to the vault's .trash folder (never permanent). */
  trash(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** List direct children of a folder ("" = vault root). */
  listFolder(path: string): Promise<{ files: string[]; folders: string[] }>;
}

/**
 * The remote provider contract. This is the typed successor of upstream's
 * `RemoteClient` switch: list, upload, download, delete — plus the move and
 * metadata calls the three-way planner needs.
 */
export interface RemoteProvider {
  /** Bring the remote view up to date and return it. */
  snapshot(preferredIds: Map<string, string>): Promise<RemoteSnapshot>;
  /** Fresh metadata for one file, bypassing caches. null if gone/trashed. */
  stat(id: string): Promise<RemoteFile | null>;
  download(id: string): Promise<ArrayBuffer>;
  /**
   * Upload content to `path`. With `existingId` the file is updated in place
   * (keeps Drive revision history); without it a new file is created and the
   * call must fail with `PreconditionError` if a file with that name appeared
   * remotely in the meantime (prevents creating duplicates).
   */
  upload(path: string, data: ArrayBuffer, existingId?: string, md5?: string): Promise<RemoteFile>;
  move(id: string, toPath: string): Promise<RemoteFile>;
  mkdir(path: string): Promise<string>;
  /** Move to the remote trash (never permanent). */
  trash(id: string): Promise<void>;
  /** Are there any (non-trashed) children left? */
  folderIsEmpty(id: string): Promise<boolean>;
}

/** Thrown when the world changed between planning and executing an action. The action is skipped and retried next sync. */
export class PreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreconditionError";
  }
}

/** Simple async key/value store (IndexedDB in the plugin, a Map in tests). */
export interface KVStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  /** All entries whose key starts with `prefix`. */
  entries<T>(prefix: string): Promise<Array<[string, T]>>;
}
