import { ScrollView, Text, View } from "react-native";
import { Muted, NavBar, PageHeading, Screen, SectionTitle, screenPadding } from "../../../ui/chrome";
import { ChoiceCard, FilterChip } from "../../../ui/fields";
import { paletteChoices, useAppearance, usePalette, type AppearanceMode } from "../../../ui/theme";

const MODES: { id: AppearanceMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

export default function AppearanceScreen() {
  const palette = usePalette();
  const appearance = useAppearance();
  return (
    <Screen>
      <NavBar title="Appearance" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding}>
        <PageHeading eyebrow="Make Liftlog feel like you." title="Appearance" />
        <SectionTitle>Color palette</SectionTitle>
        <Muted>Applied throughout the app.</Muted>
        <View accessibilityRole="radiogroup" style={{ marginTop: 4 }}>
          {paletteChoices.map((choice) => (
            <ChoiceCard
              key={choice.id}
              title={choice.name}
              detail={choice.detail}
              selected={appearance.paletteId === choice.id}
              onPress={() => appearance.setPaletteId(choice.id)}
              leading={
                <View style={{ flexDirection: "row", width: 48, height: 25 }}>
                  {choice.swatches.map((color, index) => (
                    <View
                      key={`${choice.id}-${color}`}
                      style={{
                        flex: 1,
                        backgroundColor: color,
                        borderTopLeftRadius: index === 0 ? 7 : 0,
                        borderBottomLeftRadius: index === 0 ? 7 : 0,
                        borderTopRightRadius: index === choice.swatches.length - 1 ? 7 : 0,
                        borderBottomRightRadius: index === choice.swatches.length - 1 ? 7 : 0,
                      }}
                    />
                  ))}
                </View>
              }
            />
          ))}
        </View>
        <View style={{ marginTop: 26 }}>
          <SectionTitle>Display mode</SectionTitle>
        </View>
        <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
          {MODES.map((mode) => (
            <FilterChip key={mode.id} label={mode.label} selected={appearance.mode === mode.id} onPress={() => appearance.setMode(mode.id)} />
          ))}
        </View>
        <Text style={{ color: palette.muted, fontSize: 12, marginTop: 12 }}>
          System follows your phone’s light or dark setting. Your palette choice is saved automatically.
        </Text>
      </ScrollView>
    </Screen>
  );
}
