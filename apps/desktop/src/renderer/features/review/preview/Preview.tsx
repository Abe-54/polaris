/**
 * Review on fixtures, for screenshots against Paper R1 / R2 (`scripts/reviewScreens.ts`)
 * and the large-Review bench: `#review/pull`, `#review/session`, `#review/large` (2,500
 * files, collapsed) and `#review/list-only` (12,000 files); the queue's Reviewed group in
 * `#review/queue-reviewed` and `#review/queue-done`; Reviewers and Merge in `#review/merge-…`
 * and `#review/reviewers…` (mergeFixtures.ts); the Data section in `#review/session-data…`
 * (schemaScenes.ts). A stand-in bridge serves the patches;
 * no Daemon or GitHub is involved. Its own chunk.
 */
import { stackedDetail } from "../../pulls/preview/stack.ts";
import { type GitDiffSpec, ReviewCheckout } from "@polaris/protocol";
import { Predicate } from "effect";
import { createRoot } from "react-dom/client";
import { createStore } from "zustand/vanilla";
import type { OpenPull, PolarisApi, Result } from "../../../../shared/api.ts";
import { App } from "../../../app/App.tsx";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { openPull, openSessionReview } from "../../../routes/review.ts";
import { emptyHostModel } from "../../../store/hostModel.ts";
import { type AppState, type Connection, initialState, sessionKey } from "../../../store/store.ts";
import { standInBridge } from "../../bridge.ts";
import { pullsStore } from "../../pulls/store.ts";
import { ACCOUNTS, HOSTS, LIST, MODELS } from "../../pulls/preview/fixtures.ts";
import {
  pullSummary,
  sessionSummary,
  setUpScene,
  withThreads,
} from "../../risk/preview/fixtures.ts";
import { doneStore } from "../data/advance.ts";
import { reviewedStore } from "../data/reviewedStore.ts";
import { markLocal } from "../data/viewedStore.ts";
import { fingerprint, indexPatch } from "../model/patch.ts";
import { subjectKey, updateSurface } from "../surface.ts";
import { poster } from "../overview/data/actions.ts";
import { walkthroughScenes } from "../overview/data/overview.ts";
import { setTab } from "../overview/model/tabs.ts";
import { openSceneTab, overviewDetail, walkthroughsFor } from "../overview/preview/fixtures.ts";
import {
  CHECKOUT,
  manyFilesPatch,
  PULL_DETAIL,
  PULL_FINDINGS,
  PULL_PATCH,
  SESSION,
  SESSION_FINDINGS,
  sessionModel,
  TURN_PATCHES,
} from "./fixtures.ts";
import {
  QUEUE_CHECKOUT,
  QUEUE_COMPARE,
  QUEUE_DETAIL,
  QUEUE_DONE_LIST,
  QUEUE_LIST,
  QUEUE_PULL,
} from "./queueFixtures.ts";
import { mergeAnswer, setUpMerge } from "./mergeScenes.ts";
import {
  isXg,
  REVIEWER_SESSION,
  reviewerSession,
  setUpXg,
  XG_FINDINGS,
  xgDetail,
} from "./xgScenes.ts";
import {
  isWorst,
  setUpWorst,
  worstDetail,
  worstFindings,
  worstHosts,
  worstPatch,
  worstReviewerSession,
  worstSummary,
} from "./worstScenes.ts";
import { isSchemaScene, schemaDiffAnswer, schemaHosts, schemaPatch } from "./schemaScenes.ts";
import { openSchemaDiff } from "../schema/store.ts";

const encode = (text: string) => new TextEncoder().encode(text);

const patchFor = (scene: string, spec: GitDiffSpec) => {
  if (scene === "large") return manyFilesPatch(2500);

  if (scene === "list-only") return manyFilesPatch(12_000);

  if (isWorst(scene)) return scene === "worst-empty" ? "" : worstPatch(200);

  return Predicate.isTagged(spec, "Turn")
    ? schemaPatch(scene, spec.turnId, TURN_PATCHES.get(spec.turnId) ?? "")
    : PULL_PATCH;
};

/** What the stand-in reads of a request's input. */
interface PreviewInput {
  readonly spec?: GitDiffSpec;
}

const ok = <A,>(value: A): Promise<Result<A>> => Promise.resolve({ ok: true, value });

/** The queue's and Merge's scenes are on acme/atlas #88. */
const onQueue = (scene: string) =>
  scene.startsWith("queue-") || scene.startsWith("merge-") || scene.startsWith("reviewers");

