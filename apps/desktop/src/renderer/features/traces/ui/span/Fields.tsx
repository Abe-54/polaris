/**
 * The Fields tab (Paper T1): "Filter fields", then `attributes`, `polaris`, `resource`, `scope`
 * and `span` as groups that fold, `attributes` and `polaris` open at first.
 */
import { DisclosureChevron, SearchIcon } from "@polaris/ui";
import { useState } from "react";
import { type FieldGroup, type FieldGroupName, filterFields } from "../../model/span/fields.ts";
import { FieldRow, Quiet, Value } from "./parts.tsx";

const OPEN_AT_FIRST: ReadonlySet<FieldGroupName> = new Set(["attributes", "polaris"]);

const Group = ({
  group,
  open,
  onToggle,
}: {
  readonly group: FieldGroup;
  readonly open: boolean;
  readonly onToggle: () => void;
}) => (
  <div data-testid={`span-group-${group.name}`}>
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="focus-visible:ring-starlight flex h-[26px] w-full cursor-default items-center gap-1.5 pl-3 outline-none focus-visible:ring-2 focus-visible:ring-inset"
    >
      <DisclosureChevron open={open} size={12} className="text-text-faint" />
      <span className="text-code-inline text-text-subtle font-mono">{group.name}</span>
      <span className="text-text-faint tabular font-mono text-[11px] leading-[14px]">
        {group.fields.length}
      </span>
    </button>
    {open
      ? group.fields.map((f) => (
          <FieldRow key={f.key} name={f.key}>
            <Value text={f.value} sql={f.sql === true} />
            {f.note === undefined ? null : (
              <span className="text-code-inline text-text-faint font-mono"> · {f.note}</span>
            )}
          </FieldRow>
        ))
      : null}
  </div>
);

export const Fields = ({ groups }: { readonly groups: ReadonlyArray<FieldGroup> }) => {
  const [query, setQuery] = useState("");
  const [toggled, setToggled] = useState<ReadonlySet<FieldGroupName>>(new Set());
  const shown = filterFields(groups, query);
  const filtering = query.trim() !== "";

  const toggle = (name: FieldGroupName) => {
    const next = new Set(toggled);

    if (!next.delete(name)) next.add(name);
    setToggled(next);
  };

  return (
    <>
      <label className="border-hairline bg-surface-sunken focus-within:ring-starlight mx-3 mt-2.5 mb-1.5 flex h-7 shrink-0 items-center gap-2 rounded-full border px-2.5 focus-within:ring-2">
        <SearchIcon size={12} className="text-text-faint shrink-0" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter fields"
          aria-label="Filter fields"
          spellCheck={false}
          className="text-caption text-text-default placeholder:text-text-faint min-w-0 flex-1 bg-transparent outline-none"
          data-testid="span-filter"
        />
      </label>
      <div className="flex flex-col pt-0.5 pb-3">
        {shown.length === 0 ? <Quiet>No fields match “{query.trim()}”</Quiet> : null}
        {shown.map((g) => (
          <Group
            key={g.name}
            group={g}
            // A filter opens every group it matched; otherwise a click flips the default.
            open={filtering || OPEN_AT_FIRST.has(g.name) !== toggled.has(g.name)}
            onToggle={() => toggle(g.name)}
          />
        ))}
      </div>
    </>
  );
};
