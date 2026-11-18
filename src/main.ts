import { Notice, Platform, Plugin, setIcon, type ObsidianProtocolData } from "obsidian";
import { DriveApi, FOLDER_MIME, type DriveFile } from "./gdrive/driveApi";
import { withRetry, type HttpFn } from "./gdrive/http";
import { AuthError, exchangeCode, REVOKE_ENDPOINT, startAuth, TokenManager, type Tokens } from "./gdrive/oauth";
import { GoogleDriveProvider } from "./gdrive/provider";
import { errMsg, SyncLog } from "./log";
import { LocalForageKV } from "./obsidian/kv";
import { ObsidianLocalFs } from "./obsidian/localFs";
import { obsidianHttp } from "./obsidian/obsidianHttp";
import { GDriveSettingTab } from "./obsidian/settingTab";
import { DEFAULT_SETTINGS, type GDriveSettings } from "./settings";
import { prepare, runPlan, safetyCheck, type EngineDeps } from "./sync/engine";
import { IgnoreFilter } from "./sync/ignore";
import { isDeletion, summarize } from "./sync/planner";
import { reviewReason } from "./sync/planView";
import { LogModal, PlanReviewModal } from "./obsidian/modals";
import { BaseStore } from "./sync/store";
import { randomString } from "./gdrive/oauth";

export const AUTH_ACTION = "gdrive-sync-auth";

export type SyncTrigger = "manual" | "startup" | "resume" | "interval" | "dry-run";

export default class GDriveSyncPlugin extends Plugin {
  settings!: GDriveSettings;
  kv!: LocalForageKV;
  log!: SyncLog;
  private http!: HttpFn;
  private tokens!: TokenManager;
  private provider: GoogleDriveProvider | null = null;
  private running = false;
  private stopping = false;
  private ribbon: HTMLElement | null = null;
  private statusBar: HTMLElement | null = null;
  private intervalId: number | null = null;
  /** Avoid repeating the "needs review" notice on every automatic trigger. */
  private reviewNoticeShown = false;
  /** Conflicts persist until resolved; only notify when the set changes. */
  private lastConflictKey = "";

