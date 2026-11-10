import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { arcadeCommands } from "./features/arcade/index.ts";
import { onNeedsYouEvent } from "./features/needs-you/index.ts";
import { bannerEntry, recordBanner } from "./features/session/index.ts";
import { applyAppearance } from "./appearance.ts";
import {
  connectHostDeveloperModes,
  connectSettings,
  settingsCommands,
  settingsStore,
} from "./features/settings/index.ts";
import { connectUpdates, updatesStore } from "./features/settings/updates/store.ts";
import { createOnboarding } from "./features/onboarding/index.ts";
import { installPalette } from "./features/palette/index.ts";
import { startProofSession } from "./proof.ts";
import { createCommandRegistry } from "./routes/commands.ts";
import { installKeyboard, installMouseButtons } from "./routes/keyboard.ts";
import { onOpenPullEvent, onOpenReviewEvent } from "./routes/review.ts";
import { onDeepLinkEvent } from "./routes/deepLink.ts";
import { createNavigation } from "./routes/navigation.ts";
import { exposeSwitchTimes } from "./routes/switchTimer.ts";
import type { Appearance, Density } from "../shared/api.ts";
import { shellCommands, shellContext } from "./shell/commands.ts";
import { workspaceCommands } from "./shell/visibility.ts";
import { send } from "./features/session/dispatch.ts";
import { connect } from "./store/store.ts";
import { actionTraces, connectSelfTraces, traceRequests } from "./features/selfTraces/index.ts";
import { installCrashReporting } from "./features/crash/index.ts";

installCrashReporting();

/** Requests join the user action that caused them (features/selfTraces/actions.ts). */
const api = traceRequests(window.polaris);

const connection = connect(api);

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

const onboarding = createOnboarding({ api, store: connection.store });

const navigation = createNavigation({
  app: connection.store,
  storage,
  ensureWorkspace: onboarding.workspaceFor,
});

const commands = createCommandRegistry();

commands.register(settingsCommands(navigation.actions));

commands.register(
  shellCommands({
    connection,
    navigation,
    dark: () => {
      const { theme } = connection.store.getState();

      return theme === "system"
        ? matchMedia("(prefers-color-scheme: dark)").matches
        : theme === "dark";
    },
  })
);

commands.provide(shellContext({ connection, navigation }));

commands.contribute(workspaceCommands({ app: connection.store.getState, navigation, send }));

commands.contribute(arcadeCommands());

commands.provide(() => {
  const version = updatesStore.getState().view?.availableVersion;

  return version == null ? {} : { values: { updateVersion: version } };
});

installPalette({ commands, actions: navigation.actions, storage });

// `#preview/<scene>`: the shell on fixtures, for screenshots (features/session/preview).
const preview = location.hash.startsWith("#preview/");

// `#needs-you/<scene>`: the inbox and hover card on fixtures (features/needs-you/preview).
const needsYouPreview = location.hash.startsWith("#needs-you/");

// `#pulls/<scene>`: the pull request list on fixtures (features/pulls/preview).
const pullsPreview = location.hash.startsWith("#pulls/");

// `#review/<scene>`: Review on fixtures (features/review/preview).
const reviewPreview = location.hash.startsWith("#review/");

// `#checkout/<scene>`: the Review Checkout chip and menu on fixtures (features/review/checkout/preview).
const checkoutPreview = location.hash.startsWith("#checkout/");

// `#hosts/<scene>`: Settings → Hosts on fixtures, every daemon update state (features/machines/preview).
const updatesPreview = location.hash.startsWith("#updates/");

const hostsPreview = location.hash.startsWith("#hosts/");

// `#constellation/<scene>`: the Constellation tab on fixtures (features/constellation/preview).
const constellationPreview = location.hash.startsWith("#constellation/");

// `#constellations/<scene>`: the sidebar, Needs you, Review, Settings and Usage parts of Constellations (features/sessions/preview).
const constellationsPreview = location.hash.startsWith("#constellations/");

// `#explorer/<scene>`: Edit mode's explorer on fixtures (features/editor/explorer/preview).
const explorerPreview = location.hash.startsWith("#explorer/");

// `#editor/<scene>`: the editor pane on in-memory files (features/editor/preview).
const editorPreview = location.hash.startsWith("#editor/");

// `#editor-inline/<scene>`: the selection bar, inline card and ⌘L picker on fixtures (features/editor-inline/preview).
const editorInlinePreview = location.hash.startsWith("#editor-inline/");

// `#tab-completion/<scene>`: Settings → Editor → Tab completion on fixtures (features/settings/editor/preview).
const tabCompletionPreview = location.hash.startsWith("#tab-completion/");

// `#completion-card/<scene>`: the status bar's tab completion card on fixtures (features/editor/prediction/preview).
const completionCardPreview = location.hash.startsWith("#completion-card/");

// `#edit-prediction/<scene>`: the Editor with an Edit Prediction drawn on fixtures (features/editor/prediction/preview).
const editPredictionPreview = location.hash.startsWith("#edit-prediction/");

// `#data/<scene>`: Data mode on fixtures, each lane's scenes (features/data/preview/scenes).
const dataPreview = location.hash.startsWith("#data/");

// `#data-sidebar/<scene>`: Data's sidebar, connection bar and status bar on worst-case fixtures (features/data/preview).
const dataSidebarPreview = location.hash.startsWith("#data-sidebar/");

// `#traces/<scene>`: Traces on fixtures (features/traces/preview).
const tracesPreview = location.hash.startsWith("#traces/");

