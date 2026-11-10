/**
 * Computer use (ENG-846): random uses, answers, Turn ends and removals drive the real Session
 * decider and the real app policy, against an independent model of `packages/spec/computer-use.qnt`.
 */
import { expect, test } from "bun:test";
import {
  AgentSession,
  answerAppApproval,
  type AppApprovalKind,
  AppId,
  type AppPolicy,
  ApprovalDecision,
  ApprovalRequest,
  AppUseDecision,
  controlApp,
  decideAppUse,
  DesktopApp,
  DomainEvent,
  emptyAppPolicy,
  releaseSession,
  RequestId,
  SessionId,
  Turn,
  TurnId,
  withoutAllowedApp,
} from "@polaris/protocol";
import { Schema } from "effect";
import fc from "fast-check";
import { started } from "../data/approvals.testing.ts";
import { decideSession } from "../engine/session.ts";
import { workingTurn } from "../store/model.ts";
import { pbtRuns, pbtSeed, pbtTimeout } from "./pbt.ts";

const APPS = ["figma", "notes", "keychain"] as const;

const REFUSED = "keychain";

type App = (typeof APPS)[number];

type How = "session" | "always" | "deny";

type Step =
  | { readonly do: "use"; readonly s: number; readonly app: App; readonly physical: boolean }
  // Answers the `pick`th pending card, so most answers land on one; a miss changes nothing.
  | { readonly do: "answer"; readonly pick: number; readonly how: How }
  | { readonly do: "end"; readonly s: number }
  | { readonly do: "send"; readonly s: number }
  | { readonly do: "remove"; readonly app: App };

// ── The independent model: the spec's state, keyed by plain strings ─────────

interface Model {
  readonly turns: Set<number>;
  readonly always: Set<App>;
  readonly allowed: Set<string>;
  readonly headed: Set<string>;
  readonly cards: Set<string>;
  readonly controller: Map<App, number>;
  /** What the user said, per session: the ghosts `covered` reads. */
  readonly saidApp: Set<string>;
  readonly saidHeaded: Set<string>;
}

const key = (s: number, app: App) => `${s}/${app}`;

const card = (s: number, app: App, kind: AppApprovalKind) => `${s}/${app}/${kind}`;

const expectedDecision = (m: Model, s: number, app: App, physical: boolean) => {
  const by = m.controller.get(app);

  if (app === REFUSED) return "Refused";

  if (by !== undefined && by !== s) return "InUse";

  if (!m.always.has(app) && !m.allowed.has(key(s, app))) return "app";

  return physical && !m.headed.has(key(s, app)) ? "headed-input" : "Allowed";
};

/** The user covered this action by their own answers, whatever the policy stored. */
const covered = (m: Model, s: number, app: App, physical: boolean) =>
  app !== REFUSED &&
  (m.controller.get(app) ?? s) === s &&
  (m.always.has(app) || m.saidApp.has(key(s, app))) &&
  (!physical || m.saidHeaded.has(key(s, app)));

interface Card {
  readonly s: number;
  readonly app: App;
  readonly kind: AppApprovalKind;
}

const pickCard = (m: Model, pick: number): Card | undefined => {
  const [s, app, kind] = [...m.cards].sort()[pick]?.split("/") ?? [];

  // SAFETY: every card was written by `card` from a session, an App and an AppApprovalKind.
  return s === undefined
    ? undefined
    : { s: Number(s), app: app as App, kind: kind as AppApprovalKind };
};

const answerModel = (m: Model, { s, app, kind }: Card, how: How) => {
  // "Always" on a headed-input card is refused: nothing changes and the card stays.
  if (kind === "headed-input" && how === "always") return;
  m.cards.delete(card(s, app, kind));

  if (how === "deny") return;

  if (kind === "headed-input") {
    m.headed.add(key(s, app));
    m.saidHeaded.add(key(s, app));
  } else if (how === "always") m.always.add(app);
  else {
    m.allowed.add(key(s, app));
    m.saidApp.add(key(s, app));
  }
};

const endModel = (m: Model, s: number) => {
  m.turns.delete(s);

  for (const pending of Array.from(m.cards))
    if (pending.startsWith(`${s}/`)) m.cards.delete(pending);

  for (const [app, by] of Array.from(m.controller)) if (by === s) m.controller.delete(app);
};

// ── The real code: two Session records and the Host's policy ────────────────

const at = started.session.createdAt;

const appId = (app: App) => AppId.make(`dev.lux.test.${app}`);

