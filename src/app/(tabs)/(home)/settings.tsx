import Constants from "expo-constants";
import { router } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useWorkspace } from "../../../composition/database";
import { GroupLabel, NavBar, Notice, PageHeading, Screen, Tile, screenPadding } from "../../../ui/chrome";
import { Icon, type IconName } from "../../../ui/icons";
import { appearanceSummary, useAppearance, usePalette } from "../../../ui/theme";

export default function SettingsScreen() {
  const palette = usePalette();
  const appearance = useAppearance();
  const workspace = useWorkspace();
  const version = Constants.expoConfig?.version ?? "1.0.0";
  const accountDetail =
    workspace.access.mode === "signed-in"
      ? workspace.access.email
      : workspace.access.mode === "signed-out-hold"
        ? `${workspace.access.email} · sign in again`
        : "Local only";
  return (
    <Screen>
      <NavBar title="Settings" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding}>
        <PageHeading eyebrow="Your training. Your way." title="Make it yours." />
        <GroupLabel>Preferences</GroupLabel>
        <SettingRow icon="user" title="Account" detail={accountDetail} onPress={() => router.push("/account")} />
        <SettingRow icon="book" title="Training profile" detail="Goal, days, and equipment" onPress={() => router.push("/profile")} />
        <SettingRow icon="palette" title="Appearance" detail={appearanceSummary(appearance.paletteId, appearance.mode)} onPress={() => router.push("/appearance")} />
        <SettingRow icon="ruler" title="Weight units" detail="Pounds (lb)" onPress={() => router.push("/units")} />
        <GroupLabel>Your data</GroupLabel>
        <SettingRow icon="archive" title="Backup & restore" detail="Export or restore your workouts" onPress={() => router.push("/backup")} />
        <SettingRow icon="shield" title="Chat & analysis" detail="Permissions and connection" onPress={() => router.push("/connection")} />
        <Notice title="Your workouts stay with you" body="Workout logging is available offline. Chat and analysis need a connection." />
        <Text style={{ color: palette.muted, fontSize: 12, textAlign: "center", marginTop: 27 }}>Liftlog · Version {version}</Text>
      </ScrollView>
    </Screen>
  );
}

function SettingRow({ icon, title, detail, onPress }: { icon: IconName; title: string; detail: string; onPress: () => void }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingVertical: 17,
        borderBottomWidth: 1,
        borderBottomColor: palette.line,
        flexDirection: "row",
        alignItems: "center",
        gap: 13,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <Tile icon={icon} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: palette.text, fontSize: 15, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: palette.muted, fontSize: 13, marginTop: 5 }}>{detail}</Text>
      </View>
      <Icon name="forward" color={palette.muted} />
    </Pressable>
  );
}
