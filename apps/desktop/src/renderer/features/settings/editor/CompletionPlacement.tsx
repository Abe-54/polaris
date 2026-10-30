/**
 * Tab completion's placement well (SR-02; DESIGN.md, Tab completion v1): one row per Host led
 * by its colour, with where its completion is served, then a model lane and a placement lane.
 */
import {
  cn,
  Kicker,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsWell,
} from "@polaris/ui";
import { Option, Schema } from "effect";
import {
  PredictionPlacementChoice,
  type PredictionPreferences,
} from "../../../../shared/predictionPlacement.ts";
import { modelName } from "../../editor/prediction/store.ts";
import { ColourSquare } from "../../machines/page/parts.tsx";
import type { PlacementRow } from "./placementRows.ts";

const RECOMMENDED = "recommended";

const MODEL_LANE = "w-[148px]";

/** The kit's closed select: 26px on raised-control with a hairline edge. */
const TRIGGER =
  "bg-raised-control text-caption h-[26px] gap-1.5 rounded-[8px] border-[light-dark(#00000014,#ffffff14)] px-2.5";

/** Radix drops SelectValue's className, so a long model id is truncated from the trigger. */
const TRUNCATE_VALUE = "[&>span]:min-w-0 [&>span]:truncate [&>svg]:shrink-0";

const PLACEMENT_LANE = "w-[128px]";

export type PreferencesChange = (
  hostKey: string,
  patch: Partial<Pick<PredictionPreferences, "placement" | "model" | "format">>
) => void;

const ModelSelect = ({
  row,
  onChange,
}: {
  readonly row: PlacementRow;
  readonly onChange: PreferencesChange;
}) => (
  <Select
    value={row.model ?? RECOMMENDED}
    disabled={row.placement === "off" || (row.models.length === 0 && row.model === null)}
    onValueChange={(value) =>
      onChange(row.key, { model: value === RECOMMENDED ? null : value, format: null })
    }
  >
    <SelectTrigger
      aria-label={`Completion model for ${row.name}`}
      title={row.model ?? undefined}
      className={cn(TRIGGER, MODEL_LANE, TRUNCATE_VALUE)}
    >
      <SelectValue>{row.model === null ? "Recommended" : modelName(row.model)}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectItem value={RECOMMENDED}>Recommended</SelectItem>
      {row.model !== null && row.modelMissing && (
        <SelectItem value={row.model}>{row.model} · unavailable</SelectItem>
      )}
      {row.models.map((model) => (
        <SelectItem key={model} value={model}>
          {model}
          {/qwen3.*30b/i.test(model) ? " · large, unmeasured" : ""}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const PlacementSelect = ({
  row,
  onChange,
}: {
  readonly row: PlacementRow;
  readonly onChange: PreferencesChange;
}) => (
  <Select
    value={row.placement}
    onValueChange={(value) => {
      const placement = Schema.decodeUnknownOption(PredictionPlacementChoice)(value);

      if (Option.isSome(placement)) onChange(row.key, { placement: placement.value });
    }}
  >
    <SelectTrigger
      aria-label={`Completion placement for ${row.name}`}
      className={cn(TRIGGER, PLACEMENT_LANE)}
    >
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="auto">Auto</SelectItem>
      <SelectItem value="client">This machine</SelectItem>
      <SelectItem value="host" disabled={!row.hostCanServe}>
        {row.hostCanServe ? "This host" : "This host · too small"}
      </SelectItem>
      <SelectItem value="off">Off</SelectItem>
    </SelectContent>
  </Select>
);

/** Colour square, name and where it's served; the two lanes keep fixed widths so they align. */
const Row = ({
  row,
  colour,
  onChange,
}: {
  readonly row: PlacementRow;
  readonly colour: string | null;
  readonly onChange: PreferencesChange;
}) => (
  <div
    className="px-panel flex items-center gap-3 py-[calc(var(--spacing-gap)+3px)]"
    data-testid="placement-row"
  >
    <ColourSquare colour={colour} size={8} />
    <div className="flex min-w-0 flex-1 flex-col">
      <span className="text-body text-text-default truncate" title={row.name}>
        {row.name}
      </span>
      <span className="text-caption text-text-subtle truncate">{row.caption}</span>
    </div>
    <div className="flex shrink-0 items-center gap-3">
      <ModelSelect row={row} onChange={onChange} />
      <PlacementSelect row={row} onChange={onChange} />
    </div>
  </div>
);

export const CompletionPlacement = ({
  rows,
  colours,
  onChange,
}: {
  readonly rows: ReadonlyArray<PlacementRow>;
  /** Each Host's own colour by key; null when it has none. */
  readonly colours: Readonly<Record<string, string | null>>;
  readonly onChange: PreferencesChange;
}) => (
  <SettingsWell aria-label="Completion placement" data-testid="completion-placement">
    <div className="px-panel flex items-center gap-3 py-2">
      <Kicker className="text-text-subtle min-w-0 flex-1 truncate">
        Where each host's completion runs · Auto picks the stronger machine
      </Kicker>
      <Kicker className="text-text-subtle flex shrink-0 gap-3" aria-hidden>
        <span className={MODEL_LANE}>Model</span>
        <span className={PLACEMENT_LANE}>Runs on</span>
      </Kicker>
    </div>
    {rows.map((row) => (
      <Row key={row.key} row={row} colour={colours[row.key] ?? null} onChange={onChange} />
    ))}
  </SettingsWell>
);
