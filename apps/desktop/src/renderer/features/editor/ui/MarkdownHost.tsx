import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ConnectionState } from "@polaris/protocol";
import { useApp } from "../../../shell/hooks.ts";
import { previewDocument } from "../runtime/markdown.ts";
import { setMarkdownLocked } from "../runtime/actions.ts";
import type { LanguageApi } from "../../../../shared/api.ts";
import type { PreviewDocument } from "../markdown/targets.ts";
import { polaris } from "../../bridge.ts";
import { useEditor } from "../runtime/store.ts";
import { fileKey, workspaceKey } from "../model/drafts.ts";
import { openFile } from "../runtime/actions.ts";
import { viewOf, whenLoaded } from "../runtime/buffers.ts";

const MarkdownPreview = lazy(() =>
  import("../markdown/index.tsx").then((m) => ({ default: m.MarkdownPreview }))
);

const observers = new WeakMap<EditorView, Compartment>();

/** Observe the existing CodeMirror document, including reloads and edits while detached. */
const useSource = (key: string) => {
  const [source, setSource] = useState(() => viewOf(key)?.state.sliceDoc() ?? "");
  useEffect(() => {
    const view = viewOf(key);

    if (view === null) return;
    const existing = observers.get(view);
    const watch = existing ?? new Compartment();
    observers.set(view, watch);
    let frame: number | null = null;

    const publish = () => {
      frame = null;
      setSource(view.state.sliceDoc());
    };

    publish();

    const listener = EditorView.updateListener.of((update) => {
      if (update.docChanged && frame === null) frame = requestAnimationFrame(publish);
    });

    view.dispatch({
      effects:
        existing === undefined
          ? StateEffect.appendConfig.of(watch.of(listener))
          : watch.reconfigure(listener),
    });

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);

      if (viewOf(key) === view) view.dispatch({ effects: watch.reconfigure([]) });
    };
  }, [key]);

  return source;
};

/** Navigation reuses the Editor's file authority and awaits unreadable-file outcomes. */
const openDocument = async (document: PreviewDocument, fragment: string) => {
  openFile({
    hostKey: document.hostKey,
    workspaceId: document.checkout.workspaceId,
    path: document.path,
  });
  await whenLoaded(fileKey(document.hostKey, document.path));
  const view = viewOf(fileKey(document.hostKey, document.path));

  if (view === null) throw new Error("File unavailable");

  if (fragment) {
    const { sourceHeadingLine } = await import("../markdown/sourceHeadings.ts");
    const line = sourceHeadingLine(view.state, fragment);

    if (line !== null) {
      const { revealLine } = await import("../runtime/buffers.ts");
      revealLine(view, line, 1);
    }
  }
};

export interface MarkdownHostProps {
  readonly bufferKey: string;
  readonly document: PreviewDocument;
  readonly hostLabel: string;
  readonly api?: LanguageApi | undefined;
}

export const MarkdownHost = ({ bufferKey, ...props }: MarkdownHostProps) => {
  const source = useSource(bufferKey);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      ref={host}
      className="focus-visible:outline-starlight min-h-0 flex-1 overflow-auto focus-visible:outline-2 focus-visible:-outline-offset-2"
      data-testid="editor-markdown-preview"
      aria-label="Rendered Markdown"
      tabIndex={0}
    >
      <Suspense
        fallback={
          <p className="text-text-subtle p-[var(--density-panel)]" role="status">
            Loading preview…
          </p>
        }
      >
        <MarkdownPreview
          {...props}
          source={source}
          openDocument={openDocument}
          openExternal={async (url) => {
            const result = await polaris().request("shell.openExternal", { url });

            if (!result.ok) throw new Error(result.error.message);
          }}
        />
      </Suspense>
    </div>
  );
};

export const useMarkdownDocument = (hostKey: string, workspaceId: string, path: string | null) => {
  const policyEpoch = useEditor((s) => s.previewEpochs[workspaceKey(hostKey, workspaceId)] ?? 0);
  const host = useApp((s) => s.hosts.find((h) => h.key === hostKey));
  const model = useApp((s) => s.hostModels[hostKey]);

  const document = useMemo(
    () =>
      path === null || model === undefined
        ? null
        : previewDocument(
            {
              hosts: host === undefined ? [] : [host],
              hostModels: { [hostKey]: model },
            },
            { hostKey, workspaceId, path }
          ),
    [host, model, hostKey, workspaceId, path]
  );

  const connectionState: ConnectionState = host?.status.state ?? "offline";

  return {
    document,
    epoch: `${host?.status.epoch ?? 0}:${policyEpoch}`,
    connectionState,
    hostLabel: host?.label ?? "this host",
  };
};

export const MarkdownBuffer = ({
  ready,
  document,
  epoch,
  connectionState,
  ...props
}: Omit<MarkdownHostProps, "document"> & {
  readonly ready: boolean;
  readonly document: PreviewDocument | null;
  readonly epoch: string;
  readonly connectionState: ConnectionState;
}) => {
  if (!ready) return null;

  if (document === null)
    return (
      <p role="status" className="text-text-subtle p-panel">
        Preview unavailable: the Host or checkout is no longer registered.
      </p>
    );

  return (
    <MarkdownHost
      key={JSON.stringify([
        document.hostKey,
        document.path,
        epoch,
        connectionState,
        document.checkout,
      ])}
      {...props}
      document={document}
      api={connectionState === "connected" ? polaris().languages : undefined}
    />
  );
};

const connectionStateLabel: Record<ConnectionState, string> = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
  "needs-attention": "Needs attention",
};

export const PreviewControls = ({
  visible,
  hostKey,
  workspaceId,
  path,
  hostLabel,
  connectionState,
  locked,
}: {
  readonly visible: boolean;
  readonly hostKey: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly hostLabel: string;
  readonly connectionState: ConnectionState;
  readonly locked: boolean;
}) =>
  visible ? (
    <div className="border-hairline gap-gap px-panel py-gap text-caption text-text-subtle flex items-center justify-between border-b">
      <span className="truncate" title={path}>
        Preview · {hostLabel}
        {connectionState === "connected" ? "" : ` · ${connectionStateLabel[connectionState]}`}
      </span>
      <button
        type="button"
        aria-pressed={locked}
        onClick={() => setMarkdownLocked(hostKey, workspaceId, !locked)}
        className="rounded-control text-text-default focus-visible:outline-starlight shrink-0 focus-visible:outline-2"
      >
        {locked ? "Unlock preview" : "Lock to document"}
      </button>
    </div>
  ) : null;
