import assert from 'node:assert/strict';
import test from 'node:test';
import { migrate } from '../storage/schema';
import { openNodeDatabase } from '../storage/nodeDriver';
import { grantChatConsent } from './chat';
import { startWorkout } from './workout';
import { bindSync, prepareBatch } from './syncStore';
import { cacheAiPolicy, canUseAiPolicy, fetchAiPolicy, hasAnalyticsConsent, readAiPolicy, revokeAiLocally, updateAiConsent } from './aiConsent';
const url='https://example.test';
const policy={providerId:'a'.repeat(64),providerName:'Example',consentVersion:'2026-11-16',external:true,fields:['note'],retentionNotice:'Provider retention applies.',accepted:true};
function db(){const d=openNodeDatabase();migrate(d,'2026-11-15T00:00:00Z');return d;}
test('generic permission grants neither analytics nor external AI',()=>{const d=db();grantChatConsent(d);assert.equal(hasAnalyticsConsent(d),false);assert.equal(canUseAiPolicy(d,url,policy),false);});
test('local revoke blocks stale accepted policy, including after reload',()=>{const d=db();cacheAiPolicy(d,url,policy);assert.equal(canUseAiPolicy(d,url,policy),true);revokeAiLocally(d,url,policy);cacheAiPolicy(d,url,policy);assert.equal(readAiPolicy(d,url)?.accepted,false);assert.equal(canUseAiPolicy(d,url,policy),false);assert.equal(canUseAiPolicy(d,url,{...policy,providerId:'b'.repeat(64)}),false);});
test('grant response cannot override a newer local revoke',async()=>{const d=db();let finish!:(r:Response)=>void;const pending=updateAiConsent({db:d,baseUrl:url,authorization:'token',boundOrigin:url,policy,accepted:true,fetchImpl:()=>new Promise(r=>{finish=r;})});revokeAiLocally(d,url,policy);finish(new Response(JSON.stringify(policy)));assert.equal((await pending).ok,false);assert.equal(canUseAiPolicy(d,url,policy),false);});
test('changed provider response cannot confirm an old grant',async()=>{const d=db();const result=await updateAiConsent({db:d,baseUrl:url,authorization:'token',boundOrigin:url,policy,accepted:true,fetchImpl:async()=>new Response(JSON.stringify({...policy,providerId:'b'.repeat(64)}))});assert.equal(result.ok,false);assert.equal(canUseAiPolicy(d,url,policy),false);});
test('wrong credential destination prevents any HTTP request',async()=>{let calls=0;const result=await updateAiConsent({baseUrl:url,authorization:'token',boundOrigin:'https://other.test',policy,accepted:true,fetchImpl:async()=>{calls++;return new Response(JSON.stringify(policy));}});assert.equal(result.ok,false);assert.equal(calls,0);});

test('late policy response never writes a closed previous workspace',async()=>{
 const db=openNodeDatabase();migrate(db);let current=true;let release!:(response:Response)=>void;
 const promise=fetchAiPolicy({db,baseUrl:'https://account.example',authorization:'synthetic',boundOrigin:'https://account.example',isCurrent:()=>current,fetchImpl:async()=>new Promise<Response>(resolve=>{release=resolve;})});
 current=false;db.close();release(Response.json({providerId:'a'.repeat(64),providerName:'Groq',consentVersion:'2026-11-16',external:true,fields:['note'],retentionNotice:'Not verified',accepted:true}));
 assert.deepEqual(await promise,{ok:false,code:'STALE'});
});

test('revoking AI leaves manual logging and its cloud outbox enabled',()=>{
 const d=db();bindSync(d,'synthetic-account',url);cacheAiPolicy(d,url,policy);revokeAiLocally(d,url,policy);
 assert.equal(canUseAiPolicy(d,url,policy),false);
 const logged=startWorkout(d,{actionId:'manual',localDate:'2026-11-15',label:'Offline',now:'2026-11-15T12:00:00Z'});
 assert.equal(logged.ok,true);assert.ok(prepareBatch(d).some(op=>op.recordType==='workout'));
});

test('policy failures retain actionable categories without sending credentials elsewhere',async()=>{
 const cases:[string,Partial<Parameters<typeof fetchAiPolicy>[0]>,typeof fetch,string,number][]=[
  ['unauthenticated',{},async()=>new Response('',{status:401}),'SIGN_IN',1],
  ['service failure',{},async()=>new Response('',{status:503}),'SERVICE_ERROR',1],
  ['malformed JSON',{},async()=>new Response('{'),'SERVICE_ERROR',1],
  ['invalid schema',{},async()=>Response.json({}),'SERVICE_ERROR',1],
  ['wrong origin',{boundOrigin:'https://other.test'},async()=>Response.json(policy),'WORKSPACE_MISMATCH',0],
  ['network failure',{},async()=>{throw new TypeError('network');},'NETWORK_ERROR',1],
  ['invalid address',{baseUrl:'not a URL'},async()=>Response.json(policy),'INVALID_INPUT',0],
 ];
 for(const [name,overrides,response,code,count] of cases){let calls=0;const result=await fetchAiPolicy({baseUrl:url,authorization:'synthetic',boundOrigin:url,...overrides,fetchImpl:async(...args)=>{calls++;return response(...args);}});assert.deepEqual(result,{ok:false,code},name);assert.equal(calls,count,name);}
 const anonymous=await fetchAiPolicy({baseUrl:url,authorization:null,boundOrigin:null,fetchImpl:async(_url,init)=>{assert.equal(new Headers(init?.headers).has('Authorization'),false);return new Response('',{status:401});}});
 assert.deepEqual(anonymous,{ok:false,code:'SIGN_IN'});
});
