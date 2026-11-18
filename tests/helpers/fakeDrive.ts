/**
 * In-memory fake of the Google Drive v3 REST API — just enough of it for the
 * plugin: files.get/list/create/update (incl. trash, move), alt=media
 * downloads, multipart/media/resumable uploads, and the Changes API.
 *
 * Tests run the REAL DriveApi + RemoteIndex + GoogleDriveProvider on top of it.
 */
import SparkMD5 from "spark-md5";
import type { HttpFn, HttpRequest, HttpResponse } from "../../src/gdrive/http";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const ROOT_ID = "VAULT_ROOT";

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content?: Uint8Array;
  modifiedTime: number;
  createdTime: number;
  trashed: boolean;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = JSON.stringify(body);
  return { status, headers, text, arrayBuffer: enc.encode(text).buffer as ArrayBuffer };
}

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function toBuf(s: string | Uint8Array): ArrayBuffer {
  const u = typeof s === "string" ? enc.encode(s) : s;
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

interface Session {
  meta: { name?: string; parents?: string[]; mimeType?: string };
  existingId?: string;
  total: number;
  received: Uint8Array;
  size: number;
}

export class FakeDrive {
  files = new Map<string, FakeFile>();
  private seq = 0;
  private clock = Date.parse("2025-01-01T00:00:00Z");
  private changeLog: Array<{ seq: number; fileId: string }> = [];
  private sessions = new Map<string, Session>();
  /** Every content a file ever had (like Drive's version history), by file ID. */
  revisions = new Map<string, Uint8Array[]>();
  /** pagination size for files.list (small in tests to exercise paging) */
  pageSize = 1000;
  /** every request, for assertions */
  requests: HttpRequest[] = [];
  /** Return a response to short-circuit a request (e.g. 429); `undefined` to proceed. */
  intercept: ((req: HttpRequest) => HttpResponse | undefined) | null = null;
  /** Called after a mutating request was applied; throw to simulate the connection dying before the reply arrives. */
  afterCommit: ((req: HttpRequest) => void) | null = null;

  constructor() {
    this.files.set(ROOT_ID, {
      id: ROOT_ID,
      name: "Vault",
      mimeType: FOLDER_MIME,
      parents: ["MY_DRIVE"],
      modifiedTime: this.tick(),
      createdTime: this.clock,
      trashed: false,
    });
  }

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  private newId(): string {
    return `id${++this.seq}`;
  }

  private keepRevision(id: string, content: Uint8Array | undefined) {
    if (!content) return;
    this.revisions.set(id, [...(this.revisions.get(id) ?? []), content]);
  }

  private touch(id: string) {
    this.changeLog.push({ seq: this.changeLog.length + 1, fileId: id });
  }

  // ---------- test helpers (act like a user editing Drive in the browser) ----------

  /** Create folders along `path` (merging into existing ones) and return the leaf folder ID. */
  mkdirp(path: string): string {
    let parent = ROOT_ID;
    if (!path) return parent;
    for (const name of path.split("/")) {
      const existing = [...this.files.values()].find((f) => !f.trashed && f.mimeType === FOLDER_MIME && f.name === name && f.parents.includes(parent));
      if (existing) {
        parent = existing.id;
        continue;
      }
      const id = this.newId();
      this.files.set(id, { id, name, mimeType: FOLDER_MIME, parents: [parent], modifiedTime: this.tick(), createdTime: this.clock, trashed: false });
      this.touch(id);
      parent = id;
    }
    return parent;
  }

  /** Always creates a NEW file (Drive allows duplicate names). */
  addFile(path: string, content: string | Uint8Array, mimeType = "text/markdown"): string {
    const i = path.lastIndexOf("/");
    const parent = this.mkdirp(i < 0 ? "" : path.slice(0, i));
    const id = this.newId();
    const t = this.tick();
    const bytes = typeof content === "string" ? enc.encode(content) : content;
    this.files.set(id, { id, name: path.slice(i + 1), mimeType, parents: [parent], content: bytes, modifiedTime: t, createdTime: t, trashed: false });
    this.keepRevision(id, bytes);
    this.touch(id);
    return id;
  }

  addGoogleDoc(path: string): string {
    const id = this.addFile(path, "", "application/vnd.google-apps.document");
    delete this.files.get(id)!.content;
    return id;
  }

  /** Path of a (non-trashed) item, or null. */
  pathOf(id: string): string | null {
    const parts: string[] = [];
    let cur = this.files.get(id);
    while (cur && cur.id !== ROOT_ID) {
      if (cur.trashed) return null;
      parts.unshift(cur.name);
      cur = this.files.get(cur.parents[0]);
    }
    return cur ? parts.join("/") : null;
  }

  /** All live (non-trashed) files under the vault root: path -> content. Fails on duplicate paths. */
  tree(): Map<string, string> {
    const out = new Map<string, string>();
    for (const f of this.files.values()) {
      if (f.mimeType === FOLDER_MIME || f.trashed || !f.content) continue;
      const p = this.pathOf(f.id);
      if (p === null) continue;
      if (out.has(p)) throw new Error(`duplicate path in fake Drive: ${p}`);
      out.set(p, dec.decode(f.content));
    }
    return out;
  }

  folderPaths(): string[] {
    return [...this.files.values()]
      .filter((f) => f.mimeType === FOLDER_MIME && f.id !== ROOT_ID && !f.trashed)
      .map((f) => this.pathOf(f.id)!)
      .filter((p) => p !== null)
      .sort();
  }

  countAt(path: string): number {
    return [...this.files.values()].filter((f) => !f.trashed && this.pathOf(f.id) === path).length;
  }

  idAt(path: string): string {
    const f = [...this.files.values()].find((x) => !x.trashed && this.pathOf(x.id) === path);
    if (!f) throw new Error(`no file at ${path}`);
    return f.id;
  }

  read(path: string): string {
    return dec.decode(this.files.get(this.idAt(path))!.content!);
  }

  edit(path: string, content: string) {
    const f = this.files.get(this.idAt(path))!;
    f.content = enc.encode(content);
    this.keepRevision(f.id, f.content);
    f.modifiedTime = this.tick();
    this.touch(f.id);
  }

  trash(path: string) {
    const f = this.files.get(this.idAt(path))!;
    f.trashed = true;
    this.touch(f.id);
  }

  /** Move/rename like the Drive web UI (keeps the ID). */
  move(path: string, to: string) {
    const f = this.files.get(this.idAt(path))!;
    const i = to.lastIndexOf("/");
    f.parents = [this.mkdirp(i < 0 ? "" : to.slice(0, i))];
    f.name = to.slice(i + 1);
    f.modifiedTime = this.tick();
    this.touch(f.id);
  }

  /** Every piece of content Drive still has anywhere (live, trashed, or in version history). */
  allContentEver(): Set<string> {
    const out = new Set<string>();
    for (const revs of this.revisions.values()) for (const r of revs) out.add(dec.decode(r));
    for (const f of this.files.values()) if (f.content) out.add(dec.decode(f.content));
    return out;
  }

  trashedNames(): string[] {
    return [...this.files.values()]
      .filter((f) => f.trashed)
      .map((f) => f.name)
      .sort();
  }

  // ---------- HTTP ----------

  private meta(f: FakeFile) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      trashed: f.trashed,
      modifiedTime: new Date(f.modifiedTime).toISOString(),
      createdTime: new Date(f.createdTime).toISOString(),
      ...(f.content && f.mimeType !== FOLDER_MIME && !f.mimeType.startsWith("application/vnd.google-apps.")
        ? { md5Checksum: SparkMD5.ArrayBuffer.hash(toBuf(f.content)), size: String(f.content.byteLength) }
        : {}),
    };
  }

  private matchQuery(f: FakeFile, q: string): boolean {
    const parentIds = [...q.matchAll(/'((?:[^'\\]|\\.)*)' in parents/g)].map((m) => m[1]);
    if (parentIds.length > 0 && !f.parents.some((p) => parentIds.includes(p))) return false;
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
    if (name && f.name !== name[1].replace(/\\(.)/g, "$1")) return false;
    const mime = /mimeType = '([^']*)'/.exec(q);
    if (mime && f.mimeType !== mime[1]) return false;
    if (q.includes("trashed = false") && f.trashed) return false;
    return true;
  }

  private finishUpload(meta: Session["meta"], existingId: string | undefined, content: Uint8Array): FakeFile {
    if (existingId) {
      const f = this.files.get(existingId)!;
      f.content = content;
      this.keepRevision(f.id, content);
      f.modifiedTime = this.tick();
      this.touch(f.id);
      return f;
    }
    const id = this.newId();
    const t = this.tick();
    const f: FakeFile = {
      id,
      name: meta.name!,
      mimeType: meta.mimeType ?? "application/octet-stream",
      parents: meta.parents ?? [ROOT_ID],
      content,
      modifiedTime: t,
      createdTime: t,
      trashed: false,
    };
    this.files.set(id, f);
    this.keepRevision(id, content);
    this.touch(id);
    return f;
  }

  readonly http: HttpFn = async (req) => {
    this.requests.push(req);
    const intercepted = this.intercept?.(req);
    if (intercepted) return intercepted;
    const res = this.handle(req);
    if (req.method && req.method !== "GET") this.afterCommit?.(req);
    return res;
  };

  private handle(req: HttpRequest): HttpResponse {
    const u = new URL(req.url);
    const method = req.method ?? "GET";
    const qp = u.searchParams;

    // resumable session URIs
    if (u.hostname === "upload.fake") {
      const s = this.sessions.get(u.pathname);
      if (!s) return json(404, { error: { message: "session gone" } });
      const cr = req.headers?.["Content-Range"] ?? "";
      if (cr.startsWith("bytes */")) {
        return s.size >= s.total ? json(200, this.meta(this.files.get(s.existingId!)!)) : json(308, {}, s.size > 0 ? { range: `bytes=0-${s.size - 1}` } : {});
      }
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
      if (!m || Number(m[1]) !== s.size) return json(400, { error: { message: `bad range ${cr}, have ${s.size}` } });
      const chunk = new Uint8Array(req.body as ArrayBuffer);
      s.received.set(chunk, s.size);
      s.size += chunk.byteLength;
      if (s.size >= s.total) {
        const f = this.finishUpload(s.meta, s.existingId, s.received);
        s.existingId = f.id;
        return json(200, this.meta(f));
      }
      return json(308, {}, { range: `bytes=0-${s.size - 1}` });
    }

    const path = u.pathname.replace(/^\/(upload\/)?drive\/v3/, "");
    const isUpload = u.pathname.startsWith("/upload/");

    if (path === "/about") return json(200, { user: { emailAddress: "me@example.com", displayName: "Me" } });
    if (path === "/changes/startPageToken") return json(200, { startPageToken: String(this.changeLog.length + 1) });
    if (path === "/changes") {
      const from = Number(qp.get("pageToken"));
      const seen = new Map<string, number>();
      for (const c of this.changeLog) if (c.seq >= from) seen.set(c.fileId, c.seq);
      const changes = [...seen.keys()].map((id) => ({ fileId: id, removed: false, file: this.meta(this.files.get(id)!) }));
      return json(200, { changes, newStartPageToken: String(this.changeLog.length + 1) });
    }

    if (path === "/files" && method === "GET") {
      const q = qp.get("q") ?? "";
      const all = [...this.files.values()].filter((f) => f.id !== ROOT_ID && this.matchQuery(f, q));
      const start = Number(qp.get("pageToken") ?? 0);
      const page = all.slice(start, start + this.pageSize);
      return json(200, { files: page.map((f) => this.meta(f)), nextPageToken: start + this.pageSize < all.length ? String(start + this.pageSize) : undefined });
    }

    if (path === "/files" && method === "POST") {
      const type = qp.get("uploadType");
      if (!isUpload) {
        const body = JSON.parse(req.body as string);
        const id = this.newId();
        const t = this.tick();
        this.files.set(id, { id, name: body.name, mimeType: body.mimeType, parents: body.parents, modifiedTime: t, createdTime: t, trashed: false });
        this.touch(id);
        return json(200, this.meta(this.files.get(id)!));
      }
      if (type === "multipart") {
        const bytes = new Uint8Array(req.body as ArrayBuffer);
        const boundary = /boundary=(.+)$/.exec(req.contentType!)![1];
        const sep = enc.encode("\r\n\r\n");
        const h1 = indexOf(bytes, sep);
        const end1 = indexOf(bytes, enc.encode(`\r\n--${boundary}`), h1);
        const meta = JSON.parse(dec.decode(bytes.slice(h1 + 4, end1)));
        const h2 = indexOf(bytes, sep, end1);
        const end2 = indexOf(bytes, enc.encode(`\r\n--${boundary}--`), h2);
        const f = this.finishUpload(meta, undefined, bytes.slice(h2 + 4, end2));
        return json(200, this.meta(f));
      }
      if (type === "resumable") return this.startSession(JSON.parse(req.body as string), undefined, req);
    }

    const fm = /^\/files\/([^/]+)$/.exec(path);
    if (fm) {
      const f = this.files.get(decodeURIComponent(fm[1]));
      if (!f) return json(404, { error: { message: "File not found" } });
      if (method === "GET") {
        if (qp.get("alt") === "media") {
          const buf = toBuf(f.content ?? new Uint8Array());
          return { status: 200, headers: {}, arrayBuffer: buf, text: dec.decode(buf) };
        }
        return json(200, this.meta(f));
      }
      if (method === "PATCH" && isUpload) {
        if (qp.get("uploadType") === "media") return json(200, this.meta(this.finishUpload({}, f.id, new Uint8Array(req.body as ArrayBuffer))));
        if (qp.get("uploadType") === "resumable") return this.startSession({}, f.id, req);
      }
      if (method === "PATCH") {
        const body = JSON.parse((req.body as string) || "{}");
        if (body.trashed === true) f.trashed = true;
        if (body.name) f.name = body.name;
        const add = qp.get("addParents");
        const rem = qp.get("removeParents");
        if (add && rem) f.parents = [...f.parents.filter((p) => p !== rem), add];
        f.modifiedTime = this.tick();
        this.touch(f.id);
        return json(200, this.meta(f));
      }
    }
    return json(400, { error: { message: `fake drive: unhandled ${method} ${req.url}` } });
  }

  private startSession(meta: Session["meta"], existingId: string | undefined, req: HttpRequest): HttpResponse {
    const total = Number(req.headers?.["X-Upload-Content-Length"]);
    const key = `/s${++this.seq}`;
    this.sessions.set(key, {
      meta: { ...meta, mimeType: req.headers?.["X-Upload-Content-Type"] },
      existingId,
      total,
      received: new Uint8Array(total),
      size: 0,
    });
    return json(200, {}, { location: `https://upload.fake${key}` });
  }
}
