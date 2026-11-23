import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer, type RequestListener} from 'node:http';
import {assertCredentialDestination, normalizeServerUrl, databaseFile, readStoredAccess, signedInAccess, serializeAccess, submitCredentials, revokeServerSession} from './accountSession';
import {requestChat} from './chat';
import {requestTrends} from './trends';

async function localServer(handler:RequestListener) {
 const server=createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 return {server,url,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}
test('mobile API calls reject redirects before synthetic credentials or notes reach another service',async()=>{
 let received=0;const sink=await localServer((_req,res)=>{received++;res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');});
 const source=await localServer((_req,res)=>{res.writeHead(307,{Location:sink.url+'/capture'});res.end();});
 try {
  await submitCredentials({baseUrl:source.url,mode:'login',email:'synthetic@example.invalid',password:'synthetic-only-password'});
  await requestChat({baseUrl:source.url,authorization:'synthetic-token',boundOrigin:source.url,body:{note:'synthetic note',consent:true,contextRevision:'none',workout:null,exercises:[]}});
  await requestTrends({baseUrl:source.url,authorization:'synthetic-token',boundOrigin:source.url,body:{range:{start:'2026-11-01',end:'2026-11-02'},workouts:[]}});
  await revokeServerSession(source.url,'synthetic-token',fetch,source.url);
  assert.equal(received,0);
 } finally {await source.close();await sink.close();}
});
test('untrusted account ids cannot introduce path components into a database filename',()=>{
 for(const id of ['../../other','folder/name','folder\\name','..','bad?query','a'.repeat(129)]) {
  const access=signedInAccess({accountId:id,email:'synthetic@example.invalid',displayName:'Synthetic',token:'synthetic-token',expiresAt:'2030-01-01T00:00:00Z'});
  assert.throws(()=>databaseFile(access));
  assert.equal(readStoredAccess(serializeAccess(access),'2026-11-09T00:00:00Z').discard,true);
 }
 assert.equal(databaseFile(signedInAccess({accountId:'a-safe-uuid',email:'synthetic@example.invalid',displayName:'Synthetic',token:'synthetic-token',expiresAt:'2030-01-01T00:00:00Z'})),'liftlog-a-safe-uuid.db');
});

test('credential destinations reject changed hosts, HTTP downgrade and missing binding',()=>{
 assert.throws(()=>assertCredentialDestination('https://other.example','https://account.example'));
 assert.throws(()=>assertCredentialDestination('http://account.example','https://account.example'));
 assert.throws(()=>assertCredentialDestination('https://account.example',null));
 assert.throws(()=>normalizeServerUrl('https://user:pass@account.example'));
 assert.throws(()=>normalizeServerUrl('https://account.example?token=synthetic'));
 assert.equal(normalizeServerUrl('https://account.example/'),'https://account.example');
 assert.doesNotThrow(()=>assertCredentialDestination('https://account.example','https://account.example'));
});
