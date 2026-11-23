// Web and Node test transport. Native explicitly uses Expo's redirect-aware implementation.
export const appFetch: typeof fetch = (...args) => fetch(...args);
