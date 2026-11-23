// A pilot install has its own SQLite and Keychain namespace.
module.exports = ({ config }) => {
  const origin = process.env.EXPO_PUBLIC_LIFTLOG_API_ORIGIN;
  if (!origin) {
    if (process.env.LIFTLOG_REQUIRE_PILOT_ORIGIN === "1") {
      throw new Error("Set EXPO_PUBLIC_LIFTLOG_API_ORIGIN before building Liftlog Pilot.");
    }
    return config;
  }
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || !url.hostname.includes(".")) {
    throw new Error("EXPO_PUBLIC_LIFTLOG_API_ORIGIN must be an exact HTTPS origin.");
  }
  return {
    ...config,
    name: "Liftlog Pilot",
    scheme: "liftlog-pilot",
    ios: { ...config.ios, bundleIdentifier: "com.darshan.liftlog.pilot" },
    android: { ...config.android, package: "com.darshan.liftlog.pilot" },
  };
};
