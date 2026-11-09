/**
 * One row of the thread (MX-E): turn text on the open ground, a message, a tool step or a run of
 * them in a well, and a finished Turn's receipt; a finished Turn's long-press menu (MX-J).
 */
import type { Attachment, CelestialBody, HarnessKind } from "@polaris/protocol";
import { mobileType } from "@polaris/ui/tokens";
import { Match } from "effect";
import { memo, type ReactNode, useState } from "react";
import { type LayoutChangeEvent, Pressable, Text, View } from "react-native";
import { Thumbnails } from "../attachments/index.ts";
import { Celestial } from "../celestial";
import { Markdown } from "../markdown/index.ts";
import { type BubbleState, BubbleFootnote, useBubbleTreatment } from "../states/thread.tsx";
import { LongPressMenu, type MenuAction, turnMenu } from "../menus/index.ts";
import { type MobileColours, themedStyles } from "../theme/index.ts";
import { type ThreadRow, type TurnFacts, turnHeading } from "./rows.ts";
import { CONTENT_TEXT_SCALE } from "../theme/textScale.ts";
import { VisualizationCard } from "../visualization/index.ts";

// The arrow defers `makeStyles`, which is defined at the foot of the module.
const useStyles = themedStyles((colours) => makeStyles(colours));

type Styles = ReturnType<typeof useStyles>;

/** The Critical diamond: an 8pt square turned 45°. */
export const Diamond = () => <View style={useStyles().diamond} />;

/** The well a group of steps sits in: its first row opens it, its last closes it. */
const wellOf = (styles: Styles, row: { readonly first: boolean; readonly last: boolean }) => [
  styles.well,
  row.first ? styles.wellFirst : null,
  row.last ? styles.wellLast : null,
];

/** Finished calls folded into one line (DESIGN.md, Tool runs): a faint check, the summary, a chevron. */
const Run = ({
  row,
  onToggle,
}: {
  readonly row: Extract<ThreadRow, { kind: "run" }>;
  readonly onToggle: (key: string) => void;
}) => {
  const styles = useStyles();

  return (
    <View style={wellOf(styles, row)}>
      <Pressable
        style={styles.step}
        onPress={() => onToggle(row.key)}
        accessibilityRole="button"
        accessibilityState={{ expanded: row.open }}
        accessibilityLabel={row.summary}
      >
        <Text style={styles.check}>✓</Text>
        <Text
          style={styles.runSummary}
          numberOfLines={2}
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          {row.summary}
        </Text>
        <Text style={[styles.chevron, row.open ? styles.chevronOpen : null]}>›</Text>
      </Pressable>
    </View>
  );
};

/** What a tapped step or finding puts in focus, for the iPhone Duo's second half (D6). */
export interface ThreadFocus {
  readonly key: string;
  readonly turnId: string;
  readonly kind: "step" | "finding";
  readonly label: string;
  readonly paths: ReadonlyArray<string>;
}

/** The session's celestial, which works beside the step in flight. */
export interface RowSession {
  readonly hostId: string;
  readonly sessionId: string;
  readonly body: CelestialBody;
  readonly harness: HarnessKind;
}

const StepMark = ({
  row,
  session,
}: {
  readonly row: Extract<ThreadRow, { kind: "step" }>;
  readonly session: RowSession | undefined;
}) => {
  const styles = useStyles();

  if (row.tone === "active" && session !== undefined)
    return (
      <View style={styles.markSlot}>
        <Celestial body={session.body} harness={session.harness} size={16} working />
      </View>
    );

  return (
    <Text style={[styles.check, row.tone === "failed" ? styles.failed : null]}>
      {row.tone === "failed" ? "✕" : "✓"}
    </Text>
  );
};

const TONE_WORDS = { done: "done", active: "running", failed: "failed" } as const;

/** "bun test, exit 137": what VoiceOver reads for a step, instead of its ✓ or ✕ glyph. */
const stepLabel = (row: Extract<ThreadRow, { kind: "step" }>) =>
  `${row.label}, ${row.detail === "" ? TONE_WORDS[row.tone] : row.detail}`;

