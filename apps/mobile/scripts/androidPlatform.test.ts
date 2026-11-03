import { expect, test } from "bun:test";

const boundary = `
import assert from "node:assert/strict";
import { mock } from "bun:test";
const os = process.env.POLARIS_TEST_OS ?? "android";
let alert, sheet;
const opened = [];
const rn = {
  Platform: { OS: os },
  Settings: { get: () => null },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  Alert: { alert: (...args) => { alert = args; } },
  ActionSheetIOS: { showActionSheetWithOptions: (...args) => {
    assert.equal(os, "ios", "Android called ActionSheetIOS"); sheet = args;
  } },
  Linking: { openURL: async (url) => { opened.push(url); } },
};
mock.module("react-native", () => rn);
mock.module("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
mock.module("expo-haptics", () => ({
  AndroidHaptics: { Context_Click: "context-click", Confirm: "confirm", Reject: "reject", Segment_Tick: "tick" },
  ImpactFeedbackStyle: { Light: "light", Rigid: "rigid" },
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
  performAndroidHapticsAsync: async () => {},
  impactAsync: async () => {},
  notificationAsync: async () => {},
}));
mock.module("expo-notifications", () => ({ requestPermissionsAsync: async () => ({ granted: false }) }));
let baselineLoads = 0;
if (process.env.POLARIS_TEST_HEAD === "1") {
  const { plugin } = await import("bun");
  const { relative, resolve } = await import("node:path");
  const root = resolve(process.cwd(), "../..");
  plugin({ name: "Android regression baseline", setup: (build) => {
    build.onLoad({ filter: /(?:polaris-push[\\\\/]index|composer[\\\\/]pick|visualization[\\\\/]confirmLink|hosts[\\\\/]HostSheet|app[\\\\/]navigation|menus[\\\\/](?:LongPressMenu|choices|choiceStore|AndroidMenu|MenuSymbol))\\.tsx?$/ }, ({ path }) => {
      const file = relative(root, path).replaceAll("\\\\", "/");
      const head = Bun.spawnSync(["git", "show", "HEAD:" + file], { cwd: root });
      assert.equal(head.exitCode, 0, head.stderr.toString());
      baselineLoads++;
      return { contents: head.stdout.toString(), loader: path.endsWith("tsx") ? "tsx" : "ts" };
    });
  } });
}
const { currentChoice, finishChoice } = await import("./src/menus/choiceStore.ts");
if (process.env.POLARIS_TEST_HEAD === "1") assert.ok(baselineLoads > 0, "HEAD plugin did not load the choice store");
const offered = () => os === "ios" ? sheet[0].options.slice(0, -1) : currentChoice()?.options;
const select = (index) => {
  if (os === "ios") sheet[1](index);
  else {
    assert.ok(currentChoice(), "Expected an Android choice sheet");
    finishChoice(currentChoice(), index);
    assert.equal(currentChoice(), null);
    assert.equal(alert, undefined, "Android choices should use the themed sheet");
  }
};
const cancel = () => os === "ios" ? sheet[1](sheet[0].cancelButtonIndex) : select(null);

`;

const probe = (body: string, os = "android") => {
  const result = Bun.spawnSync([process.execPath, "--eval", boundary + body], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, POLARIS_TEST_OS: os },
  });

  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
};

