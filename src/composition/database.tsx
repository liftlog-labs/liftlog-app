import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Text, View } from "react-native";
import * as Network from "expo-network";
import { performAccountDeletion, recoverAccountDeletion, readAccountDeletion } from "../modules/accountDeletion";
import { PrimaryButton, SecondaryButton, TextField } from "../ui/fields";
import { createSyncWorker, type SyncWorker } from "../modules/mobileSync";
import { bindSync, rebindVerifiedAccount, readSyncState, listSyncConflicts, resolveSyncConflict, type SyncConflict } from "../modules/syncStore";
import { associateWorkspace } from "../modules/syncAssociation";
import { repairSyncConflict } from "../modules/syncRepairs";
import {
  ANONYMOUS_WORKSPACE,
  databaseFile,
  fetchAccount,
  holdAccess,
  legacyDatabaseFile,
  logoutNotice,
  readStoredAccess,
  revokeServerSession,
  serializeAccess,
  SESSION_KEY,
  signedInAccess,
  workspaceIdFor,
  type AccountSession,
  type LocalAccess,
  type WorkspaceStamp,
} from "../modules/accountSession";
import { courseBaseUrl, setCourseBaseUrl } from "../modules/chat";
import { attachmentForLogin, copyLegacyWorkspace, declineLegacyWorkspace, legacyChoiceDeclined, migrationComplete } from "../modules/workspaceMigration";
import { sqliteDatabaseExists } from "../storage/databaseFiles";
import { migrate } from "../storage/schema";
import { openNativeDatabase } from "../storage/nativeDriver";
import { deviceSecretStore } from "../storage/secretStore";
import type { SqlExecutor } from "../storage/sql";
import { AppearanceProvider, fallbackPalette } from "../ui/theme";

type Snapshot = {
  generation: number;
  workspaceId: string;
  access: LocalAccess;
  db: SqlExecutor;
};

export type WorkspaceSnap = Snapshot;

type WorkspaceApi = {
  access: LocalAccess;
  workspaceId: string;
  generation: number;
  persistent: boolean;
  notice: string | null;
  needsLegacyChoice: boolean;
  capture: () => WorkspaceSnap;
  signIn: (session: AccountSession) => Promise<void>;
  associateLegacy: (keepBoth?:boolean) => Promise<void>;
  declineLegacy: () => void;
  logout: () => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
  expire: () => Promise<void>;
  clearNotice: () => void;
  dataVersion: number;
  sync: (ReturnType<typeof readSyncState> & {conflicts: SyncConflict[]}) | null;
  enableCloud: () => Promise<void>;
  resolveConflict: (id:number,choice:"server"|"local") => void;
  repairConflict: (id:number,action:"finish"|"rename"|"separate",value?:string) => void;
  associateGuest: (keepBoth?:boolean) => Promise<void>;
};

const DatabaseContext = createContext<SqlExecutor | null>(null);
const WorkspaceContext = createContext<WorkspaceApi | null>(null);
let currentSnapshot: Snapshot | null = null;

