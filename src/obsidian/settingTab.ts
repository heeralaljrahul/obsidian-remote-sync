import { App, Modal, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type { DriveFile } from "../gdrive/driveApi";
import { errMsg } from "../log";
import type GDriveSyncPlugin from "../main";
import { DEFAULT_REDIRECT_URI, parseFolderId } from "../settings";
import { DEFAULT_IGNORE_PATTERNS } from "../sync/ignore";

class FolderPickModal extends Modal {
  constructor(app: App, private readonly folders: DriveFile[], private readonly onPick: (f: DriveFile) => void) {
    super(app);
  }
  onOpen() {
    this.titleEl.setText("Pick your vault folder");
    if (this.folders.length === 0) {
      this.contentEl.createEl("p", { text: "No folder with that name was found." });
      return;
    }
    for (const f of this.folders) {
      new Setting(this.contentEl)
        .setName(f.name)
        .setDesc(`ID ${f.id} · created ${f.createdTime?.slice(0, 10) ?? "?"} · modified ${f.modifiedTime?.slice(0, 10) ?? "?"}`)
        .addButton((b) =>
          b
            .setButtonText("Use this folder")
            .setCta()
            .onClick(() => {
              this.onPick(f);
              this.close();
            })
        );
    }
  }
  onClose() {
    this.contentEl.empty();
  }
}

export class GDriveSettingTab extends PluginSettingTab {
  private folderSearch = "";
  private pastedCode = "";
  private pastedRefresh = "";
  private newFolderName = "Obsidian Vault";

  constructor(app: App, private readonly plugin: GDriveSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    const save = () => p.saveSettings();
    containerEl.empty();

    containerEl.createEl("p", {
      text: "Sync only runs while Obsidian is open. iOS does not let plugins sync in the background, so on iPhone/iPad sync happens when you open or return to Obsidian, on the interval below, or when you tap the sync icon.",
      cls: "gdvs-callout",
    });

    // ---------- Google account ----------
    new Setting(containerEl).setName("Google account").setHeading();
    new Setting(containerEl)
      .setName("OAuth client ID")
      .setDesc("From your own Google Cloud project (see SETUP.md). Stored only on this device.")
      .addText((t) =>
        t.setPlaceholder("xxxx.apps.googleusercontent.com").setValue(s.clientId).onChange(async (v) => {
          s.clientId = v.trim();
          await save();
        })
      );
    new Setting(containerEl)
      .setName("OAuth client secret")
      .setDesc("Required by Google for Web clients. Stored only in this device's plugin data.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(s.clientSecret).onChange(async (v) => {
          s.clientSecret = v.trim();
          await save();
        });
      });
    new Setting(containerEl)
      .setName("Redirect URI")
      .setDesc("The GitHub Pages callback page. Must exactly match an Authorized redirect URI of your OAuth client.")
      .addText((t) =>
        t.setPlaceholder(DEFAULT_REDIRECT_URI).setValue(s.redirectUri).onChange(async (v) => {
          s.redirectUri = v.trim() || DEFAULT_REDIRECT_URI;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Permission scope")
      .setDesc(
        "Full Drive access is needed to sync a folder you created outside this plugin. 'Privacy mode' (drive.file) only lets the plugin see files it created itself, so it must create its own folder and do a first full upload from your PC. Changing this requires signing in again."
      )
      .addDropdown((d) =>
        d
          .addOption("drive", "Full Drive (works with your existing folder)")
          .addOption("drive.file", "Privacy mode: only files this plugin created")
          .setValue(s.scope)
          .onChange(async (v) => {
            s.scope = v as typeof s.scope;
            await save();
            this.display();
          })
      );

    const signedIn = p.isSignedIn();
    const days = p.signInExpiresInDays();
    const since = s.tokens?.issuedAt ? ` Signed in on ${new Date(s.tokens.issuedAt).toLocaleDateString()}.` : "";
    const signInDesc = !signedIn
      ? "Opens Google in your browser. After you approve, the callback page sends you back to Obsidian."
      : days !== null
        ? `⚠️ Google says this sign-in expires in ${Math.max(0, Math.round(days))} day(s). Publish your Google Cloud app to "In production" (SETUP.md step 3), then sign out and in again to get a sign-in that doesn't expire.`
        : `No expiry. It keeps working as long as this device syncs at least once every 6 months and you don't revoke access.${since} If it ever stops after about 7 days, your Google Cloud app is still in "Testing" (see SETUP.md step 3).`;
    new Setting(containerEl)
      .setName(signedIn ? `Signed in${s.accountEmail ? ` as ${s.accountEmail}` : ""}` : "Not signed in")
      .setDesc(signInDesc)
      .addButton((b) =>
        signedIn
          ? b.setButtonText("Sign out").onClick(async () => {
              await p.signOut();
              this.display();
            })
          : b
              .setButtonText("Sign in with Google")
              .setCta()
              .onClick(() => void p.startSignIn())
      );

    if (!signedIn) {
      new Setting(containerEl)
        .setName("Paste authorization code")
        .setDesc("If the browser didn't jump back to Obsidian, copy the code shown on the callback page and paste it here (same device, right after signing in).")
        .addText((t) => t.setPlaceholder("4/0A…").onChange((v) => (this.pastedCode = v)))
        .addButton((b) =>
          b.setButtonText("Use code").onClick(async () => {
            if (!this.pastedCode.trim()) return;
            await p.finishSignIn(this.pastedCode);
            this.display();
          })
        );
      new Setting(containerEl)
        .setName("Paste refresh token")
        .setDesc("Fallback: sign in on your PC, use 'Copy refresh token' there, and paste it here. Uses the same client ID/secret.")
        .addText((t) => {
          t.inputEl.type = "password";
          t.onChange((v) => (this.pastedRefresh = v));
        })
        .addButton((b) =>
          b.setButtonText("Save").onClick(async () => {
            if (!this.pastedRefresh.trim()) return;
            await p.useRefreshToken(this.pastedRefresh);
            this.display();
          })
        );
    } else {
      new Setting(containerEl)
        .setName("Copy refresh token")
        .setDesc("To sign in on your phone without the browser flow. Treat it like a password: anyone with it (and your client secret) can access your Drive. Paste it only into this plugin.")
        .addButton((b) =>
          b.setButtonText("Copy").onClick(async () => {
            await navigator.clipboard.writeText(s.tokens?.refreshToken ?? "");
            new Notice("Refresh token copied. Clear your clipboard after pasting it.");
          })
        );
    }

    // ---------- Vault folder ----------
    new Setting(containerEl).setName("Drive vault folder").setHeading();
    new Setting(containerEl)
      .setName("Current folder")
      .setDesc(s.folderId ? `${s.folderName || "(name unknown)"} — ID ${s.folderId}` : "None selected yet.");
    new Setting(containerEl)
      .setName("Folder ID or link")
      .setDesc("Paste the folder's ID or its Drive URL (drive.google.com/drive/folders/<ID>).")
      .addText((t) => t.setPlaceholder("1AbC…").onChange((v) => (this.folderSearch = v)))
      .addButton((b) =>
        b.setButtonText("Use ID").onClick(async () => {
          const id = parseFolderId(this.folderSearch);
          if (!id) return;
          try {
            const f = await p.checkFolder(id);
            await p.setFolder(f.id, f.name);
            new Notice(`Vault folder set to "${f.name}"`);
          } catch (e) {
            new Notice(errMsg(e), 8000);
          }
          this.display();
        })
      )
      .addButton((b) =>
        b.setButtonText("Find by name").onClick(async () => {
          const name = this.folderSearch.trim();
          if (!name) return;
          try {
            const found = await p.findFolders(name);
            new FolderPickModal(this.app, found, async (f) => {
              await p.setFolder(f.id, f.name);
              this.display();
            }).open();
          } catch (e) {
            new Notice(errMsg(e), 8000);
          }
        })
      );
    if (s.scope === "drive.file") {
      new Setting(containerEl)
        .setName("Create a new vault folder (privacy mode)")
        .setDesc("Creates a folder in My Drive that this plugin owns. Do the first sync from your PC so it uploads the whole vault.")
        .addText((t) => t.setValue(this.newFolderName).onChange((v) => (this.newFolderName = v)))
        .addButton((b) =>
          b.setButtonText("Create").onClick(async () => {
            try {
              const f = await p.createAppFolder(this.newFolderName.trim() || "Obsidian Vault");
              await p.setFolder(f.id, f.name);
              new Notice(`Created "${f.name}". Use the same folder ID on your other devices.`);
            } catch (e) {
              new Notice(errMsg(e), 8000);
            }
            this.display();
          })
        );
    }

    // ---------- When to sync ----------
    new Setting(containerEl).setName("When to sync").setHeading();
    new Setting(containerEl).setName("Sync when Obsidian opens").addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await save();
      })
    );
    new Setting(containerEl)
      .setName("Sync when returning to Obsidian")
      .setDesc(Platform.isMobile ? "Runs when you switch back to Obsidian on your phone/iPad (at most once a minute)." : "Runs when the Obsidian window becomes visible again (at most once a minute).")
      .addToggle((t) =>
        t.setValue(s.syncOnResume).onChange(async (v) => {
          s.syncOnResume = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Sync when leaving Obsidian")
      .setDesc("If you edited something since the last sync, start a sync when you switch away from Obsidian. On iPhone/iPad there are only a few seconds before iOS pauses the app; anything not finished continues next time.")
      .addToggle((t) =>
        t.setValue(s.syncOnLeave).onChange(async (v) => {
          s.syncOnLeave = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Sync after you stop editing (seconds)")
      .setDesc("0 = off. E.g. 60 syncs one minute after your last change, so edits reach Drive while Obsidian is still open.")
      .addText((t) =>
        t.setValue(String(s.syncAfterEditSeconds)).onChange(async (v) => {
          const n = Math.floor(Number(v));
          s.syncAfterEditSeconds = Number.isFinite(n) && n > 0 ? Math.max(10, n) : 0;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Sync every N minutes")
      .setDesc("0 = off. Only while Obsidian is open and in the foreground.")
      .addText((t) =>
        t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
          const n = Math.max(0, Math.floor(Number(v) || 0));
          s.intervalMinutes = n;
          await save();
          p.resetInterval();
        })
      );

    // ---------- What to sync ----------
    new Setting(containerEl).setName("What to sync").setHeading();
    new Setting(containerEl)
      .setName(`Sync the ${this.app.vault.configDir} folder`)
      .setDesc("Settings, themes and plugins. Off by default. This plugin's own folder (with your tokens) is never synced.")
      .addToggle((t) =>
        t.setValue(s.syncConfigDir).onChange(async (v) => {
          s.syncConfigDir = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Ignore list")
      .setDesc("Files/folders to leave alone on both sides. Ignoring something never deletes it.")
      .addTextArea((t) => {
        t.inputEl.rows = 8;
        t.inputEl.addClass("gdvs-ignore");
        t.setValue(s.ignorePatterns).onChange(async (v) => {
          s.ignorePatterns = v;
          await save();
        });
      })
      .addExtraButton((b) =>
        b
          .setIcon("reset")
          .setTooltip("Restore defaults")
          .onClick(async () => {
            s.ignorePatterns = DEFAULT_IGNORE_PATTERNS;
            await save();
            this.display();
          })
      );
    new Setting(containerEl)
      .setName("Skip files larger than (MB)")
      .setDesc("0 = no limit. Large files use a lot of memory on a phone.")
      .addText((t) =>
        t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
          s.maxFileSizeMB = Math.max(0, Number(v) || 0);
          await save();
        })
      );

    // ---------- Safety & troubleshooting ----------
    new Setting(containerEl).setName("Safety and troubleshooting").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Deleted files are never removed permanently: they go to this vault's .trash folder or to Google Drive's trash. The first sync with a folder always shows a dry run for you to approve, and never deletes anything.",
    });
    new Setting(containerEl)
      .setName("Ask before trashing more than")
      .setDesc("If one sync would move more than this many files/folders to the trash, it waits for your confirmation (automatic syncs pause until you tap the sync icon).")
      .addText((t) =>
        t.setValue(String(s.deleteConfirmThreshold)).onChange(async (v) => {
          const n = Math.floor(Number(v));
          s.deleteConfirmThreshold = Number.isFinite(n) && n >= 0 ? n : 20;
          await save();
        })
      );
    new Setting(containerEl)
      .setName("Dry run")
      .setDesc("Show what a sync would upload, download and trash, without changing anything.")
      .addButton((b) => b.setButtonText("Dry run").onClick(() => void p.sync("dry-run")));
    new Setting(containerEl)
      .setName("Sync log")
      .setDesc("What happened during recent syncs: useful when something looks wrong on your phone.")
      .addButton((b) => b.setButtonText("View log").onClick(() => p.showLog()));

    // ---------- Advanced ----------
    new Setting(containerEl).setName("Advanced").setHeading();
    new Setting(containerEl)
      .setName("Reset sync state")
      .setDesc("Forget what was synced before on this device. The next sync behaves like a first sync: it compares both sides and never deletes anything.")
      .addButton((b) =>
        b
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            await p.resetSyncState();
            new Notice("Sync state reset.");
          })
      );
  }
}