test.each(["android", "ios"])(
  "%s can pick attachments and cancel without leaving a pending pick",
  (os) => {
    probe(
      `
let photoOptions, heic = false;
const writes = [];
mock.module("expo-image-picker", () => ({
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" },
  launchImageLibraryAsync: async (options) => {
    photoOptions = options;
    return { canceled: false, assets: [
      heic
        ? { uri: "file:///photo.heic", fileName: "photo.HEIC", mimeType: "image/heic", fileSize: 4, base64: "/9j/2Q==" }
        : { uri: "file:///photo.jpg", fileName: "photo.jpg", mimeType: "image/jpeg", fileSize: 4 },
    ] };
  },
}));
mock.module("expo-document-picker", () => ({ getDocumentAsync: async () => ({
  canceled: false, assets: [{ uri: "file:///notes.txt", name: "notes.txt", mimeType: "text/plain", size: 3 }],
}) }));
mock.module("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class {
    constructor(...parts) { this.uri = parts.join("/"); }
    size = 4;
    async write(data, options) { writes.push({ uri: this.uri, data, options }); }
  },
}));
const { pickAttachments } = await import("./src/composer/pick.ts");
const photos = pickAttachments();
assert.deepEqual(offered(), ["Photo library", "Files"]);
select(0);
assert.deepEqual(await photos, [{ uri: "file:///photo.jpg", name: "photo.jpg", mimeType: "image/jpeg", size: 4, isImage: true }]);
assert.deepEqual(photoOptions.mediaTypes, ["images"]);
assert.equal(photoOptions.allowsMultipleSelection, true);
assert.equal(photoOptions.selectionLimit, 10);
assert.equal(photoOptions.preferredAssetRepresentationMode, "compatible");
if (os === "android") {
  assert.equal(photoOptions.base64, true);
  assert.equal(photoOptions.quality, 0.99);
  heic = true;
  const converted = pickAttachments();
  select(0);
  const [photo] = await converted;
  assert.equal(photo.uri.startsWith("file:///cache/photo-"), true);
  assert.equal(photo.uri.endsWith("-0.jpg"), true);
  assert.deepEqual(photo, { uri: photo.uri, name: "photo.jpg", mimeType: "image/jpeg", size: 4, isImage: true });
  assert.deepEqual(writes, [{ uri: photo.uri, data: "/9j/2Q==", options: { encoding: "base64" } }]);
} else {
  assert.equal(photoOptions.base64, undefined);
  assert.equal(photoOptions.quality, undefined);
}
const files = pickAttachments();
select(1);
assert.deepEqual(await files, [{ uri: "file:///notes.txt", name: "notes.txt", mimeType: "text/plain", size: 3, isImage: false }]);
const canceled = pickAttachments();
cancel();
assert.deepEqual(await canceled, []);
`,
      os
    );
  },
  30_000
);

test.each(["android", "ios"])(
  "%s opens visualization links only after confirmation",
  (os) => {
    probe(
      `
const { confirmLink } = await import("./src/visualization/confirmLink.ts");
confirmLink("Unsafe", "http://example.com");
assert.equal(alert, undefined);
assert.equal(sheet, undefined);
assert.equal(currentChoice(), null);
confirmLink("Example", "https://example.com/page");
assert.deepEqual(opened, []);
assert.deepEqual(offered(), ["Open in browser"]);
if (os === "ios") assert.equal(sheet[0].title, "Open this link?");
else assert.equal(currentChoice().title, "Open this link?");
cancel();
assert.deepEqual(opened, []);
confirmLink("Example", "https://example.com/page");
select(0);
assert.deepEqual(opened, ["https://example.com/page"]);
`,
      os
    );
  },
  30_000
);

test("Android push hooks need no Apple module, notification permission or FCM token", () => {
  probe(`
const effects = [];
mock.module("react", () => ({
  useEffect: (effect) => effects.push(effect),
  useRef: (current) => ({ current }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
}));
mock.module("expo", () => ({
  requireNativeModule: (name) => { throw new Error("Cannot find native module " + name); },
  requireOptionalNativeModule: () => null,
}));
mock.module("expo-notifications", () => new Proxy({}, { get: (_, method) => () => {
  throw new Error("Android called notifications." + String(method));
} }));
mock.module("./src/runtime/hosts.tsx", () => ({ useHosts: () => [] }));
mock.module("./src/widgets/WidgetSync.ts", () => ({ refreshWidgets: () => {} }));
mock.module("./src/push/constellations.ts", () => ({ useConstellationNotifications: () => true }));
const { PolarisPush } = await import("./modules/polaris-push/index.ts");
assert.equal(PolarisPush, null);
const { PolarisLiveActivity } = await import("./modules/polaris-live-activity/index.ts");
assert.equal(PolarisLiveActivity, null);
const { usePush, usePushLinks } = await import("./src/push/usePush.ts");
usePush({}, [{ hostId: "host", hostAddress: "address" }], true);
usePushLinks(() => { throw new Error("Unexpected navigation"); });
for (const effect of effects) effect();
await new Promise((resolve) => setTimeout(resolve, 10));
`);
}, 30_000);

test.each(["android", "ios"])(
  "%s keeps all three motion choices reachable",
  (os) => {
    probe(
      `
const { choose } = await import("./src/menus/choices.ts");
let motion = -1;
for (const index of [0, 1, 2]) {
  choose("Motion", ["System", "Reduced", "Full"], (index) => { motion = index; });
  assert.deepEqual(offered(), ["System", "Reduced", "Full"]);
  select(index);
  assert.equal(motion, index);
}
`,
      os
    );
  },
  30_000
);

