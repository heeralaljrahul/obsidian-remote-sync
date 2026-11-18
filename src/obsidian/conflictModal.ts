import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { errMsg } from "../log";
import { cosmeticDifference, decodeText, diffLines, sideBySide, splitLines, toHunks, type DiffOp } from "../sync/diff";
import { formatBytes } from "../sync/planView";
import type { ConflictItem, Resolution } from "../sync/resolve";

export interface ConflictHandlers {
  readLocal(path: string): Promise<ArrayBuffer>;
  readRemote(id: string): Promise<ArrayBuffer>;
  /** Applies the choice; resolves to a message for the user. Throws if it couldn't be applied. */
  resolve(c: ConflictItem, choice: Resolution): Promise<string>;
}

/** Text files bigger than this are not diffed (memory/time on phones). */
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_RENDERED_LINES = 4000;

const when = (t: number) => (t > 0 ? new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "?");

/**
 * Conflict resolution: a list of conflicting files, then a per-file view with a
 * unified diff (side-by-side optional on wide screens) and three choices.
 */
export class ConflictModal extends Modal {
  private done = new Map<string, string>();
  private view: "unified" | "split";

  constructor(
    app: App,
    private readonly items: ConflictItem[],
    private readonly h: ConflictHandlers
  ) {
    super(app);
    this.view = !Platform.isMobile && window.innerWidth >= 900 ? "split" : "unified";
  }

  onOpen() {
    this.modalEl.addClass("gdvs-modal", "gdvs-conflict-modal");
    this.renderList();
  }

  onClose() {
    this.contentEl.empty();
  }

  // ---------- list ----------

  private renderList() {
    const { contentEl } = this;
    contentEl.empty();
    const open = this.items.filter((c) => !this.done.has(c.path));
    this.titleEl.setText(open.length ? `Sync conflicts (${open.length})` : "All conflicts resolved");
    contentEl.createEl("p", {
      text: "These files were changed on this device and in Google Drive since the last sync, so the plugin left both versions alone. Review each one and choose which version to keep. Nothing is deleted permanently.",
    });

    for (const c of this.items) {
      const result = this.done.get(c.path);
      const s = new Setting(contentEl).setName(c.path);
      if (result) {
        s.setDesc(`✓ ${result}`);
        s.settingEl.addClass("gdvs-resolved");
        continue;
      }
      s.setDesc(
        `${c.type === "both-modified" ? "Edited on both sides" : "Different versions on both sides"} · ` +
          `this device ${formatBytes(c.local.size)}, ${when(c.local.mtime)} · Drive ${formatBytes(c.remote.size)}, ${when(c.remote.modifiedTime)}`
      );
      s.addButton((b) =>
        b
          .setButtonText("Review")
          .setCta()
          .onClick(() => void this.renderDetail(c))
      );
    }

    const footer = new Setting(contentEl);
    if (open.length > 1) {
      footer.addButton((b) =>
        b.setButtonText(`Keep both for all ${open.length}`).onClick(async () => {
          b.setDisabled(true);
          for (const c of open) await this.apply(c, "keep-both", false);
          this.renderList();
        })
      );
    }
    footer.addButton((b) => b.setButtonText(open.length ? "Decide later" : "Close").onClick(() => this.close()));
  }

  // ---------- one file ----------

