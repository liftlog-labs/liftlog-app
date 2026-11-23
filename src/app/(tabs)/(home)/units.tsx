import { ScrollView, Text } from "react-native";
import { NavBar, PageHeading, Screen, screenPadding } from "../../../ui/chrome";
import { usePalette } from "../../../ui/theme";

export default function UnitsScreen() {
  const palette = usePalette();
  return (
    <Screen>
      <NavBar title="Weight units" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding}>
        <PageHeading eyebrow="Weight units" title="Pounds." />
        <Text style={{ color: palette.text, fontSize: 16, lineHeight: 23 }}>
          Weights are stored in pounds (lb). Liftlog does not convert them to kilograms.
        </Text>
        <Text style={{ color: palette.muted, fontSize: 13, marginTop: 12 }}>Bars, plates, and dumbbells all use the same pound values already saved on this phone.</Text>
      </ScrollView>
    </Screen>
  );
}
