/** Network failure tests: every kind of bad network / bad server behaviour against the fake Drive. */
import { expect } from "chai";
import { DriveApi } from "../src/gdrive/driveApi";
import type { HttpRequest, HttpResponse } from "../src/gdrive/http";
import { TokenManager, type Tokens } from "../src/gdrive/oauth";
import { Device, kinds } from "./helpers/device";
import { FakeDrive } from "./helpers/fakeDrive";

const resp = (status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
};

async function settle(...devices: Device[]) {
  for (let round = 0; round < 3; round++) for (const d of devices) await d.sync();
}

describe("network resilience", () => {
  let drive: FakeDrive;
  let pc: Device;
  beforeEach(async () => {
    drive = new FakeDrive();
    pc = new Device(drive);
    for (let i = 0; i < 10; i++) pc.vault.put(`n${i}.md`, `note ${i}`);
    drive.addFile("from-drive.md", "d");
    await pc.sync();
  });

  it("401 (expired access token) refreshes the token once and retries", async () => {
    let tokens: Tokens = { accessToken: "old", expiresAt: Date.now() + 3600_000, refreshToken: "rt", scope: "" };
    let refreshes = 0;
    const http = async (req: HttpRequest) => {
      if (req.url.includes("oauth2.googleapis.com")) {
        refreshes++;
        return resp(200, { access_token: "new", expires_in: 3600 });
      }
      return req.headers?.Authorization === "Bearer new"
        ? resp(200, { user: { emailAddress: "me@x", displayName: "Me" } })
        : resp(401, { error: { message: "Invalid Credentials" } });
    };
    const tm = new TokenManager(
      http,
      () => ({ clientId: "c", clientSecret: "s", tokens }),
      async (t) => void (tokens = t)
    );
    const api = new DriveApi(http, (force) => tm.accessToken(force));
    expect((await api.about()).email).to.equal("me@x");
    expect(refreshes).to.equal(1);
  });

  it("random transient 5xx / 429 / dropped connections during a sync: the sync still completes correctly", async () => {
    pc.vault.put("new1.md", "x");
    drive.edit("from-drive.md", "d2");
    pc.vault.remove("n3.md");
    let i = 0;
    drive.intercept = (req) => {
      i++;
      if (req.method === "POST") return undefined; // creates are deliberately not retried; covered elsewhere
      if (i % 3 === 0) return resp(503, { error: { message: "backendError" } });
      if (i % 5 === 0) return resp(429, { error: { message: "rate" } });
      if (i % 7 === 0) throw new Error("ECONNRESET");
      return undefined;
    };
    const { res } = await pc.sync();
    drive.intercept = null;
    expect(res.failed).to.deep.equal([]);
    expect(drive.read("new1.md")).to.equal("x");
    expect(pc.vault.text("from-drive.md")).to.equal("d2");
    expect(drive.countAt("n3.md")).to.equal(0);
  });

  it("completely offline: sync fails before changing anything, and recovers later", async () => {
    pc.vault.put("offline-edit.md", "o");
    const before = pc.vault.tree();
    drive.intercept = () => {
      throw new Error("The Internet connection appears to be offline.");
    };
    let err: unknown;
    try {
      await pc.sync();
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.match(/offline/);
    expect(pc.vault.tree()).to.deep.equal(before);
    expect(pc.vault.trashed).to.deep.equal([]);
    drive.intercept = null;
    await pc.sync();
    expect(drive.read("offline-edit.md")).to.equal("o");
  });

  it("connection lost half-way through applying changes: done work is kept, the rest resumes", async () => {
    for (let i = 0; i < 8; i++) pc.vault.put(`batch${i}.md`, `b${i}`);
    let uploads = 0;
    drive.intercept = (req) => {
      if (req.url.includes("uploadType=multipart") && ++uploads > 3) throw new Error("network down");
      return undefined;
    };
    const first = await pc.sync();
    expect(first.res.done).to.equal(3);
    expect(first.res.failed.length).to.be.greaterThan(0);
    expect(first.res.stopped).to.equal(true, "stops after repeated failures instead of hammering");
    drive.intercept = null;
    pc.restart();
    await pc.sync();
    for (let i = 0; i < 8; i++) expect(drive.countAt(`batch${i}.md`)).to.equal(1);
  });

  it("garbled JSON from Drive aborts the sync without deleting anything", async () => {
    drive.edit("from-drive.md", "changed");
    pc.vault.remove("n1.md");
    drive.intercept = (req) =>
      req.url.includes("/changes?") ? { status: 200, headers: {}, text: "<html>proxy error", arrayBuffer: new ArrayBuffer(0) } : undefined;
    // a bad changes feed falls back to a full rescan, which also gets garbage here:
    const realIntercept = drive.intercept;
    drive.intercept = (req) =>
      realIntercept(req) ?? (req.url.includes("/files?") ? { status: 200, headers: {}, text: "{not json", arrayBuffer: new ArrayBuffer(0) } : undefined);
    let err: unknown;
    try {
      await pc.sync();
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.match(/JSON/);
    expect(drive.countAt("n1.md")).to.equal(1);
    expect(pc.vault.trashed).to.deep.equal([]);
  });

  it("an expired/invalid Changes cursor falls back to a full rescan", async () => {
    drive.addFile("after.md", "a");
    drive.intercept = (req) => (req.url.includes("/changes?") ? resp(410, { error: { message: "Invalid page token" } }) : undefined);
    await pc.sync();
    drive.intercept = null;
    expect(pc.vault.text("after.md")).to.equal("a");
  });

  it("a failed page in the middle of a paginated listing is retried and nothing is missed", async () => {
    const fresh = new FakeDrive();
    fresh.pageSize = 5;
    for (let i = 0; i < 23; i++) fresh.addFile(`p${i}.md`, `${i}`);
    const dev = new Device(fresh);
    let pages = 0;
    fresh.intercept = (req) => (req.url.includes("/files?") && req.url.includes("pageToken") && ++pages === 2 ? resp(503) : undefined);
    await dev.sync();
    expect(dev.vault.files.size).to.equal(23);
  });

  it("a corrupted or truncated download is detected (MD5) and never written", async () => {
    drive.edit("from-drive.md", "the real content");
    drive.intercept = (req) =>
      req.url.includes("alt=media")
        ? { status: 200, headers: {}, text: "the real cont", arrayBuffer: new TextEncoder().encode("the real cont").buffer as ArrayBuffer }
        : undefined;
    const { res } = await pc.sync();
    expect(res.skipped.map((s) => s.reason)).to.include("remote file changed during sync");
    expect(pc.vault.text("from-drive.md")).to.equal("d");
    drive.intercept = null;
    await pc.sync();
    expect(pc.vault.text("from-drive.md")).to.equal("the real content");
  });

  it("if Drive stores different bytes than we sent (checksum mismatch), the file is not marked as synced", async () => {
    pc.vault.put("n0.md", "edited");
    drive.intercept = (req) => {
      if (req.url.includes("uploadType=media")) {
        // Drive "stores" something else
        const f = [...drive.files.values()].find((x) => x.name === "n0.md")!;
        f.content = new TextEncoder().encode("garbage");
        return resp(200, {
          id: f.id,
          name: f.name,
          mimeType: "text/markdown",
          md5Checksum: "0".repeat(32),
          size: "7",
          modifiedTime: new Date().toISOString(),
          parents: f.parents,
        });
      }
      return undefined;
    };
    const { res } = await pc.sync();
    expect(res.failed[0].error).to.match(/checksum mismatch/);
    drive.intercept = null;
    const { prep } = await pc.sync();
    expect(prep.plan.actions.map((a) => a.kind)).to.not.include("adopt", "a bad upload is not accepted as in sync");
  });

  it("an expired resumable upload session restarts on the next sync", async () => {
    pc.vault.put("big.bin", new Uint8Array(12 * 1024 * 1024).fill(7));
    let chunks = 0;
    drive.intercept = (req) => (req.url.startsWith("https://upload.fake") && ++chunks === 2 ? resp(404, { error: { message: "session expired" } }) : undefined);
    const first = await pc.sync();
    expect(first.res.failed[0].error).to.match(/expired/);
    drive.intercept = null;
    await pc.sync();
    const f = [...drive.files.values()].find((x) => x.name === "big.bin")!;
    expect(f.content!.byteLength).to.equal(12 * 1024 * 1024);
  });

  it("a rate-limit storm longer than the retry budget fails gracefully and recovers later", async () => {
    pc.vault.put("n2.md", "edited");
    drive.intercept = () => resp(403, { error: { errors: [{ reason: "userRateLimitExceeded" }], message: "User Rate Limit Exceeded" } });
    let err: unknown;
    try {
      await pc.sync();
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.match(/Rate Limit|403/);
    drive.intercept = null;
    await pc.sync();
    expect(drive.read("n2.md")).to.equal("edited");
  });

  it("a plain 403 (no permission) is not retried in a loop", async () => {
    let calls = 0;
    drive.intercept = () => (
      calls++,
      resp(403, { error: { errors: [{ reason: "insufficientFilePermissions" }], message: "The user does not have sufficient permissions" } })
    );
    try {
      await pc.sync();
    } catch {
      /* expected */
    }
    expect(calls).to.be.lessThan(4);
  });

  it("high latency on every request still syncs correctly", async () => {
    pc.vault.put("slow.md", "s");
    const inner = drive.http;
    const slow = async (req: HttpRequest) => {
      await new Promise((r) => setTimeout(r, 15));
      return inner(req);
    };
    (drive as unknown as { http: typeof slow }).http = slow;
    pc.restart();
    await pc.sync();
    (drive as unknown as { http: typeof inner }).http = inner;
    expect(drive.read("slow.md")).to.equal("s");
  });

  it("after any failure pattern, a clean network converges both devices", async () => {
    const phone = new Device(drive);
    await phone.sync();
    pc.vault.put("pc.md", "from pc");
    phone.vault.put("phone.md", "from phone");
    let i = 0;
    drive.intercept = (req) => (++i % 4 === 0 && req.method !== "POST" ? resp(500) : undefined);
    try {
      await pc.sync();
      await phone.sync();
    } catch {
      /* some syncs may abort */
    }
    drive.intercept = null;
    await settle(pc, phone);
    expect(pc.vault.tree()).to.deep.equal(phone.vault.tree());
    expect(pc.vault.tree()).to.deep.equal(drive.tree());
    expect(kinds((await pc.sync()).prep)).to.deep.equal([]);
  });
});
