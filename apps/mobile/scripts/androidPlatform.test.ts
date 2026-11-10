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
const { currentChoice, finishChoice } = await import("./src/menus/choiceStore.ts");
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
mock.module("expo-document-picker", () => ({ getDocumentAsync: async () => ({
  canceled: false, assets: [{ uri: "file:///notes.txt", name: "notes.txt", mimeType: "text/plain", size: 3 }],
}) }));
mock.module("expo-image-picker", () => ({ UIImagePickerPreferredAssetRepresentationMode: {}, launchImageLibraryAsync: async () => ({ canceled: true }) }));
mock.module("expo-file-system", () => ({ File: class {}, Paths: {} }));
const { pickAttachments } = await import("./src/composer/pick.ts");
const photos = pickAttachments();
assert.deepEqual(offered(), ["Photo library", "Files"]);
select(0);
assert.deepEqual(await photos, []);
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
const { linkConfirms } = await import("@polaris/visualization");
const { confirmLink: confirm } = await import("./src/visualization/confirmLink.ts");
let now = 0;
const confirms = linkConfirms(() => now);
const confirmLink = (title, url) => confirm(title, url, confirms);
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
now += 1000;
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
}, 30_000);

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
