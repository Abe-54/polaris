import { test } from "bun:test";
import { nativeProbe } from "../app/nativeProbe.testing.ts";

test("Android long press preserves grouped actions, receipt, disabled reasons and dismissal", () => {
  nativeProbe(`
let longPress;
let taps = 0;
const actions = [];
mock.module("./motion/haptics.ts", () => ({ haptics: { send: () => taps++ } }));
mock.module("./menus/MenuSymbol.tsx", () => ({ MenuSymbol: "MenuSymbol" }));
mock.module("react-native-gesture-handler", () => ({
  GestureDetector: "GestureDetector",
  Gesture: { LongPress: () => ({ runOnJS() { return this; }, onStart(callback) { longPress = callback; return this; } }) },
}));
mock.module("./sheet/index.tsx", () => ({ InstrumentSheet: "InstrumentSheet", SheetHeader: "SheetHeader" }));
const { AndroidMenu } = await import("./menus/AndroidMenu.tsx");
const copy = { id: "copy", title: "Copy", subtitle: null, disabled: false, symbol: "doc.on.doc", action: { kind: "copy", text: "Turn output" } };
const fork = { id: "fork", title: "Fork from here", subtitle: "From the desktop app for now", disabled: true, symbol: "arrow.triangle.branch", action: { kind: "fork" } };
let menu = [[], [copy], [], [fork]];
const render = () => { cursor = 0; return AndroidMenu({ menu, title: "Turn 2\\nCompleted", onAction: (action) => actions.push(action), children: "Turn source" }); };
const sheet = (tree) => nodes(tree).find((node) => node.type === "InstrumentSheet");
let tree = render();
assert.equal(sheet(tree), undefined);
const source = nodes(tree).find((node) => node.props?.accessibilityActions);
source.props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } });
assert.equal(taps, 0);
longPress();
tree = render();
assert.equal(taps, 1);
assert.equal(nodes(tree).find((node) => node.type === "SheetHeader").props.title, "Turn 2\\nCompleted");
assert.equal(exposed(tree).some((node) => node.props?.children === "Turn source"), false);
assert.equal(sheet(tree).props.children[1].length, 2);
assert.deepEqual(nodes(tree).filter((node) => node.type === "MenuSymbol").map((node) => node.props.symbol), ["doc.on.doc", "arrow.triangle.branch"]);
let buttons = nodes(tree).filter((node) => node.type === "Pressable");
assert.equal(buttons[1].props.accessibilityHint, fork.subtitle);
buttons[1].props.onPress();
assert.deepEqual(actions, []);
tree = render();
assert.ok(sheet(tree));
buttons[0].props.onPress();
assert.deepEqual(actions, [copy.action]);
tree = render();
assert.equal(sheet(tree), undefined);
assert.equal(exposed(tree).some((node) => node.props?.children === "Turn source"), true);
nodes(tree).find((node) => node.props?.accessibilityActions).props.onAccessibilityAction({ nativeEvent: { actionName: "longpress" } });
tree = render();
assert.equal(taps, 2);
sheet(tree).props.onClose();
tree = render();
assert.equal(sheet(tree), undefined);
menu = [[], []];
assert.equal(render(), "Turn source");
longPress();
assert.equal(taps, 2);
`);
});

test("Android rename trims the title and dispatches once, while unchanged titles do nothing", () => {
  nativeProbe(`
let longPress;
const actions = [];
mock.module("./motion/haptics.ts", () => ({ haptics: { send: () => {} } }));
mock.module("./menus/MenuSymbol.tsx", () => ({ MenuSymbol: "MenuSymbol" }));
mock.module("react-native-gesture-handler", () => ({
  GestureDetector: "GestureDetector",
  Gesture: { LongPress: () => ({ runOnJS() { return this; }, onStart(callback) { longPress = callback; return this; } }) },
}));
mock.module("./sheet/index.tsx", () => ({ InstrumentSheet: "InstrumentSheet", SheetHeader: "SheetHeader" }));
const { AndroidMenu } = await import("./menus/AndroidMenu.tsx");
const menu = [[{ id: "rename", title: "Rename…", subtitle: null, symbol: null, disabled: false, action: { kind: "rename", hostId: "host", sessionId: "session", title: "Before" } }]];
const render = () => { cursor = 0; return AndroidMenu({ menu, title: "", onAction: (action) => actions.push(action), children: "Source" }); };
const button = (tree) => nodes(tree).find((node) => node.type === "Pressable");
render(); longPress();
button(render()).props.onPress();
button(render()).props.onPress();
assert.deepEqual(actions, []);
render(); longPress();
button(render()).props.onPress();
nodes(render()).find((node) => node.type === "TextInput").props.onChangeText("  After  ");
button(render()).props.onPress();
assert.equal(actions.length, 1);
assert.equal(actions[0].kind, "send");
assert.equal(actions[0].hostId, "host");
assert.equal(actions[0].command._tag, "RenameSession");
assert.equal(actions[0].command.title, "After");
assert.equal(actions[0].command.sessionId, "session");
assert.equal(nodes(render()).some((node) => node.type === "InstrumentSheet"), false);
`);
});

test("Android symbols render the supported menu icons and omit unknown symbols", () => {
  nativeProbe(`
mock.module("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
const { MenuSymbol } = await import("./menus/MenuSymbol.tsx");
for (const symbol of ["doc.on.doc", "arrow.triangle.branch"]) {
  const tree = MenuSymbol({ symbol, color: "white" });
  assert.equal(tree.props.importantForAccessibility, "no-hide-descendants");
  assert.equal(tree.props.accessible, false);
}
assert.equal(MenuSymbol({ symbol: null, color: "white" }), null);
assert.equal(MenuSymbol({ symbol: "unknown", color: "white" }), null);
`);
});
