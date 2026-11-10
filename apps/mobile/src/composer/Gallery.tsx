/**
 * A development screen of the composer's states from fixtures, for screenshots: launch a
 * development build with `-polarisDevComposer <state>` (`-polarisDevTheme`, `-polarisDevWidth`).
 */
import {
  type ApprovalRequest,
  ContextUsage,
  type HarnessKind,
  Model,
  ModelId,
  RequestId,
  Subagent,
  SubagentId,
  TurnId,
} from "@polaris/protocol";
import { Match, Schema } from "effect";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Settings, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemeName, useTheme } from "../theme";
import { Composer } from "../thread/Composer.tsx";
import type { ComposerMode } from "../thread/composer.ts";
import { ModelSheet } from "./ModelSheet.tsx";
import { CHANGE_NOTES } from "./modelSheet.ts";
import { PERMISSION_MODES } from "../newSession/model.ts";
import { request, sessionId } from "../thread/daemon.testing.ts";
import type { Chip } from "./attach.ts";
import type { ModelSheetInput } from "./useModelSheet.ts";
import {
  EMPTY_CONTEXT,
  EXACTLY_FULL,
  LONG_DRAFT,
  LONG_ERROR,
  LONG_MODEL,
  LONG_MODELS,
  MANY_CHIPS,
  NO_WINDOW,
  ONE_SHORT_REQUEST,
  OVER_FULL,
  TWENTY_SUBAGENTS,
  UNKNOWN_HARNESS,
  WORST_QUESTION,
  WORST_REQUESTS,
  WORST_SECRET,
} from "./worstCase.ts";
import type { SecretOutcome } from "../thread/fold.ts";

const GalleryState = Schema.Literals([
  "idle",
  "typed",
  "working",
  "approval",
  "subagent",
  "long",
  "question",
  "secret",
  "secret-saved",
  "worst-secret",
  "sheet",
  "worst",
  "worst-question",
  "worst-sheet",
  "worst-zero",
  "worst-full",
  "sheet-later",
]);

type GalleryState = typeof GalleryState.Type;

const launchArgument = <A,>(key: string, is: (value: unknown) => value is A): A | null => {
  const value: unknown = Platform.OS === "ios" ? Settings.get(key) : undefined;

  return is(value) ? value : null;
};

const STATE = __DEV__ ? launchArgument("polarisDevComposer", Schema.is(GalleryState)) : null;

/** "320" for the narrowest iPhone's column. */
const widthOf = (raw: string | null): number | null => {
  const width = Number(raw ?? "");

  return width > 0 ? width : null;
};

/** A narrower column than the phone; iOS hands launch arguments over as strings. */
const WIDTH = __DEV__ ? widthOf(launchArgument("polarisDevWidth", Schema.is(Schema.String))) : null;

export const composerGalleryOn = (): boolean => STATE !== null;

const at = new Date(Date.now() - 72_000).toISOString();

const ask = (id: string, fields: Partial<ApprovalRequest>) =>
  request({ id: RequestId.make(id), openedAt: at, ...fields });

const helper = (n: number) =>
  new Subagent({
    id: SubagentId.make(`s${n}`),
    sessionId,
    turnId: TurnId.make("t"),
    parentItemId: null,
    title: `Helper ${n}`,
    agent: "Explore",
    model: null,
    status: "working",
    startedAt: at,
    endedAt: null,
  });

const SECRET = ask("k", {
  kind: "secret",
  title: "Tailscale auth key",
  detail: "To join this machine to your tailnet for the deploy",
  placeholder: "tskey-auth-…",
});

/** `secret-saved`: the strip once the key reached the Host and the agent works on. */
const SAVED: SecretOutcome = { request: SECRET, outcome: "saved" };

const REQUESTS: Readonly<Record<GalleryState, ReadonlyArray<ApprovalRequest>>> = {
  idle: [],
  typed: [],
  working: [],
  approval: [ask("a", { detail: "bun run build" })],
  subagent: [
    ask("a", { detail: "bun run build" }),
    ask("b", {
      kind: "file-change",
      detail: "apps/site/public/index.html",
      openedAt: new Date(Date.now() - 30_000).toISOString(),
    }),
  ],
  long: [ask("a", { detail: "bun run --cwd apps/mobile test -- src/composer\nbun run lint" })],
  question: [
    ask("q", { kind: "question", title: "Which base?", options: ["main", "phase-1 branch"] }),
  ],
  secret: [SECRET],
  "secret-saved": [],
  "worst-secret": WORST_SECRET,
  sheet: [],
  "sheet-later": [],
  worst: WORST_REQUESTS,
  "worst-question": WORST_QUESTION,
  "worst-sheet": [],
  "worst-zero": ONE_SHORT_REQUEST,
  "worst-full": [],
};

/** What else each state feeds the composer; the demo states keep the defaults. */
interface Scene {
  readonly harness: HarnessKind;
  readonly model: string;
  readonly subagents: ReadonlyArray<Subagent>;
  readonly context: ContextUsage | null;
  readonly text: string;
  readonly chips: ReadonlyArray<Chip>;
  readonly error: string | null;
}

