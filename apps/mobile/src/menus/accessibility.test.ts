import { test } from "bun:test";
import { nativeProbe } from "../app/nativeProbe.testing.ts";

test("Android menu actions and rename controls are labelled buttons with their disabled state", () => {
  nativeProbe(`
let longPress;
mock.module("./motion/haptics.ts", () => ({ haptics: { send: () => {} } }));
mock.module("./menus/MenuSymbol.tsx", () => ({ MenuSymbol: "MenuSymbol" }));
mock.module("react-native-gesture-handler", () => ({
  GestureDetector: "GestureDetector",
  Gesture: { LongPress: () => ({ runOnJS() { return this; }, onStart(callback) { longPress = callback; return this; } }) },
}));
mock.module("./sheet/index.tsx", () => ({ InstrumentSheet: "InstrumentSheet", SheetHeader: "SheetHeader" }));
const { AndroidMenu } = await import("./menus/AndroidMenu.tsx");
const names = ["Open agent session", "Open review", "Pin to top", "Rename…", "Archive", "Copy agent session ID"];
const menu = [names.map((title, id) => ({
  id: String(id), title, disabled: id === 1, subtitle: id === 1 ? "Host offline" : null,
  action: id === 3 ? { kind: "rename", hostId: "host", sessionId: "session", title: "Before" } : { kind: "copy", text: "session" },
}))];
const render = () => { cursor = 0; return AndroidMenu({ menu, title: "Actions", onAction: () => {}, children: "Home row" }); };
render(); longPress();
let tree = render();
const buttons = nodes(tree).filter((node) => node.type === "Pressable");
assert.deepEqual(buttons.map((node) => node.props.accessibilityLabel), names);
assert.equal(buttons.every((node) => node.props.accessibilityRole === "button"), true);
assert.deepEqual(buttons.map((node) => node.props.accessibilityState.disabled), [false, true, false, false, false, false]);
assert.equal(buttons[1].props.accessibilityHint, "Host offline");
buttons[3].props.onPress();
tree = render();
const input = nodes(tree).find((node) => node.type === "TextInput");
assert.equal(input.props.accessibilityLabel, "Agent session title");
input.props.onChangeText(" ");
tree = render();
const save = nodes(tree).find((node) => node.type === "Pressable");
assert.equal(save.props.accessibilityLabel, "Save");
assert.equal(save.props.accessibilityRole, "button");
assert.equal(save.props.accessibilityState.disabled, true);
`);
});