const detailFor = (scene: string) => {
  if (onQueue(scene)) return QUEUE_DETAIL;

  if (scene === "stacked") return stackedDetail(PULL_DETAIL);

  if (isXg(scene)) return xgDetail(PULL_DETAIL);

  if (isWorst(scene)) return worstDetail(PULL_DETAIL, scene);

  if (scene.startsWith("ov")) return overviewDetail(PULL_DETAIL, scene);

  return scene.startsWith("pull-") ? withThreads(PULL_DETAIL) : PULL_DETAIL;
};

const xgOr = (scene: string) => {
  if (isXg(scene)) return XG_FINDINGS;

  if (isWorst(scene)) return worstFindings(scene);

  return scene === "large" || scene === "list-only" ? [] : PULL_FINDINGS;
};

const request = (scene: string) => (method: string, input: PreviewInput) => {
  if (method === "git.diff" && input.spec !== undefined) {
    return ok({ bytes: encode(patchFor(scene, input.spec)), files: 0, fileIndex: [] });
  }

  if (method === "git.show" || method === "files.read") {
    return ok({ size: 0, mimeType: "text/plain", content: { kind: "text", text: "" } });
  }

  if (method === "github.pull.detail") return ok(detailFor(scene));

  if (method === "github.pull.compare") return ok(QUEUE_COMPARE);

  if (method === "review.runRiskSummary") {
    if (scene.startsWith("session")) return ok(sessionSummary(SESSION_FINDINGS, SESSION.id));
    const summary = pullSummary(xgOr(scene));

    return ok(isWorst(scene) ? worstSummary(summary, scene) : summary);
  }

  if (method === "review.verdicts") return ok([]);

  if (method === "data.schemaDiff") return schemaDiffAnswer(scene, SESSION.id);

  const merging = mergeAnswer(scene, method);

  if (merging !== null) return ok(merging);

  if (method === "github.files.setViewed" || method === "dispatch") return ok(null);

  return Promise.resolve({ ok: false, error: { code: "Unsupported", message: "preview" } });
};

const bridge = (scene: string): PolarisApi => ({
  // SAFETY: the stand-in answers every method the Review view asks with its declared shape.
  request: request(scene) as PolarisApi["request"],
  subscribe: () => () => undefined,
  onAppEvent: () => () => undefined,
});

const PULL: OpenPull = {
  repo: { owner: "work-org", name: "nj-homes-choice-next" },
  number: 88,
  pullId: "PR_88",
};

/** `#review/stacked`: layer 2 of a four-layer GitHub stack (features/pulls/preview/stack.ts). */
const STACKED_PULL: OpenPull = { ...PULL, number: 632, pullId: "PR_632" };

const pullOf = (scene: string) => {
  if (onQueue(scene)) return QUEUE_PULL;

  return scene === "stacked" ? STACKED_PULL : PULL;
};

/** `#review/queue-…`: Reviewed open beside #88, or the done pane once #88 emptied its group. */
const setUpQueue = (scene: string) => {
  if (!onQueue(scene)) return;
  const done = scene === "queue-done";

  pullsStore.setState({ list: done ? QUEUE_DONE_LIST : QUEUE_LIST, accounts: ACCOUNTS });
  reviewedStore.setState({ reviews: {}, open: !done });
  doneStore.setState({ done: done ? { pullId: "PR_88", group: "requested" } : null });
};

/**
 * `#review/bench?cwd=…&base=…&head=…`: a real repository through the real Daemon on the
 * local Host, as a Review Checkout would serve it (`scripts/reviewBench.ts`).
 */
const benchModels = (query: URLSearchParams): AppState["hostModels"] => {
  const head = query.get("head") ?? "";
  const base = query.get("base") ?? "";

  const checkout = new ReviewCheckout({
    id: CHECKOUT.id,
    workspaceId: CHECKOUT.workspaceId,
    subject: CHECKOUT.subject,
    state: "ready",
    blocked: null,
    reviewedHead: null,
    reviewedMergeBase: null,
    openedAt: CHECKOUT.openedAt,
    updatedAt: CHECKOUT.updatedAt,
    path: query.get("cwd") ?? "",
    head,
    mergeBase: base,
    latestHead: head,
    latestBase: base,
  });

  return {
    local: {
      ...emptyHostModel,
      synchronized: true,
      reviewCheckouts: new Map([[checkout.id, checkout]]),
    },
  };
};

/** Turns 22 and 23 already reviewed, as Paper R2 shows them ("2 files · all viewed"). */
const markOlderTurnsViewed = (subject: string) => {
  for (const turnId of ["t21", "t22"]) {
    const bytes = encode(TURN_PATCHES.get(turnId) ?? "");

    for (const file of indexPatch(bytes, [])) {
      markLocal(subject, `${turnId}:${file.path}`, fingerprint(bytes, file));
    }
  }
};