  private async renderDetail(c: ConflictItem) {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(c.path);
    const status = contentEl.createEl("p", { text: "Loading both versions…", cls: "gdvs-detail" });

    let localText: string | null = null;
    let remoteText: string | null = null;
    try {
      if (c.local.size <= MAX_DIFF_BYTES && c.remote.size <= MAX_DIFF_BYTES) {
        const [l, r] = await Promise.all([this.h.readLocal(c.path), this.h.readRemote(c.remote.id)]);
        localText = decodeText(c.path, l);
        remoteText = decodeText(c.path, r);
      }
      status.remove();
    } catch (e) {
      status.setText(`Could not load the versions: ${errMsg(e)}`);
    }

    const meta = contentEl.createDiv({ cls: "gdvs-conflict-meta" });
    const mk = (cls: string, label: string, size: number, t: number) => {
      const d = meta.createDiv({ cls: `gdvs-side ${cls}` });
      d.createEl("strong", { text: label });
      d.createDiv({ text: `${formatBytes(size)} · modified ${when(t)}`, cls: "gdvs-detail" });
    };
    mk("gdvs-side-remote", "− Google Drive version", c.remote.size, c.remote.modifiedTime);
    mk("gdvs-side-local", "+ This device's version", c.local.size, c.local.mtime);

    if (localText === null || remoteText === null) {
      contentEl.createEl("p", {
        text:
          c.local.size > MAX_DIFF_BYTES || c.remote.size > MAX_DIFF_BYTES
            ? "This file is too large to compare here. Compare the sizes and dates above, or choose 'Keep both' and compare the two files yourself."
            : "This isn't a text file, so there's no line-by-line comparison. Compare the sizes and dates above, or choose 'Keep both'.",
      });
    } else {
      const cosmetic = cosmeticDifference(remoteText, localText);
      if (cosmetic) contentEl.createEl("p", { text: `${cosmetic} Either choice is safe.`, cls: "gdvs-callout" });
      const ops = diffLines(splitLines(remoteText), splitLines(localText));
      if (!Platform.isMobile) {
        new Setting(contentEl).setName("View").addDropdown((d) =>
          d
            .addOption("unified", "Unified")
            .addOption("split", "Side by side")
            .setValue(this.view)
            .onChange((v) => {
              this.view = v as "unified" | "split";
              diffEl.empty();
              this.renderDiff(diffEl, ops);
            })
        );
      }
      const diffEl = contentEl.createDiv({ cls: "gdvs-diff" });
      this.renderDiff(diffEl, ops);
    }

    const choices: Array<[Resolution, string, string, boolean]> = [
      ["keep-local", "Keep this device's version", "Replaces the Drive version (Drive keeps the old one in its version history).", false],
      ["keep-remote", "Keep the Drive version", "Replaces this device's version (it is moved to the vault's .trash).", false],
      ["keep-both", "Keep both", 'The Drive version keeps the name; this device\'s version is saved as "… (conflict date).ext".', true],
    ];
    for (const [choice, label, desc, cta] of choices) {
      new Setting(contentEl)
        .setName(label)
        .setDesc(desc)
        .addButton((b) => {
          b.setButtonText(label.replace(/'s version$/, "")).onClick(async () => {
            b.setDisabled(true);
            const ok = await this.apply(c, choice, true);
            if (ok) this.renderList();
            else b.setDisabled(false);
          });
          if (cta) b.setCta();
        });
    }
    new Setting(contentEl).addButton((b) => b.setButtonText("← Back to the list").onClick(() => this.renderList()));
  }

  private async apply(c: ConflictItem, choice: Resolution, notify: boolean): Promise<boolean> {
    try {
      const msg = await this.h.resolve(c, choice);
      this.done.set(c.path, msg);
      if (notify) new Notice(msg, 6000);
      return true;
    } catch (e) {
      new Notice(`${c.path}: ${errMsg(e)}`, 10000);
      return false;
    }
  }

  private renderDiff(el: HTMLElement, ops: DiffOp[]) {
    const hunks = toHunks(ops, 3);
    if (hunks.length === 0) {
      el.createDiv({ text: "No line differences.", cls: "gdvs-detail" });
      return;
    }
    let rendered = 0;
    for (const h of hunks) {
      if (rendered > MAX_RENDERED_LINES) {
        el.createDiv({ text: "…more differences not shown", cls: "gdvs-detail" });
        break;
      }
      el.createDiv({ cls: "gdvs-hunk-head", text: `Lines ${h.bStart}–${h.bStart + Math.max(h.bLen - 1, 0)} on this device` });
      if (this.view === "split") {
        const table = el.createDiv({ cls: "gdvs-split" });
        for (const row of sideBySide(h.ops)) {
          const cell = (side: "left" | "right") => {
            const v = row[side];
            const d = table.createDiv({ cls: `gdvs-cell ${v?.changed ? (side === "left" ? "gdvs-del" : "gdvs-add") : ""} ${v ? "" : "gdvs-empty"}` });
            if (v) {
              d.createSpan({ cls: "gdvs-ln", text: String(v.n) });
              d.createSpan({ cls: "gdvs-code", text: v.text || " " });
            }
          };
          cell("left");
          cell("right");
          rendered++;
        }
      } else {
        for (const o of h.ops) {
          const row = el.createDiv({ cls: `gdvs-line ${o.t === "del" ? "gdvs-del" : o.t === "add" ? "gdvs-add" : ""}` });
          row.createSpan({ cls: "gdvs-sign", text: o.t === "del" ? "−" : o.t === "add" ? "+" : " " });
          row.createSpan({ cls: "gdvs-code", text: o.text || " " });
          rendered++;
        }
      }
    }
  }
}
