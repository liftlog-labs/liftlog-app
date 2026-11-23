import { appFetch } from "../shared/http";
import { authHeaders, signedInAccess, submitCredentials, SESSION_KEY, type LocalAccess, type SecretStore } from "./accountSession";
import type { SqlExecutor } from "../storage/sql";

export const ACCOUNT_DELETION_KEY = "sync_account_deletion";
export type AccountDeletionState = "pending" | "confirmed";
export function readAccountDeletion(db: SqlExecutor): AccountDeletionState | null {
  const value = db.get<{value:string}>("SELECT value FROM preference WHERE key=?",[ACCOUNT_DELETION_KEY])?.value;
  return value === "pending" || value === "confirmed" ? value : null;
}
function mark(db: SqlExecutor, value: AccountDeletionState) {
  db.run("INSERT INTO preference(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[ACCOUNT_DELETION_KEY,value]);
}

/** A lost acknowledgement remains pending: a revoked token is never proof of deletion. */
export async function performAccountDeletion(input: {
  db: SqlExecutor; access: LocalAccess; store: SecretStore; boundOrigin: string | null;
  configuredOrigin: string; password: string; isCurrent: () => boolean; fetchImpl?: typeof fetch;
}): Promise<"confirmed" | "pending" | "stale"> {
  if (input.access.mode !== "signed-in" || !input.access.accountId || !input.password || !input.isCurrent()) throw Error("Sign in to the intended account first.");
  const origin=input.boundOrigin?.replace(/\/$/,"");
  if (!origin || origin !== input.configuredOrigin.replace(/\/$/,"")) throw Error("Verify the original account server before deleting.");
  const url=new URL(origin);
  if(url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)))) throw Error("Use HTTPS for account deletion.");
  if(readAccountDeletion(input.db)==="confirmed") throw Error("This account workspace is quarantined.");
  mark(input.db,"pending");
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),15000);
  let confirmed=false;
  try {
    const response=await (input.fetchImpl??appFetch)(`${origin}/api/v1/account/delete`,{method:"POST",redirect:"error",headers:authHeaders(input.access.token),body:JSON.stringify({confirm:true,password:input.password}),signal:controller.signal});
    if(response.ok) {const body=await response.json() as {deleted?:unknown;accountId?:unknown};confirmed=body.deleted===true && body.accountId===input.access.accountId;}
  } catch { /* Network errors cannot establish whether the deletion committed. */ }
  finally {clearTimeout(timeout);}
  if(!input.isCurrent()) return "stale";
  if(!confirmed) return "pending";
  mark(input.db,"confirmed");
  await input.store.remove(SESSION_KEY);
  return input.isCurrent()?"confirmed":"stale";
}

export async function recoverAccountDeletion(input: Parameters<typeof performAccountDeletion>[0]): Promise<"confirmed" | "pending" | "stale"> {
  if(input.access.mode === "anonymous" || !input.access.accountId || !input.boundOrigin || input.boundOrigin.replace(/\/$/,"") !== input.configuredOrigin.replace(/\/$/,"")) throw Error("Verify the original account server first.");
  const target=new URL(input.boundOrigin);
  if(target.username || target.password || target.search || target.hash || (target.protocol!=="https:" && !(target.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(target.hostname)))) throw Error("Use HTTPS for account recovery.");
  if(!input.isCurrent()) return "stale";
  const attempt=await submitCredentials({baseUrl:input.boundOrigin,mode:"login",email:input.access.email,password:input.password,fetchImpl:input.fetchImpl});
  if(!input.isCurrent()) return "stale";
  if(!attempt.ok || attempt.session.accountId!==input.access.accountId) return "pending";
  return performAccountDeletion({...input,access:signedInAccess(attempt.session)});
}
