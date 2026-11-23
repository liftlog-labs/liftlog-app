import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { stampOf, useWorkspace } from "../../composition/database";
import { gateProtectedCall, sameWorkspace } from "../../modules/accountSession";
import { courseBaseUrl } from "../../modules/chat";
import { hasAnalyticsConsent } from "../../modules/aiConsent";
import { buildTrendRequest, requestTrends, type TrendResult } from "../../modules/trends";
import { isValidLocalDate } from "../../shared/names";
import { BrandBar, EmptyState, Muted, PageHeading, Panel, Pill, Screen, SectionTitle, screenPadding } from "../../ui/chrome";
import { FieldLabel, PrimaryButton, TextAction, TextField } from "../../ui/fields";
import { daysInclusive, defaultTrendRange, formatPoundsDisplay, formatRangeLabel } from "../../ui/format";
import { Icon } from "../../ui/icons";
import { usePalette } from "../../ui/theme";

type Status =
  | { phase: "loading" }
  | { phase: "needs-permission" }
  | { phase: "sign-in" }
  | { phase: "unavailable" }
  | { phase: "ready"; result: TrendResult };

export default function ProgressScreen() {
  const palette = usePalette();
  const { capture, expire } = useWorkspace();
  const initial = defaultTrendRange();
  const [start, setStart] = useState(initial.start);
  const [end, setEnd] = useState(initial.end);
  const [draftStart, setDraftStart] = useState(initial.start);
  const [draftEnd, setDraftEnd] = useState(initial.end);
  const [editing, setEditing] = useState(false);
  const [dateMessage, setDateMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ phase: "loading" });
  const requestId = useRef(0);

  const load = useCallback(() => {
    const sent = capture();
    const id = requestId.current + 1;
    requestId.current = id;
    const gate = gateProtectedCall({
      access: sent.access,
      sent: stampOf(sent),
      active: stampOf(sent),
      consent: hasAnalyticsConsent(sent.db),
      now: new Date().toISOString(),
      targetServer: courseBaseUrl(sent.db),
    });
    if (gate.action === "stop") {
      setStatus(gate.code === "SIGN_IN" ? { phase: "sign-in" } : { phase: "needs-permission" });
      return;
    }
    setStatus({ phase: "loading" });
    const request = buildTrendRequest(sent.db, start, end);
    requestTrends({ baseUrl: courseBaseUrl(sent.db), body: request, authorization: gate.authorization, boundOrigin: sent.access.mode === "signed-in" ? sent.access.serverOrigin : null }).then(async (result) => {
      if (requestId.current !== id || capture().workspaceId !== sent.workspaceId) return;
      if (!result.ok && result.code === "SIGN_IN") {
        await expire();
        if (requestId.current !== id || capture().workspaceId !== sent.workspaceId) return;
        setStatus({ phase: "sign-in" });
        return;
      }
      if (!sameWorkspace(stampOf(sent), stampOf(capture()))) return;
      setStatus(result.ok ? { phase: "ready", result: result.value } : { phase: "unavailable" });
    });
  }, [capture, end, expire, start]);

  useFocusEffect(
    useCallback(() => {
      load();
      return () => {
        requestId.current += 1;
      };
    }, [load]),
  );

  function applyDates() {
    if (!isValidLocalDate(draftStart) || !isValidLocalDate(draftEnd) || draftStart > draftEnd) {
      setDateMessage("Enter a start and end as YYYY-MM-DD, with the start first.");
      return;
    }
    setDateMessage(null);
    setStart(draftStart);
    setEnd(draftEnd);
    setEditing(false);
  }

  const range = status.phase === "ready" ? status.result.range : { start, end };
  const heading = formatRangeLabel(range.start, range.end);

  return (
    <Screen>
      <BrandBar />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding} keyboardShouldPersistTaps="handled">
        <PageHeading eyebrow="Small wins, made visible." title="Your progress" />
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <SectionTitle>{heading}</SectionTitle>
          <Pressable accessibilityRole="button" onPress={() => setEditing((value) => !value)} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
            <Text style={{ color: palette.primary, fontSize: 13, fontWeight: "600" }}>Change dates</Text>
          </Pressable>
        </View>
        {editing ? (
          <View style={{ marginTop: 8 }}>
            <FieldLabel>Start date</FieldLabel>
            <TextField label="Start date" value={draftStart} onChangeText={setDraftStart} placeholder="YYYY-MM-DD" />
            <FieldLabel>End date</FieldLabel>
            <TextField label="End date" value={draftEnd} onChangeText={setDraftEnd} placeholder="YYYY-MM-DD" />
            {dateMessage ? <Text style={{ color: palette.warmInk, marginTop: 8 }}>{dateMessage}</Text> : null}
            <PrimaryButton label="Show this range" onPress={applyDates} />
          </View>
        ) : null}
        {status.phase === "loading" ? <Text style={{ color: palette.muted, marginTop: 24 }}>Loading your progress.</Text> : null}
        {status.phase === "needs-permission" ? (
          <EmptyState
            icon="progress"
            title={"Analysis needs\npermission."}
            body="Allow progress analysis to send workouts in the selected dates to your server."
            action={<PrimaryButton label="Review permission" onPress={() => router.push("/connection")} />}
          />
        ) : null}
        {status.phase === "sign-in" ? (
          <EmptyState
            icon="progress"
            title={"Sign in to\nload analysis."}
            body="Workouts in this workspace stay on this phone. Analysis waits until you sign in again."
            action={<PrimaryButton label="Open account" onPress={() => router.push("/account")} />}
          />
        ) : null}
        {status.phase === "unavailable" ? (
          <EmptyState
            icon="progress"
            title={"Progress is\nunavailable."}
            body="We couldn’t load your analysis. Your workouts are still saved on this phone."
            action={
              <View>
                <PrimaryButton label="Try again" onPress={() => load()} />
                <TextAction label="View workout history" onPress={() => router.push("/history")} />
              </View>
            }
          />
        ) : null}
        {status.phase === "ready" ? <Ready result={status.result} /> : null}
      </ScrollView>
    </Screen>
  );
}

