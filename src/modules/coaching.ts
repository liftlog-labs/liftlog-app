import { appFetch } from '../shared/http';
import { err, ok, type Result } from '../shared/result';
import { assertCredentialDestination, authHeaders, normalizeServerUrl } from './accountSession';

export type CoachingTurn = {role:'user'|'assistant';text:string};
export type CoachingStamp = {accountId:string;generation:number;workspaceId:string;contextRevision:string;cursor:number;consentEpoch:number;providerId:string;origin:string};
export type CoachingResponse = {version:1;kind:'coaching';accountId:string;snapshot:{cursor:number;revision:string;asOf:string;timeZone:string;localDate:string};answer:string;focus:'upper'|'lower'|'full_body'|'light'|'clarify';evidence:{id:string;text:string}[];uncertainties:string[];questions:string[]};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const str=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export function sameCoachingStamp(a:CoachingStamp,b:CoachingStamp):boolean{return (Object.keys(a) as (keyof CoachingStamp)[]).every(k=>a[k]===b[k]);}
export function validCoachingResponse(v:unknown):v is CoachingResponse {
 if(!object(v)||!exact(v,'version,kind,accountId,snapshot,answer,focus,evidence,uncertainties,questions')||v.version!==1||v.kind!=='coaching'||!uuid(v.accountId)||!str(v.answer,1800)||!['upper','lower','full_body','light','clarify'].includes(String(v.focus)))return false;
 const s=v.snapshot;if(!object(s)||!exact(s,'cursor,revision,asOf,timeZone,localDate')||!integer(s.cursor)||typeof s.revision!=='string'||!/^[a-f0-9]{64}$/.test(s.revision)||!str(s.asOf,40)||!Number.isFinite(Date.parse(s.asOf))||!str(s.timeZone,80)||typeof s.localDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s.localDate))return false;
 try{new Intl.DateTimeFormat('en-US',{timeZone:s.timeZone});}catch{return false;}
 if(!Array.isArray(v.evidence)||v.evidence.length>64||!v.evidence.every(e=>object(e)&&exact(e,'id,text')&&str(e.id,200)&&str(e.text,1500))||new Set(v.evidence.map(e=>e.id)).size!==v.evidence.length)return false;
 return (['uncertainties','questions'] as const).every(k=>Array.isArray(v[k])&&v[k].length<=(k==='questions'?2:12)&&v[k].every(t=>str(t,1000)));
}
export async function requestCoaching(input:{baseUrl:string;authorization:string;boundOrigin:string|null|undefined;question:string;aiPolicyId:string;timeZone:string;sync:{cursor:number;pending:boolean;conflicts:boolean};turns:CoachingTurn[];stamp:CoachingStamp;current:()=>CoachingStamp|null;canUse:()=>boolean;fetchImpl?:typeof fetch}):Promise<Result<CoachingResponse>> {
 const current=()=>{const now=input.current();return now!==null&&sameCoachingStamp(input.stamp,now);};
 if(!current())return err('STALE');if(!input.canUse())return err('CONSENT_REQUIRED');
 if(!str(input.question,1000)||!/^[a-f0-9]{64}$/.test(input.aiPolicyId)||!str(input.timeZone,80)||!integer(input.sync.cursor)||input.turns.length>4||!input.turns.every(t=>['user','assistant'].includes(t.role)&&str(t.text,1500)))return err('INVALID_INPUT');
 let base:string;
 try{base=normalizeServerUrl(input.baseUrl);}catch{return err('INVALID_INPUT');}
 try{assertCredentialDestination(base,input.boundOrigin);}catch{return err('WORKSPACE_MISMATCH');}
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),25000);
 try{

 const response=await(input.fetchImpl??appFetch)(`${base}/api/v1/chat/coach`,{method:'POST',redirect:'error',headers:authHeaders(input.authorization),signal:controller.signal,body:JSON.stringify({question:input.question,aiPolicyId:input.aiPolicyId,timeZone:input.timeZone,sync:input.sync,turns:input.turns.map(({role,text})=>({role,text}))})});
 if(!current())return err('STALE');if(!input.canUse())return err('CONSENT_REQUIRED');
 if(response.redirected||response.status>=300&&response.status<400)return err('SERVICE_ERROR');
 if(response.status===401||response.status===410)return err('SIGN_IN');if(response.status===403)return err('CONSENT_REQUIRED');if(response.status===409)return err('STALE');if(!response.ok)return err('SERVICE_ERROR');
 const raw=await response.text();if(raw.length>32768||new TextEncoder().encode(raw).byteLength>32768)return err('SERVICE_ERROR');
 let body:unknown;try{body=JSON.parse(raw);}catch{return err('SERVICE_ERROR');}if(!current())return err('STALE');if(!input.canUse())return err('CONSENT_REQUIRED');
 if(!validCoachingResponse(body))return err('SERVICE_ERROR');
 if(body.accountId!==input.stamp.accountId||body.snapshot.cursor!==input.stamp.cursor||body.snapshot.timeZone!==input.timeZone)return err('STALE');return ok(body);
 }catch{return err('NETWORK_ERROR');}finally{clearTimeout(timer);}
}
