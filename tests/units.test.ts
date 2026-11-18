import { expect } from "chai";
import { multipartBody, qEscape } from "../src/gdrive/driveApi";
import { isRetryable, withRetry, type HttpResponse } from "../src/gdrive/http";
import { AuthError, exchangeCode, pkceChallenge, startAuth, TokenManager, type Tokens } from "../src/gdrive/oauth";
import { parseFolderId } from "../src/settings";
import { DEFAULT_IGNORE_PATTERNS, IgnoreFilter } from "../src/sync/ignore";
import { normKey } from "../src/sync/paths";
import { reviewReason } from "../src/sync/planView";
import type { Action } from "../src/sync/types";

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  text: typeof body === "string" ? body : JSON.stringify(body),
  arrayBuffer: new ArrayBuffer(0),
});

describe("ignore rules", () => {
  const f = new IgnoreFilter({ configDir: ".obsidian", syncConfigDir: false, patterns: DEFAULT_IGNORE_PATTERNS + "\nTemplates/\n*.tmp\narchive/**/old-*.md" });
  const cases: Array<[string, boolean, boolean]> = [
    ["notes/a.md", false, false],
    [".obsidian/app.json", false, true],
    [".trash/x.md", false, true],
    ["folder/.hidden.md", false, true],
    ["sub/.DS_Store", false, true],
    ["Templates", true, true],
    ["Templates/daily.md", false, true],
    ["x/y.tmp", false, true],
    ["archive/2020/q1/old-plan.md", false, true],
    ["archive/new-plan.md", false, false],
  ];
  for (const [p, isFolder, expected] of cases) {
    it(`${p} -> ${expected ? "ignored" : "synced"}`, () => expect(f.isIgnored(p, isFolder)).to.equal(expected));
  }
  it("with config sync on, .obsidian syncs except this plugin's folder and workspace files", () => {
    const g = new IgnoreFilter({ configDir: ".obsidian", syncConfigDir: true, patterns: DEFAULT_IGNORE_PATTERNS });
    expect(g.isIgnored(".obsidian/app.json", false)).to.equal(false);
    expect(g.isIgnored(".obsidian/plugins/gdrive-vault-sync/data.json", false)).to.equal(true);
    expect(g.isIgnored(".obsidian/workspace.json", false)).to.equal(true);
  });
});

describe("paths", () => {
  it("normalises iOS-style NFD names and slashes", () => {
    expect(normKey("/Café/x//y.md/")).to.equal("Café/x/y.md");
  });
  it("parses a folder ID from a Drive link", () => {
    expect(parseFolderId("https://drive.google.com/drive/folders/1AbC_d-9?usp=sharing")).to.equal("1AbC_d-9");
    expect(parseFolderId(" 1AbC ")).to.equal("1AbC");
  });
  it("escapes quotes in Drive queries", () => {
    expect(qEscape("Rahul's notes\\x")).to.equal("Rahul\\'s notes\\\\x");
  });
});

