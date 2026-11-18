/** Pure planner tests: hand-built snapshots, no I/O. */
import { expect } from "chai";
import { isDeletion, pathsNeedingHash, plan } from "../src/sync/planner";
import type { BaseEntry, LocalFile, LocalSnapshot, RemoteFile, RemoteSnapshot } from "../src/sync/types";

const L = (path: string, md5: string, mtime = 100, size = 10): LocalFile => ({ path, md5, mtime, size });
const R = (path: string, md5: string, id = `id-${path}`, modifiedTime = 200, size = 10): RemoteFile => ({ path, id, md5, modifiedTime, size });
const B = (path: string, md5: string, id = `id-${path}`): BaseEntry => ({
  path,
  isFolder: false,
  md5,
  localMtime: 100,
  localSize: 10,
  remoteId: id,
  remoteMd5: md5,
  remoteModifiedTime: 200,
  remoteSize: 10,
  syncedAt: 1,
});
const FB = (path: string): BaseEntry => ({ path, isFolder: true, syncedAt: 1 });

function local(files: LocalFile[], folders: string[] = []): LocalSnapshot {
  return { files: new Map(files.map((f) => [f.path, f])), folders: new Set(folders) };
}
function remote(files: RemoteFile[], folders: Record<string, string> = {}, blocked: Record<string, string> = {}): RemoteSnapshot {
  return { files: new Map(files.map((f) => [f.path, f])), folders: new Map(Object.entries(folders)), blocked: new Map(Object.entries(blocked)) };
}
function base(entries: BaseEntry[]): Map<string, BaseEntry> {
  return new Map(entries.map((b) => [b.path, b]));
}
const opts = { maxFileSize: 0 };
const kinds = (p: ReturnType<typeof plan>) => p.actions.map((a) => `${a.kind}:${"path" in a ? a.path : `${a.from}->${a.to}`}`);

describe("planner: three-way decision table", () => {
  const cases: Array<[string, LocalFile[], RemoteFile[], BaseEntry[], string[]]> = [
    ["unchanged on both sides -> nothing", [L("a", "1")], [R("a", "1")], [B("a", "1")], []],
    ["edited locally -> upload", [L("a", "2", 150)], [R("a", "1")], [B("a", "1")], ["upload:a"]],
    ["edited remotely -> download", [L("a", "1")], [R("a", "2", "id-a", 300)], [B("a", "1")], ["download:a"]],
    ["edited both, different -> conflict", [L("a", "2", 150)], [R("a", "3", "id-a", 300)], [B("a", "1")], ["conflict:a"]],
    ["edited both, identical -> adopt", [L("a", "2", 150)], [R("a", "2", "id-a", 300)], [B("a", "1")], ["adopt:a"]],
    ["new locally -> upload", [L("a", "1")], [], [B("x", "9")].slice(0, 0), ["upload:a"]],
    ["new remotely -> download", [], [R("a", "1")], [], ["download:a"]],
    ["new on both, identical -> adopt", [L("a", "1")], [R("a", "1")], [], ["adopt:a"]],
    ["new on both, different -> conflict", [L("a", "1")], [R("a", "2")], [], ["conflict:a"]],
    ["deleted locally -> trash remote", [L("z", "z")], [R("a", "1"), R("z", "z")], [B("a", "1"), B("z", "z")], ["trashRemote:a"]],
    ["deleted remotely -> trash local", [L("a", "1"), L("z", "z")], [R("z", "z")], [B("a", "1"), B("z", "z")], ["trashLocal:a"]],
    ["deleted locally, edited remotely -> download (restore)", [L("z", "z")], [R("a", "2", "id-a", 300), R("z", "z")], [B("a", "1"), B("z", "z")], ["download:a"]],
    ["deleted remotely, edited locally -> upload (restore)", [L("a", "2", 150), L("z", "z")], [R("z", "z")], [B("a", "1"), B("z", "z")], ["upload:a"]],
    ["deleted on both -> forget", [L("z", "z")], [R("z", "z")], [B("a", "1"), B("z", "z")], ["forget:a"]],
    ["only mtime changed locally (same hash) -> adopt to refresh base", [L("a", "1", 999)], [R("a", "1")], [B("a", "1")], ["adopt:a"]],
    ["same content, new Drive ID (re-uploaded elsewhere) -> adopt", [L("a", "1")], [R("a", "1", "new-id")], [B("a", "1")], ["adopt:a"]],
  ];
  for (const [name, l, r, b, expected] of cases) {
    it(name, () => {
      expect(kinds(plan(local(l), remote(r), base(b), opts))).to.deep.equal(expected);
    });
  }
});

