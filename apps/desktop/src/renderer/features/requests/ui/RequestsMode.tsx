/**
 * Requests (⌘6; DESIGN.md, Requests; ADR 0098): Traces' shell with no assistant panel. The
 * Workspace bar, the sidebar on the ground over the horizon, and one panel holding the URL bar,
 * the request pane with the send pane beside it, and the status bar. A curl command pasted
 * outside a field opens as a new Request.
 */
import type { SessionId } from "@polaris/protocol";
import { EmptyState, Horizon, PixelAlertIcon, PixelHourglassIcon } from "@polaris/ui";
import { type ClipboardEvent, useMemo, useState } from "react";
import { TopBar } from "../../../shell/TopBar.tsx";
import { useSelection } from "../../../shell/hooks.ts";
import { useRequestsSnapshot, useVariables } from "../data/hooks.tsx";
import { useRequestsUnavailable } from "../model/availability.ts";
import { type Draft, NEW_REQUEST_FILE } from "../model/draft.ts";
import type { RequestsSessionKey } from "../model/session.ts";
import { openNewDraft, setEnvironment } from "../model/store.ts";
import { CurlDialog } from "./CurlDialog.tsx";
import { RequestPane } from "./RequestPane.tsx";
import { SendPane } from "./SendPane.tsx";
import { RequestsSidebar } from "./Sidebar.tsx";
import type { RequestsSlotProps } from "./slots.ts";
import { RequestsStatusBar } from "./StatusBar.tsx";
import { UrlBar } from "./UrlBar.tsx";
import { isCurl, useRequestActions, useRequestCommands } from "./useRequestActions.tsx";
import { useOpenRequest } from "./useOpenRequest.ts";

const Centered = ({
  testId,
  icon,
  title,
  fact,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  fact: string;
}) => (
  <div className="grid flex-1 place-items-center" data-testid={testId}>
    <EmptyState icon={icon} title={title} fact={fact} />
  </div>
);

/** Fields take their own paste; elsewhere a curl command opens as a Request. */
const typingIn = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target.closest("input, textarea, [contenteditable]") !== null);

/** The names in the new-request file, so an import never takes one. */
const takenNames = (saved: ReadonlyMap<string, { readonly file: string; readonly name: string }>) =>
  new Set([...saved.values()].flatMap((r) => (r.file === NEW_REQUEST_FILE ? [r.name] : [])));

const BLANK = (taken: ReadonlySet<string>): Draft => {
  let name = "New request";

  for (let n = 2; taken.has(name); n++) name = `New request ${n}`;

  return {
    file: NEW_REQUEST_FILE,
    name,
    method: "GET",
    url: "{{base}}/",
    headers: [],
    body: "",
    auth: null,
    line: null,
  };
};

const Workbench = (slot: RequestsSlotProps) => {
  const { at } = slot;
  const snapshot = useRequestsSnapshot(at);
  const ready = snapshot.status === "ready" ? snapshot.value : null;
  const shown = useOpenRequest(at, ready);
  const { open, environment, view } = shown;
  const taken = useMemo(() => takenNames(shown.saved), [shown.saved]);
  const actions = useRequestActions(at, open, environment, taken);
  const [curlOpen, setCurlOpen] = useState(false);
  const input = actions.target === null ? null : { target: actions.target, environment };
  const variables = useVariables(at, input);

  useRequestCommands(actions);

  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData.getData("text/plain");

    if (typingIn(event.target) || !isCurl(text)) return;
    event.preventDefault();
    void actions.importCurl(text);
  };

  return (
    <div
      className="flex min-h-0 flex-1 gap-1.5 pr-1.5 pb-1.5"
      data-testid="requests-mode"
      onPaste={onPaste}
    >
      <div className="relative isolate flex min-h-0 shrink-0 flex-col">
        <RequestsSidebar
          {...slot}
          snapshot={snapshot}
          openKey={open?.key ?? null}
          unsaved={shown.unsaved}
          onOpen={shown.select}
          onNew={() => openNewDraft(at, BLANK(taken))}
          onPasteCurl={() => setCurlOpen(true)}
        />
        <Horizon moon={false} />
      </div>
      <section className="border-hairline bg-panel shadow-panel flex min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border">
        {open === null ? (
          <Centered
            testId="requests-none-open"
            icon={<PixelHourglassIcon size={24} className="text-text-strong" />}
            title={snapshot.status === "loading" ? "Reading requests" : "No request open"}
            fact="Pick a request, start one with +, or paste a curl command"
          />
        ) : (
          <>
            <UrlBar
              method={open.draft.method}
              url={open.draft.url}
              environment={environment}
              environments={shown.environments}
              sending={view.sending}
              onMethod={(method) => shown.edit({ method })}
              onUrl={(url) => shown.edit({ url })}
              onEnvironment={(env) => setEnvironment(at, env)}
              onSend={() => void actions.send()}
              onCurl={(text) => void actions.importCurl(text)}
            />
            <div className="flex min-h-0 flex-1">
              <RequestPane
                at={at}
                workspaceId={slot.workspaceId}
                open={open}
                tab={view.tab}
                environment={environment}
                variables={variables}
                edit={shown.edit}
                onCopyCurl={actions.copyCurl}
              />
              <SendPane {...slot} latest={view.latest} sending={view.sending} />
            </div>
          </>
        )}
        <RequestsStatusBar {...slot} />
      </section>
      <CurlDialog
        open={curlOpen}
        onOpenChange={setCurlOpen}
        onImport={(text) => void actions.importCurl(text)}
      />
    </div>
  );
};

const Shown = ({ at, workspaceId }: { at: RequestsSessionKey; workspaceId: string }) => {
  const unavailable = useRequestsUnavailable(at.hostKey);

  if (unavailable !== null)
    return (
      <Centered
        testId="requests-unsupported"
        icon={<PixelAlertIcon size={24} className="text-text-strong" />}
        title={unavailable}
        fact="Update the daemon in Settings → Hosts to send requests from this checkout"
      />
    );

  return <Workbench at={at} hostKey={at.hostKey} workspaceId={workspaceId} />;
};

export const RequestsMode = () => {
  const { hostKey, workspaceId, sessionId } = useSelection();

  return (
    <>
      <TopBar />
      <main className="flex min-h-0 flex-1 flex-col">
        {hostKey === null || workspaceId === null || sessionId === null ? (
          <Centered
            testId="requests-no-session"
            icon={<PixelHourglassIcon size={24} className="text-text-strong" />}
            title="No agent session to send requests from"
            fact="Requests sends from the selected agent session's checkout"
          />
        ) : (
          <Shown
            key={`${hostKey}\u0000${sessionId}`}
            at={{ hostKey, sessionId: sessionId satisfies SessionId }}
            workspaceId={workspaceId}
          />
        )}
      </main>
    </>
  );
};