describe("HTTP retry", () => {
  it("retries 429, 5xx and rate-limit 403 but not a plain 403/404", () => {
    expect(isRetryable(res(429))).to.equal(true);
    expect(isRetryable(res(503))).to.equal(true);
    expect(isRetryable(res(403, { error: { errors: [{ reason: "rateLimitExceeded" }] } }))).to.equal(true);
    expect(isRetryable(res(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }))).to.equal(false);
    expect(isRetryable(res(404))).to.equal(false);
  });
  it("backs off exponentially, honours Retry-After, and gives up after maxRetries", async () => {
    const delays: number[] = [];
    let calls = 0;
    const http = withRetry(async () => (calls++, res(429, {}, calls === 2 ? { "retry-after": "30" } : {})), {
      maxRetries: 4,
      sleep: async (ms) => void delays.push(ms),
      random: () => 0,
    });
    const r = await http({ url: "x" });
    expect(r.status).to.equal(429);
    expect(calls).to.equal(5);
    expect(delays).to.deep.equal([1000, 30000, 4000, 8000]);
  });
  it("never re-sends a create after a network error (it may already exist in Drive)", async () => {
    let calls = 0;
    const http = withRetry(
      async () => {
        calls++;
        throw new Error("connection reset");
      },
      { sleep: async () => {} }
    );
    let err: unknown;
    try {
      await http({ url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", method: "POST" });
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.contain("connection reset");
    expect(calls).to.equal(1);
  });
  it("does retry a create that was rejected with 429 (nothing was created)", async () => {
    let calls = 0;
    const http = withRetry(async () => (calls++ === 0 ? res(429) : res(200)), { sleep: async () => {} });
    expect((await http({ url: "https://www.googleapis.com/drive/v3/files", method: "POST" })).status).to.equal(200);
    expect(calls).to.equal(2);
  });
  it("stops retrying at once when the device goes offline", async () => {
    let calls = 0;
    const http = withRetry(async () => (calls++, res(503)), { sleep: async () => {}, giveUp: () => calls >= 2 });
    expect((await http({ url: "x" })).status).to.equal(503);
    expect(calls).to.equal(2);
  });
  it("retries network errors", async () => {
    let calls = 0;
    const http = withRetry(
      async () => {
        if (calls++ < 2) throw new Error("offline");
        return res(200);
      },
      { sleep: async () => {} }
    );
    expect((await http({ url: "x" })).status).to.equal(200);
  });
});

describe("OAuth", () => {
  it("PKCE S256 matches the RFC 7636 appendix B test vector", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).to.equal("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("builds an offline, consent, S256 auth URL with state and the chosen scope", async () => {
    const { url, pending } = await startAuth("cid", "https://example.github.io/cb/", "drive");
    const q = new URL(url).searchParams;
    expect(q.get("access_type")).to.equal("offline");
    expect(q.get("prompt")).to.equal("consent");
    expect(q.get("code_challenge_method")).to.equal("S256");
    expect(q.get("code_challenge")).to.equal(await pkceChallenge(pending.verifier));
    expect(q.get("state")).to.equal(pending.state);
    expect(q.get("scope")).to.equal("https://www.googleapis.com/auth/drive");
    expect(q.get("redirect_uri")).to.equal("https://example.github.io/cb/");
    expect(pending.verifier.length).to.be.within(43, 128);
  });
  it("rejects a sign-in where the Drive checkbox was left unticked", async () => {
    const http = async () => res(200, { access_token: "a", expires_in: 3600, refresh_token: "r", scope: "openid" });
    let err: unknown;
    try {
      await exchangeCode(http, { clientId: "c", clientSecret: "s", redirectUri: "u", code: "x", verifier: "v", requiredScope: "drive" });
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.match(/tick the Google Drive checkbox/);
    const ok = await exchangeCode(async () => res(200, { access_token: "a", expires_in: 3600, refresh_token: "r", scope: "https://www.googleapis.com/auth/drive" }), {
      clientId: "c", clientSecret: "s", redirectUri: "u", code: "x", verifier: "v", requiredScope: "drive",
    });
    expect(ok.refreshToken).to.equal("r");
  });
  it("records when a time-limited refresh token expires, and no expiry otherwise", async () => {
    const base = { access_token: "a", expires_in: 3600, refresh_token: "r", scope: "https://www.googleapis.com/auth/drive" };
    const args = { clientId: "c", clientSecret: "s", redirectUri: "u", code: "x", verifier: "v" };
    const limited = await exchangeCode(async () => res(200, { ...base, refresh_token_expires_in: 604799 }), args);
    expect(Math.round((limited.refreshTokenExpiresAt! - Date.now()) / 86_400_000)).to.equal(7);
    const forever = await exchangeCode(async () => res(200, base), args);
    expect(forever.refreshTokenExpiresAt).to.equal(undefined);
    expect(forever.issuedAt).to.be.closeTo(Date.now(), 1000);
  });
  it("keeps the original sign-in date across access-token refreshes", async () => {
    let tokens: Tokens = { accessToken: "", expiresAt: 0, refreshToken: "rt", scope: "", issuedAt: 1234 };
    const tm = new TokenManager(async () => res(200, { access_token: "n", expires_in: 3600 }), () => ({ clientId: "c", clientSecret: "s", tokens }), async (t) => void (tokens = t));
    await tm.accessToken();
    expect(tokens.issuedAt).to.equal(1234);
    expect(tokens.refreshTokenExpiresAt).to.equal(undefined);
  });
  it("refreshes an expired access token once, even with concurrent callers, and saves it", async () => {
    let tokens: Tokens = { accessToken: "old", expiresAt: 0, refreshToken: "rt", scope: "" };
    let calls = 0;
    const tm = new TokenManager(
      async (req) => {
        calls++;
        expect(String(req.body)).to.contain("grant_type=refresh_token");
        return res(200, { access_token: "new", expires_in: 3600 });
      },
      () => ({ clientId: "c", clientSecret: "s", tokens }),
      async (t) => void (tokens = t)
    );
    const [a, b] = await Promise.all([tm.accessToken(), tm.accessToken()]);
    expect([a, b, calls, tokens.refreshToken]).to.deep.equal(["new", "new", 1, "rt"]);
    expect(await tm.accessToken()).to.equal("new");
    expect(calls).to.equal(1);
  });
  it("turns invalid_grant into a clear 'sign in again' error", async () => {
    const tm = new TokenManager(
      async () => res(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }),
      () => ({ clientId: "c", clientSecret: "s", tokens: { accessToken: "", expiresAt: 0, refreshToken: "rt", scope: "" } }),
      async () => {}
    );
    let err: unknown;
    try {
      await tm.accessToken();
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(AuthError);
    expect(String(err)).to.match(/In production/);
  });
});

describe("multipart upload body", () => {
  it("contains JSON metadata and the exact binary content", () => {
    const data = new Uint8Array([0, 13, 10, 255, 45, 45]).buffer;
    const { body, contentType } = multipartBody({ name: "a.bin" }, data, "application/octet-stream");
    const boundary = contentType.split("boundary=")[1];
    const bytes = new Uint8Array(body);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith(`--${boundary}\r\nContent-Type: application/json`)).to.equal(true);
    expect(text).to.contain('{"name":"a.bin"}');
    expect(text.endsWith(`\r\n--${boundary}--`)).to.equal(true);
    const start = text.indexOf("application/octet-stream\r\n\r\n") + "application/octet-stream\r\n\r\n".length;
    expect([...bytes.slice(start, start + 6)]).to.deep.equal([0, 13, 10, 255, 45, 45]);
  });
});

describe("review rules", () => {
  const trash = (n: number): Action[] => Array.from({ length: n }, (_, i) => ({ kind: "trashLocal", path: `${i}`, local: { path: `${i}`, mtime: 1, size: 1 } }));
  it("first sync and dry runs always need review; many deletions need review", () => {
    expect(reviewReason({ firstSync: true, actions: [] }, false, 20)).to.equal("first-sync");
    expect(reviewReason({ firstSync: false, actions: [] }, true, 20)).to.equal("dry-run");
    expect(reviewReason({ firstSync: false, actions: trash(20) }, false, 20)).to.equal(null);
    expect(reviewReason({ firstSync: false, actions: trash(21) }, false, 20)).to.equal("many-deletions");
    expect(reviewReason({ firstSync: false, actions: trash(1) }, false, 0)).to.equal("many-deletions");
  });
});
