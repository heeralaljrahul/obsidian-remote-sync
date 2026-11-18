/**
 * Runs in the browser page. Wires the fake Obsidian API, a fake Google OAuth
 * server (which really verifies PKCE and the redirect URI) and the fake Drive.
 * The REAL built main.js is loaded on top by the test.
 */
import type { HttpRequest, HttpResponse } from "../../src/gdrive/http";
import { FakeDrive, ROOT_ID } from "../helpers/fakeDrive";
import * as obsidian from "./fakeObsidian";

const enc = new TextEncoder();
const json = (status: number, body: unknown): HttpResponse => {
  const text = JSON.stringify(body);
  return { status, headers: {}, text, arrayBuffer: enc.encode(text).buffer as ArrayBuffer };
};
const b64url = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const CLIENT_ID = "e2e-client.apps.googleusercontent.com";
export const CLIENT_SECRET = "GOCSPX-e2e-secret";

class FakeGoogle {
  private codes = new Map<string, { challenge: string; redirect: string; scope: string; used: boolean }>();
  accessTokens = new Set<string>();
  refreshTokens = new Set<string>();
  /** like ticking (or not) the Drive checkbox on Google's consent screen */
  grantDrive = true;
  authorizeCalls: URL[] = [];
  private n = 0;

  /** What happens in the browser on accounts.google.com: returns the callback URL Google redirects to. */
  authorize(url: string): string {
    const u = new URL(url);
    this.authorizeCalls.push(u);
    const q = u.searchParams;
    if (u.origin + u.pathname !== "https://accounts.google.com/o/oauth2/v2/auth") throw new Error(`wrong auth endpoint ${u}`);
    if (q.get("client_id") !== CLIENT_ID) throw new Error("unknown client");
    if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) throw new Error("not a PKCE code request");
    if (q.get("access_type") !== "offline") throw new Error("no offline access requested");
    const code = `4/e2e-code-${++this.n}`;
    this.codes.set(code, { challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")!, scope: this.grantDrive ? q.get("scope")! : "openid", used: false });
    return `${q.get("redirect_uri")}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(q.get("state")!)}&scope=${encodeURIComponent(q.get("scope")!)}`;
  }

  async token(req: HttpRequest): Promise<HttpResponse> {
    const f = new URLSearchParams(String(req.body));
    if (f.get("client_id") !== CLIENT_ID || f.get("client_secret") !== CLIENT_SECRET) return json(401, { error: "invalid_client" });
    if (f.get("grant_type") === "authorization_code") {
      const c = this.codes.get(f.get("code") ?? "");
      if (!c || c.used) return json(400, { error: "invalid_grant", error_description: "Malformed auth code." });
      if (f.get("redirect_uri") !== c.redirect) return json(400, { error: "redirect_uri_mismatch" });
      const digest = await crypto.subtle.digest("SHA-256", enc.encode(f.get("code_verifier") ?? ""));
      if (b64url(digest) !== c.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      c.used = true;
      const at = `ya29.e2e-${++this.n}`;
      const rt = `1//e2e-refresh-${this.n}`;
      this.accessTokens.add(at);
      this.refreshTokens.add(rt);
      return json(200, { access_token: at, expires_in: 3599, refresh_token: rt, scope: c.scope, token_type: "Bearer" });
    }
    if (f.get("grant_type") === "refresh_token") {
      if (!this.refreshTokens.has(f.get("refresh_token") ?? "")) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      const at = `ya29.e2e-${++this.n}`;
      this.accessTokens.add(at);
      return json(200, { access_token: at, expires_in: 3599, scope: "https://www.googleapis.com/auth/drive", token_type: "Bearer" });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  revoke(req: HttpRequest): HttpResponse {
    const t = new URLSearchParams(String(req.body)).get("token") ?? "";
    this.refreshTokens.delete(t);
    return json(200, {});
  }
}

const drive = new FakeDrive();
const google = new FakeGoogle();
const requests: HttpRequest[] = [];
let offline = false;

obsidian.setNetwork(async (req) => {
  requests.push(req);
  if (offline) throw new Error("The Internet connection appears to be offline.");
  if (req.url === "https://oauth2.googleapis.com/token") return google.token(req);
  if (req.url === "https://oauth2.googleapis.com/revoke") return google.revoke(req);
  if (req.url.startsWith("https://www.googleapis.com/")) {
    const auth = req.headers?.Authorization ?? "";
    if (!google.accessTokens.has(auth.replace(/^Bearer /, ""))) return json(401, { error: { message: "Request had invalid authentication credentials." } });
    return drive.http(req);
  }
  if (req.url.startsWith("https://upload.fake/")) return drive.http(req);
  throw new Error(`unexpected host: ${req.url}`);
});

const opened: string[] = [];
window.open = ((url: string) => {
  opened.push(String(url));
  return null;
}) as typeof window.open;
let clipboard = "";
Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void (clipboard = t) }, configurable: true });

interface Device {
  name: string;
  vault: obsidian.FakeVault;
  plugin: obsidian.Plugin & Record<string, unknown>;
}

const E2E = {
  obsidian,
  drive,
  google,
  requests,
  opened,
  ROOT_ID,
  CLIENT_ID,
  CLIENT_SECRET,
  clipboard: () => clipboard,
  setOffline(v: boolean) {
    offline = v;
  },
  devices: {} as Record<string, Device>,
  /** Creates a device with its own vault and plugin instance (separate data.json and IndexedDB store). */
  async startDevice(name: string, mobile: boolean, keepFrom?: Device): Promise<Device> {
    obsidian.Platform.isMobile = mobile;
    const PluginClass = (window as unknown as { __PluginClass: new (app: obsidian.App, m: unknown) => obsidian.Plugin }).__PluginClass;
    const vault = keepFrom?.vault ?? new obsidian.FakeVault(name);
    const plugin = new PluginClass(new obsidian.App(vault), { id: "gdrive-vault-sync", version: "e2e" }) as Device["plugin"];
    if (keepFrom) plugin.__data = keepFrom.plugin.__data; // same data.json after a restart
    await (plugin as unknown as { onload(): Promise<void> }).onload();
    await new Promise((r) => setTimeout(r, 10)); // onLayoutReady
    const d = { name, vault, plugin };
    E2E.devices[name] = d;
    return d;
  },
  /** Simulates Google redirecting to the callback page, which forwards to obsidian://gdrive-sync-auth */
  async completeGoogleSignIn(d: Device) {
    const authUrl = opened[opened.length - 1];
    const cb = new URL(google.authorize(authUrl));
    const handler = d.plugin.__handlers.get("gdrive-sync-auth")!;
    await handler({ action: "gdrive-sync-auth", code: cb.searchParams.get("code")!, state: cb.searchParams.get("state")! });
  },
  settings(d: Device) {
    return d.plugin.settings as Record<string, unknown>;
  },
  async waitIdle(d: Device) {
    for (let i = 0; i < 2000 && (d.plugin as unknown as { running: boolean }).running; i++) await new Promise((r) => setTimeout(r, 5));
  },
  notices: obsidian.notices,
};

(window as unknown as { E2E: typeof E2E }).E2E = E2E;
(window as unknown as { require: (n: string) => unknown }).require = (n: string) => {
  if (n === "obsidian") return obsidian;
  throw new Error(`main.js tried to require "${n}" — not available on iOS`);
};
