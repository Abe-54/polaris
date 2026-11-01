/**
 * The connection bar's instrument card (Paper D3): label colour and text, then server, driver,
 * database, where it was found, agent access and writes. Label edits post `data.source.label`; a source
 * the user added can be edited or removed.
 */
import type { DataSource, DataSourceLabel } from "@polaris/protocol";
import { Button, Input, Kicker, PopoverContent } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { PendingDataApproval } from "../../approval/PendingDataApproval.tsx";
import { useDataApi } from "../../data/hooks.tsx";
import { openSourceForm } from "../../model/sidebar.ts";
import { accessLine, driverText, foundText, kickerText, statusText } from "../../model/source.ts";
import type { DataSessionKey } from "../../model/store.ts";
import { LabelSwatches } from "./LabelSwatches.tsx";
import { WritesChoice } from "./WritesChoice.tsx";

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
    {source.engine === "sqlite" ? (
      <Line label="File" value={source.path ?? ""} />
    ) : (
      <Line label="Server" value={`${source.host}:${source.port}`} />
    )}
    <Line label="Driver" value={driverText(source)} />
    {source.branch === undefined ? null : <Line label="Branch" value={source.branch.name} />}
    {source.engine === "sqlite" ? null : (
      <Line
        label="DB"
        value={source.user === undefined ? source.database : `${source.database} as ${source.user}`}
      />
    )}
    <Line label="From" value={foundText(source)} />
    <Line label="Agents" value={accessLine(source)} />
    <Line label="Status" value={statusText(source)} />
  </div>
);

const sameLabel = (a: DataSourceLabel, b: DataSourceLabel) =>
  a.text === b.text && a.colour === b.colour;

/**
 * The label as the user is editing it; posted on a swatch, Enter, blur or the card closing
 * (Escape included). A fresh snapshot replaces the draft only when the saved label's value moved.
 */
const useLabel = (at: DataSessionKey, source: DataSource) => {
  const api = useDataApi();
  const [draft, setDraft] = useState<DataSourceLabel>(source.label);
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const { text, colour } = source.label;

  useEffect(() => {
    dirty.current = false;
    setDraft({ text, colour });
  }, [text, colour]);

  const post = async (next: DataSourceLabel) => {
    const label = { ...next, text: next.text.toUpperCase() };

    dirty.current = false;
    setDraft(next);

    if (sameLabel(label, { text, colour })) return;
    const result = await api.labelSource(at, source.name, label);

    setError(result.ok ? null : result.error.message);
  };

  const edit = (next: DataSourceLabel) => {
    dirty.current = true;
    setDraft(next);
  };

  const flush = useRef<() => void>(() => undefined);

  useEffect(() => {
    flush.current = () => {
      if (dirty.current) void post(draft);
    };
  });
  useEffect(() => () => flush.current(), []);

  return { draft, edit, post, error };
};

/** A source the user added: Edit, and Remove confirmed in place (rule/destructive-names-object). */
const ManualActions = ({
  at,
  source,
  canEdit,
  onRemoved,
}: {
  readonly at: DataSessionKey;
  readonly source: DataSource;
  readonly canEdit: boolean;
  readonly onRemoved: () => void;
}) => {
  const api = useDataApi();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    const result = await api.removeSource(at, source.name);

    if (result.ok) onRemoved();
    else setError(result.error.message);
  };

  if (!confirming)
    return (
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          disabled={!canEdit}
          data-testid="data-source-remove"
          onClick={() => setConfirming(true)}
        >
          Remove…
        </Button>
        <Button
          variant="secondary"
          disabled={!canEdit}
          onClick={() => openSourceForm(at, { mode: "edit", source })}
        >
          Edit
        </Button>
      </div>
    );

  return (
    <div className="border-hairline bg-well flex flex-col gap-2 rounded-[12px] border px-3 py-2.5">
      <p className="text-caption text-text-default">
        Agents in this checkout can't query <span dir="auto">{source.name}</span> after this, and
        its saved password is deleted. You can add it again.
      </p>
      {source.privilegeWarnings?.length ? (
        <p role="status" className="text-caption text-text-default">
          This connection has {source.privilegeWarnings.join(", ")}. Use a SELECT-only database
          user.
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-caption text-failed-text">
          Couldn't remove it · {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" autoFocus onClick={() => setConfirming(false)}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={!canEdit}
          data-testid="data-source-remove-confirm"
          onClick={() => void remove()}
        >
          Remove data source
        </Button>
      </div>
    </div>
  );
};

export interface ConnectionCardProps {
  readonly at: DataSessionKey;
  readonly source: DataSource;
  /** False while the Host is Reconnecting or Offline. */
  readonly canEdit: boolean;
  /** The user removed the source: the card closes. */
  readonly onRemoved: () => void;
}

/** Inside the popover's content, so closing the card unmounts it and flushes the label draft. */
const CardBody = ({ at, source, canEdit, onRemoved }: ConnectionCardProps) => {
  const { draft, edit, post, error } = useLabel(at, source);
  const api = useDataApi();
  const [accessError, setAccessError] = useState<string | null>(null);

  const revoke = async () => {
    const result = await api.accessSource?.(at, source.name, true);
    setAccessError(
      result?.ok ? null : (result?.error.message ?? "Reconnect to manage agent access.")
    );
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Kicker className="flex-1">Label</Kicker>
        <LabelSwatches
          value={draft.colour}
          disabled={!canEdit}
          onChange={(colour) => void post({ ...draft, colour })}
        />
      </div>
      {/* Uppercase on screen only: rewriting the value would move the caret. */}
      <Input
        aria-label="Label"
        data-testid="data-label-field"
        disabled={!canEdit}
        className="bg-well h-[30px] font-mono uppercase"
        value={draft.text}
        placeholder={kickerText(source, "")}
        onChange={(e) => edit({ ...draft, text: e.target.value })}
        onBlur={() => void post(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void post(draft);
        }}
      />
      <Details source={source} />
      {source.privilegeWarnings?.length ? (
        <p role="status" className="text-caption text-text-default">
          This connection has {source.privilegeWarnings.join(", ")}. Use a SELECT-only database
          user.
        </p>
      ) : null}
      <PendingDataApproval hostKey={at.hostKey} source={source} />
      <WritesChoice at={at} source={source} canEdit={canEdit} />
      {error === null ? null : (
        <p role="alert" className="text-caption text-failed-text">
          Couldn't save the label · {error}
        </p>
      )}
      {api.accessSource ? (
        <div className="border-hairline flex flex-col gap-2 border-t pt-2">
          <p className="text-caption text-text-subtle">
            Revoke removes this target's approval and any server-wide approval for this user.
            {source.locality === "local"
              ? " Local access returns to its default: agents may read it."
              : " Agents will need approval to read it again."}
          </p>
          <Button variant="secondary" disabled={!canEdit} onClick={() => void revoke()}>
            Revoke agent approval
          </Button>
          {accessError ? (
            <p role="alert" className="text-caption text-failed-text">
              {accessError}
            </p>
          ) : null}
        </div>
      ) : null}
      {source.foundIn.kind === "manual" ? (
        <ManualActions at={at} source={source} canEdit={canEdit} onRemoved={onRemoved} />
      ) : null}
    </>
  );
};

export const ConnectionCard = (props: ConnectionCardProps) => (
  <PopoverContent
    align="start"
    data-testid="data-connection-card"
    className="bg-raised rounded-card border-hairline flex w-[440px] flex-col gap-3 border p-3.5"
  >
    <CardBody {...props} />
  </PopoverContent>
);
