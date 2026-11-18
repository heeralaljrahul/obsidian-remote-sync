/** Stress / scale tests: big vaults, deep trees, large files, mass operations, repeated syncs. */
import { expect } from "chai";
import { diffLines, splitLines, toHunks } from "../src/sync/diff";
import { isDeletion } from "../src/sync/planner";
import { reviewReason } from "../src/sync/planView";
import { md5Hex } from "../src/sync/engine";
import { resolveConflict } from "../src/sync/resolve";
import { BaseStore } from "../src/sync/store";
import { Device } from "./helpers/device";
import { FakeDrive, ROOT_ID } from "./helpers/fakeDrive";

describe("stress", function () {
  this.timeout(180000);

  it("5,000-file first sync (2,000 identical, 1,500 PC-only, 1,500 Drive-only across 50 folders), then a cheap no-change sync", async () => {
    const drive = new FakeDrive();
    const pc = new Device(drive);
    for (let i = 0; i < 2000; i++) {
      const p = `f${i % 50}/same-${i}.md`;
      drive.addFile(p, `same ${i}`);
      pc.vault.put(p, `same ${i}`);
    }
    for (let i = 0; i < 1500; i++) pc.vault.put(`f${i % 50}/pc-${i}.md`, `pc ${i}`);
    for (let i = 0; i < 1500; i++) drive.addFile(`f${i % 50}/drive-${i}.md`, `drive ${i}`);

    let t = Date.now();
    const first = await pc.sync();
    const firstMs = Date.now() - t;
    expect(first.res.failed).to.deep.equal([]);
    expect(first.prep.plan.actions.filter((a) => a.kind === "adopt")).to.have.length(2000);
    expect(drive.tree().size).to.equal(5000);
    expect(pc.vault.files.size).to.equal(5000);
    // Listing is batched: far fewer list calls than folders x pages.
    const listCalls = drive.requests.filter((r) => r.url.includes("/files?") && r.url.includes("in+parents") && !r.url.includes("name+%3D")).length;
    expect(listCalls).to.be.lessThan(20);

    drive.requests = [];
    t = Date.now();
    const second = await pc.sync();
    const secondMs = Date.now() - t;
    expect(second.prep.plan.actions).to.deep.equal([]);
    expect(drive.requests.length, "a no-change sync is ~1 request (Changes API)").to.be.lessThan(4);
    expect(pc.log.all().some((e) => e.msg.startsWith("hashing") && e.t >= t)).to.equal(false, "no file is re-read when nothing changed");
    console.log(`      first sync ${firstMs} ms, no-change sync ${secondMs} ms, ${listCalls} list calls`);
  });

  it("a folder tree 60 levels deep", async () => {
    const drive = new FakeDrive();
    const pc = new Device(drive);
    const deep = Array.from({ length: 60 }, (_, i) => `d${i}`).join("/");
    pc.vault.put(`${deep}/leaf.md`, "deep");
    drive.addFile(`${deep}/remote-leaf.md`, "deep remote");
    await pc.sync();
    expect(drive.read(`${deep}/leaf.md`)).to.equal("deep");
    expect(pc.vault.text(`${deep}/remote-leaf.md`)).to.equal("deep remote");
    expect(drive.folderPaths().filter((p) => p === deep)).to.have.length(1, "no duplicate folders");
  });

  it("2,500 files in ONE folder (several result pages)", async () => {
    const drive = new FakeDrive();
    for (let i = 0; i < 2500; i++) drive.addFile(`Inbox/${i}.md`, `${i}`);
    const pc = new Device(drive);
    await pc.sync();
    expect(pc.vault.files.size).to.equal(2500);
  });

  it("a 40 MB attachment is uploaded in 8 MB chunks and downloaded intact on another device", async () => {
    const drive = new FakeDrive();
    const pc = new Device(drive);
    const big = new Uint8Array(40 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 256;
    pc.vault.put("video.mp4", big);
    await pc.sync();
    const chunks = drive.requests.filter((r) => r.url.startsWith("https://upload.fake") && !String(r.headers?.["Content-Range"]).startsWith("bytes */"));
    expect(chunks).to.have.length(5);
    const phone = new Device(drive);
    await phone.sync();
    const got = phone.vault.files.get("video.mp4")!.data;
    expect(got.byteLength).to.equal(big.byteLength);
    expect(md5Hex(got.buffer as ArrayBuffer)).to.equal(md5Hex(big.buffer as ArrayBuffer));
  });

  it("1,000 files deleted at once: everything goes to trash, and the plan asks for review first", async () => {
    const drive = new FakeDrive();
    const pc = new Device(drive);
    for (let i = 0; i < 1000; i++) pc.vault.put(`old/${i}.md`, `${i}`);
    pc.vault.put("keep.md", "k");
    await pc.sync();
    for (let i = 0; i < 1000; i++) pc.vault.remove(`old/${i}.md`);
    const prep = await pc.plan();
    expect(prep.plan.actions.filter(isDeletion).length).to.be.at.least(1000);
    expect(reviewReason(prep.plan, false, 20)).to.equal("many-deletions");
    await pc.sync();
    expect(drive.trashedNames().length).to.be.at.least(1000);
    expect([...drive.files.values()].filter((f) => f.name.endsWith(".md")).length).to.be.at.least(1001, "trashed, not deleted");
  });

  it("300 conflicts at once can all be resolved", async () => {
    const drive = new FakeDrive();
    const pc = new Device(drive);
    for (let i = 0; i < 300; i++) {
      drive.addFile(`c/${i}.md`, `drive ${i}`);
      pc.vault.put(`c/${i}.md`, `pc ${i}`);
    }
    const { prep } = await pc.sync();
    const conflicts = prep.plan.actions.filter((a) => a.kind === "conflict");
    expect(conflicts).to.have.length(300);
    for (const a of conflicts) {
      if (a.kind !== "conflict") continue;
      await resolveConflict({ path: a.path, type: a.type, local: a.local, remote: a.remote }, "keep-both", { local: pc.vault, remote: pc.provider, base: new BaseStore(pc.kv, ROOT_ID), log: pc.log, md5: md5Hex });
    }
    const after = await pc.sync();
    expect(after.prep.plan.actions).to.deep.equal([]);
    expect(drive.tree().size).to.equal(600);
  });

  it("1,000 files renamed (folder moved) on another device are moved locally, not re-downloaded", async () => {
    const drive = new FakeDrive();
    const pc = new Device(drive);
    const phone = new Device(drive);
    for (let i = 0; i < 1000; i++) pc.vault.put(`Projects/${i}.md`, `${i}`);
    await pc.sync();
    await phone.sync();
    for (let i = 0; i < 1000; i++) phone.vault.userRename(`Projects/${i}.md`, `Archive/2026/${i}.md`);
    phone.vault.folders.delete("Projects");
    await phone.sync();
    drive.requests = [];
    const { prep } = await pc.sync();
    expect(prep.plan.actions.filter((a) => a.kind === "moveLocal")).to.have.length(1000);
    expect(drive.requests.filter((r) => r.url.includes("alt=media"))).to.have.length(0);
    expect(pc.vault.text("Archive/2026/999.md")).to.equal("999");
  });

  it("100 syncs in a row: local state does not grow, log stays capped", async () => {
    const drive = new FakeDrive();
    const pc = new Device(drive);
    for (let i = 0; i < 50; i++) pc.vault.put(`${i}.md`, `${i}`);
    await pc.sync();
    const sizeAfterFirst = pc.kv.data.size;
    for (let i = 0; i < 100; i++) {
      pc.vault.put(`${i % 50}.md`, `v${i}`);
      await pc.sync();
    }
    expect(pc.kv.data.size).to.equal(sizeAfterFirst);
    expect(pc.log.all().length).to.be.at.most(1500);
  });

  it("500 files with emoji, CJK, accents and NFD (iOS) names", async () => {
    const drive = new FakeDrive();
    const pc = new Device(drive);
    const names = ["📝 idée", "日本語メモ", "Ελληνικά", "Café", "Ünïcödé", "עברית", "русский"];
    for (let i = 0; i < 500; i++) drive.addFile(`u/${names[i % names.length]} ${i}.md`, `u${i}`);
    await pc.sync();
    expect(pc.vault.files.size).to.equal(500);
    const { prep } = await pc.sync();
    expect(prep.plan.actions).to.deep.equal([]);
  });

  it("diffing a 20,000-line note with 200 scattered edits stays fast", () => {
    const a = Array.from({ length: 20000 }, (_, i) => `line ${i} lorem ipsum`);
    const b = [...a];
    for (let i = 0; i < 200; i++) b[i * 97] = `edited ${i}`;
    const t = Date.now();
    const hunks = toHunks(diffLines(splitLines(a.join("\n")), splitLines(b.join("\n"))));
    expect(Date.now() - t).to.be.lessThan(2000);
    expect(hunks.length).to.equal(200);
  });
});
