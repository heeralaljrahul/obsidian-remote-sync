/**
 * Probes against Google's REAL endpoints (no credentials needed): checks that
 * our assumptions about Google's error formats and status codes hold.
 * Skipped automatically when Google isn't reachable (e.g. offline).
 */
import { expect } from "chai";
import { DriveApi } from "../src/gdrive/driveApi";
import { HttpError, isRetryable, lowerHeaders, withRetry, type HttpFn } from "../src/gdrive/http";
import { refreshAccessToken, startAuth, TokenManager } from "../src/gdrive/oauth";

const fetchHttp: HttpFn = async (req) => {
  const r = await fetch(req.url, {
    method: req.method ?? "GET",
    headers: { ...(req.headers ?? {}), ...(req.contentType ? { "Content-Type": req.contentType } : {}) },
    body: req.body as BodyInit | undefined,
    redirect: "manual",
  });
  const buf = await r.arrayBuffer();
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => (headers[k] = v));
  return { status: r.status, headers: lowerHeaders(headers), arrayBuffer: buf, text: new TextDecoder().decode(buf) };
};

describe("live Google endpoints (no credentials)", function () {
  this.timeout(30000);
  before(async function () {
    try {
      await fetch("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(8000) });
    } catch {
      this.skip();
    }
  });

  it("token endpoint: a bad client gives a clear invalid_client error", async () => {
    let err: unknown;
    try {
      await refreshAccessToken(fetchHttp, { clientId: "000-fake.apps.googleusercontent.com", clientSecret: "x", refreshToken: "1//bogus" });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(HttpError);
    expect((err as HttpError).status).to.equal(401);
    expect(String(err)).to.match(/invalid_client/);
  });

  it("TokenManager surfaces Google's real rejection without retrying forever", async () => {
    const tm = new TokenManager(
      withRetry(fetchHttp, { maxRetries: 2 }),
      () => ({
        clientId: "000-fake.apps.googleusercontent.com",
        clientSecret: "x",
        tokens: { accessToken: "", expiresAt: 0, refreshToken: "1//bogus", scope: "" },
      }),
      async () => {}
    );
    let err: unknown;
    const t = Date.now();
    try {
      await tm.accessToken();
    } catch (e) {
      err = e;
    }
    expect(String(err)).to.match(/Google sign-in failed \(invalid_client/);
    expect(Date.now() - t).to.be.lessThan(10000, "401 is not retried");
  });

  it("Drive API: an invalid access token gives 401 with Google's real message, tried once with a refreshed token, not looped", async () => {
    let tokenCalls = 0;
    const api = new DriveApi(withRetry(fetchHttp), async () => (tokenCalls++, "ya29.invalid"));
    let err: unknown;
    try {
      await api.about();
    } catch (e) {
      err = e;
    }
    expect((err as HttpError).status).to.equal(401);
    expect(String(err)).to.match(/invalid authentication credentials/);
    expect(tokenCalls).to.equal(2);
  });

  it("Drive API: a request without auth gets 403, which is not treated as a retryable rate limit", async () => {
    const r = await fetchHttp({ url: "https://www.googleapis.com/drive/v3/files?pageSize=1" });
    expect(r.status).to.equal(403);
    expect(isRetryable(r)).to.equal(false);
  });

  it("our files.list query syntax is accepted by Drive's parser (fails on auth, not on the query)", async () => {
    const q = "('abc' in parents or 'd\\'ef' in parents) and trashed = false";
    const r = await fetchHttp({
      url: `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, fields: "nextPageToken,files(id)" })}`,
      headers: { Authorization: "Bearer ya29.invalid" },
    });
    expect(r.status).to.equal(401);
    expect(r.text).to.not.match(/Invalid Value|invalid query/i);
  });

  it("Google's sign-in page parses our authorization URL (fails only on the fake client ID)", async () => {
    const { url } = await startAuth("000-fake.apps.googleusercontent.com", "https://heeralaljrahul.github.io/obsidian-remote-sync/callback/", "drive");
    const r = await fetchHttp({ url });
    const body = r.text;
    // Google rejects the unknown client, not a malformed request.
    expect(body).to.not.match(/invalid_request|Missing required parameter|code_challenge/i);
    expect(r.status === 302 || r.status === 400 || r.status === 401 || r.status === 200).to.equal(true);
  });
});
