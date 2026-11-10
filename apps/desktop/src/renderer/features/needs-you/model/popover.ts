/**
 * The Needs You popover's copy (Paper X-F 09): each item's kicker ("Codex · approval · 2m",
 * set in mono caps), its sentence, and the footer's status line. Pure, so it is tested.
 */
import type { ApprovalRequest, CelestialBody, HarnessKind } from "@polaris/protocol";
import { harnessHue, sessionCelestial } from "@polaris/ui";
import { Match } from "effect";
import { age } from "../../../shell/copy.ts";
import { dataWants } from "../../data/approval/model.ts";
import type { ConstellationGroup, ConstellationItem, ItemKind } from "./constellation.ts";
import type { AlsoKind, AlsoWaiting, WaitingSession } from "./inbox.ts";

export interface RowCopy {
  readonly harness: HarnessKind;
  readonly body: CelestialBody;
  readonly kicker: ReadonlyArray<string>;
  readonly text: string;
  /** A command, set in mono after the sentence. */
  readonly code: string | null;
}

/** What a waiting session wants, after its title ("Spike review wants to run"). */
export const KIND_WANTS: Record<ApprovalRequest["kind"], string> = {
  command: "wants to run a command",
  "file-change": "wants to change files",
  tool: "wants to use a tool",
  question: "has a question",
  secret: "is asking for a secret",
  app: "wants to use an app",
  "headed-input": "wants headed input",
  "computer-use": "wants computer use",
};

const titleOf = (title: string) => title || "Untitled session";

/** What the request wants: "wants to read analytics" for a Data Source Approval. */
export const wantsOf = (request: ApprovalRequest) => dataWants(request) ?? KIND_WANTS[request.kind];

/** The kicker's word and the sentence for a waiting session's first request. */
const requestCopy = (title: string, request: ApprovalRequest) =>
  Match.value(request.kind).pipe(
    Match.when("question", () => ({ word: "question", text: `${title} asks: ${request.title}` })),
    // A secret's reason stays in its card; the label alone says what it is.
    Match.when("secret", () => ({
      word: "secret",
      text: `${title} is asking for a secret: ${request.title}`,
    })),
    Match.when("command", () => ({ word: "approval", text: `${title} wants to run` })),
    Match.orElse(() => ({ word: "approval", text: `${title} ${wantsOf(request)}` }))
  );

export const waitingCopy = (item: WaitingSession, now: number): RowCopy | null => {
  const { session } = item.entry;
  const request = item.requests[0];

  if (request === undefined) return null;
  const { word, text } = requestCopy(titleOf(session.title), request);
  // The whole request, for every approval: an approval is never answered blind.
  const approval = request.kind !== "question" && request.kind !== "secret";

  return {
    harness: session.harness,
    body: sessionCelestial(session.celestial),
    kicker: [harnessHue(session.harness).name, word, age(item.since, now)],
    text,
    code: approval ? (request.detail ?? request.title) : null,
  };
};

const ALSO_WORD: Record<AlsoKind, string> = {
  failed: "failed",
  "in-terminal": "in terminal",
  interrupted: "interrupted",
};

const alsoText = (item: AlsoWaiting): string => {
  const title = titleOf(item.entry.session.title);

  if (item.kind === "failed")
    return `${title} failed: ${item.entry.session.lastError ?? "the turn errored"}`;

  return item.kind === "in-terminal"
    ? `${title} is in your terminal`
    : `${title} was interrupted when the daemon stopped`;
};

export const alsoCopy = (item: AlsoWaiting, now: number): RowCopy => ({
  harness: item.entry.session.harness,
  body: sessionCelestial(item.entry.session.celestial),
  kicker: [
    harnessHue(item.entry.session.harness).name,
    ALSO_WORD[item.kind],
    age(item.entry.session.updatedAt, now),
  ],
  text: alsoText(item),
  code: null,
});

const CONSTELLATION_WORD: Record<ItemKind, string> = {
  "worker-approval": "approval",
  question: "question",
  lead: "lead",
  claim: "claim",
  unclaimed: "no report",
  stalled: "stalled",
  setup: "setup failed",
  stale: "stale",
  "worker-context": "context",
  "lead-context": "context",
};

/** The Task, or "the lead". */
export const who = (item: ConstellationItem) => item.taskId ?? "the lead";

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const constellationText = (item: ConstellationItem): string => {
  const it = who(item);

  if (item.request?.kind === "secret" && (item.kind === "worker-approval" || item.kind === "lead"))
    return sentence(`${it} is asking for a secret: ${item.request.title}`);

  const text = {
    "worker-approval": `${it} wants to run`,
    question: `${it} asks: ${item.question?.text ?? item.request?.title ?? ""}`,
    lead:
      item.request?.kind === "question"
        ? `The lead asks: ${item.request.title}`
        : "The lead wants to run",
    claim:
      item.worker?.state === "handed-up"
        ? `The lead handed ${it}'s claim to you`
        : `${it} claimed; the constellation is paused`,
    unclaimed: `${it} stopped without reporting back`,
    stalled: `${it} stalled before its first turn`,
    setup: `${it} setup failed`,
    stale: `${it} went stale: its host is offline`,
    "worker-context": `${it} is near its context limit`,
    "lead-context": "The lead is near its context limit",
  }[item.kind];

  return sentence(text);
};

/** An approval the Constellation item is blocked on, answered in place. */
export const constellationApproval = (item: ConstellationItem) =>
  item.request !== undefined &&
  item.request.kind !== "question" &&
  item.request.kind !== "secret" &&
  (item.kind === "worker-approval" || item.kind === "lead");

export const leadName = (group: ConstellationGroup) =>
  group.lead?.session.title || `${group.view.constellation.name} lead`;

export const constellationCopy = (
  group: ConstellationGroup,
  item: ConstellationItem,
  now: number
): RowCopy => {
  const session = item.entry?.session ?? group.lead?.session;
  const harness = session?.harness ?? "claude";

  return {
    harness,
    body: sessionCelestial(session?.celestial, item.entry === null),
    kicker: [
      leadName(group),
      item.request?.kind === "secret" ? "secret" : CONSTELLATION_WORD[item.kind],
      age(item.since, now),
    ],
    text: constellationText(item),
    code: constellationApproval(item) ? (item.request?.detail ?? item.request?.title ?? "") : null,
  };
};

/** Where and since when an item waits, for the footer. */
export interface Waited {
  readonly hostKey: string;
  readonly since: string;
}

/** "3 waiting · oldest 9m · 2 hosts" (Paper X-F 09's footer). */
export const popoverStatus = (items: ReadonlyArray<Waited>, now: number): string => {
  if (items.length === 0) return "nothing waiting";
  const oldest = items.reduce((a, b) => (b.since < a ? b.since : a), items[0]?.since ?? "");
  const hosts = new Set(items.map((i) => i.hostKey)).size;

  return [
    `${items.length} waiting`,
    `oldest ${age(oldest, now)}`,
    hosts === 1 ? "1 host" : `${hosts} hosts`,
  ].join(" · ");
};
