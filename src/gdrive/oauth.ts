/**
 * Google OAuth 2.0 (authorization code + PKCE, offline access) using only Web
 * Crypto and the injected HTTP transport.
 *
 * Flow (desktop and iOS are identical):
 *   1. plugin opens accounts.google.com with redirect_uri = the GitHub Pages
 *      callback page (Google refuses obsidian:// for Web clients)
 *   2. callback page forwards ?code&state to obsidian://gdrive-sync-auth
 *   3. plugin checks `state`, exchanges the code with the PKCE verifier
 */
import { HttpError, parseJson, type HttpFn } from "./http";

export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export type ScopeMode = "drive" | "drive.file";

export function scopeUrl(mode: ScopeMode): string {
  return mode === "drive" ? "https://www.googleapis.com/auth/drive" : "https://www.googleapis.com/auth/drive.file";
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(byteLen = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLen)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface PendingAuth {
  verifier: string;
  state: string;
  createdAt: number;
}

export async function startAuth(clientId: string, redirectUri: string, scope: ScopeMode): Promise<{ url: string; pending: PendingAuth }> {
  const verifier = randomString(48); // 64 chars, within PKCE's 43..128
  const state = randomString(16);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopeUrl(scope),
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    access_type: "offline",
    // force the consent screen so Google always returns a refresh token
    prompt: "consent",
    state,
  });
  return { url: `${AUTH_ENDPOINT}?${params.toString()}`, pending: { verifier, state, createdAt: Date.now() } };
}

export interface Tokens {
  accessToken: string;
  /** ms since epoch */
  expiresAt: number;
  refreshToken: string;
  scope: string;
  /** When Google said this refresh token will stop working (ms). Absent = no expiry announced. */
  refreshTokenExpiresAt?: number;
  /** When this refresh token was issued (ms). */
  issuedAt?: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  /** Only sent for time-limited refresh tokens. */
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(http: HttpFn, form: Record<string, string>): Promise<TokenResponse> {
  const res = await http({
    url: TOKEN_ENDPOINT,
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams(form).toString(),
  });
  let json: TokenResponse | undefined;
  try {
    json = parseJson<TokenResponse>(res);
  } catch {
    /* handled below */
  }
  if (res.status !== 200 || !json?.access_token) {
    const reason = json?.error ? `${json.error}${json.error_description ? `: ${json.error_description}` : ""}` : `HTTP ${res.status}`;
    throw new HttpError(res.status, res.text.slice(0, 300), `Google sign-in failed (${reason})`);
  }
  return json;
}

export async function exchangeCode(
  http: HttpFn,
  a: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string; requiredScope?: ScopeMode }
): Promise<Tokens> {
  const t = await tokenRequest(http, {
    client_id: a.clientId,
    client_secret: a.clientSecret,
    code: a.code,
    code_verifier: a.verifier,
    grant_type: "authorization_code",
    redirect_uri: a.redirectUri,
  });
  if (!t.refresh_token) {
    throw new Error("Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and sign in again.");
  }
  // Google's consent screen has per-permission checkboxes; an unticked Drive box still "succeeds".
  if (a.requiredScope && t.scope !== undefined && !t.scope.split(" ").includes(scopeUrl(a.requiredScope))) {
    throw new Error("Google Drive access was not granted. Sign in again and tick the Google Drive checkbox on Google's consent screen.");
  }
  return {
    accessToken: t.access_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    refreshToken: t.refresh_token,
    scope: t.scope ?? "",
    issuedAt: Date.now(),
    refreshTokenExpiresAt: t.refresh_token_expires_in ? Date.now() + t.refresh_token_expires_in * 1000 : undefined,
  };
}

export async function refreshAccessToken(http: HttpFn, a: { clientId: string; clientSecret: string; refreshToken: string }): Promise<Tokens> {
  const t = await tokenRequest(http, {
    client_id: a.clientId,
    client_secret: a.clientSecret,
    refresh_token: a.refreshToken,
    grant_type: "refresh_token",
  });
  return {
    accessToken: t.access_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    // Google normally keeps the same refresh token; take a new one if offered.
    refreshToken: t.refresh_token ?? a.refreshToken,
    scope: t.scope ?? "",
    refreshTokenExpiresAt: t.refresh_token_expires_in ? Date.now() + t.refresh_token_expires_in * 1000 : undefined,
  };
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Hands out a valid access token, refreshing (and persisting) it when needed. */
export class TokenManager {
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly http: HttpFn,
    private readonly getConfig: () => { clientId: string; clientSecret: string; tokens: Tokens | null },
    private readonly saveTokens: (t: Tokens) => Promise<void>
  ) {}

  async accessToken(forceRefresh = false): Promise<string> {
    const { tokens } = this.getConfig();
    if (!tokens?.refreshToken) throw new AuthError("Not signed in to Google Drive. Open the plugin settings and sign in.");
    if (!forceRefresh && tokens.accessToken && tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refresh(): Promise<string> {
    const { clientId, clientSecret, tokens } = this.getConfig();
    if (!clientId || !clientSecret) throw new AuthError("Enter your OAuth client ID and secret in the plugin settings.");
    try {
      const t = await refreshAccessToken(this.http, { clientId, clientSecret, refreshToken: tokens!.refreshToken });
      t.issuedAt = tokens!.issuedAt;
      await this.saveTokens(t);
      return t.accessToken;
    } catch (e) {
      if (e instanceof HttpError && e.body.includes("invalid_grant")) {
        throw new AuthError(
          "Google rejected the saved sign-in (expired or revoked). Sign in again. If this happens every 7 days, publish the OAuth consent screen to 'In production' (see SETUP.md)."
        );
      }
      throw e;
    }
  }
}
