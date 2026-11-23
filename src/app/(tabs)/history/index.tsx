import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useDatabase, useWorkspace } from "../../../composition/database";
import { listHistory, type HistoryItem } from "../../../modules/workout";
import { BrandBar, EmptyState, PageHeading, Pill, Screen, SectionTitle, screenPadding } from "../../../ui/chrome";
import { PrimaryButton } from "../../../ui/fields";
import { countPhrase, formatMonthKey, formatWeekdayDate, minutesBetween } from "../../../ui/format";
import { Icon } from "../../../ui/icons";
import { RestorationStatus } from "../../../ui/syncStatus";
import { usePalette } from "../../../ui/theme";

export default function HistoryScreen() {
  const palette = usePalette();
  const db = useDatabase();
  const { dataVersion, sync } = useWorkspace();
  const [items, setItems] = useState<HistoryItem[]>([]);
  useFocusEffect(useCallback(() => { void dataVersion; setItems(listHistory(db)); }, [db, dataVersion]));
  const groups = groupByMonth(items);

  return (
    <Screen>
      <BrandBar />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={items.length === 0 ? { flexGrow: 1, justifyContent: "center" } : screenPadding}>
        <RestorationStatus />
        {items.length === 0 && sync && !sync.restored ? null : items.length === 0 ? (
          <EmptyState
            icon="book"
            title={"Your story\nstarts here."}
            body="Your finished workouts will appear here. Start a session and make it your own."
            action={<PrimaryButton label="Start your first workout" onPress={() => router.push("/")} />}
          />
        ) : (
          <>
            <PageHeading eyebrow="Every session counts." title="Your history" />
            {groups.map((group) => (
              <View key={group.key}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                  <SectionTitle>{formatMonthKey(group.key)}</SectionTitle>
                  <Text style={{ color: palette.muted, fontSize: 13 }}>{countPhrase(group.items.length, "workout")}</Text>
                </View>
                {group.items.map((item) => (
                  <HistoryCard key={item.workoutId} item={item} />
                ))}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function HistoryCard({ item }: { item: HistoryItem }) {
  const palette = usePalette();
  const minutes = minutesBetween(item.startedAt, item.endedAt);
  const when = formatWeekdayDate(item.date);
  const destination = item.endedAt ? `/history/${item.workoutId}` : `/workout/${item.workoutId}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      onPress={() => router.push(destination)}
      style={({ pressed }) => ({ paddingVertical: 17, borderBottomWidth: 1, borderBottomColor: palette.line, opacity: pressed ? 0.75 : 1 })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: "600", flex: 1 }}>{item.label}</Text>
        <Icon name="forward" color={palette.muted} />
      </View>
      <Text style={{ color: palette.muted, fontSize: 13, marginBottom: 5 }}>
        {minutes ? `${when} · ${minutes} min` : when}
        {item.endedAt ? "" : " · In progress"}
      </Text>
      <Text style={{ color: palette.muted, fontSize: 12 }}>{exerciseSummary(item.exerciseNames)}</Text>
      <View style={{ marginTop: 10, flexDirection: "row", gap: 8 }}>
        <Pill label={countPhrase(item.setCount, "set")} />
        {item.endedAt ? null : <Pill label="In progress" warm />}
      </View>
    </Pressable>
  );
}

function groupByMonth(items: HistoryItem[]) {
  const groups: { key: string; items: HistoryItem[] }[] = [];
  for (const item of items) {
    const key = item.date.slice(0, 7);
    const group = groups.find((candidate) => candidate.key === key);
    if (group) group.items.push(item);
    else groups.push({ key, items: [item] });
  }
  return groups;
}

function exerciseSummary(names: string[]): string {
  if (names.length === 0) return "No exercises yet";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} + ${names.length - 2} more`;
}
