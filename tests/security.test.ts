/** Security tests: path traversal, secret handling, injection, OAuth checks. */
import { expect } from "chai";
import { DriveApi } from "../src/gdrive/driveApi";
import { HttpError } from "../src/gdrive/http";
import {
  checkAuthCallback,
  exchangeCode,
  PENDING_AUTH_MAX_AGE_MS,
  randomString,
  redirectUriProblem,
  startAuth,
  TokenManager,
  type Tokens,
} from "../src/gdrive/oauth";
import { SyncLog } from "../src/log";
import { md5Hex } from "../src/sync/engine";
import { execute } from "../src/sync/executor";
import { IgnoreFilter } from "../src/sync/ignore";
import { isSafeVaultPath, normKey } from "../src/sync/paths";
import { BaseStore, MemoryKV } from "../src/sync/store";
import { Device } from "./helpers/device";
import { FakeDrive, ROOT_ID } from "./helpers/fakeDrive";

describe("security", () => {
  describe("path traversal from Drive file names", () => {
    const evil = ["..\\..\\evil.md", "..", "a:b.md", "con\u0000.md", "x\u001b[31m.md", "sub\\..\\..\\up.md", "C:\\Windows\\x.md"];

    it("unsafe Drive names are skipped, never written, and noted", async () => {
      const drive = new FakeDrive();
      const pc = new Device(drive);
      const notes: string[] = [];
      (pc.provider as unknown as { log: (l: string, m: string) => void }).log = (_l, m) => notes.push(m);
      for (const name of evil) drive.addFile(name, "pwned");
      drive.addFile("ok.md", "fine");
      const { res } = await pc.sync();
      expect([...pc.vault.files.keys()]).to.deep.equal(["ok.md"]);
      expect(res.failed).to.deep.equal([]);
      expect(notes.filter((n) => n.startsWith("skipping Drive item"))).to.have.length(evil.length);
      for (const p of pc.vault.files.keys()) expect(isSafeVaultPath(p), p).to.equal(true);
    });

    it("unsafe names inside folders are skipped too", async () => {
      const drive = new FakeDrive();
      const pc = new Device(drive);
      drive.addFile("notes/..\\..\\..\\escape.md", "pwned");
      await pc.sync();
      expect([...pc.vault.files.keys()]).to.deep.equal([]);
    });

    it("the executor refuses unsafe paths even if a bad plan reaches it (defence in depth)", async () => {
      const drive = new FakeDrive();
      const pc = new Device(drive);
      const id = drive.addFile("x.md", "pwned");
      const remote = { path: "../outside.md", id, md5: md5Hex(new TextEncoder().encode("pwned").buffer as ArrayBuffer), size: 5, modifiedTime: 1 };
      for (const badPath of ["../outside.md", "/etc/passwd", "a/../../b.md", "C:/Windows/x.md", "a\\..\\b.md"]) {
        const res = await execute(
          { firstSync: false, actions: [{ kind: "download", path: badPath, reason: "new", remote: { ...remote, path: badPath } }] },
          { local: pc.vault, remote: pc.provider, base: new BaseStore(pc.kv, ROOT_ID), log: new SyncLog(null), md5: md5Hex }
        );
        expect(res.failed.map((f) => f.error)[0], badPath).to.match(/refusing to touch unsafe path/);
      }
      expect(pc.vault.files.size).to.equal(0);
    });

    it("path normalisation can't sneak the plugin's own folder past the ignore rules", () => {
      const f = new IgnoreFilter({ configDir: ".obsidian", syncConfigDir: true, patterns: "" });
      for (const p of [
        ".obsidian/plugins/gdrive-vault-sync/data.json",
        "/.obsidian//plugins/gdrive-vault-sync/data.json/",
        ".obsidian\\plugins\\gdrive-vault-sync\\data.json",
      ]) {
        expect(f.isIgnored(normKey(p), false), p).to.equal(true);
      }
    });
  });

  describe("secrets", () => {
    const TOKEN = "ya29.SECRET-ACCESS-TOKEN";

    it("the access token is only ever sent to Google APIs, never to the resumable upload host or elsewhere", async () => {
      const drive = new FakeDrive();
      const pc = new Device(drive);
      const http = drive.http;
      const { GoogleDriveProvider } = await import("../src/gdrive/provider");
      pc.provider = new GoogleDriveProvider(new DriveApi(http, async () => TOKEN), pc.kv, ROOT_ID, () => {});
      pc.vault.put("small.md", "x");
      pc.vault.put("big.bin", new Uint8Array(6 * 1024 * 1024));
      drive.addFile("remote.md", "r");
      await pc.sync();
      const withAuth = drive.requests.filter((r) => r.headers?.Authorization);
      expect(withAuth.length).to.be.greaterThan(3);
      for (const r of withAuth) expect(new URL(r.url).hostname, r.url).to.equal("www.googleapis.com");
      for (const r of drive.requests.filter((x) => x.url.startsWith("https://upload.fake"))) expect(r.headers?.Authorization).to.equal(undefined);
    });

    it("tokens never end up in the sync log, even when requests fail", async () => {
      const drive = new FakeDrive();
      const pc = new Device(drive);
      const { GoogleDriveProvider } = await import("../src/gdrive/provider");
      pc.provider = new GoogleDriveProvider(new DriveApi(drive.http, async () => TOKEN), pc.kv, ROOT_ID, () => {});
      pc.vault.put("a.md", "a");
      let n = 0;
      drive.intercept = (req) =>
        req.method === "POST" && n++ < 1
          ? { status: 403, headers: {}, text: JSON.stringify({ error: { message: "forbidden" } }), arrayBuffer: new ArrayBuffer(0) }
          : undefined;
      await pc.sync();
      const all = JSON.stringify(pc.log.all());
      expect(all).to.contain("FAILED");
      expect(all).to.not.contain(TOKEN);
      expect(all).to.not.contain("Bearer");
    });

    it("HTTP errors never include the Authorization header", async () => {
      const api = new DriveApi(
        async () => ({ status: 500, headers: {}, text: '{"error":{"message":"boom"}}', arrayBuffer: new ArrayBuffer(0) }),
        async () => TOKEN
      );
      let err: unknown;
      try {
        await api.about();
      } catch (e) {
        err = e;
      }
      expect(err).to.be.instanceOf(HttpError);
      expect(String(err) + JSON.stringify(err)).to.not.contain(TOKEN);
    });

    it("the client secret is only sent to Google's token endpoint, never put in the browser URL", async () => {
      const { url } = await startAuth("my-client-id", "https://example.github.io/cb/", "drive");
      expect(url).to.not.contain("secret");
      const seen: string[] = [];
      await exchangeCode(
        async (req) => {
          seen.push(req.url);
          expect(String(req.body)).to.contain("client_secret=SECRET");
          return { status: 200, headers: {}, text: JSON.stringify({ access_token: "a", expires_in: 1, refresh_token: "r" }), arrayBuffer: new ArrayBuffer(0) };
        },
        { clientId: "c", clientSecret: "SECRET", redirectUri: "u", code: "x", verifier: "v" }
      );
      expect(seen).to.deep.equal(["https://oauth2.googleapis.com/token"]);
    });

    it("a refresh failure message does not echo the refresh token", async () => {
      const tokens: Tokens = { accessToken: "", expiresAt: 0, refreshToken: "1//REFRESH-SECRET", scope: "" };
      const tm = new TokenManager(
        async () => ({ status: 400, headers: {}, text: JSON.stringify({ error: "invalid_grant" }), arrayBuffer: new ArrayBuffer(0) }),
        () => ({ clientId: "c", clientSecret: "s", tokens }),
        async () => {}
      );
      let err: unknown;
      try {
        await tm.accessToken();
      } catch (e) {
        err = e;
      }
      expect(String(err)).to.not.contain("REFRESH-SECRET");
    });
  });

  describe("OAuth flow checks", () => {
    const pending = { verifier: "v", state: "S1", createdAt: 1_000_000 };
    it("rejects a callback with the wrong state, no pending sign-in, or an expired one", () => {
      expect(checkAuthCallback(pending, "S1", 1_000_001)).to.equal(null);
      expect(checkAuthCallback(pending, "evil", 1_000_001)).to.match(/state mismatch/);
      expect(checkAuthCallback(pending, "", 1_000_001)).to.match(/state mismatch/);
      expect(checkAuthCallback(null, "S1")).to.match(/No sign-in in progress/);
      expect(checkAuthCallback(pending, "S1", 1_000_000 + PENDING_AUTH_MAX_AGE_MS + 1)).to.match(/expired/);
    });
    it("the paste-a-code fallback (no state) still requires a fresh pending sign-in", () => {
      expect(checkAuthCallback(pending, undefined, 1_000_001)).to.equal(null);
      expect(checkAuthCallback(null, undefined)).to.match(/No sign-in/);
    });
    it("only https redirect URIs are accepted (http only for localhost)", async () => {
      expect(redirectUriProblem("https://heeralaljrahul.github.io/obsidian-remote-sync/callback/")).to.equal(null);
      expect(redirectUriProblem("http://localhost:8080/cb")).to.equal(null);
      expect(redirectUriProblem("http://example.com/cb")).to.match(/https/);
      expect(redirectUriProblem("javascript:alert(1)")).to.match(/https/);
      expect(redirectUriProblem("not a url")).to.match(/valid URL/);
      let err: unknown;
      try {
        await startAuth("c", "http://evil.example/cb", "drive");
      } catch (e) {
        err = e;
      }
      expect(String(err)).to.match(/https/);
    });
    it("PKCE verifiers and states are long, URL-safe and unique", async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 2000; i++) {
        const { pending: p } = await startAuth("c", "https://x.test/cb", "drive");
        expect(p.verifier).to.match(/^[A-Za-z0-9_-]{43,128}$/);
        expect(p.state).to.match(/^[A-Za-z0-9_-]{20,}$/);
        expect(seen.has(p.verifier) || seen.has(p.state)).to.equal(false);
        seen.add(p.verifier).add(p.state);
      }
      expect(randomString(32)).to.have.length(43);
    });
  });

  describe("Drive query injection", () => {
    it("names with quotes and backslashes are matched exactly (no duplicate uploads, no wrong match)", async () => {
      const drive = new FakeDrive();
      const pc = new Device(drive);
      for (const n of ["Rahul's notes.md", "it's ' or name contains 'a.md", "quote\" and 'mix'.md"]) pc.vault.put(n, n);
      drive.addFile("a.md", "decoy");
      await pc.sync();
      const { prep } = await pc.sync();
      expect(prep.plan.actions).to.deep.equal([]);
      for (const n of ["Rahul's notes.md", "it's ' or name contains 'a.md"]) expect(drive.countAt(n), n).to.equal(1);
      expect(drive.read("a.md")).to.equal("decoy");
    });
  });

  describe("local IndexedDB state is isolated per Drive folder", () => {
    it("two folders never share base state", async () => {
      const kv = new MemoryKV();
      await new BaseStore(kv, "FOLDER_A").put({ path: "x.md", isFolder: false, syncedAt: 1 });
      expect((await new BaseStore(kv, "FOLDER_B").loadAll()).size).to.equal(0);
      expect((await new BaseStore(kv, "FOLDER_A").loadAll()).size).to.equal(1);
    });
  });
});
