import type { PendingAuth, ScopeMode, Tokens } from "./gdrive/oauth";
import { DEFAULT_IGNORE_PATTERNS } from "./sync/ignore";

/**
 * Stored in this plugin's data.json (per device, never synced: the plugin's own
 * folder is hard-excluded from sync because it contains your OAuth secret and
 * tokens). Nothing here is hard-coded or committed.
 */
export interface GDriveSettings {
  clientId: string;
  clientSecret: string;
  /** The GitHub Pages callback page that forwards Google's redirect into Obsidian. */
  redirectUri: string;
  scope: ScopeMode;
  tokens: Tokens | null;
  /** PKCE verifier + state while the browser sign-in is open (survives iOS suspending Obsidian). */
  pendingAuth: PendingAuth | null;
  accountEmail: string;

  folderId: string;
  folderName: string;

  syncOnStartup: boolean;
  syncOnResume: boolean;
  /** 0 = off */
  intervalMinutes: number;
  /** Sync this many seconds after your last edit. 0 = off. */
  syncAfterEditSeconds: number;
  /** When Obsidian goes to the background with unsynced edits, start a sync. */
  syncOnLeave: boolean;

  syncConfigDir: boolean;
  ignorePatterns: string;
  /** 0 = no limit */
  maxFileSizeMB: number;
  /** Ask before a sync trashes more than this many files/folders. */
  deleteConfirmThreshold: number;

  /** Random ID for this installation; names the local IndexedDB store. */
  installId: string;
  lastSyncAt: number;
}

export const DEFAULT_REDIRECT_URI = "https://heeralaljrahul.github.io/obsidian-remote-sync/callback/";

export const DEFAULT_SETTINGS: GDriveSettings = {
  clientId: "",
  clientSecret: "",
  redirectUri: DEFAULT_REDIRECT_URI,
  scope: "drive",
  tokens: null,
  pendingAuth: null,
  accountEmail: "",
  folderId: "",
  folderName: "",
  syncOnStartup: true,
  syncOnResume: true,
  intervalMinutes: 0,
  syncAfterEditSeconds: 0,
  syncOnLeave: true,
  syncConfigDir: false,
  ignorePatterns: DEFAULT_IGNORE_PATTERNS,
  maxFileSizeMB: 200,
  deleteConfirmThreshold: 20,
  installId: "",
  lastSyncAt: 0,
};

/** Accept a bare folder ID or a pasted Drive folder URL. */
export function parseFolderId(input: string): string {
  const s = input.trim();
  const m = /\/folders\/([A-Za-z0-9_-]+)/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]+)/.exec(s);
  return m ? m[1] : s;
}
