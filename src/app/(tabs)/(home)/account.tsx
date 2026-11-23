import { pilotOrigin } from "../../../shared/pilot";
import { useState } from "react";
import { ScrollView, Text } from "react-native";
import { useDatabase, useWorkspace } from "../../../composition/database";
import { authFailureMessage, submitCredentials } from "../../../modules/accountSession";
import { CLOUD_SYNC_VERSION, type SyncConflict } from "../../../modules/syncStore";
import { courseBaseUrl } from "../../../modules/chat";
import { Muted, NavBar, Notice, PageHeading, Panel, Screen, screenPadding } from "../../../ui/chrome";
import { FieldLabel, FilterChip, PrimaryButton, SecondaryButton, TextField } from "../../../ui/fields";
import { usePalette } from "../../../ui/theme";

export default function AccountScreen() {
  const palette = usePalette();
  const db = useDatabase();
  const workspace = useWorkspace();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [associationCollision, setAssociationCollision] = useState<"guest" | "legacy" | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [busy, setBusy] = useState(false);
  const access = workspace.access;
  const signedIn = access.mode === "signed-in";
  const held = access.mode === "signed-out-hold";

  async function submit() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    workspace.clearNotice();
    const attempt = await submitCredentials({
      baseUrl: courseBaseUrl(db),
      mode,
      email,
      password,
      displayName,
      ...(mode === "register" ? { cloudSyncConsent: CLOUD_SYNC_VERSION } : {}),
    });
    setPassword("");
    if (!attempt.ok) {
      setMessage(authFailureMessage(attempt.code));
      setBusy(false);
      return;
    }
    try {
      await workspace.signIn(attempt.session);
      setBusy(false);
    } catch {
      setMessage("The account session could not be opened. Workouts on this phone were not moved.");
      setBusy(false);
    }
  }

  async function perform(action: () => void | Promise<void>, association: "guest" | "legacy" | null = null) {
    if (busy) return;
    setBusy(true); setMessage(null);
    try { await action(); if (association) setAssociationCollision(null); }
    catch (error) {
      if (association && error instanceof Error && error.message === "ASSOCIATION_COLLISION") {
        setAssociationCollision(association); setMessage("Some local records share identities with account records. Both logs have been kept. Choose below to copy them with separate identities.");
      } else if (association && error instanceof Error && error.message === "FINISH_WORKOUT_BEFORE_ASSOCIATION") {
        setMessage(association === "guest" ? "Finish an open workout in one of the two logs, then try again. To open the original local-only log, sign out. Neither source log was changed." : "Finish an open workout in one of the two logs, then try again. The original legacy log and account records were kept.");
      } else setMessage("That change could not finish. Your saved records were kept. Try again when connected.");
    } finally { setBusy(false); }
  }

  async function logout() {
    if (busy) return;
    setBusy(true);
    try { await workspace.logout(); } catch { setMessage("Credentials could not be cleared. Try signing out again."); } finally { setBusy(false); }
  }

  return (
    <Screen>
      <NavBar title="Account" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding} keyboardShouldPersistTaps="handled">
        <PageHeading eyebrow="Your log stays on this phone." title="Account" />
        {signedIn ? (
          <Text style={{ color: palette.text, fontSize: 16, lineHeight: 23 }}>
            Signed in as {access.mode === "signed-in" ? access.email : ""}. Account history restores automatically. Logging works offline; cloud storage and model permissions are separate.
          </Text>
        ) : null}
        {held ? (
          <Text style={{ color: palette.text, fontSize: 16, lineHeight: 23 }}>
            The session for {access.mode === "signed-out-hold" ? access.email : ""} expired. Workouts for this account are still on this phone. Sign in again to resume account sync, chat or analysis.
          </Text>
        ) : null}
        {access.mode === "anonymous" ? (
          <Text style={{ color: palette.text, fontSize: 16, lineHeight: 23 }}>
            You can log workouts with no account. Those records stay in the local-only workspace. Signing in opens a separate workspace and does not upload or claim the records already here.
          </Text>
        ) : null}
        {workspace.notice ? <Text style={{ color: palette.primary, marginTop: 14, lineHeight: 21 }}>{workspace.notice}</Text> : null}
        {signedIn && workspace.sync?.consent === null && !workspace.sync.terminal ? <Panel>
          <Text style={{ color: palette.text, lineHeight: 22 }}>Enable cloud storage to sync this account’s workouts and training profile. Downloads and local logging remain available. Model permission is separate.</Text>
          <PrimaryButton label="Enable cloud storage" disabled={busy} onPress={() => void perform(workspace.enableCloud)} />
        </Panel> : null}
        {signedIn && !workspace.sync?.terminal ? <Panel>
          <Text style={{ color: palette.text, lineHeight: 22 }}>Add the local-only log from this phone to this account for cloud sync. This is optional and preserves the original local-only log.</Text>
          <SecondaryButton label="Add local-only log to this account" onPress={() => void perform(() => workspace.associateGuest(), "guest")} />
        </Panel> : null}
        {workspace.sync?.lastCode === "SERVER_CHANGED" ? <Notice title="Server settings changed" body="Sync is paused to protect this account’s log. Restore its original server address in Connection settings. Moving an existing account log to another server is not supported. Your local records are kept." /> : null}
        {workspace.sync?.lastCode === "ACCOUNT_MISMATCH" ? <Notice title="Account verification needed" body="The server returned a different account identity. Sync is paused. Review Connection settings, then sign out and sign in to the intended account. Your local records are kept." /> : null}
        {workspace.sync?.terminal ? <Notice title="Account sync stopped" body="This workspace is preserved on this phone. Sign in to a valid account before using account services." /> : null}
        {workspace.sync && workspace.sync.failures >= 5 && !workspace.sync.terminal ? <Notice title="Sync is having trouble" body="Your local workouts are saved. Check your connection and server settings. Sync will try again while the app is open." /> : null}
        {workspace.sync?.conflicts.map((conflict) => <ConflictCard key={conflict.id} conflict={conflict} busy={busy} resolve={(choice) => void perform(() => workspace.resolveConflict(conflict.id, choice))} repair={(action, value) => void perform(() => workspace.repairConflict(conflict.id, action, value))} />)}
        {signedIn ? <PrimaryButton label={busy ? "Signing out" : "Sign out"} onPress={logout} disabled={busy} /> : null}
        {!signedIn && mode === "register" ? (
          <Text style={{ color: palette.text, fontSize: 16, lineHeight: 23 }}>
            Creating an account enables cloud storage for workouts and your training profile in this account. Your account log syncs and restores across devices while logging still works offline. Existing local-only records move only when you choose below. Sending a note to a model stays a separate choice.
          </Text>
        ) : null}
        {workspace.needsLegacyChoice ? (
          <>
            <Text style={{ color: palette.text, fontSize: 16, lineHeight: 23, marginTop: 16 }}>
              This phone already has a log for this email. Explicitly add it to this account to include it in cloud sync, or leave it separate. The original log is preserved.
            </Text>
            <PrimaryButton label="Keep the existing log with this account" onPress={() => void perform(() => workspace.associateLegacy(), "legacy")} disabled={busy} />
            <SecondaryButton label="Keep it separate" onPress={workspace.declineLegacy} />
          </>
        ) : null}
        {signedIn ? null : (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 16 }} contentContainerStyle={{ gap: 8 }}>
              <FilterChip label="Sign in" selected={mode === "login"} onPress={() => setMode("login")} />
              {pilotOrigin ? null : <FilterChip label="Create account" selected={mode === "register"} onPress={() => setMode("register")} />}
            </ScrollView>
            {pilotOrigin ? <Muted>Use the pilot account provided by the operator.</Muted> : null}
            {mode === "register" ? (
              <>
                <FieldLabel>Display name</FieldLabel>
                <TextField label="Display name" value={displayName} onChangeText={setDisplayName} placeholder="Optional" />
              </>
            ) : null}
            <FieldLabel>Email</FieldLabel>
            <TextField label="Email" value={email} onChangeText={setEmail} keyboard="email-address" placeholder="you@example.com" />
            <FieldLabel>Password</FieldLabel>
            <TextField label="Password" value={password} onChangeText={setPassword} secure placeholder="Password" />
            <PrimaryButton label={busy ? "Checking" : mode === "register" ? "Create account" : "Sign in"} onPress={submit} disabled={busy} />
          </>
        )}
        {signedIn && associationCollision ? <PrimaryButton label="Keep both logs with separate identities" disabled={busy} onPress={() => void perform(() => associationCollision === "legacy" ? workspace.associateLegacy(true) : workspace.associateGuest(true), associationCollision)} /> : null}
        {message ? <Text style={{ color: palette.warmInk, marginTop: 14, lineHeight: 21 }}>{message}</Text> : null}
        {workspace.persistent ? null : (
          <Muted size={12}>This browser keeps the session in memory only. Refreshing the page forgets the token and returns to the local-only workspace.</Muted>
        )}
        {signedIn ? <Panel>
          <Text style={{color:palette.warmInk,fontSize:18}}>Delete account</Text>
          <Text style={{color:palette.text,lineHeight:22,marginTop:8}}>Deleting removes this account and its server history and revokes its sessions. This phone’s account copy will be quarantined and inaccessible. Local-only and other account logs are kept. The server retains your email and deletion markers to prevent old data returning. Backup removal and retention timing have not been verified.</Text>
          {deleteConfirm ? <>
            <FieldLabel>Confirm with your current password</FieldLabel>
            <TextField label="Deletion password" value={deletePassword} onChangeText={setDeletePassword} secure placeholder="Current password" />
            <PrimaryButton label={busy?"Deleting account":"Permanently delete my account"} disabled={busy || !deletePassword} onPress={()=>{if(busy)return;setBusy(true);const password=deletePassword;setDeletePassword("");void workspace.deleteAccount(password).catch(()=>setMessage("Deletion or credential cleanup could not finish. Follow the account recovery notice.")).finally(()=>setBusy(false));}} />
            <SecondaryButton label="Cancel deletion" onPress={()=>{if(!busy){setDeleteConfirm(false);setDeletePassword("");}}} />
          </> : <SecondaryButton label="Review account deletion" onPress={()=>{if(!busy)setDeleteConfirm(true);}} />}
        </Panel> : null}
        <Notice title="Password reset is unavailable" body="Contact the service operator if you cannot access your account." />
      </ScrollView>
    </Screen>
  );
}

