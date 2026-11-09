/**
 * Requests on fixtures, for screenshots: `#requests/<scene>` renders the whole app on Requests
 * with "Fix overdue totals" in the ledger Workspace selected and the fixture RequestsApi, no
 * Daemon involved. `q1` opens "Recalculate overdue" with an unsaved edit, as Paper Q1; `list`
 * opens the first Request.
 */
import { RequestTarget } from "@polaris/protocol";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { App } from "../../../app/App.tsx";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import type { AppState, Connection } from "../../../store/store.ts";
import { fixtureAppState, HOST } from "../../traces/preview/appState.ts";
import { FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import { RequestsLayer } from "../data/hooks.tsx";
import { refString } from "../model/draft.ts";
import { openRequest, setDraft, setLatestSend } from "../model/store.ts";
import { fixtureRequestsApi } from "./fixtureApi.ts";

const at = { hostKey: HOST, sessionId: FIXTURE_SESSION };

const RECALCULATE = { file: "http/invoices.http", name: "Recalculate overdue" };

/** Q1: the open Request has an edit not yet saved, and was just sent. */
const playQ1 = async (api: ReturnType<typeof fixtureRequestsApi>) => {
  const key = refString(RECALCULATE);

  openRequest(at, key);
  await new Promise<void>((resolve) => {
    const stop = api.watch(at, {
      next: (snapshot) => {
        const saved = snapshot.files
          .find((f) => f.path === RECALCULATE.file)
          ?.requests.find((r) => r.name === RECALCULATE.name);

        if (saved !== undefined)
          setDraft(at, key, {
            file: saved.file,
            name: saved.name,
            method: saved.method,
            url: saved.url,
            headers: saved.headers,
            body: (saved.body ?? "").replace('"EUR",', '"EUR",\n  "dryRun": false,'),
            auth: saved.auth ?? null,
            line: saved.line ?? null,
          });
        queueMicrotask(stop);
        resolve();
      },
    });
  });

  const sent = await api.send(at, {
    target: RequestTarget.cases.Saved.make({ ref: RECALCULATE }),
    environment: "dev",
  });

  if (sent.ok) setLatestSend(at, sent.value);
};

/** `shown` is the appearance at mount: later changes arrive through the returned setter. */
export const mountRequestsPreview = (
  root: HTMLElement,
  hash: string,
  shown: Pick<AppState, "density" | "theme">
) => {
  const scene = hash.replace(/^#requests\//, "");
  const store = createStore<AppState>(() => ({ ...fixtureAppState(), ...shown }));
  const api = fixtureRequestsApi();

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });

  navigation.actions.selectSession(at);
  navigation.actions.setMode("requests");

  if (scene === "q1") void playQ1(api);

  createRoot(root).render(
    <RequestsLayer api={api}>
      <App
        value={{ connection, navigation, commands: createCommandRegistry({ platform: "mac" }) }}
      />
    </RequestsLayer>
  );

  return connection.setDensity;
};
