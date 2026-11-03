import { expect } from "bun:test";

/** Runs each native-boundary probe in its own process so module mocks never leak into other tests. */
export const nativeProbe = (body: string, platform = "android") => {
  const result = Bun.spawnSync([process.execPath, "--eval", boundary + body], {
    cwd: `${import.meta.dir}/..`,
    env: { ...process.env, POLARIS_TEST_OS: platform },
  });

  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
};

const boundary = `
import assert from "node:assert/strict";
import { mock } from "bun:test";
if (process.env.POLARIS_TEST_BASELINE === "1") {
  const { plugin } = await import("bun");
  const { relative, resolve } = await import("node:path");
  const root = resolve(process.cwd(), "../../..");
  plugin({ name: "Mobile accessibility and copy baseline", setup: (build) => {
    build.onLoad({ filter: /(?:host|AndroidMenu|LinkScreen|ScanSheet|HostSheet)\\.tsx$/ }, ({ path }) => {
      const file = relative(root, path).replaceAll(String.fromCharCode(92), "/");
      const head = Bun.spawnSync(["git", "show", "HEAD:" + file], { cwd: root });
      assert.equal(head.exitCode, 0, head.stderr.toString());
      return { contents: head.stdout.toString(), loader: "tsx" };
    });
  } });
}
const os = process.env.POLARIS_TEST_OS;
const jsx = (type, props) => ({ type, props });
mock.module("react/jsx-runtime", () => ({ jsx, jsxs: jsx, Fragment: "Fragment" }));
mock.module("react/jsx-dev-runtime", () => ({ jsxDEV: jsx, Fragment: "Fragment" }));
const states = [];
let cursor = 0;
mock.module("react", () => ({
  createContext: () => ({ Provider: "Provider" }),
  useContext: () => null,
  useId: () => "sheet",
  useState: (initial) => {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
    return [states[index], (next) => { states[index] = typeof next === "function" ? next(states[index]) : next; }];
  },
  useCallback: (callback) => callback,
  useMemo: (build) => build(),
  useLayoutEffect: () => {},
  useEffect: () => {},
  useRef: (current) => ({ current }),
}));
const rn = {
  Platform: { OS: os },
  View: "View", Text: "Text", Pressable: "Pressable", TextInput: "TextInput",
  StyleSheet: { create: (styles) => styles, absoluteFill: {} },
};
mock.module("react-native", () => rn);
mock.module("./theme/index.ts", () => ({
  themedStyles: () => () => ({}),
  useTheme: () => ({ colours: {} }),
}));
const nodes = (tree) => Array.isArray(tree) ? tree.flatMap(nodes)
  : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const exposed = (tree) => Array.isArray(tree) ? tree.flatMap(exposed)
  : !tree || typeof tree !== "object" || tree.props?.importantForAccessibility === "no-hide-descendants"
    ? [] : [tree, ...exposed(tree.props?.children)];
`;
