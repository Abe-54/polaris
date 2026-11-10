/**
 * A file's header in the diff (Paper R1 1VT-0, R2 263-0): chevron, path, +/− counts, the
 * highest Severity badge and the Viewed checkbox; the first file of a Turn carries the
 * Turn's divider above it, and a reviewed Turn folds to the divider alone with a check.
 * Rendered by Pierre into each file's header slot; it reads its row from `headerStore`.
 */
import { CheckIcon, cn, DisclosureChevron, SeverityBadge, Tile } from "@polaris/ui";
import { memo } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { OpenInEditorButton } from "../../editor-links/index.ts";
import type { DividerRow } from "../model/layout.ts";
import type { MarkSeverity } from "../model/marks.ts";
import type { PatchFileStatus } from "../model/patch.ts";
import { ReviewFileMenu } from "./fileMenu.tsx";
import { IntentGlyph } from "./IntentGlyph.tsx";
import { isMigrationPath } from "../schema/model.ts";
import { openSchemaDiff, useSchemaLink } from "../schema/store.ts";

export interface HeaderModel {
  readonly path: string;
  readonly oldPath: string | null;
  readonly status: PatchFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly collapsed: boolean;
  readonly viewed: boolean;
  /** Viewed, then its diff changed (GitHub's `dismissed`). */
  readonly changed: boolean;
  readonly severity: MarkSeverity | null;
  readonly divider: DividerRow | null;
  /** "1 comment": what a collapsed file hides. */
  readonly note: string | null;
}

export interface HeaderActions {
  readonly toggle: (id: string) => void;
  readonly setViewed: (id: string, viewed: boolean) => void;
  readonly openSections: (sectionIds: ReadonlyArray<string>) => void;
}

/** Header models by item id, written by the DiffPane; each header subscribes to its own. */
export const headerStore = createStore<{
  readonly rows: Readonly<Record<string, HeaderModel>>;
  readonly actions: HeaderActions | null;
}>(() => ({ rows: {}, actions: null }));

