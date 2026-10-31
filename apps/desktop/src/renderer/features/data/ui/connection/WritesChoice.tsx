/**
 * The connection card's Writes row (`data.source.access`'s `writes`): Allowed lets agents ask to
 * write and the user's grid edits commit; Off refuses both on a Remote Data Source.
 */
import type { DataSource } from "@polaris/protocol";
import { Kicker, SegmentedControl } from "@polaris/ui";
import { useState } from "react";
import { useDataApi } from "../../data/hooks.tsx";
import type { DataSessionKey } from "../../model/store.ts";

const OPTIONS = [
  { value: "ask", label: "Allowed" },
  { value: "off", label: "Off" },
] as const;

const caption = (source: DataSource) => {
  if (source.writes === "ask") return "Agents' writes ask you each time; your grid edits commit.";

  return source.locality === "remote"
    ? "Agents can't write, and the grid is read-only."
    : "Agents can't write.";
};

export const WritesChoice = (props: {
  readonly at: DataSessionKey;
  readonly source: DataSource;
  readonly canEdit: boolean;
}) => {
  const { at, source, canEdit } = props;
  const api = useDataApi();
  const [error, setError] = useState<string | null>(null);
  const setWrites = api.setWrites;

  if (setWrites === undefined) return null;

  const choose = async (writes: DataSource["writes"]) => {
    const result = await setWrites(at, source.name, writes);

    setError(result.ok ? null : result.error.message);
  };

  return (
    <div className="flex flex-col gap-1.5" data-testid="data-writes">
      <div className="flex items-center gap-2">
        <Kicker className="flex-1">Writes</Kicker>
        <SegmentedControl<DataSource["writes"]>
          aria-label="Writes"
          variant="well"
          options={OPTIONS.map((o) => ({ ...o, disabled: !canEdit }))}
          value={source.writes}
          onValueChange={(writes) => void choose(writes)}
        />
      </div>
      <p className="text-caption text-text-subtle">{caption(source)}</p>
      {error === null ? null : (
        <p role="alert" className="text-caption text-failed-text">
          Couldn't change writes · {error}
        </p>
      )}
    </div>
  );
};