  async onload() {
    await this.loadSettings();
    this.kv = new LocalForageKV(this.settings.installId);
    this.log = new SyncLog(this.kv);
    await this.log.load();

    this.http = withRetry(obsidianHttp, {
      onRetry: (n, ms, why) => this.log.warn(`Google API busy (${why}); retry ${n} in ${Math.round(ms / 1000)}s`),
    });
    this.tokens = new TokenManager(
      this.http,
      () => ({ clientId: this.settings.clientId, clientSecret: this.settings.clientSecret, tokens: this.settings.tokens }),
      async (t) => {
        this.settings.tokens = t;
        await this.saveSettings();
      }
    );

    this.ribbon = this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => void this.sync("manual"));
    if (!Platform.isMobile) {
      this.statusBar = this.addStatusBarItem();
      this.updateStatus();
    }

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync("manual") });
    this.addCommand({ id: "dry-run", name: "Dry run (show what a sync would do)", callback: () => void this.sync("dry-run") });
    this.addCommand({ id: "show-log", name: "Show sync log", callback: () => this.showLog() });

    this.registerObsidianProtocolHandler(AUTH_ACTION, (p) => void this.onAuthCallback(p));
    this.addSettingTab(new GDriveSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      // Only after layout-ready is Obsidian's file index complete; syncing earlier could
      // mistake not-yet-indexed files for deletions.
      if (this.settings.syncOnStartup) window.setTimeout(() => void this.sync("startup"), 2000);
      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "visible" && this.settings.syncOnResume && Date.now() - this.settings.lastSyncAt > 60_000) {
          void this.sync("resume");
        }
      });
    });
    this.resetInterval();
  }

  onunload() {
    this.stopping = true;
    void this.log?.flush();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.installId) {
      this.settings.installId = randomString(12);
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  resetInterval() {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.intervalId = null;
    const m = this.settings.intervalMinutes;
    if (m > 0) {
      this.intervalId = window.setInterval(() => void this.sync("interval"), m * 60_000);
      this.registerInterval(this.intervalId);
    }
  }

  isSignedIn(): boolean {
    return !!this.settings.tokens?.refreshToken;
  }

  api(): DriveApi {
    return new DriveApi(this.http, (force) => this.tokens.accessToken(force));
  }

  // ---------------- OAuth ----------------

  async startSignIn() {
    const s = this.settings;
    if (!s.clientId || !s.clientSecret) {
      new Notice("Enter your OAuth client ID and client secret first.");
      return;
    }
    const { url, pending } = await startAuth(s.clientId, s.redirectUri, s.scope);
    s.pendingAuth = pending;
    await this.saveSettings(); // before leaving the app: iOS may suspend Obsidian while Safari is open
    window.open(url);
  }

  private async onAuthCallback(p: ObsidianProtocolData) {
    if (p.error) {
      new Notice(`Google sign-in was cancelled or failed: ${p.error}`, 10000);
      return;
    }
    if (!p.code) {
      new Notice("Sign-in link had no code.");
      return;
    }
    await this.finishSignIn(p.code, p.state);
  }

  /** Exchange an authorization code. `state` is checked when present (the paste-code fallback has none). */
  async finishSignIn(code: string, state?: string) {
    const pending = this.settings.pendingAuth;
    if (!pending) {
      new Notice("No sign-in in progress. Press 'Sign in with Google' again.");
      return;
    }
    if (state !== undefined && state !== pending.state) {
      new Notice("Sign-in rejected: the response does not match the request (state mismatch). Try again.", 10000);
      return;
    }
    try {
      const t = await exchangeCode(this.http, {
        clientId: this.settings.clientId,
        clientSecret: this.settings.clientSecret,
        redirectUri: this.settings.redirectUri,
        code: code.trim(),
        verifier: pending.verifier,
      });
      await this.setTokens(t);
      this.settings.pendingAuth = null;
      await this.saveSettings();
      new Notice(`Signed in to Google Drive as ${this.settings.accountEmail}`);
    } catch (e) {
      this.log.error(`sign-in failed: ${errMsg(e)}`);
      new Notice(errMsg(e), 10000);
    }
  }

  /** Fallback: paste a refresh token copied from another device. */
  async useRefreshToken(refreshToken: string) {
    await this.setTokens({ accessToken: "", expiresAt: 0, refreshToken: refreshToken.trim(), scope: "" });
    try {
      await this.tokens.accessToken(true);
      new Notice(`Signed in to Google Drive as ${this.settings.accountEmail || "(unknown)"}`);
    } catch (e) {
      this.settings.tokens = null;
      await this.saveSettings();
      new Notice(`That refresh token did not work: ${errMsg(e)}`, 10000);
    }
  }

  private async setTokens(t: Tokens) {
    this.settings.tokens = t;
    await this.saveSettings();
    try {
      this.settings.accountEmail = (await this.api().about()).email;
    } catch {
      this.settings.accountEmail = "";
    }
    await this.saveSettings();
  }

  async signOut() {
    const rt = this.settings.tokens?.refreshToken;
    this.settings.tokens = null;
    this.settings.accountEmail = "";
    await this.saveSettings();
    if (rt) {
      try {
        await this.http({ url: REVOKE_ENDPOINT, method: "POST", contentType: "application/x-www-form-urlencoded", body: `token=${encodeURIComponent(rt)}` });
      } catch {
        /* best effort */
      }
    }
    new Notice("Signed out of Google Drive.");
  }

  // ---------------- folder selection ----------------

  findFolders(name: string): Promise<DriveFile[]> {
    return this.api().findFoldersByName(name);
  }

  async setFolder(id: string, name: string) {
    if (id !== this.settings.folderId) this.provider = null;
    this.settings.folderId = id;
    this.settings.folderName = name;
    await this.saveSettings();
  }

  async checkFolder(id: string): Promise<DriveFile> {
    const f = await this.api().getFile(id);
    if (!f || f.trashed) throw new Error("Folder not found with the current permission scope.");
    if (f.mimeType !== FOLDER_MIME) throw new Error(`"${f.name}" is not a folder.`);
    return f;
  }

  /** Privacy mode (drive.file): the plugin creates and owns the folder. */
  async createAppFolder(name: string): Promise<DriveFile> {
    return this.api().createFolder(name, "root");
  }

  /** Forget local sync state for the current folder (next sync behaves like a first sync: no deletions). */
  async resetSyncState() {
    if (!this.settings.folderId) return;
    await new BaseStore(this.kv, this.settings.folderId).clear();
    await this.provider?.index.reset();
    this.provider = null;
    this.log.warn("sync state reset; the next sync is treated as a first sync");
    await this.log.flush();
  }

  // ---------------- sync ----------------

  private engineDeps(): EngineDeps {
    const s = this.settings;
    if (!this.provider || this.provider.rootId !== s.folderId) {
      this.provider = new GoogleDriveProvider(this.api(), this.kv, s.folderId, (lvl, m) => (lvl === "warn" ? this.log.warn(m) : this.log.info(m)));
    }
    const filter = new IgnoreFilter({ configDir: this.app.vault.configDir, syncConfigDir: s.syncConfigDir, patterns: s.ignorePatterns });
    const localFs = new ObsidianLocalFs(this.app);
    return {
      local: localFs,
      scanLocal: () => localFs.scan({ syncConfigDir: s.syncConfigDir, skipFolder: (p) => filter.isIgnored(p, true) }),
      remote: this.provider,
      kv: this.kv,
      namespace: s.folderId,
      filter,
      log: this.log,
      options: { maxFileSize: s.maxFileSizeMB > 0 ? s.maxFileSizeMB * 1024 * 1024 : 0 },
      shouldStop: () => this.stopping,
      onProgress: (d, t) => this.updateStatus(`Syncing ${d}/${t}`),
    };
  }

  async sync(trigger: SyncTrigger) {
    const manual = trigger === "manual" || trigger === "dry-run";
    if (this.running) {
      if (manual) new Notice("A sync is already running.");
      return;
    }
    const s = this.settings;
    if (!s.clientId || !this.isSignedIn() || !s.folderId) {
      if (manual) new Notice("Google Drive sync is not set up yet: open the plugin settings.");
      return;
    }
    this.running = true;
    this.setSpinning(true);
    this.updateStatus("Syncing…");
    this.log.info(`--- ${trigger} sync started ---`);
    try {
      const deps = this.engineDeps();
      const prep = await prepare(deps);
      const counts = summarize(prep.plan);

      safetyCheck(prep);

      const review = reviewReason(prep.plan, trigger === "dry-run", s.deleteConfirmThreshold);
      if (review) {
        if (!manual) {
          // Never run a first sync or a mass deletion unattended.
          const why = review === "first-sync" ? "The first sync needs your review" : `This sync would trash ${prep.plan.actions.filter(isDeletion).length} items and needs your review`;
          this.log.warn(`${why}; automatic sync paused until you tap the sync icon`);
          if (!this.reviewNoticeShown) new Notice(`Google Drive: ${why}. Tap the sync icon to review it.`, 10000);
          this.reviewNoticeShown = true;
          return;
        }
        // Full plan in the log (capped) so it can be read later on the phone.
        const MAX_LINES = 500;
        for (const a of prep.plan.actions.slice(0, MAX_LINES)) this.log.info(`[${review}] ${JSON.stringify(a, ["kind", "path", "from", "to", "reason", "type"])}`);
        if (prep.plan.actions.length > MAX_LINES) this.log.info(`[${review}] …and ${prep.plan.actions.length - MAX_LINES} more actions`);
        this.log.info(`waiting for review (${review}): ${JSON.stringify(counts)}`);
        this.updateStatus("waiting for your review");
        await this.log.flush();
        const run = await new PlanReviewModal(this.app, prep.plan, review).ask();
        if (!run) {
          this.log.info(review === "dry-run" ? "dry run closed" : "sync cancelled by user");
          return;
        }
        this.reviewNoticeShown = false;
      }

      const res = await runPlan(deps, prep.plan);
      s.lastSyncAt = Date.now();
      await this.saveSettings();
      const msg = `Sync finished: ${res.done} change(s)` + (res.conflicts.length ? `, ${res.conflicts.length} conflict(s) left untouched` : "") + (res.skipped.length ? `, ${res.skipped.length} skipped` : "") + (res.failed.length ? `, ${res.failed.length} FAILED` : "") + (res.stopped ? " (stopped early, will resume)" : "");
      this.log.info(msg);
      const conflictKey = res.conflicts.map((c) => ("path" in c ? c.path : "")).sort().join("\n");
      const newConflicts = conflictKey !== "" && conflictKey !== this.lastConflictKey;
      this.lastConflictKey = conflictKey;
      if (manual || res.failed.length > 0 || newConflicts) new Notice(msg, 8000);
    } catch (e) {
      const m = errMsg(e);
      this.log.error(`sync aborted: ${m}`);
      if (manual || e instanceof AuthError) new Notice(`Google Drive sync failed: ${m}\nDetails: command "Show sync log".`, 12000);
    } finally {
      this.running = false;
      this.setSpinning(false);
      this.updateStatus();
      await this.log.flush();
    }
  }

  showLog() {
    new LogModal(this.app, this.log).open();
  }

  private setSpinning(on: boolean) {
    if (!this.ribbon) return;
    setIcon(this.ribbon, on ? "loader" : "refresh-cw");
    this.ribbon.toggleClass("gdvs-spinning", on);
  }

  private updateStatus(text?: string) {
    if (!this.statusBar) return;
    if (text) {
      this.statusBar.setText(`Drive: ${text}`);
      return;
    }
    const t = this.settings.lastSyncAt;
    this.statusBar.setText(t ? `Drive: synced ${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Drive: not synced yet");
  }
}