const sessionId = (s: number) =>
  SessionId.make(s === 0 ? started.session.id : `model-session-${s}`);

const turnOf = (s: number, n: number, index: number) =>
  new Turn({
    ...Schema.decodeUnknownSync(Schema.Struct(Turn.fields))(started.turns[0]!),
    id: TurnId.make(`model-turn-${s}-${n}`),
    sessionId: sessionId(s),
    index,
  });

const recordOf = (s: number): typeof started =>
  s === 0
    ? started
    : {
        ...started,
        session: new AgentSession({
          ...Schema.decodeUnknownSync(Schema.Struct(AgentSession.fields))(started.session),
          id: sessionId(s),
        }),
        turns: [turnOf(s, 0, 0)],
      };

class Actual {
  records = [recordOf(0), recordOf(1)];
  policy: AppPolicy = emptyAppPolicy([appId(REFUSED)]);
  acts = 0;
  private n = 0;

  private decide(s: number, input: Parameters<typeof decideSession>[1]) {
    const decision = decideSession(this.records[s], input);
    this.records[s] = decision.next.context.record!;

    return decision.events;
  }

  private pendingFor(s: number, app: App, kind: AppApprovalKind) {
    return [...this.records[s]!.pending.values()].find(
      (request) => request.kind === kind && request.app?.id === appId(app)
    );
  }

  /** A computer use tool call, as the Daemon gates it; answers what it came to. */
  use(s: number, app: App, physical: boolean): string | null {
    const turn = workingTurn(this.records[s]!);

    if (turn === undefined) return null;
    const use = { sessionId: sessionId(s), appId: appId(app), headed: physical };
    const decision = decideAppUse(this.policy, use);

    if (AppUseDecision.guards.Allowed(decision)) {
      this.policy = controlApp(this.policy, use);
      this.acts++;
    }

    if (!AppUseDecision.guards.NeedsApproval(decision)) return decision._tag;

    if (this.pendingFor(s, app, decision.kind) === undefined)
      this.decide(s, {
        type: "harness.approvalRequested",
        request: new ApprovalRequest({
          id: RequestId.make(`app-${++this.n}`),
          sessionId: sessionId(s),
          turnId: turn.id,
          kind: decision.kind,
          app: new DesktopApp({ id: appId(app), name: app, icon: null }),
          title: `Use ${app}`,
          detail: null,
          options: [],
          openedAt: at,
        }),
      });

    return decision.kind;
  }

  answer(s: number, app: App, kind: AppApprovalKind, how: How) {
    const request = this.pendingFor(s, app, kind);

    const decision =
      how === "deny"
        ? ApprovalDecision.cases.Deny.make({ reason: null })
        : ApprovalDecision.cases.Allow.make({ remember: how === "always" });

    if (request === undefined) return;

    // The machine refuses an answer `appDecisionRefusal` refuses: no event, so the card stays.
    const decided = this.decide(s, {
      type: "approval.respond",
      requestId: request.id,
      decision,
      resolvedBy: "model",
    }).flatMap((event) => (DomainEvent.guards.ApprovalResolved(event) ? [event.decision] : []));

    for (const made of decided)
      this.policy = answerAppApproval(
        this.policy,
        { sessionId: sessionId(s), appId: appId(app), kind },
        made
      );
  }

  end(s: number) {
    const turn = workingTurn(this.records[s]!);

    if (turn === undefined) return;
    this.decide(s, {
      type: "harness.turnEnded",
      turnId: turn.id,
      status: "completed",
      error: null,
      checkpoint: null,
      at,
    });
    this.policy = releaseSession(this.policy, sessionId(s));
  }

  send(s: number) {
    const record = this.records[s]!;

    if (workingTurn(record) === undefined)
      this.decide(s, { type: "turn.send", turn: turnOf(s, ++this.n, record.session.turnCount) });
  }

  remove(app: App) {
    this.policy = withoutAllowedApp(this.policy, appId(app));
  }

  /** What a Client and the Host feed would see, in the model's terms. */
  observed() {
    const sessions = [0, 1];

    return {
      turns: sessions.filter((s) => workingTurn(this.records[s]!) !== undefined),
      needsYou: sessions.filter((s) => this.records[s]!.session.state === "needs-you"),
      cards: sessions
        .flatMap((s) =>
          [...this.records[s]!.pending.values()].map(
            (request) => `${s}/${request.app?.name}/${request.kind}`
          )
        )
        .sort(),
      always: APPS.filter((app) => this.policy.always.has(appId(app))),
      controller: APPS.flatMap((app) => {
        const by = this.policy.controllers.get(appId(app));

        return by === undefined ? [] : [`${app}:${by === sessionId(0) ? 0 : 1}`];
      }),
    };
  }
}