test("Android Back pops pushed screens, dismisses a sheet first and leaves exit to the system at Home", () => {
  probe(`
globalThis.__DEV__ = false;
mock.module("react/jsx-runtime", () => ({ jsx: (type, props) => ({ type, props }) }));
const handlers = [];
rn.BackHandler = { addEventListener: (name, callback) => {
  assert.equal(name, "hardwareBackPress");
  handlers.push(callback);
  return { remove: () => handlers.splice(handlers.indexOf(callback), 1) };
} };
const states = [], refs = [], effects = [];
let stateIndex = 0, refIndex = 0;
mock.module("react", () => ({
  createContext: () => ({ Provider: "Provider" }),
  useCallback: (callback) => callback,
  useContext: () => null,
  useMemo: (build) => build(),
  useEffect: (effect) => effects.push(effect),
  useRef: (current) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }),
  useState: (initial) => {
    const index = stateIndex++;
    if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
  },
}));
const { NavigationProvider } = await import("./src/app/navigation.tsx");
const render = () => {
  stateIndex = 0; refIndex = 0;
  return NavigationProvider({ children: null }).props.value;
};
let navigation = render();
const cleanups = effects.map((effect) => effect());
const back = () => [...handlers].reverse().some((handler) => handler());
assert.equal(back(), false);
navigation.push({ screen: "hosts" });
navigation = render();
let sheetOpen = true;
const sheetBack = rn.BackHandler.addEventListener("hardwareBackPress", () => { sheetOpen = false; return true; });
assert.equal(back(), true);
assert.equal(sheetOpen, false);
assert.equal(render().top.screen, "hosts");
sheetBack.remove();
assert.equal(back(), true);
assert.equal(render().top.screen, "tabs");
assert.equal(back(), false);
for (const cleanup of cleanups) cleanup?.();
assert.equal(handlers.length, 0);
`);
}, 30_000);

test("Android menus expose enabled actions, rename with entered text and dismiss without sending", () => {
  probe(`
const states = [];
let cursor = 0, longPress;
const jsx = (type, props) => ({ type, props });
mock.module("react/jsx-runtime", () => ({ jsx, jsxs: jsx, Fragment: "Fragment" }));
mock.module("react", () => ({ useState: (initial) => {
  const index = cursor++;
  if (!(index in states)) states[index] = initial;
  return [states[index], (next) => { states[index] = next; }];
} }));
Object.assign(rn, { Pressable: "Pressable", Text: "Text", TextInput: "TextInput", View: "View", StyleSheet: { create: (styles) => styles } });
mock.module("react-native-gesture-handler", () => ({
  GestureDetector: "GestureDetector",
  Gesture: { LongPress: () => ({ runOnJS() { return this; }, onStart(callback) { longPress = callback; return this; } }) },
}));
mock.module("./src/sheet/index.tsx", () => ({ InstrumentSheet: "InstrumentSheet", SheetHeader: "SheetHeader" }));
mock.module("./src/theme/index.ts", () => ({ useTheme: () => ({ colours: {} }) }));
const { AndroidMenu } = await import("./src/menus/AndroidMenu.tsx");
const sent = [];
const action = { kind: "copy", text: "Output" };
const entry = (id, next, disabled = false) => ({ id, title: id, action: next, disabled, subtitle: null, symbol: null });
const menu = [[entry("Copy", action), entry("Fork", { kind: "fork" }, true)], [entry("Rename", { kind: "rename", hostId: "host", sessionId: "session", title: "Before" })]];
const render = () => { cursor = 0; return AndroidMenu({ menu, title: "Turn 1", children: "row", onAction: (action) => sent.push(action) }); };
const nodes = (tree) => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const find = (tree, type, predicate = () => true) => nodes(tree).find((node) => node.type === type && predicate(node.props));
const press = (tree, text) => find(tree, "Pressable", (props) => nodes(props.children).some((node) => node.type === "Text" && node.props.children === text)).props.onPress();
let tree = render();
assert.equal(find(tree, "InstrumentSheet"), undefined);
longPress(); tree = render();
assert.equal(find(tree, "InstrumentSheet").props.open, true);
press(tree, "Fork");
assert.deepEqual(sent, []);
press(tree, "Copy");
assert.deepEqual(sent, [action]);
assert.equal(find(render(), "InstrumentSheet"), undefined);
longPress(); tree = render(); press(tree, "Rename"); tree = render();
find(tree, "TextInput").props.onChangeText("  After  ");
tree = render(); press(tree, "Save");
assert.equal(sent[1].hostId, "host");
assert.equal(sent[1].command.sessionId, "session");
assert.equal(sent[1].command.title, "After");
assert.equal(sent[1].command._tag, "RenameSession");
tree = render();
longPress(); tree = render();
find(tree, "InstrumentSheet").props.onClose();
assert.equal(sent.length, 2);
assert.equal(find(render(), "InstrumentSheet"), undefined);
`);
}, 30_000);

