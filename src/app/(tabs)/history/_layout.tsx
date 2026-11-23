import { Stack } from "expo-router";
import { usePrefersReducedMotion } from "../../../ui/motion";
import { usePalette } from "../../../ui/theme";

export const unstable_settings = { anchor: "index" };

export default function HistoryLayout() {
  const palette = usePalette();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: reducedMotion ? "none" : "slide_from_right",
        contentStyle: { backgroundColor: palette.background },
      }}
    />
  );
}
