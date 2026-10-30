/**
 * SR-02's Languages card: the automatic download switch, then a row per Language Integration
 * with its state, parts on disclosure and an on/off switch, on the host the picker names.
 */
import {
  cn,
  DisclosureChevron,
  SettingsCard,
  SettingsEmpty,
  SettingsSwitch,
  SettingsToggleRow,
  SettingsWell,
} from "@polaris/ui";
import { useState, type ReactNode } from "react";
import type { Fact, LanguageRow } from "./model.ts";

const Monogram = ({ text }: { readonly text: string }) => (
  <span
    aria-hidden
    className="bg-raised-control rounded-control text-text-default flex size-6 shrink-0 items-center justify-center font-mono text-[10px] leading-3 font-medium"
  >
    {text}
  </span>
);

const FactRow = ({ fact }: { readonly fact: Fact }) => (
  <div className="flex items-center gap-2">
    <dt className="text-caption text-text-subtle w-[120px] shrink-0">{fact.label}</dt>
    <dd className="flex min-w-0 items-center gap-2">
      <span className={cn("text-caption text-text-default", fact.mono && "font-mono")}>
        {fact.value}
      </span>
      {fact.note && <span className="text-caption text-text-subtle">{fact.note}</span>}
    </dd>
  </div>
);

const ROW = "px-panel flex flex-col gap-3 py-[calc(var(--spacing-gap)+4px)]";

/** Fixed lanes: tile, name and state, disclosure, switch; an empty switch slot keeps them aligned. */
export const IntegrationRow = ({
  row,
  enabled,
  onToggle,
  switchable,
}: {
  readonly row: LanguageRow;
  readonly enabled: boolean;
  readonly onToggle: (on: boolean) => void;
  readonly switchable: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const factsId = `language-facts-${row.id}`;

  return (
    <div className={ROW}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={factsId}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 cursor-default items-center gap-3 text-left"
        >
          <Monogram text={row.monogram} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-body text-text-default truncate">{row.name}</span>
            <span className="text-caption text-text-subtle truncate">{row.state}</span>
          </span>
          <DisclosureChevron open={open} size={12} className="text-text-subtle" />
        </button>
        <span className="flex w-[30px] shrink-0 justify-end">
          {switchable && (
            <SettingsSwitch
              aria-label={`${row.name} language tools`}
              checked={enabled}
              onCheckedChange={onToggle}
            />
          )}
        </span>
      </div>
      {open && (
        <dl id={factsId} className="flex flex-col gap-2 pl-9">
          {row.facts.length === 0 ? (
            <p className="text-caption text-text-subtle">No parts reported by this host yet.</p>
          ) : (
            row.facts.map((fact) => <FactRow key={fact.label + fact.value} fact={fact} />)
          )}
        </dl>
      )}
    </div>
  );
};

const MarkdownRow = () => (
  <div className={ROW}>
    <div className="flex items-center gap-3">
      <Monogram text="Md" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body text-text-default">Markdown</span>
        <span className="text-caption text-text-subtle truncate">
          Highlighting and preview · no language server needed
        </span>
      </span>
      <span className="w-[30px] shrink-0" />
    </div>
  </div>
);

/** "4 ready on Mac Studio", beside the title. */
export const readySummary = (rows: ReadonlyArray<LanguageRow>, host: string) =>
  `${rows.filter((row) => row.state.startsWith("Ready")).length} ready on ${host}`;

export interface LanguagesCardProps {
  readonly rows: ReadonlyArray<LanguageRow>;
  readonly enabled: (row: LanguageRow) => boolean;
  readonly onToggle: (row: LanguageRow, on: boolean) => void;
  /** The syntax-only languages, in the footer. */
  readonly footLine: string | null;
  /** Shown in place of the rows while the Host's facts load or can't be read. */
  readonly notice: string | null;
  /** "4 ready on Mac Studio"; null while there are no rows. */
  readonly summary: string | null;
  readonly picker: ReactNode;
  readonly download: {
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly onChange: (on: boolean) => void;
  };
  /** The Advanced… button. */
  readonly action: ReactNode;
}

export const LanguagesCard = ({
  rows,
  enabled,
  onToggle,
  footLine,
  notice,
  summary,
  picker,
  download,
  action,
}: LanguagesCardProps) => (
  <SettingsCard
    aria-label="Languages"
    title={
      <span className="flex items-baseline gap-2">
        Languages
        {summary === null ? null : (
          <span className="text-caption text-text-subtle font-normal">{summary}</span>
        )}
      </span>
    }
    aside={picker}
    status={notice === null ? (footLine ?? "") : ""}
    action={action}
  >
    <SettingsWell>
      <SettingsToggleRow
        title="Download language tools automatically"
        caption="Fetches a pinned server the first time you open a file; toolchains stay yours"
        checked={download.checked}
        disabled={download.disabled}
        onCheckedChange={download.onChange}
      />
    </SettingsWell>
    <SettingsWell>
      {notice !== null ? (
        <div role="status">
          <SettingsEmpty>{notice}</SettingsEmpty>
        </div>
      ) : (
        <>
          {rows.map((row) => (
            <IntegrationRow
              key={row.id}
              row={row}
              enabled={enabled(row)}
              switchable={row.syntaxIds.length > 0}
              onToggle={(on) => onToggle(row, on)}
            />
          ))}
          <MarkdownRow />
        </>
      )}
    </SettingsWell>
  </SettingsCard>
);
