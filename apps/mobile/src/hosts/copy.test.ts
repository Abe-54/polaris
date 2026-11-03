import { test } from "bun:test";
import { nativeProbe } from "../app/nativeProbe.testing.ts";

test.each(["android", "ios"])(
  "%s host unlink controls and confirmation use the device's words",
  (platform) => {
    nativeProbe(
      `
let alert;
Object.assign(rn, { Switch: "Switch", Alert: { alert: (...args) => { alert = args; } } });
mock.module("../modules/polaris-push/index.ts", () => ({ PolarisPush: null }));
mock.module("./push/constellations.ts", () => ({ constellationNotifications: { set: () => {} }, useConstellationNotifications: () => true }));
mock.module("./sheet/index.tsx", () => ({ InstrumentSheet: "InstrumentSheet", SheetHeader: "SheetHeader", Well: "Well" }));
mock.module("./hosts/StateDot.tsx", () => ({ StateDot: "StateDot", stateLineColour: () => "white" }));
mock.module("./push/hostNotifications.ts", () => ({ hostNotifications: { set: () => {} }, useHostNotifications: () => true }));
const { HostSheet } = await import("./hosts/HostSheet.tsx");
let unlinked = 0;
const tree = HostSheet({
  details: { name: "Linux VM", state: "connected", status: "Connected", failure: null, roundTrip: "10 ms", route: "via Polaris Relay", sessionsLabel: "Agent sessions", sessions: "2" },
  onClose: () => {}, onUnlink: () => { unlinked++; },
});
const text = (tree) => Array.isArray(tree) ? tree.map(text).join("")
  : tree && typeof tree === "object" ? text(tree.props.children) : String(tree ?? "");
const button = nodes(tree).find((node) => node.type === "Pressable");
const phone = os === "android" ? "phone" : "iPhone";
const computer = os === "android" ? "computer" : "Mac";
assert.equal(text(button), "Unlink this " + phone + " from Linux VM…");
button.props.onPress();
assert.equal(alert[0], "Unlink this " + phone + " from Linux VM?");
assert.equal(alert[1], "Linux VM forgets this " + phone + ", and its agent sessions leave this list. Your other hosts stay linked; link again from your " + computer + ".");
assert.equal(unlinked, 0);
assert.deepEqual(alert[2].map(({ text, style }) => ({ text, style })), [
  { text: "Cancel", style: "cancel" }, { text: "Unlink", style: "destructive" },
]);
alert[2][0].onPress?.();
assert.equal(unlinked, 0);
alert[2][1].onPress();
assert.equal(unlinked, 1);
`,
      platform
    );
  }
);
