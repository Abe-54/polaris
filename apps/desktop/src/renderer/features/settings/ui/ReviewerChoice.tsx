/**
 * The Reviewer's Harness, Model and effort as three chips (Paper S7), for the default and
 * for each Workspace override. Models and efforts come from the Harness picker's own list
 * on a Host where that Harness is ready.
 */
import { HARNESS_CATALOGUE } from "@polaris/protocol";
import {
  Dither,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tile,
} from "@polaris/ui";
import { choose, type ModelData, shortlist, useHarnessModels } from "../../harness/index.ts";
import { type Choice, effortLabel, prettyModel } from "../model/reviewer.ts";

const AUTO = "auto";

const DEFAULT = "default";

interface Option {
  readonly value: string;
  readonly label: string;
}

const Chip = ({
  label,
  value,
  options,
  onChange,
  lead,
  disabled = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<Option>;
  readonly onChange: (value: string) => void;
  readonly lead?: React.ReactNode;
  readonly disabled?: boolean;
}) => (
  <Select value={value} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger
      aria-label={label}
      className="px-row-x bg-surface-sunken h-[calc(var(--spacing-tree-row)+2px)] gap-2"
    >
      <span className="text-caption text-text-subtle">{label}</span>
      {lead}
      <span className="text-body text-text-strong font-medium">
        <SelectValue />
      </span>
    </SelectTrigger>
    <SelectContent>
      {options.map((o) => (
        <SelectItem key={o.value} value={o.value}>
          {o.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const useModels = (hostKey: string | null, harness: string): ReadonlyArray<ModelData> =>
  useHarnessModels(hostKey ?? "", harness, hostKey !== null).models.filter((m) => m.id !== DEFAULT);

/** The Model's display name, once a Host has listed the Harness's Models. */
export const useModelName = (hostKey: string | null, harness: string) => {
  const models = useModels(hostKey, harness);

  return (id: string) => models.find((m) => m.id === id)?.name ?? prettyModel(id);
};

export const ModelChips = ({
  choice,
  modelHost,
  onChange,
  modelOnly,
}: {
  readonly choice: Choice;
  readonly modelHost: string | null;
  readonly onChange: (choice: Choice) => void;
  readonly modelOnly: boolean;
}) => {
  const models = useModels(modelHost, choice.harness);
  const model = models.find((m) => m.id === choice.model);
  const { top } = shortlist(choice.harness, models);

  const saved =
    choice.model === null || top.some((m) => m.id === choice.model) ? null : choice.model;

  const efforts = model?.efforts ?? (choice.effort === null ? [] : [choice.effort]);

  const modelOptions: ReadonlyArray<Option> = [
    ...(modelOnly ? [] : [{ value: DEFAULT, label: "Default" }]),
    ...top.map((m) => ({ value: m.id, label: m.name })),
    ...(saved === null ? [] : [{ value: saved, label: model?.name ?? prettyModel(saved) }]),
  ];

  return (
    <>
      <Chip
        label="Model"
        value={choice.model ?? DEFAULT}
        options={modelOptions}
        onChange={(v) => {
          const next = models.find((m) => m.id === v);

          onChange({
            ...choice,
            ...(next === undefined ? { model: null, effort: null } : choose(next, choice.effort)),
          });
        }}
      />
      {modelOnly ? null : (
        <Chip
          label="Effort"
          value={choice.effort ?? DEFAULT}
          disabled={efforts.length === 0}
          options={[
            { value: DEFAULT, label: "Default" },
            ...efforts.map((e) => ({ value: e, label: effortLabel(e) })),
          ]}
          onChange={(v) => onChange({ ...choice, effort: v === DEFAULT ? null : v })}
        />
      )}
    </>
  );
};

export const ReviewerChoice = ({
  value,
  onChange,
  modelHost,
  allowAuto,
  modelOnly = false,
}: {
  /** Null: automatic. */
  readonly value: Choice | null;
  readonly onChange: (choice: Choice | null) => void;
  /** A Host where `harness` is ready, to list its Models. */
  readonly modelHost: (harness: string) => string | null;
  readonly allowAuto: boolean;
  /** Harness and Model only, no Default or Effort (Settings → Editor's commit messages). */
  readonly modelOnly?: boolean;
}) => {
  const harnesses: ReadonlyArray<Option> = [
    ...(allowAuto ? [{ value: AUTO, label: "Automatic" }] : []),
    ...HARNESS_CATALOGUE.map((h) => ({ value: h.kind, label: h.name })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Chip
        label="Harness"
        value={value?.harness ?? AUTO}
        options={harnesses}
        lead={
          value === null ? null : (
            <Tile hue={value.harness} size={20} className="size-4 rounded-[4px]">
              <Dither hue={value.harness} size={10} />
            </Tile>
          )
        }
        onChange={(v) => onChange(v === AUTO ? null : { harness: v, model: null, effort: null })}
      />
      {value === null ? null : (
        <ModelChips
          choice={value}
          modelHost={modelHost(value.harness)}
          onChange={onChange}
          modelOnly={modelOnly}
        />
      )}
    </div>
  );
};
