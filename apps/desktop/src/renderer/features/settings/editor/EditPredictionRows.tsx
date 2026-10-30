/**
 * Tab completion's behaviour well (SR-02; Edit Predictions EP7, spec §7): Display,
 * Aggressiveness, Accept key and Off in, kept the same on every Host, and "Clear history".
 */
import {
  Kbd,
  SegmentedControl,
  SettingsButton,
  SettingsRow,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@polaris/ui";
import { useState } from "react";
import type { HostView } from "../../../../shared/api.ts";
import { chordOf } from "../../../../shared/keymap.ts";
import { currentKeyPlatform, modifierLabel } from "../../../../shared/chord.ts";
import {
  PREDICTION_ACCEPT_BINDING,
  type PredictionAggressiveness,
  type PredictionPreferences,
} from "../../../../shared/predictionPlacement.ts";
import { polaris } from "../../bridge.ts";
import { LANGUAGE_IDS, LANGUAGES, type LanguageId } from "../../editor/model/language.ts";
import {
  preferencesOf,
  setPreferencesEverywhere,
  usePrediction,
} from "../../editor/prediction/store.ts";

type Display = PredictionPreferences["display"];

const DISPLAY: ReadonlyArray<{ readonly value: Display; readonly label: string }> = [
  { value: "full", label: "Full" },
  { value: "subtle", label: "Subtle" },
];

const AGGRESSIVENESS: ReadonlyArray<{
  readonly value: PredictionAggressiveness;
  readonly label: string;
}> = [
  { value: "conservative", label: "Conservative" },
  { value: "balanced", label: "Balanced" },
  { value: "eager", label: "Eager" },
];

const ADD = "add-language";

/** The binding's key as the editor's hint spells it ("Tab"), not the menu glyph. */
const acceptKey = () => chordOf(PREDICTION_ACCEPT_BINDING, currentKeyPlatform()) ?? "Tab";

const isLanguageId = (value: string): value is LanguageId =>
  LANGUAGE_IDS.some((id) => id === value);

/** Each machine keeps its own copy of these preferences; the rows read the local one and set all. */
const keysOf = (hosts: ReadonlyArray<HostView>) => {
  const keys = hosts.map((host) => host.key);

  return keys.includes("local") ? keys : ["local", ...keys];
};

export const EditPredictionRows = ({
  hosts,
  onError,
}: {
  readonly hosts: ReadonlyArray<HostView>;
  readonly onError: (message: string | null) => void;
}) => {
  const loaded = usePrediction((state) => state.loaded);
  const local = hosts.find((host) => host.kind === "local")?.key ?? "local";
  const preferences = usePrediction((state) => state.preferences[local]) ?? preferencesOf(local);

  const set = (patch: Partial<PredictionPreferences>) =>
    setPreferencesEverywhere(polaris(), keysOf(hosts), patch).then(
      () => onError(null),
      (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause))
    );

  const disabled = preferences.disabledLanguages.filter(isLanguageId);
  const offered = LANGUAGE_IDS.filter((id) => id !== "plain" && !disabled.includes(id));

  return (
    <>
      <SettingsRow title="Display" caption={`Subtle shows a marker; hold ${modifierLabel("Alt")}`}>
        <SegmentedControl
          variant="well"
          aria-label="Display"
          options={DISPLAY}
          value={preferences.display}
          onValueChange={(display) => void set({ display })}
        />
      </SettingsRow>
      <SettingsRow title="Aggressiveness" caption="Pause, jump reach, deletions">
        <SegmentedControl
          variant="well"
          aria-label="Aggressiveness"
          options={AGGRESSIVENESS}
          value={preferences.aggressiveness}
          onValueChange={(aggressiveness) => void set({ aggressiveness })}
        />
      </SettingsRow>
      <SettingsRow title="Accept key" caption="Tab by default · a Keyboard page will remap it">
        <Kbd aria-label={`Accept key: ${acceptKey()}`}>{acceptKey()}</Kbd>
      </SettingsRow>
      <div className="px-panel flex flex-wrap items-center gap-2 py-[calc(var(--spacing-gap)+4px)]">
        <span className="text-body text-text-default min-w-0 flex-1">Off in</span>
        {disabled.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Languages with tab completion off">
            {disabled.map((id) => (
              <li
                key={id}
                className="bg-raised-control text-caption text-text-default flex h-6 items-center gap-1 rounded-full pr-1 pl-2.5"
              >
                {LANGUAGES[id].name}
                <button
                  type="button"
                  aria-label={`Turn tab completion back on for ${LANGUAGES[id].name}`}
                  className="text-text-subtle hover:text-text-default hover:bg-fill-hover flex size-5 cursor-default items-center justify-center rounded-full text-[11px]"
                  onClick={() =>
                    void set({ disabledLanguages: disabled.filter((item) => item !== id) })
                  }
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <Select
          value={ADD}
          disabled={!loaded || offered.length === 0}
          onValueChange={(value) => {
            if (isLanguageId(value)) void set({ disabledLanguages: [...disabled, value] });
          }}
        >
          <SelectTrigger
            aria-label="Add language"
            className="text-caption text-text-subtle h-6 w-auto gap-1.5 rounded-full border-dashed border-[light-dark(#00000026,#ffffff2e)] bg-transparent px-2.5"
          >
            <SelectValue>Add language</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ADD} className="hidden">
              Add language
            </SelectItem>
            {offered.map((id) => (
              <SelectItem key={id} value={id}>
                {LANGUAGES[id].name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
};

/** The outcome log behind the status card's counts (spec §8); one button, no confirmation. */
export const ClearHistoryRow = () => {
  const [state, setState] = useState<"idle" | "clearing" | "cleared" | "failed">("idle");

  const clear = () => {
    setState("clearing");
    void polaris()
      .request("prediction.outcomes.clear", {})
      .then((result) => setState(result.ok ? "cleared" : "failed"));
  };

  return (
    <SettingsRow title="Prediction history" caption="The status card's counts · never uploaded">
      {state === "cleared" && (
        <span role="status" className="text-caption text-text-subtle">
          Cleared
        </span>
      )}
      {state === "failed" && (
        <span role="alert" className="text-caption text-text-strong">
          Couldn't clear it
        </span>
      )}
      <SettingsButton disabled={state === "clearing"} onClick={clear}>
        {state === "clearing" ? "Clearing…" : "Clear history"}
      </SettingsButton>
    </SettingsRow>
  );
};
