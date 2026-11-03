import { expect, test } from "bun:test";
import { deviceCopyFor } from "../app/deviceCopy.ts";
import { nativeProbe } from "../app/nativeProbe.testing.ts";
import { linking } from "./linking.ts";
import { notSavedMessage } from "./model.ts";

test.each(["android", "ios"])("%s linking names the phone when saving fails", async (platform) => {
  let failure = "";
  const { encodeLinkEnvelope, HostId } = await import("@polaris/protocol");

  const link = encodeLinkEnvelope({
    link: {
      hostId: HostId.make("desktop"),
      hostName: "desktop",
      relayUrl: "wss://relay.polaris.dev/v1",
      // SAFETY: RelayAddress is 22 base64url characters; its brand is not exported for tests.
      hostAddress: "a".repeat(22) as Parameters<
        typeof encodeLinkEnvelope
      >[0]["link"]["hostAddress"],
      hostNoiseKey: "b".repeat(43),
      secret: "c".repeat(43),
      expiresAt: "2026-10-29T12:00:00.000Z",
    },
    hosts: [],
  });

  const machine = linking({
    onLink: () => Promise.reject(new Error("secure storage unavailable")),
    onStep: (step) => {
      if (step.kind === "failed") failure = step.message;
    },
    notSaved: notSavedMessage(deviceCopyFor(platform)),
  });

  machine.submit(link);
  await Promise.resolve();

  expect(failure).toBe(
    platform === "android"
      ? "Couldn't save the link on this phone. Make a new one and try again."
      : "Couldn't save the link on this iPhone. Make a new one and try again."
  );
});

test.each(["android", "ios"])(
  "%s pairing and scan instructions keep the required copy",
  (platform) => {
    nativeProbe(
      `
Object.assign(rn, { ScrollView: "ScrollView", useWindowDimensions: () => ({ height: 850, fontScale: 1 }) });
mock.module("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16 }) }));
mock.module("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
mock.module("./dither/index.ts", () => ({ Dither: "Dither" }));
mock.module("./sheet/index.tsx", () => ({ InstrumentSheet: "InstrumentSheet", SheetHeader: "SheetHeader", SheetKicker: "SheetKicker" }));
mock.module("./link/Viewfinder.tsx", () => ({ Viewfinder: "Viewfinder" }));
mock.module("./link/Sky.tsx", () => ({ Sky: "Sky" }));
mock.module("./link/Star.tsx", () => ({ STAR_SIZE: 100 }));
mock.module("./horizon/index.tsx", () => ({ HORIZON_HEIGHT: 100 }));
mock.module("./horizon/scene.ts", () => ({ RIDGE_TOP: 20, HORIZON_HEIGHT: 200, MOON_TOP: 72 }));
mock.module("./relay/RelayProvider.tsx", () => ({ useRelay: () => ({}) }));
const { PAIRING_COPY, LINK_ANOTHER_COPY, ScanSheetView } = await import("./link/ScanSheet.tsx");
const { Pairing } = await import("./link/LinkScreen.tsx");
const expand = (tree) => Array.isArray(tree) ? tree.map(expand) : tree && typeof tree === "object"
  ? typeof tree.type === "function" ? expand(tree.type(tree.props))
    : { ...tree, props: { ...tree.props, children: expand(tree.props.children) } } : tree;
const text = (tree) => Array.isArray(tree) ? tree.map(text).join("")
  : tree && typeof tree === "object" ? text(tree.props.children) : String(tree ?? "");
const phone = os === "android" ? "phone" : "iPhone";
const computer = os === "android" ? "computer" : "Mac";
assert.equal(PAIRING_COPY.kicker, "Scan from your " + computer);
assert.equal(PAIRING_COPY.instruction, "On your " + computer + ", open Polaris → Settings → Devices and scan the code.");
assert.equal(PAIRING_COPY.pasteInstruction, "On your " + computer + ", open Polaris → Settings → Devices and copy the link.");
assert.equal(LINK_ANOTHER_COPY.title, "Link another " + computer);
assert.equal(LINK_ANOTHER_COPY.instruction, "On that " + computer + ", open Polaris → Settings → Devices and scan the code.");
assert.equal(LINK_ANOTHER_COPY.pasteInstruction, "On that " + computer + ", open Polaris → Settings → Devices and copy the link.");
const state = { step: { kind: "scan" }, submit: () => {}, show: () => {} };
cursor = 0;
let tree = expand(Pairing({ linking: state }));
const lines = nodes(tree).filter((node) => node.type === "Text").map(text);
assert(lines.includes("Link this " + phone));
assert(lines.includes("Your agent sessions run on your " + computer + ". Link it to follow them and answer from here."));
cursor = 0;
tree = expand(ScanSheetView({ open: true, linking: { ...state, step: { kind: "linked", hostName: "desktop", hosts: ["desktop"] } }, ...PAIRING_COPY }));
assert(text(tree).includes("Linked this " + phone));
if (os === "android") assert.equal(text(tree).includes("iPhone"), false);
`,
      platform
    );
  }
);
