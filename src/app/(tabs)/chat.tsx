import { protectedCallMessage } from "../../shared/result";
import { CoachingConversation } from "../../ui/CoachingConversation";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { stampOf, useDatabase, useWorkspace } from "../../composition/database";
import { gateProtectedCall, sameWorkspace } from "../../modules/accountSession";
import {
  applyChatResponse,
  buildChatRequest,
  courseBaseUrl,
  grantChatConsent,
  hasChatConsent,
  requestChat,
  undoLoggedSet,
  type ChatResponse,
} from "../../modules/chat";
import { fetchAiPolicy, canUseAiPolicy, aiConsentRevision, type AiPolicy } from "../../modules/aiConsent";
import { readSyncState } from "../../modules/syncStore";
import { getOpenWorkout, getWorkout } from "../../modules/workout";
import { createId } from "../../shared/id";
import { localDateString } from "../../shared/names";
import { BrandBar, PageHeading, Screen, screenPadding } from "../../ui/chrome";
import { formatClock } from "../../ui/format";
import { Icon } from "../../ui/icons";
import { usePalette } from "../../ui/theme";

type Receipt = {
  setId: string;
  workoutId: string;
  exerciseId: string;
  workoutLabel: string;
  exerciseName: string;
  loadLb: string | null;
  reps: number | null;
  assisted: boolean;
  setNumber: number;
  line: string;
};

type Item =
  | { id: string; kind: "user"; text: string; at: string }
  | { id: string; kind: "assistant"; title?: string; text: string; manual?: boolean }
  | { id: string; kind: "receipt"; receipt: Receipt; undone: boolean };

export default function ChatScreen() {
  const [mode, setMode] = useState<'Log' | 'Coach'>('Log');
  const palette = usePalette();
  const workspace = useWorkspace();
  return <SafeAreaView edges={['top','left','right']} style={{flex:1,backgroundColor:palette.background}}>
    <View style={{flexDirection:'row',paddingHorizontal:24,paddingTop:12,gap:12}}>
      {(['Log','Coach'] as const).map(value=><Pressable key={value} accessibilityRole="button" accessibilityState={{selected:mode===value}} onPress={()=>setMode(value)} style={{flex:1,padding:12,borderRadius:12,backgroundColor:mode===value?palette.soft:palette.surface}}><Text style={{color:palette.text,textAlign:'center',fontWeight:'600'}}>{value}</Text></Pressable>)}
    </View>
    <View style={{flex:1,display:mode==='Log'?'flex':'none'}} accessibilityElementsHidden={mode!=='Log'} importantForAccessibility={mode==='Log'?'auto':'no-hide-descendants'}>
      <LoggingConversation/>
    </View>
    {mode==='Coach'?<CoachingConversation key={`${workspace.workspaceId}:${workspace.generation}`}/>:null}
  </SafeAreaView>;
}

