/**
 * A development screen of the composer's states from fixtures, for screenshots: launch a
 * development build with `-polarisDevComposer <state>` (`-polarisDevTheme`, `-polarisDevWidth`).
 */
import { Model, ModelId } from "@polaris/protocol";
import { Schema } from "effect";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Settings, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ThemeName, useTheme } from "../theme";
import { Composer } from "../thread/Composer.tsx";
import type { ComposerMode } from "../thread/composer.ts";
import { ModelSheet } from "./ModelSheet.tsx";
import { CHANGE_NOTES } from "./modelSheet.ts";
import { PERMISSION_MODES } from "../newSession/model.ts";
import type { ModelSheetInput } from "./useModelSheet.ts";
import { at, REQUESTS, SAVED, sceneOf } from "./galleryScenes.testing.ts";
import { LONG_MODELS, UNKNOWN_HARNESS } from "./worstCase.testing.ts";

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

export type GalleryState = typeof GalleryState.Type;

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
