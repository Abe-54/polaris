/**
 * The open Request as the view shows it: the file's version, the user's draft over it, whether
 * they differ, and the environment it sends in. The first Request opens when none is.
 */
import type { HttpRequest, RequestsSnapshot } from "@polaris/protocol";
import { useEffect, useMemo } from "react";
import { type Draft, draftOf, isDirty, refString } from "../model/draft.ts";
import type { RequestsSessionKey } from "../model/session.ts";
import { fileGroups } from "../model/sidebar.ts";
import { dropDraft, openRequest, setDraft, useRequestsView } from "../model/store.ts";

export interface OpenRequest {
  readonly key: string;
  /** The file's version; undefined for a Request not saved yet. */
  readonly saved: HttpRequest | undefined;
  readonly draft: Draft;
  readonly dirty: boolean;
}

/** Every saved Request by key, in the sidebar's order, so the first opened is the first listed. */
export const savedRequests = (snapshot: RequestsSnapshot | null) => {
  const byKey = new Map<string, HttpRequest>();

  for (const file of fileGroups(snapshot?.files ?? [], ""))
    for (const request of file.requests) byKey.set(refString(request), request);

  return byKey;
};

export const useOpenRequest = (at: RequestsSessionKey, snapshot: RequestsSnapshot | null) => {
  const view = useRequestsView(at);
  const saved = useMemo(() => savedRequests(snapshot), [snapshot]);
  const first = saved.keys().next().value ?? null;
  const key = view.open ?? first;
  const file = key === null ? undefined : saved.get(key);
  const draft = key === null ? undefined : (view.drafts[key] ?? (file && draftOf(file)));
  const { hostKey, sessionId } = at;

  // A draft the file has caught up with (just saved, or edited back) is dropped.
  useEffect(() => {
    for (const [k, d] of Object.entries(view.drafts)) {
      const s = saved.get(k);

      if (s !== undefined && !isDirty(d, s)) dropDraft({ hostKey, sessionId }, k);
    }
  }, [view.drafts, saved, hostKey, sessionId]);

  const environments = snapshot?.environments ?? [];

  const environment =
    view.environment !== null && environments.includes(view.environment)
      ? view.environment
      : (environments[0] ?? null);

  const open: OpenRequest | null =
    key === null || draft === undefined
      ? null
      : { key, saved: file, draft, dirty: isDirty(draft, file) };

  return {
    open,
    environment,
    environments,
    view,
    saved,
    edit: (change: Partial<Draft>) => {
      if (open !== null) setDraft(at, open.key, { ...open.draft, ...change });
    },
    select: (request: HttpRequest) => openRequest(at, refString(request)),
    unsaved: (request: HttpRequest) => {
      const d = view.drafts[refString(request)];

      return d !== undefined && isDirty(d, request);
    },
  };
};
