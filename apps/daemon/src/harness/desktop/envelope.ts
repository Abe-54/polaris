/**
 * agent-desktop's JSON envelope (`ok` with `data`, or `ok: false` with `error`), and the tool
 * result Polaris makes of it: the envelope as text, a screenshot as an image, and a hint.
 */
import type { ComputerUseCall } from "@polaris/protocol";
import { Option, Predicate, Schema } from "effect";

export const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({
      code: Schema.String,
      message: Schema.String,
      suggestion: Schema.optionalKey(Schema.String),
    })
  ),
});

export type Envelope = typeof Envelope.Type;

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope));

/** The last line that is an envelope: agent-desktop prints one, after any log lines. */
export const envelopeOf = (stdout: string): Option.Option<Envelope> => {
  const lines = stdout.trim().split("\n").reverse();

  for (const line of lines) {
    const decoded = decodeEnvelope(line);

    if (Option.isSome(decoded)) return decoded;
  }

  return Option.none();
};

export type DesktopContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface DesktopResult {
  readonly content: ReadonlyArray<DesktopContent>;
  readonly isError?: boolean;
}

export const failure = (message: string): DesktopResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

export const HEADED_HINT =
  "This app exposes no accessibility tree to act on. Take a screenshot of its screen, then use the headed tools (mouse_click, hover, drag, physical_click, physical_type) at the coordinates it shows. They need the user's approval.";

const SnapshotData = Schema.Struct({ ref_count: Schema.Number });

const decodeSnapshot = Schema.decodeUnknownOption(SnapshotData);

/** A snapshot with nothing to act on, or an action the element can't do, means: go headed. */
export const needsHeaded = (envelope: Envelope): boolean => {
  if (!envelope.ok) return envelope.error?.code === "ACTION_NOT_SUPPORTED";

  if (envelope.command !== "snapshot") return false;

  return Option.match(decodeSnapshot(envelope.data), {
    onNone: () => false,
    onSome: (data) => data.ref_count === 0,
  });
};

export const ScreenshotData = Schema.Struct({
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  scale_factor: Schema.optionalKey(Schema.Number),
});

export type ScreenshotData = typeof ScreenshotData.Type;

const decodeScreenshot = Schema.decodeUnknownOption(ScreenshotData);

/** A screenshot's base64 image, taken out of the envelope so the text stays small. */
export const imageOf = (envelope: Envelope) =>
  envelope.ok && envelope.command === "screenshot"
    ? Option.getOrNull(decodeScreenshot(envelope.data))
    : null;

export interface ResultParts {
  readonly envelope: Envelope;
  /** What the call's Tool Call records; the translators read it back (`computerUseCallOf`). */
  readonly computerUse: typeof ComputerUseCall.Encoded;
  readonly image?: { readonly data: string; readonly mimeType: string } | null;
  readonly note?: string | null;
}

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown));

const withoutImage = (envelope: Envelope): Envelope => {
  if (imageOf(envelope) === null) return envelope;

  return Option.match(decodeRecord(envelope.data), {
    onNone: () => envelope,
    onSome: ({ data: _data, ...rest }) => ({ ...envelope, data: rest }),
  });
};

export const resultOf = (parts: ResultParts): DesktopResult => {
  const envelope = withoutImage(parts.envelope);
  const hint = needsHeaded(parts.envelope) ? HEADED_HINT : null;
  const notes = [parts.note, hint].filter(Predicate.isNotNullish);
  // JSON.stringify drops a note that is undefined.

  const body = {
    ...envelope,
    polaris_note: notes.length > 0 ? notes.join(" ") : undefined,
    computer_use: parts.computerUse,
  };

  const content: Array<DesktopContent> = [{ type: "text", text: JSON.stringify(body) }];

  if (parts.image) content.push({ type: "image", ...parts.image });

  return envelope.ok ? { content } : { content, isError: true };
};
