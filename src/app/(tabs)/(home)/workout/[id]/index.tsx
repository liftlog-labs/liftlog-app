import { Redirect, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useDatabase, useWorkspace } from "../../../../../composition/database";
import { deleteSet, finishWorkout, getWorkout, type WorkoutEntry } from "../../../../../modules/workout";
import { Muted, NavBar, PageHeading, Panel, Pill, Screen, screenPadding } from "../../../../../ui/chrome";
import { PrimaryButton, SecondaryButton, TextAction } from "../../../../../ui/fields";
import { countPhrase, formatLongDate, oneParam } from "../../../../../ui/format";
import { Icon } from "../../../../../ui/icons";
import { usePalette } from "../../../../../ui/theme";

export default function ActiveWorkoutScreen() {
  const palette = usePalette();
  const db = useDatabase();
  const { dataVersion } = useWorkspace();
  const params = useLocalSearchParams<{ id: string }>();
  const workoutId = oneParam(params.id) ?? "";
  const [version, setVersion] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const workout = useMemo(() => {
    void version;
    void dataVersion;
    return getWorkout(db, workoutId);
  }, [db, workoutId, version, dataVersion]);

  useFocusEffect(useCallback(() => setVersion((value) => value + 1), []));

  if (!workout) {
    return (
      <Screen>
        <NavBar title="Workout" />
        <View style={{ padding: 22 }}>
          <Text style={{ color: palette.text, fontSize: 17 }}>That workout is not on this phone.</Text>
        </View>
      </Screen>
    );
  }

  if (workout.endedAt) return <Redirect href={`/history/${workout.workoutId}`} />;

  const live = workout;
  const openEntry = expanded ?? live.entries[0]?.entryId ?? null;
  const setCount = live.entries.reduce((sum, entry) => sum + entry.sets.length, 0);
  const [year, month, day] = live.date.split("-").map(Number);
  const when = new Date(year, month - 1, day);

  function finish() {
    const result = finishWorkout(db, live.workoutId, new Date().toISOString());
    if (!result.ok) {
      setMessage("Workout not finished. Try again.");
      return;
    }
    router.replace(`/history/${live.workoutId}`);
  }

  return (
    <Screen>
      <NavBar title="Workout" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding}>
        <PageHeading eyebrow={formatLongDate(when)} title={live.label} />
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <Pill label="In progress" icon="live" warm />
          <Muted>
            {countPhrase(live.entries.length, "exercise")} · {countPhrase(setCount, "set")}
          </Muted>
        </View>
        {message ? <Text style={{ color: palette.warmInk, marginTop: 12 }}>{message}</Text> : null}
        {live.entries.length === 0 ? <Text style={{ color: palette.muted, marginTop: 18 }}>Add an exercise to log a set.</Text> : null}
        {live.entries.map((entry) => (
          <ExerciseCard
            key={entry.entryId}
            entry={entry}
            open={openEntry === entry.entryId}
            managing={managing === entry.entryId}
            onToggle={() => setExpanded(openEntry === entry.entryId ? "" : entry.entryId)}
            onManage={() => setManaging(managing === entry.entryId ? null : entry.entryId)}
            onEdit={(setId) => router.push(`/workout/${live.workoutId}/set?exerciseId=${entry.exerciseId}&setId=${setId}`)}
            onLog={() => router.push(`/workout/${live.workoutId}/set?exerciseId=${entry.exerciseId}`)}
            onDelete={(setId) => {
              const removed = deleteSet(db, setId, new Date().toISOString());
              setMessage(removed.ok ? "Set deleted" : "Set not deleted. Try again.");
              setVersion((value) => value + 1);
            }}
          />
        ))}
        <SecondaryButton label="Add exercise" icon="plus" onPress={() => router.push(`/workout/${live.workoutId}/exercise`)} />
        <PrimaryButton label="Finish workout" onPress={finish} />
        <Text style={{ color: palette.muted, fontSize: 12, marginTop: 12 }}>Your workout stays open when you switch tabs.</Text>
      </ScrollView>
    </Screen>
  );
}

