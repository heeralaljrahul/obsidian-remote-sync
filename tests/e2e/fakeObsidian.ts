/**
 * A small, faithful-enough fake of Obsidian's plugin API (from the public
 * obsidian.d.ts), used to run the REAL built main.js in a browser. Only what
 * the plugin uses is implemented. Network goes to an in-page fake Google.
 */
import type { HttpRequest, HttpResponse } from "../../src/gdrive/http";

// ---------- DOM helpers Obsidian adds to HTMLElement ----------
type Opts = { text?: string; cls?: string | string[]; attr?: Record<string, string> };
const P = HTMLElement.prototype as unknown as Record<string, unknown>;
P.createEl = function (this: HTMLElement, tag: string, o: Opts = {}) {
  const e = document.createElement(tag);
  if (o.text !== undefined) e.textContent = o.text;
  if (o.cls) e.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
  for (const [k, v] of Object.entries(o.attr ?? {})) e.setAttribute(k, v);
  this.appendChild(e);
  return e;
};
P.createDiv = function (this: HTMLElement & { createEl: (t: string, o?: Opts) => HTMLElement }, o: Opts = {}) {
  return this.createEl("div", o);
};
P.createSpan = function (this: HTMLElement & { createEl: (t: string, o?: Opts) => HTMLElement }, o: Opts = {}) {
  return this.createEl("span", o);
};
P.empty = function (this: HTMLElement) {
  while (this.firstChild) this.removeChild(this.firstChild);
};
P.setText = function (this: HTMLElement, t: string) {
  this.textContent = t;
};
P.addClass = function (this: HTMLElement, ...c: string[]) {
  this.classList.add(...c);
};
P.removeClass = function (this: HTMLElement, ...c: string[]) {
  this.classList.remove(...c);
};
P.toggleClass = function (this: HTMLElement, c: string, v: boolean) {
  this.classList.toggle(c, v);
};