/** `#review/ov-…` and `#review/session-ov…`: Overview's scenes (overview/preview/fixtures.ts). */
const setUpOverview = (scene: string) => {
  const overview = scene.startsWith("ov") || scene.startsWith("session-ov");

  const key = scene.startsWith("session")
    ? subjectKey({ kind: "session", hostKey: "local", sessionId: SESSION.id })
    : subjectKey({ kind: "pull", pull: pullOf(scene) });

  // The diff's scenes (Paper R1, R2) open on Changes; the real app opens every Review on Overview.
  if (!overview) {
    setTab(key, "changes");

    return;
  }

  poster.current = {
    command: () => Promise.resolve({ ok: true }),
    publish: () => Promise.resolve({ ok: true }),
    comment: () => Promise.resolve({ ok: true }),
  };
  walkthroughScenes.setState({ [key]: walkthroughsFor(scene) });
  openSceneTab(scene, key);
};

const findingsOf = (scene: string) => {
  if (isXg(scene)) return XG_FINDINGS;

  if (isWorst(scene)) return worstFindings(scene);

  return scene.startsWith("pull") || scene.startsWith("ov") ? PULL_FINDINGS : [];
};

export const mountReviewPreview = (root: HTMLElement, hash: string) => {
  const [scene = "", search = ""] = hash.replace(/^#review\//, "").split("?");
  const bench = scene === "bench";
  const studio = MODELS.studio;
  const local = MODELS.local;

  const reviewer = isWorst(scene) ? worstReviewerSession : reviewerSession;

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: bench ? [] : schemaHosts(scene, worstHosts(HOSTS, scene)),
    hostModels: bench
      ? benchModels(new URLSearchParams(search))
      : {
          ...MODELS,
          // The pull list's preview gives studio a session of its own; Review shows only ours.
          studio: {
            ...studio,
            sessions: new Map(),
            reviewCheckouts: new Map([
              onQueue(scene) ? [QUEUE_CHECKOUT.id, QUEUE_CHECKOUT] : [CHECKOUT.id, CHECKOUT],
            ]),
          },
          local: {
            ...local,
            sessions: new Map([
              [
                SESSION.id,
                { session: SESSION, pendingApprovals: [], lastTurnPreview: null, subagents: [] },
              ],
            ]),
          },
        },
    sessions: {
      [sessionKey("local", SESSION.id)]: sessionModel(),
      [sessionKey("studio", REVIEWER_SESSION)]: reviewer(),
      [sessionKey("local", REVIEWER_SESSION)]: reviewer(),
    },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: (density) => store.setState({ density }),
    setAppearance: ({ density, theme }) => store.setState({ density, theme }),
  };

  const navigation = createNavigation({ app: store, storage: null });

  if (!bench) {
    standInBridge(bridge(scene));
    pullsStore.setState({ list: LIST, accounts: ACCOUNTS });
    setUpQueue(scene);
  }

  setUpMerge(scene);
  setUpScene(scene, subjectKey({ kind: "session", hostKey: "local", sessionId: SESSION.id }));
  setUpOverview(scene);

  if (scene.startsWith("session")) {
    openSessionReview(navigation.actions, "local", SESSION.id);
    markOlderTurnsViewed(subjectKey({ kind: "session", hostKey: "local", sessionId: SESSION.id }));

    if (isSchemaScene(scene) && scene !== "session-data-diff")
      openSchemaDiff(
        subjectKey({ kind: "session", hostKey: "local", sessionId: SESSION.id }),
        scene === "session-data-worst"
          ? "src-household_income_eligibility_determinations_by_county_and_program_year_with_overrides_replica"
          : "src-app"
      );
    updateSurface(subjectKey({ kind: "session", hostKey: "local", sessionId: SESSION.id }), {
      findings: SESSION_FINDINGS,
      selectedFinding: SESSION_FINDINGS[0]?.id ?? null,
    });
  } else {
    const pull = pullOf(scene);

    setUpXg(scene, subjectKey({ kind: "pull", pull }), "rs-88");
    setUpWorst(scene, subjectKey({ kind: "pull", pull }), "rs-88");
    openPull(navigation.actions, pull);
    updateSurface(subjectKey({ kind: "pull", pull }), {
      findings: findingsOf(scene),
      selectedFinding:
        scene === "pull" || scene === "pull-verdict" ? (PULL_FINDINGS[0]?.id ?? null) : null,
    });
  }

  const commands = createCommandRegistry({ platform: "mac" });

  createRoot(root).render(<App value={{ connection, navigation, commands }} />);

  return connection.setDensity;
};
