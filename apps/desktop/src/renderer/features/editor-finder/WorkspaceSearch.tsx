/**
 * ⌘⇧F, find in the Workspace (spec §1): text search over `files.grep` in the same place ⌘P
 * searches, matches grouped by file with the match lit, Match case and Regex toggles (⌥C, ⌥R),
 * and ↵ opening the match in the editor at its line and column.
 */
import {
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  cn,
} from "@polaris/ui";
import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { spelledAs } from "../../routes/editor.ts";
import { useCommands } from "../../shell/hooks.ts";
import { polaris } from "../bridge.ts";
import { useOpenInEditor } from "../editor-links/index.ts";
import { relativeTo } from "./model.ts";
import { type Scope, useFinderScope } from "./scope.ts";
import {
  type FileMatches,
  groupHits,
  type MatchRow,
  resultsLabel,
  ROW_CHARS,
  type SearchOptions,
} from "./searchModel.ts";
import { shortcutLabel } from "../../../shared/chord.ts";
import { FIELD_CHORDS } from "../../../shared/keymap.ts";

const LIMIT = 300;

/** Long enough that typing doesn't grep every keystroke; short enough to feel live. */
const SETTLE_MS = 150;

const searchStore = createStore<{ readonly open: boolean; readonly initial: string }>(() => ({
  open: false,
  initial: "",
}));

/** Opens ⌘⇧F, optionally searching for `initial` (the preview's scene). */
export const openWorkspaceSearch = (initial = "") => searchStore.setState({ open: true, initial });

const close = () => searchStore.setState({ open: false, initial: "" });

type Results =
  | { readonly kind: "idle" }
  | {
      readonly kind: "ready";
      readonly files: ReadonlyArray<FileMatches>;
      readonly limited: boolean;
    }
  | { readonly kind: "failed"; readonly message: string };

const useGrep = (scope: Scope, options: SearchOptions): Results => {
  const [results, setResults] = useState<Results>({ kind: "idle" });
  const { pattern, regex, caseSensitive } = options;

  useEffect(() => {
    if (pattern.trim() === "") return undefined;
    let current = true;

    const timer = setTimeout(() => {
      void polaris()
        .request("files.grep", {
          hostKey: scope.hostKey,
          root: scope.root,
          pattern,
          regex,
          caseSensitive,
          limit: LIMIT,
        })
        .then((result) => {
          if (!current) return;

          if (!result.ok) {
            setResults({ kind: "failed", message: result.error.message });

            return;
          }

          const relative = (path: string) => relativeTo(scope.root, spelledAs(scope.root, path));

          setResults({
            kind: "ready",
            files: groupHits(result.value, { pattern, regex, caseSensitive }, relative),
            limited: result.value.length >= LIMIT,
          });
        });
    }, SETTLE_MS);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [scope.hostKey, scope.root, pattern, regex, caseSensitive]);

  return pattern.trim() === "" ? { kind: "idle" } : results;
};

/** The line around its match, the match lit (Starlight is never used for this; text-strong is). */
const Snippet = ({ row }: { readonly row: MatchRow }) => {
  const { text, match } = row;

  if (match === null) return <span className="truncate">{text.trim().slice(0, ROW_CHARS)}</span>;
  const start = Math.max(0, match.from - 40);
  const lead = text.slice(start, match.from).trimStart();

  return (
    <span className="truncate whitespace-pre">
      {start > 0 ? "…" : ""}
      {lead}
      <mark className="bg-fill-selected text-text-strong rounded-[3px]">
        {text.slice(match.from, match.to)}
      </mark>
      {text.slice(match.to, match.to + ROW_CHARS)}
    </span>
  );
};

const Toggle = ({
  on,
  label,
  onToggle,
  children,
}: {
  readonly on: boolean;
  readonly label: string;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) => (
  <button
    type="button"
    aria-pressed={on}
    aria-label={label}
    title={label}
    onClick={onToggle}
    className={cn(
      "rounded-control h-6 min-w-6 cursor-default px-1.5 font-mono text-[12px]",
      on ? "bg-fill-selected text-text-strong" : "text-text-subtle hover:bg-fill-hover"
    )}
  >
    {children}
  </button>
);

const Results = ({ scope, initial }: { readonly scope: Scope; readonly initial: string }) => {
  const [pattern, setPattern] = useState(initial);
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const results = useGrep(scope, { pattern, regex, caseSensitive });
  const open = useOpenInEditor();

  const pick = (path: string, row: MatchRow) => {
    close();
    open({
      hostKey: scope.hostKey,
      root: scope.root,
      workspaceId: scope.workspaceId,
      path,
      line: row.line,
      column: row.column,
    });
  };

  // ⌥C and ⌥R toggle Match case and Regex without leaving the field.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.altKey) return;

    if (event.code === "KeyC") setCaseSensitive((v) => !v);
    else if (event.code === "KeyR") setRegex((v) => !v);
    else return;
    event.preventDefault();
  };

  const files = results.kind === "ready" ? results.files : [];

  return (
    <div onKeyDownCapture={onKeyDown} className="contents">
      <CommandInput
        value={pattern}
        onValueChange={setPattern}
        placeholder={`Find in ${scope.name}`}
        aria-label="Find in workspace"
        data-testid="search-input"
        hint={
          <span className="flex items-center gap-1">
            <Toggle
              on={caseSensitive}
              label={`Match case (${shortcutLabel(FIELD_CHORDS.matchCase)})`}
              onToggle={() => setCaseSensitive((v) => !v)}
            >
              Aa
            </Toggle>
            <Toggle
              on={regex}
              label={`Regex (${shortcutLabel(FIELD_CHORDS.regex)})`}
              onToggle={() => setRegex((v) => !v)}
            >
              .*
            </Toggle>
          </span>
        }
      />
      <CommandList aria-label="Matches">
        <CommandEmpty>
          {results.kind === "failed"
            ? results.message
            : pattern.trim() === ""
              ? `Text in ${scope.name}`
              : "No matches"}
        </CommandEmpty>
        {files.map((file) => (
          <CommandGroup key={file.path} heading={file.path}>
            {file.rows.map((row) => (
              <CommandItem
                key={`${file.path}:${row.line}`}
                value={`${file.path}:${row.line}`}
                data-testid="search-match"
                leading={
                  <span className="text-text-subtle tabular w-8 shrink-0 text-right font-mono text-[12px]">
                    {row.line}
                  </span>
                }
                onSelect={() => pick(file.path, row)}
              >
                <span className="text-code-inline font-mono">
                  <Snippet row={row} />
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <CommandFooter>
        <span>↑↓ Move</span>
        <span>↵ Open</span>
        <span className="flex-1" />
        {results.kind === "ready" ? (
          <span data-testid="search-count">{resultsLabel(results.files, results.limited)}</span>
        ) : null}
        <span>esc</span>
      </CommandFooter>
    </div>
  );
};

/** Mounted once by the shell; owns `editor.findInWorkspace` (⌘⇧F). */
export const WorkspaceSearch = () => {
  const { open, initial } = useStore(searchStore, (s) => s);
  const scope = useFinderScope();
  const commands = useCommands();

  useEffect(() => {
    return commands.register({
      "editor.findInWorkspace": {
        run: () => openWorkspaceSearch(),
        enabled: () => scope !== null,
      },
    });
  }, [commands, scope]);

  if (!open || scope === null) return null;

  return (
    <CommandDialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
      shouldFilter={false}
      title="Find in workspace"
      description={`Find text in ${scope.name}`}
    >
      <Results scope={scope} initial={initial} />
    </CommandDialog>
  );
};
