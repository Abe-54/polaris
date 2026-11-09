/**
 * The request pane (DESIGN.md, Requests → Request pane; Paper Q1): the name, its file and line,
 * "Open in Edit ⌘3" and "Copy as curl"; tabs Params, Headers, Body and Auth with "traceparent
 * added on send"; the tab's editor; and the VARIABLES footer.
 */
import type { ResolvedVariable, WorkspaceId } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { commandShortcut } from "../../../../shared/keymap.ts";
import { useApp } from "../../../shell/hooks.ts";
import { useOpenInEditor } from "../../editor-links/index.ts";
import type { Loaded } from "../data/hooks.tsx";
import { bodyLanguage, type Draft, setsTraceparent } from "../model/draft.ts";
import type { RequestsSessionKey } from "../model/session.ts";
import { type RequestTab, setRequestTab } from "../model/store.ts";
import { queryParams, withQueryParams } from "../model/url.ts";
import { AuthTab } from "./pane/AuthTab.tsx";
import { BodyEditor } from "./pane/BodyEditor.tsx";
import { KeyValueRows } from "./pane/KeyValueRows.tsx";
import { Variables } from "./pane/Variables.tsx";
import type { OpenRequest } from "./useOpenRequest.ts";

const LINK =
  "text-caption text-text-subtle hover:text-text-default focus-visible:ring-starlight shrink-0 cursor-default rounded-control px-1 outline-none focus-visible:ring-2 disabled:opacity-(--opacity-dimmed)";

const useOpenInEdit = (at: RequestsSessionKey, workspaceId: string, draft: Draft) => {
  const open = useOpenInEditor();
  const cwd = useApp((s) => s.hostModels[at.hostKey]?.sessions.get(at.sessionId)?.session.cwd);

  return () =>
    open({
      hostKey: at.hostKey,
      path: draft.file,
      root: cwd ?? null,
      // SAFETY: the shown Workspace's id, as the shell selected it.
      workspaceId: workspaceId as WorkspaceId,
      line: draft.line,
    });
};

/** "Copied" for a moment after a copy lands, so the click is seen to have worked. */
const useCopied = (copy: () => Promise<boolean>) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);

    return () => clearTimeout(timer);
  }, [copied]);

  return { copied, copy: () => void copy().then(setCopied) };
};

const Header = ({
  at,
  workspaceId,
  open,
  onName,
  onCopyCurl,
}: {
  readonly at: RequestsSessionKey;
  readonly workspaceId: string;
  readonly open: OpenRequest;
  readonly onName: (name: string) => void;
  readonly onCopyCurl: () => Promise<boolean>;
}) => {
  const { draft, saved } = open;
  const openInEdit = useOpenInEdit(at, workspaceId, draft);
  const { copied, copy } = useCopied(onCopyCurl);
  const place = draft.line === null ? draft.file : `${draft.file}:${draft.line}`;

  return (
    <div className="px-panel gap-row-x flex items-center pt-3.5 pb-2.5">
      <input
        aria-label="Request name"
        data-testid="requests-name"
        value={draft.name}
        spellCheck={false}
        onChange={(event) => onName(event.target.value)}
        size={Math.max(4, draft.name.length)}
        className="text-heading-sm text-text-strong focus:bg-well focus:ring-starlight rounded-control -mx-1 min-w-0 bg-transparent px-1 font-medium outline-none focus:ring-1"
      />
      <span className="text-caption text-text-faint min-w-0 truncate font-mono" title={place}>
        {saved === undefined ? `${draft.file} · not saved` : place}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        className={LINK}
        disabled={saved === undefined}
        onClick={openInEdit}
        data-testid="requests-open-in-edit"
      >
        {`Open in Edit ${commandShortcut("view.edit")}`}
      </button>
      <button type="button" className={LINK} onClick={copy} data-testid="requests-copy-curl">
        {copied ? "Copied" : "Copy as curl"}
      </button>
    </div>
  );
};

const AUTH_NOTE = { Bearer: "bearer", Basic: "basic" } as const;

