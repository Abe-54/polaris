/**
 * The composer gallery's worst case (break-ui, ENG-534): realistic data at the limits the
 * protocol allows, for `-polarisDevComposer worst…`. Development builds only.
 */
import {
  ApprovalQuestion,
  type ApprovalRequest,
  ContextUsage,
  type HarnessKind,
  Model,
  ModelId,
  QuestionOption,
  RequestId,
  Subagent,
  SubagentId,
  TurnId,
} from "@polaris/protocol";
import { request, sessionId } from "../thread/daemon.testing.ts";
import type { Chip } from "./attach.ts";

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

/** A Harness this build doesn't list: the strip and chip fall back to its kind. */
export const UNKNOWN_HARNESS: HarnessKind = "acme-research-agent";

/** The chip's label when a Harness names only the Model's id. */
export const LONG_MODEL = "claude-opus-5-5-20261015-thinking[1m]";

const LONG_COMMAND = [
  "cd /Users/aleksandra.wisniewska-kowalczyk/code/northwind-industries-holdings/platform",
  "POLARIS_HOME=/tmp/polaris-e2e-9f8e7d6c bun run --cwd apps/daemon test -- --filter 'engine/approvals'",
  "git log --oneline origin/main..HEAD | wc -l",
  "rm -rf node_modules/.cache/turbo && bun install --frozen-lockfile",
].join("\n");

const QUESTION = [
  "Before I migrate the event store, which of these should I keep exactly as it is today? ",
  "The migration rewrites every Turn's envelope, so whatever isn't kept will be re-derived from ",
  "the folded events, and the Desktop App's history view will show the re-derived version. ",
  "Czy mam zachować również stare identyfikatory poleceń (CommandId) dla wznowień? 🚧",
].join("");

const question = (
  header: string,
  text: string,
  labels: ReadonlyArray<string>,
  multiSelect: boolean
) =>
  new ApprovalQuestion({
    header,
    question: text,
    options: labels.map((label) => new QuestionOption({ label, description: null })),
    multiSelect,
  });

const QUESTIONS = [
  question(
    "Event store migration scope",
    QUESTION,
    [
      "Keep everything",
      "Keep the envelopes only",
      "Re-derive the Turn summaries from the folded events and rebuild every snapshot",
      "Ask me again per Workspace",
      "Zachowaj identyfikatory",
      "إبقاء المعرفات القديمة",
      "保留旧的标识符",
      "🦊 Skip",
      "Other",
    ],
    true
  ),
  question("", "And the backups?", ["Keep 7 days", "Keep 30 days", "Delete them"], false),
];

/** Six open requests: subagents' and the lead's, short, long, disguised, a question and a tool. */
export const WORST_REQUESTS: ReadonlyArray<ApprovalRequest> = [
  request({
    id: RequestId.make("w-1"),
    detail: LONG_COMMAND,
    openedAt: ago(300),
  }),
  request({
    id: RequestId.make("w-2"),
    // A short command hiding a right-to-left override: the strip must not offer it compact.
    detail: "cat ‮gnp.exe",
    openedAt: ago(240),
  }),
  request({ id: RequestId.make("w-3"), detail: "ls", openedAt: ago(200) }),
  request({
    id: RequestId.make("w-4"),
    kind: "file-change",
    title: "Edit 14 files",
    detail:
      "packages/protocol/src/domain/approvals/requests/ApprovalRequestWithSubagentAttribution.ts",
    openedAt: ago(120),
  }),
  request({
    id: RequestId.make("w-5"),
    kind: "question",
    title: "Which scope?",
    options: [],
    questions: QUESTIONS,
    openedAt: ago(60),
  }),
  request({
    id: RequestId.make("w-6"),
    kind: "tool",
    title: "mcp__northwind-industries-holdings-linear__create_issue_with_attachments",
    detail: null,
    openedAt: ago(10),
  }),
];

export const WORST_QUESTION: ReadonlyArray<ApprovalRequest> = [
  request({
    id: RequestId.make("q-1"),
    kind: "question",
    title: "Which scope?",
    questions: QUESTIONS,
    openedAt: ago(30),
  }),
];

/** A Secret Request at its limits: a long label, a reason of several lines, an unbroken hint. */
export const WORST_SECRET: ReadonlyArray<ApprovalRequest> = [
  request({
    id: RequestId.make("k-1"),
    kind: "secret",
    title: "Northwind Industries production Stripe restricted key (read-only, payouts and balance)",
    detail: [
      "I need it to reconcile last month's payouts against the ledger export in /Users/aleksandra.wisniewska-kowalczyk/code/northwind-industries-holdings/platform. ",
      "Everything that doesn't need Stripe is done; the reconciliation script waits on this key. ",
      "Klucz tylko do odczytu wystarczy. 🔑",
    ].join(""),
    placeholder: "northwind-restricted-key-read-only-payouts-and-balance-0000000000000000",
    openedAt: ago(40),
  }),
  request({
    id: RequestId.make("k-2"),
    kind: "secret",
    title: "密钥",
    detail: null,
    openedAt: ago(10),
  }),
];