const DEMO: Scene = {
  harness: "claude",
  model: "Opus 5.5",
  subagents: [],
  context: new ContextUsage({ usedTokens: 34_000, windowTokens: 200_000 }),
  text: "",
  chips: [],
  error: null,
};

const WORST: Scene = {
  harness: UNKNOWN_HARNESS,
  model: LONG_MODEL,
  subagents: TWENTY_SUBAGENTS,
  context: OVER_FULL,
  text: LONG_DRAFT,
  chips: MANY_CHIPS,
  error: LONG_ERROR,
};

const sceneOf = (state: GalleryState): Scene =>
  Match.value(state).pipe(
    Match.when("typed", () => ({ ...DEMO, text: "Now write the release timeline" })),
    Match.when("subagent", () => ({ ...DEMO, subagents: [helper(0), helper(1), helper(2)] })),
    Match.when("worst", () => WORST),
    Match.when("worst-question", () => ({ ...WORST, text: "", chips: [], error: null })),
    Match.when("worst-secret", () => ({ ...WORST, text: "", chips: [], error: null })),
    Match.when("worst-sheet", () => ({ ...DEMO, model: LONG_MODEL, context: NO_WINDOW })),
    Match.when("worst-zero", () => ({
      ...DEMO,
      harness: UNKNOWN_HARNESS,
      subagents: TWENTY_SUBAGENTS.slice(0, 1),
      context: EMPTY_CONTEXT,
    })),
    Match.when("worst-full", () => ({ ...WORST, context: EXACTLY_FULL, text: "", error: null })),
    Match.orElse(() => DEMO)
  );

const MODELS = [
  new Model({
    id: ModelId.make("opus"),
    name: "Opus 5.5",
    description: "Most capable",
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "high",
    isDefault: true,
  }),
  new Model({
    id: ModelId.make("sonnet"),
    name: "Sonnet 5.5",
    description: "Fast and capable",
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    isDefault: false,
  }),
];

const sheetInput = (
  state: GalleryState,
  open: boolean,
  setOpen: (open: boolean) => void
): ModelSheetInput => {
  const models = state === "worst-sheet" ? LONG_MODELS : MODELS;

  return {
    open,
    setOpen,
    harness: state === "worst-sheet" ? UNKNOWN_HARNESS : "claude",
    models,
    model: models[0] ?? null,
    label: sceneOf(state).model,
    effort: "high",
    change: { kind: "set" },
    note: CHANGE_NOTES.set,
    forkTo: [{ kind: "codex", name: "Codex", status: "ready", startable: true }],
    harnessPick: "fork",
    permission: "auto-edits",
    permissions: PERMISSION_MODES,
    error: null,
    pickModel: () => undefined,
    pickPermission: () => undefined,
    forkOn: () => undefined,
  };
};

const working = (state: GalleryState) =>
  state === "working" ||
  state === "subagent" ||
  state === "approval" ||
  state.startsWith("secret") ||
  state.startsWith("worst");

const modeOf = (state: GalleryState): ComposerMode =>
  working(state) ? { kind: "steer" } : { kind: "send" };

export const ComposerGallery = () => {
  const { colours, setTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const state = STATE ?? "idle";
  const scene = sceneOf(state);
  const [open, setOpen] = useState(state === "sheet" || state === "worst-sheet");
  const [text, setText] = useState(scene.text);

  useEffect(() => {
    if (state !== "sheet-later") return;
    // Time to focus the field first: the sheet then opens over the keyboard.
    const timer = setTimeout(() => setOpen(true), 8000);

    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    const theme = launchArgument("polarisDevTheme", Schema.is(ThemeName));

    if (theme !== null) setTheme(theme);
    // Launch arguments are read once.
  }, []);

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{
        flex: 1,
        justifyContent: "flex-end",
        backgroundColor: colours.ground,
        paddingHorizontal: 10,
        paddingBottom: insets.bottom,
        alignItems: WIDTH === null ? "stretch" : "center",
      }}
    >
      <View style={WIDTH === null ? null : { width: WIDTH - 20 }}>
        <Composer
          mode={modeOf(state)}
          text={text}
          harness={scene.harness}
          model={scene.model}
          celestial={null}
          workingSince={working(state) ? at : null}
          draftStatus="saved"
          error={scene.error}
          requests={{
            requests: REQUESTS[state],
            answering: [],
            errors: new Map(),
            enabled: true,
            onRespond: () => undefined,
            onProvideSecret: () => undefined,
            settled: state === "secret-saved" ? SAVED : null,
            host: { hostId: "gallery", name: "Mac Studio" },
          }}
          subagents={scene.subagents}
          contextUsage={scene.context}
          attach={{
            chips: scene.chips,
            caption: null,
            pick: () => undefined,
            add: () => undefined,
            remove: () => undefined,
          }}
          voice={{
            listening: false,
            failure: null,
            toggle: () => undefined,
            release: () => undefined,
          }}
          onChange={setText}
          onSend={() => undefined}
          onQueue={() => undefined}
          onStop={() => undefined}
        />
      </View>
      <ModelSheet input={sheetInput(state, open, setOpen)} />
    </KeyboardAvoidingView>
  );
};
