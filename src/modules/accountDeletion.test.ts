import assert from "node:assert/strict";
import test from "node:test";
import { openNodeDatabase } from "../storage/nodeDriver";
import { migrate } from "../storage/schema";
import { memorySecretStore, signedInAccess } from "./accountSession";
import { performAccountDeletion, recoverAccountDeletion, readAccountDeletion } from "./accountDeletion";

function setup() {
  const db = openNodeDatabase(":memory:"); migrate(db);
  const store = memorySecretStore();
  const access = signedInAccess({ email:"delete@example.com", displayName:"", accountId:"delete-id", token:"token", expiresAt:"2099-01-01" });
  const input = { db, access, store, boundOrigin:"https://example.com", configuredOrigin:"https://example.com", password:"password", isCurrent:()=>true };
  return {db, input};
}
test("persists barrier before transport and validates deletion identity", async () => {
  const {db,input}=setup();
  try {
    const result=await performAccountDeletion({...input,fetchImpl:async (url,init)=>{
      assert.equal(readAccountDeletion(db),"pending"); assert.equal(url,"https://example.com/api/v1/account/delete");
      assert.deepEqual(JSON.parse(String(init?.body)),{confirm:true,password:"password"});
      return Response.json({deleted:true,accountId:"delete-id"});
    }});
    assert.equal(result,"confirmed"); assert.equal(readAccountDeletion(db),"confirmed");
  } finally {db.close();}
});
test("offline, rejected and mismatched receipts retain pending quarantine",async()=>{
  for(const fetchImpl of [async()=>{throw Error("offline");},async()=>new Response(null,{status:401}),async()=>Response.json({deleted:true,accountId:"other"})]){
    const {db,input}=setup();try {assert.equal(await performAccountDeletion({...input,fetchImpl}),"pending");assert.equal(readAccountDeletion(db),"pending");}finally{db.close();}
  }
});
test("credential removal failure preserves confirmed barrier and surfaces failure",async()=>{
 const {db,input}=setup();try {
 await assert.rejects(performAccountDeletion({...input,store:{...input.store,remove:async()=>{throw Error("keychain unavailable");}},fetchImpl:async()=>Response.json({deleted:true,accountId:"delete-id"})}),/keychain/);
 assert.equal(readAccountDeletion(db),"confirmed");
 }finally{db.close();}
});
test("origin change and stale generation cannot send or confirm",async()=>{
 const {db,input}=setup();try {
 let calls=0;
 await assert.rejects(performAccountDeletion({...input,configuredOrigin:"https://evil.example",fetchImpl:async()=>{calls++;return new Response();}}));assert.equal(calls,0);assert.equal(readAccountDeletion(db),null);
 let current=true;
 assert.equal(await performAccountDeletion({...input,isCurrent:()=>current,fetchImpl:async()=>{current=false;return Response.json({deleted:true,accountId:"delete-id"});}}),"stale");assert.equal(readAccountDeletion(db),"pending");
 }finally{db.close();}
});

test("recovery refuses a recreated account identity",async()=>{
 const {db,input}=setup();try {
 let calls=0;
 assert.equal(await recoverAccountDeletion({...input,fetchImpl:async()=>{calls++;return Response.json({token:"new",expiresAt:"2099-01-01",account:{accountId:"different",email:"delete@example.com"}});}}),"pending");
 assert.equal(calls,1);
 }finally{db.close();}
});
test("recovery uses a fresh session only after verifying the original identity",async()=>{
 const {db,input}=setup();try {
 let calls=0;
 const result=await recoverAccountDeletion({...input,fetchImpl:async(_url,init)=>{
 calls++;
 if(calls===1)return Response.json({token:"fresh-session",expiresAt:"2099-01-01",account:{accountId:"delete-id",email:"delete@example.com"}});
 assert.equal((init?.headers as Record<string,string>).Authorization,"Bearer fresh-session");
 return Response.json({deleted:true,accountId:"delete-id"});
 }});
 assert.equal(result,"confirmed");assert.equal(calls,2);assert.equal(readAccountDeletion(db),"confirmed");
 }finally{db.close();}
});
test("unsafe transport cannot persist or send a deletion",async()=>{
 const {db,input}=setup();try {
 let sent=false;
 await assert.rejects(performAccountDeletion({...input,boundOrigin:"http://remote.example",configuredOrigin:"http://remote.example",fetchImpl:async()=>{sent=true;return new Response();}}),/HTTPS/);
 assert.equal(sent,false);assert.equal(readAccountDeletion(db),null);
 }finally{db.close();}
});