// ---------- misc ----------
export const Platform = { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false };
export function setIcon(el: HTMLElement, icon: string) {
  el.setAttribute("data-icon", icon);
}
export function normalizePath(p: string) {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
export const notices: string[] = [];
export class Notice {
  noticeEl = document.createElement("div");
  constructor(msg: string) {
    notices.push(String(msg));
    this.noticeEl.textContent = msg;
    this.noticeEl.className = "notice";
    document.body.appendChild(this.noticeEl);
  }
}

// ---------- requestUrl -> in-page fake Google ----------
export let network: (req: HttpRequest) => Promise<HttpResponse> = async () => {
  throw new Error("no fake network installed");
};
export function setNetwork(fn: typeof network) {
  network = fn;
}
export function requestUrl(p: { url: string; method?: string; headers?: Record<string, string>; body?: string | ArrayBuffer; contentType?: string; throw?: boolean }) {
  return (async () => {
    const r = await network({ url: p.url, method: p.method, headers: p.headers, body: p.body, contentType: p.contentType });
    if (p.throw !== false && r.status >= 400) throw new Error(`Request failed, status ${r.status}`);
    return { status: r.status, headers: r.headers, arrayBuffer: r.arrayBuffer, text: r.text, get json() { return JSON.parse(r.text); } };
  })();
}

// ---------- vault ----------
export class TAbstractFile {
  constructor(public vault: FakeVault, public path: string) {}
  get name() {
    return this.path.split("/").pop()!;
  }
}
export class TFile extends TAbstractFile {
  stat = { ctime: 0, mtime: 0, size: 0 };
  get extension() {
    return this.name.includes(".") ? this.name.split(".").pop()! : "";
  }
}
export class TFolder extends TAbstractFile {}

let clock = Date.parse("2026-11-18T10:00:00Z");
const tick = () => (clock += 1000);

/** In-memory vault + adapter. Files in the config dir are adapter-only (not indexed), like Obsidian. */
export class FakeVault {
  configDir = ".obsidian";
  files = new Map<string, { data: Uint8Array; mtime: number; ctime: number }>();
  folders = new Set<string>();
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  trashed: string[] = [];

  constructor(private readonly name: string) {}
  getName() {
    return this.name;
  }

  private indexed(p: string) {
    return !p.split("/").some((s) => s.startsWith("."));
  }
  private parentsOf(p: string) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
  }
  private fire(ev: string, ...args: unknown[]) {
    for (const h of this.handlers.get(ev) ?? []) h(...args);
  }
  on(ev: string, cb: (...a: unknown[]) => void) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb]);
    return { ev, cb };
  }

  /** what a user does in the editor */
  userWrite(p: string, text: string) {
    const existed = this.files.has(p);
    this.parentsOf(p);
    const now = tick();
    this.files.set(p, { data: new TextEncoder().encode(text), mtime: now, ctime: existed ? this.files.get(p)!.ctime : now });
    this.fire(existed ? "modify" : "create", this.getAbstractFileByPath(p));
  }
  read(p: string) {
    return new TextDecoder().decode(this.files.get(p)!.data);
  }

  getAllLoadedFiles(): TAbstractFile[] {
    const out: TAbstractFile[] = [];
    for (const f of this.folders) if (this.indexed(f)) out.push(this.getAbstractFileByPath(f)!);
    for (const p of this.files.keys()) if (this.indexed(p)) out.push(this.getAbstractFileByPath(p)!);
    return out;
  }
  getFiles() {
    return this.getAllLoadedFiles().filter((f) => f instanceof TFile) as TFile[];
  }
  getAbstractFileByPath(p: string): TAbstractFile | null {
    const f = this.files.get(p);
    if (f && this.indexed(p)) {
      const t = new TFile(this, p);
      t.stat = { ctime: f.ctime, mtime: f.mtime, size: f.data.byteLength };
      return t;
    }
    if (this.folders.has(p) && this.indexed(p)) return new TFolder(this, p);
    return null;
  }
  async modifyBinary(file: TFile, data: ArrayBuffer, opts?: { mtime?: number }) {
    const f = this.files.get(file.path)!;
    f.data = new Uint8Array(data.slice(0));
    f.mtime = opts?.mtime ?? tick();
    this.fire("modify", file);
  }
  async createBinary(p: string, data: ArrayBuffer, opts?: { mtime?: number }) {
    if (this.files.has(p)) throw new Error("File already exists.");
    this.parentsOf(p);
    const m = opts?.mtime ?? tick();
    this.files.set(p, { data: new Uint8Array(data.slice(0)), mtime: m, ctime: m });
    const f = this.getAbstractFileByPath(p);
    this.fire("create", f);
    return f;
  }
  async createFolder(p: string) {
    if (this.folders.has(p)) throw new Error("Folder already exists.");
    this.parentsOf(p + "/x");
    this.folders.add(p);
    return new TFolder(this, p);
  }
  async rename(file: TAbstractFile, to: string) {
    const from = file.path;
    if (this.files.has(from)) {
      this.parentsOf(to);
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
    } else {
      this.folders.delete(from);
      this.folders.add(to);
    }
    this.fire("rename", this.getAbstractFileByPath(to), from);
  }
  async trash(file: TAbstractFile, system: boolean) {
    if (system) throw new Error("test expects local .trash only");
    await this.adapter.trashLocal(file.path);
    this.fire("delete", file);
  }

  adapter = {
    readBinary: async (p: string) => {
      const f = this.files.get(p);
      if (!f) throw new Error(`ENOENT ${p}`);
      return f.data.slice().buffer as ArrayBuffer;
    },
    writeBinary: async (p: string, data: ArrayBuffer, opts?: { mtime?: number }) => {
      this.parentsOf(p);
      const m = opts?.mtime ?? tick();
      this.files.set(p, { data: new Uint8Array(data.slice(0)), mtime: m, ctime: m });
    },
    stat: async (p: string) => {
      const f = this.files.get(p);
      if (f) return { type: "file", ctime: f.ctime, mtime: f.mtime, size: f.data.byteLength };
      if (this.folders.has(p)) return { type: "folder", ctime: 0, mtime: 0, size: 0 };
      return null;
    },
    exists: async (p: string) => this.files.has(p) || this.folders.has(p) || p === "",
    list: async (p: string) => {
      const under = (k: string) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/");
      return { files: [...this.files.keys()].filter(under), folders: [...this.folders].filter(under) };
    },
    mkdir: async (p: string) => {
      this.parentsOf(p + "/x");
    },
    rename: async (a: string, b: string) => {
      this.files.set(b, this.files.get(a)!);
      this.files.delete(a);
    },
    trashLocal: async (p: string) => {
      this.trashed.push(p);
      const f = this.files.get(p);
      if (f) {
        this.files.set(`.trash/${p.split("/").pop()}`, f);
        this.files.delete(p);
      } else this.folders.delete(p);
    },
    trashSystem: async () => false,
  };
}

