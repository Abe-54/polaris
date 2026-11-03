import { test } from "bun:test";
import { nativeProbe } from "../app/nativeProbe.testing.ts";

test("Android decisions and detents use semantic feedback", () => {
  nativeProbe(`
const calls = [];
mock.module("expo-haptics", () => ({
  AndroidHaptics: { Confirm: "confirm", Reject: "reject", Context_Click: "context", Segment_Tick: "tick" },
  performAndroidHapticsAsync: async kind => { calls.push(kind); },
  ImpactFeedbackStyle: {}, NotificationFeedbackType: {},
  impactAsync: async () => { throw new Error("legacy Android impact"); },
  notificationAsync: async () => { throw new Error("legacy Android notification"); },
}));
const { haptics } = await import("./motion/haptics.ts");
haptics.send();
haptics.stop();
haptics.approve();
haptics.warning();
haptics.detent();
assert.deepEqual(calls, ["context", "reject", "confirm", "reject", "tick"]);
`);
});
