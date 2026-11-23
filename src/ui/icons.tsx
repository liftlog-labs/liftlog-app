import Feather from "@expo/vector-icons/Feather";
import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import type { ComponentProps } from "react";

type FeatherName = ComponentProps<typeof Feather>["name"];
type CommunityName = ComponentProps<typeof MaterialCommunityIcons>["name"];

export type IconName =
  | "home"
  | "chat"
  | "history"
  | "progress"
  | "settings"
  | "back"
  | "forward"
  | "down"
  | "play"
  | "arrow-right"
  | "live"
  | "dumbbell"
  | "check"
  | "plus"
  | "search"
  | "saved"
  | "archive"
  | "shield"
  | "download"
  | "upload"
  | "more"
  | "send"
  | "book"
  | "palette"
  | "ruler"
  | "sprout"
  | "user";

const feather: Partial<Record<IconName, FeatherName>> = {
  home: "home",
  chat: "message-circle",
  history: "clock",
  progress: "bar-chart-2",
  settings: "sliders",
  back: "chevron-left",
  forward: "chevron-right",
  down: "chevron-down",
  play: "play",
  "arrow-right": "arrow-right",
  live: "activity",
  check: "check",
  plus: "plus",
  search: "search",
  saved: "check-circle",
  archive: "archive",
  download: "download",
  upload: "upload",
  more: "more-horizontal",
  send: "arrow-up",
  book: "book-open",
  user: "user",
};

const community: Partial<Record<IconName, CommunityName>> = {
  dumbbell: "dumbbell",
  shield: "shield-check-outline",
  palette: "palette-outline",
  ruler: "ruler",
  sprout: "sprout",
};

export function Icon({ name, color, size = 21 }: { name: IconName; color: string; size?: number }) {
  const communityName = community[name];
  if (communityName) {
    return <MaterialCommunityIcons name={communityName} size={size} color={color} importantForAccessibility="no" accessibilityElementsHidden />;
  }
  return <Feather name={feather[name] ?? "circle"} size={size} color={color} importantForAccessibility="no" accessibilityElementsHidden />;
}
