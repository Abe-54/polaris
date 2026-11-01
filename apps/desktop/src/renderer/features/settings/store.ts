/**
 * The app settings the renderer reads and changes: appearance, each Harness's
 * defaults for new sessions, and Settings → Sessions. Main owns the file; a change is shown
 * at once here, then saved, and every window hears it back as an `AppEvent`.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type {
  Appearance,
  AppearancePatch,
  PolarisApi,
  SessionDefault,
  SessionDefaults,
  SessionPrefs,
  SessionPrefsPatch,
} from "../../../shared/api.ts";
import { DEFAULT_SESSION_PREFS } from "../../../shared/sessionPrefs.ts";

export interface SettingsState {
  readonly appearance: Appearance;
  readonly sessionDefaults: SessionDefaults;
  readonly sessions: SessionPrefs;
  /** Empty until main answers. */
  readonly version: string;
  /** Polaris Dev: Developer Mode comes from its leases and the switch is locked on. */
  readonly developmentBuild: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "system",
  darkTheme: "moonlit",
  density: "calm",
  textSize: "default",
  diffPalette: "default",
  motion: "system",
  codeFont: "sf-mono",
  codeFontSize: 13,
  wordWrap: false,
};

export const settingsStore = createStore<SettingsState>(() => ({
  appearance: DEFAULT_APPEARANCE,
  sessionDefaults: {},
  sessions: DEFAULT_SESSION_PREFS,
  version: "",
  developmentBuild: false,
}));

let bridge: PolarisApi | null = null;

/** Loads the settings from main and keeps them current; call once per window. */
export const connectSettings = (api: PolarisApi) => {
  bridge = api;

  void api.request("settings.get", {}).then((result) => {
    if (!result.ok) return;
    const v = result.value;

    settingsStore.setState({
      appearance: {
        theme: v.theme,
        darkTheme: v.darkTheme,
        density: v.density,
        textSize: v.textSize,
        diffPalette: v.diffPalette,
        motion: v.motion,
        codeFont: v.codeFont,
        codeFontSize: v.codeFontSize,
        wordWrap: v.wordWrap,
      },
      sessionDefaults: v.sessionDefaults,
      sessions: v.sessions,
      version: v.version,
      developmentBuild: v.developmentBuild,
    });
  });

  return api.onAppEvent((event) => {
    if (event.kind === "appearance") settingsStore.setState({ appearance: event.appearance });

    if (event.kind === "session-defaults") {
      settingsStore.setState({ sessionDefaults: event.sessionDefaults });
    }

    if (event.kind === "sessions") settingsStore.setState({ sessions: event.sessions });
  });
};

export const setAppearance = (patch: AppearancePatch) => {
  settingsStore.setState((s) => ({ appearance: { ...s.appearance, ...patch } }));
  void bridge?.request("settings.setAppearance", { patch });
};

export const setSessionDefault = (harness: string, value: SessionDefault | null) => {
  settingsStore.setState((s) => {
    const others = Object.entries(s.sessionDefaults).filter(([kind]) => kind !== harness);

    return {
      sessionDefaults: Object.fromEntries(value === null ? others : [...others, [harness, value]]),
    };
  });
  void bridge?.request("settings.setSessionDefault", { harness, value });
};

export const setSessionPrefs = (patch: SessionPrefsPatch) => {
  settingsStore.setState((s) => ({ sessions: { ...s.sessions, ...patch } }));
  void bridge?.request("settings.setSessions", { patch });
};

export const useSettings = <A>(select: (state: SettingsState) => A): A =>
  useStore(settingsStore, select);

/**
 * What a new Agent Session of `harness` starts with, as set in Settings → Harnesses;
 * null when the user hasn't chosen (the Harness's own defaults apply).
 */
export const useSessionDefault = (harness: string): SessionDefault | null =>
  useSettings((s) => s.sessionDefaults[harness] ?? null);
