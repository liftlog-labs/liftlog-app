import { appFetch } from "../shared/http";
import type { SqlExecutor } from "../storage/sql";
import { authHeaders, assertCredentialDestination } from "./accountSession";
import { acknowledgeBatch, applySyncPage, bindSync, CLOUD_SYNC_VERSION, prepareBatch, readSyncState, recordPushConflicts, resetPullCursor, type SyncOperation, type SyncPage, type SyncResult } from "./syncStore";

type Options={db:SqlExecutor;accountId:string;baseUrl:string;token:string;isCurrent:()=>boolean;onChange?:()=>void;onAuthRequired?:()=>void;fetchImpl?:typeof fetch;timeoutMs?:number};
class SyncFailure extends Error {constructor(readonly code:string,readonly status=0,readonly body:Record<string,unknown>={}) {super(code);}}
const owners=new WeakMap<SqlExecutor, {stop:()=>void}>();
export type SyncWorker=ReturnType<typeof createSyncWorker>;
export function createSyncWorker(options:Options) {
 const {db,accountId,token}=options;const baseUrl=options.baseUrl.replace(/\/$/,"");
 bindSync(db,accountId,baseUrl);
 owners.get(db)?.stop();
 if(readSyncState(db).lastCode==="SIGN_IN") db.run("UPDATE sync_state SET last_code=NULL,failures=0 WHERE id=1");
 let stopped=false;let active=true;let timer:ReturnType<typeof setTimeout>|undefined;let controller:AbortController|null=null;let flight:Promise<void>|null=null;
 const current=()=>!stopped && active && options.isCurrent();
 function changed(){if(current()) options.onChange?.();}
 function stop(){stopped=true;if(timer) clearTimeout(timer);controller?.abort();}
 function schedule(delay:number){if(!current()) return;if(timer) clearTimeout(timer);timer=setTimeout(()=>{timer=undefined;void run().then(()=>{
   if(!current() || timer) return;
   const state=readSyncState(db);
   if(state.terminal || state.lastCode==="SIGN_IN") return;
   const delay=state.failures?Math.min(60000,1000*2**Math.min(state.failures,6))*(0.8+Math.random()*0.4):15000;
   schedule(delay);
 });},delay);}
 async function request(path:string,body?:unknown):Promise<Record<string,unknown>> {
   if(!current() || readSyncState(db).terminal) throw new SyncFailure("STALE");
   assertCredentialDestination(baseUrl,readSyncState(db).origin);
   const abort=new AbortController();controller=abort;
   let timeout:ReturnType<typeof setTimeout>|undefined;
   try {
     const {response,result}=await Promise.race([
       (async()=>{
         const response=await (options.fetchImpl??appFetch)(`${baseUrl}${path}`,{method:body===undefined?"GET":"POST",headers:authHeaders(token),redirect:"error",signal:abort.signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
         if(!current()) throw new SyncFailure("STALE");
         const result=await response.json() as Record<string,unknown>;
         return {response,result};
       })(),
       new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{abort.abort();reject(new SyncFailure("TIMEOUT"));},options.timeoutMs??10000);}),
     ]);
     if(!current() || readSyncState(db).terminal) throw new SyncFailure("STALE");
     if(!result || typeof result!=="object" || Array.isArray(result)) throw new SyncFailure("INVALID_RESPONSE");
     if(!response.ok) throw new SyncFailure(typeof result.code==="string"?result.code:"REQUEST_FAILED",response.status,result);
     return result;
   } catch(error) {
     if(error instanceof SyncFailure) throw error;
     throw new SyncFailure(current()?"UNAVAILABLE":"STALE");
   } finally {if(timeout) clearTimeout(timeout);if(controller===abort) controller=null;}
 }
 async function push(operations:SyncOperation[]):Promise<boolean> {
   try {
     const body=await request("/api/v1/sync/push",{accountId,consent:{cloudSync:CLOUD_SYNC_VERSION},operations});
     if(body.accountId!==accountId || !Array.isArray(body.results)) throw new SyncFailure("INVALID_RESPONSE");
     acknowledgeBatch(db,operations,body.results as SyncResult[]);changed();return true;
   } catch(error) {
     if(error instanceof SyncFailure && error.code==="CONFLICT" && Array.isArray(error.body.conflicts)) {
       recordPushConflicts(db,operations,error.body.conflicts as Parameters<typeof recordPushConflicts>[2]);changed();return false;
     }
     throw error;
   }
 }
 async function reconcile() {
   if(!current() || readSyncState(db).terminal) return;
   try {
     const account=await request("/api/v1/account");
     if(account.accountId!==accountId) throw new SyncFailure("ACCOUNT_MISMATCH");
     const consent=account.cloudSyncConsent===CLOUD_SYNC_VERSION?CLOUD_SYNC_VERSION:null;
     db.run("UPDATE sync_state SET consent=? WHERE id=1",[consent]);changed();
     // Resolve uncertain commits first; the server receipt is the only reliable acknowledgment.
     if(consent && db.get("SELECT seq FROM sync_outbox WHERE fingerprint IS NOT NULL AND blocked=0 LIMIT 1")) {
       try { await push(prepareBatch(db)); } catch(error) {
         // This definitive atomic rejection committed nothing. Pull may reveal a parent tombstone.
         // Keep the frozen body intact; unaffected operations can still be replayed afterward.
         if(!(error instanceof SyncFailure) || error.code!=="PARENT_NOT_FOUND") throw error;
       }
     }
     let complete=false;
     for(let page=0;page<4 && current();page++) {
       const cursor=readSyncState(db).cursor;
       let body:Record<string,unknown>;
       try {body=await request(`/api/v1/sync/pull?cursor=${cursor}&limit=100`);} catch(error) {
         if(error instanceof SyncFailure && error.code==="CURSOR_EXPIRED" && error.body.recovery==="full") {resetPullCursor(db);changed();continue;}
         throw error;
       }
       applySyncPage(db,body as unknown as SyncPage);changed();
       if(body.complete) {complete=true;break;}
       await new Promise(resolve=>setTimeout(resolve,0));
     }
     if(!current()) return;
     if(complete && consent) {
       for(let batch=0;batch<4 && current();batch++) {
         const operations=prepareBatch(db);if(!operations.length) break;
         if(!await push(operations)) break;
         await new Promise(resolve=>setTimeout(resolve,0));
       }
     }
     if(!current()) return;
     db.run("UPDATE sync_state SET failures=0,last_code=NULL WHERE id=1");changed();
     const remains=db.get("SELECT seq FROM sync_outbox WHERE blocked=0 LIMIT 1");
     if(!complete || (consent && remains && !db.get("SELECT id FROM sync_conflict WHERE resolved=0 LIMIT 1"))) schedule(100);
   } catch(error) {
     if(!current()) return;
     const failure=error instanceof SyncFailure?error:new SyncFailure("STORAGE_OR_PROTOCOL");
     if(failure.code==="STALE") return;
     const code=failure.status===401?"SIGN_IN":failure.code;
     db.run("UPDATE sync_state SET failures=failures+1,last_code=?,terminal=CASE WHEN ?='ACCOUNT_GONE' THEN 1 ELSE terminal END WHERE id=1",[code,code]);
     if(code==="CONSENT_REQUIRED") db.run("UPDATE sync_state SET consent=NULL WHERE id=1");
     changed();if(code==="SIGN_IN" && current()) options.onAuthRequired?.();
   }
 }
 function run():Promise<void> {
   if(flight) return flight;
   flight=reconcile().finally(()=>{flight=null;});return flight;
 }
 function wake(delay=600){if(!current()) return;const state=readSyncState(db);if(state.terminal || state.lastCode==="SIGN_IN") return;schedule(state.failures?Math.max(delay,Math.min(60000,1000*2**Math.min(state.failures,6))):delay);}
 function setActive(value:boolean){active=value;if(!value) {if(timer) clearTimeout(timer);controller?.abort();} else wake(0);}
 async function enableCloud():Promise<void> {
   if(!current()) return;
   const body=await request("/api/v1/account/consent",{cloudSync:CLOUD_SYNC_VERSION});
   if(body.cloudSync!==CLOUD_SYNC_VERSION) throw Error("Consent was not confirmed");
   if(!current()) return;db.run("UPDATE sync_state SET consent=?,last_code=NULL WHERE id=1",[CLOUD_SYNC_VERSION]);changed();wake(0);
 }
 const worker={run,wake,stop,setActive,enableCloud};owners.set(db,worker);return worker;
}
