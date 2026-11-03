import { test } from "bun:test";
import { nativeProbe } from "../app/nativeProbe.testing.ts";

test("Android requests notification permission after linking and resumes live updates after Settings", () => {
  nativeProbe(`
rn.Platform.Version = 33;
let resume;
let enabled = false;
let requests = 0;
let cleanups = [];
rn.AppState = { addEventListener: (_, listener) => { resume = listener; return { remove() {} }; } };
rn.Linking = { sendIntent: async (action, extras) => {
  assert.equal(action, "android.settings.APP_NOTIFICATION_SETTINGS");
  assert.equal(extras[0].value, "dev.lux.polaris.mobile");
}, openSettings: async () => {} };
mock.module("expo-notifications", () => ({ requestPermissionsAsync: async () => { requests++; enabled = true; } }));
mock.module("../modules/polaris-live-activity/index.ts", () => ({ PolarisLiveActivity: { enabled: () => enabled } }));
mock.module("react", () => ({
  useState: (initial) => [states[0] ?? initial, (value) => { states[0] = value; }],
  useEffect: (effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
}));
const { useAndroidLiveUpdatePermission, openAndroidNotificationSettings } = await import("./notifications/android.ts");
assert.equal(useAndroidLiveUpdatePermission(false), false);
assert.equal(requests, 0);
assert.equal(useAndroidLiveUpdatePermission(true), false);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(requests, 1);
assert.equal(states[0], true);
enabled = false;
resume("active");
assert.equal(states[0], false);
enabled = true;
resume("active");
assert.equal(states[0], true);
await openAndroidNotificationSettings();
for (const cleanup of cleanups) cleanup();
`);
});
