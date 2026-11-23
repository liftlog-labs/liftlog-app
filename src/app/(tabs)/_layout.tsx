import { Tabs } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Icon, type IconName } from "../../ui/icons";
import { useKeyboardOverlap } from "../../ui/keyboard";
import { usePalette } from "../../ui/theme";

const TAB_ICONS: Record<string, IconName> = {
  "(home)": "home",
  chat: "chat",
  history: "history",
  progress: "progress",
};

export const unstable_settings = { anchor: "(home)" };

export default function TabLayout() {
  const palette = usePalette();
  return (
    <Tabs
      detachInactiveScreens={false}
      tabBar={(props) => <AppTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: false,
        tabBarLabelPosition: "below-icon",
        sceneStyle: { backgroundColor: palette.background },
      }}
    >
      <Tabs.Screen name="(home)" options={{ title: "Home", tabBarAccessibilityLabel: "Home" }} />
      <Tabs.Screen name="chat" options={{ title: "Chat", tabBarAccessibilityLabel: "Chat" }} />
      <Tabs.Screen name="history" options={{ title: "History", tabBarAccessibilityLabel: "History" }} />
      <Tabs.Screen name="progress" options={{ title: "Progress", tabBarAccessibilityLabel: "Progress" }} />
    </Tabs>
  );
}

function AppTabBar({
  state,
  descriptors,
  emitter,
  navigateToTab,
  insets,
}: {
  state: { index: number; routes: { key: string; name: string }[] };
  descriptors: Record<string, { options: { title?: string; tabBarAccessibilityLabel?: string } }>;
  emitter: { emit: (event: { type: "tabPress"; target: string; canPreventDefault: true }) => { defaultPrevented: boolean } };
  navigateToTab: (routeKey: string) => void;
  insets: { bottom: number; left: number; right: number };
}) {
  const palette = usePalette();
  const overlap = useKeyboardOverlap();
  const bottom = overlap > 0 ? overlap : Math.max(insets.bottom, 8);
  return (
    <View
      style={{
        backgroundColor: palette.surface,
        borderTopWidth: 1,
        borderTopColor: palette.line,
        paddingBottom: bottom,
        paddingLeft: Math.max(insets.left, 0),
        paddingRight: Math.max(insets.right, 0),
      }}
    >
      <View accessibilityRole="tablist" style={{ flexDirection: "row", paddingTop: 9, paddingBottom: 6, paddingHorizontal: 8 }}>
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const options = descriptors[route.key]?.options;
          const label = options?.title ?? route.name;
          const icon = TAB_ICONS[route.name] ?? "home";
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={options?.tabBarAccessibilityLabel ?? label}
              onPress={() => {
                const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) navigateToTab(route.key);
              }}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 51,
                alignItems: "center",
                justifyContent: "center",
                gap: 4,
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <View
                style={{
                  width: 48,
                  height: 28,
                  borderRadius: 10,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: focused ? palette.soft : "transparent",
                }}
              >
                <Icon name={icon} color={focused ? palette.primary : palette.muted} size={21} />
              </View>
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
                style={{ color: focused ? palette.primary : palette.muted, fontSize: 11, fontWeight: focused ? "700" : "500" }}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
