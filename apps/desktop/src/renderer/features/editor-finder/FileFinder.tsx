/**
 * ⌘P from anywhere (spec §5): a fuzzy file finder over `files.searchPaths` in the selected
 * Workspace (or the selected session's Worktree), on that Workspace's Host. Recent files
 * first while the query is empty; `name:42` opens at line 42. Picking opens in Edit.
 */
import {
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@polaris/ui";
import { useEffect, useState } from "react";
import { useCommands } from "../../shell/hooks.ts";
import { polaris } from "../bridge.ts";
import { spelledAs } from "../../routes/editor.ts";
import { useOpenInEditor } from "../editor-links/index.ts";
import { type Scope, useFinderScope } from "./scope.ts";
import {
  matchingRecent,
  parseQuery,
  relativeTo,
  RESULT_LIMIT,
  rowOf,
  type FinderRow,
} from "./model.ts";
import { closeFileFinder, openFileFinder, useFinder, useRecent } from "./store.ts";

type Search =
  | { readonly kind: "idle" }
  | { readonly kind: "ready"; readonly query: string; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "failed"; readonly message: string };

/** The latest query's hits; an answer to an older query is dropped. */
const useSearch = (scope: Scope, text: string): Search => {
  const [search, setSearch] = useState<Search>({ kind: "idle" });

  useEffect(() => {
    if (text === "") return undefined;
    let current = true;

    void polaris()
      .request("files.searchPaths", {
        hostKey: scope.hostKey,
        root: scope.root,
        query: text,
        limit: RESULT_LIMIT,
      })
      .then((result) => {
        if (!current) return;

        setSearch(
          result.ok
            ? { kind: "ready", query: text, paths: result.value.map((hit) => hit.path) }
            : { kind: "failed", message: result.error.message }
        );
      });

    return () => {
      current = false;
    };
  }, [scope.hostKey, scope.root, text]);

  return search;
};

const Row = ({ row, onPick }: { readonly row: FinderRow; readonly onPick: () => void }) => (
  <CommandItem
    value={row.path}
    data-testid="finder-item"
    detail={row.folder === "" ? undefined : row.folder}
    onSelect={onPick}
  >
    {row.name}
  </CommandItem>
);

const Results = ({
  scope,
  initialQuery,
}: {
  readonly scope: Scope;
  readonly initialQuery: string;
}) => {
  const [raw, setRaw] = useState(initialQuery);
  const query = parseQuery(raw);
  const search = useSearch(scope, query.text);
  const recent = useRecent(scope.hostKey, scope.workspaceId);
  const open = useOpenInEditor();

  const near = (path: string) => relativeTo(scope.root, spelledAs(scope.root, path));
  const recentRows = matchingRecent(recent.map(near), query.text).map(rowOf);

  const shownRecent = new Set(recentRows.map((r) => r.path));

  const hits =
    search.kind === "ready" && query.text !== ""
      ? search.paths.map((p) => rowOf(near(p))).filter((r) => !shownRecent.has(r.path))
      : [];

  const pick = (row: FinderRow) => {
    closeFileFinder();
    open({
      hostKey: scope.hostKey,
      root: scope.root,
      workspaceId: scope.workspaceId,
      path: row.path,
      line: query.line,
      column: query.column,
    });
  };

  return (
    <>
      <CommandInput
        value={raw}
        onValueChange={setRaw}
        placeholder={`Go to a file in ${scope.name}`}
        aria-label="Go to file"
        data-testid="finder-input"
      />
      <CommandList aria-label="Files">
        <CommandEmpty>
          {search.kind === "failed"
            ? search.message
            : query.text === ""
              ? "No recent files"
              : "No files match"}
        </CommandEmpty>
        {recentRows.length === 0 ? null : (
          <CommandGroup heading="Recent">
            {recentRows.map((row) => (
              <Row key={row.path} row={row} onPick={() => pick(row)} />
            ))}
          </CommandGroup>
        )}
        {hits.length === 0 ? null : (
          <CommandGroup heading="Files">
            {hits.map((row) => (
              <Row key={row.path} row={row} onPick={() => pick(row)} />
            ))}
          </CommandGroup>
        )}
      </CommandList>
      <CommandFooter>
        <span>↑↓ Move</span>
        <span>↵ Open</span>
        <span>name:42 Go to line</span>
        <span className="flex-1" />
        <span>esc</span>
      </CommandFooter>
    </>
  );
};

/** Mounted once by the shell; owns the `editor.findFile` command (⌘P). */
export const FileFinder = () => {
  const { open, initialQuery } = useFinder();
  const scope = useFinderScope();
  const commands = useCommands();

  useEffect(() => {
    return commands.register({
      "editor.findFile": { run: () => openFileFinder(), enabled: () => scope !== null },
    });
  }, [commands, scope]);

  if (!open || scope === null) return null;

  return (
    <CommandDialog
      open
      onOpenChange={(next) => {
        if (!next) closeFileFinder();
      }}
      shouldFilter={false}
      title="Go to file"
      description={`Go to a file in ${scope.name}`}
    >
      <Results scope={scope} initialQuery={initialQuery} />
    </CommandDialog>
  );
};
