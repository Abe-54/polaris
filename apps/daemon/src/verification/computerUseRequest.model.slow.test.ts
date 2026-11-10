/**
 * Computer use requests (ENG-846): random asks, answers, the Host turning Ready and Turn ends
 * drive the real Session decider, against an independent model of the approval half of
 * `packages/spec/computer-use-request.qnt`. The Harness reopening is the Engine's
 * (`Engine.computerUse.test.ts`), so it isn't modelled here.
 */
import { expect, test } from "bun:test";
import {
  AgentSession,
  ApprovalDecision,
  ApprovalRequest,
  ComputerUseRequest,
  ComputerUseState,
  DomainEvent,
  RequestId,
  SessionId,
  Turn,
  TurnId,
} from "@polaris/protocol";
import { Schema } from "effect";
import fc from "fast-check";
import { started } from "../data/approvals.testing.ts";
import { decideSession } from "../engine/session.ts";
import { workingTurn } from "../store/model.ts";
import { pbtRuns, pbtSeed, pbtTimeout } from "./pbt.ts";

type Step =
  | { readonly do: "ask"; readonly s: number }
  | { readonly do: "answer"; readonly s: number; readonly how: "not-now" | "allow" }
  | { readonly do: "ready" }
  | { readonly do: "end"; readonly s: number }
  | { readonly do: "send"; readonly s: number };

/** The spec's approval state: Turns in flight and pending requests. */
interface Model {
  readonly turns: Set<number>;
  readonly asks: Set<number>;
}

const at = started.session.createdAt;

const sessionId = (s: number) =>
  SessionId.make(s === 0 ? started.session.id : `request-session-${s}`);

const turnOf = (s: number, n: number, index: number) =>
  new Turn({
    ...Schema.decodeUnknownSync(Schema.Struct(Turn.fields))(started.turns[0]!),
    id: TurnId.make(`request-turn-${s}-${n}`),
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
  /** Answers the real machine refused, so the agent was never told anything. */
  refused = 0;
  private n = 0;

  private decide(s: number, input: Parameters<typeof decideSession>[1]) {
    const decision = decideSession(this.records[s], input);
    this.records[s] = decision.next.context.record!;

    return decision.events;
  }

  private pending(s: number) {
    return [...this.records[s]!.pending.values()].find((r) => r.kind === "computer-use");
  }

  /** `ComputerUseRequests.request` opening its approval, as the tool call does. */
  ask(s: number) {
    const turn = workingTurn(this.records[s]!);

    if (turn === undefined || this.pending(s) !== undefined) return;
    this.decide(s, {
      type: "harness.approvalRequested",
      request: new ApprovalRequest({
        id: RequestId.make(`computer-use-${++this.n}`),
        sessionId: sessionId(s),
        turnId: turn.id,
        kind: "computer-use",
        computerUse: ComputerUseRequest.make({
          state: ComputerUseState.cases.Off.make({}),
          app: "Numbers",
          reason: "To fill in the report",
        }),
        title: "Use Numbers",
        detail: null,
        options: [],
        openedAt: at,
      }),
    });
  }

  answer(s: number, how: "not-now" | "allow") {
    const request = this.pending(s);

    if (request === undefined) return;

    const events = this.decide(s, {
      type: "approval.respond",
      requestId: request.id,
      decision:
        how === "not-now"
          ? ApprovalDecision.cases.Deny.make({ reason: null })
          : ApprovalDecision.cases.Allow.make({ remember: false }),
      resolvedBy: "model",
    });

    if (!events.some((event) => DomainEvent.guards.ApprovalResolved(event))) this.refused++;
  }

  /** The Host turned Ready: the Daemon withdraws every request. */
  ready() {
    for (const s of [0, 1]) {
      const request = this.pending(s);

      if (request !== undefined)
        this.decide(s, {
          type: "harness.approvalWithdrawn",
          requestId: request.id,
          withdrawnBy: "daemon",
          reason: "Computer use is on",
        });
    }
  }

  end(s: number) {
    const turn = workingTurn(this.records[s]!);

    if (turn !== undefined)
      this.decide(s, {
        type: "harness.turnEnded",
        turnId: turn.id,
        status: "completed",
        error: null,
        checkpoint: null,
        at,
      });
  }

  send(s: number) {
    const record = this.records[s]!;

    if (workingTurn(record) === undefined)
      this.decide(s, { type: "turn.send", turn: turnOf(s, ++this.n, record.session.turnCount) });
  }

  observed() {
    const sessions = [0, 1];

    return {
      turns: sessions.filter((s) => workingTurn(this.records[s]!) !== undefined),
      asks: sessions.filter((s) => this.pending(s) !== undefined),
      needsYou: sessions.filter((s) => this.records[s]!.session.state === "needs-you"),
    };
  }
}

const expectedView = (m: Model) => ({
  turns: [0, 1].filter((s) => m.turns.has(s)),
  asks: [0, 1].filter((s) => m.asks.has(s)),
  // Needs You exactly while a request is pending.
  needsYou: [0, 1].filter((s) => m.asks.has(s)),
});

const applyStep = (actual: Actual, m: Model, next: Step) => {
  switch (next.do) {
    case "ask":
      actual.ask(next.s);

      if (m.turns.has(next.s)) m.asks.add(next.s);
      break;
    case "answer":
      actual.answer(next.s, next.how);

      // Allow is refused: the request stays.
      if (next.how === "not-now") m.asks.delete(next.s);
      break;
    case "ready":
      actual.ready();
      m.asks.clear();
      break;
    case "end":
      actual.end(next.s);
      m.turns.delete(next.s);
      m.asks.delete(next.s);
      break;
    case "send":
      actual.send(next.s);
      m.turns.add(next.s);
      break;
  }
};

const session = fc.constantFrom(0, 0, 1);

const step: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: fc.record({ do: fc.constant("ask" as const), s: session }), weight: 3 },
  {
    arbitrary: fc.record({
      do: fc.constant("answer" as const),
      s: session,
      how: fc.constantFrom<"not-now" | "allow">("not-now", "allow"),
    }),
    weight: 2,
  },
  fc.record({ do: fc.constant("ready" as const) }),
  fc.record({ do: fc.constant("end" as const), s: session }),
  fc.record({ do: fc.constant("send" as const), s: session })
);

const RUNS = pbtRuns(300);

test(
  "computer use requests: Needs You while pending, Allow refused, cleared by Not now, Ready or the Turn's end",
  () => {
    let refusedAllows = 0;

    fc.assert(
      fc.property(fc.array(step, { minLength: 20, maxLength: 80 }), (steps) => {
        const actual = new Actual();
        const model: Model = { turns: new Set([0, 1]), asks: new Set() };
        let expectedRefusals = 0;

        for (const next of steps) {
          const pendingBefore = next.do === "answer" && model.asks.has(next.s);
          applyStep(actual, model, next);
          expectedRefusals += pendingBefore && next.do === "answer" && next.how === "allow" ? 1 : 0;
          expect(actual.observed()).toEqual(expectedView(model));
        }

        expect(actual.refused).toBe(expectedRefusals);
        refusedAllows += expectedRefusals;
      }),
      { numRuns: RUNS, ...pbtSeed() }
    );

    // The run must reach a refused Allow, or it proves little about it.
    expect(refusedAllows).toBeGreaterThan(0);
  },
  pbtTimeout(RUNS, 100)
);
