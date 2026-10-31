/**
 * The connection bar's instrument card (Paper D3): label colour and text, then server, driver,
 * database, where it was found and agent access. Label edits post `data.source.label`.
 */
import type { DataSource, DataSourceLabel } from "@polaris/protocol";
import { Button, Input, Kicker, PopoverContent } from "@polaris/ui";
import { useEffect, useState } from "react";
import { PendingDataApproval } from "../../approval/PendingDataApproval.tsx";
import { useDataApi } from "../../data/hooks.tsx";
import { openSourceForm } from "../../model/sidebar.ts";
import { accessLine, driverText, foundText, kickerText, statusText } from "../../model/source.ts";
import type { DataSessionKey } from "../../model/store.ts";
import { LabelSwatches } from "./LabelSwatches.tsx";

const Line = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="text-caption flex min-w-0 gap-3 font-mono">
    <span className="text-text-faint w-[7ch] shrink-0 uppercase">{label}</span>
    <span className="text-text-default min-w-0 truncate" title={value}>
      {value}
    </span>
  </div>
);

const Details = ({ source }: { readonly source: DataSource }) => (
  <div
    className="border-hairline bg-well flex flex-col gap-1.5 rounded-[12px] border px-3 py-2.5"
    data-testid="data-connection-details"
  >
    <Line label="Server" value={`${source.host}:${source.port}`} />
    <Line label="Driver" value={driverText(source)} />
    {source.branch === undefined ? null : <Line label="Branch" value={source.branch.name} />}
    <Line
      label="DB"
      value={source.user === undefined ? source.database : `${source.database} as ${source.user}`}
    />
    <Line label="From" value={foundText(source)} />
    <Line label="Agents" value={accessLine(source)} />
    <Line label="Status" value={statusText(source)} />
  </div>
);

/** The label as the user is editing it; posted on a swatch, Enter or leaving the field. */
const useLabel = (at: DataSessionKey, source: DataSource) => {
  const api = useDataApi();
  const [label, setLabel] = useState<DataSourceLabel>(source.label);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setLabel(source.label), [source.label]);

  const post = async (next: DataSourceLabel) => {
    setLabel(next);

    if (next.text === source.label.text && next.colour === source.label.colour) return;
    const result = await api.labelSource(at, source.name, next);

    setError(result.ok ? null : result.error.message);
  };

  return { label, setLabel, post, error };
};

export const ConnectionCard = ({
  at,
  source,
  canEdit,
}: {
  readonly at: DataSessionKey;
  readonly source: DataSource;
  /** False while the Host is Reconnecting or Offline. */
  readonly canEdit: boolean;
}) => {
  const { label, setLabel, post, error } = useLabel(at, source);
  const manual = source.foundIn.kind === "manual";

  return (
    <PopoverContent
      align="start"
      data-testid="data-connection-card"
      className="bg-raised rounded-card border-hairline flex w-[440px] flex-col gap-3 border p-3.5"
    >
      <div className="flex items-center gap-2">
        <Kicker className="flex-1">Label</Kicker>
        <LabelSwatches
          value={label.colour}
          disabled={!canEdit}
          onChange={(colour) => void post({ ...label, colour })}
        />
      </div>
      <Input
        aria-label="Label"
        data-testid="data-label-field"
        disabled={!canEdit}
        className="bg-well h-[30px] font-mono uppercase"
        value={label.text}
        placeholder={kickerText(source, "")}
        onChange={(e) => setLabel({ ...label, text: e.target.value.toUpperCase() })}
        onBlur={() => void post(label)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void post(label);
        }}
      />
      <Details source={source} />
      {source.access === "needs-approval" ? (
        <PendingDataApproval hostKey={at.hostKey} sourceId={source.id} />
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-caption text-failed-text">
          Couldn't save the label · {error}
        </p>
      )}
      {manual ? (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            disabled={!canEdit}
            onClick={() => openSourceForm({ mode: "edit", source })}
          >
            Edit
          </Button>
        </div>
      ) : null}
    </PopoverContent>
  );
};