const tabNote = (tab: RequestTab, draft: Draft): string | null => {
  if (tab === "params") return String(queryParams(draft.url).length);

  if (tab === "headers") return String(draft.headers.length);

  if (tab === "body") return draft.body === "" ? null : bodyLanguage(draft);

  return draft.auth === null ? null : AUTH_NOTE[draft.auth._tag];
};

const TAB_LABEL = { params: "Params", headers: "Headers", body: "Body", auth: "Auth" } as const;

const TABS: ReadonlyArray<RequestTab> = ["params", "headers", "body", "auth"];

const Tabs = ({
  at,
  tab,
  draft,
}: {
  readonly at: RequestsSessionKey;
  readonly tab: RequestTab;
  readonly draft: Draft;
}) => (
  <div className="border-hairline px-panel flex h-[34px] shrink-0 items-center gap-[18px] border-b">
    <div role="tablist" aria-label="Request" className="flex h-full items-center gap-[18px]">
      {TABS.map((t) => {
        const selected = t === tab;
        const note = tabNote(t, draft);

        return (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={selected}
            data-testid={`requests-tab-${t}`}
            onClick={() => setRequestTab(at, t)}
            className={cn(
              "focus-visible:ring-starlight flex h-full cursor-default items-center gap-1.5 border-b outline-none focus-visible:ring-2",
              selected ? "border-text-strong" : "border-transparent"
            )}
          >
            <span
              className={cn(
                "text-body",
                selected ? "text-text-strong font-medium" : "text-text-subtle"
              )}
            >
              {TAB_LABEL[t]}
            </span>
            {note === null ? null : (
              <span
                className={cn(
                  "text-micro font-mono",
                  selected ? "text-text-subtle" : "text-text-faint"
                )}
              >
                {note}
              </span>
            )}
          </button>
        );
      })}
    </div>
    <span className="flex-1" />
    {setsTraceparent(draft.headers) ? null : (
      <span className="text-caption text-text-faint truncate" data-testid="requests-traceparent">
        traceparent added on send
      </span>
    )}
  </div>
);

const TabBody = ({
  tab,
  draft,
  edit,
}: {
  readonly tab: RequestTab;
  readonly draft: Draft;
  readonly edit: (change: Partial<Draft>) => void;
}) => {
  if (tab === "params")
    return (
      <KeyValueRows
        label="Parameter"
        rows={queryParams(draft.url)}
        onRows={(rows) => edit({ url: withQueryParams(draft.url, rows) })}
      />
    );

  if (tab === "headers")
    return (
      <KeyValueRows label="Header" rows={draft.headers} onRows={(headers) => edit({ headers })} />
    );

  if (tab === "auth") return <AuthTab auth={draft.auth} onAuth={(auth) => edit({ auth })} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col py-1">
      <BodyEditor
        text={draft.body}
        language={bodyLanguage(draft)}
        onChange={(body) => edit({ body })}
      />
    </div>
  );
};

export interface RequestPaneProps {
  readonly at: RequestsSessionKey;
  readonly workspaceId: string;
  readonly open: OpenRequest;
  readonly tab: RequestTab;
  readonly environment: string | null;
  readonly variables: Loaded<ReadonlyArray<ResolvedVariable>> | null;
  readonly edit: (change: Partial<Draft>) => void;
  readonly onCopyCurl: () => Promise<boolean>;
}

export const RequestPane = (props: RequestPaneProps) => {
  const { at, open, tab, edit } = props;

  return (
    <section
      aria-label={open.draft.name}
      className="border-hairline flex min-w-0 flex-1 flex-col border-r"
      data-testid="requests-pane"
    >
      <Header
        at={at}
        workspaceId={props.workspaceId}
        open={open}
        onName={(name) => edit({ name })}
        onCopyCurl={props.onCopyCurl}
      />
      <Tabs at={at} tab={tab} draft={open.draft} />
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <TabBody tab={tab} draft={open.draft} edit={edit} />
      </div>
      {props.variables === null ? null : (
        <Variables environment={props.environment} variables={props.variables} />
      )}
    </section>
  );
};
