import { test } from "bun:test";
import { nativeProbe } from "./nativeProbe.testing.ts";

test("covered tabs and screens are hidden from Android accessibility and restored on Back", () => {
  nativeProbe(`
class Value {
  interpolate() { return 0; }
}
Object.assign(rn, {
  Animated: { View: "AnimatedView", Value },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  useWindowDimensions: () => ({ width: 400 }),
});
const { SwipeBack } = await import("./app/SwipeBack.tsx");
const { initialNavigation, layersOf, pushed, wentBack } = await import("./app/navigationState.ts");
const render = (state) => SwipeBack({
  layers: layersOf(state), onBack: () => {}, render: (route) => jsx("Screen", { name: route.screen }),
});
const screens = (state) => exposed(render(state)).filter((node) => node.type === "Screen").map((node) => node.props.name);
assert.deepEqual(screens(initialNavigation), ["tabs"]);
const thread = pushed(initialNavigation, { screen: "thread", hostId: "host", sessionId: "session" });
assert.deepEqual(screens(thread), ["thread"]);
const next = pushed(thread, { screen: "newSession", workspaceId: null });
assert.deepEqual(screens(next), ["newSession"]);
assert.deepEqual(screens(wentBack(next)), ["thread"]);
assert.deepEqual(screens(wentBack(thread)), ["tabs"]);
`);
});
