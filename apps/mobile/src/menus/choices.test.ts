import { expect, test } from "bun:test";
import { nativeProbe } from "../app/nativeProbe.testing.ts";
import { currentChoice, finishChoice, showChoice, subscribeChoice } from "./choiceStore.ts";

test("imperative choices queue before mount, preserve indexes, and settle only once", () => {
  const outcomes: string[] = [];

  const first = {
    title: undefined,
    message: undefined,
    options: ["Photo library", "Files"],
    onChoose: (index: number) => outcomes.push(`attach:${index}`),
    onCancel: () => outcomes.push("cancel attach"),
  };

  const second = { ...first, title: "Motion", onCancel: () => outcomes.push("cancel motion") };
  let notifications = 0;
  const unsubscribe = subscribeChoice(() => notifications++);
  showChoice(first);
  showChoice(second);
  expect(currentChoice()).toBe(first);
  finishChoice(first, -1);
  finishChoice(first, 2);
  expect(currentChoice()).toBe(first);
  finishChoice(first, 1);
  finishChoice(first, null);
  expect(currentChoice()).toBe(second);
  finishChoice(second, null);
  finishChoice(second, 0);
  expect(currentChoice()).toBeNull();
  expect(outcomes).toEqual(["attach:1", "cancel motion"]);
  expect(notifications).toBe(4);
  unsubscribe();
});

test("Android choices use themed sheet options without an empty header, and Cancel or dismissal cancels", () => {
  nativeProbe(`
rn.ActionSheetIOS = { showActionSheetWithOptions: () => { throw new Error("Android used the iOS sheet"); } };
mock.module("react", () => ({ useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useState: (initial) => [initial, () => {}] }));
mock.module("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 24, left: 0, right: 0 }) }));
mock.module("./sheet/index.tsx", () => ({ InstrumentSheet: "InstrumentSheet", SheetHeader: "SheetHeader" }));
mock.module("./theme/index.ts", () => ({ useTheme: () => ({ colours: { textStrong: "#fff", textSubtle: "#aaa", hairline: "#333" } }) }));
const { choose } = await import("./menus/choices.ts");
const { ChoiceSheetHost } = await import("./menus/ChoiceSheetHost.tsx");
const outcomes = [];
const ask = () => choose(undefined, ["Photo library", "Files"], (index) => outcomes.push(index), undefined, () => outcomes.push("cancel"));
assert.equal(ChoiceSheetHost(), null);
ask();
let tree = ChoiceSheetHost();
assert.equal(tree.type, "InstrumentSheet");
assert.equal(nodes(tree).some((node) => node.type === "SheetHeader"), false);
const buttons = nodes(tree).filter((node) => node.type === "Pressable");
assert.deepEqual(buttons.map((node) => node.props.accessibilityLabel), ["Photo library", "Files", "Cancel"]);
assert.equal(buttons.every((node) => node.props.accessibilityRole === "button"), true);
assert.equal(nodes(buttons[0]).find((node) => node.type === "Text").props.style[1].color, "#fff");
buttons[1].props.onPress();
tree.props.onClose();
assert.deepEqual(outcomes, [1]);
assert.equal(ChoiceSheetHost(), null);
ask();
tree = ChoiceSheetHost();
nodes(tree).filter((node) => node.type === "Pressable").at(-1).props.onPress();
tree.props.onClose();
assert.deepEqual(outcomes, [1, "cancel"]);
ask();
ChoiceSheetHost().props.onClose();
assert.deepEqual(outcomes, [1, "cancel", "cancel"]);
choose("Open this link?", ["Open in browser"], () => outcomes.push("opened"), "example.com", () => outcomes.push("closed"));
tree = ChoiceSheetHost();
assert.equal(nodes(tree).find((node) => node.type === "SheetHeader").props.title, "Open this link?");
assert.equal(nodes(tree).some((node) => node.type === "Text" && node.props.children === "example.com"), true);
tree.props.onClose();
assert.equal(ChoiceSheetHost(), null);
`);
});

test("iOS choices retain the native action sheet and Cancel index", () => {
  nativeProbe(
    `
let config;
let select;
mock.module("react-native", () => ({ Platform: { OS: "ios" }, ActionSheetIOS: { showActionSheetWithOptions: (options, callback) => { config = options; select = callback; } } }));
const { choose } = await import("./menus/choices.ts");
const { currentChoice } = await import("./menus/choiceStore.ts");
const outcomes = [];
choose("Motion", ["Follow system", "Reduce", "Full"], (index) => outcomes.push(index), "Details", () => outcomes.push("cancel"));
assert.deepEqual(config, { title: "Motion", message: "Details", options: ["Follow system", "Reduce", "Full", "Cancel"], cancelButtonIndex: 3 });
select(1);
select(3);
assert.deepEqual(outcomes, [1, "cancel"]);
assert.equal(currentChoice(), null);
`,
    "ios"
  );
});