const Step = ({
  row,
  critical,
  focused,
  onFocus,
  session,
}: {
  readonly row: Extract<ThreadRow, { kind: "step" }>;
  readonly critical: boolean;
  readonly focused: boolean;
  readonly onFocus: ((focus: ThreadFocus) => void) | undefined;
  readonly session: RowSession | undefined;
}) => {
  const styles = useStyles();

  return (
    <View style={wellOf(styles, row)}>
      <Pressable
        disabled={onFocus === undefined}
        onPress={() =>
          onFocus?.({
            key: row.key,
            turnId: row.turnId,
            kind: "step",
            label: row.label,
            paths: row.paths,
          })
        }
        accessibilityLabel={stepLabel(row)}
        accessibilityRole={onFocus === undefined ? undefined : "button"}
        accessibilityState={onFocus === undefined ? undefined : { selected: focused }}
        style={[styles.step, focused ? styles.stepFocused : null]}
      >
        <StepMark row={row} session={session} />
        <Text
          style={[styles.stepLabel, row.tone === "active" ? styles.stepActive : null]}
          numberOfLines={1}
          ellipsizeMode="middle"
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          {row.label}
        </Text>
        {critical ? <Diamond /> : null}
        {row.detail === "" ? null : (
          <Text
            style={row.tone === "failed" ? styles.stepFailed : styles.stepDetail}
            maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          >
            {row.detail}
          </Text>
        )}
      </Pressable>
    </View>
  );
};

export interface RowProps {
  readonly row: ThreadRow;
  /** Paths an open Critical finding is in. */
  readonly criticalPaths: ReadonlySet<string>;
  /** Opens or folds a run, by its key. */
  readonly onToggle: (key: string) => void;
  /** Makes step rows pressable; the iPhone Duo's second half follows them. */
  readonly onFocus?: ((focus: ThreadFocus) => void) | undefined;
  readonly focused?: boolean;
  /** Takes a steer that didn't land back into the composer, by its id. */
  readonly onEditSteer?: ((id: string) => void) | undefined;
  /** Sends a failed Turn again, by its id. */
  readonly onSendAgain?: ((id: string) => void) | undefined;
  /** The Host's name, for "Queued · sends when <host> is back". */
  readonly hostName?: string;
  /** The session's Host, which holds the images its messages carried. */
  readonly hostId: string;
  /** The session, for the step in flight and a finished Turn's menu. */
  readonly session?: RowSession | undefined;
  /** Runs what a finished Turn's long-press menu chose. */
  readonly onMenuAction?: ((action: MenuAction) => void) | undefined;
  /** Visualization ids a later one replaces. */
  readonly revised?: ReadonlySet<string>;
  /** Row keys of the Visualizations that may hold a live WebView. */
  readonly liveFrames?: ReadonlySet<string>;
}

const NONE: ReadonlySet<string> = new Set();

const Bubble = ({
  text,
  note,
  hostId,
  attachments = [],
  faded = false,
  failed = false,
}: {
  readonly text: string;
  readonly note: string | null;
  readonly hostId: string;
  readonly attachments?: ReadonlyArray<Attachment>;
  readonly faded?: boolean;
  readonly failed?: boolean;
}) => {
  const styles = useStyles();

  return (
    <View style={[styles.promptLine, faded ? styles.faded : null]}>
      <Thumbnails hostId={hostId} attachments={attachments} />
      {text.trim() === "" ? null : (
        <View style={styles.prompt}>
          <Text style={styles.promptText} selectable>
            {text}
          </Text>
        </View>
      )}
      {note === null ? null : (
        <Text style={[styles.note, failed ? styles.noteFailed : null]}>{note}</Text>
      )}
    </View>
  );
};

