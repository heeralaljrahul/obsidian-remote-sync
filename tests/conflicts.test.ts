import { expect } from "chai";
import { md5Hex } from "../src/sync/engine";
import { cosmeticDifference, decodeText, diffLines, sideBySide, splitLines, toHunks, unifiedText, type DiffOp } from "../src/sync/diff";
import { BaseStore } from "../src/sync/store";
import { conflictCopyPath, resolveConflict, type ConflictItem, type Resolution } from "../src/sync/resolve";
import { Device, kinds } from "./helpers/device";
import { FakeDrive, ROOT_ID } from "./helpers/fakeDrive";

/** Apply an edit script to A; must give B. */
function apply(ops: DiffOp[]): { a: string[]; b: string[] } {
  return { a: ops.filter((o) => o.t !== "add").map((o) => o.text), b: ops.filter((o) => o.t !== "del").map((o) => o.text) };
}

describe("line diff", () => {
  it("produces a correct, minimal edit script", () => {
    const a = splitLines("a\nb\nc\nd\ne\nf\n");
    const b = splitLines("a\nc\nd\nX\ne\nf\nG\n");
    const ops = diffLines(a, b);
    expect(apply(ops)).to.deep.equal({ a, b });
    expect(ops.filter((o) => o.t !== "eq").map((o) => `${o.t}:${o.text}`)).to.deep.equal(["del:b", "add:X", "add:G"]);
  });

  it("is correct on random inputs (property test)", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 300; i++) {
      const a = Array.from({ length: Math.floor(rnd() * 30) }, () => "xyzw"[Math.floor(rnd() * 4)]);
      const b = Array.from({ length: Math.floor(rnd() * 30) }, () => "xyzw"[Math.floor(rnd() * 4)]);
      const ops = diffLines(a, b);
      expect(apply(ops)).to.deep.equal({ a, b });
      // line numbers are consecutive on both sides
      expect(ops.filter((o) => o.t !== "add").map((o) => (o as { a: number }).a)).to.deep.equal(a.map((_, j) => j + 1));
      expect(ops.filter((o) => o.t !== "del").map((o) => (o as { b: number }).b)).to.deep.equal(b.map((_, j) => j + 1));
    }
  });

  it("falls back to replace-all (still correct) when the files are too different", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    const ops = diffLines(a, b, 10);
    expect(apply(ops)).to.deep.equal({ a, b });
  });

  it("handles a large note with one change quickly", () => {
    const a = Array.from({ length: 50000 }, (_, i) => `line ${i}`);
    const b = [...a];
    b[25000] = "changed";
    const t = Date.now();
    const ops = diffLines(a, b);
    expect(Date.now() - t).to.be.lessThan(1000);
    expect(ops.filter((o) => o.t !== "eq")).to.have.length(2);
  });

  it("renders unified-diff hunks identical to GNU diff -U3", () => {
    const a = splitLines("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n");
    const b = splitLines("1\n2\n3\n4\n5\n6\nSEVEN\n8\n9\n10\n11\n12\n13\n14\n15\n16\n");
    const text = unifiedText(toHunks(diffLines(a, b)), "Drive", "This device");
    expect(text).to.equal(["--- Drive", "+++ This device", "@@ -4,7 +4,7 @@", " 4", " 5", " 6", "-7", "+SEVEN", " 8", " 9", " 10", "@@ -13,3 +13,4 @@", " 13", " 14", " 15", "+16"].join("\n"));
  });

  it("hunk positions for pure insertions/deletions at the start", () => {
    expect(toHunks(diffLines([], ["new"]))[0]).to.include({ aStart: 0, aLen: 0, bStart: 1, bLen: 1 });
    expect(toHunks(diffLines(["old", "x"], ["x"]))[0]).to.include({ aStart: 1, aLen: 2, bStart: 1, bLen: 1 });
  });

  it("pairs changed lines for the side-by-side view", () => {
    const rows = sideBySide(diffLines(["a", "b", "c"], ["a", "B", "B2", "c"]));
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).to.deep.equal([
      ["a", "a"],
      ["b", "B"],
      [null, "B2"],
      ["c", "c"],
    ]);
  });

  it("treats CRLF and LF the same, and explains cosmetic differences", () => {
    expect(diffLines(splitLines("a\r\nb\r\n"), splitLines("a\nb")).every((o) => o.t === "eq")).to.equal(true);
    expect(cosmeticDifference("a\r\nb", "a\nb")).to.match(/line endings/);
    expect(cosmeticDifference("a  \nb\n\n", "a\nb")).to.match(/trailing/);
    expect(cosmeticDifference("a", "b")).to.equal(null);
  });

  it("detects binary vs text", () => {
    const enc = new TextEncoder();
    expect(decodeText("n.md", enc.encode("﻿héllo").buffer as ArrayBuffer)).to.equal("héllo");
    expect(decodeText("p.png", new Uint8Array([137, 80, 78, 71, 0, 1]).buffer)).to.equal(null);
    expect(decodeText("n.md", new Uint8Array([0xff, 0xfe, 0x00]).buffer)).to.equal(null);
  });
});

