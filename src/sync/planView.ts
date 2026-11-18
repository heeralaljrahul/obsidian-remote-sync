/** Turns a SyncPlan into human-readable sections (used by the review modal and the log). Pure: no Obsidian imports. */
import { isDeletion } from "./planner";
import type { Action, SyncPlan } from "./types";

export interface PlanItem {
  label: string;
  detail?: string;
}

export interface PlanSection {
  key: string;
  title: string;
  /** visually highlighted (deletions, conflicts) */
  warn: boolean;
  items: PlanItem[];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const REASON: Record<string, string> = {
  new: "new",
  modified: "changed",
  restore: "deleted on the other side but edited here, so it is kept",
};

function item(a: Action): PlanItem {
  switch (a.kind) {
    case "upload":
      return { label: a.path, detail: `${REASON[a.reason]} · ${formatBytes(a.local.size)}` };
    case "download":
      return { label: a.path, detail: `${a.reason === "restore" ? "deleted here but edited in Drive, so it is restored" : REASON[a.reason]} · ${formatBytes(a.remote.size)}` };
    case "trashLocal":
      return { label: a.path, detail: "deleted in Drive → moved to this vault's .trash" };
    case "trashRemote":
      return { label: a.path, detail: "deleted here → moved to Google Drive trash" };
    case "trashLocalFolder":
      return { label: `${a.path}/`, detail: "empty folder, deleted in Drive → .trash" };
    case "trashRemoteFolder":
      return { label: `${a.path}/`, detail: "empty folder, deleted here → Drive trash" };
    case "moveLocal":
      return { label: `${a.from} → ${a.to}`, detail: "renamed in Drive" };
    case "moveRemote":
      return { label: `${a.from} → ${a.to}`, detail: "renamed here" };
    case "conflict":
      return {
        label: a.path,
        detail: `${a.type === "both-modified" ? "edited on both sides" : "exists on both sides with different content"} · here ${formatBytes(a.local.size)}, Drive ${formatBytes(a.remote.size)}`,
      };
    case "skip":
      return { label: a.path, detail: a.reason };
    case "mkdirLocal":
      return { label: `${a.path}/`, detail: "create folder here" };
    case "mkdirRemote":
      return { label: `${a.path}/`, detail: "create folder in Drive" };
    case "adopt":
      return { label: a.path, detail: "identical on both sides" };
    case "adoptFolder":
      return { label: `${a.path}/`, detail: "exists on both sides" };
    case "forget":
      return { label: a.path, detail: "gone on both sides" };
  }
}

const SECTIONS: Array<{ key: string; title: string; warn: boolean; match: (a: Action) => boolean }> = [
  { key: "conflict", title: "Conflicts (left untouched)", warn: true, match: (a) => a.kind === "conflict" },
  { key: "delete", title: "Deletions (to trash)", warn: true, match: isDeletion },
  { key: "upload", title: "Uploads to Drive", warn: false, match: (a) => a.kind === "upload" },
  { key: "download", title: "Downloads from Drive", warn: false, match: (a) => a.kind === "download" },
  { key: "move", title: "Renames / moves", warn: false, match: (a) => a.kind === "moveLocal" || a.kind === "moveRemote" },
  { key: "skip", title: "Skipped", warn: false, match: (a) => a.kind === "skip" },
  { key: "folder", title: "New folders", warn: false, match: (a) => a.kind === "mkdirLocal" || a.kind === "mkdirRemote" },
  { key: "bookkeeping", title: "Already in sync (bookkeeping only)", warn: false, match: (a) => a.kind === "adopt" || a.kind === "adoptFolder" || a.kind === "forget" },
];

export function planSections(plan: SyncPlan): PlanSection[] {
  return SECTIONS.map((s) => ({
    key: s.key,
    title: s.title,
    warn: s.warn,
    items: plan.actions.filter(s.match).map(item),
  })).filter((s) => s.items.length > 0);
}

/** Actions that actually change something on either side. */
export function countChanges(plan: SyncPlan): number {
  return plan.actions.filter((a) => !["adopt", "adoptFolder", "forget", "skip", "conflict"].includes(a.kind)).length;
}

export type ReviewReason = "dry-run" | "first-sync" | "many-deletions";

/**
 * Does this plan need a human to look at it before running?
 *  - always for an explicit dry run
 *  - always for the first sync with a folder (also after "reset sync state")
 *  - when it would trash more than `deleteThreshold` files/folders
 */
export function reviewReason(plan: SyncPlan, isDryRun: boolean, deleteThreshold: number): ReviewReason | null {
  if (isDryRun) return "dry-run";
  if (plan.firstSync) return "first-sync";
  if (deleteThreshold >= 0 && plan.actions.filter(isDeletion).length > deleteThreshold) return "many-deletions";
  return null;
}
