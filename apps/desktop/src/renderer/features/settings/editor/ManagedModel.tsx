/**
 * Tab completion's model well (SR-02; DESIGN.md, Tab completion setup): the one model Polaris
 * runs on the chosen machine with its memory meter, the folder it lives in, and what it's doing.
 */
import {
  Input,
  Kicker,
  SettingsButton,
  SettingsRow,
  SettingsSelect,
  SettingsWell,
} from "@polaris/ui";
import { ManagedModelId, type ManagedServerStatus } from "@polaris/protocol";
import { Match, Option, Schema } from "effect";
import { useEffect, useState, type ReactNode } from "react";
import type { PredictionSide } from "@polaris/client/prediction";
import { polaris } from "../../bridge.ts";
import { FAILURE_TITLES, gb } from "../../editor/prediction/card/managed.ts";
import {
  managedAction,
  managedKey,
  preferencesOf,
  setHostPreferences,
  usePrediction,
  watchManaged,
} from "../../editor/prediction/store.ts";
import { inSentence } from "./placementRows.ts";

const SWEEP = "sweep-next-edit-1.5b";

/** The closed control says the pick; the open list adds what each costs in memory. */
const CHOICES: ReadonlyArray<{
  readonly value: ManagedModelId;
  readonly name: string;
  readonly tag: string;
  readonly label: string;
  readonly short: string;
  /** The other model's cost, under the meter. */
  readonly other: string;
}> = [
  {
    value: SWEEP,
    name: "Sweep Next-Edit 1.5B",
    tag: "recommended",
    label: "Sweep Next-Edit 1.5B · recommended · 2.6 GB of memory",
    short: "Sweep",
    other: "Zeta needs ~9 GB",
  },
  {
    value: "zeta-2.1",
    name: "Zeta 2.1",
    tag: "higher quality",
    label: "Zeta 2.1 · higher quality · about 9 GB of memory",
    short: "Zeta",
    other: "Sweep needs ~2.6 GB",
  },
];

export interface ManagedModelProps {
  /** The preferences key of the machine: the local Host's for the Client side, else the Host's. */
  readonly hostKey: string;
  readonly side: PredictionSide;
  readonly machine: string;
  readonly connected: boolean;
  /** The machine picker in the kicker row. */
  readonly picker?: ReactNode;
  /** The machine's memory, for the meter; null when unknown. */
  readonly ramBytes?: number | null;
  /** Rows after the folder (Prediction history). */
  readonly children?: ReactNode;
}

/** A pixel meter: 3px cells every 5px, filled to `fraction`, the rest a faint track. */
const Meter = ({ fraction }: { readonly fraction: number }) => (
  <div
    role="meter"
    aria-label="Memory"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(fraction * 100)}
    className="h-2 w-full bg-[light-dark(#0000000f,#ffffff12)]"
  >
    <div
      className="h-full bg-[repeating-linear-gradient(90deg,var(--color-text-default)_0_3px,transparent_3px_5px)]"
      style={{ width: `${Math.min(100, Math.max(1, fraction * 100))}%` }}
    />
  </div>
);

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

/** One line for the status row, and which buttons follow it. */
const describe = (status: ManagedServerStatus, machine: string, ramBytes: number | null) =>
  Match.value(status.phase).pipe(
    Match.tag("Unsupported", (phase) => ({
      line:
        phase.reason === "too-small"
          ? `${machine} is too small to run a next-edit model`
          : `No model server build for ${machine}`,
      primary: null,
      remove: false,
      cancel: false,
    })),
    Match.tag("Absent", () => ({
      line: `Not downloaded · ${gb(status.model.sizeBytes + status.model.serverBytes)} download${status.freeBytes === null ? "" : ` · ${gb(status.freeBytes)} free`}`,
      primary: `Download ${status.model.name}`,
      remove: false,
      cancel: false,
    })),
    Match.tag("Downloading", (phase) => ({
      line: `Downloading ${phase.file === "server" ? "the model server" : status.model.name} · ${mb(phase.receivedBytes)} of ${gb(phase.totalBytes)}`,
      primary: null,
      remove: false,
      cancel: true,
    })),
    Match.tag("Verifying", () => ({
      line: "Verifying the download against its published checksum",
      primary: null,
      remove: false,
      cancel: false,
    })),
    Match.tag("Stopped", () => ({
      line: "Downloaded · starts on the first keystroke, stops after 15 idle minutes",
      primary: null,
      remove: true,
      cancel: false,
    })),
    Match.tag("Starting", () => ({
      line: `Loading ${status.model.name}…`,
      primary: null,
      remove: true,
      cancel: false,
    })),
    Match.tag("Serving", () => ({
      line: `Running${status.memoryBytes === null ? "" : ` · ${gb(status.memoryBytes)} of ${ramBytes === null ? "" : `${gb(ramBytes)} `}memory`}`,
      primary: null,
      remove: true,
      cancel: false,
    })),
    Match.tag("Backoff", (phase) => ({
      line: `Stopped · restarting in ${Math.ceil(phase.retryInMs / 1000)} s`,
      primary: null,
      remove: true,
      cancel: false,
    })),
    Match.tag("Failed", (phase) => ({
      line:
        phase.message.length > 0
          ? `${FAILURE_TITLES[phase.reason]} · ${phase.message}`
          : FAILURE_TITLES[phase.reason],
      primary: "Try again",
      remove: true,
      cancel: false,
    })),
    Match.exhaustive
  );