export class App {
  workspace = { onLayoutReady: (cb: () => void) => setTimeout(cb, 0) };
  constructor(public vault: FakeVault) {}
}

// ---------- Plugin API ----------
export class Plugin {
  app: App;
  manifest: { id: string; version: string };
  __data: unknown = null;
  __ribbons: HTMLElement[] = [];
  __commands: Array<{ id: string; name: string; callback: () => void }> = [];
  __handlers = new Map<string, (p: Record<string, string>) => void>();
  __tabs: PluginSettingTab[] = [];
  __statusBar: HTMLElement[] = [];
  constructor(app: App, manifest: { id: string; version: string }) {
    this.app = app;
    this.manifest = manifest;
  }
  async loadData() {
    return this.__data === null ? null : JSON.parse(JSON.stringify(this.__data));
  }
  async saveData(d: unknown) {
    this.__data = JSON.parse(JSON.stringify(d));
  }
  addRibbonIcon(icon: string, title: string, cb: () => void) {
    const el = document.createElement("button");
    el.setAttribute("aria-label", title);
    el.setAttribute("data-icon", icon);
    el.onclick = cb;
    document.body.appendChild(el);
    this.__ribbons.push(el);
    return el;
  }
  addStatusBarItem() {
    const el = document.createElement("div");
    this.__statusBar.push(el);
    return el;
  }
  addCommand(c: { id: string; name: string; callback: () => void }) {
    this.__commands.push(c);
  }
  registerObsidianProtocolHandler(action: string, h: (p: Record<string, string>) => void) {
    this.__handlers.set(action, h);
  }
  addSettingTab(t: PluginSettingTab) {
    this.__tabs.push(t);
  }
  registerEvent() {}
  registerDomEvent(el: EventTarget, type: string, cb: EventListener) {
    el.addEventListener(type, cb);
  }
  registerInterval(id: number) {
    return id;
  }
}

export class PluginSettingTab {
  containerEl = document.createElement("div");
  constructor(public app: App, public plugin: Plugin) {
    this.containerEl.className = "settings";
  }
}

export class Modal {
  modalEl = document.createElement("div");
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(public app: App) {
    this.modalEl.className = "modal";
    this.titleEl = this.modalEl.appendChild(document.createElement("div"));
    this.titleEl.className = "modal-title";
    this.contentEl = this.modalEl.appendChild(document.createElement("div"));
    this.contentEl.className = "modal-content";
  }
  open() {
    document.body.appendChild(this.modalEl);
    (this as unknown as { onOpen?: () => void }).onOpen?.();
  }
  close() {
    (this as unknown as { onClose?: () => void }).onClose?.();
    this.modalEl.remove();
  }
}

