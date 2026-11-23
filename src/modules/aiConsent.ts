import { appFetch } from "../shared/http";
import { assertCredentialDestination, authHeaders, normalizeServerUrl } from './accountSession';
import { sha256Hex } from '../shared/digest';
import { err, ok, type Result } from '../shared/result';
import type { SqlExecutor } from '../storage/sql';

export type AiPolicy = { providerId:string; providerName:string; consentVersion:string; external:boolean; fields:string[]; retentionNotice:string; accepted:boolean };
type Cached = { policy:AiPolicy; pending:boolean; epoch:number };
function analyticsKey(db:SqlExecutor){const url=db.get<{value:string}>("SELECT value FROM preference WHERE key='course_base_url'")?.value??'http://127.0.0.1:8000';return `analytics_consent_v1_${sha256Hex(normalizeServerUrl(url))}`;}
function put(db:SqlExecutor,key:string,value:string){db.run('INSERT INTO preference (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,value]);}
export function hasAnalyticsConsent(db:SqlExecutor){return db.get<{value:string}>('SELECT value FROM preference WHERE key=?',[analyticsKey(db)])?.value==='granted';}
export function grantAnalyticsConsent(db:SqlExecutor){put(db,analyticsKey(db),'granted');}
export function revokeAnalyticsConsent(db:SqlExecutor){put(db,analyticsKey(db),'revoked');}
function key(url:string){return `ai_policy_${sha256Hex(normalizeServerUrl(url))}`;}
function cached(db:SqlExecutor,url:string):Cached|null {try {const raw=db.get<{value:string}>('SELECT value FROM preference WHERE key=?',[key(url)])?.value;const v=raw?JSON.parse(raw):null;return v && validPolicy(v.policy)&&typeof v.pending==='boolean'&&Number.isSafeInteger(v.epoch)?v:null;}catch{return null;}}
export function readAiPolicy(db:SqlExecutor,url:string):AiPolicy|null {const c=cached(db,url);return c?{...c.policy,accepted:c.policy.accepted&&!c.pending}:null;}
export function aiConsentRevision(db:SqlExecutor,url:string){return cached(db,url)?.epoch??0;}
export function aiRevocationPending(db:SqlExecutor,url:string){return cached(db,url)?.pending??false;}
export function cacheAiPolicy(db:SqlExecutor,url:string,policy:AiPolicy){const c=cached(db,url);put(db,key(url),JSON.stringify({policy:{...policy,accepted:policy.accepted&&!c?.pending},pending:c?.pending??false,epoch:c?.epoch??0}));}
export function revokeAiLocally(db:SqlExecutor,url:string,policy:AiPolicy){const c=cached(db,url);put(db,key(url),JSON.stringify({policy:{...policy,accepted:false},pending:true,epoch:(c?.epoch??0)+1}));}
export function canUseAiPolicy(db:SqlExecutor,url:string,policy:AiPolicy){const c=cached(db,url);return !!c&&!c.pending&&c.policy.providerId===policy.providerId&&c.policy.consentVersion===policy.consentVersion&&c.policy.accepted&&policy.accepted;}
export function validPolicy(v:unknown):v is AiPolicy {if(!v||typeof v!=='object'||Array.isArray(v))return false;const p=v as Record<string,unknown>;return Object.keys(p).sort().join(',')==='accepted,consentVersion,external,fields,providerId,providerName,retentionNotice'&&typeof p.providerId==='string'&&/^[a-f0-9]{64}$/.test(p.providerId)&&typeof p.providerName==='string'&&p.providerName.length>0&&p.providerName.length<=200&&p.consentVersion==='2026-11-16'&&typeof p.external==='boolean'&&typeof p.accepted==='boolean'&&typeof p.retentionNotice==='string'&&p.retentionNotice.length>0&&p.retentionNotice.length<=4000&&Array.isArray(p.fields)&&p.fields.length>0&&p.fields.length<=30&&p.fields.every(f=>typeof f==='string'&&f.length>0&&f.length<=500);}
type Input={baseUrl:string;authorization:string|null;boundOrigin:string|null|undefined;fetchImpl?:typeof fetch;db?:SqlExecutor;isCurrent?:()=>boolean};
async function call(input:Input,change?:{policy:AiPolicy;accepted:boolean}):Promise<Result<AiPolicy>>{
 let base:string;
 try {base=normalizeServerUrl(input.baseUrl);}catch{return err('INVALID_INPUT');}
 if(input.authorization){try{assertCredentialDestination(base,input.boundOrigin);}catch{return err('WORKSPACE_MISMATCH');}}
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),8000);
 try {
 const response=await (input.fetchImpl??appFetch)(`${base}/api/v1/chat/${change?'consent':'policy'}`,{method:change?'POST':'GET',headers:authHeaders(input.authorization),redirect:'error',signal:controller.signal,...(change?{body:JSON.stringify({providerId:change.policy.providerId,consentVersion:change.policy.consentVersion,accepted:change.accepted})}:{})});
 if(response.status===401)return err('SIGN_IN');if(!response.ok)return err('SERVICE_ERROR');const raw=await response.text();if(raw.length>16384)return err('SERVICE_ERROR');let policy:unknown;try{policy=JSON.parse(raw);}catch{return err('SERVICE_ERROR');}if(!validPolicy(policy))return err('SERVICE_ERROR');if(change&&(policy.providerId!==change.policy.providerId||policy.consentVersion!==change.policy.consentVersion||policy.accepted!==change.accepted))return err('STALE');return ok(policy);
 }catch{return err('NETWORK_ERROR');}finally{clearTimeout(timer);}
}
export async function fetchAiPolicy(input:Input):Promise<Result<AiPolicy>>{if(input.isCurrent&&!input.isCurrent())return err('STALE');const epoch=input.db?cached(input.db,input.baseUrl)?.epoch??0:0;const result=await call(input);if(input.isCurrent&&!input.isCurrent())return err('STALE');if(input.db&&epoch!==(cached(input.db,input.baseUrl)?.epoch??0))return err('STALE');if(result.ok&&input.db)cacheAiPolicy(input.db,input.baseUrl,result.value);return result;}
export async function updateAiConsent(input:Input&{policy:AiPolicy;accepted:boolean}):Promise<Result<AiPolicy>>{if(input.isCurrent&&!input.isCurrent())return err('STALE');if(!input.accepted&&input.db)revokeAiLocally(input.db,input.baseUrl,input.policy);if(input.isCurrent&&!input.isCurrent())return err('STALE');const epoch=input.db?cached(input.db,input.baseUrl)?.epoch??0:0;const result=await call(input,input);if(input.isCurrent&&!input.isCurrent())return err('STALE');if(input.db&&epoch!==(cached(input.db,input.baseUrl)?.epoch??0))return err('STALE');if(result.ok&&input.db)put(input.db,key(input.baseUrl),JSON.stringify({policy:result.value,pending:false,epoch:epoch+1}));return result;}
