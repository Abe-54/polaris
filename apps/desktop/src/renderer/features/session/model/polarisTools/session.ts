/** The tools over the session itself: `wait_for_command`, `notify` and `request_secret`. */
import type { SecretOutcome } from "../../../../store/sessionModel.ts";
import { polarisTool } from "../runs.ts";
import { decodeInput, type NotifyInput, RequestSecretInput, type WaitInput } from "./inputs.ts";
import { outputText, parseResult, type ToolResult } from "./result.ts";
import type { Built, Head, PolarisToolView, Segment, ToolCallItem } from "./types.ts";
import { count } from "./words.ts";
import { clientCopy } from "../../../../../shared/clientCopy.ts";

const FINISHED = /^Finished: (.+?)(?: \((?:exit (-?\d+)|(\w+))\))?$/;

const STILL = /^Still running after (\d+)s:$/;

const RUNNING = /^- [^:]+: (.+)$/;

interface Finished {
  readonly description: string;
  readonly exit: number | null;
}

const finishedOf = (lines: ReadonlyArray<string>): ReadonlyArray<Finished> =>
  lines.flatMap((line) => {
    const match = FINISHED.exec(line);

    if (match === null) return [];

    return [
      { description: match[1] ?? "", exit: match[2] === undefined ? null : Number(match[2]) },
    ];
  });

const exitSegment = (exit: number | null): ReadonlyArray<Segment> => {
  if (exit === null) return [];

  const segment: Segment = { text: `· exit ${exit}` };

  return [exit === 0 ? segment : { ...segment, tone: "failed" }];
};

const finishedHead = (all: ReadonlyArray<Finished>, waiting: Head["verbs"]): Head => {
  const [only] = all;

  if (all.length === 1 && only !== undefined)
    return {
      verbs: [waiting[0], "Waited for", waiting[2]],
      subject: { text: only.description, mono: true },
      detail: exitSegment(only.exit),
      caption: null,
    };

  const failed = all.filter((f) => f.exit !== null && f.exit !== 0).length;

  return {
    verbs: [waiting[0], `Waited for ${count(all.length, "command")}`, waiting[2]],
    subject: null,
    detail: failed > 0 ? [{ text: `· ${failed} failed`, tone: "failed" }] : [],
    caption: null,
  };
};

const doneHead = (lines: ReadonlyArray<string>, waiting: Head["verbs"]): Head => {
  const finished = finishedOf(lines);

  if (finished.length > 0) return finishedHead(finished, waiting);
  const still = STILL.exec(lines[0] ?? "");

  if (still !== null) {
    const running = lines.flatMap((line) => RUNNING.exec(line)?.[1] ?? []);

    return {
      verbs: [waiting[0], `Waited ${still[1]}s`, waiting[2]],
      subject: running[0] === undefined ? null : { text: running[0], mono: true },
      detail: [
        {
          text:
            running.length > 1
              ? `and ${running.length - 1} more are still running`
              : "is still running",
        },
      ],
      caption: "timed out, not failed",
    };
  }

  return {
    verbs: [waiting[0], "Nothing was running to wait for", waiting[2]],
    subject: null,
    detail: [],
    caption: null,
  };
};

export const waitForCommand = (
  { task, timeoutSeconds = 45 }: typeof WaitInput.Type,
  result: ToolResult | null
): Built => {
  const waiting: Head["verbs"] = [
    "Waiting on",
    "Waited on",
    task === undefined ? "wait on background commands" : "wait on",
  ];

  const pending: Head = {
    verbs: waiting,
    subject: { text: task ?? "background commands", mono: task !== undefined },
    detail: [],
    caption: `up to ${timeoutSeconds}s`,
  };

  if (result === null || result.refusal !== null) return { head: pending, well: null, links: [] };

  const lines = [result.summary, ...result.body];

  const tail = lines.filter(
    (line) => !FINISHED.test(line) && !STILL.test(line) && !RUNNING.test(line)
  );

  return {
    head: doneHead(lines, waiting),
    well:
      finishedOf(lines).length === 0 || tail.length === 0
        ? null
        : { kind: "tail", text: tail.join("\n") },
    links: [],
  };
};

/** Whether the Desktop App showed a notify banner, from its own record (`agentBanners`). */
export type BannerRecord = "shown" | "here" | "off";

const BANNER_CAPTION = new Map<BannerRecord, string>([
  ["shown", "banner shown"],
  ["here", "no banner, you were here"],
]);

const BANNER_REPLY = new Map<BannerRecord, string>([
  ["shown", `shown as a banner on ${clientCopy().machine}`],
  ["here", "no banner: you were in this session"],
  ["off", "no banner: notifications are off"],
]);

export const notify = (
  { title = "", body = "" }: typeof NotifyInput.Type,
  result: ToolResult | null
): Built => {
  const again = result?.summary.startsWith("This notification was already sent") === true;

  return {
    head: {
      verbs: ["Notifying you", "Notified you", "notify you"],
      subject: title === "" ? null : { text: title },
      detail: [],
      caption: again ? "already sent" : null,
    },
    well: title === "" ? null : { kind: "banner", title, body },
    links: [],
  };
};

/** A sent notification's row with the Desktop App's record of its banner. */
export const withBanner = (view: PolarisToolView, banner: BannerRecord | null): PolarisToolView => {
  if (view.tool !== "notify" || view.phase !== "done" || banner === null) return view;

  return {
    ...view,
    caption: view.caption ?? BANNER_CAPTION.get(banner) ?? null,
    reply: `Sent · ${BANNER_REPLY.get(banner) ?? ""}`,
  };
};

/** How a Secret Request ended, from Polaris's reply to the agent (`mcp/tools/secret.ts`). */
const SECRET_ENDINGS: ReadonlyArray<
  readonly [prefix: string, caption: string, outcome: SecretOutcome]
> = [
  ["Saved.", "saved securely", "provided"],
  ["The user declined", "declined", "declined"],
  ["No answer in", "timed out", "ended"],
  ["The request ended unanswered", "ended", "ended"],
];

const endingOf = (summary: string) => SECRET_ENDINGS.find(([prefix]) => summary.startsWith(prefix));

/**
 * A finished `request_secret` call's label and how it ended, read from Polaris's reply, so a
 * Secret Request's answered state outlives the feed that saw it (ENG-631); null otherwise.
 */
export const secretEnding = (
  item: ToolCallItem
): { readonly label: string; readonly outcome: SecretOutcome } | null => {
  if (polarisTool(item.name) !== "request_secret" || item.status === "running") return null;
  const ending = endingOf(parseResult(outputText(item))?.summary ?? "");
  const { label = "" } = decodeInput(RequestSecretInput, item);

  return ending === undefined || label === "" ? null : { label, outcome: ending[2] };
};

/** `request_secret`: the label it asked for and how it ended; never a value, which it never sees. */
export const requestSecret = (
  { label = "" }: typeof RequestSecretInput.Type,
  result: ToolResult | null
): Built => {
  const summary = result?.summary ?? "";

  return {
    head: {
      verbs: ["Asking you for a secret", "Asked you for a secret", "ask you for a secret"],
      subject: label === "" ? null : { text: label },
      detail: [],
      caption: endingOf(summary)?.[1] ?? null,
    },
    well: null,
    links: [],
  };
};
