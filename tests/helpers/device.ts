import { DriveApi } from "../../src/gdrive/driveApi";
import { withRetry } from "../../src/gdrive/http";
import { GoogleDriveProvider } from "../../src/gdrive/provider";
import { SyncLog } from "../../src/log";
import { prepare, runPlan, safetyCheck, type EngineDeps, type Prepared } from "../../src/sync/engine";
import type { ExecResult } from "../../src/sync/executor";
import { DEFAULT_IGNORE_PATTERNS, IgnoreFilter } from "../../src/sync/ignore";
import { parentOf } from "../../src/sync/paths";
import { MemoryKV } from "../../src/sync/store";
import type { LocalFs, LocalSnapshot } from "../../src/sync/types";
import { FakeDrive, ROOT_ID, toBuf } from "./fakeDrive";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** In-memory vault. mtimes come from a shared clock so edits always look newer. */
export class MemVault implements LocalFs {
  files = new Map<string, { data: Uint8Array; mtime: number }>();
  folders = new Set<string>();
  /** paths moved to the vault's .trash */
  trashed: string[] = [];
  /** content of everything moved to .trash (Obsidian keeps it there) */
  trashBin: Array<{ path: string; data: Uint8Array }> = [];
  /** test hook: runs before every write (throw to simulate a crash mid-write) */
  beforeWrite: ((path: string) => void) | null = null;
  private static clock = Date.parse("2025-06-01T00:00:00Z");

  static tick(): number {
    MemVault.clock += 1000;
    return MemVault.clock;
  }

  put(path: string, content: string | Uint8Array) {
    this.addParents(path);
    this.files.set(path, { data: typeof content === "string" ? enc.encode(content) : content, mtime: MemVault.tick() });
  }
  text(path: string): string {
    const f = this.files.get(path);
    if (!f) throw new Error(`no local file ${path}`);
    return dec.decode(f.data);
  }
  remove(path: string) {
    this.files.delete(path);
  }
  /** user renames a file in Obsidian (mtime unchanged, like a real rename) */
  userRename(from: string, to: string) {
    this.addParents(to);
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  tree(): Map<string, string> {
    return new Map([...this.files].map(([p, f]) => [p, dec.decode(f.data)]));
  }
  private addParents(p: string) {
    for (let d = parentOf(p); d; d = parentOf(d)) this.folders.add(d);
  }

  async scan(): Promise<LocalSnapshot> {
    const files: LocalSnapshot["files"] = new Map();
    for (const [p, f] of this.files) files.set(p, { path: p, mtime: f.mtime, size: f.data.byteLength });
    return { files, folders: new Set(this.folders) };
  }

  // LocalFs
  async read(p: string) {
    return toBuf(this.files.get(p)!.data);
  }
  async write(p: string, data: ArrayBuffer, mtime: number) {
    this.beforeWrite?.(p);
    this.addParents(p);
    this.files.set(p, { data: new Uint8Array(data.slice(0)), mtime: mtime > 0 ? mtime : MemVault.tick() });
  }
  async stat(p: string) {
    const f = this.files.get(p);
    if (f) return { mtime: f.mtime, size: f.data.byteLength, isFolder: false };
    return this.folders.has(p) ? { mtime: 0, size: 0, isFolder: true } : null;
  }
  async rename(from: string, to: string) {
    this.userRename(from, to);
  }
  async trash(p: string) {
    this.trashed.push(p);
    const f = this.files.get(p);
    if (f) this.trashBin.push({ path: p, data: f.data });
    this.files.delete(p);
    this.folders.delete(p);
  }
  async mkdir(p: string) {
    for (let d = p; d; d = parentOf(d)) this.folders.add(d);
  }
  async listFolder(p: string) {
    return {
      files: [...this.files.keys()].filter((k) => parentOf(k) === p),
      folders: [...this.folders].filter((k) => parentOf(k) === p),
    };
  }
}

export interface DeviceOptions {
  syncConfigDir?: boolean;
  patterns?: string;
  maxFileSize?: number;
}

/** One device (PC, iPhone, iPad) with its own vault and its own local sync state, talking to a shared FakeDrive. */
export class Device {
  vault = new MemVault();
  kv = new MemoryKV();
  log = new SyncLog(null);
  provider: GoogleDriveProvider;
  opts: Required<DeviceOptions>;
  /** test hook: stop the executor after N actions (simulates iOS suspending the app) */
  stopAfter: number | null = null;

  constructor(
    readonly drive: FakeDrive,
    opts: DeviceOptions = {}
  ) {
    this.opts = { syncConfigDir: false, patterns: DEFAULT_IGNORE_PATTERNS, maxFileSize: 0, ...opts };
    this.provider = this.makeProvider();
    // keep the test output clean
    console.warn = () => {};
  }

  makeProvider() {
    const http = withRetry(this.drive.http, { sleep: async () => {}, random: () => 0, maxRetries: 3 });
    return new GoogleDriveProvider(new DriveApi(http, async () => "test-token"), this.kv, ROOT_ID, () => {});
  }

  /** Simulates the app being restarted: in-memory caches gone, persisted state kept. */
  restart() {
    this.provider = this.makeProvider();
  }

  deps(): EngineDeps {
    return {
      local: this.vault,
      scanLocal: () => this.vault.scan(),
      remote: this.provider,
      kv: this.kv,
      namespace: ROOT_ID,
      filter: new IgnoreFilter({ configDir: ".obsidian", syncConfigDir: this.opts.syncConfigDir, patterns: this.opts.patterns }),
      log: this.log,
      options: { maxFileSize: this.opts.maxFileSize },
    };
  }

  plan(): Promise<Prepared> {
    return prepare(this.deps());
  }

  async sync(): Promise<{ prep: Prepared; res: ExecResult }> {
    const d = this.deps();
    const prep = await prepare(d);
    safetyCheck(prep);
    let n = 0;
    const res = await runPlan({ ...d, shouldStop: () => this.stopAfter !== null && n++ >= this.stopAfter }, prep.plan);
    return { prep, res };
  }
}

export function kinds(p: Prepared): string[] {
  return p.plan.actions.map((a) => `${a.kind}:${"path" in a ? a.path : `${a.from}->${a.to}`}`).sort();
}
