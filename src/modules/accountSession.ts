import { pilotOrigin } from "../shared/pilot";
import { appFetch } from "../shared/http";
import { sha256Hex } from "../shared/digest";

export const SESSION_KEY = "liftlog.session";
export const ANONYMOUS_WORKSPACE = "anonymous";
export const ANONYMOUS_DATABASE = "liftlog.db";

export type AccountSession = {
  email: string;
  displayName: string;
  accountId: string;
  token: string;
  expiresAt: string;
  cloudSyncConsent?: string | null;
  serverOrigin?: string | null;
};

export type LocalAccess =
  | { mode: "anonymous" }
  | { mode: "signed-in"; email: string; displayName: string; accountKey: string; accountId: string | null; serverOrigin?: string | null; token: string; expiresAt: string }
  | { mode: "signed-out-hold"; email: string; displayName: string; accountKey: string; accountId: string | null; serverOrigin?: string | null };

export type AuthFailure = "AUTH_REJECTED" | "RATE_LIMITED" | "EMAIL_IN_USE" | "INVALID_PASSWORD" | "INVALID_INPUT" | "UNAVAILABLE";

export type AuthAttempt = { ok: true; session: AccountSession } | { ok: false; code: AuthFailure };

export type WorkspaceStamp = { generation: number; workspaceId: string };

export type SecretStore = {
  persistent: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

const SECRET_PREFERENCE = /token|password|bearer|secret|authorization/i;

export function memorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    persistent: false,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
  };
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function accountKeyForEmail(email: string): string {
  return sha256Hex(normalizeEmail(email));
}

export function workspaceIdFor(access: LocalAccess): string {
  if (access.mode === "anonymous") return ANONYMOUS_WORKSPACE;
  return access.accountId ?? access.accountKey;
}

export function databaseFile(access: LocalAccess): string {
  if (access.mode === "anonymous") return ANONYMOUS_DATABASE;
  if (access.accountId) {
    if (!safeAccountId(access.accountId)) throw new Error("Invalid account database identity");
    return `liftlog-${access.accountId}.db`;
  }
  return `liftlog-${access.accountKey}.db`;
}

export function legacyDatabaseFile(email: string): string {
  return `liftlog-${accountKeyForEmail(email)}.db`;
}

