/** Disposable real-HTTP verification. Run: node_modules/.bin/tsx scripts/test-mobile-sync.mts */
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {openNodeDatabase} from '../src/storage/nodeDriver';
import {migrate} from '../src/storage/schema';
import {createSyncWorker} from '../src/modules/mobileSync';
import {bindSync,CLOUD_SYNC_VERSION,listSyncConflicts,localPayload,prepareBatch,readSyncState,resolveSyncConflict} from '../src/modules/syncStore';
import {associateWorkspace} from '../src/modules/syncAssociation';
import {performAccountDeletion,recoverAccountDeletion,readAccountDeletion} from '../src/modules/accountDeletion';
import {memorySecretStore,signedInAccess,serializeAccess,SESSION_KEY} from '../src/modules/accountSession';
import {personalContextFromDatabase} from '../src/modules/personalContext';

const root=resolve(import.meta.dirname,'..');
const dir=mkdtempSync(join(tmpdir(),'liftlog-http-'));
const databaseSettings = process.env.LIFTLOG_TEST_POSTGRES_URL
  ? 'config.postgres_test_settings' : 'config.sync_test_settings';
const env={...process.env,CHAT_PROVIDER:'fake',DJANGO_SETTINGS_MODULE:databaseSettings,LIFTLOG_TEST_DATABASE:join(dir,'server.sqlite3')};
const python=join(root,'server/.venv/bin/python');
const now='2026-11-08T12:00:00.000Z';
const socket=createServer();await new Promise<void>(r=>socket.listen(0,'127.0.0.1',r));
const port=(socket.address() as {port:number}).port;await new Promise<void>(r=>socket.close(()=>r()));
const baseUrl=`http://127.0.0.1:${port}`;
const migrated=spawnSync(python,['manage.py','migrate','--noinput'],{cwd:join(root,'server'),env,encoding:'utf8'});
assert.equal(migrated.status,0,migrated.stderr);
const server=spawn(python,['manage.py','runserver',`127.0.0.1:${port}`,'--noreload'],{cwd:join(root,'server'),env,stdio:'ignore'});
const databases:ReturnType<typeof openNodeDatabase>[]=[];
const workers:ReturnType<typeof createSyncWorker>[]=[];
function db(file?:string){const value=openNodeDatabase(file);migrate(value,now);databases.push(value);return value;}
type Session={token:string;account:{accountId:string}};
async function register(name:string,consent=true):Promise<Session>{const response=await fetch(`${baseUrl}/api/v1/auth/register`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:`${name}@synthetic.invalid`,password:'Synthetic-only-password-498!',...(consent?{cloudSyncConsent:CLOUD_SYNC_VERSION}:{})})});assert.equal(response.status,201);return response.json() as Promise<Session>;}
function worker(database:ReturnType<typeof db>,session:Session,extras:Partial<Parameters<typeof createSyncWorker>[0]>={}){const value=createSyncWorker({db:database,accountId:session.account.accountId,baseUrl,token:session.token,isCurrent:()=>true,...extras});workers.push(value);return value;}
async function cycle(value:ReturnType<typeof worker>,database:ReturnType<typeof db>){await value.run();assert.equal(readSyncState(database).lastCode,null,JSON.stringify(readSyncState(database)));}
function seed(database:ReturnType<typeof db>){database.transaction(()=>{
 database.run("INSERT INTO exercise VALUES('synthetic-exercise','machine',NULL,?,?,NULL)",[now,now]);
 database.run("INSERT INTO exercise_name VALUES('synthetic-name','synthetic-exercise','Synthetic Press','synthetic press',1,?,?,NULL)",[now,now]);
 database.run("INSERT INTO workout(id,date,label,normalized_label,started_at,ended_at,created_at,updated_at) VALUES('synthetic-workout','2026-11-08','Synthetic','synthetic',?,?,?,?)",[now,now,now,now]);
 database.run("INSERT INTO workout_exercise VALUES('synthetic-entry','synthetic-workout','synthetic-exercise',1,?,?,NULL)",[now,now]);
 database.run("INSERT INTO workout_set VALUES('synthetic-set','synthetic-entry',1,'100',5,NULL,0,NULL,?,?,?,NULL)",[now,now,now]);
 database.run("INSERT INTO training_profile VALUES('local','hypertrophy',NULL,3,45,'[\"machine\"]',NULL,?,1)",[now]);
 });}