const progressOf = (status: ManagedServerStatus) =>
  Match.value(status.phase).pipe(
    Match.tag("Downloading", (phase) =>
      phase.totalBytes === 0 ? 0 : phase.receivedBytes / phase.totalBytes
    ),
    Match.orElse(() => null)
  );

export const ManagedModel = ({
  hostKey,
  side,
  machine,
  connected,
  picker,
  ramBytes = null,
  children,
}: ManagedModelProps) => {
  const status = usePrediction(
    (state) =>
      state.managed[managedKey(hostKey, side)] ?? state.inspections[hostKey]?.managed[side] ?? null
  );

  const preferences =
    usePrediction((state) => state.preferences[hostKey]) ?? preferencesOf(hostKey);

  const [folder, setFolder] = useState(preferences.modelsDir ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;

    return watchManaged(polaris(), hostKey, side);
  }, [hostKey, side, connected]);

  useEffect(() => setFolder(preferences.modelsDir ?? ""), [preferences.modelsDir]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);

    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const act = (action: "setup" | "cancel" | "remove") =>
    run(async () => {
      await managedAction(polaris(), hostKey, side, action);
    });

  const saveFolder = (value: string) => {
    const modelsDir = value.trim() === "" ? null : value.trim();

    if (modelsDir === preferences.modelsDir) return;

    void run(async () => {
      await setHostPreferences(polaris(), hostKey, { modelsDir });
      await managedAction(polaris(), hostKey, side, null);
    });
  };

  const choose = () =>
    run(async () => {
      const result = await polaris().request("prediction.modelsDir.choose", {});

      if (result.ok && result.value !== null) {
        setFolder(result.value);
        saveFolder(result.value);
      }
    });

  const chooseModel = (value: string) => {
    const model = Schema.decodeUnknownOption(ManagedModelId)(value);

    void run(async () => {
      await setHostPreferences(polaris(), hostKey, {
        managedModel: Option.isSome(model) && model.value !== SWEEP ? model.value : null,
      });
      await managedAction(polaris(), hostKey, side, null);
    });
  };

  const described = status === null ? null : describe(status, machine, ramBytes);
  const progress = status === null ? null : progressOf(status);

  const folderCaption =
    status === null
      ? `On ${inSentence(machine)}`
      : `${status.modelsDir}${status.freeBytes === null ? "" : ` · ${gb(status.freeBytes)} free`}`;

  const chosen = CHOICES.find((choice) => choice.value === (preferences.managedModel ?? SWEEP));
  const memory = status?.memoryBytes ?? null;
  const line = !connected ? `${machine} is offline` : (described?.line ?? `Checking ${machine}…`);

  return (
    <SettingsWell aria-label={`Model on ${inSentence(machine)}`}>
      <div className="px-panel flex flex-col gap-2 pt-[calc(var(--spacing-panel)-2px)] pb-3">
        <div className="flex items-center justify-between gap-3">
          <Kicker className="text-text-subtle">{`Model · ${machine}`}</Kicker>
          {picker}
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-text-strong truncate text-[20px] leading-6">{chosen?.name}</span>
          <span className="text-caption text-text-subtle shrink-0">{chosen?.tag}</span>
          <span className="flex-1" />
          <SettingsSelect
            id={`managed-model-${hostKey}`}
            label={`Model on ${inSentence(machine)}`}
            value={chosen?.value}
            options={CHOICES}
            disabled={busy || !connected}
            onChange={chooseModel}
          />
        </div>
        <div className="flex flex-col gap-1">
          {progress !== null ? (
            <div
              role="progressbar"
              aria-label="Download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.floor(progress * 100)}
            >
              <Meter fraction={progress} />
            </div>
          ) : memory !== null && ramBytes !== null && ramBytes > 0 ? (
            <Meter fraction={memory / ramBytes} />
          ) : null}
          <div className="flex justify-between gap-3">
            <span
              className="text-caption text-text-subtle min-w-0 truncate"
              role="status"
              data-testid="managed-status"
              title={described?.line ?? undefined}
            >
              {line}
            </span>
            <span className="text-caption text-text-subtle shrink-0">{chosen?.other}</span>
          </div>
          {described === null ||
          (!described.cancel && !described.remove && described.primary === null) ? null : (
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              {described.cancel && (
                <SettingsButton variant="ghost" disabled={busy} onClick={() => void act("cancel")}>
                  Cancel
                </SettingsButton>
              )}
              {described.remove && (
                <SettingsButton variant="ghost" disabled={busy} onClick={() => void act("remove")}>
                  Remove downloaded model
                </SettingsButton>
              )}
              {described.primary !== null && (
                <SettingsButton disabled={busy || !connected} onClick={() => void act("setup")}>
                  {described.primary}
                </SettingsButton>
              )}
            </div>
          )}
          {error !== null && (
            <span role="alert" className="text-caption text-text-strong">
              {error}
            </span>
          )}
        </div>
      </div>
      <SettingsRow htmlFor={`models-dir-${hostKey}`} title="Model folder" caption={folderCaption}>
        <Input
          id={`models-dir-${hostKey}`}
          value={folder}
          placeholder="~/.polaris/models"
          spellCheck={false}
          className="h-[26px] w-36 font-mono text-[11px]"
          disabled={busy || !connected}
          onChange={(event) => setFolder(event.target.value)}
          onBlur={(event) => saveFolder(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveFolder(folder);
          }}
        />
        {side === "client" && (
          <SettingsButton disabled={busy || !connected} onClick={() => void choose()}>
            Choose…
          </SettingsButton>
        )}
      </SettingsRow>
      {children}
    </SettingsWell>
  );
};