class Component<T extends HTMLElement> {
  constructor(public el: T) {}
}
class ButtonComponent extends Component<HTMLButtonElement> {
  buttonEl = this.el;
  setButtonText(t: string) {
    this.el.textContent = t;
    return this;
  }
  setCta() {
    this.el.classList.add("mod-cta");
    return this;
  }
  setWarning() {
    this.el.classList.add("mod-warning");
    return this;
  }
  setDisabled(d: boolean) {
    this.el.disabled = d;
    return this;
  }
  setIcon(i: string) {
    this.el.setAttribute("data-icon", i);
    return this;
  }
  setTooltip(t: string) {
    this.el.title = t;
    return this;
  }
  onClick(cb: () => void) {
    this.el.onclick = cb;
    return this;
  }
}
class TextComponent extends Component<HTMLInputElement> {
  inputEl = this.el;
  setPlaceholder(p: string) {
    this.el.placeholder = p;
    return this;
  }
  setValue(v: string) {
    this.el.value = v;
    return this;
  }
  onChange(cb: (v: string) => unknown) {
    this.el.addEventListener("input", () => void cb(this.el.value));
    return this;
  }
}
class TextAreaComponent extends Component<HTMLTextAreaElement> {
  inputEl = this.el;
  setValue(v: string) {
    this.el.value = v;
    return this;
  }
  onChange(cb: (v: string) => unknown) {
    this.el.addEventListener("input", () => void cb(this.el.value));
    return this;
  }
}
class ToggleComponent extends Component<HTMLInputElement> {
  setValue(v: boolean) {
    this.el.checked = v;
    return this;
  }
  onChange(cb: (v: boolean) => unknown) {
    this.el.addEventListener("change", () => void cb(this.el.checked));
    return this;
  }
}
class DropdownComponent extends Component<HTMLSelectElement> {
  addOption(v: string, label: string) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    this.el.appendChild(o);
    return this;
  }
  setValue(v: string) {
    this.el.value = v;
    return this;
  }
  onChange(cb: (v: string) => unknown) {
    this.el.addEventListener("change", () => void cb(this.el.value));
    return this;
  }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  constructor(container: HTMLElement) {
    this.settingEl = container.appendChild(document.createElement("div"));
    this.settingEl.className = "setting-item";
    this.infoEl = this.settingEl.appendChild(document.createElement("div"));
    this.nameEl = this.infoEl.appendChild(document.createElement("div"));
    this.nameEl.className = "setting-item-name";
    this.descEl = this.infoEl.appendChild(document.createElement("div"));
    this.descEl.className = "setting-item-description";
    this.controlEl = this.settingEl.appendChild(document.createElement("div"));
  }
  setName(n: string) {
    this.nameEl.textContent = n;
    return this;
  }
  setDesc(d: string) {
    this.descEl.textContent = d;
    return this;
  }
  setHeading() {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  private add<T>(el: HTMLElement, c: T, cb: (c: T) => unknown) {
    this.controlEl.appendChild(el);
    cb(c);
    return this;
  }
  addButton(cb: (b: ButtonComponent) => unknown) {
    const el = document.createElement("button");
    return this.add(el, new ButtonComponent(el), cb);
  }
  addExtraButton(cb: (b: ButtonComponent) => unknown) {
    const el = document.createElement("button");
    el.className = "extra";
    return this.add(el, new ButtonComponent(el), cb);
  }
  addText(cb: (t: TextComponent) => unknown) {
    const el = document.createElement("input");
    return this.add(el, new TextComponent(el), cb);
  }
  addTextArea(cb: (t: TextAreaComponent) => unknown) {
    const el = document.createElement("textarea");
    return this.add(el, new TextAreaComponent(el), cb);
  }
  addToggle(cb: (t: ToggleComponent) => unknown) {
    const el = document.createElement("input");
    el.type = "checkbox";
    return this.add(el, new ToggleComponent(el), cb);
  }
  addDropdown(cb: (d: DropdownComponent) => unknown) {
    const el = document.createElement("select");
    return this.add(el, new DropdownComponent(el), cb);
  }
}
