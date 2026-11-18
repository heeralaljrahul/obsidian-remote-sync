/**
 * Thin Google Drive v3 REST client, written from the public API reference:
 * https://developers.google.com/drive/api/reference/rest/v3
 *
 * Every request goes through the injected HttpFn (Obsidian `requestUrl` in the
 * plugin) with automatic token refresh on 401 and backoff on rate limits.
 */
import { HttpError, parseJson, type HttpFn, type HttpResponse } from "./http";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const FILE_FIELDS = "id,name,mimeType,md5Checksum,size,modifiedTime,createdTime,parents,trashed";

/** Files above this size use a resumable upload. */
export const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
/** Must be a multiple of 256 KiB. 8 MiB keeps memory use bounded on phones. */
export const CHUNK_SIZE = 8 * 1024 * 1024;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  parents?: string[];
  trashed?: boolean;
}

export interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

export function isGoogleNative(mime: string): boolean {
  return mime.startsWith("application/vnd.google-apps.") && mime !== FOLDER_MIME;
}

/** Escape a value for use inside a Drive `q` string literal. */
export function qEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  css: "text/css",
  js: "text/javascript",
  canvas: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

export function guessMime(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/** Saved state of an interrupted resumable upload, so it can continue after iOS suspends the app. */
export interface ResumableSession {
  uri: string;
  md5: string;
  size: number;
  createdAt: number;
}

export interface ResumableStore {
  get(key: string): Promise<ResumableSession | null>;
  set(key: string, s: ResumableSession): Promise<void>;
  remove(key: string): Promise<void>;
}

export class DriveApi {
  constructor(private readonly http: HttpFn, private readonly token: (forceRefresh?: boolean) => Promise<string>) {}

  /** Authorized request. Retries once with a fresh token on 401. Throws HttpError for non-2xx (except `okStatuses`). */
  async call(
    method: string,
    url: string,
    opts: { query?: Record<string, string>; body?: string | ArrayBuffer; contentType?: string; headers?: Record<string, string>; okStatuses?: number[] } = {}
  ): Promise<HttpResponse> {
    const full = opts.query ? `${url}?${new URLSearchParams(opts.query).toString()}` : url;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.http({
        url: full,
        method,
        body: opts.body,
        contentType: opts.contentType,
        headers: { Authorization: `Bearer ${await this.token(attempt > 0)}`, ...(opts.headers ?? {}) },
      });
      if (res.status === 401 && attempt === 0) continue;
      if ((res.status >= 200 && res.status < 300) || opts.okStatuses?.includes(res.status)) return res;
      throw new HttpError(res.status, res.text.slice(0, 500), `Google Drive ${method} failed: HTTP ${res.status} ${extractReason(res.text)}`);
    }
    throw new Error("unreachable");
  }

  async about(): Promise<{ email: string; name: string }> {
    const r = parseJson<{ user: { emailAddress: string; displayName: string } }>(await this.call("GET", `${API}/about`, { query: { fields: "user(emailAddress,displayName)" } }));
    return { email: r.user.emailAddress, name: r.user.displayName };
  }

  async getFile(id: string): Promise<DriveFile | null> {
    try {
      return parseJson<DriveFile>(await this.call("GET", `${API}/files/${encodeURIComponent(id)}`, { query: { fields: FILE_FIELDS, supportsAllDrives: "true" } }));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
  }

  /** files.list with pagination. */
  async list(q: string, fields = FILE_FIELDS): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        q,
        fields: `nextPageToken,files(${fields})`,
        pageSize: "1000",
        spaces: "drive",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      };
      if (pageToken) query.pageToken = pageToken;
      const r = parseJson<{ files: DriveFile[]; nextPageToken?: string }>(await this.call("GET", `${API}/files`, { query }));
      out.push(...r.files);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** Non-trashed children of any of the given folders (batched into one query). */
  listChildren(parentIds: string[]): Promise<DriveFile[]> {
    const parents = parentIds.map((id) => `'${qEscape(id)}' in parents`).join(" or ");
    return this.list(`(${parents}) and trashed = false`);
  }

  findFoldersByName(name: string): Promise<DriveFile[]> {
    return this.list(`name = '${qEscape(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`);
  }

  async findChildByName(parentId: string, name: string): Promise<DriveFile[]> {
    return this.list(`'${qEscape(parentId)}' in parents and name = '${qEscape(name)}' and trashed = false`);
  }

  async getStartPageToken(): Promise<string> {
    const r = parseJson<{ startPageToken: string }>(await this.call("GET", `${API}/changes/startPageToken`, { query: { supportsAllDrives: "true" } }));
    return r.startPageToken;
  }

  /** All changes since `pageToken`. Returns the token to use next time. */
  async listChanges(pageToken: string): Promise<{ changes: DriveChange[]; newStartPageToken: string }> {
    const changes: DriveChange[] = [];
    let token = pageToken;
    for (;;) {
      const r = parseJson<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>(
        await this.call("GET", `${API}/changes`, {
          query: {
            pageToken: token,
            pageSize: "1000",
            spaces: "drive",
            includeRemoved: "true",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
          },
        })
      );
      changes.push(...r.changes);
      if (r.newStartPageToken) return { changes, newStartPageToken: r.newStartPageToken };
      if (!r.nextPageToken) throw new Error("Drive changes response had no page token");
      token = r.nextPageToken;
    }
  }

  async download(id: string): Promise<ArrayBuffer> {
    const res = await this.call("GET", `${API}/files/${encodeURIComponent(id)}`, { query: { alt: "media", supportsAllDrives: "true" } });
    return res.arrayBuffer;
  }

  async createFolder(name: string, parentId: string): Promise<DriveFile> {
    return parseJson<DriveFile>(
      await this.call("POST", `${API}/files`, {
        query: { fields: FILE_FIELDS, supportsAllDrives: "true" },
        contentType: "application/json",
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      })
    );
  }

  /** Rename and/or move. */
  async move(id: string, newName: string, addParent?: string, removeParent?: string): Promise<DriveFile> {
    const query: Record<string, string> = { fields: FILE_FIELDS, supportsAllDrives: "true" };
    if (addParent && removeParent && addParent !== removeParent) {
      query.addParents = addParent;
      query.removeParents = removeParent;
    }
    return parseJson<DriveFile>(
      await this.call("PATCH", `${API}/files/${encodeURIComponent(id)}`, { query, contentType: "application/json", body: JSON.stringify({ name: newName }) })
    );
  }

  /** Move to Drive's trash (recoverable for 30 days). Never a permanent delete. */
  async trash(id: string): Promise<void> {
    await this.call("PATCH", `${API}/files/${encodeURIComponent(id)}`, {
      query: { supportsAllDrives: "true" },
      contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    });
  }

  /**
   * Create (no `existingId`) or update file content. Small files go in one
   * request; larger ones use a resumable session uploaded in CHUNK_SIZE parts,
   * persisted in `sessions` so an upload interrupted by iOS can continue.
   */
  async upload(
    a: { name: string; parentId: string; data: ArrayBuffer; existingId?: string; md5: string; sessionKey: string },
    sessions?: ResumableStore
  ): Promise<DriveFile> {
    const mime = guessMime(a.name);
    if (a.data.byteLength <= RESUMABLE_THRESHOLD) {
      if (a.existingId) {
        return parseJson<DriveFile>(
          await this.call("PATCH", `${UPLOAD_API}/files/${encodeURIComponent(a.existingId)}`, {
            query: { uploadType: "media", fields: FILE_FIELDS, supportsAllDrives: "true" },
            contentType: mime,
            body: a.data,
          })
        );
      }
      const { body, contentType } = multipartBody({ name: a.name, parents: [a.parentId], mimeType: mime }, a.data, mime);
      return parseJson<DriveFile>(
        await this.call("POST", `${UPLOAD_API}/files`, { query: { uploadType: "multipart", fields: FILE_FIELDS, supportsAllDrives: "true" }, contentType, body })
      );
    }
    return this.resumableUpload(a, mime, sessions);
  }

  private async resumableUpload(
    a: { name: string; parentId: string; data: ArrayBuffer; existingId?: string; md5: string; sessionKey: string },
    mime: string,
    sessions?: ResumableStore
  ): Promise<DriveFile> {
    const total = a.data.byteLength;
    let offset = 0;
    let uri: string | undefined;

    // Continue a saved session for the exact same content, if Google still has it.
    const saved = await sessions?.get(a.sessionKey);
    if (saved && saved.md5 === a.md5 && saved.size === total && Date.now() - saved.createdAt < 6 * 24 * 3600 * 1000) {
      const st = await this.http({ url: saved.uri, method: "PUT", headers: { "Content-Range": `bytes */${total}` } });
      if (st.status === 200 || st.status === 201) {
        await sessions?.remove(a.sessionKey);
        return parseJson<DriveFile>(st);
      }
      if (st.status === 308) {
        uri = saved.uri;
        offset = nextOffset(st);
      }
    }

    if (!uri) {
      const init = await this.call(a.existingId ? "PATCH" : "POST", a.existingId ? `${UPLOAD_API}/files/${encodeURIComponent(a.existingId)}` : `${UPLOAD_API}/files`, {
        query: { uploadType: "resumable", fields: FILE_FIELDS, supportsAllDrives: "true" },
        contentType: "application/json; charset=UTF-8",
        headers: { "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(total) },
        body: JSON.stringify(a.existingId ? {} : { name: a.name, parents: [a.parentId], mimeType: mime }),
      });
      uri = init.headers["location"];
      if (!uri) throw new Error("Drive did not return a resumable upload URL");
      await sessions?.set(a.sessionKey, { uri, md5: a.md5, size: total, createdAt: Date.now() });
    }

    while (offset < total) {
      const end = Math.min(offset + CHUNK_SIZE, total);
      const res = await this.http({
        url: uri,
        method: "PUT",
        contentType: mime,
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}` },
        body: a.data.slice(offset, end),
      });
      if (res.status === 200 || res.status === 201) {
        await sessions?.remove(a.sessionKey);
        return parseJson<DriveFile>(res);
      }
      if (res.status === 308) {
        offset = nextOffset(res);
        continue;
      }
      if (res.status === 404 || res.status === 410) {
        await sessions?.remove(a.sessionKey);
        throw new Error("resumable upload session expired; it will restart on the next sync");
      }
      throw new HttpError(res.status, res.text.slice(0, 500), `chunk upload failed: HTTP ${res.status} ${extractReason(res.text)}`);
    }
    // All bytes sent but no final response: ask for the status.
    const fin = await this.http({ url: uri, method: "PUT", headers: { "Content-Range": `bytes */${total}` } });
    if (fin.status === 200 || fin.status === 201) {
      await sessions?.remove(a.sessionKey);
      return parseJson<DriveFile>(fin);
    }
    throw new Error(`resumable upload did not complete (HTTP ${fin.status})`);
  }
}

/** Parse the `Range: bytes=0-N` header of a 308 response into the next byte to send. */
function nextOffset(res: HttpResponse): number {
  const m = /bytes=0-(\d+)/.exec(res.headers["range"] ?? "");
  return m ? Number(m[1]) + 1 : 0;
}

function extractReason(text: string): string {
  try {
    const j = JSON.parse(text);
    return j?.error?.message ?? j?.error_description ?? "";
  } catch {
    return "";
  }
}

/** Build a multipart/related body (JSON metadata + binary content) without Node's Buffer. */
export function multipartBody(meta: object, data: ArrayBuffer, mime: string): { body: ArrayBuffer; contentType: string } {
  const boundary = `gdvs${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` + `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const out = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(new Uint8Array(data), head.byteLength);
  out.set(tail, head.byteLength + data.byteLength);
  return { body: out.buffer, contentType: `multipart/related; boundary=${boundary}` };
}