function Ready({ result }: { result: TrendResult }) {
  const palette = usePalette();
  const days = daysInclusive(result.range.start, result.range.end);
  const [featured, ...rest] = result.exercises;
  return (
    <View>
      <Panel>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ color: palette.text, fontSize: 15, fontWeight: "700" }}>Workout overview</Text>
          <Icon name="progress" color={palette.primary} />
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 28, marginTop: 18 }}>
          <Stat value={String(result.workoutCount)} label="Workouts" />
          <Stat value={String(days)} label="Days in range" />
        </View>
      </Panel>
      {result.exercises.length === 0 ? <Text style={{ color: palette.muted, marginTop: 18 }}>No exercises in this range.</Text> : null}
      {featured ? <Featured exercise={featured} /> : null}
      {rest.map((exercise) => (
        <Panel key={exerciseKey(exercise)}>
          <Text style={{ color: palette.text, fontSize: 15, fontWeight: "700" }}>{exercise.name}</Text>
          <Metric label="Total volume" value={volumeLabel(exercise.totalVolumeLb)} />
          <Metric label="Sessions / week" value={exercise.frequencyPerWeek} />
          <Metric label="Sessions" value={String(exercise.sessionCount)} />
        </Panel>
      ))}
      <Muted size={12}>Based on workouts in your selected date range.</Muted>
    </View>
  );
}

function Featured({ exercise }: { exercise: TrendResult["exercises"][number] }) {
  const palette = usePalette();
  return (
    <View style={{ marginTop: 22 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <SectionTitle>{exercise.name}</SectionTitle>
        {exercise.totalVolumeLb != null ? <Pill label="Volume" warm /> : null}
      </View>
      <Text style={{ color: palette.muted, marginTop: 8 }}>{exercise.totalVolumeLb != null ? "Total lifted across all logged sets" : "No total volume for this exercise."}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 28, marginTop: 18 }}>
        <Stat value={exercise.totalVolumeLb != null ? formatPoundsDisplay(exercise.totalVolumeLb) : "—"} unit={exercise.totalVolumeLb != null ? "lb" : undefined} label="Total volume" />
        <Stat value={exercise.frequencyPerWeek} label="Sessions / week" />
      </View>
      <Metric label="Average volume / session" value={volumeLabel(exercise.averageVolumeLb)} />
      <Metric label="Sessions" value={String(exercise.sessionCount)} />
    </View>
  );
}

function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  const palette = usePalette();
  return (
    <View style={{ minWidth: 88 }}>
      <Text style={{ color: palette.text, fontSize: 23, fontWeight: "700", letterSpacing: -0.6, fontVariant: ["tabular-nums"] }}>
        {value} {unit ? <Text style={{ fontSize: 13, fontWeight: "400", color: palette.muted }}>{unit}</Text> : null}
      </Text>
      <Text style={{ color: palette.muted, fontSize: 12 }}>{label}</Text>
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  const palette = usePalette();
  return (
    <View style={{ minHeight: 44, paddingVertical: 17, borderBottomWidth: 1, borderBottomColor: palette.line, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <Text style={{ color: palette.muted, flex: 1 }}>{label}</Text>
      <Text style={{ color: palette.text, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{value}</Text>
    </View>
  );
}

function volumeLabel(value: string | null): string {
  if (value == null) return "—";
  return `${formatPoundsDisplay(value)} lb`;
}

function exerciseKey(exercise: TrendResult["exercises"][number]): string {
  return `${exercise.exerciseId}:${exercise.sessionCount}:${exercise.frequencyPerWeek}:${exercise.totalVolumeLb ?? "none"}`;
}
