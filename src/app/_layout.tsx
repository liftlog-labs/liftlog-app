import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DatabaseProvider } from "../composition/database";
import { usePrefersReducedMotion } from "../ui/motion";
import { usePalette } from "../ui/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <DatabaseProvider>
        <RootNavigator />
      </DatabaseProvider>
    </SafeAreaProvider>
  );
}

function RootNavigator() {
  const palette = usePalette();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <>
      <StatusBar style={palette.dark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: reducedMotion ? "none" : "slide_from_right",
          contentStyle: { backgroundColor: palette.background },
        }}
      >
        <Stack.Screen name="(tabs)" />
      </Stack>
    </>
  );
}
