/**
 * The composer gallery's scenes (composer/Gallery.tsx), built from fixtures. A testing module, so
 * a release bundle drops it (ENG-555).
 */
import {
  type ApprovalRequest,
  ContextUsage,
  type HarnessKind,
  RequestId,
  Subagent,
  SubagentId,
  TurnId,
} from "@polaris/protocol";
import { Match } from "effect";
import type { SecretOutcome } from "../thread/fold.ts";
import { request, sessionId } from "../thread/daemon.testing.ts";
import type { Chip } from "./attach.ts";
import type { GalleryState } from "./Gallery.tsx";
import {
  EMPTY_CONTEXT,
  EXACTLY_FULL,
  LONG_DRAFT,
  LONG_ERROR,
  LONG_MODEL,
  MANY_CHIPS,
  NO_WINDOW,
  ONE_SHORT_REQUEST,
  OVER_FULL,
  TWENTY_SUBAGENTS,
  UNKNOWN_HARNESS,
  WORST_QUESTION,
  WORST_REQUESTS,
  WORST_SECRET,
} from "./worstCase.testing.ts";

export const at = new Date(Date.now() - 72_000).toISOString();

const ask = (id: string, fields: Partial<ApprovalRequest>) =>
  request({ id: RequestId.make(id), openedAt: at, ...fields });

const helper = (n: number) =>
  new Subagent({
    id: SubagentId.make(`s${n}`),
    sessionId,
    turnId: TurnId.make("t"),
    parentItemId: null,
    title: `Helper ${n}`,
    agent: "Explore",
    model: null,
    status: "working",
    startedAt: at,
    endedAt: null,
  });

const SECRET = ask("k", {
  kind: "secret",
  title: "Tailscale auth key",
  detail: "To join this machine to your tailnet for the deploy",
  placeholder: "tskey-auth-…",
});

/** `secret-saved`: the strip once the key reached the Host and the agent works on. */
export const SAVED: SecretOutcome = { request: SECRET, outcome: "saved" };

export const REQUESTS: Readonly<Record<GalleryState, ReadonlyArray<ApprovalRequest>>> = {
  idle: [],
  typed: [],
  working: [],
  approval: [ask("a", { detail: "bun run build" })],
  subagent: [
    ask("a", { detail: "bun run build" }),
    ask("b", {
      kind: "file-change",
      detail: "apps/site/public/index.html",
      openedAt: new Date(Date.now() - 30_000).toISOString(),
    }),
  ],
  long: [ask("a", { detail: "bun run --cwd apps/mobile test -- src/composer\nbun run lint" })],
  question: [
    ask("q", { kind: "question", title: "Which base?", options: ["main", "phase-1 branch"] }),
  ],
  secret: [SECRET],
  "secret-saved": [],
  "worst-secret": WORST_SECRET,
  sheet: [],
  "sheet-later": [],
  worst: WORST_REQUESTS,
  "worst-question": WORST_QUESTION,
  "worst-sheet": [],
  "worst-zero": ONE_SHORT_REQUEST,
  "worst-full": [],
};

/** What else each state feeds the composer; the demo states keep the defaults. */
interface Scene {
  readonly harness: HarnessKind;
  readonly model: string;
  readonly subagents: ReadonlyArray<Subagent>;
  readonly context: ContextUsage | null;
  readonly text: string;
  readonly chips: ReadonlyArray<Chip>;
  readonly error: string | null;
}

const DEMO: Scene = {
  harness: "claude",
  model: "Opus 5.5",
  subagents: [],
  context: new ContextUsage({ usedTokens: 34_000, windowTokens: 200_000 }),
  text: "",
  chips: [],
  error: null,
};

const WORST: Scene = {
  harness: UNKNOWN_HARNESS,
  model: LONG_MODEL,
  subagents: TWENTY_SUBAGENTS,
  context: OVER_FULL,
  text: LONG_DRAFT,
  chips: MANY_CHIPS,
  error: LONG_ERROR,
};

export const sceneOf = (state: GalleryState): Scene =>
  Match.value(state).pipe(
    Match.when("typed", () => ({ ...DEMO, text: "Now write the release timeline" })),
    Match.when("subagent", () => ({ ...DEMO, subagents: [helper(0), helper(1), helper(2)] })),
    Match.when("worst", () => WORST),
    Match.when("worst-question", () => ({ ...WORST, text: "", chips: [], error: null })),
    Match.when("worst-secret", () => ({ ...WORST, text: "", chips: [], error: null })),
    Match.when("worst-sheet", () => ({ ...DEMO, model: LONG_MODEL, context: NO_WINDOW })),
    Match.when("worst-zero", () => ({
      ...DEMO,
      harness: UNKNOWN_HARNESS,
      subagents: TWENTY_SUBAGENTS.slice(0, 1),
      context: EMPTY_CONTEXT,
    })),
    Match.when("worst-full", () => ({ ...WORST, context: EXACTLY_FULL, text: "", error: null })),
    Match.orElse(() => DEMO)
  );
