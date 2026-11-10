/** What a Polaris tool row shows (DESIGN.md, Polaris tools in the conversation). */
import type { TurnItem } from "@polaris/protocol";

export type ToolCallItem = Extract<TurnItem, { readonly _tag: "ToolCall" }>;

/** One run of text on the row or in its well. */
export interface Segment {
  readonly text: string;
  /** Ids, heads, commands and paths are set in mono. */
  readonly mono?: boolean;
  /** `failed` only for a failed check or exit code; `faint` for what reads quieter still. */
  readonly tone?: "failed" | "faint";
  /** A Harness kind: its hue dot leads the text (the worker it names). */
  readonly hue?: string;
}

export interface FieldRow {
  readonly label: string;
  readonly value: ReadonlyArray<Segment>;
}

export interface CheckMark {
  readonly label: string;
  /** `reported`: the worker said so; Polaris didn't see the command run. */
  readonly state: "passed" | "failed" | "reported";
}

export interface TaskLine {
  readonly id: string;
  readonly title: string;
  readonly note: ReadonlyArray<Segment>;
  /** What the call did to it: "added", "edited", "canceled", or the worker it went to. */
  readonly change: ReadonlyArray<Segment>;
  readonly struck?: boolean;
}

export interface TurnLine {
  /** "Turn 4 · completed · 13:52". */
  readonly heading: string;
  readonly reply: string | null;
  readonly commands: ReadonlyArray<string>;
}

/** What opening the row shows, built from the call's input and Polaris's reply. */
export type Well =
  | {
      readonly kind: "fields";
      readonly text: string | null;
      readonly rows: ReadonlyArray<FieldRow>;
      readonly checks: ReadonlyArray<CheckMark>;
    }
  | {
      readonly kind: "tasks";
      readonly heading: string | null;
      readonly rows: ReadonlyArray<TaskLine>;
    }
  | { readonly kind: "tail"; readonly text: string }
  | { readonly kind: "banner"; readonly title: string; readonly body: string }
  | { readonly kind: "turns"; readonly turns: ReadonlyArray<TurnLine> }
  | { readonly kind: "history"; readonly rows: ReadonlyArray<HistoryRow> };

/** A session a history row names, which opens from it. */
export interface SessionRef {
  readonly id: string;
  readonly title: string;
}

/** A session `sessions` listed, or a match `search_history` found: where, then what. */
export interface HistoryRow {
  readonly session: SessionRef | null;
  /** "Turn 4 · reply · 13:52", or the session's Harness, state and Turns. */
  readonly heading: string;
  readonly text: string | null;
}

/** A link in the well's foot: opens a Task's worker in the Lead's Intent column. */
export interface TaskLink {
  readonly label: string;
  readonly taskId: string;
}

/** The row's line before Polaris answers: the verb in each phase, then its subject. */
export interface Head {
  readonly verbs: readonly [pending: string, done: string, refused: string];
  readonly subject: Segment | null;
  readonly detail: ReadonlyArray<Segment>;
  /** Right-aligned, faint: the one state worth reading folded ("banner shown"). */
  readonly caption: string | null;
}

export interface Built {
  readonly head: Head;
  readonly well: Well | null;
  readonly links: ReadonlyArray<TaskLink>;
  /** Sessions the foot opens (the one `read_history` read); none if absent. */
  readonly sessions?: ReadonlyArray<SessionRef>;
}

/** Polaris refused the call: its finding, which the agent reads and acts on. */
export interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly fix: string | null;
}

export interface PolarisToolView {
  /** The tool's own name (`dispatch`), whichever Harness called it. */
  readonly tool: string;
  readonly phase: "pending" | "done" | "refused";
  readonly verb: string;
  readonly subject: Segment | null;
  readonly detail: ReadonlyArray<Segment>;
  readonly caption: string | null;
  readonly well: Well | null;
  readonly refusal: Refusal | null;
  /** Polaris's reply in words ("Plan recorded · revision 8"); null while pending. */
  readonly reply: string | null;
  readonly links: ReadonlyArray<TaskLink>;
  /** Sessions the foot opens, on the row's own Host. */
  readonly sessions: ReadonlyArray<SessionRef>;
  /** A `notify` call's title and body, which find its banner in the Desktop App's record. */
  readonly notice: { readonly title: string; readonly body: string } | null;
  /** Behind Show raw: the real name, input and result. */
  readonly raw: { readonly name: string; readonly input: string; readonly output: string };
}