/** A Turn on its way (MX-AV): queued under its bubble while the Host is away, or failed and outlined. */
const SendBubble = ({
  row,
  hostId,
  hostName,
  onSendAgain,
}: {
  readonly row: Extract<ThreadRow, { kind: "send" }>;
  readonly hostId: string;
  readonly hostName: string;
  readonly onSendAgain: ((id: string) => void) | undefined;
}) => {
  const styles = useStyles();
  const { waiting } = row;

  const state =
    waiting === null
      ? null
      : Match.value(waiting).pipe(
          Match.discriminatorsExhaustive("kind")({
            queued: (): BubbleState => ({ kind: "queued", host: hostName }),
            failed: ({ error }): BubbleState => ({
              kind: "failed",
              message: error,
              onSendAgain: () => onSendAgain?.(row.id),
            }),
          })
        );

  const treatment = useBubbleTreatment(state);

  return (
    <View style={[styles.promptLine, waiting === null ? styles.faded : null]}>
      <Thumbnails hostId={hostId} attachments={row.attachments} />
      {row.text.trim() === "" ? null : (
        <View style={[styles.prompt, treatment.view]}>
          <Text style={[styles.promptText, treatment.text]} selectable>
            {row.text}
          </Text>
        </View>
      )}
      <BubbleFootnote state={state} />
    </View>
  );
};

/** Its Turn's menu around a finished Turn's text; the lifted text leaves its receipt behind. */
const TurnMenu = ({
  turn,
  session,
  onMenuAction,
  receiptHeight,
  children,
}: {
  readonly turn: TurnFacts | null;
  readonly session: RowSession | undefined;
  readonly onMenuAction: ((action: MenuAction) => void) | undefined;
  readonly receiptHeight: number;
  readonly children: ReactNode;
}) =>
  turn === null || session === undefined || onMenuAction === undefined ? (
    children
  ) : (
    <LongPressMenu
      menu={turnMenu(session, turn)}
      title={[turnHeading(turn), turn.receipt].filter((line) => line !== "").join("\n")}
      previewInsetBottom={receiptHeight}
      card
      onAction={onMenuAction}
    >
      {children}
    </LongPressMenu>
  );

const RECEIPT_GAP = 8;

const Reply = ({
  row,
  session,
  onMenuAction,
}: {
  readonly row: Extract<ThreadRow, { kind: "reply" }>;
  readonly session: RowSession | undefined;
  readonly onMenuAction: ((action: MenuAction) => void) | undefined;
}) => {
  const styles = useStyles();
  const [receiptHeight, setReceiptHeight] = useState(0);

  // The menu's view also holds the reply's bottom margin, so the cut starts above both.
  const measure = (event: LayoutChangeEvent) =>
    setReceiptHeight(event.nativeEvent.layout.height + RECEIPT_GAP + TURN_GAP);

  return (
    <TurnMenu
      turn={row.turn}
      session={session}
      onMenuAction={onMenuAction}
      receiptHeight={row.receipt === null ? 0 : receiptHeight}
    >
      <View style={[styles.reply, row.receipt === null ? null : styles.turnEnd]}>
        <Markdown text={row.text} />
        {row.receipt === null ? null : (
          <Text
            style={styles.receipt}
            onLayout={measure}
            maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          >
            {row.receipt}
          </Text>
        )}
      </View>
    </TurnMenu>
  );
};

const RowView = ({
  row,
  criticalPaths,
  onToggle,
  onFocus,
  focused = false,
  onEditSteer,
  onSendAgain,
  hostId,
  hostName = "the host",
  session,
  onMenuAction,
  revised = NONE,
  liveFrames = NONE,
}: RowProps) => {
  const styles = useStyles();

  switch (row.kind) {
    case "prompt":
      return <Bubble text={row.text} note={null} hostId={hostId} attachments={row.attachments} />;
    case "quiet":
      return (
        <Text style={[styles.quiet, styles.turnEnd]} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
          {row.text}
        </Text>
      );
    case "steered":
      return (
        <Bubble
          text={row.text}
          note="Steered this turn"
          hostId={hostId}
          attachments={row.attachments}
        />
      );
    case "outgoing":
      return row.failed ? (
        <Pressable
          onPress={() => onEditSteer?.(row.id)}
          accessibilityRole="button"
          accessibilityHint="Puts the message back in the composer"
        >
          <Bubble
            text={row.text}
            note={row.note}
            hostId={hostId}
            attachments={row.attachments}
            faded
            failed
          />
        </Pressable>
      ) : (
        <Bubble
          text={row.text}
          note={row.note}
          hostId={hostId}
          attachments={row.attachments}
          faded
        />
      );
    case "send":
      return <SendBubble row={row} hostId={hostId} hostName={hostName} onSendAgain={onSendAgain} />;
    case "reply":
      return <Reply row={row} session={session} onMenuAction={onMenuAction} />;
    case "receipt":
      return (
        <TurnMenu turn={row.turn} session={session} onMenuAction={onMenuAction} receiptHeight={0}>
          <Text
            style={[styles.receipt, styles.reply, styles.turnEnd]}
            maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          >
            {row.text}
          </Text>
        </TurnMenu>
      );
    case "error":
      return <Text style={[styles.message, styles.error]}>{row.text}</Text>;
    case "run":
      return <Run row={row} onToggle={onToggle} />;
    case "visualization":
      return (
        <VisualizationCard
          visualization={row.visualization}
          revised={revised.has(row.visualization.id)}
          live={liveFrames.has(row.key)}
          session={session}
        />
      );
    case "step":
      return (
        <Step
          row={row}
          critical={row.paths.some((path) => criticalPaths.has(path))}
          focused={focused}
          onFocus={onFocus}
          session={session}
        />
      );
  }
};

