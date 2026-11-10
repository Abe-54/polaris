/**
 * The row gallery's rows and cards (home/ui/Gallery.tsx), built from Home's fixtures. A testing
 * module, so a release bundle drops it (ENG-555).
 */
import type { ApprovalRequest } from "@polaris/protocol";
import {
  commandApproval,
  constellation,
  minutesAgo,
  NOW,
  question,
  type SessionInput,
  session,
} from "../fixtures.testing.ts";
import type { ConstellationRow, SessionRow as Row } from "../model/home.ts";

const row = (
  input: SessionInput & { readonly minutes: number },
  extra: { readonly approval?: ApprovalRequest; readonly preview?: string } = {}
): Row => ({
  kind: "session",
  key: input.id,
  hostId: "gallery",
  hostName: "mac-studio",
  workspaceName: "polaris",
  session: session({ ...input, updatedAt: minutesAgo(input.minutes) }),
  approval: extra.approval ?? null,
  replyPreview: extra.preview ?? null,
  since: NOW - input.minutes * 60_000,
  stale: false,
});

export const ROWS: ReadonlyArray<readonly [string, Row]> = [
  [
    "working",
    row(
      { id: "w", title: "Polaris planning", state: "working", turnCount: 24, minutes: 1 },
      { preview: "Writing index.html" }
    ),
  ],
  [
    "needs you",
    row(
      {
        id: "n",
        title: "Spike GPUI review screen",
        state: "needs-you",
        harness: "codex",
        minutes: 42,
      },
      { approval: commandApproval("n", "r1", "cargo build") }
    ),
  ],
  [
    "done",
    row({
      id: "d",
      title: "Mobile chrome redesign",
      harness: "codex",
      turnCount: 3,
      acceptedThroughIndex: 0,
      minutes: 12,
    }),
  ],
  [
    "failed",
    row({
      id: "f",
      title: "Fix flaky resume test",
      state: "failed",
      lastError: "exit 1 in bun test",
      minutes: 60,
    }),
  ],
  [
    "dormant",
    row({
      id: "z",
      title: "Glossary first pass for the Mobile App onboarding copy",
      state: "dormant",
      minutes: 1440,
    }),
  ],
  [
    "stale (host reconnecting)",
    {
      ...row({ id: "s", title: "Route hosts through the Polaris Relay", minutes: 4 }),
      stale: true,
    },
  ],
];

export const CONSTELLATION: ConstellationRow = {
  kind: "constellation",
  key: "c",
  hostId: "gallery",
  hostName: "mac-studio",
  constellation: constellation("Orchestrator overhaul", "lead"),
  lead: session({ id: "lead", state: "working" }),
  since: NOW,
  stale: false,
};

export const HERO = row(
  {
    id: "c1",
    title: "Spike GPUI review screen",
    state: "needs-you",
    harness: "codex",
    minutes: 42,
  },
  { approval: commandApproval("c1", "r2", "cargo build --release") }
);

export const INBOX = row(
  { id: "c2", title: "Fix eligibility form validation", state: "needs-you", minutes: 18 },
  {
    approval: question("c2", "r3", "Monthly or annual household income?", ["Annual", "Monthly"]),
  }
);
