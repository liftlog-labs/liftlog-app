import { Redirect, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useDatabase, useWorkspace } from "../../../composition/database";
import { getWorkout, type WorkoutDetail } from "../../../modules/workout";
import { NavBar, PageHeading, Pill, Screen, screenPadding } from "../../../ui/chrome";
import { exerciseTypeLabel, formatLongDate, minutesBetween, oneParam } from "../../../ui/format";
import { usePalette } from "../../../ui/theme";

export default function WorkoutDetailScreen() {
  const palette = usePalette();
  const db = useDatabase();
  const { dataVersion } = useWorkspace();
  const workoutId = oneParam(useLocalSearchParams<{ id: string }>().id) ?? "";
  const [workout, setWorkout] = useState<WorkoutDetail | null>(() => getWorkout(db, workoutId));
  useFocusEffect(
    useCallback(() => {
      void dataVersion;
      setWorkout(getWorkout(db, workoutId));
    }, [db, workoutId, dataVersion]),
  );

  if (!workout) {
    return (
      <Screen>
        <NavBar title="Workout details" />
        <View style={{ padding: 22 }}>
          <Text style={{ color: palette.text, fontSize: 17 }}>That workout is not on this phone.</Text>
        </View>
      </Screen>
    );
  }
  if (!workout.endedAt) return <Redirect href={`/workout/${workout.workoutId}`} />;

  const [year, month, day] = workout.date.split("-").map(Number);
  const minutes = minutesBetween(workout.startedAt, workout.endedAt);
  const setCount = workout.entries.reduce((sum, entry) => sum + entry.sets.length, 0);

  return (
    <Screen>
      <NavBar title="Workout details" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding}>
        <PageHeading eyebrow={formatLongDate(new Date(year, month - 1, day))} title={workout.label} />
        <Pill label="Finished" icon="check" />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 28, marginTop: 18, marginBottom: 8 }}>
          <Stat value={minutes ? String(minutes) : "—"} unit={minutes ? "min" : undefined} label="Duration" />
          <Stat value={String(workout.entries.length)} label="Exercises" />
          <Stat value={String(setCount)} label="Sets logged" />
        </View>
        {workout.entries.map((entry) => (
          <View key={entry.entryId} style={{ marginTop: 8 }}>
            <View style={{ height: 1, backgroundColor: palette.line, marginVertical: 20 }} />
            <Text style={{ color: palette.text, fontSize: 17, fontWeight: "700" }}>{entry.name}</Text>
            <Text style={{ color: palette.muted, marginTop: 7 }}>{exerciseTypeLabel(entry.type)}</Text>
            {entry.sets.length === 0 ? <Text style={{ color: palette.muted, marginTop: 12 }}>No sets logged.</Text> : null}
            {entry.sets.map((set, index) => (
              <View key={set.setId} style={{ minHeight: 44, paddingVertical: 17, borderBottomWidth: 1, borderBottomColor: palette.line, flexDirection: "row", alignItems: "center", gap: 12 }}>
                <Text style={{ color: palette.muted, width: 64 }}>Set {index + 1}</Text>
                <Text style={{ color: palette.text, fontWeight: "600", flex: 1, fontVariant: ["tabular-nums"] }}>
                  {set.line}
                  {set.assisted ? " · Assisted" : ""}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit set ${index + 1}`}
                  onPress={() => router.push(`/workout/${workout.workoutId}/set?exerciseId=${entry.exerciseId}&setId=${set.setId}`)}
                  style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}
                >
                  <Text style={{ color: palette.primary, fontSize: 13, fontWeight: "600" }}>Edit</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  const palette = usePalette();
  return (
    <View>
      <Text style={{ color: palette.text, fontSize: 23, fontWeight: "700", letterSpacing: -0.6, fontVariant: ["tabular-nums"] }}>
        {value} {unit ? <Text style={{ fontSize: 13, fontWeight: "400", color: palette.muted }}>{unit}</Text> : null}
      </Text>
      <Text style={{ color: palette.muted, fontSize: 12 }}>{label}</Text>
    </View>
  );
}