describe("planner: renames", () => {
  it("same Drive ID at a new path = remote rename -> moveLocal", () => {
    const p = plan(local([L("old.md", "1")]), remote([R("new.md", "1", "ID")]), base([B("old.md", "1", "ID")]), opts);
    expect(kinds(p)).to.deep.equal(["moveLocal:old.md->new.md"]);
  });

  it("content re-appears at exactly one new local path = local rename -> moveRemote", () => {
    const p = plan(local([L("new.md", "1")]), remote([R("old.md", "1", "ID")]), base([B("old.md", "1", "ID")]), opts);
    expect(kinds(p)).to.deep.equal(["moveRemote:old.md->new.md"]);
  });

  it("ambiguous local rename (two new copies with the same content) falls back to upload + trash", () => {
    const p = plan(local([L("n1.md", "1"), L("n2.md", "1")]), remote([R("old.md", "1", "ID")]), base([B("old.md", "1", "ID")]), opts);
    expect(kinds(p).sort()).to.deep.equal(["trashRemote:old.md", "upload:n1.md", "upload:n2.md"]);
  });

  it("remote rename onto a path that exists locally is not applied as a rename", () => {
    const p = plan(local([L("old.md", "1"), L("new.md", "x")]), remote([R("new.md", "1", "ID")]), base([B("old.md", "1", "ID")]), opts);
    expect(kinds(p)).to.not.include("moveLocal:old.md->new.md");
  });
});

describe("planner: safety", () => {
  it("the first sync (empty base) never contains deletions", () => {
    const p = plan(local([L("a", "1")]), remote([R("b", "2")]), new Map(), opts);
    expect(p.firstSync).to.equal(true);
    expect(p.actions.some(isDeletion)).to.equal(false);
  });

  it("blocked paths are skipped even when missing locally (no deletion of the Drive duplicates)", () => {
    const p = plan(local([]), remote([], {}, { "dup.md": "duplicate" }), base([B("dup.md", "1")]), opts);
    expect(kinds(p)).to.deep.equal(["skip:dup.md"]);
  });

  it("a file on one side and a folder on the other is skipped", () => {
    const p = plan(local([L("thing", "1")]), remote([], { thing: "F" }), new Map(), opts);
    expect(kinds(p)).to.deep.equal(["skip:thing"]);
  });

  it("files over the size limit are skipped", () => {
    const p = plan(local([L("big", "1", 100, 5000)]), remote([]), new Map(), { maxFileSize: 1000 });
    expect(p.actions[0].kind).to.equal("skip");
  });
});

describe("planner: folders", () => {
  it("new empty folders are created on the other side, shallowest first", () => {
    const p = plan(local([], ["a", "a/b"]), remote([]), new Map(), opts);
    expect(kinds(p)).to.deep.equal(["mkdirRemote:a", "mkdirRemote:a/b"]);
  });

  it("a folder deleted remotely is trashed locally only once nothing in it is kept", () => {
    const keep = plan(local([L("d/x", "1", 150)], ["d"]), remote([]), base([FB("d"), B("d/x", "0")]), opts);
    expect(kinds(keep)).to.include("mkdirRemote:d");
    const gone = plan(local([L("d/x", "0")], ["d"]), remote([]), base([FB("d"), B("d/x", "0")]), opts);
    expect(kinds(gone)).to.deep.equal(["trashLocal:d/x", "trashLocalFolder:d"]);
  });

  it("folder trashes come after file trashes, deepest first", () => {
    const p = plan(local([], []), remote([], { a: "A", "a/b": "B" }), base([FB("a"), FB("a/b"), B("z", "z")]), opts);
    expect(kinds(p).filter((k) => k.startsWith("trash"))).to.deep.equal(["trashRemoteFolder:a/b", "trashRemoteFolder:a"]);
  });
});

describe("pathsNeedingHash", () => {
  it("hashes only files whose (mtime,size) changed, new files that also exist remotely, and rename candidates", () => {
    const l = local([L("same", "", 100), L("touched", "", 101), L("both", ""), L("onlylocal", "", 1, 77), L("maybe-renamed", "", 1, 10)]);
    const r = remote([R("same", "1"), R("touched", "1"), R("both", "x"), R("gone-locally", "g")]);
    const b = base([B("same", "1"), B("touched", "1"), B("gone-locally", "g")]);
    expect(pathsNeedingHash(l, r, b).sort()).to.deep.equal(["both", "maybe-renamed", "touched"]);
  });
});
