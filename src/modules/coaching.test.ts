import assert from 'node:assert/strict';
import test from 'node:test';
import { requestCoaching, sameCoachingStamp, validCoachingResponse, type CoachingStamp } from './coaching';
import { openNodeDatabase } from '../storage/nodeDriver';
import { migrate } from '../storage/schema';
import { cacheAiPolicy, canUseAiPolicy, revokeAiLocally, validPolicy } from './aiConsent';
const accountId='11111111-1111-4111-8111-111111111111';
const stamp:CoachingStamp={accountId,generation:1,workspaceId:accountId,contextRevision:'c'.repeat(64),cursor:2,consentEpoch:1,providerId:'a'.repeat(64),origin:'https://example.test'};
const body={version:1,kind:'coaching',accountId,snapshot:{cursor:2,revision:'b'.repeat(64),asOf:'2026-11-16T12:00:00Z',timeZone:'UTC',localDate:'2026-11-16'},answer:'Tell me your available time.',focus:'clarify',evidence:[{id:'profile.goal',text:'Goal is unknown.'}],uncertainties:['Missing effort does not prove recovery.'],questions:['How much time?']};
const input=()=>({baseUrl:stamp.origin,authorization:'synthetic',boundOrigin:stamp.origin,question:'What should I train?',aiPolicyId:stamp.providerId,timeZone:'UTC',sync:{cursor:2,pending:false,conflicts:false},turns:[],stamp,current:()=>stamp,canUse:()=>true,fetchImpl:async()=>Response.json(body)});
test('strict coaching response rejects invented shape, evidence and account selector',()=>{
 assert.equal(validCoachingResponse(body),true);
 for(const bad of [{...body,apply:{}},{...body,version:2},{...body,focus:'unsupported'},{...body,focus:1},{...body,evidence:[{id:'',text:'bad'}]},{...body,snapshot:{...body.snapshot,cursor:1.1}},{...body,questions:['a','b','c']},{...body,answer:''},{...body,evidence:[...body.evidence,...body.evidence]}])assert.equal(validCoachingResponse(bad),false);
});
test('stamp rejects every identity/context/consent boundary change',()=>{for(const key of Object.keys(stamp) as (keyof CoachingStamp)[])assert.equal(sameCoachingStamp(stamp,{...stamp,[key]:typeof stamp[key]==='number'?Number(stamp[key])+1:`${stamp[key]}x`}),false);});
test('coaching sends only bounded question, metadata and recent turns with redirect rejection',async()=>{
 let payload:Record<string,unknown>={};const r=await requestCoaching({...input(),fetchImpl:async(_url,options)=>{assert.equal(options?.redirect,'error');payload=JSON.parse(String(options?.body));return Response.json(body);}});assert.equal(r.ok,true);assert.deepEqual(Object.keys(payload).sort(),['aiPolicyId','question','sync','timeZone','turns']);
});
test('local revoke and old policy make no coaching HTTP request',async()=>{
 const db=openNodeDatabase();migrate(db);const policy={providerId:stamp.providerId,providerName:'Synthetic',consentVersion:'2026-11-16',external:true,fields:['question'],retentionNotice:'Synthetic.',accepted:true};cacheAiPolicy(db,stamp.origin,policy);revokeAiLocally(db,stamp.origin,policy);let calls=0;
 assert.equal(validPolicy({...policy,consentVersion:'2026-11-15'}),false);
 assert.deepEqual(await requestCoaching({...input(),canUse:()=>canUseAiPolicy(db,stamp.origin,policy),fetchImpl:async()=>{calls++;return Response.json(body);}}),{ok:false,code:'CONSENT_REQUIRED'});assert.equal(calls,0);db.close();
});
test('wrong pinned origin and redirect responses cannot succeed',async()=>{
 let calls=0;assert.equal((await requestCoaching({...input(),boundOrigin:'https://other.test',fetchImpl:async()=>{calls++;return Response.json(body);}})).ok,false);assert.equal(calls,0);
 assert.equal((await requestCoaching({...input(),fetchImpl:async()=>new Response('',{status:302,headers:{Location:'https://other.test'}})})).ok,false);
});
test('late account switch and local context changes discard answer',async()=>{
 for(const change of [{generation:2},{contextRevision:'d'.repeat(64)},{cursor:3},{consentEpoch:2},{providerId:'e'.repeat(64)}]){
 let active=stamp;let finish!:(r:Response)=>void;const pending=requestCoaching({...input(),current:()=>active,fetchImpl:()=>new Promise(r=>{finish=r;})});active={...stamp,...change};finish(Response.json(body));assert.deepEqual(await pending,{ok:false,code:'STALE'});
 }
});
test('malformed, oversized and revoked responses are rejected without domain writes',async()=>{
 const db=openNodeDatabase();migrate(db);const snapshot=()=>['exercise','exercise_name','workout','workout_exercise','workout_set','training_profile','sync_outbox','sync_conflict','sync_state','preference'].map(table=>JSON.stringify(db.all(`SELECT * FROM ${table} ORDER BY rowid`)));const before=snapshot();
 for(const response of [Response.json({...body,accountId:'22222222-2222-4222-8222-222222222222'}),Response.json({...body,answer:'x'.repeat(33000)}),new Response('{')])assert.equal((await requestCoaching({...input(),fetchImpl:async()=>response})).ok,false);
 let allowed=true;assert.equal((await requestCoaching({...input(),canUse:()=>allowed,fetchImpl:async()=>{allowed=false;return Response.json(body);}})).ok,false);
 assert.deepEqual(snapshot(),before);db.close();
});
test('invalid request bounds stop before HTTP and stale server snapshots are discarded',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return Response.json(body);};
 for(const change of [{question:'x'.repeat(1001)},{turns:Array.from({length:5},()=>({role:'user' as const,text:'Hi'}))},{turns:[{role:'user' as const,text:'x'.repeat(1501)}]},{sync:{cursor:2.5,pending:false,conflicts:false}}])assert.deepEqual(await requestCoaching({...input(),...change,fetchImpl}),{ok:false,code:'INVALID_INPUT'});
 assert.equal(calls,0);
 assert.deepEqual(await requestCoaching({...input(),fetchImpl:async()=>Response.json({...body,snapshot:{...body.snapshot,cursor:3}})}),{ok:false,code:'STALE'});
});
test('context change while response body is arriving cannot display the answer',async()=>{
 let current=stamp;let finish!:(text:string)=>void;
 const response=Response.json(body);response.text=()=>new Promise(resolve=>{finish=resolve;});
 const pending=requestCoaching({...input(),current:()=>current,fetchImpl:async()=>response});
 await Promise.resolve();current={...stamp,contextRevision:'f'.repeat(64)};finish(JSON.stringify(body));
 assert.deepEqual(await pending,{ok:false,code:'STALE'});
});

test('coaching transport preserves network, auth and service recovery categories',async()=>{
 assert.deepEqual(await requestCoaching({...input(),fetchImpl:async()=>{throw new TypeError('offline');}}),{ok:false,code:'NETWORK_ERROR'});
 for(const [status,code] of [[401,'SIGN_IN'],[403,'CONSENT_REQUIRED'],[503,'SERVICE_ERROR']] as const){
  assert.deepEqual(await requestCoaching({...input(),fetchImpl:async()=>new Response('{}',{status})}),{ok:false,code});
 }
 assert.deepEqual(await requestCoaching({...input(),boundOrigin:'https://other.test'}),{ok:false,code:'WORKSPACE_MISMATCH'});
 assert.deepEqual(await requestCoaching({...input(),fetchImpl:async()=>new Response('{')}),{ok:false,code:'SERVICE_ERROR'});
});