// `#requests/<scene>`: Requests on fixtures (features/requests/preview).
const requestsPreview = location.hash.startsWith("#requests/");

// `#computer-use/<scene>`: computer use's cards on fixtures (features/computer-use/preview).
const computerUsePreview = location.hash.startsWith("#computer-use/");

// `#settings/<scene>`: Settings on worst-case fixtures (features/settings/preview).
const settingsPreview = location.hash.startsWith("#settings/");

let setPreviewDensity: ((density: Density) => void) | null = null;

const appearance = (value: Appearance) => {
  applyAppearance(value);
  connection.setAppearance(value);
  setPreviewDensity?.(value.density);
};

appearance(settingsStore.getState().appearance);

settingsStore.subscribe((state, prev) => {
  if (state.appearance !== prev.appearance) appearance(state.appearance);
});

connectSettings(api);

connectHostDeveloperModes(api);

connectUpdates(api);

// Warnings in the window join the open action Span, else become polaris.log Spans (ENG-754).
connectSelfTraces(window.polaris, actionTraces.active);

window.polaris.onAppEvent((event) => {
  if (event.kind === "command") commands.run(event.id);
  else if (event.kind === "needs-you")
    onNeedsYouEvent(event, navigation.actions, (hostKey, sessionId, requestId) =>
      connection.store
        .getState()
        .hostModels[hostKey]?.sessions.get(sessionId)
        ?.pendingApprovals.find((r) => r.id === requestId)
    );
  else if (event.kind === "open-pull") onOpenPullEvent(event.pull, navigation.actions);
  else if (event.kind === "open-review") onOpenReviewEvent(event.target, navigation.actions);
  else if (event.kind === "deep-link")
    onDeepLinkEvent(event.link, connection.store, navigation.actions);
  else if (event.kind === "agent-banner") recordBanner(bannerEntry(event));
  else if (event.kind === "proof") {
    void startProofSession({ api, store: connection.store, hostKey: event.hostKey })
      .then((sessionId) => navigation.actions.selectSession({ hostKey: event.hostKey, sessionId }))
      .catch((cause: unknown) => console.error("polaris: proof session failed", cause));
  }
});

installKeyboard({ actions: navigation.actions, registry: commands });

installMouseButtons(commands);

exposeSwitchTimes();

const root = document.getElementById("root");

if (root !== null && preview) {
  void import("./features/session/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountPreview(root, location.hash);
  });
} else if (root !== null && needsYouPreview) {
  void import("./features/needs-you/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountNeedsYouPreview(root, location.hash);
  });
} else if (root !== null && constellationsPreview) {
  void import("./features/sessions/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountConstellationsPreview(root, location.hash);
  });
} else if (root !== null && pullsPreview) {
  void import("./features/pulls/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountPullsPreview(root, location.hash);
  });
} else if (root !== null && reviewPreview) {
  void import("./features/review/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountReviewPreview(root, location.hash);
  });
} else if (root !== null && checkoutPreview) {
  void import("./features/review/checkout/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountCheckoutPreview(root, location.hash);
  });
} else if (root !== null && updatesPreview) {
  void import("./features/settings/updates/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountUpdatesPreview(root, location.hash);
  });
} else if (root !== null && hostsPreview) {
  void import("./features/machines/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountHostsPreview(root, location.hash);
  });
} else if (root !== null && constellationPreview) {
  void import("./features/constellation/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountConstellationPreview(root, location.hash);
  });
} else if (root !== null && dataSidebarPreview) {
  void import("./features/data/preview/SidebarPreview.tsx").then((m) => {
    setPreviewDensity = m.mountDataSidebarPreview(root, location.hash);
  });
} else if (root !== null && explorerPreview) {
  void import("./features/editor/explorer/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountExplorerPreview(root, location.hash);
  });
} else if (root !== null && editorPreview) {
  void import("./features/editor/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountEditorPreview(root, location.hash);
  });
} else if (root !== null && editorInlinePreview) {
  void import("./features/editor-inline/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountEditorInlinePreview(root, location.hash);
  });
} else if (root !== null && editPredictionPreview) {
  void import("./features/editor/prediction/preview/EditPreview.tsx").then((m) => {
    setPreviewDensity = m.mountEditPredictionPreview(root, location.hash);
  });
} else if (root !== null && completionCardPreview) {
  void import("./features/editor/prediction/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountCompletionCardPreview(root, location.hash);
  });
} else if (root !== null && settingsPreview) {
  void import("./features/settings/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountSettingsPreview(root, location.hash);
  });
} else if (root !== null && dataPreview) {
  void import("./features/data/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountDataPreview(
      root,
      location.hash,
      settingsStore.getState().appearance
    );
  });
} else if (root !== null && tracesPreview) {
  void import("./features/traces/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountTracesPreview(
      root,
      location.hash,
      settingsStore.getState().appearance
    );
  });
} else if (root !== null && requestsPreview) {
  void import("./features/requests/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountRequestsPreview(
      root,
      location.hash,
      settingsStore.getState().appearance
    );
  });
} else if (root !== null && computerUsePreview) {
  void import("./features/computer-use/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountComputerUsePreview(root, location.hash);
  });
} else if (root !== null && tabCompletionPreview) {
  void import("./features/settings/editor/preview/Preview.tsx").then((m) => {
    setPreviewDensity = m.mountTabCompletionPreview(root, location.hash);
  });
} else if (root !== null) {
  createRoot(root).render(
    <App value={{ connection, navigation, commands }} onboarding={onboarding} />
  );
}