const expectedView = (m: Model) => ({
  turns: [0, 1].filter((s) => m.turns.has(s)),
  needsYou: [0, 1].filter((s) => [...m.cards].some((pending) => pending.startsWith(`${s}/`))),
  cards: [...m.cards].sort(),
  always: APPS.filter((app) => m.always.has(app)),
  controller: APPS.flatMap((app) =>
    m.controller.has(app) ? [`${app}:${m.controller.get(app)}`] : []
  ),
});

// One session and one app are favoured, so chains of approvals complete and sessions meet.
const session = fc.constantFrom(0, 0, 0, 1);

const app = fc.constantFrom<App>("figma", "figma", "figma", "notes", "keychain");

const use = fc.record({
  do: fc.constant("use" as const),
  s: session,
  app,
  physical: fc.constantFrom(true, true, false),
});

const answer = fc.record({
  do: fc.constant("answer" as const),
  pick: fc.integer({ min: 0, max: 2 }),
  how: fc.constantFrom<How>("session", "session", "always", "deny"),
});

const step: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: use, weight: 4 },
  { arbitrary: answer, weight: 3 },
  fc.record({ do: fc.constant("end" as const), s: session }),
  fc.record({ do: fc.constant("send" as const), s: session }),
  fc.record({ do: fc.constant("remove" as const), app })
);

const RUNS = pbtRuns(300);

const freshModel = (): Model => ({
  turns: new Set([0, 1]),
  always: new Set(),
  allowed: new Set(),
  headed: new Set(),
  cards: new Set(),
  controller: new Map(),
  saidApp: new Set(),
  saidHeaded: new Set(),
});

/** States the run must reach, or it proves little. */
const reached = { acted: 0, headedActs: 0, inUse: 0, askedAgain: 0, refusedAlways: 0 };

const useStep = (actual: Actual, model: Model, next: Extract<Step, { do: "use" }>) => {
  const { s, app: target, physical } = next;
  const expected = model.turns.has(s) ? expectedDecision(model, s, target, physical) : null;

  expect(actual.use(s, target, physical)).toBe(expected);

  if (expected === "Allowed") {
    // Safety: the user's own answers and the lock cover every action.
    expect(covered(model, s, target, physical)).toBe(true);
    model.controller.set(target, s);
    reached.acted++;
    reached.headedActs += physical ? 1 : 0;
  } else if (expected === "app" || expected === "headed-input") {
    reached.askedAgain += model.saidApp.has(key(s, target)) ? 1 : 0;
    model.cards.add(card(s, target, expected));
  } else reached.inUse += expected === "InUse" ? 1 : 0;

  return expected === "Allowed" ? 1 : 0;
};

const answerStep = (actual: Actual, model: Model, next: Extract<Step, { do: "answer" }>) => {
  const picked = pickCard(model, next.pick);

  if (picked === undefined) return;
  reached.refusedAlways += picked.kind === "headed-input" && next.how === "always" ? 1 : 0;
  actual.answer(picked.s, picked.app, picked.kind, next.how);
  answerModel(model, picked, next.how);
};

/** Applies one step to both sides; answers how many actions it made. */
const applyStep = (actual: Actual, model: Model, next: Step): number => {
  switch (next.do) {
    case "use":
      return useStep(actual, model, next);
    case "answer":
      answerStep(actual, model, next);
      break;
    case "end":
      actual.end(next.s);
      endModel(model, next.s);
      break;
    case "send":
      actual.send(next.s);
      model.turns.add(next.s);
      break;
    case "remove":
      actual.remove(next.app);
      model.always.delete(next.app);
      break;
  }

  return 0;
};

test(
  "app and headed-input approvals, always-allow and app control agree with an independent model",
  () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 40, maxLength: 100 }), (steps) => {
        const actual = new Actual();
        const model = freshModel();
        let acts = 0;

        for (const next of steps) {
          acts += applyStep(actual, model, next);
          expect(actual.observed()).toEqual(expectedView(model));
          expect(actual.acts).toBe(acts);
        }
      }),
      { numRuns: RUNS, ...pbtSeed() }
    );

    for (const [state, times] of Object.entries(reached))
      expect(`${state}: ${times > 0}`).toBe(`${state}: true`);
  },
  pbtTimeout(RUNS, 100)
);
