import { useEffect, useState } from "react";
import { Dimensions, Keyboard, Platform, type KeyboardEvent } from "react-native";

export function useKeyboardOverlap(): number {
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    const showEvents = Platform.OS === "ios" ? (["keyboardWillChangeFrame", "keyboardDidShow"] as const) : (["keyboardDidShow"] as const);
    const hideEvents = Platform.OS === "ios" ? (["keyboardWillHide", "keyboardDidHide"] as const) : (["keyboardDidHide"] as const);
    const subscriptions = [
      ...showEvents.map((event) => Keyboard.addListener(event, (keyboard) => setOverlap(overlapHeight(keyboard)))),
      ...hideEvents.map((event) => Keyboard.addListener(event, () => setOverlap(0))),
    ];
    return () => subscriptions.forEach((subscription) => subscription.remove());
  }, []);
  return overlap;
}

function overlapHeight(event: KeyboardEvent): number {
  const windowHeight = Dimensions.get("window").height;
  const { screenY, height } = event.endCoordinates;
  if (screenY > 0 && screenY < windowHeight) return Math.max(0, Math.round(windowHeight - screenY));
  return Math.max(0, Math.round(height));
}
