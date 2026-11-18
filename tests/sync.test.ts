/**
 * End-to-end sync scenarios: the real planner, executor, DriveApi, RemoteIndex
 * and GoogleDriveProvider, against an in-memory fake Google Drive and
 * in-memory vaults ("devices").
 */
import { expect } from "chai";
import { isDeletion, pathOf } from "../src/sync/planner";
import { Device, kinds, MemVault } from "./helpers/device";
import { FakeDrive, FOLDER_MIME } from "./helpers/fakeDrive";

describe("sync scenarios (mock Google Drive)", () => {
  let drive: FakeDrive;
  let pc: Device;

  beforeEach(() => {
    drive = new FakeDrive();
    pc = new Device(drive);
  });

  describe("first sync where both sides already have files", () => {
    beforeEach(() => {
      drive.addFile("Daily/2025-01-01.md", "same text");
      drive.addFile("Ideas.md", "drive version");
      drive.addFile("Only in Drive.md", "from drive");
      drive.addFile("img/photo.png", new Uint8Array([1, 2, 3, 255]), "image/png");
      pc.vault.put("Daily/2025-01-01.md", "same text");
      pc.vault.put("Ideas.md", "local version");
      pc.vault.put("Only on PC.md", "from pc");
    });

    it("is flagged as a first sync and plans no deletions at all", async () => {
      const prep = await pc.plan();
      expect(prep.plan.firstSync).to.equal(true);
      expect(prep.plan.actions.filter(isDeletion)).to.deep.equal([]);
    });

    it("adopts identical files, copies one-sided files both ways, leaves differing files as conflicts", async () => {
      const { prep, res } = await pc.sync();
      expect(kinds(prep)).to.include.members([
        "adopt:Daily/2025-01-01.md",
        "conflict:Ideas.md",
        "download:Only in Drive.md",
        "download:img/photo.png",
        "upload:Only on PC.md",
      ]);
      expect(res.failed).to.deep.equal([]);
      expect(pc.vault.text("Ideas.md")).to.equal("local version");
      expect(drive.read("Ideas.md")).to.equal("drive version");
      expect(pc.vault.text("Only in Drive.md")).to.equal("from drive");
      expect([...pc.vault.files.get("img/photo.png")!.data]).to.deep.equal([1, 2, 3, 255]);
      expect(drive.read("Only on PC.md")).to.equal("from pc");
      expect(drive.countAt("Daily/2025-01-01.md")).to.equal(1, "identical file must not be uploaded again");
      expect(pc.vault.trashed).to.deep.equal([]);
      expect(drive.trashedNames()).to.deep.equal([]);
    });

    it("a second sync with no changes does nothing except report the open conflict", async () => {
      await pc.sync();
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["conflict:Ideas.md"]);
    });

    it("an empty vault + full Drive downloads everything (fresh phone)", async () => {
      const phone = new Device(drive);
      const { res } = await phone.sync();
      expect(res.failed).to.deep.equal([]);
      expect(phone.vault.text("Ideas.md")).to.equal("drive version");
      expect(phone.vault.files.size).to.equal(4);
    });
  });

  describe("after an initial sync", () => {
    beforeEach(async () => {
      pc.vault.put("a.md", "A1");
      pc.vault.put("b.md", "B1");
      pc.vault.put("notes/c.md", "C1");
      drive.addFile("d.md", "D1");
      await pc.sync();
    });

    it("new files on both sides are copied across", async () => {
      pc.vault.put("new-local.md", "L");
      drive.addFile("new-remote.md", "R");
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["download:new-remote.md", "upload:new-local.md"]);
      expect(drive.read("new-local.md")).to.equal("L");
      expect(pc.vault.text("new-remote.md")).to.equal("R");
    });

    it("edits on either side propagate, and Drive updates keep the same file ID (revision history)", async () => {
      const idA = drive.idAt("a.md");
      pc.vault.put("a.md", "A2");
      drive.edit("b.md", "B2");
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["download:b.md", "upload:a.md"]);
      expect(drive.read("a.md")).to.equal("A2");
      expect(drive.idAt("a.md")).to.equal(idA);
      expect(pc.vault.text("b.md")).to.equal("B2");
    });

    it("a local mtime change without a content change does not upload", async () => {
      const f = pc.vault.files.get("a.md")!;
      f.mtime = MemVault.tick();
      drive.requests = [];
      const { prep } = await pc.sync();
      expect(prep.plan.actions.map((a) => a.kind)).to.deep.equal(["adopt"]);
      expect(drive.requests.filter((r) => r.url.includes("/upload/"))).to.have.length(0);
    });

    it("deleting locally moves the Drive file to Drive trash (not a permanent delete)", async () => {
      pc.vault.remove("a.md");
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["trashRemote:a.md"]);
      expect(drive.trashedNames()).to.deep.equal(["a.md"]);
      expect([...drive.files.values()].some((f) => f.name === "a.md")).to.equal(true, "still recoverable from trash");
    });

    it("deleting in Drive moves the local file to the vault .trash", async () => {
      drive.trash("b.md");
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["trashLocal:b.md"]);
      expect(pc.vault.trashed).to.deep.equal(["b.md"]);
    });

    it("deleted on both sides just forgets the file", async () => {
      pc.vault.remove("a.md");
      drive.trash("a.md");
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["forget:a.md"]);
    });

    it("edited locally but deleted in Drive: the edit wins and is re-uploaded", async () => {
      pc.vault.put("a.md", "A-edited");
      drive.trash("a.md");
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["upload:a.md"]);
      expect(drive.read("a.md")).to.equal("A-edited");
    });

    it("deleted locally but edited in Drive: the edit wins and is restored", async () => {
      pc.vault.remove("b.md");
      drive.edit("b.md", "B-edited");
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["download:b.md"]);
      expect(pc.vault.text("b.md")).to.equal("B-edited");
    });

    it("emptied folders are trashed on the other side once their files are gone", async () => {
      pc.vault.remove("notes/c.md");
      pc.vault.folders.delete("notes");
      await pc.sync();
      expect(drive.folderPaths()).to.not.include("notes");
    });

    it("a remote folder that still holds a Google Doc is never trashed", async () => {
      drive.addGoogleDoc("notes/Shopping list");
      pc.vault.remove("notes/c.md");
      pc.vault.folders.delete("notes");
      const { res } = await pc.sync();
      expect(drive.folderPaths()).to.include("notes");
      expect(res.skipped.map((s) => s.reason)).to.include("remote folder is not empty");
    });

    describe("renames", () => {
      it("a local rename becomes a Drive move of the same file (no re-upload)", async () => {
        const id = drive.idAt("a.md");
        pc.vault.userRename("a.md", "archive/a-renamed.md");
        const { prep } = await pc.sync();
        expect(kinds(prep)).to.include("moveRemote:a.md->archive/a-renamed.md");
        expect(drive.idAt("archive/a-renamed.md")).to.equal(id);
        expect(drive.countAt("a.md")).to.equal(0);
        expect(drive.trashedNames()).to.deep.equal([]);
      });

      it("a rename in Drive becomes a local rename", async () => {
        drive.move("b.md", "notes/b-moved.md");
        const { prep } = await pc.sync();
        expect(kinds(prep)).to.include("moveLocal:b.md->notes/b-moved.md");
        expect(pc.vault.text("notes/b-moved.md")).to.equal("B1");
        expect(pc.vault.files.has("b.md")).to.equal(false);
        expect(pc.vault.trashed).to.deep.equal([]);
      });

      it("renaming a whole folder in Drive moves every file locally", async () => {
        drive.addFile("notes/e.md", "E");
        await pc.sync();
        const folderId = [...drive.files.values()].find((f) => f.name === "notes" && f.mimeType === FOLDER_MIME)!;
        folderId.name = "Notes 2025";
        (drive as unknown as { touch(id: string): void }).touch(folderId.id);
        await pc.sync();
        expect(pc.vault.text("Notes 2025/c.md")).to.equal("C1");
        expect(pc.vault.text("Notes 2025/e.md")).to.equal("E");
        expect(pc.vault.files.has("notes/c.md")).to.equal(false);
        // only the now-empty old folder goes to .trash, never a note
        expect(pc.vault.trashed).to.deep.equal(["notes"]);
      });

      it("REGRESSION (found by fuzzing): an unsynced local edit survives a rename + edit from another device", async () => {
        const phone = new Device(drive);
        await phone.sync();
        pc.vault.put("a.md", "PC edit, not synced yet");
        phone.vault.userRename("a.md", "renamed-on-phone.md");
        await phone.sync(); // Drive: same file, new name
        phone.vault.put("renamed-on-phone.md", "phone edit after renaming");
        await phone.sync(); // Drive: new content
        // PC: follows the rename (keeping its edit) and reports the conflict.
        const first = await pc.sync();
        expect(kinds(first.prep)).to.include.members(["moveLocal:a.md->renamed-on-phone.md", "conflict:renamed-on-phone.md"]);
        // The bug: the next sync treated the PC copy as unchanged and downloaded over it.
        const second = await pc.sync();
        expect(kinds(second.prep)).to.deep.equal(["conflict:renamed-on-phone.md"]);
        expect(pc.vault.text("renamed-on-phone.md")).to.equal("PC edit, not synced yet");
        expect(drive.read("renamed-on-phone.md")).to.equal("phone edit after renaming");
      });

      it("renamed locally AND edited in Drive: rename is applied, edit is downloaded", async () => {
        drive.move("a.md", "a2.md");
        drive.edit("a2.md", "A-remote-edit");
        await pc.sync();
        expect(pc.vault.text("a2.md")).to.equal("A-remote-edit");
        expect(pc.vault.files.has("a.md")).to.equal(false);
      });
    });

    describe("conflicts", () => {
      it("edited on both sides: nothing is overwritten, it is reported as a conflict", async () => {
        pc.vault.put("a.md", "A-local");
        drive.edit("a.md", "A-remote");
        const { prep, res } = await pc.sync();
        expect(kinds(prep)).to.deep.equal(["conflict:a.md"]);
        expect(res.conflicts).to.have.length(1);
        expect(pc.vault.text("a.md")).to.equal("A-local");
        expect(drive.read("a.md")).to.equal("A-remote");
      });

      it("edited on both sides to the same content: no conflict", async () => {
        pc.vault.put("a.md", "SAME");
        drive.edit("a.md", "SAME");
        const { prep } = await pc.sync();
        expect(kinds(prep)).to.deep.equal(["adopt:a.md"]);
      });

      it("the conflict persists until resolved, then syncs normally", async () => {
        pc.vault.put("a.md", "A-local");
        drive.edit("a.md", "A-remote");
        await pc.sync();
        expect(kinds((await pc.sync()).prep)).to.deep.equal(["conflict:a.md"]);
        pc.vault.put("a.md", "A-remote"); // user resolves by hand
        expect(kinds((await pc.sync()).prep)).to.deep.equal(["adopt:a.md"]);
        pc.vault.put("a.md", "A3");
        expect(kinds((await pc.sync()).prep)).to.deep.equal(["upload:a.md"]);
      });
    });
  });

  describe("interrupted syncs resume safely (iOS suspends the app)", () => {
    it("stopping after some actions: the next sync does only the rest, without duplicates", async () => {
      for (let i = 0; i < 6; i++) pc.vault.put(`n${i}.md`, `content ${i}`);
      pc.stopAfter = 2;
      const first = await pc.sync();
      expect(first.res.stopped).to.equal(true);
      expect(first.res.done).to.equal(2);

      pc.stopAfter = null;
      pc.restart();
      const second = await pc.sync();
      expect(second.prep.plan.actions.filter((a) => a.kind === "upload")).to.have.length(4);
      expect(drive.tree().size).to.equal(6);
      for (let i = 0; i < 6; i++) expect(drive.countAt(`n${i}.md`)).to.equal(1);
    });

    it("an upload that reached Drive but whose reply was lost is adopted, not uploaded twice", async () => {
      pc.vault.put("x.md", "X");
      drive.afterCommit = (req) => {
        if (req.url.includes("uploadType=multipart")) {
          drive.afterCommit = null;
          throw new Error("network connection lost");
        }
      };
      const first = await pc.sync();
      expect(first.res.failed).to.have.length(1);
      expect(drive.countAt("x.md")).to.equal(1);

      pc.restart();
      const second = await pc.sync();
      expect(kinds(second.prep)).to.deep.equal(["adopt:x.md"]);
      expect(drive.countAt("x.md")).to.equal(1);
    });

    it("a Drive trash that happened but was not recorded is simply forgotten next time", async () => {
      pc.vault.put("y.md", "Y");
      pc.vault.put("keep.md", "K");
      await pc.sync();
      pc.vault.remove("y.md");
      // The trash is applied in Drive, but the app dies before hearing back (outlasting retries).
      drive.afterCommit = (req) => {
        if (req.method === "PATCH" && String(req.body).includes('"trashed":true')) throw new Error("app suspended");
      };
      const first = await pc.sync();
      expect(first.res.failed).to.have.length(1);
      drive.afterCommit = null;
      pc.restart();
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["forget:y.md"]);
    });

    it("a crash while writing a download never overwrites a local edit and loses nothing in Drive", async () => {
      pc.vault.put("z.md", "Z1");
      await pc.sync();
      drive.edit("z.md", "Z-remote");
      pc.vault.beforeWrite = (p) => {
        pc.vault.beforeWrite = null;
        pc.vault.put(p, "Z-half-written"); // partial content hits the disk, then the app dies
        throw new Error("killed by iOS");
      };
      await pc.sync();
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["conflict:z.md"]);
      expect(drive.read("z.md")).to.equal("Z-remote");
    });

    it("a file edited between planning and executing is skipped, not clobbered", async () => {
      pc.vault.put("w.md", "W1");
      await pc.sync();
      drive.edit("w.md", "W-remote");
      const d = pc.deps();
      const { prepare, runPlan } = await import("../src/sync/engine");
      const prep = await prepare(d);
      pc.vault.put("w.md", "W-local-typed-just-now");
      const res = await runPlan(d, prep.plan);
      expect(res.skipped.map((s) => s.reason)).to.include("local file changed during sync");
      expect(pc.vault.text("w.md")).to.equal("W-local-typed-just-now");
    });
  });

  describe("duplicate names in Drive", () => {
    it("identical duplicates: one is used, no third copy is uploaded, extras are left alone", async () => {
      drive.addFile("dup.md", "same");
      drive.addFile("dup.md", "same");
      pc.vault.put("dup.md", "same");
      const { prep } = await pc.sync();
      expect(kinds(prep)).to.deep.equal(["adopt:dup.md"]);
      expect(drive.countAt("dup.md")).to.equal(2);
      pc.vault.put("dup.md", "edited");
      await pc.sync();
      expect(drive.countAt("dup.md")).to.equal(2);
      const contents = [...drive.files.values()].filter((f) => f.name === "dup.md").map((f) => new TextDecoder().decode(f.content));
      expect(contents.sort()).to.deep.equal(["edited", "same"]);
    });

    it("different files with the same name are blocked: never downloaded, uploaded or deleted", async () => {
      drive.addFile("clash.md", "version 1");
      drive.addFile("clash.md", "version 2");
      pc.vault.put("clash.md", "local");
      const { prep } = await pc.sync();
      expect(prep.plan.actions.find((a) => pathOf(a) === "clash.md")?.kind).to.equal("skip");
      expect(pc.vault.text("clash.md")).to.equal("local");
      expect(drive.countAt("clash.md")).to.equal(2);

      pc.vault.remove("clash.md");
      await pc.sync();
      expect(drive.countAt("clash.md")).to.equal(2);
      expect(drive.trashedNames()).to.deep.equal([]);
    });

    it("names that differ only in upper/lower case are blocked (they would collide on iOS/Windows)", async () => {
      drive.addFile("Todo.md", "one");
      drive.addFile("todo.md", "two");
      const { prep } = await pc.sync();
      expect(prep.plan.actions.filter((a) => a.kind === "skip")).to.have.length(1);
      expect(pc.vault.files.size).to.equal(0);
    });

    it("once synced, a duplicate that appears later does not replace the known file", async () => {
      drive.addFile("k.md", "known");
      await pc.sync();
      drive.addFile("k.md", "imposter");
      const { prep } = await pc.sync();
      expect(prep.plan.actions.filter((a) => pathOf(a) === "k.md").map((a) => a.kind)).to.deep.equal([]);
      expect(pc.vault.text("k.md")).to.equal("known");
    });

    it("duplicate folders are merged instead of creating a third one", async () => {
      drive.addFile("Proj/a.md", "a");
      const second = [...drive.files.values()].find((f) => f.name === "Proj")!;
      drive.files.set("dupfolder", { ...second, id: "dupfolder", createdTime: second.createdTime + 5000 });
      drive.addFile("Proj/b.md", "b"); // lands in the first folder
      drive.files.set("inDup", { id: "inDup", name: "c.md", mimeType: "text/markdown", parents: ["dupfolder"], content: new TextEncoder().encode("c"), modifiedTime: 1, createdTime: 1, trashed: false });
      await pc.sync();
      expect([...pc.vault.files.keys()].sort()).to.deep.equal(["Proj/a.md", "Proj/b.md", "Proj/c.md"]);
      pc.vault.put("Proj/new.md", "n");
      await pc.sync();
      expect(drive.folderPaths().filter((p) => p === "Proj")).to.have.length(2, "no third Proj folder");
    });
  });

  describe("three devices: PC, iPhone, iPad", () => {
    it("changes made on one device reach the others, including deletions and renames", async () => {
      const phone = new Device(drive);
      const ipad = new Device(drive);
      pc.vault.put("shared.md", "v1");
      pc.vault.put("todelete.md", "bye");
      pc.vault.put("torename.md", "r");
      await pc.sync();
      await phone.sync();
      await ipad.sync();
      expect(phone.vault.text("shared.md")).to.equal("v1");

      phone.vault.put("shared.md", "edited on iPhone");
      phone.vault.remove("todelete.md");
      phone.vault.userRename("torename.md", "renamed.md");
      await phone.sync();
      await pc.sync();
      await ipad.sync();
      for (const d of [pc, ipad]) {
        expect(d.vault.text("shared.md")).to.equal("edited on iPhone");
        expect(d.vault.files.has("todelete.md")).to.equal(false);
        expect(d.vault.trashed).to.include("todelete.md");
        expect(d.vault.text("renamed.md")).to.equal("r");
      }
      expect([...drive.tree().keys()].sort()).to.deep.equal(["renamed.md", "shared.md"]);
    });
  });

  describe("filters", () => {
    it(".obsidian is ignored by default, on both sides", async () => {
      drive.addFile(".obsidian/app.json", "{}");
      pc.vault.put(".obsidian/hotkeys.json", "{}");
      const { prep } = await pc.sync();
      expect(prep.plan.actions).to.deep.equal([]);
    });

    it("with config sync on, .obsidian syncs but this plugin's own folder (tokens!) never does", async () => {
      const dev = new Device(drive, { syncConfigDir: true });
      dev.vault.put(".obsidian/app.json", "{}");
      dev.vault.put(".obsidian/plugins/gdrive-vault-sync/data.json", '{"tokens":"SECRET"}');
      dev.vault.put(".obsidian/workspace.json", "{}");
      await dev.sync();
      expect([...drive.tree().keys()]).to.deep.equal([".obsidian/app.json"]);
    });

    it("adding an ignore pattern never deletes the now-ignored files", async () => {
      pc.vault.put("Private/diary.md", "secret");
      await pc.sync();
      const strict = new Device(drive, { patterns: "Private/" });
      strict.kv = pc.kv;
      strict.vault = pc.vault;
      strict.restart();
      pc.vault.remove("Private/diary.md");
      const { prep } = await strict.sync();
      expect(prep.plan.actions.filter(isDeletion)).to.deep.equal([]);
      expect(drive.read("Private/diary.md")).to.equal("secret");
    });

    it("Google Docs/Sheets are skipped", async () => {
      drive.addGoogleDoc("Budget");
      const { prep } = await pc.sync();
      expect(prep.plan.actions).to.deep.equal([]);
    });

    it("files over the size limit are skipped both ways", async () => {
      const dev = new Device(drive, { maxFileSize: 10 });
      dev.vault.put("big.md", "x".repeat(11));
      drive.addFile("big2.md", "y".repeat(11));
      const { prep } = await dev.sync();
      expect(prep.plan.actions.map((a) => a.kind)).to.deep.equal(["skip", "skip"]);
    });
  });

  describe("Drive API behaviour", () => {
    it("pages through large folders", async () => {
      drive.pageSize = 7;
      for (let i = 0; i < 40; i++) drive.addFile(`p/${i}.md`, `${i}`);
      await pc.sync();
      expect(pc.vault.files.size).to.equal(40);
    });

    it("uses the Changes API after the first sync instead of re-listing the folder", async () => {
      for (let i = 0; i < 5; i++) drive.addFile(`f/${i}.md`, "x");
      await pc.sync();
      drive.requests = [];
      drive.addFile("f/new.md", "new");
      await pc.sync();
      expect(drive.requests.some((r) => r.url.includes("/changes?"))).to.equal(true);
      expect(drive.requests.filter((r) => r.url.includes("/files?") && r.url.includes("in+parents") && !r.url.includes("name+%3D"))).to.have.length(0);
      expect(pc.vault.text("f/new.md")).to.equal("new");
    });

    it("retries with backoff on 429 and rate-limit 403, then succeeds", async () => {
      pc.vault.put("r.md", "r");
      let n = 0;
      drive.intercept = (req) => {
        if (req.url.includes("/files?") && n++ < 2) {
          const text = JSON.stringify({ error: { errors: [{ reason: n === 1 ? "userRateLimitExceeded" : "x" }] } });
          return { status: n === 1 ? 403 : 429, headers: {}, text, arrayBuffer: new ArrayBuffer(0) };
        }
        return undefined;
      };
      const { res } = await pc.sync();
      expect(res.failed).to.deep.equal([]);
      expect(drive.read("r.md")).to.equal("r");
    });

    it("uploads files over 5 MB in resumable chunks, and resumes an interrupted upload", async () => {
      const big = new Uint8Array(9 * 1024 * 1024 + 123).map((_, i) => i % 251);
      pc.vault.put("video.bin", big);
      let chunks = 0;
      drive.intercept = (req) => {
        // first chunk gets through, then the connection is gone (app suspended)
        if (req.url.startsWith("https://upload.fake") && !String(req.headers?.["Content-Range"]).startsWith("bytes */") && ++chunks >= 2) {
          throw new Error("connection dropped mid-upload");
        }
        return undefined;
      };
      const first = await pc.sync();
      expect(first.res.failed).to.have.length(1);
      drive.intercept = null;
      pc.restart();
      const second = await pc.sync();
      expect(second.res.failed).to.deep.equal([]);
      const f = [...drive.files.values()].find((x) => x.name === "video.bin")!;
      expect(f.content!.byteLength).to.equal(big.byteLength);
      expect(f.content![9 * 1024 * 1024]).to.equal(big[9 * 1024 * 1024]);
      expect(drive.requests.filter((r) => r.url.includes("uploadType=resumable"))).to.have.length(1, "second sync continued the saved session");
      const firstChunkSentTwice = drive.requests.filter((r) => String(r.headers?.["Content-Range"]).startsWith("bytes 0-")).length;
      expect(firstChunkSentTwice).to.equal(1, "already-uploaded bytes are not sent again");
    });
  });

  describe("safety checks", () => {
    it("refuses to run if the vault suddenly looks empty after earlier syncs", async () => {
      pc.vault.put("a.md", "A");
      await pc.sync();
      pc.vault.files.clear();
      let err: unknown;
      try {
        await pc.sync();
      } catch (e) {
        err = e;
      }
      expect(String(err)).to.match(/looks empty/);
      expect(drive.trashedNames()).to.deep.equal([]);
    });

    it("pointing at a different Drive folder starts fresh instead of treating files as deleted", async () => {
      pc.vault.put("a.md", "A");
      await pc.sync();
      const otherDrive = new FakeDrive();
      const sameDeviceOtherFolder = new Device(otherDrive);
      sameDeviceOtherFolder.vault = pc.vault;
      sameDeviceOtherFolder.kv = pc.kv;
      // Different folder ID -> different base namespace:
      (sameDeviceOtherFolder as unknown as { deps: () => ReturnType<Device["deps"]> }).deps = () => ({ ...Device.prototype.deps.call(sameDeviceOtherFolder), namespace: "OTHER_FOLDER" });
      const { prep } = await sameDeviceOtherFolder.sync();
      expect(prep.plan.firstSync).to.equal(true);
      expect(prep.plan.actions.filter(isDeletion)).to.deep.equal([]);
    });
  });
});