const conflictFields: Record<string, string> = {
  name: "Name", type: "Exercise type", barWeightLb: "Bar weight (lb)", canonical: "Primary name",
  date: "Date", label: "Workout name", startedAt: "Started", endedAt: "Finished", position: "Order",
  loadLb: "Weight (lb)", reps: "Reps", durationSec: "Duration (seconds)", assisted: "Assisted", note: "Note", loggedAt: "Logged",
  goal: "Goal", experience: "Experience", trainingDays: "Days per week", sessionMinutes: "Session minutes", equipment: "Equipment", preferences: "Exercise preferences",
};
function readable(value: unknown): string {
  if (value == null) return "Not set";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((item) => typeof item === "object" ? String(item?.stance ?? "Preference saved") : String(item)).join(", ") || "None";
  return String(value);
}
function ConflictCard({ conflict, busy, resolve, repair }: {
  conflict: SyncConflict; busy: boolean; resolve: (choice: "server" | "local") => void;
  repair: (action: "finish" | "rename" | "separate", value?: string) => void;
}) {
  const palette = usePalette();
  const [name, setName] = useState("");
  const constrained = conflict.reason.toLowerCase().includes("constraint");
  const blocked = conflict.remote.deleted || /suppressed|parent|constraint/i.test(conflict.reason);
  const local = conflict.localPayload;
  const remote = conflict.remote.payload;
  const fields = Object.keys(conflictFields).filter((key) => JSON.stringify(local?.[key]) !== JSON.stringify(remote?.[key]));
  return <Panel>
    <Text style={{ color: palette.text, fontWeight: "700", fontSize: 16 }}>{conflict.recordType.replace(/_/g, " ")} needs a choice</Text>
    <Text style={{ color: palette.muted, marginTop: 8 }}>{conflict.remote.deleted ? "This record was deleted from the account. Your rejected edit is retained for review." : constrained ? "These records cannot fit together in this phone’s log. Choose how to preserve them." : "Your phone and account have different versions. Review the changes below."}</Text>
    {fields.map((key) => <Text key={key} style={{ color: palette.text, marginTop: 10, lineHeight: 21 }}>{conflictFields[key]}{`\nPhone: ${readable(local?.[key])}\nAccount: ${readable(remote?.[key])}`}</Text>)}
    {!fields.length ? <Text style={{ color: palette.muted, marginTop: 10 }}>The records differ in their linked workout or exercise. Both versions are retained until you choose.</Text> : null}
    <SecondaryButton label={conflict.remote.deleted ? "Accept account deletion" : "Use account version"} onPress={() => { if (!busy) resolve("server"); }} />
    {!blocked ? <SecondaryButton label="Keep my edit" onPress={() => { if (!busy) resolve("local"); }} /> : null}
    {constrained && conflict.recordType === "workout" ? <SecondaryButton label="Finish local workout and use account version" onPress={() => { if (!busy) repair("finish"); }} /> : null}
    {constrained && conflict.recordType === "exercise_name" ? <><FieldLabel>New name for phone exercise alias</FieldLabel><TextField label="New exercise alias" value={name} onChangeText={setName} placeholder="A separate exercise name" /><SecondaryButton label="Rename phone alias" onPress={() => { if (!busy && name.trim()) repair("rename", name.trim()); }} /></> : null}
    {constrained && conflict.recordType === "workout_exercise" ? <SecondaryButton label="Separate entry into a recovered workout" onPress={() => { if (!busy) repair("separate"); }} /> : null}
  </Panel>;
}
