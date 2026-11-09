/**
 * Requests on fixtures, for screenshots: `#requests/<scene>` renders the whole app on Requests
 * with "Fix overdue totals" in the ledger Workspace selected and the fixture RequestsApi, no
 * Daemon involved. `q1` opens "Recalculate overdue" with an unsaved edit, as Paper Q1; `list`
 * opens the first Request; `q2` shows an agent's ad-hoc send whose write failed (the send pane);
 * `states` lays out Q3's cards; the rest are in scenes.ts.
 */
import { RequestTarget } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import { App } from "../../../app/App.tsx";
import { AppProvider } from "../../../shell/hooks.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import type { AppState, Connection } from "../../../store/store.ts";
import { fixtureAppState, HOST } from "../../traces/preview/appState.ts";
import { FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import { RequestsLayer } from "../data/hooks.tsx";
import { refString } from "../model/draft.ts";
import { openRequest, setDraft, setLatestSend } from "../model/store.ts";
import { AGENT_SEND, SendFixtureLayers } from "../ui/send/fixture.tsx";
import { fixtureRequestsApi } from "./fixtureApi.ts";
import { statesScene } from "./scenes.ts";
import { StatesGallery } from "./StatesGallery.tsx";

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
  const states = statesScene(scene);

  const store = createStore<AppState>(() => ({
    ...(states?.state ?? ((s: AppState) => s))(fixtureAppState()),
    ...shown,
  }));

  const fixture = fixtureRequestsApi(states?.options);
  const api = states === null ? fixture : states.api(fixture);

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });

  navigation.actions.selectSession(at);
  navigation.actions.setMode("requests");

  if (scene === "q1" || scene === "q2") void playQ1(api);

  if (scene === "q2") setTimeout(() => setLatestSend(at, AGENT_SEND), 200);

  states?.play();

  const commands = createCommandRegistry({ platform: "mac" });

  if (scene === "states") {
    createRoot(root).render(
      <AppProvider value={{ connection, navigation, commands }}>
        <TooltipProvider>
          <StatesGallery at={at} />
        </TooltipProvider>
      </AppProvider>
    );

    return connection.setDensity;
  }

  createRoot(root).render(
    <RequestsLayer api={api}>
      <SendFixtureLayers {...(states?.traces === undefined ? {} : { traces: states.traces })}>
        <App value={{ connection, navigation, commands }} />
      </SendFixtureLayers>
    </RequestsLayer>
  );

  return connection.setDensity;
};