function readSnapshot(): WorkspaceSnap {
  if (!currentSnapshot) throw new Error("Workspace missing");
  const current = currentSnapshot;
  return { generation: current.generation, workspaceId: current.workspaceId, access: current.access, db: current.db };
}

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<Awaited<ReturnType<typeof deviceSecretStore>> | null>(null);
  const chain = useRef(Promise.resolve());
  const workerRef = useRef<SyncWorker | null>(null);
  const [sync, setSync] = useState<WorkspaceApi["sync"]>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const dataSignature = useRef("");
  const stopSync = useCallback(() => { workerRef.current?.stop(); workerRef.current = null; }, []);
  const refreshSync = useCallback(() => {
    const current = currentSnapshot;
    if (!current || current.access.mode === "anonymous" || !current.access.accountId) { setSync(null); return; }
    const state = readSyncState(current.db);
    const conflicts = listSyncConflicts(current.db);
    const signature = `${current.generation}:${state.cursor}:${state.localVersion}:${conflicts.map(c=>c.id).join(",")}`;
    if (signature !== dataSignature.current) { dataSignature.current = signature; setDataVersion(v=>v+1); }
    const next = {...state,conflicts};
    setSync(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsLegacyChoice, setNeedsLegacyChoice] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [persistent, setPersistent] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const enqueue = useCallback((work: () => Promise<void>) => {
    const run = chain.current.then(work, work);
    chain.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  const openAccess = useCallback(async (access: LocalAccess, generation: number, baseUrl?: string) => {
    stopSync();
    const previous = currentSnapshot;
    const file = databaseFile(access);
    if (previous && databaseFile(previous.access) === file) {
      if(baseUrl && access.mode !== "anonymous" && access.accountId && !readAccountDeletion(previous.db)) {
        rebindVerifiedAccount(previous.db,access.accountId,baseUrl);
        setCourseBaseUrl(previous.db,baseUrl);
      }
      const next: Snapshot = { ...previous, generation, workspaceId: workspaceIdFor(access), access };
      currentSnapshot = next;
      setSnapshot(next);
      refreshSync();
      return;
    }
    const db = await openNativeDatabase(file);
    try {
      migrate(db);
      if (baseUrl && !readAccountDeletion(db)) {
        if(readSyncState(db).accountId && access.mode !== "anonymous" && access.accountId) rebindVerifiedAccount(db,access.accountId,baseUrl);
        setCourseBaseUrl(db,baseUrl);
      }
      if (access.mode !== "anonymous" && access.accountId && !readAccountDeletion(db)) {
        const origin = readSyncState(db).origin ?? courseBaseUrl(db);
        bindSync(db, access.accountId, origin);
      }
    } catch (cause) {
      db.close();
      throw cause;
    }
    const next: Snapshot = { generation, workspaceId: workspaceIdFor(access), access, db };
    currentSnapshot = next;
    if (previous) {
      try {
        previous.db.close();
      } catch {
        // The previous workspace is already closed.
      }
    }
    setSnapshot(next);
    refreshSync();
  }, [stopSync, refreshSync]);

  useEffect(() => {
    let cancelled = false;
    enqueue(async () => {
      const store = await deviceSecretStore();
      storeRef.current = store;
      if (cancelled) return;
      setPersistent(store.persistent);
      const raw = await store.get(SESSION_KEY);
      const read = readStoredAccess(raw, new Date().toISOString());
      if (read.discard) await store.remove(SESSION_KEY);
      else if (read.rewrite) await store.set(SESSION_KEY, read.rewrite);
      if (cancelled) return;
      await openAccess(read.access, 1);
      if (cancelled || read.access.mode !== "signed-in" || read.access.accountId || !currentSnapshot) return;
      const remote = await fetchAccount(courseBaseUrl(currentSnapshot.db), read.access.token, fetch, read.access.serverOrigin);
      if (cancelled || !currentSnapshot) return;
      if (!remote.ok) {
        if (remote.code === "SIGN_IN") {
          const held = holdAccess(read.access);
          const record = serializeAccess(held);
          if (record) await store.set(SESSION_KEY, record);
          const next: Snapshot = { ...currentSnapshot, generation: 2, access: held };
          currentSnapshot = next;
          setSnapshot(next);
        }
        return;
      }
      if (attachmentForLogin("continuous") !== "copy") return;
      const nextAccess = signedInAccess({
        email: remote.email,
        displayName: remote.displayName,
        accountId: remote.accountId,
        serverOrigin: read.access.serverOrigin,
        token: read.access.token,
        expiresAt: read.access.expiresAt,
      });
      const target = await openNativeDatabase(databaseFile(nextAccess));
      try {
        migrate(target);
        copyLegacyWorkspace(currentSnapshot.db, target, remote.accountId, read.access.accountKey);
      } finally {
        target.close();
      }
      const record = serializeAccess(nextAccess);
      if (record) await store.set(SESSION_KEY, record);
      await openAccess(nextAccess, 2);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "The database could not be opened.");
    });
    return () => {
      cancelled = true;
    };
  }, [enqueue, openAccess]);

  const capture = useCallback(() => readSnapshot(), []);

  const signIn = useCallback(
    (session: AccountSession) => {
      stopSync();
      const loginBaseUrl = currentSnapshot ? courseBaseUrl(currentSnapshot.db) : "http://127.0.0.1:8000";
      return enqueue(async () => {
        const access = signedInAccess(session);
        const record = serializeAccess(access);
        if (!storeRef.current || !record) throw new Error("Session store missing");
        await storeRef.current.set(SESSION_KEY, record);
        const generation = (currentSnapshot?.generation ?? 0) + 1;
        const legacyName = legacyDatabaseFile(session.email);
        const legacyExists = sqliteDatabaseExists(legacyName);
        try {
          await openAccess(access, generation, loginBaseUrl);
        } catch (cause) {
          await storeRef.current.remove(SESSION_KEY);
          throw cause;
        }
        const opened = currentSnapshot;
        if(opened && session.cloudSyncConsent) { opened.db.run("UPDATE sync_state SET consent=? WHERE id=1",[session.cloudSyncConsent]); refreshSync(); }
        const offer =
          legacyExists &&
          opened !== null &&
          attachmentForLogin("fresh") === "separate" &&
          !migrationComplete(opened.db, session.accountId) &&
          !legacyChoiceDeclined(opened.db, access.accountKey);
        setNeedsLegacyChoice(offer);
        setNotice(null);
      });
    },
    [enqueue, openAccess, stopSync, refreshSync],
  );

  const associateLegacy = useCallback(
    (keepBoth=false) =>
      enqueue(async () => {
        const current = currentSnapshot;
        if (!current || current.access.mode === "anonymous" || !current.access.accountId) return;
        if (attachmentForLogin("explicit") !== "copy") return;
        const legacy = await openNativeDatabase(legacyDatabaseFile(current.access.email));
        try {
          migrate(legacy);
          associateWorkspace(legacy, current.db, `legacy:${current.access.accountKey}`,keepBoth);
          refreshSync(); workerRef.current?.wake(0);
        } finally {
          legacy.close();
        }
        setNeedsLegacyChoice(false);
      }),
    [enqueue, refreshSync],
  );

  const declineLegacy = useCallback(() => {
    const current = currentSnapshot;
    if (!current || current.access.mode === "anonymous") return;
    declineLegacyWorkspace(current.db, current.access.accountKey);
    setNeedsLegacyChoice(false);
  }, []);

  const expire = useCallback(
    () => {
      stopSync();
      return enqueue(async () => {
        const current = currentSnapshot;
        if (!current || current.access.mode !== "signed-in" || !storeRef.current) return;
        const access = holdAccess(current.access);
        const record = serializeAccess(access);
        if (record) await storeRef.current.set(SESSION_KEY, record);
        const next: Snapshot = { ...current, generation: current.generation + 1, access };
        currentSnapshot = next;
        setSnapshot(next);
        refreshSync();
      });
    },
    [enqueue, stopSync, refreshSync],
  );

  const logout = useCallback(
    () => {
      stopSync();
      return enqueue(async () => {
        const current = currentSnapshot;
        const store = storeRef.current;
        if (!current || !store) return;
        const token = current.access.mode === "signed-in" ? current.access.token : null;
        const baseUrl = courseBaseUrl(current.db);
        await store.remove(SESSION_KEY);
        const generation = current.generation + 1;
        await openAccess({ mode: "anonymous" }, generation);
        setNeedsLegacyChoice(false);
        if (!token) {
          setNotice(logoutNotice("local"));
          return;
        }
        const outcome = await revokeServerSession(baseUrl, token, fetch, current.access.mode === "signed-in" ? current.access.serverOrigin : null);
        setNotice(logoutNotice(outcome));
      });
    },
    [enqueue, openAccess, stopSync],
  );

  const deleteAccount = useCallback((password: string) => {
    stopSync();
    const captured=currentSnapshot;
    if (!captured || captured.access.mode === "anonymous" || !storeRef.current) return Promise.reject(Error("Sign in first."));
    if(readAccountDeletion(captured.db)!=="confirmed") captured.db.run("INSERT INTO preference(key,value) VALUES('sync_account_deletion','pending') ON CONFLICT(key) DO UPDATE SET value='pending'");
    const next={...captured,generation:captured.generation+1};
    currentSnapshot=next; setSnapshot(next);
    return enqueue(async()=>{
      const isCurrent=()=>currentSnapshot?.generation===next.generation && currentSnapshot.workspaceId===next.workspaceId;
      if(!isCurrent() || !storeRef.current) return;
      const args={db:next.db,access:next.access,store:storeRef.current,boundOrigin:readSyncState(next.db).origin,configuredOrigin:courseBaseUrl(next.db),password,isCurrent};
      try {
        const outcome=await (readAccountDeletion(next.db)==="pending" ? recoverAccountDeletion(args) : performAccountDeletion(args));
        if(!isCurrent()) return;
        if(outcome==="confirmed") {
          await openAccess({mode:"anonymous"},next.generation+1);
          setNotice("Account deletion confirmed. Server account history was removed and sessions revoked. This phone’s account copy remains quarantined and inaccessible. Local-only and other account logs were kept.");
        } else setNotice("Deletion is not confirmed. Account data is quarantined and sync is stopped. Retry with your password. If the account was already deleted after a lost response, verification may fail; that is not proof of deletion.");
      } catch(cause) {
        setNotice(cause instanceof Error ? cause.message : "Deletion could not finish.");
        throw cause;
      } finally { if(isCurrent()) {setSnapshot({...next});refreshSync();} }
    });
  },[enqueue,openAccess,refreshSync,stopSync]);

  useEffect(() => {
    if (!snapshot || snapshot.access.mode !== "signed-in" || !snapshot.access.accountId || readAccountDeletion(snapshot.db)) return;
    const captured = snapshot;
    const baseUrl = courseBaseUrl(captured.db).replace(/\/$/, "");
    const state = readSyncState(captured.db);
    const worker = state.origin === baseUrl ? createSyncWorker({
      db: captured.db, accountId: snapshot.access.accountId, baseUrl, token: snapshot.access.token,
      isCurrent: () => currentSnapshot?.generation === captured.generation && currentSnapshot.workspaceId === captured.workspaceId && courseBaseUrl(captured.db).replace(/\/$/, "") === baseUrl,
      onChange: refreshSync,
      onAuthRequired: () => { void expire(); },
    }) : null;
    workerRef.current = worker;
    const initial = setTimeout(() => {
      if (worker) worker.setActive(AppState.currentState === "active" || AppState.currentState === null);
      else setSync({...state,lastCode:"SERVER_CHANGED",conflicts:listSyncConflicts(captured.db)});
    }, 0);
    const app = AppState.addEventListener("change", state => worker?.setActive(state === "active"));
    const network = Network.addNetworkStateListener(state => { if (state.isConnected) worker?.wake(0); });
    let lastVersion = readSyncState(captured.db).localVersion;
    const poll = setInterval(() => {
      if (currentSnapshot?.generation !== captured.generation) return;
      if (courseBaseUrl(captured.db).replace(/\/$/, "") !== baseUrl) {
        worker?.stop();
        const next = {...captured,generation:captured.generation+1};
        currentSnapshot=next; setSnapshot(next);
        return;
      }
      const version = readSyncState(captured.db).localVersion;
      if (version !== lastVersion) { lastVersion=version; refreshSync(); worker?.wake(); }
    }, 500);
    return () => { clearTimeout(initial); clearInterval(poll); app.remove(); network.remove(); worker?.stop(); if(workerRef.current === worker) workerRef.current=null; };
  }, [snapshot, refreshSync, expire]);

  const clearNotice = useCallback(() => setNotice(null), []);

  const enableCloud = useCallback(async () => { await workerRef.current?.enableCloud(); }, []);
  const resolveConflict = useCallback((id:number,choice:"server"|"local") => {
    const snap = readSnapshot(); if(snap.access.mode !== "signed-in") throw Error("Sign in first");
    resolveSyncConflict(snap.db,id,choice); refreshSync(); workerRef.current?.wake(0);
  }, [refreshSync]);
  const repairConflict = useCallback((id:number,action:"finish"|"rename"|"separate",value?:string) => {
    const snap=readSnapshot(); if(snap.access.mode !== "signed-in") throw Error("Sign in first");
    repairSyncConflict(snap.db,id,action,value); refreshSync(); workerRef.current?.wake(0);
  }, [refreshSync]);
  const associateGuest = useCallback(async (keepBoth=false) => {
    const snap=readSnapshot(); if(snap.access.mode !== "signed-in") throw Error("Sign in first");
    const guest=await openNativeDatabase("liftlog.db");
    try {
      if(currentSnapshot?.generation !== snap.generation) throw Error("Workspace changed");
      migrate(guest); associateWorkspace(guest,snap.db,"anonymous",keepBoth);
    }
    finally { guest.close(); }
    refreshSync(); workerRef.current?.wake(0);
  }, [refreshSync]);

  const api = useMemo<WorkspaceApi | null>(() => {
    if (!snapshot) return null;
    return {
      access: snapshot.access,
      workspaceId: snapshot.workspaceId,
      generation: snapshot.generation,
      persistent,
      notice,
      needsLegacyChoice,
      capture,
      signIn,
      associateLegacy,
      declineLegacy,
      logout,
      deleteAccount,
      expire,
      clearNotice,
      sync, dataVersion, enableCloud, resolveConflict, repairConflict, associateGuest,
    };
  }, [snapshot, persistent, notice, needsLegacyChoice, capture, signIn, associateLegacy, declineLegacy, logout, deleteAccount, expire, clearNotice, sync, dataVersion, enableCloud, resolveConflict, repairConflict, associateGuest]);

  if (!snapshot) {
    return (
      <View style={{ flex: 1, backgroundColor: fallbackPalette.background, padding: 24, justifyContent: "center" }}>
        <Text style={{ color: fallbackPalette.warmInk, fontSize: 18 }}>{error ? "Could not open your workouts." : "Opening your log."}</Text>
        {error ? <Text style={{ color: fallbackPalette.text, marginTop: 8 }}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <DatabaseContext.Provider value={snapshot.db}>
      <WorkspaceContext.Provider value={api}>
        <AppearanceProvider key={snapshot.workspaceId || ANONYMOUS_WORKSPACE} db={snapshot.db}>
          {readAccountDeletion(snapshot.db) ? <View style={{flex:1,padding:24,justifyContent:"center",backgroundColor:fallbackPalette.background}}>
            <Text style={{color:fallbackPalette.text,fontSize:22}}>Account workspace quarantined</Text>
            <Text style={{color:fallbackPalette.text,marginVertical:16}}>{readAccountDeletion(snapshot.db)==="confirmed" ? "Server deletion was confirmed, but credential cleanup did not finish. The account copy is inaccessible and uploads are blocked. Return to the local-only log to retry clearing credentials." : "Deletion is not confirmed. Sync and access to this account’s local history are stopped. Enter the original account password to verify its identity and retry. A failed login cannot confirm deletion. Local-only and other account logs are kept."}</Text>
            {notice ? <Text style={{color:fallbackPalette.warmInk,marginBottom:12}}>{notice}</Text> : null}
            {readAccountDeletion(snapshot.db)==="pending" ? <><TextField label="Original account password" value={recoveryPassword} onChangeText={setRecoveryPassword} secure placeholder="Password" /><PrimaryButton label={deletionBusy?"Checking deletion":"Verify and retry deletion"} disabled={deletionBusy || !recoveryPassword} onPress={()=>{setDeletionBusy(true);const password=recoveryPassword;setRecoveryPassword("");void deleteAccount(password).catch(()=>undefined).finally(()=>setDeletionBusy(false));}} /></> : null}
            <SecondaryButton label="Return to local-only log" onPress={()=>{if(deletionBusy)return;setDeletionBusy(true);void logout().catch(()=>setNotice("Credentials could not be cleared. This account remains quarantined; try again.")).finally(()=>setDeletionBusy(false));}} />
          </View> : children}
        </AppearanceProvider>
      </WorkspaceContext.Provider>
    </DatabaseContext.Provider>
  );
}

export function useDatabase(): SqlExecutor {
  const db = useContext(DatabaseContext);
  if (!db) throw new Error("Database missing");
  return db;
}

export function useWorkspace(): WorkspaceApi {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("Workspace missing");
  return workspace;
}

export function stampOf(snap: WorkspaceSnap): WorkspaceStamp {
  return { generation: snap.generation, workspaceId: snap.workspaceId };
}