export const Row = memo(RowView);

/** Space between items of a Turn, and after a Turn's end (MX-E). */
const ITEM_GAP = 8;

const TURN_GAP = 18;

const makeStyles = (colours: MobileColours) =>
  ({
    diamond: {
      width: 6,
      height: 6,
      margin: 1,
      backgroundColor: colours.severityCritical,
      transform: [{ rotate: "45deg" }],
    },
    promptLine: { alignItems: "flex-end", gap: 4, paddingLeft: 56, marginBottom: TURN_GAP },
    faded: { opacity: 0.6 },
    note: { ...mobileType.footnote, color: colours.textSubtle, marginHorizontal: 4 },
    noteFailed: { color: colours.failedText },
    prompt: {
      backgroundColor: colours.raised,
      borderWidth: 1,
      borderColor: colours.hairline,
      borderRadius: 18,
      borderBottomRightRadius: 6,
      paddingVertical: 10,
      paddingHorizontal: 14,
    },
    promptText: { ...mobileType.callout, lineHeight: 20, color: colours.textStrong },
    message: { ...mobileType.callout, color: colours.textDefault },
    reply: { paddingHorizontal: 6, marginBottom: ITEM_GAP, gap: RECEIPT_GAP },
    turnEnd: { marginBottom: TURN_GAP },
    receipt: { ...mobileType.index, color: colours.textFaint },
    quiet: { ...mobileType.footnote, color: colours.textSubtle, paddingHorizontal: 6 },
    error: { color: colours.failedText, paddingHorizontal: 6, marginBottom: ITEM_GAP },
    well: {
      backgroundColor: colours.panel,
      borderColor: colours.hairline,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      paddingHorizontal: 12,
    },
    wellFirst: {
      borderTopWidth: 1,
      borderTopLeftRadius: 14,
      borderTopRightRadius: 14,
      paddingTop: 6,
    },
    wellLast: {
      borderBottomWidth: 1,
      borderBottomLeftRadius: 14,
      borderBottomRightRadius: 14,
      paddingBottom: 6,
      marginBottom: ITEM_GAP,
    },
    step: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30 },
    stepFocused: {
      backgroundColor: colours.raised,
      borderRadius: 10,
      borderLeftWidth: 2,
      borderLeftColor: colours.starlight,
      marginHorizontal: -8,
      paddingHorizontal: 6,
    },
    markSlot: { width: 16, alignItems: "center" },
    check: { ...mobileType.footnote, color: colours.textSubtle, width: 16, textAlign: "center" },
    failed: { color: colours.failedText },
    stepLabel: { ...mobileType.footnote, color: colours.textSubtle, flex: 1 },
    stepActive: { ...mobileType.subhead, fontWeight: "500", color: colours.textStrong },
    stepDetail: { ...mobileType.index, color: colours.textFaint },
    stepFailed: { ...mobileType.index, color: colours.failedText },
    runSummary: { ...mobileType.footnote, color: colours.textSubtle, flex: 1 },
    chevron: { ...mobileType.subhead, color: colours.textFaint },
    chevronOpen: { transform: [{ rotate: "90deg" }] },
  }) as const;