test("Android Copy writes the output even without the Apple context-menu module", () => {
  probe(`
let copied = null;
rn.Clipboard = { setString: (text) => { copied = text; } };
rn.StyleSheet = { create: (styles) => styles };
mock.module("expo", () => ({ requireOptionalNativeModule: () => null, requireNativeView: () => { throw new Error("Apple view requested"); } }));
mock.module("react/jsx-runtime", () => ({ jsx: (type, props) => ({ type, props }) }));
mock.module("./src/menus/AndroidMenu.tsx", () => ({ AndroidMenu: "AndroidMenu" }));
mock.module("./src/theme/index.ts", () => ({ useTheme: () => ({ colours: {} }) }));
const { copyText, LongPressMenu } = await import("./src/menus/LongPressMenu.tsx");
assert.equal(await copyText("Reply\\n\\nCode"), true);
assert.equal(copied, "Reply\\n\\nCode");
const menu = [[{ id: "copy", title: "Copy", disabled: false, action: { kind: "copy", text: "Reply" } }]];
const row = LongPressMenu({ menu, title: "Turn 1", onAction: () => {}, children: "Row" });
assert.equal(row.type, "AndroidMenu");
assert.equal(row.props.menu, menu);
`);
}, 30_000);

test.each(["android", "ios"])(
  "%s confirms Host unlink with device wording",
  (os) => {
    probe(
      `
const jsx = (type, props) => ({ type, props });
mock.module("react/jsx-runtime", () => ({ jsx, jsxs: jsx, Fragment: "Fragment" }));
mock.module("expo", () => ({ requireOptionalNativeModule: () => null }));
mock.module("./src/push/constellations.ts", () => ({
  useConstellationNotifications: () => true,
  constellationNotifications: { set: () => {} },
}));
mock.module("./src/sheet/index.tsx", () => ({
  InstrumentSheet: "InstrumentSheet", SheetHeader: "SheetHeader", Well: "Well",
}));
mock.module("./src/theme/index.ts", () => ({
  useTheme: () => ({ colours: {} }),
  themedStyles: (build) => () => build({}),
}));
Object.assign(rn, { Pressable: "Pressable", Switch: "Switch", Text: "Text", View: "View" });
const { HostSheet } = await import("./src/hosts/HostSheet.tsx");
let unlinked = 0;
const tree = HostSheet({
  details: { name: "Work Mac", state: "connected", status: "Connected", failure: null,
    roundTrip: "10 ms", route: "Relay", sessionsLabel: "Agent sessions", sessions: "2" },
  onClose: () => {},
  onUnlink: () => { unlinked++; },
});
const nodes = (tree) => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const unlink = nodes(tree).find((node) => node.type === "Pressable");
assert.ok(unlink);
const phone = os === "ios" ? "iPhone" : "phone";
const computer = os === "ios" ? "Mac" : "computer";
const label = nodes(unlink).find((node) => node.type === "Text").props.children.flat().join("");
assert.equal(label, "Unlink this " + phone + " from Work Mac\u2026");
unlink.props.onPress();
assert.equal(unlinked, 0);
assert.equal(alert[0], "Unlink this " + phone + " from Work Mac?");
assert.equal(alert[1], "Work Mac forgets this " + phone + ", and its agent sessions leave this list. Your other hosts stay linked; link again from your " + computer + ".");
assert.deepEqual(alert[2].map(({ text, style }) => ({ text, style })), [
  { text: "Cancel", style: "cancel" }, { text: "Unlink", style: "destructive" },
]);
alert[2][0].onPress?.();
assert.equal(unlinked, 0);
alert[2][1].onPress();
assert.equal(unlinked, 1);
`,
      os
    );
  },
  30_000
);