function context(database:ReturnType<typeof db>){
 const first=personalContextFromDatabase(database,now,'UTC');
 assert.deepEqual(personalContextFromDatabase(database,now,'UTC'),first,'context extraction must be deterministic');
 // These two stale-context tokens count local materializations, not synchronized domain edits.
 // Compare every semantic context field while verifying each full context is deterministic above.
 const {profileRevision: _profileRevision,revision: _revision,...semantic}=first;
 return semantic;
}
function passed(label:string){console.log(`PASS ${label}`);}
try {
 let ready = false;
 for (let attempt = 0; attempt < 400; attempt++) {
   assert.equal(server.exitCode, null, "Disposable Django server exited before readiness");
   try {
     ready = (await fetch(`${baseUrl}/api/v1/account`)).status === 401;
     if (ready) break;
   } catch {
     // The loopback port is not listening until Django starts.
   }
   await new Promise(resolve => setTimeout(resolve, 50));
 }
 assert.ok(ready, "Disposable Django server did not report readiness");
 const session=await register('primary');const a=db(join(dir,'a.sqlite3'));bindSync(a,session.account.accountId,baseUrl);seed(a);a.transaction(()=>{
 a.run("UPDATE exercise SET bar_weight_lb='0' WHERE id='synthetic-exercise'");
 a.run("UPDATE exercise_name SET display_name='Synthetic Press Edited', normalized_name='synthetic press edited' WHERE id='synthetic-name'");
 a.run("UPDATE workout SET label='Synthetic Edited',normalized_label='synthetic edited' WHERE id='synthetic-workout'");
 a.run("UPDATE workout_exercise SET position=2 WHERE id='synthetic-entry'");
 a.run("UPDATE workout_set SET note='Synthetic edited note' WHERE id='synthetic-set'");
 a.run("UPDATE training_profile SET session_minutes=50,revision=2 WHERE id='local'");
 });const wa=worker(a,session);
 for(let i=0;i<4;i++)await cycle(wa,a);
 assert.equal(a.get<{n:number}>('SELECT count(*) n FROM sync_outbox')?.n,0);
 const b=db();const wb=worker(b,session);for(let i=0;i<4;i++)await cycle(wb,b);
 for(const [type,id] of [['exercise','synthetic-exercise'],['exercise_name','synthetic-name'],['workout','synthetic-workout'],['workout_exercise','synthetic-entry'],['workout_set','synthetic-set'],['training_profile','local']] as const)assert.deepEqual(localPayload(b,type,id),localPayload(a,type,id));
 assert.deepEqual(context(b),context(a));assert.equal(context(b).performedVolumeLb,'500');passed('all six types upload, fresh restore, equivalent context and totals');
 const reinstall=db();await cycle(worker(reinstall,session),reinstall);assert.deepEqual(context(reinstall),context(a));passed('reinstall restoration');
 // Commit a push but deliberately lose its acknowledgment, then reopen durable client state.
 a.run("UPDATE workout_set SET reps=6 WHERE id='synthetic-set'");let sent='';let lost=false;
 const lostWorker=worker(a,session,{fetchImpl:async(input,init)=>{const response=await fetch(input,init);if(String(input).endsWith('/sync/push')&&!lost){sent=String(init?.body);lost=true;throw Error('synthetic lost ack');}return response;}});
 await lostWorker.run();assert.equal(readSyncState(a).lastCode,'UNAVAILABLE');lostWorker.stop();assert.ok(prepareBatch(a).length);
 const reopened=db(join(dir,'a.sqlite3'));let replay='';const replayWorker=worker(reopened,session,{fetchImpl:async(input,init)=>{if(String(input).endsWith('/sync/push')&&!replay)replay=String(init?.body);return fetch(input,init);}});await cycle(replayWorker,reopened);assert.deepEqual(JSON.parse(replay),JSON.parse(sent));await cycle(wb,b);assert.equal(context(b).performedVolumeLb,'600');passed('lost push acknowledgment and durable exact replay after restart');
 reopened.run("UPDATE workout_set SET reps=7 WHERE id='synthetic-set'");
 let connected = false;
 const reconnecting = worker(reopened, session, {
   fetchImpl: async (input, init) => {
     if (!connected) throw Error('synthetic offline');
     return fetch(input, init);
   },
 });
 await reconnecting.run();
 assert.equal(readSyncState(reopened).lastCode, 'UNAVAILABLE');
 connected = true;
 reconnecting.wake(0); // Same wake as the native network listener.
 for (let attempt = 0; attempt < 160 && readSyncState(reopened).lastCode !== null; attempt++) {
   await new Promise(resolve => setTimeout(resolve, 50));
 }
 assert.equal(readSyncState(reopened).lastCode, null);
 reconnecting.stop();
 await cycle(wb, b);
 assert.equal(context(b).performedVolumeLb, '700');
 passed('offline edits synced automatically after a reconnect wake');
 b.run("UPDATE workout_set SET reps=9 WHERE id='synthetic-set'");reopened.run("UPDATE workout_set SET reps=8 WHERE id='synthetic-set'");await cycle(worker(reopened,session),reopened);await cycle(wb,b);const conflicts=listSyncConflicts(b);assert.ok(conflicts.length);assert.equal(b.get<{reps:number}>("SELECT reps FROM workout_set WHERE id='synthetic-set'")?.reps,9);resolveSyncConflict(b,conflicts[0].id,'server');await cycle(wb,b);assert.equal(context(b).performedVolumeLb,'800');passed('concurrent edit preserves local version and explicit resolution');
 reopened.run("UPDATE workout_set SET deleted_at=? WHERE id='synthetic-set'",[now]);await cycle(worker(reopened,session),reopened);b.run("UPDATE workout_set SET reps=10 WHERE id='synthetic-set'");await cycle(wb,b);assert.ok(listSyncConflicts(b).some(c=>c.remote.deleted));assert.equal(b.get<{deleted_at:string}>("SELECT deleted_at FROM workout_set WHERE id='synthetic-set'")?.deleted_at!==null,true);passed('remote deletion defeats stale edit with conflict evidence');
 // More than one pull page, with interruption after one durable page.
 for(let i=0;i<110;i++) reopened.run("INSERT INTO workout(id,date,label,created_at,updated_at) VALUES(?,'2026-11-08',?,?,?)",[`page-${i}`,`Page ${i}`,now,now]);
 for(let i=0;i<3;i++)await cycle(worker(reopened,session),reopened);
 const interruptedFile=join(dir,'interrupted.sqlite3');const interrupted=db(interruptedFile);let pulls=0;
 const interruptWorker=worker(interrupted,session,{fetchImpl:async(input,init)=>{if(String(input).includes('/sync/pull')&&++pulls===2)throw Error('synthetic interrupted restore');return fetch(input,init);}});
 await interruptWorker.run();assert.equal(readSyncState(interrupted).lastCode,'UNAVAILABLE');assert.equal(readSyncState(interrupted).restored,false);assert.ok(readSyncState(interrupted).cursor>0);interruptWorker.stop();
 interrupted.run("INSERT INTO workout(id,date,label,created_at,updated_at) VALUES('during-restore','2026-11-08','During restore',?,?)",[now,now]);
 const resumed=db(interruptedFile);await cycle(worker(resumed,session),resumed);assert.equal(readSyncState(resumed).restored,true);assert.ok(resumed.get("SELECT id FROM workout WHERE id='during-restore'"));assert.equal(resumed.get<{n:number}>("SELECT count(*) n FROM workout WHERE id LIKE 'page-%'")?.n,110);passed('interrupted multi-page restore resumes with new logging retained');
 // Compact only the disposable server, leaving a stale device cursor and unsent local edit.
 const staleCursor=readSyncState(b).cursor;assert.ok(staleCursor>0);
 b.run("INSERT INTO workout(id,date,label,created_at,updated_at) VALUES('unsent-recovery','2026-11-08','Unsent recovery',?,?)",[now,now]);
 const compact=spawnSync(python,['manage.py','shell','-c',"from django.contrib.auth import get_user_model; from records.service import compact_change_log; u=get_user_model().objects.get(email='primary@synthetic.invalid'); compact_change_log(u,u.sync_state.cursor)"],{cwd:join(root,'server'),env,encoding:'utf8'});assert.equal(compact.status,0,compact.stderr);
 await cycle(wb,b);assert.equal(readSyncState(b).restored,true);assert.ok(b.get("SELECT id FROM workout WHERE id='unsent-recovery'"));assert.equal(b.get("SELECT seq FROM sync_outbox WHERE client_id='unsent-recovery'"),undefined);passed('expired cursor full recovery preserves and uploads unsent edit');
 const noConsent=await register('no-consent',false);const c=db();seed(c);const wc=worker(c,noConsent);await cycle(wc,c);assert.equal(readSyncState(c).consent,null);assert.ok(c.get('SELECT seq FROM sync_outbox LIMIT 1'));const fresh=db();await cycle(worker(fresh,noConsent),fresh);assert.equal(context(fresh).performedVolumeLb,'0');passed('consent isolation and disabled uploads');
 await wc.enableCloud();await cycle(wc,c);await cycle(worker(fresh,noConsent),fresh);assert.equal(context(fresh).performedVolumeLb,'500');passed('explicit cloud enablement uploads pending local history');
 c.run("UPDATE workout_set SET reps=2 WHERE id='synthetic-set'");await cycle(wc,c);await cycle(worker(fresh,noConsent),fresh);assert.equal(context(fresh).performedVolumeLb,'200');await cycle(worker(reopened,session),reopened);assert.ok(reopened.get<{deleted_at:string}>("SELECT deleted_at FROM workout_set WHERE id='synthetic-set'")?.deleted_at);assert.equal(localPayload(fresh,'workout','synthetic-workout')?.label,'Synthetic');assert.equal(localPayload(reopened,'workout','synthetic-workout')?.label,'Synthetic Edited');passed('identical record IDs remain isolated across accounts');
 const doomedSession=await register('delete-recreate');const doomed=db();seed(doomed);const doomedWorker=worker(doomed,doomedSession);await cycle(doomedWorker,doomed);assert.equal(doomed.get('SELECT seq FROM sync_outbox LIMIT 1'),undefined);
 const deleted=await fetch(`${baseUrl}/api/v1/account/delete`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${doomedSession.token}`},body:JSON.stringify({confirm:true,password:'Synthetic-only-password-498!'})});assert.equal(deleted.status,200);assert.deepEqual(await deleted.json(),{deleted:true,accountId:doomedSession.account.accountId});
 await doomedWorker.run();assert.equal(readSyncState(doomed).lastCode,'SIGN_IN');
 const recreatedSession=await register('delete-recreate');assert.notEqual(recreatedSession.account.accountId,doomedSession.account.accountId);const recreated=db();await cycle(worker(recreated,recreatedSession),recreated);assert.equal(recreated.get("SELECT id FROM workout WHERE id='synthetic-workout'"),undefined);assert.equal(recreated.get('SELECT id FROM training_profile'),undefined);assert.throws(()=>bindSync(doomed,recreatedSession.account.accountId,baseUrl));passed('account deletion revokes old session and same-email recreation restores no deleted history');
 const guest=db();seed(guest);const guestBefore=guest.all("SELECT name,sql FROM sqlite_master WHERE type='table'").map(row=>({name:row.name,rows:guest.all(`SELECT * FROM ${row.name} ORDER BY rowid`)}));const guestSession=await register('guest-association');const guestTarget=db();const guestWorker=worker(guestTarget,guestSession);await cycle(guestWorker,guestTarget);assert.equal(context(guestTarget).performedVolumeLb,'0');
 associateWorkspace(guest,guestTarget,'synthetic-guest');associateWorkspace(guest,guestTarget,'synthetic-guest');await cycle(guestWorker,guestTarget);const guestFresh=db();await cycle(worker(guestFresh,guestSession),guestFresh);assert.deepEqual(context(guestFresh),context(guest));assert.deepEqual(guest.all("SELECT name,sql FROM sqlite_master WHERE type='table'").map(row=>({name:row.name,rows:guest.all(`SELECT * FROM ${row.name} ORDER BY rowid`)})),guestBefore);passed('explicit guest association uploads once and fresh-restores without source mutation');
 // A frozen child request whose parent was deleted must not prevent pulling the tombstone.
 const parentSession=await register('parent-deletion');const parentA=db();seed(parentA);const parentWA=worker(parentA,parentSession);await cycle(parentWA,parentA);const parentB=db();const parentWB=worker(parentB,parentSession);await cycle(parentWB,parentB);
 parentA.run("UPDATE workout_set SET reps=17 WHERE id='synthetic-set'");const frozen=prepareBatch(parentA);assert.equal(frozen.length,1);assert.equal(frozen[0].payload?.reps,17);
 parentB.run("UPDATE workout_exercise SET deleted_at=? WHERE id='synthetic-entry'",[now]);await cycle(parentWB,parentB);
 let frozenReplay:unknown;const parentReplay=worker(parentA,parentSession,{fetchImpl:async(input,init)=>{if(String(input).endsWith('/sync/push')&&frozenReplay===undefined)frozenReplay=(JSON.parse(String(init?.body)) as {operations:unknown}).operations;return fetch(input,init);}});await cycle(parentReplay,parentA);assert.deepEqual(frozenReplay,frozen);
 assert.ok(parentA.get<{deleted_at:string}>("SELECT deleted_at FROM workout_exercise WHERE id='synthetic-entry'")?.deleted_at);assert.ok(parentA.get<{deleted_at:string}>("SELECT deleted_at FROM workout_set WHERE id='synthetic-set'")?.deleted_at);
 assert.ok(listSyncConflicts(parentA).some(conflict=>conflict.clientId==='synthetic-set'&&conflict.localPayload?.reps===17));assert.equal(parentA.get("SELECT seq FROM sync_outbox WHERE client_id='synthetic-set' AND blocked=0"),undefined);
 await cycle(parentReplay,parentA);const parentFresh=db();await cycle(worker(parentFresh,parentSession),parentFresh);assert.equal(context(parentFresh).performedVolumeLb,'0');assert.equal(parentFresh.get("SELECT id FROM workout_exercise WHERE id='synthetic-entry' AND deleted_at IS NULL"),undefined);passed('frozen child parent-not-found replay pulls deletion and preserves rejected local edit');
 const expired=db();let authPrompts=0;await worker(expired,session,{token:'synthetic-invalid-token',onAuthRequired:()=>authPrompts++}).run();assert.equal(readSyncState(expired).lastCode,'SIGN_IN');assert.equal(authPrompts,1);passed('invalid session stops protected sync and requests sign-in');
 const switched=db();let current=true;let release!:()=>void;let received!:()=>void;const arrived=new Promise<void>(r=>received=r);const gate=new Promise<void>(r=>release=r);
 const stale=worker(switched,session,{isCurrent:()=>current,fetchImpl:async(input,init)=>{const response=await fetch(input,init);received();await gate;return response;}});const pending=stale.run();await arrived;const before=readSyncState(switched);current=false;stale.stop();release();await pending;assert.deepEqual(readSyncState(switched),before);assert.throws(()=>bindSync(switched,noConsent.account.accountId,baseUrl));passed('account switch ignores delayed response and rejects cross-account binding');
 // Exercise the mobile deletion orchestration against the disposable real server.
 function snapshot(database:ReturnType<typeof db>){return database.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row=>({name:row.name,rows:database.all(`SELECT * FROM ${row.name} ORDER BY rowid`)}));}
 async function deletionInput(name:string){
  const session=await register(name);const database=db();seed(database);
  const access=signedInAccess({email:`${name}@synthetic.invalid`,displayName:'Synthetic',accountId:session.account.accountId,token:session.token,expiresAt:'2099-01-01',serverOrigin:baseUrl});
  const store=memorySecretStore();await store.set(SESSION_KEY,serializeAccess(access)!);
  const input={db:database,access,store,boundOrigin:baseUrl,configuredOrigin:baseUrl,password:'Synthetic-only-password-498!',isCurrent:()=>true};
  return {session,database,input};
 }
 const isolationGuestBefore=snapshot(guest);const isolationOtherBefore=snapshot(fresh);
 const mobileDelete=await deletionInput('mobile-confirmed');let deletionWorkerRequests=0;
 const preDeletionWorker=worker(mobileDelete.database,mobileDelete.session,{fetchImpl:async(input,init)=>{deletionWorkerRequests++;return fetch(input,init);}});
 assert.ok(mobileDelete.database.get('SELECT seq FROM sync_outbox LIMIT 1'));
 assert.equal(await performAccountDeletion(mobileDelete.input),'confirmed');
 assert.equal(await mobileDelete.input.store.get(SESSION_KEY),null);assert.equal(readAccountDeletion(mobileDelete.database),'confirmed');assert.equal(readSyncState(mobileDelete.database).terminal,true);
 await preDeletionWorker.run();assert.equal(deletionWorkerRequests,0);assert.deepEqual(prepareBatch(mobileDelete.database),[]);assert.ok(mobileDelete.database.get('SELECT seq FROM sync_outbox LIMIT 1'));
 assert.deepEqual(snapshot(guest),isolationGuestBefore);assert.deepEqual(snapshot(fresh),isolationOtherBefore);
 passed('mobile confirmed HTTP deletion clears credentials, quarantines pending rows and leaves guest/other databases unchanged');
 const mobileRecovery=await deletionInput('mobile-recovery');worker(mobileRecovery.database,mobileRecovery.session);
 assert.equal(await performAccountDeletion({...mobileRecovery.input,password:'Synthetic-wrong-password-498!'}),'pending');
 assert.equal(await recoverAccountDeletion(mobileRecovery.input),'confirmed');assert.equal(readAccountDeletion(mobileRecovery.database),'confirmed');assert.equal(readSyncState(mobileRecovery.database).terminal,true);assert.equal(await mobileRecovery.input.store.get(SESSION_KEY),null);
 assert.equal((await fetch(`${baseUrl}/api/v1/account`,{headers:{Authorization:`Bearer ${mobileRecovery.session.token}`}})).status,401);
 passed('mobile recovery logs into the original identity and confirms real HTTP deletion');
 const ambiguousDelete=await deletionInput('mobile-lost-ack');worker(ambiguousDelete.database,ambiguousDelete.session);
 const retainedCredentials=await ambiguousDelete.input.store.get(SESSION_KEY);let committedDelete=false;
 assert.equal(await performAccountDeletion({...ambiguousDelete.input,fetchImpl:async(input,init)=>{const response=await fetch(input,init);assert.equal(response.status,200);assert.equal((await response.json()).deleted,true);committedDelete=true;throw Error('synthetic lost deletion acknowledgment');}}),'pending');
 assert.equal(committedDelete,true);assert.equal(readAccountDeletion(ambiguousDelete.database),'pending');assert.equal(readSyncState(ambiguousDelete.database).terminal,true);assert.equal(await ambiguousDelete.input.store.get(SESSION_KEY),retainedCredentials);
 assert.equal((await fetch(`${baseUrl}/api/v1/account`,{headers:{Authorization:`Bearer ${ambiguousDelete.session.token}`}})).status,401);
 let retryStatus=0;assert.equal(await recoverAccountDeletion({...ambiguousDelete.input,fetchImpl:async(input,init)=>{const response=await fetch(input,init);retryStatus=response.status;return response;}}),'pending');assert.equal(retryStatus,401);assert.equal(readAccountDeletion(ambiguousDelete.database),'pending');assert.equal(readSyncState(ambiguousDelete.database).terminal,true);assert.deepEqual(prepareBatch(ambiguousDelete.database),[]);
 passed('lost real deletion acknowledgment remains pending and failed recovery login preserves quarantine');
 const mobileRecreatedSession=await register('mobile-lost-ack');assert.notEqual(mobileRecreatedSession.account.accountId,ambiguousDelete.session.account.accountId);
 const quarantineBefore=snapshot(ambiguousDelete.database);const recoveryPaths:string[]=[];
 assert.equal(await recoverAccountDeletion({...ambiguousDelete.input,fetchImpl:async(input,init)=>{recoveryPaths.push(new URL(String(input)).pathname);return fetch(input,init);}}),'pending');
 assert.deepEqual(recoveryPaths,['/api/v1/auth/login']);assert.deepEqual(snapshot(ambiguousDelete.database),quarantineBefore);assert.equal(await ambiguousDelete.input.store.get(SESSION_KEY),retainedCredentials);
 const recreatedAccountResponse=await fetch(`${baseUrl}/api/v1/account`,{headers:{Authorization:`Bearer ${mobileRecreatedSession.token}`}});assert.equal(recreatedAccountResponse.status,200);assert.equal((await recreatedAccountResponse.json()).accountId,mobileRecreatedSession.account.accountId);
 const mobileRecreatedDatabase=db();await cycle(worker(mobileRecreatedDatabase,mobileRecreatedSession),mobileRecreatedDatabase);assert.equal(mobileRecreatedDatabase.get('SELECT id FROM workout'),undefined);assert.equal(mobileRecreatedDatabase.get('SELECT id FROM training_profile'),undefined);assert.throws(()=>bindSync(ambiguousDelete.database,mobileRecreatedSession.account.accountId,baseUrl));
 passed('mobile recovery refuses same-email new identity, leaves account alive and restores empty history');
 const delayedDelete=await deletionInput('mobile-delayed');worker(delayedDelete.database,delayedDelete.session);let deletionCurrent=true;
 let deletionArrived!:()=>void;let releaseDeletion!:()=>void;const deletionReceived=new Promise<void>(r=>deletionArrived=r);const deletionGate=new Promise<void>(r=>releaseDeletion=r);
 const delayedResult=performAccountDeletion({...delayedDelete.input,isCurrent:()=>deletionCurrent,fetchImpl:async(input,init)=>{const response=await fetch(input,init);assert.equal(response.status,200);deletionArrived();await deletionGate;return response;}});
 await deletionReceived;const otherCredentials=serializeAccess(signedInAccess({email:'other@synthetic.invalid',displayName:'Other',accountId:noConsent.account.accountId,token:noConsent.token,expiresAt:'2099-01-01',serverOrigin:baseUrl}))!;
 await delayedDelete.input.store.set(SESSION_KEY,otherCredentials);deletionCurrent=false;const delayedOtherBefore=snapshot(fresh);releaseDeletion();assert.equal(await delayedResult,'stale');
 assert.equal(readAccountDeletion(delayedDelete.database),'pending');assert.equal(readSyncState(delayedDelete.database).terminal,true);assert.equal(await delayedDelete.input.store.get(SESSION_KEY),otherCredentials);assert.deepEqual(snapshot(fresh),delayedOtherBefore);assert.deepEqual(snapshot(guest),isolationGuestBefore);
 passed('late real deletion response cannot confirm or clear another active account credentials or database');
 console.log('HTTP synthetic integration completed. No external services or real histories used.');
} finally {for(const value of workers)value.stop();for(const value of databases)value.close();server.kill('SIGTERM');await new Promise<void>(r=>{if(server.exitCode!==null)r();else server.once('exit',()=>r());});rmSync(dir,{recursive:true,force:true});}
