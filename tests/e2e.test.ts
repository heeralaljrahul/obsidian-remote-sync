/**
 * END-TO-END: the real built main.js, in Chromium, inside a fake Obsidian
 * (tests/e2e/fakeObsidian.ts) with real IndexedDB (localforage) and real Web
 * Crypto, talking to a fake Google OAuth server (verifies PKCE) and the fake
 * Drive. Drives the UI the way a user would: settings, ribbon icon, modals.
 *
 * Needs Playwright + Chromium; skipped if unavailable.
 */
import { expect } from "chai";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import type { Browser, Page } from "playwright";

const root = join(__dirname, "..");
const req = createRequire(join(root, "package.json"));

describe("end-to-end: built main.js in a browser with a fake Obsidian", function () {
  this.timeout(120000);
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  before(async function () {
    let pw: typeof import("playwright");
    try {
      pw = req("playwright");
    } catch {
      this.skip();
    }
    execFileSync("node", ["esbuild.config.mjs", "production"], { cwd: root, stdio: "ignore" });
    const esbuild = req("esbuild");
    const harness = esbuild.buildSync({ entryPoints: [join(root, "tests/e2e/harness.ts")], bundle: true, write: false, platform: "browser", format: "iife", target: "es2020" }).outputFiles[0].text;
    const mainJs = readFileSync(join(root, "main.js"), "utf8");
    browser = await pw!.chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 430, height: 932 } });
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto("about:blank");
    // real IndexedDB needs a real origin
    await page.route("https://vault.local/", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
    await page.goto("https://vault.local/");
    await page.addStyleTag({ content: readFileSync(join(root, "styles.css"), "utf8") });
    await page.addScriptTag({ content: harness });
    // Load the REAL bundle exactly as Obsidian does: CommonJS with only `obsidian` available.
    await page.addScriptTag({ content: `(function(){var module={exports:{}};var exports=module.exports;\n${mainJs}\n;window.__PluginClass=module.exports.default||module.exports;})();` });
  });

  after(async () => {
    await browser?.close();
  });

  afterEach(() => {
    expect(errors, "no uncaught errors in the page").to.deep.equal([]);
  });

  const ev = <T>(fn: string, arg?: unknown): Promise<T> => page.evaluate(new Function("arg", `return (async () => { const E = window.E2E; ${fn} })()`) as (a: unknown) => Promise<T>, arg);

  it("loads with nothing but the obsidian module (no Node/Electron), registers ribbon, commands and protocol handler", async () => {
    const r = await ev<{ cmds: string[]; ribbon: string; handler: boolean }>(`
      const d = await E.startDevice("pc", false);
      d.vault.userWrite("Daily/2026-11-18.md", "same on both");
      d.vault.userWrite("Ideas.md", "PC version");
      d.vault.userWrite("Only on PC.md", "pc");
      E.drive.addFile("Daily/2026-11-18.md", "same on both");
      E.drive.addFile("Ideas.md", "Drive version");
      E.drive.addFile("From Drive.md", "drive");
      return { cmds: d.plugin.__commands.map(c => c.id), ribbon: d.plugin.__ribbons[0].getAttribute("data-icon"), handler: d.plugin.__handlers.has("gdrive-sync-auth") };`);
    expect(r.cmds).to.include.members(["sync-now", "dry-run", "show-log", "resolve-conflicts"]);
    expect(r.ribbon).to.equal("refresh-cw");
    expect(r.handler).to.equal(true);
  });

  it("settings UI: enter client ID/secret, sign in with Google (PKCE verified by the fake server), pick the folder", async () => {
    await ev(`const d = E.devices.pc; const tab = d.plugin.__tabs[0]; tab.containerEl.id = "settings"; document.body.appendChild(tab.containerEl); tab.display();`);
    const fill = async (name: string, value: string) => {
      const input = page.locator(".setting-item", { has: page.locator(".setting-item-name", { hasText: name }) }).locator("input").first();
      await input.fill(value);
    };
    await fill("OAuth client ID", "e2e-client.apps.googleusercontent.com");
    await fill("OAuth client secret", "GOCSPX-e2e-secret");
    expect(await ev<string>(`return E.settings(E.devices.pc).clientSecret`)).to.equal("GOCSPX-e2e-secret");

    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await page.waitForFunction(() => (window as unknown as { E2E: { opened: string[] } }).E2E.opened.length > 0);
    const authUrl = await ev<string>(`return E.opened[0]`);
    expect(authUrl).to.match(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(authUrl).to.not.contain("GOCSPX");
    expect(await ev<unknown>(`return !!E.settings(E.devices.pc).pendingAuth`)).to.equal(true, "verifier saved before leaving the app");

    await ev(`await E.completeGoogleSignIn(E.devices.pc)`);
    const s = await ev<{ email: string; rt: string; pending: unknown }>(`const s = E.settings(E.devices.pc); return { email: s.accountEmail, rt: s.tokens && s.tokens.refreshToken, pending: s.pendingAuth }`);
    expect(s.email).to.equal("me@example.com");
    expect(s.rt).to.match(/^1\/\/e2e-refresh-/);
    expect(s.pending).to.equal(null);

    await ev(`const t = E.devices.pc.plugin.__tabs[0]; t.display();`);
    await expect(page.locator(".setting-item-name", { hasText: "Signed in as me@example.com" })).to.be.ok;
    expect(await page.locator(".setting-item-description", { hasText: "No expiry" }).count()).to.equal(1);

    await fill("Folder ID or link", "https://drive.google.com/drive/folders/VAULT_ROOT?usp=sharing");
    await page.getByRole("button", { name: "Use ID" }).click();
    await page.waitForFunction(() => (window as unknown as { E2E: { devices: Record<string, { plugin: { settings: { folderId: string } } }> } }).E2E.devices.pc.plugin.settings.folderId === "VAULT_ROOT");
    await ev(`document.getElementById("settings").remove()`);
  });

  it("a replayed or forged sign-in link is rejected (state check, single-use code)", async () => {
    const r = await ev<{ notices: string[]; rt: string }>(`
      const d = E.devices.pc; const before = E.settings(d).tokens.refreshToken;
      await d.plugin.__handlers.get("gdrive-sync-auth")({ action: "gdrive-sync-auth", code: "4/forged", state: "attacker" });
      return { notices: E.notices.slice(-1), rt: E.settings(d).tokens.refreshToken === before ? "unchanged" : "changed" };`);
    expect(r.notices[0]).to.match(/No sign-in in progress|state mismatch/);
    expect(r.rt).to.equal("unchanged");
  });

  it("first sync: tapping the ribbon icon shows the dry-run review, nothing changes until 'Run first sync'", async () => {
    await ev(`E.devices.pc.plugin.__ribbons[0].click()`);
    await page.locator(".modal-title", { hasText: "Review your first sync" }).waitFor();
    const text = await page.locator(".modal").innerText();
    expect(text).to.contain("Conflicts");
    expect(text).to.contain("Uploads to Drive");
    expect(text).to.contain("Downloads from Drive");
    expect(text).to.not.contain("Deletions");
    expect(await ev<number>(`return E.drive.tree().size`)).to.equal(3, "nothing uploaded yet");

    await page.getByRole("button", { name: "Run first sync" }).click();
    await ev(`await E.waitIdle(E.devices.pc)`);
    // conflict view opens automatically after a manual sync with conflicts
    await page.locator(".modal-title", { hasText: "Sync conflicts (1)" }).waitFor();
    const tree = await ev<Record<string, string>>(`return Object.fromEntries(E.drive.tree())`);
    expect(tree["Only on PC.md"]).to.equal("pc");
    expect(await ev<string>(`return E.devices.pc.vault.read("From Drive.md")`)).to.equal("drive");
  });

  it("conflict view: the diff shows both versions; 'Keep both' keeps both everywhere", async () => {
    await page.getByRole("button", { name: "Review" }).click();
    await page.locator(".gdvs-diff").waitFor();
    expect(await page.locator(".gdvs-line.gdvs-del").innerText()).to.contain("Drive version");
    expect(await page.locator(".gdvs-line.gdvs-add").innerText()).to.contain("PC version");
    await page.getByRole("button", { name: "Keep both", exact: true }).click();
    await page.locator(".gdvs-resolved").waitFor();
    await page.getByRole("button", { name: "Close" }).click();
    const r = await ev<{ local: string[]; drive: Record<string, string> }>(`return { local: [...E.devices.pc.vault.files.keys()].sort(), drive: Object.fromEntries(E.drive.tree()) }`);
    const copy = r.local.find((p) => p.startsWith("Ideas (conflict "))!;
    expect(copy).to.match(/^Ideas \(conflict \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
    expect(r.drive["Ideas.md"]).to.equal("Drive version");
    expect(r.drive[copy]).to.equal("PC version");
  });

  it("everyday sync via the command; status bar on desktop; data is persisted in real IndexedDB", async () => {
    await ev(`const d = E.devices.pc; d.vault.userWrite("New note.md", "hello"); d.plugin.__commands.find(c => c.id === "sync-now").callback(); await new Promise(r => setTimeout(r, 20)); await E.waitIdle(d);`);
    expect(await ev<string>(`return E.drive.read("New note.md")`)).to.equal("hello");
    expect(await ev<string>(`return E.devices.pc.plugin.__statusBar[0].textContent`)).to.match(/^Drive: synced/);
    const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
    expect(dbs).to.include("gdrive-vault-sync");
  });

  it("restart (new plugin instance, same data.json + IndexedDB): nothing to do, no re-download", async () => {
    const r = await ev<{ downloads: number; uploads: number }>(`
      const old = E.devices.pc; await old.plugin.onunload();
      const d = await E.startDevice("pc", false, old);
      const n = E.requests.length;
      d.plugin.__commands.find(c => c.id === "sync-now").callback(); await new Promise(r => setTimeout(r, 20)); await E.waitIdle(d);
      const reqs = E.requests.slice(n);
      return { downloads: reqs.filter(x => x.url.includes("alt=media")).length, uploads: reqs.filter(x => x.url.includes("/upload/")).length };`);
    expect(r).to.deep.equal({ downloads: 0, uploads: 0 });
  });

  it("dry run command shows the plan and changes nothing", async () => {
    await ev(`E.devices.pc.vault.userWrite("Dry.md", "x"); E.devices.pc.plugin.__commands.find(c => c.id === "dry-run").callback();`);
    await page.locator(".modal-title", { hasText: "Dry run" }).waitFor();
    expect(await page.locator(".modal").innerText()).to.contain("Dry.md");
    await page.getByRole("button", { name: "Close" }).click();
    await ev(`await E.waitIdle(E.devices.pc)`);
    expect(await ev<number>(`return E.drive.countAt("Dry.md")`)).to.equal(0);
  });

  it("iPhone: paste the PC's refresh token, same folder, first sync downloads everything (mobile layout)", async () => {
    await ev(`
      const rt = E.settings(E.devices.pc).tokens.refreshToken;
      const ph = await E.startDevice("iphone", true);
      const tab = ph.plugin.__tabs[0]; tab.containerEl.id = "settings"; document.body.appendChild(tab.containerEl); tab.display();
      window.__rt = rt;`);
    const fill = async (name: string, value: string) =>
      page.locator("#settings .setting-item", { has: page.locator(".setting-item-name", { hasText: name }) }).locator("input").first().fill(value);
    await fill("OAuth client ID", "e2e-client.apps.googleusercontent.com");
    await fill("OAuth client secret", "GOCSPX-e2e-secret");
    await fill("Paste refresh token", await ev<string>(`return window.__rt`));
    await page.locator("#settings .setting-item", { has: page.locator(".setting-item-name", { hasText: "Paste refresh token" }) }).getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => (window as unknown as { E2E: { devices: Record<string, { plugin: { settings: { accountEmail: string } } }> } }).E2E.devices.iphone.plugin.settings.accountEmail === "me@example.com");
    await fill("Folder ID or link", "VAULT_ROOT");
    await page.locator("#settings").getByRole("button", { name: "Use ID" }).click();
    await page.waitForFunction(() => (window as unknown as { E2E: { devices: Record<string, { plugin: { settings: { folderId: string } } }> } }).E2E.devices.iphone.plugin.settings.folderId === "VAULT_ROOT");
    expect(await page.locator("#settings").innerText()).to.contain("iOS does not let plugins sync in the background");
    await ev(`document.getElementById("settings").remove(); E.devices.iphone.plugin.__ribbons[0].click();`);
    await page.locator(".modal-title", { hasText: "Review your first sync" }).waitFor();
    const modalWidth = await page.locator(".modal").evaluate((el) => el.getBoundingClientRect().width);
    expect(modalWidth).to.be.at.most(430);
    await page.getByRole("button", { name: "Run first sync" }).click();
    await ev(`await E.waitIdle(E.devices.iphone)`);
    const files = await ev<string[]>(`return [...E.devices.iphone.vault.files.keys()].filter(p => !p.startsWith(".")).sort()`);
    const driveFiles = await ev<string[]>(`return [...E.drive.tree().keys()].sort()`);
    expect(files).to.deep.equal(driveFiles);
  });

  it("iPhone: edit, then leave the app -> sync on leave pushes the edit; the PC receives it on return", async () => {
    await ev(`
      const ph = E.devices.iphone; ph.vault.userWrite("Ideas.md", "edited on iPhone");
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise(r => setTimeout(r, 30)); await E.waitIdle(ph);
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });`);
    expect(await ev<string>(`return E.drive.read("Ideas.md")`)).to.equal("edited on iPhone");
    await ev(`const pc = E.devices.pc; pc.plugin.__commands.find(c => c.id === "sync-now").callback(); await new Promise(r => setTimeout(r, 20)); await E.waitIdle(pc);`);
    expect(await ev<string>(`return E.devices.pc.vault.read("Ideas.md")`)).to.equal("edited on iPhone");
  });

  it("offline: automatic syncs are skipped quietly; a manual sync says 'offline' immediately and changes nothing", async () => {
    await page.context().setOffline(true);
    const r = await ev<{ log: string; manualNotice: string }>(`
      const ph = E.devices.iphone; E.setOffline(true);
      ph.vault.userWrite("offline.md", "o");
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      await new Promise(r => setTimeout(r, 30)); await E.waitIdle(ph);
      const log = ph.plugin.log.all().map(e => e.msg).join("\\n");
      window.__onLineDuringTest = navigator.onLine;
      const nBefore = E.notices.length;
      ph.plugin.__commands.find(c => c.id === "sync-now").callback(); await new Promise(r => setTimeout(r, 30)); await E.waitIdle(ph);
      E.setOffline(false);
      return { log, manualNotice: E.notices.slice(nBefore).join(" | ") };`);
    await page.context().setOffline(false);
    expect(r.log).to.contain("leave sync skipped: offline");
    expect(r.manualNotice).to.match(/You're offline/);
    expect(await ev<number>(`return E.drive.countAt("offline.md")`)).to.equal(0);
  });

  it("log viewer opens, filters, and copies", async () => {
    await ev(`E.devices.iphone.plugin.__commands.find(c => c.id === "show-log").callback()`);
    await page.locator(".modal-title", { hasText: "Google Drive sync log" }).waitFor();
    expect(await page.locator(".gdvs-log-row").count()).to.be.greaterThan(3);
    await page.getByRole("button", { name: "Copy" }).click();
    const copied = await ev<string>(`return E.clipboard()`);
    expect(copied).to.match(/first.sync/i);
    expect(copied).to.not.contain("ya29.");
    expect(copied).to.not.contain("GOCSPX");
    await ev(`document.querySelectorAll(".modal").forEach(m => m.remove())`);
  });

  it("a malicious Drive file name (path traversal) is never written to the vault", async () => {
    const r = await ev<string[]>(`
      E.drive.addFile("..\\\\..\\\\evil.md", "pwned");
      const pc = E.devices.pc; pc.plugin.__commands.find(c => c.id === "sync-now").callback(); await new Promise(r => setTimeout(r, 20)); await E.waitIdle(pc);
      return [...pc.vault.files.keys()].filter(p => p.includes("..") || p.includes("evil"));`);
    expect(r).to.deep.equal([]);
  });

  it("sign-in left unticked for Drive is refused with a clear message", async () => {
    const r = await ev<string>(`
      const pc = E.devices.pc; E.google.grantDrive = false;
      await pc.plugin.signOut();
      await pc.plugin.startSignIn();
      await E.completeGoogleSignIn(pc);
      await new Promise(r => setTimeout(r, 100)); // the obsidian:// handler doesn't await
      E.google.grantDrive = true;
      return E.notices[E.notices.length - 1];`);
    expect(r).to.match(/tick the Google Drive checkbox/);
    expect(await ev<unknown>(`return E.settings(E.devices.pc).tokens`)).to.equal(null);
  });

  it("no token or secret ever reached any host other than Google", async () => {
    const hosts = await ev<string[]>(`return [...new Set(E.requests.map(r => new URL(r.url).host))].sort()`);
    expect(hosts).to.deep.equal(["oauth2.googleapis.com", "upload.fake", "www.googleapis.com"].filter((h) => hosts.includes(h)));
    const leaked = await ev<number>(`return E.requests.filter(r => r.url.startsWith("https://upload.fake") && r.headers && r.headers.Authorization).length`);
    expect(leaked).to.equal(0);
  });
});
