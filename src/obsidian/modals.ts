import { App, Modal, Notice, Setting } from "obsidian";
import type { LogEntry, SyncLog } from "../log";
import { countChanges, planSections, type ReviewReason } from "../sync/planView";
import type { SyncPlan } from "../sync/types";

/** Long lists are cut so the modal stays fast on a phone; the full plan is in the sync log. */
const MAX_ITEMS_PER_SECTION = 300;

const INTRO: Record<ReviewReason, string> = {
  "dry-run": "Dry run: nothing has been changed. This is what a sync would do right now.",
  "first-sync":
    "This is the first sync with this Drive folder on this device, so here is a dry run first. Nothing has been changed yet. The first sync never deletes anything: files that differ on both sides are listed as conflicts, and after the sync you choose which version to keep for each.",
  "many-deletions":
    "This sync would move many files to the trash. Check the list before continuing (trashed files can be restored from the vault's .trash folder and from Google Drive's trash).",
};

/** Shows a planned sync; resolves true if the user chose to run it. */
export class PlanReviewModal extends Modal {
  private resolve!: (run: boolean) => void;
  private decided = false;

  constructor(
    app: App,
    private readonly plan: SyncPlan,
    private readonly reason: ReviewReason
  ) {
    super(app);
  }

  /** Open the modal and wait for the user's choice. */
  ask(): Promise<boolean> {
    return new Promise((res) => {
      this.resolve = res;
      this.open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("gdvs-modal");
    this.titleEl.setText(this.reason === "first-sync" ? "Review your first sync" : this.reason === "dry-run" ? "Dry run" : "Confirm deletions");
    contentEl.createEl("p", { text: INTRO[this.reason] });

    const changes = countChanges(this.plan);
    const sections = planSections(this.plan);
    const summary = contentEl.createDiv({ cls: "gdvs-summary" });
    if (sections.length === 0) summary.setText("Everything is already in sync.");
    for (const s of sections) {
      summary.createSpan({ cls: s.warn ? "gdvs-chip gdvs-warn" : "gdvs-chip", text: `${s.title.replace(/ \(.*\)/, "")}: ${s.items.length}` });
    }

    for (const s of sections) {
      const d = contentEl.createEl("details", { cls: "gdvs-section" });
      if (s.warn || s.key === "upload" || s.key === "download") d.open = s.items.length <= 50 || s.warn;
      d.createEl("summary", { text: `${s.title} (${s.items.length})`, cls: s.warn ? "gdvs-warn" : "" });
      const ul = d.createEl("ul", { cls: "gdvs-list" });
      for (const it of s.items.slice(0, MAX_ITEMS_PER_SECTION)) {
        const li = ul.createEl("li");
        li.createDiv({ text: it.label, cls: "gdvs-path" });
        if (it.detail) li.createDiv({ text: it.detail, cls: "gdvs-detail" });
      }
      if (s.items.length > MAX_ITEMS_PER_SECTION) {
        ul.createEl("li", { text: `…and ${s.items.length - MAX_ITEMS_PER_SECTION} more (see the sync log)`, cls: "gdvs-detail" });
      }
    }

    const buttons = new Setting(contentEl);
    buttons.addButton((b) => b.setButtonText(this.reason === "dry-run" ? "Close" : "Cancel").onClick(() => this.finish(false)));
    if (changes > 0 || this.plan.firstSync) {
      buttons.addButton((b) =>
        b
          .setButtonText(this.reason === "first-sync" ? "Run first sync" : this.reason === "many-deletions" ? "Yes, sync and trash these" : "Run this sync now")
          .setCta()
          .onClick(() => this.finish(true))
      );
    }
  }

  private finish(run: boolean) {
    this.decided = true;
    this.resolve(run);
    this.close();
  }

  onClose() {
    if (!this.decided) this.resolve(false);
    this.contentEl.empty();
  }
}

/** Sync log viewer, readable on a phone, with copy for sharing when troubleshooting. */
export class LogModal extends Modal {
  private onlyProblems = false;

  constructor(
    app: App,
    private readonly log: SyncLog
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass("gdvs-modal");
    this.titleEl.setText("Google Drive sync log");
    this.render();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();
    const all = this.log.all();
    const entries = (this.onlyProblems ? all.filter((e) => e.level !== "info") : all).slice().reverse();

    new Setting(contentEl)
      .setName("Only warnings and errors")
      .addToggle((t) =>
        t.setValue(this.onlyProblems).onChange((v) => {
          this.onlyProblems = v;
          this.render();
        })
      )
      .addButton((b) =>
        b.setButtonText("Copy").onClick(async () => {
          await navigator.clipboard.writeText(all.map(formatLine).join("\n"));
          new Notice("Sync log copied");
        })
      )
      .addButton((b) =>
        b
          .setButtonText("Clear")
          .setWarning()
          .onClick(async () => {
            await this.log.clear();
            this.render();
          })
      );

    if (entries.length === 0) {
      contentEl.createEl("p", { text: "The log is empty." });
      return;
    }
    const list = contentEl.createDiv({ cls: "gdvs-log" });
    for (const e of entries.slice(0, 1000)) {
      const row = list.createDiv({ cls: `gdvs-log-row gdvs-${e.level}` });
      row.createSpan({ cls: "gdvs-log-time", text: new Date(e.t).toLocaleString() });
      row.createSpan({ cls: "gdvs-log-msg", text: e.msg });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

function formatLine(e: LogEntry): string {
  return `${new Date(e.t).toISOString()} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
}
