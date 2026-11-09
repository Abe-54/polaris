/**
 * The model picker (DESIGN.md, Harness picker and Menus and popovers; Paper X-F 01): the
 * Harness chip opens an instrument card with the Harness switch in its header, the Models,
 * effort as a full-width track, fast mode and the Plan Limits. Picks are staged while it is
 * open and sent once when it closes; Escape closes without sending.
 */
import type { CelestialBody, HarnessKind } from "@polaris/protocol";
import {
  harnessHue,
  HarnessPicker,
  hueVar,
  InstrumentPopoverContent,
  Popover,
  PopoverTrigger,
  SegmentedControl,
} from "@polaris/ui";
import { useRef, useState } from "react";
import { useHost } from "../../session/hooks.ts";
import { useAvailability, useHarnessModels } from "../live.ts";
import {
  choose,
  effortFor,
  findModel,
  type ModelChoice,
  type ModelData,
  modelLabel,
  shortlist,
} from "../model/models.ts";
import { type HarnessOption, listedOptions } from "../model/options.ts";
import { AvailabilitySheet } from "./Availability.tsx";
import { FastIcon, ModelsWell, SettingsWell } from "./ModelCard.tsx";

export interface HarnessChipProps {
  readonly hostKey: string;
  readonly harness: HarnessKind;
  readonly model: string | null;
  readonly effort: string | null;
  readonly serviceTier?: "default" | "priority" | null;
  readonly fastAvailable?: boolean | undefined;
  readonly working?: boolean;
  /** The session's Celestial; unset on a new session, which shows the Harness tile. */
  readonly celestial?: CelestialBody | undefined;
  readonly disabled?: boolean;
  /** Picking a Model: `SetModel`, a Fork on it, or the new session's choice. */
  readonly onModel: (choice: ModelChoice) => void;
  /** A line under "Model" saying how a pick takes effect ("Forks a new session"). */
  readonly modelNote?: string | undefined;
  /** Models can't change now (a Turn in flight); the reason replaces the list. */
  readonly modelBlocked?: string | undefined;
  /** Other Harnesses: what picking one does, and its label ("Fork on Codex"). */
  readonly harnesses?: {
    readonly onPick: (option: HarnessOption) => void;
    readonly verb: (option: HarnessOption) => string;
  };
  /** Controls the card, so `/model` in the composer can open it; uncontrolled when unset. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

/** What the open card has picked but not sent yet: committed on close, dropped on Escape. */
interface Staged {
  readonly model: string | null;
  readonly effort: string | null;
  readonly serviceTier?: "default" | "priority" | null;
}

/** The header's Harness switch: this one and the others the Host lists; picking one closes. */
const HarnessSwitch = ({
  current,
  options,
  harnesses,
}: {
  readonly current: HarnessKind;
  readonly options: ReadonlyArray<HarnessOption>;
  readonly harnesses: NonNullable<HarnessChipProps["harnesses"]>;
}) => {
  const listed = options.some((o) => o.kind === current)
    ? options
    : [{ kind: current, name: harnessHue(current).name } as const, ...options];

  if (listed.length < 2) return null;

  return (
    <SegmentedControl
      aria-label="Harness"
      pill
      variant="fill"
      className="w-auto"
      value={current}
      onValueChange={(kind) => {
        const option = options.find((o) => o.kind === kind);

        if (option !== undefined && kind !== current) harnesses.onPick(option);
      }}
      options={listed.map((o) => ({
        value: o.kind,
        label: (
          <span
            className="flex items-center gap-1.5 px-2.5 whitespace-nowrap"
            title={"status" in o && o.kind !== current ? harnesses.verb(o) : undefined}
            data-testid={`pick-harness-${o.kind}`}
          >
            <span className="size-2 shrink-0" style={{ background: hueVar(o.kind) }} />
            {o.name}
          </span>
        ),
      }))}
    />
  );
};

const footerStatus = (name: string, version: string | null, host: string | undefined) =>
  [version === null ? name : `${name} ${version}`, host].filter((p) => p !== undefined).join(" · ");

export const HarnessChip = (props: HarnessChipProps) => {
  const { hostKey, harness, model, effort, working = false, disabled = false, harnesses } = props;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = props.open ?? ownOpen;
  const setOpen = props.onOpenChange ?? setOwnOpen;
  const [sheet, setSheet] = useState(false);
  const [staged, setStaged] = useState<Staged | null>(null);
  const cancelled = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const models = useHarnessModels(hostKey, harness);
  const { options } = useAvailability(hostKey);
  const host = useHost(hostKey);
  const name = harnessHue(harness).name;
  const { top, more } = shortlist(harness, models.models);
  const shownModel = staged?.model ?? model;
  const shownEffort = staged === null ? effort : staged.effort;
  const shownTier = staged === null ? props.serviceTier : staged.serviceTier;
  const selected = findModel(models.models, shownModel);
  const version = options.find((o) => o.kind === harness)?.version ?? null;

  // One send per opening: what was staged, if it differs from what the session has.
  const commit = () => {
    const picked = models.models.find((m) => m.id === staged?.model);

    if (
      staged !== null &&
      (staged.model !== model ||
        staged.effort !== effort ||
        (staged.serviceTier ?? null) !== (props.serviceTier ?? null))
    )
      props.onModel({
        ...(picked === undefined
          ? { model: staged.model, effort: staged.effort }
          : choose(picked, staged.effort)),
        serviceTier: staged.serviceTier ?? null,
      });
  };

  const onOpenChange = (next: boolean) => {
    if (!next && !cancelled.current) commit();
    setStaged(null);
    cancelled.current = false;
    setOpen(next);
  };

  const stageModel = (m: ModelData) =>
    setStaged({ model: m.id, effort: effortFor(m, shownEffort), serviceTier: shownTier ?? null });

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild disabled={disabled}>
          <HarnessPicker
            harness={harness}
            model={modelLabel(models.models, model, effort)}
            aria-label={`${name}, ${modelLabel(models.models, model, effort)}${props.serviceTier === "priority" ? ", fast mode on" : ""}`}
            suffix={
              harness === "codex" && props.serviceTier === "priority" ? <FastIcon /> : undefined
            }
            working={working}
            celestial={props.celestial}
            data-testid="model-picker"
          />
        </PopoverTrigger>
        <InstrumentPopoverContent
          align="start"
          ref={content}
          className="w-[360px]"
          data-testid="model-card"
          onEscapeKeyDown={() => {
            cancelled.current = true;
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current
              ?.querySelector<HTMLElement>("[data-selected], [role=radio], [data-row]")
              ?.focus();
          }}
          header={{
            title: "Model",
            control:
              harnesses === undefined ? undefined : (
                <HarnessSwitch
                  current={harness}
                  options={listedOptions(options)}
                  harnesses={harnesses}
                />
              ),
          }}
          wells={[
            <ModelsWell
              key="models"
              top={top}
              more={more}
              shown={selected?.id ?? shownModel}
              note={props.modelNote}
              blocked={props.modelBlocked}
              loading={models.loading}
              error={models.error}
              onPick={stageModel}
              onRefresh={models.refresh}
              onOtherHarnesses={() => {
                onOpenChange(false);
                setSheet(true);
              }}
            />,
            <SettingsWell
              key="settings"
              hostKey={hostKey}
              harness={harness}
              model={props.modelBlocked === undefined ? selected : undefined}
              effort={shownEffort}
              fastAvailable={props.fastAvailable === true && props.modelBlocked === undefined}
              fast={shownTier === "priority"}
              onEffort={(next) =>
                setStaged({ model: shownModel, effort: next, serviceTier: shownTier ?? null })
              }
              onFast={(on) =>
                setStaged({
                  model: shownModel,
                  effort: shownEffort,
                  serviceTier: on ? "priority" : "default",
                })
              }
              onSend={() => onOpenChange(false)}
            />,
          ]}
          footer={{ status: footerStatus(name, version, host?.label) }}
        />
      </Popover>
      <AvailabilitySheet hostKey={hostKey} open={sheet} onOpenChange={setSheet} />
    </>
  );
};

/** The chip before a Harness is chosen: while the Host is checked, or when none is ready. */
export const NoHarnessChip = ({ loading }: { readonly loading: boolean }) => (
  <span
    className="rounded-control bg-fill-selected text-caption text-text-subtle inline-flex h-[26px] shrink-0 items-center px-2"
    data-testid="model-picker"
  >
    {loading ? "Checking harnesses…" : "No harness ready"}
  </span>
);