export function signedInAccess(session: AccountSession): Extract<LocalAccess, { mode: "signed-in" }> {
  const email = normalizeEmail(session.email);
  return {
    mode: "signed-in",
    email,
    displayName: session.displayName,
    accountKey: accountKeyForEmail(email),
    accountId: session.accountId,
    serverOrigin: session.serverOrigin ?? null,
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

export function holdAccess(access: Extract<LocalAccess, { mode: "signed-in" }>): LocalAccess {
  return { mode: "signed-out-hold", email: access.email, displayName: access.displayName, accountKey: access.accountKey, accountId: access.accountId, serverOrigin: access.serverOrigin ?? null };
}

export function serializeAccess(access: LocalAccess): string | null {
  if (access.mode === "anonymous") return null;
  if (access.mode === "signed-in") {
    return JSON.stringify({
      email: access.email,
      displayName: access.displayName,
      accountKey: access.accountKey,
      accountId: access.accountId,
      serverOrigin: access.serverOrigin ?? null,
      token: access.token,
      expiresAt: access.expiresAt,
    });
  }
  return JSON.stringify({
    email: access.email,
    displayName: access.displayName,
    accountKey: access.accountKey,
    accountId: access.accountId,
    serverOrigin: access.serverOrigin ?? null,
    token: null,
    expiresAt: null,
  });
}

export function readStoredAccess(raw: string | null, now: string): { access: LocalAccess; rewrite: string | null; discard: boolean } {
  if (!raw) return { access: { mode: "anonymous" }, rewrite: null, discard: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { access: { mode: "anonymous" }, rewrite: null, discard: true };
  }
  if (!parsed || typeof parsed !== "object") return { access: { mode: "anonymous" }, rewrite: null, discard: true };
  const body = parsed as Record<string, unknown>;
  if ("password" in body) return { access: { mode: "anonymous" }, rewrite: null, discard: true };
  if (typeof body.email !== "string" || typeof body.displayName !== "string" || typeof body.accountKey !== "string") {
    return { access: { mode: "anonymous" }, rewrite: null, discard: true };
  }
  const email = normalizeEmail(body.email);
  const accountKey = body.accountKey;
  if (accountKey !== accountKeyForEmail(email)) return { access: { mode: "anonymous" }, rewrite: null, discard: true };
  const accountId = typeof body.accountId === "string" && body.accountId ? body.accountId : null;
  if (accountId && !safeAccountId(accountId)) return { access: { mode: "anonymous" }, rewrite: null, discard: true };
  const token = typeof body.token === "string" && body.token ? body.token : null;
  const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : null;
  let serverOrigin: string | null = null;
  try { if(typeof body.serverOrigin === "string") serverOrigin=normalizeServerUrl(body.serverOrigin); } catch { /* Legacy/untrusted destinations require fresh sign-in. */ }
  const fresh = serverOrigin !== null && token !== null && expiresAt !== null && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.parse(now);
  if (fresh) {
    return {
      access: { mode: "signed-in", email, displayName: body.displayName, accountKey, accountId, serverOrigin, token, expiresAt },
      rewrite: null,
      discard: false,
    };
  }
  const access: LocalAccess = { mode: "signed-out-hold", email, displayName: body.displayName, accountKey, accountId, serverOrigin };
  return { access, rewrite: token || expiresAt ? serializeAccess(access) : null, discard: false };
}

export function accessAfterAuthResult(current: LocalAccess, attempt: AuthAttempt): LocalAccess {
  if (!attempt.ok) return current;
  return signedInAccess(attempt.session);
}

export function gateProtectedCall(input: {
  access: LocalAccess;
  sent: WorkspaceStamp;
  active: WorkspaceStamp;
  consent: boolean;
  now: string;
  targetServer?: string;
}): { action: "send"; authorization: string | null } | { action: "stop"; code: "SIGN_IN" | "STALE" | "CONSENT_REQUIRED" | "WORKSPACE_MISMATCH" | "INVALID_INPUT" } {
  if (input.sent.generation !== input.active.generation || input.sent.workspaceId !== input.active.workspaceId) {
    return { action: "stop", code: "STALE" };
  }
  if (!input.consent) return { action: "stop", code: "CONSENT_REQUIRED" };
  if (input.access.mode === "signed-out-hold") return { action: "stop", code: "SIGN_IN" };
  if (input.access.mode === "signed-in") {
    if(input.targetServer) {
      try {normalizeServerUrl(input.targetServer);} catch {return {action:"stop",code:"INVALID_INPUT"};}
      try {assertCredentialDestination(input.targetServer,input.access.serverOrigin);} catch {return {action:"stop",code:"WORKSPACE_MISMATCH"};}
    }
    if (!Number.isFinite(Date.parse(input.access.expiresAt)) || Date.parse(input.access.expiresAt) <= Date.parse(input.now)) {
      return { action: "stop", code: "SIGN_IN" };
    }
    return { action: "send", authorization: input.access.token };
  }
  return { action: "send", authorization: null };
}

export function sameWorkspace(sent: WorkspaceStamp, active: WorkspaceStamp): boolean {
  return sent.generation === active.generation && sent.workspaceId === active.workspaceId;
}

export function commitIfCurrent<T>(sent: WorkspaceStamp, active: WorkspaceStamp, commit: () => T): T | null {
  if (!sameWorkspace(sent, active)) return null;
  return commit();
}

export function draftForWorkspace(fromWorkspace: string, toWorkspace: string, draft: string): string {
  return fromWorkspace === toWorkspace ? draft : "";
}

export function authHeaders(authorization: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (authorization) headers.Authorization = `Bearer ${authorization}`;
  return headers;
}

export function isSecretPreferenceKey(key: string): boolean {
  return SECRET_PREFERENCE.test(key);
}

export function authFailureMessage(code: AuthFailure): string {
  switch (code) {
    case "AUTH_REJECTED":
      return "That email or password did not match.";
    case "RATE_LIMITED":
      return "Too many attempts. Wait and try again.";
    case "EMAIL_IN_USE":
      return "An account with that email already exists. Sign in instead.";
    case "INVALID_PASSWORD":
      return "Use at least 10 characters and avoid a common password.";
    case "INVALID_INPUT":
      return "Check the email and password.";
    case "UNAVAILABLE":
      return "The server could not be reached. Workouts on this phone were not changed.";
  }
}

export function logoutNotice(outcome: "local" | "revoked" | "unreachable" | "rejected"): string {
  if (outcome === "revoked") {
    return "Signed out on this phone and on the server. That account's workouts stay in their own workspace.";
  }
  if (outcome === "unreachable") {
    return "Signed out on this phone. The server could not be reached, so the session was not revoked there. That account's workouts stay in their own workspace.";
  }
  if (outcome === "rejected") {
    return "Signed out on this phone. The server did not confirm that the session was revoked. That account's workouts stay in their own workspace.";
  }
  return "Signed out on this phone. That account's workouts stay in their own workspace.";
}

export async function submitCredentials(input: {
  baseUrl: string;
  mode: "register" | "login";
  email: string;
  password: string;
  displayName?: string;
  cloudSyncConsent?: string;
  fetchImpl?: typeof fetch;
}): Promise<AuthAttempt> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@") || !input.password) return { ok: false, code: "INVALID_INPUT" };
  const fetchImpl = input.fetchImpl ?? appFetch;
  const path = input.mode === "register" ? "/api/v1/auth/register" : "/api/v1/auth/login";
  const payload: Record<string, string> = { email, password: input.password };
  if (input.mode === "register" && input.displayName?.trim()) payload.displayName = input.displayName.trim();
  if (input.mode === "register" && input.cloudSyncConsent !== undefined) payload.cloudSyncConsent = input.cloudSyncConsent;
  try {
    const baseUrl=normalizeServerUrl(input.baseUrl);
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      redirect: "error",
      headers: authHeaders(null),
      body: JSON.stringify(payload),
    });
    if (response.status === 200 || response.status === 201) {
      const body = (await response.json()) as {
        token?: unknown;
        expiresAt?: unknown;
        account?: { email?: unknown; displayName?: unknown; accountId?: unknown; cloudSyncConsent?: unknown };
      };
      if (typeof body.token !== "string" || typeof body.expiresAt !== "string" || typeof body.account?.accountId !== "string") {
        return { ok: false, code: "UNAVAILABLE" };
      }
      const accountEmail = typeof body.account.email === "string" ? normalizeEmail(body.account.email) : email;
      const displayName = typeof body.account.displayName === "string" ? body.account.displayName : "";
      return {
        ok: true,
        session: { serverOrigin: baseUrl, email: accountEmail, displayName, accountId: body.account.accountId, token: body.token, expiresAt: body.expiresAt, cloudSyncConsent: typeof body.account.cloudSyncConsent === "string" ? body.account.cloudSyncConsent : null },
      };
    }
    return { ok: false, code: await failureCode(response) };
  } catch {
    return { ok: false, code: "UNAVAILABLE" };
  }
}