function LoggingConversation() {
  const palette = usePalette();
  const db = useDatabase();
  const workspace = useWorkspace();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [policy, setPolicy] = useState<AiPolicy | null>(null);
  const [consent, setConsent] = useState(() => hasChatConsent(db));
  const [openLabel, setOpenLabel] = useState<string | null>(() => getOpenWorkout(db)?.label ?? null);
  const [openId, setOpenId] = useState<string | null>(() => getOpenWorkout(db)?.workoutId ?? null);
  const [note, setNote] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [askConsent, setAskConsent] = useState(false);

  const refreshOpen = useCallback(() => {
    const open = getOpenWorkout(db);
    setOpenLabel(open?.label ?? null);
    setOpenId(open?.workoutId ?? null);
    setConsent(hasChatConsent(db));
  }, [db]);
  useFocusEffect(useCallback(() => refreshOpen(), [refreshOpen]));

  async function send(actionId = pendingId ?? createId()) {
    const text = note.trim();
    if (!text || sending) return;
    if (!hasChatConsent(db)) {
      setAskConsent(true);
      return;
    }
    setSending(true);
    setPendingId(actionId);
    const at = formatClock(new Date());
    setItems((current) => (current.some((item) => item.id === `${actionId}-user`) ? current : [...current, { id: `${actionId}-user`, kind: "user", text, at }]));
    const sent = workspace.capture();
    const gate = gateProtectedCall({
      access: sent.access,
      sent: stampOf(sent),
      active: stampOf(sent),
      consent: hasChatConsent(sent.db),
      now: new Date().toISOString(),
      targetServer: courseBaseUrl(sent.db),
    });
    if (gate.action === "stop") {
      setItems((current) => [
        ...withoutStatus(current, actionId),
        {
          id: `${actionId}-status`,
          kind: "assistant",
          title: "That set wasn’t saved.",
          text:
            protectedCallMessage(gate.code),
          manual: true,
        },
      ]);
      setSending(false);
      return;
    }
    const current = () => mounted.current && sameWorkspace(stampOf(sent), stampOf(workspace.capture()));
    try {
      const baseUrl = courseBaseUrl(sent.db);
      const boundOrigin = sent.access.mode === "signed-in" ? sent.access.serverOrigin ?? readSyncState(sent.db).origin : null;
      const fresh = await fetchAiPolicy({ db: sent.db, baseUrl, authorization: gate.authorization, boundOrigin, isCurrent: current });
      if (!current()) return;
      if (!fresh.ok) throw new Error(protectedCallMessage(fresh.code));
      setPolicy(fresh.value);
      if (fresh.value.external && !canUseAiPolicy(sent.db, baseUrl, fresh.value)) {
        setAskConsent(true);
        throw new Error("Review the named provider and allow AI sharing in Connections before sending.");
      }
      const consentRevision = aiConsentRevision(sent.db, baseUrl);
      const request = { ...buildChatRequest(sent.db, text), ...(fresh.value.external ? { aiPolicyId: fresh.value.providerId } : {}) };
      const response = await requestChat({ baseUrl, body: request, authorization: gate.authorization, boundOrigin });
      if (!current()) return;
      if (!response.ok) throw new Error(protectedCallMessage(response.code));
      if (aiConsentRevision(sent.db, baseUrl) !== consentRevision || !hasChatConsent(sent.db) || (fresh.value.external && !canUseAiPolicy(sent.db, baseUrl, fresh.value))) throw new Error("AI permission changed. This response was not saved.");
      const applied = applyChatResponse(sent.db, {
        actionId, sentRevision: request.contextRevision, response: response.value,
        now: new Date().toISOString(), localDate: localDateString(),
      });
      setItems((items) => [...withoutStatus(items, actionId), messageFor(sent.db, actionId, response.value, applied)]);
      if (applied.ok && applied.value.kind !== "clarify") setNote("");
      setPendingId(applied.ok ? null : actionId);
      refreshOpen();
    } catch (error) {
      if (current()) setItems((items) => [...withoutStatus(items, actionId), { id: `${actionId}-status`, kind: "assistant", title: "That set wasn’t saved.", text: error instanceof Error ? error.message : "Chat is unavailable. Your note is still here.", manual: true }]);
    } finally {
      if (mounted.current) setSending(false);
    }
  }

  function allow() {
    grantChatConsent(db);
    setConsent(true);
    setAskConsent(false);
  }

  function undo(receipt: Receipt) {
    const result = undoLoggedSet(db, receipt.setId, new Date().toISOString());
    if (!result.ok) {
      setItems((current) => [
        ...current.filter((item) => item.id !== `${receipt.setId}-undo`),
        { id: `${receipt.setId}-undo`, kind: "assistant", text: "Set not removed. Try again." },
      ]);
      return;
    }
    setItems((current) => current.map((item) => (item.kind === "receipt" && item.receipt.setId === receipt.setId ? { ...item, undone: true } : item)));
  }

  const manualHref = openId ? `/workout/${openId}` : "/";

  return (
    <Screen topSafeArea={false}
      footer={
        <View style={{ paddingHorizontal: 22, paddingTop: 12, paddingBottom: 8, backgroundColor: palette.background }}>
          <View style={{ flexDirection: "row", gap: 7, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 17, padding: 7, alignItems: "center" }}>
            <TextInput
              accessibilityLabel="Workout message"
              placeholder="What did you lift?"
              placeholderTextColor={palette.muted}
              value={note}
              onChangeText={setNote}
              onSubmitEditing={() => send()}
              editable={!sending}
              style={{ flex: 1, minHeight: 42, paddingHorizontal: 8, color: palette.text, fontSize: 15 }}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              disabled={sending || note.trim().length === 0}
              onPress={() => send()}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 12,
                backgroundColor: palette.primary,
                alignItems: "center",
                justifyContent: "center",
                opacity: sending || note.trim().length === 0 ? 0.55 : pressed ? 0.75 : 1,
              })}
            >
              <Icon name="send" color={palette.onPrimary} size={18} />
            </Pressable>
          </View>
          <Pressable accessibilityRole="button" onPress={() => router.push(manualHref)} style={({ pressed }) => ({ minHeight: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
            <Text style={{ color: palette.primary, fontSize: 13, fontWeight: "600" }}>Use manual entry</Text>
          </Pressable>
        </View>
      }
    >
      <BrandBar />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding} keyboardShouldPersistTaps="handled">
        <PageHeading eyebrow="Your workout, in your words." title="Workout chat" />
        <View style={{ backgroundColor: palette.soft, borderRadius: 13, paddingHorizontal: 15, paddingVertical: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Text style={{ color: palette.text, fontSize: 13, flex: 1 }}>{openLabel ?? "No workout open"}</Text>
          {openId ? (
            <Pressable accessibilityRole="button" onPress={() => router.push(`/workout/${openId}`)} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
              <Text style={{ color: palette.primary, fontSize: 13, fontWeight: "600" }}>Open workout</Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => router.push("/")} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
              <Text style={{ color: palette.primary, fontSize: 13, fontWeight: "600" }}>Start workout</Text>
            </Pressable>
          )}
        </View>
        {items.length > 0 ? <Text style={{ textAlign: "center", color: palette.muted, fontSize: 11, marginTop: 16 }}>Today, {items.find((item) => item.kind === "user") && items[0].kind === "user" ? items[0].at : formatClock(new Date())}</Text> : null}
        <View style={{ gap: 15, marginTop: 15 }}>
          <View style={{ alignSelf: "flex-start", maxWidth: "93%", backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 18, borderBottomLeftRadius: 4, padding: 15 }}>
            <Text style={{ color: palette.text, fontSize: 14 }}>Tell me the exercise, weight, and reps.</Text>
            <Text style={{ color: palette.muted, fontSize: 12, marginTop: 7 }}>Try “Squat, 135 lb, 8 reps”.</Text>
          </View>
          {!consent || askConsent ? (
            <View style={{ backgroundColor: palette.soft, borderRadius: 16, padding: 15 }}>
              <Text style={{ color: palette.text, fontWeight: "700" }}>Allow chat before the first note.</Text>
              <Text style={{ color: palette.muted, marginTop: 6, fontSize: 14 }}>
                Sending shares your note, active workout ID and name, context revision, and the entire exercise catalog (IDs, names, types) with your server {policy?.external ? `and ${policy.providerName}` : ""}. Freeform notes may contain sensitive information. Full workout history and your profile are not automatically included.
              </Text>
              <Pressable accessibilityRole="button" onPress={allow} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
                <Text style={{ color: palette.primary, fontWeight: "600" }}>Allow sending to server</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => router.push("/connection")} style={{ minHeight: 44, justifyContent: "center" }}>
                <Text style={{ color: palette.primary }}>Review AI provider and permission</Text>
              </Pressable>
              {policy ? <Text style={{ color: palette.muted }}>{policy.retentionNotice}</Text> : null}
            </View>
          ) : null}
          {items.map((item) => {
            if (item.kind === "user") {
              return (
                <View key={item.id} style={{ alignSelf: "flex-end", maxWidth: "93%", backgroundColor: palette.soft, borderRadius: 18, borderBottomRightRadius: 4, padding: 15 }}>
                  <Text style={{ color: palette.text, fontSize: 14 }}>{item.text}</Text>
                </View>
              );
            }
            if (item.kind === "assistant") {
              return (
                <View key={item.id} style={{ alignSelf: "flex-start", maxWidth: "93%", backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 18, borderBottomLeftRadius: 4, padding: 15 }}>
                  {item.title ? <Text style={{ color: palette.text, fontWeight: "700" }}>{item.title}</Text> : null}
                  <Text style={{ color: palette.text, fontSize: 14, marginTop: item.title ? 7 : 0 }}>{item.text}</Text>
                  {item.manual ? (
                    <Pressable accessibilityRole="button" onPress={() => router.push(manualHref)} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
                      <Text style={{ color: palette.primary, fontWeight: "600" }}>Log it manually</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            }
            if (item.undone) {
              return (
                <View key={item.id} style={{ alignSelf: "flex-start", maxWidth: "93%", backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 18, padding: 15 }}>
                  <Text style={{ color: palette.text, fontSize: 14 }}>Removed {item.receipt.line}</Text>
                </View>
              );
            }
            return (
              <View key={item.id} style={{ backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 18, padding: 17 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 10 }}>
                  <Icon name="saved" color={palette.primary} size={16} />
                  <Text style={{ color: palette.primary, fontSize: 12, fontWeight: "600" }}>Set saved</Text>
                </View>
                <Text style={{ color: palette.text, fontSize: 15, fontWeight: "700" }}>{item.receipt.exerciseName}</Text>
                <Text style={{ color: palette.text, fontSize: 22, fontWeight: "600", marginTop: 5, fontVariant: ["tabular-nums"] }}>
                  {item.receipt.loadLb ?? "—"} <Text style={{ color: palette.muted, fontSize: 15, fontWeight: "400" }}>lb</Text>
                  {" × "}
                  {item.receipt.reps ?? "—"} <Text style={{ color: palette.muted, fontSize: 15, fontWeight: "400" }}>reps</Text>
                </Text>
                <Text style={{ color: palette.muted, marginTop: 6 }}>
                  Added to {item.receipt.workoutLabel} · Set {item.receipt.setNumber}
                  {item.receipt.assisted ? " · Assisted" : ""}
                </Text>
                <View style={{ flexDirection: "row", gap: 20, marginTop: 7 }}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => router.push(`/workout/${item.receipt.workoutId}/set?exerciseId=${item.receipt.exerciseId}&setId=${item.receipt.setId}`)}
                    style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}
                  >
                    <Text style={{ color: palette.primary, fontSize: 13, fontWeight: "600" }}>Edit</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" onPress={() => undo(item.receipt)} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
                    <Text style={{ color: palette.primary, fontSize: 13, fontWeight: "600" }}>Undo</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </Screen>
  );
}

function withoutStatus(items: Item[], actionId: string) {
  return items.filter((item) => item.id !== `${actionId}-status`);
}

function messageFor(
  db: ReturnType<typeof useDatabase>,
  actionId: string,
  response: ChatResponse,
  applied: ReturnType<typeof applyChatResponse>,
): Item {
  if (!applied.ok) {
    return {
      id: `${actionId}-status`,
      kind: "assistant",
      title: "That set wasn’t saved.",
      text: applied.code === "STALE" ? "Your workout changed. Review where to save this set." : "Set not saved. Try again.",
      manual: true,
    };
  }
  if (applied.value.kind === "clarify") {
    return { id: `${actionId}-status`, kind: "assistant", text: applied.value.question ?? "Which exercise did you mean?" };
  }
  if (applied.value.kind === "saved" && applied.value.setId && applied.value.workoutId) {
    const workout = getWorkout(db, applied.value.workoutId);
    const entry = workout?.entries.find((item) => item.sets.some((set) => set.setId === applied.value.setId));
    const index = entry?.sets.findIndex((set) => set.setId === applied.value.setId) ?? -1;
    const set = index >= 0 ? entry?.sets[index] : undefined;
    return {
      id: `${actionId}-status`,
      kind: "receipt",
      undone: false,
      receipt: {
        setId: applied.value.setId,
        workoutId: applied.value.workoutId,
        exerciseId: entry?.exerciseId ?? "",
        workoutLabel: workout?.label || "Workout",
        exerciseName: entry?.name || "Set",
        loadLb: set?.loadLb ?? null,
        reps: set?.reps ?? null,
        assisted: set?.assisted ?? false,
        setNumber: index >= 0 ? index + 1 : 1,
        line: applied.value.line ?? set?.line ?? "Set",
      },
    };
  }
  if (response.status === "proposal" && response.proposal.kind === "start_workout") {
    return { id: `${actionId}-status`, kind: "assistant", text: applied.value.kind === "resumed" ? "Workout resumed." : "Workout started." };
  }
  return { id: `${actionId}-status`, kind: "assistant", text: applied.value.kind === "resumed" ? "Workout resumed." : "Workout started." };
}
