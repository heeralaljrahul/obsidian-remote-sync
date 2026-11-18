import { TFile, TFolder, type App, type DataAdapter } from "obsidian";
import { normKey, parentOf } from "../sync/paths";
import type { LocalFs, LocalSnapshot } from "../sync/types";

/**
 * LocalFs over Obsidian's vault API (never Node's fs).
 *
 * Notes and attachments go through `app.vault` so Obsidian's index stays in
 * sync; the config folder (not indexed by Obsidian) goes through
 * `vault.adapter`. Deletions always go to the vault's own `.trash` folder.
 *
 * `stat` uses the same source as `scan` (TFile.stat for indexed files) so the
 * executor's "did it change since planning?" check compares like with like.
 */
export class ObsidianLocalFs implements LocalFs {
  /** normalised key -> real on-disk path (they differ only for NFD names) */
  private real = new Map<string, string>();

  constructor(private readonly app: App) {}

  private get adapter(): DataAdapter {
    return this.app.vault.adapter;
  }

  private r(p: string): string {
    return this.real.get(p) ?? p;
  }

  async scan(opts: { syncConfigDir: boolean; skipFolder: (path: string) => boolean }): Promise<LocalSnapshot> {
    this.real.clear();
    const files: LocalSnapshot["files"] = new Map();
    const folders = new Set<string>();
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f.path === "/" || f.path === "") continue;
      const k = normKey(f.path);
      if (k !== f.path) this.real.set(k, f.path);
      if (f instanceof TFile) files.set(k, { path: k, mtime: f.stat.mtime, size: f.stat.size });
      else if (f instanceof TFolder) folders.add(k);
    }
    if (opts.syncConfigDir) {
      const configDir = this.app.vault.configDir;
      const walk = async (dir: string) => {
        if (opts.skipFolder(normKey(dir))) return;
        const k = normKey(dir);
        if (k !== dir) this.real.set(k, dir);
        folders.add(k);
        const ls = await this.adapter.list(dir);
        for (const fp of ls.files) {
          const st = await this.adapter.stat(fp);
          if (!st || st.type !== "file") continue;
          const fk = normKey(fp);
          if (fk !== fp) this.real.set(fk, fp);
          files.set(fk, { path: fk, mtime: st.mtime, size: st.size });
        }
        for (const sub of ls.folders) await walk(sub);
      };
      if (await this.adapter.exists(configDir)) await walk(configDir);
    }
    return { files, folders };
  }

  read(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(this.r(path));
  }

  async write(path: string, data: ArrayBuffer, mtime: number): Promise<void> {
    const real = this.r(path);
    await this.mkdir(parentOf(path));
    const opts = mtime > 0 ? { mtime } : undefined;
    const existing = this.app.vault.getAbstractFileByPath(real);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data, opts);
      return;
    }
    if (real.startsWith(this.app.vault.configDir + "/") || (await this.adapter.exists(real))) {
      await this.adapter.writeBinary(real, data, opts);
      return;
    }
    await this.app.vault.createBinary(real, data, opts);
  }

  async stat(path: string): Promise<{ mtime: number; size: number; isFolder: boolean } | null> {
    const real = this.r(path);
    const f = this.app.vault.getAbstractFileByPath(real);
    if (f instanceof TFile) return { mtime: f.stat.mtime, size: f.stat.size, isFolder: false };
    if (f instanceof TFolder) return { mtime: 0, size: 0, isFolder: true };
    const st = await this.adapter.stat(real);
    if (!st) return null;
    return { mtime: st.mtime, size: st.size, isFolder: st.type === "folder" };
  }

  async rename(from: string, to: string): Promise<void> {
    await this.mkdir(parentOf(to));
    const f = this.app.vault.getAbstractFileByPath(this.r(from));
    // vault.rename (not fileManager.renameFile): links were already updated on the other device.
    if (f) await this.app.vault.rename(f, to);
    else await this.adapter.rename(this.r(from), to);
    this.real.delete(from);
  }

  async trash(path: string): Promise<void> {
    const real = this.r(path);
    const f = this.app.vault.getAbstractFileByPath(real);
    // system=false -> the vault's own .trash folder, never permanent.
    if (f) await this.app.vault.trash(f, false);
    else await this.adapter.trashLocal(real);
  }

  async mkdir(path: string): Promise<void> {
    if (path === "") return;
    if (await this.adapter.exists(this.r(path))) return;
    await this.mkdir(parentOf(path));
    if (path.startsWith(this.app.vault.configDir + "/") || path === this.app.vault.configDir) await this.adapter.mkdir(path);
    else await this.app.vault.createFolder(path);
  }

  async listFolder(path: string): Promise<{ files: string[]; folders: string[] }> {
    return this.adapter.list(this.r(path));
  }
}