export const ONE_SHORT_REQUEST: ReadonlyArray<ApprovalRequest> = [
  request({ id: RequestId.make("o-1"), detail: "ls", openedAt: ago(5) }),
];

const TITLES = [
  "Explore the event store",
  "Review approvals",
  "Przejrzyj migrację",
  "مراجعة الأذونات",
  "检查快照",
];

/** Twenty working Subagents, as a wide fan-out reports them. */
export const TWENTY_SUBAGENTS: ReadonlyArray<Subagent> = Array.from(
  { length: 20 },
  (_, n) =>
    new Subagent({
      id: SubagentId.make(`w-${n}`),
      sessionId,
      turnId: TurnId.make("t-1"),
      parentItemId: null,
      title: TITLES[n % TITLES.length] ?? "Helper",
      agent: "Explore",
      model: null,
      status: "working",
      startedAt: ago(200 - n),
      endedAt: null,
    })
);

/** Past the window: the Harness counts the summary it is about to compact. */
export const OVER_FULL = new ContextUsage({ usedTokens: 231_400, windowTokens: 200_000 });

export const EXACTLY_FULL = new ContextUsage({ usedTokens: 200_000, windowTokens: 200_000 });

export const EMPTY_CONTEXT = new ContextUsage({ usedTokens: 0, windowTokens: 200_000 });

/** No window yet, a shade under a million tokens used. */
export const NO_WINDOW = new ContextUsage({ usedTokens: 999_800, windowTokens: null });

const PARAGRAPH =
  "Aleksandra Wiśniewska-Kowalczyk: przenieś testy do nowego katalogu, potem uruchom je ponownie. " +
  "نور الهدى: please keep the Arabic copy right-to-left. 👩🏽‍💻 Đặng Thị Ngọc Hân checked the snapshots. ";

/** A pasted 10,000-character draft. */
export const LONG_DRAFT = PARAGRAPH.repeat(Math.ceil(10_000 / PARAGRAPH.length)).slice(0, 10_000);

const NAMES = [
  "IMG_20261028_183022_HDR_portrait_edited_edited.HEIC",
  "Q3 Board Deck — FINAL (revised) v12 [approved by legal].pdf",
  "a.png",
  "event-store-migration-plan-2026-10-29-draft-3.md",
  "Zrzut ekranu 2026-10-29 o 14.02.11.png",
  "لقطة الشاشة.png",
  "crash.log",
  "northwind-industries-holdings-platform-architecture-diagram-final.svg",
  "IMG_0001.JPG",
  "IMG_0002.JPG",
  "notes.txt",
  "trace-9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f.json",
];

const STATUSES = new Map<number, Chip["status"]>([
  [4, "failed"],
  [5, "staging"],
]);

/** Twelve attachments: long camera names, one failed, one still staging. */
export const MANY_CHIPS: ReadonlyArray<Chip> = NAMES.map((name, n) => ({
  key: `chip-${n}`,
  name,
  size: n === 2 ? 94 : 3_400_000 + n * 1_234_567,
  thumbnailUri: null,
  status: STATUSES.get(n) ?? "staged",
  attachment: null,
  failure: n === 4 ? "The Host refused the file: it's larger than 25 MB" : null,
}));

/** A dropped send as the controller reports it: nothing resends it, so it is a failure until Send. */
export const LONG_ERROR =
  "Couldn't send: the daemon on lucas-rpi closed the connection while the turn was on its way. Send again once the host is back.";

/** Models with long names and descriptions, and one with many efforts. */
export const LONG_MODELS = [
  new Model({
    id: ModelId.make(LONG_MODEL),
    name: "Claude Opus 5.5 (1M context, extended thinking, October 2026 snapshot)",
    description:
      "Most capable for long agentic coding sessions, large refactors across a monorepo and research that needs the whole context window",
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    isDefault: true,
  }),
  new Model({
    id: ModelId.make("sonnet"),
    name: "Sonnet 5.5",
    description: null,
    efforts: [],
    defaultEffort: null,
    isDefault: false,
  }),
  ...Array.from(
    { length: 10 },
    (_, n) =>
      new Model({
        id: ModelId.make(`local-${n}`),
        name: `qwen3-coder-480b-a35b-instruct-q4_k_m-${n}`,
        description: "Local · Ollama on lucas-rpi",
        efforts: [],
        defaultEffort: null,
        isDefault: false,
      })
  ),
];
