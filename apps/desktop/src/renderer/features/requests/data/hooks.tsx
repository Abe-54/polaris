/**
 * The hooks Requests' views read through, over whichever `RequestsApi` the nearest
 * `RequestsLayer` provides: the live IPC one by default, fixtures in previews and tests.
 */
import type { RequestsSnapshot, ResolvedVariable } from "@polaris/protocol";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import type { IpcError } from "../../../../shared/api.ts";
import { useApp } from "../../../shell/hooks.ts";
import type { RequestsSessionKey } from "../model/session.ts";
import { liveRequestsApi, type RequestsApi, type SendInput } from "./api.ts";

const ApiContext = createContext<RequestsApi>(liveRequestsApi);

export const RequestsLayer = ({ api, children }: { api: RequestsApi; children: ReactNode }) => (
  <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
);

export const useRequestsApi = () => useContext(ApiContext);

export type Loaded<A> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: A }
  | { readonly status: "failed"; readonly error: IpcError };

const LOADING = { status: "loading" } as const;

const useHostConnection = (hostKey: string) => {
  const epoch = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.status.epoch ?? 0);

  const connected = useApp(
    (s) => s.hosts.find((h) => h.key === hostKey)?.status.state === "connected"
  );

  return { epoch, connected };
};

/**
 * The checkout's Requests and environments, live. The watch ends with the connection and opens
 * again on each new epoch; one that fails while the Host is away keeps the last snapshot.
 */
export const useRequestsSnapshot = (at: RequestsSessionKey): Loaded<RequestsSnapshot> => {
  const api = useRequestsApi();
  const { epoch, connected } = useHostConnection(at.hostKey);
  const [state, setState] = useState<Loaded<RequestsSnapshot>>(LOADING);
  const away = useRef(!connected);
  const { hostKey, sessionId } = at;

  away.current = !connected;

  useEffect(() => {
    return api.watch(
      { hostKey, sessionId },
      {
        next: (value) => setState({ status: "ready", value }),
        end: (error) => {
          if (error !== null && !away.current) setState({ status: "failed", error });
        },
      }
    );
  }, [api, hostKey, sessionId, epoch]);

  return state;
};

/** Long enough that typing in the URL doesn't ask the Daemon on every key. */
const VARIABLES_PAUSE_MS = 250;

/**
 * The open Request's variables as the Daemon resolves them in `input`'s environment; read again
 * once edits pause. Null while nothing is open; the last answer stays until the next arrives.
 */
export const useVariables = (
  at: RequestsSessionKey,
  input: SendInput | null
): Loaded<ReadonlyArray<ResolvedVariable>> | null => {
  const api = useRequestsApi();
  const [state, setState] = useState<Loaded<ReadonlyArray<ResolvedVariable>>>(LOADING);
  const key = input === null ? null : JSON.stringify([at, input]);
  // What `key` names, read when it changes.
  const latest = useRef({ at, input });

  latest.current = { at, input };

  useEffect(() => {
    const shown = latest.current;

    if (key === null || shown.input === null) return undefined;

    const asked = shown.input;
    let live = true;

    const timer = setTimeout(() => {
      void api.variables(shown.at, asked).then((result) => {
        if (live)
          setState(
            result.ok
              ? { status: "ready", value: result.value }
              : { status: "failed", error: result.error }
          );
      });
    }, VARIABLES_PAUSE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, key]);

  return input === null ? null : state;
};
