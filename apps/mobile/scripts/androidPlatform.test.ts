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
  Alert: { alert: (...args) => { alert = args; } },
  ActionSheetIOS: { showActionSheetWithOptions: (...args) => {
    assert.equal(os, "ios", "Android called ActionSheetIOS"); sheet = args;
  } },
  Linking: { openURL: async (url) => { opened.push(url); } },
};
mock.module("react-native", () => rn);
if (process.env.POLARIS_TEST_HEAD === "1") {
  const { plugin } = await import("bun");
  const { relative, resolve } = await import("node:path");
  const root = resolve(process.cwd(), "../..");
  plugin({ name: "Android regression baseline", setup: (build) => {
    build.onLoad({ filter: /(?:polaris-push[\\\\/]index|composer[\\\\/]pick|visualization[\\\\/]confirmLink|app[\\\\/]navigation|menus[\\\\/]LongPressMenu)\\.tsx?$/ }, ({ path }) => {
      const file = relative(root, path).replaceAll("\\\\", "/");
      const head = Bun.spawnSync(["git", "show", "HEAD:" + file], { cwd: root });
      assert.equal(head.exitCode, 0, head.stderr.toString());
      return { contents: head.stdout.toString(), loader: path.endsWith("tsx") ? "tsx" : "ts" };
    });
  } });
}
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
mock.module("expo-image-picker", () => ({
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" },
  launchImageLibraryAsync: async () => ({ canceled: false, assets: [
    { uri: "file:///photo.jpg", fileName: "photo.jpg", mimeType: "image/jpeg", fileSize: 4 },
  ] }),
}));
mock.module("expo-document-picker", () => ({ getDocumentAsync: async () => ({
  canceled: false, assets: [{ uri: "file:///notes.txt", name: "notes.txt", mimeType: "text/plain", size: 3 }],
}) }));
mock.module("expo-file-system", () => ({ File: class {} }));
const { pickAttachments } = await import("./src/composer/pick.ts");
const select = (index) => os === "ios" ? sheet[1](index) : alert[2][index].onPress();
const photos = pickAttachments();
select(0);
assert.deepEqual(await photos, [{ uri: "file:///photo.jpg", name: "photo.jpg", mimeType: "image/jpeg", size: 4, isImage: true }]);
const files = pickAttachments();
select(1);
assert.deepEqual(await files, [{ uri: "file:///notes.txt", name: "notes.txt", mimeType: "text/plain", size: 3, isImage: false }]);
const canceled = pickAttachments();
if (os === "ios") sheet[1](2); else alert[3].onDismiss();
assert.deepEqual(await canceled, []);
`,
      os
    );
  }
);

test.each(["android", "ios"])("%s opens visualization links only after confirmation", (os) => {
  probe(
    `
const { linkConfirms } = await import("@polaris/visualization");
const { confirmLink: confirm } = await import("./src/visualization/confirmLink.ts");
let now = 0;
const confirms = linkConfirms(() => now);
const confirmLink = (title, url) => confirm(title, url, confirms);

confirmLink("Unsafe", "http://example.com");
assert.equal(alert, undefined);
assert.equal(sheet, undefined);
confirmLink("Example", "https://example.com/page");
assert.deepEqual(opened, []);
if (os === "ios") sheet[1](1); else alert[3].onDismiss();
assert.deepEqual(opened, []);
now += 1000;
confirmLink("Example", "https://example.com/page");
if (os === "ios") sheet[1](0); else alert[2][0].onPress();
assert.deepEqual(opened, ["https://example.com/page"]);
`,
    os
  );
});

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
mock.module("./src/push/hostNotifications.ts", () => ({ useHostNotificationsKey: () => "", hostNotifications: { get: () => true } }));
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
});

test.each(["android", "ios"])("%s keeps all three motion choices reachable", (os) => {
  probe(
    `
const { choose } = await import("./src/menus/choices.ts");
let motion = -1;
choose("Motion", ["System", "Reduced", "Full"], (index) => { motion = index; });
if (os === "ios") sheet[1](2); else {
  assert.equal(alert[2].length, 3);
  alert[2][2].onPress();
}
assert.equal(motion, 2);
`,
    os
  );
});

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
const states = [], refs = [], effects = [], events = [];
let stateIndex = 0, refIndex = 0, eventIndex = 0;
mock.module("react", () => ({
  createContext: () => ({ Provider: "Provider" }),
  useCallback: (callback) => callback,
  useContext: () => null,
  useMemo: (build) => build(),
  useEffect: (effect) => effects.push(effect),
  // Like React's: the function it returns always calls the latest render's.
  useEffectEvent: (event) => {
    const index = eventIndex++;
    events[index] = event;
    return (...args) => events[index](...args);
  },
  useRef: (current) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }),
  useState: (initial) => {
    const index = stateIndex++;
    if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
  },
}));
const { NavigationProvider } = await import("./src/app/navigation.tsx");
const render = () => {
  stateIndex = 0; refIndex = 0; eventIndex = 0;
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
});

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
longPress(); tree = render();
find(tree, "InstrumentSheet").props.onClose();
assert.equal(sent.length, 2);
assert.equal(find(render(), "InstrumentSheet"), undefined);
`);
});

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
});