describe("conflict copy names", () => {
  it("adds a date stamp before the extension and stays unique", async () => {
    const taken = new Set(["Notes/Plan (conflict 2026-11-18 0905).md"]);
    const d = new Date(2026, 10, 18, 9, 5);
    expect(await conflictCopyPath("Notes/Plan.md", d, async (p) => taken.has(p))).to.equal("Notes/Plan (conflict 2026-11-18 0905 2).md");
    expect(await conflictCopyPath("README", d, async () => false)).to.equal("README (conflict 2026-11-18 0905)");
    expect(await conflictCopyPath("a.b/c.tar.gz", d, async () => false)).to.equal("a.b/c.tar (conflict 2026-11-18 0905).gz");
  });
});

describe("resolving conflicts (mock Google Drive)", () => {
  let drive: FakeDrive;
  let pc: Device;
  let conflict: ConflictItem;

  const resolve = (choice: Resolution, c = conflict) =>
    resolveConflict(c, choice, { local: pc.vault, remote: pc.provider, base: new BaseStore(pc.kv, ROOT_ID), log: pc.log, md5: md5Hex, now: () => new Date(2026, 10, 18, 14, 30).getTime() });

  beforeEach(async () => {
    drive = new FakeDrive();
    pc = new Device(drive);
    pc.vault.put("Plan.md", "v1");
    pc.vault.put("other.md", "o");
    await pc.sync();
    pc.vault.put("Plan.md", "local edit");
    drive.edit("Plan.md", "drive edit");
    const { prep } = await pc.sync();
    const a = prep.plan.actions.find((x) => x.kind === "conflict");
    if (!a || a.kind !== "conflict") throw new Error("expected a conflict");
    conflict = { path: a.path, type: a.type, local: a.local, remote: a.remote };
  });

  it("keep this device: Drive file updated in place (same ID), then everything is in sync", async () => {
    const id = drive.idAt("Plan.md");
    await resolve("keep-local");
    expect(drive.read("Plan.md")).to.equal("local edit");
    expect(drive.idAt("Plan.md")).to.equal(id);
    expect(kinds((await pc.sync()).prep)).to.deep.equal([]);
  });

  it("keep Drive: this device's version goes to .trash, Drive version written, then in sync", async () => {
    await resolve("keep-remote");
    expect(pc.vault.text("Plan.md")).to.equal("drive edit");
    expect(pc.vault.trashed).to.deep.equal(["Plan.md"]);
    expect(kinds((await pc.sync()).prep)).to.deep.equal([]);
  });

  it("keep both: Drive version keeps the name, this device's version becomes a conflict copy on both sides", async () => {
    const msg = await resolve("keep-both");
    const copy = "Plan (conflict 2026-11-18 1430).md";
    expect(msg).to.contain(copy);
    expect(pc.vault.text("Plan.md")).to.equal("drive edit");
    expect(pc.vault.text(copy)).to.equal("local edit");
    expect(drive.read(copy)).to.equal("local edit");
    expect(kinds((await pc.sync()).prep)).to.deep.equal([]);
    // and another device gets both files
    const phone = new Device(drive);
    await phone.sync();
    expect(phone.vault.text(copy)).to.equal("local edit");
    expect(phone.vault.text("Plan.md")).to.equal("drive edit");
  });

  it("keep both while offline: the copy is kept locally and uploaded by the next sync", async () => {
    drive.intercept = (req) => (req.method === "POST" ? { status: 500, headers: {}, text: "{}", arrayBuffer: new ArrayBuffer(0) } : undefined);
    await resolve("keep-both");
    drive.intercept = null;
    const { prep } = await pc.sync();
    expect(kinds(prep)).to.deep.equal(["upload:Plan (conflict 2026-11-18 1430).md"]);
  });

  it("refuses if this device's version changed after the diff was shown", async () => {
    pc.vault.put("Plan.md", "typed more");
    let err: unknown;
    try {
      await resolve("keep-remote");
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.match(/changed after you opened it/);
    expect(pc.vault.text("Plan.md")).to.equal("typed more");
    expect(pc.vault.trashed).to.deep.equal([]);
  });

  it("refuses if the Drive version changed after the diff was shown", async () => {
    drive.edit("Plan.md", "drive edit 2");
    for (const choice of ["keep-local", "keep-remote", "keep-both"] as Resolution[]) {
      let err: unknown;
      try {
        await resolve(choice);
      } catch (e) {
        err = e;
      }
      expect(String(err), choice).to.match(/Drive version changed/);
    }
    expect(drive.read("Plan.md")).to.equal("drive edit 2");
    expect(pc.vault.text("Plan.md")).to.equal("local edit");
  });

  it("first-sync conflicts (both sides had the file) resolve the same way", async () => {
    const d2 = new FakeDrive();
    const dev = new Device(d2);
    d2.addFile("Same name.md", "drive");
    dev.vault.put("Same name.md", "pc");
    const { prep } = await dev.sync();
    const a = prep.plan.actions[0];
    if (a.kind !== "conflict") throw new Error("expected conflict");
    await resolveConflict({ path: a.path, type: a.type, local: a.local, remote: a.remote }, "keep-local", {
      local: dev.vault,
      remote: dev.provider,
      base: new BaseStore(dev.kv, ROOT_ID),
      log: dev.log,
      md5: md5Hex,
    });
    expect(d2.read("Same name.md")).to.equal("pc");
    expect(kinds((await dev.sync()).prep)).to.deep.equal([]);
  });
});