function ExerciseCard({
  entry,
  open,
  managing,
  onToggle,
  onManage,
  onEdit,
  onLog,
  onDelete,
}: {
  entry: WorkoutEntry;
  open: boolean;
  managing: boolean;
  onToggle: () => void;
  onManage: () => void;
  onEdit: (setId: string) => void;
  onLog: () => void;
  onDelete: (setId: string) => void;
}) {
  const palette = usePalette();
  const last = entry.sets[entry.sets.length - 1];
  const previous = entry.lastTimeHint?.split(", ") ?? [];
  if (!open) {
    return (
      <Panel>
        <Pressable accessibilityRole="button" accessibilityLabel={`${entry.name}, collapsed`} onPress={onToggle} style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <Text style={{ color: palette.text, fontSize: 17, fontWeight: "700", flex: 1 }}>{entry.name}</Text>
            <Icon name="down" color={palette.muted} />
          </View>
          <Text style={{ color: palette.muted, marginTop: 7 }}>
            {entry.sets.length === 0 ? "No sets yet" : `${countPhrase(entry.sets.length, "set")} logged${last ? ` · ${last.line}` : ""}`}
          </Text>
        </Pressable>
      </Panel>
    );
  }
  const showLoad = entry.type !== "bodyweight" && entry.type !== "duration";
  return (
    <Panel>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Pressable accessibilityRole="button" onPress={onToggle} style={{ flex: 1, minHeight: 44, justifyContent: "center" }}>
          <Text style={{ color: palette.text, fontSize: 17, fontWeight: "700" }}>{entry.name}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Set actions for ${entry.name}`} onPress={onManage} style={({ pressed }) => ({ width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
          <Icon name="more" color={palette.muted} />
        </Pressable>
      </View>
      <Muted>{last ? `Last set: ${last.line}${last.assisted ? " · Assisted" : ""}` : entry.lastTimeHint ? `Last time: ${entry.lastTimeHint}` : "No previous sets"}</Muted>
      <View style={{ flexDirection: "row", gap: 6, marginTop: 20, paddingBottom: 8 }}>
        <Text style={{ width: 32, color: palette.muted, fontSize: 11 }}>Set</Text>
        <Text style={{ flex: 1, color: palette.muted, fontSize: 11 }}>Previous</Text>
        {showLoad ? <Text style={{ width: 64, color: palette.muted, fontSize: 11, textAlign: "center" }}>lb</Text> : null}
        <Text style={{ width: entry.type === "duration" ? 88 : 64, color: palette.muted, fontSize: 11, textAlign: "center" }}>{entry.type === "duration" ? "Time" : "Reps"}</Text>
        <View style={{ width: 44 }} />
      </View>
      {entry.sets.map((set, index) => (
        <View key={set.setId} style={{ borderTopWidth: 1, borderTopColor: palette.line, paddingVertical: 11 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={{ width: 32, color: palette.text, fontSize: 14, fontVariant: ["tabular-nums"] }}>{index + 1}</Text>
            <Text style={{ flex: 1, color: palette.muted, fontSize: 12 }} numberOfLines={2}>
              {previous[index] ?? ""}
            </Text>
            {showLoad ? <Value text={set.loadLb ?? ""} /> : null}
            <Value text={set.durationSec != null ? formatDuration(set.durationSec) : set.reps != null ? String(set.reps) : ""} wide={entry.type === "duration"} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit set ${index + 1}, ${set.line}`}
              onPress={() => onEdit(set.setId)}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 9,
                backgroundColor: palette.primary,
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <Icon name="check" color={palette.onPrimary} size={16} />
            </Pressable>
          </View>
          {set.assisted ? <Text style={{ color: palette.warmInk, fontSize: 12, marginTop: 4 }}>Assisted</Text> : null}
          {managing ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Delete set ${index + 1}`} onPress={() => onDelete(set.setId)} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
              <Text style={{ color: palette.warmInk, fontSize: 13, fontWeight: "600" }}>Delete set {index + 1}</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      <TextAction label="+ Log a set" onPress={onLog} />
    </Panel>
  );
}

function Value({ text, wide = false }: { text: string; wide?: boolean }) {
  const palette = usePalette();
  return (
    <View style={{ width: wide ? 88 : 64, minHeight: 40, borderRadius: 9, backgroundColor: palette.background, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }}>
      <Text style={{ color: palette.text, fontSize: 14, fontVariant: ["tabular-nums"] }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
        {text}
      </Text>
    </View>
  );
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