const Viewed = ({ id, viewed }: { readonly id: string; readonly viewed: boolean }) => {
  const actions = useStore(headerStore, (s) => s.actions);

  return (
    <label
      className="text-caption text-text-subtle hover:text-text-default flex cursor-default items-center gap-1.5"
      onClick={(event) => event.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={viewed}
        data-testid="review-viewed"
        onChange={(event) => actions?.setViewed(id, event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-[4px] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-(--color-starlight)",
          viewed ? "bg-text-subtle text-bg" : "border-text-faint border"
        )}
      >
        {viewed && <CheckIcon size={10} strokeWidth={2.5} />}
      </span>
      Viewed
    </label>
  );
};

const STATUS_WORDS = {
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  "mode-changed": "mode changed",
  modified: null,
} satisfies Record<PatchFileStatus, string | null>;

/** A Turn quotes its prompt; an Intent Group's "why" is the Walkthrough's own words. */
const quoteOf = (divider: DividerRow) => {
  if (divider.quote === null) return "";

  return divider.intent === undefined ? `“${divider.quote}”` : divider.quote;
};

const Divider = ({ divider }: { readonly divider: DividerRow }) => {
  const actions = useStore(headerStore, (s) => s.actions);

  return (
    <button
      type="button"
      data-testid="turn-divider"
      data-folded={divider.folded ? "" : undefined}
      disabled={!divider.folded}
      onClick={() => actions?.openSections(divider.sectionIds)}
      className="text-caption gap-row-x h-tree-row flex w-full cursor-default items-center text-left"
    >
      {divider.intent === undefined ? (
        <Tile hue={divider.harness} size={18} />
      ) : (
        <span className="flex size-[18px] shrink-0 items-center justify-center">
          <IntentGlyph category={divider.intent.category} />
        </span>
      )}
      <span className="text-text-default font-medium">{divider.label}</span>
      {divider.intent?.critical === true && <SeverityBadge severity="critical" />}
      <span className="text-text-subtle min-w-0 flex-1 truncate">{quoteOf(divider)}</span>
      <span className="text-text-subtle shrink-0">{divider.caption}</span>
      {divider.folded && divider.reviewed && (
        <CheckIcon size={14} className="text-diff-added-text shrink-0" />
      )}
    </button>
  );
};

/** A migration's link to the Schema Diff it caused (DESIGN.md, Data → In Review). */
const SchemaLink = ({ path }: { readonly path: string }) => {
  const link = useSchemaLink();

  if (link === null || !isMigrationPath(path)) return null;

  return (
    <button
      type="button"
      data-testid="review-schema-link"
      onClick={(event) => {
        event.stopPropagation();
        openSchemaDiff(link.subjectKey, link.sourceId);
      }}
      className="text-caption text-text-subtle hover:text-text-default shrink-0 cursor-default"
    >
      Schema diff
    </button>
  );
};

const Header = ({ id }: { readonly id: string }) => {
  const row = useStore(headerStore, (s) => s.rows[id]);
  const actions = useStore(headerStore, (s) => s.actions);

  if (row === undefined) return null;

  if (row.divider?.folded === true) return <Divider divider={row.divider} />;

  const status = STATUS_WORDS[row.status];

  return (
    <div className="flex flex-col">
      {row.divider !== null && <Divider divider={row.divider} />}
      <ReviewFileMenu
        path={row.path}
        deleted={row.status === "deleted"}
        viewed={row.viewed}
        onViewed={(viewed) => actions?.setViewed(id, viewed)}
        fold={{ collapsed: row.collapsed, toggle: () => actions?.toggle(id) }}
      >
        <div
          data-testid="review-file"
          data-path={row.path}
          data-collapsed={row.collapsed ? "" : undefined}
          onClick={() => actions?.toggle(id)}
          className={cn(
            "border-hairline bg-surface-raised group/header flex h-10 cursor-default items-center gap-row-x border px-3",
            row.collapsed ? "rounded-row" : "rounded-t-row border-b-hairline"
          )}
        >
          <DisclosureChevron
            open={!row.collapsed}
            size={12}
            className={row.collapsed ? "text-text-faint" : "text-text-subtle"}
          />
          <span className="text-caption text-text-default min-w-0 truncate font-mono">
            {row.oldPath === null ? row.path : `${row.oldPath} → ${row.path}`}
          </span>
          {row.additions > 0 && (
            <span className="text-caption text-diff-added-text shrink-0 font-mono">
              +{row.additions}
            </span>
          )}
          {row.deletions > 0 && (
            <span className="text-caption text-diff-removed-text shrink-0 font-mono">
              −{row.deletions}
            </span>
          )}
          {(status !== null || row.binary) && (
            <span className="text-caption text-text-subtle shrink-0">
              {row.binary ? "binary" : status}
            </span>
          )}
          <span className="flex-1" />
          <SchemaLink path={row.path} />
          {row.note !== null && (
            <span className="text-caption text-text-subtle shrink-0">{row.note}</span>
          )}
          {row.changed && (
            <span className="text-caption text-text-subtle shrink-0" data-testid="review-changed">
              Changed since viewed
            </span>
          )}
          {row.severity !== null && <SeverityBadge severity={row.severity} />}
          {row.status !== "deleted" && (
            <OpenInEditorButton
              path={row.path}
              className="opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
            />
          )}
          <span aria-hidden="true" className="bg-hairline h-4 w-px shrink-0" />
          <Viewed id={id} viewed={row.viewed} />
        </div>
      </ReviewFileMenu>
    </div>
  );
};

/**
 * Pierre re-renders every mounted header (with `flushSync`) whenever a file mounts while
 * scrolling; memoised by id, only the new one renders.
 */
export const FileHeader = memo(Header);
