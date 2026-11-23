import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useDatabase, useWorkspace } from "../../../composition/database";
import { listHistory, startWorkout, type HistoryItem } from "../../../modules/workout";
import { createId } from "../../../shared/id";
import { localDateString } from "../../../shared/names";
import { BrandBar, Muted, PageHeading, Pill, Screen, SectionTitle, Tile, screenPadding } from "../../../ui/chrome";
import { PrimaryButton, TextField } from "../../../ui/fields";
import { countPhrase, currentWeek, formatLongDate, minutesBetween, relativeDay } from "../../../ui/format";
import { Icon } from "../../../ui/icons";
import { RestorationStatus } from "../../../ui/syncStatus";
import { usePalette } from "../../../ui/theme";

export default function HomeScreen() {
  const palette = usePalette();
  const db = useDatabase();
  const { dataVersion, sync } = useWorkspace();
  const [label, setLabel] = useState("Leg day");
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => { void dataVersion; setItems(listHistory(db)); }, [db, dataVersion]);
  useFocusEffect(useCallback(() => refresh(), [refresh]));

  const open = items.find((item) => item.endedAt === null);
  const last = items.find((item) => item.endedAt !== null);
  const today = localDateString();
  const week = currentWeek();
  const loggedDates = new Set(items.map((item) => item.date));
  const weekCount = items.filter((item) => week.some((day) => day.key === item.date)).length;

  function start() {
    setMessage(null);
    const result = startWorkout(db, { actionId: createId(), label, now: new Date().toISOString(), localDate: today });
    if (!result.ok) {
      setMessage(result.code === "LIVE_WORKOUT_EXISTS" ? "A workout is already open." : "Enter a workout name.");
      refresh();
      return;
    }
    router.push(`/workout/${result.value.workoutId}`);
  }

  return (
    <Screen>
      <BrandBar />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding}>
        <RestorationStatus />
        <PageHeading eyebrow={formatLongDate(new Date())} title={"A little stronger,\nat your own pace."} />
        <View style={{ backgroundColor: palette.soft, borderRadius: 24, padding: 20, marginBottom: 23 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <Muted>{open ? "Workout in progress" : "Your workout"}</Muted>
            <Pill label={open ? "Live" : "Your choice"} icon={open ? "live" : "dumbbell"} warm={Boolean(open)} />
          </View>
          {editing && !open ? (
            <View style={{ marginTop: 12 }}>
              <TextField label="Workout name" value={label} onChangeText={setLabel} placeholder="Leg day" />
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={open ? open.label : "Edit workout name"}
              disabled={Boolean(open)}
              onPress={() => setEditing(true)}
              style={{ marginTop: 9, marginBottom: 7 }}
            >
              <Text style={{ color: palette.text, fontSize: 29, fontWeight: "700", letterSpacing: -0.8 }}>{open?.label || label}</Text>
            </Pressable>
          )}
          <Muted>{open ? `${countPhrase(open.exerciseNames.length, "exercise")} · ${countPhrase(open.setCount, "set")} logged` : "Start fresh. Log as you go."}</Muted>
          <PrimaryButton
            label={open ? "Resume workout" : "Start workout"}
            icon={open ? "arrow-right" : "play"}
            onPress={() => (open ? router.push(`/workout/${open.workoutId}`) : start())}
          />
          {message ? <Text style={{ color: palette.warmInk, marginTop: 12 }}>{message}</Text> : null}
        </View>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <SectionTitle>This week</SectionTitle>
          <Muted>{sync && !sync.restored ? "Local sessions so far" : weekCount === 1 ? "1 workout logged" : `${weekCount} workouts logged`}</Muted>
        </View>
        <View accessibilityLabel={`Week of ${formatLongDate(new Date())}`} style={{ flexDirection: "row", marginTop: 16, marginBottom: 10 }}>
          {week.map((day) => {
            const logged = loggedDates.has(day.key);
            const isToday = day.key === today;
            return (
              <View key={day.key} style={{ flex: 1, alignItems: "center" }}>
                <Text style={{ color: palette.muted, fontSize: 11 }} numberOfLines={1}>
                  {day.name}
                </Text>
                <View
                  style={{
                    marginTop: 8,
                    padding: 3,
                    borderRadius: 20,
                    borderWidth: isToday ? 1 : 0,
                    borderColor: palette.primary,
                  }}
                >
                <View
                  style={{
                    height: 33,
                    width: 33,
                    borderRadius: 17,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: logged ? palette.primary : palette.surface,
                  }}
                >
                  <Text style={{ color: logged ? palette.onPrimary : palette.text, fontSize: 12, fontVariant: ["tabular-nums"] }}>{logged ? "✓" : day.number}</Text>
                </View>
                </View>
              </View>
            );
          })}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log with chat"
          onPress={() => router.push("/chat")}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 13,
            paddingVertical: 19,
            borderBottomWidth: 1,
            borderBottomColor: palette.line,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Tile icon="chat" />
          <View style={{ flex: 1 }}>
            <Text style={{ color: palette.text, fontSize: 15, fontWeight: "700" }}>Log with chat</Text>
            <Text style={{ color: palette.muted, fontSize: 12, marginTop: 2 }}>Write your exercise, weight, and reps</Text>
          </View>
          <Icon name="forward" color={palette.muted} />
        </Pressable>
        <View style={{ marginTop: 19 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <SectionTitle>Last session</SectionTitle>
            <Pressable accessibilityRole="button" onPress={() => router.push("/history")} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
              <Text style={{ color: palette.primary, fontSize: 13, fontWeight: "600" }}>View history</Text>
            </Pressable>
          </View>
          {last ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={last.label}
              onPress={() => router.push(`/history/${last.workoutId}`)}
              style={({ pressed }) => ({ paddingTop: 6, opacity: pressed ? 0.75 : 1, flexDirection: "row", alignItems: "center", gap: 12 })}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: palette.text, fontSize: 15, fontWeight: "600" }}>{last.label}</Text>
                <Muted>{sessionLine(last)}</Muted>
              </View>
              <Muted>{minutesLabel(last)}</Muted>
            </Pressable>
          ) : (
            <Text style={{ color: palette.muted, marginTop: 8 }}>{sync && !sync.restored ? "Account history is still restoring." : "No finished workout yet."}</Text>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

function sessionLine(item: HistoryItem) {
  return [relativeDay(item.date), countPhrase(item.exerciseNames.length, "exercise"), countPhrase(item.setCount, "set")].join(" · ");
}

function minutesLabel(item: HistoryItem) {
  const minutes = minutesBetween(item.startedAt, item.endedAt);
  return minutes ? `${minutes} min` : "";
}