export async function fetchAccount(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = appFetch,
  boundOrigin?: string | null,
): Promise<{ ok: true; accountId: string; email: string; displayName: string } | { ok: false; code: "SIGN_IN" | "UNAVAILABLE" }> {
  try {
    assertCredentialDestination(baseUrl,boundOrigin);
    const response = await fetchImpl(`${normalizeServerUrl(baseUrl)}/api/v1/account`, {
      redirect: "error",
      headers: authHeaders(token),
    });
    if (response.status === 401) return { ok: false, code: "SIGN_IN" };
    if (!response.ok) return { ok: false, code: "UNAVAILABLE" };
    const body = (await response.json()) as { accountId?: unknown; email?: unknown; displayName?: unknown };
    if (typeof body.accountId !== "string" || typeof body.email !== "string") return { ok: false, code: "UNAVAILABLE" };
    return {
      ok: true,
      accountId: body.accountId,
      email: normalizeEmail(body.email),
      displayName: typeof body.displayName === "string" ? body.displayName : "",
    };
  } catch {
    return { ok: false, code: "UNAVAILABLE" };
  }
}

export async function revokeServerSession(baseUrl: string, token: string, fetchImpl: typeof fetch = appFetch, boundOrigin?: string | null): Promise<"revoked" | "unreachable" | "rejected"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    assertCredentialDestination(baseUrl,boundOrigin);
    const response = await fetchImpl(`${normalizeServerUrl(baseUrl)}/api/v1/auth/logout`, {
      method: "POST",
      redirect: "error",
      headers: authHeaders(token),
      signal: controller.signal,
    });
    return response.status === 204 || response.status === 200 ? "revoked" : "rejected";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

export async function performLogout(input: {
  access: LocalAccess;
  store: SecretStore;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<{ notice: string }> {
  const token = input.access.mode === "signed-in" ? input.access.token : null;
  await input.store.remove(SESSION_KEY);
  if (!token) return { notice: logoutNotice("local") };
  const outcome = await revokeServerSession(input.baseUrl, token, input.fetchImpl, input.access.mode === "signed-in" ? input.access.serverOrigin : null);
  return { notice: logoutNotice(outcome) };
}

async function failureCode(response: Response): Promise<AuthFailure> {
  if (response.status === 429) return "RATE_LIMITED";
  if (response.status === 401) return "AUTH_REJECTED";
  try {
    const body = (await response.json()) as { code?: unknown };
    if (body.code === "EMAIL_IN_USE") return "EMAIL_IN_USE";
    if (body.code === "INVALID_PASSWORD") return "INVALID_PASSWORD";
    if (body.code === "INVALID_CREDENTIALS") return "AUTH_REJECTED";
    if (body.code === "RATE_LIMITED") return "RATE_LIMITED";
  } catch {
    return "UNAVAILABLE";
  }
  return response.status >= 500 ? "UNAVAILABLE" : "INVALID_INPUT";
}

function safeAccountId(id: string): boolean { return /^[A-Za-z0-9-]{1,128}$/.test(id); }

/** Pin credentials to the authenticated API base, never the editable connection preference. */
export function normalizeServerUrl(raw:string):string {
 const url=new URL(raw);
 const development=typeof __DEV__ === "undefined" || __DEV__;
 const loopback=["localhost","127.0.0.1","[::1]","10.0.2.2"].includes(url.hostname);
 if(url.username || url.password || url.search || url.hash || (url.protocol!=="https:" && !(development && loopback && url.protocol==="http:"))) throw Error("Use a trusted HTTPS server address");
 const normalized = url.toString().replace(/\/$/,"");
 if (pilotOrigin && normalized !== pilotOrigin) throw Error("Use the configured Liftlog pilot server");
 return normalized;
}
export function assertCredentialDestination(baseUrl:string,boundOrigin:string|null|undefined):void {
 if(!boundOrigin || normalizeServerUrl(baseUrl)!==normalizeServerUrl(boundOrigin)) throw Error("Sign in again on the intended server");
}
