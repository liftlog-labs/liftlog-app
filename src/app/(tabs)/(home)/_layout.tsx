import { Stack } from "expo-router";
import { RestoreDraftProvider } from "../../../ui/restoreDraft";
import { usePrefersReducedMotion } from "../../../ui/motion";
import { usePalette } from "../../../ui/theme";

export const unstable_settings = { anchor: "index" };

export default function HomeLayout() {
  const palette = usePalette();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <RestoreDraftProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: reducedMotion ? "none" : "slide_from_right",
          contentStyle: { backgroundColor: palette.background },
        }}
      />
    </RestoreDraftProvider>
  );
}
