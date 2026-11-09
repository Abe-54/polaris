/**
 * The composer's floating notice strip (Paper MX-E): the oldest open request with "+n" for the
 * rest, else Working, with Queue while a steer is typed. A permission shows Approve and Deny beside a command that fits one line,
 * and opens to every line (and Always here) otherwise; questions show their options and Send;
 * a Secret Request its masked field (`SecretCard.tsx`).
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  HarnessKind,
  RequestId,
  Subagent,
} from "@polaris/protocol";
import { mobileType } from "@polaris/ui/tokens";
import { Match } from "effect";
import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import {
  COMPACT_TEXT_SCALE,
  EXPANDED_SHARE,
  noticesOf,
  type Strip,
  stripOf,
  type StripNotice,
} from "../composer/strip.ts";
import { Celestial, subagentMoon } from "../celestial";
import { Dither } from "../dither/index.ts";
import { decisionOf } from "../home/model/respond.ts";
import { haptics } from "../motion";
import { type MobileColours, useTheme } from "../theme";
import { CONTENT_TEXT_SCALE, CONTROL_TEXT_SCALE } from "../theme/textScale.ts";
import { elapsed, harnessHue, harnessName } from "./labels.ts";
import type { SecretOutcome } from "./fold.ts";
import {
  offersAlwaysAllow,
  answered,
  answersDecision,
  pick,
  type Picks,
  requestCard,
} from "./requests.ts";
import { SecretCard, SecretSettled } from "./SecretCard.tsx";

export interface PendingRequestsProps {
  readonly requests: ReadonlyArray<ApprovalRequest>;
  readonly answering: ReadonlyArray<RequestId>;
  readonly errors: ReadonlyMap<RequestId, string>;
  /** False while the Host isn't connected: shown, not answerable. */
  readonly enabled: boolean;
  readonly onRespond: (requestId: RequestId, decision: ApprovalDecision) => void;
  /** Sends a Secret Request's value by `secret.provide`; never a RespondToApproval. */
  readonly onProvideSecret: (requestId: RequestId, typed: string) => void;
  /** How the latest Turn's Secret Request ended, if one did. */
  readonly settled?: SecretOutcome | null;
}

export interface NoticeStripProps extends PendingRequestsProps {
  readonly harness: HarnessKind;
  /** The session's Subagents, so a Subagent's request shows its moon. */
  readonly subagents?: ReadonlyArray<Subagent>;
  /** When the Turn in flight started; null when none is working. */
  readonly workingSince: string | null;
  /** While the Host is away, when the Working shown was last known ("11:42"); the dither stills. */
  readonly asOf?: string | null;
  /** Holds the typed steer for after this Turn; null when there's nothing to queue. */
  readonly onQueue?: (() => void) | null;
}

interface CardProps {
  readonly request: ApprovalRequest;
  readonly live: boolean;
  readonly onRespond: (decision: ApprovalDecision) => void;
}

const Spark = ({ colour }: { readonly colour: string }) => (
  <Svg width={12} height={12} viewBox="0 0 12 12">
    <Path d="M6 0.5 L7.1 4.9 L11.5 6 L7.1 7.1 L6 11.5 L4.9 7.1 L0.5 6 L4.9 4.9 Z" fill={colour} />
  </Svg>
);

/** Ticks once a second, only while a Turn is working. */
const useElapsed = (since: string | null): string | null => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [since]);

  return since === null ? null : elapsed(now - Date.parse(since));
};

const Answer = ({
  label,
  filled,
  live,
  onPress,
}: {
  readonly label: string;
  readonly filled: boolean;
  readonly live: boolean;
  readonly onPress: () => void;
}) => {
  const { colours } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      disabled={!live}
      onPress={onPress}
      hitSlop={6}
      style={[styles.answer, filled ? { backgroundColor: colours.textStrong } : styles.quiet]}
    >
      <Text
        style={[styles.answerLabel, { color: filled ? colours.bg : colours.textSubtle }]}
        maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
      >
        {label}
      </Text>
    </Pressable>
  );
};

const Permission = ({
  notice,
  harness,
  card,
  open,
  onToggle,
}: {
  readonly notice: Extract<StripNotice, { kind: "approval" }>;
  readonly harness: HarnessKind;
  readonly card: CardProps;
  readonly open: boolean;
  readonly onToggle: () => void;
}) => {
  const { colours } = useTheme();
  // A compact command that still wraps opens to the whole: Approve is never beside cut-off text.
  const [wraps, setWraps] = useState(false);
  // Large text leaves no room beside Approve: the buttons go under the request.
  const roomy = useWindowDimensions().fontScale <= COMPACT_TEXT_SCALE;
  const whole = open || !notice.compact || wraps || !roomy;

  const approve = () => {
    haptics.approve();
    card.onRespond(decisionOf({ kind: "approve" }));
  };

  const buttons = (
    <>
      <Answer label="Approve" filled live={card.live} onPress={approve} />
      {whole && offersAlwaysAllow(card.request) ? (
        <Answer
          label="Always here"
          filled={false}
          live={card.live}
          onPress={() => {
            haptics.approve();
            card.onRespond(decisionOf({ kind: "always" }));
          }}
        />
      ) : null}
      <Answer
        label="Deny"
        filled={false}
        live={card.live}
        onPress={() => card.onRespond(decisionOf({ kind: "deny" }))}
      />
    </>
  );

  return (
    <View style={[styles.column, card.live ? null : styles.waiting]}>
      <View style={[styles.row, styles.tight]}>
        {notice.moon === null ? (
          <Spark colour={colours.needsYou} />
        ) : (
          <Celestial body={subagentMoon(notice.moon)} harness={harness} size={12} working />
        )}
        <Pressable
          style={styles.text}
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={`${notice.headline}${notice.detail === null ? "" : `: ${notice.detail}`}`}
          accessibilityHint={whole ? undefined : "Shows the whole request"}
        >
          <Text
            style={[styles.headline, { color: colours.needsYouText }]}
            maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          >
            {notice.headline}
          </Text>
          {notice.detail === null || whole ? null : (
            <Text
              style={[styles.detail, { color: colours.textDefault }]}
              onTextLayout={(event) => {
                if (event.nativeEvent.lines.length > 1) setWraps(true);
              }}
              maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
            >
              {notice.detail}
            </Text>
          )}
        </Pressable>
        {whole ? null : buttons}
      </View>
      {whole && notice.detail !== null ? (
        <ScrollView style={styles.whole} nestedScrollEnabled>
          <Text
            style={[styles.detail, { color: colours.textDefault }]}
            selectable
            maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          >
            {notice.detail}
          </Text>
        </ScrollView>
      ) : null}
      {whole ? <View style={styles.buttons}>{buttons}</View> : null}
    </View>
  );
};

const Questions = ({ request, live, onRespond }: CardProps) => {
  const { colours } = useTheme();
  const [picks, setPicks] = useState<Picks>([]);
  const card = requestCard(request);
  const questions = card.kind === "questions" ? card.questions : [];
  const ready = live && answered(request, picks);
  const scroll = useRef<ScrollViewInstance>(null);

  // A long question hides options below the fold: show that it scrolls.
  useEffect(() => {
    const timer = setTimeout(() => scroll.current?.flashScrollIndicators(), 400);

    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.column}>
      <ScrollView
        ref={scroll}
        style={styles.questions}
        contentContainerStyle={styles.column}
        nestedScrollEnabled
      >
        {questions.map((question, index) => (
          <View key={`${index}:${question.question}`} style={styles.question}>
            <Text
              style={[styles.questionText, { color: colours.textDefault }]}
              maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
            >
              <Text
                style={[styles.headline, { color: colours.needsYouText }]}
                maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
              >
                {question.header === "" ? "Asks · " : `${question.header} · `}
              </Text>
              {question.question}
            </Text>
            <View style={[styles.chips, live ? null : styles.waiting]}>
              {question.options.map((option) => {
                const chosen = (picks[index] ?? []).includes(option.label);

                return (
                  <Pressable
                    key={option.label}
                    accessibilityRole="button"
                    accessibilityState={{ selected: chosen }}
                    disabled={!live}
                    onPress={() =>
                      setPicks((held) => pick(held, index, option.label, question.multiSelect))
                    }
                    style={[
                      styles.choice,
                      chosen
                        ? { backgroundColor: colours.textStrong, borderColor: colours.textStrong }
                        : { borderColor: colours.hairline },
                    ]}
                  >
                    <Text
                      style={[
                        styles.choiceLabel,
                        { color: chosen ? colours.bg : colours.textDefault },
                      ]}
                      maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={[styles.buttons, ready ? null : styles.waiting]}>
        <Answer
          label="Send answers"
          filled
          live={ready}
          onPress={() => {
            haptics.approve();
            onRespond(answersDecision(request, picks));
          }}
        />
      </View>
    </View>
  );
};

/** Working's quiet action: the typed steer waits for the Turn to end (ENG-557). */
const QueueAction = ({ onQueue }: { readonly onQueue: () => void }) => {
  const { colours } = useTheme();

  return (
    <Pressable
      onPress={() => {
        haptics.send();
        onQueue();
      }}
      accessibilityRole="button"
      accessibilityLabel="Queue for after this turn"
      hitSlop={8}
      style={styles.queue}
    >
      <Text
        style={[styles.answerLabel, { color: colours.textSubtle }]}
        maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
      >
        Queue
      </Text>
    </Pressable>
  );
};

const Working = ({
  harness,
  since,
  asOf,
  onQueue,
}: {
  readonly harness: HarnessKind;
  readonly since: string;
  readonly asOf: string | null;
  readonly onQueue: (() => void) | null;
}) => {
  const { colours } = useTheme();
  const time = useElapsed(asOf === null ? since : null);
  const hue = harnessHue(colours, harness);

  return (
    <View style={styles.row}>
      <View style={[styles.row, styles.working]} accessibilityLiveRegion="polite">
        <Dither color={hue} size={14} moving={asOf === null} />
        <Text
          style={[styles.headline, styles.working, { color: hue }]}
          numberOfLines={2}
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          {harnessName(harness)} is working
        </Text>
        <Text
          style={[styles.time, { color: colours.textFaint }]}
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          · {asOf === null ? time : `as of ${asOf}`}
        </Text>
      </View>
      {onQueue === null ? null : <QueueAction onQueue={onQueue} />}
    </View>
  );
};

const More = ({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) => {
  const { colours } = useTheme();

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={open ? "Show less" : `${count} more`}
      hitSlop={8}
      style={[styles.more, { backgroundColor: colours.fillHover }]}
    >
      <Text
        style={[styles.moreLabel, { color: colours.textSubtle }]}
        maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
      >
        {open ? "Less" : `+${count}`}
      </Text>
    </Pressable>
  );
};

const Notice = ({
  notice,
  props,
}: {
  readonly notice: StripNotice;
  readonly props: NoticeStripProps;
}) => {
  const { colours } = useTheme();
  const [open, setOpen] = useState(false);

  if (notice.kind === "working")
    return props.workingSince === null ? null : (
      <Working
        harness={props.harness}
        since={props.workingSince}
        asOf={props.asOf ?? null}
        onQueue={notice.queue ? (props.onQueue ?? null) : null}
      />
    );
  const { request } = notice;

  const card: CardProps = {
    request,
    live: props.enabled && !props.answering.includes(request.id),
    onRespond: (decision) => props.onRespond(request.id, decision),
  };

  const body = Match.value(notice).pipe(
    Match.discriminatorsExhaustive("kind")({
      question: () => <Questions {...card} />,
      secret: (secret) => (
        <SecretCard
          request={request}
          headline={secret.headline}
          live={card.live}
          onProvide={(typed) => props.onProvideSecret(request.id, typed)}
          onDecline={() => card.onRespond(decisionOf({ kind: "deny" }))}
        />
      ),
      approval: (approval) => (
        <Permission
          notice={approval}
          harness={props.harness}
          card={card}
          open={open}
          onToggle={() => setOpen(!open)}
        />
      ),
    })
  );

  return (
    <View style={styles.column}>
      {body}
      {props.errors.has(request.id) ? (
        <Text
          style={[styles.failed, { color: colours.failedText }]}
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          Couldn't send. Try again.
        </Text>
      ) : null}
    </View>
  );
};

const panel = (colours: MobileColours) => ({
  backgroundColor: colours.raised,
  borderColor: colours.hairline,
});

/** Every request when opened, else the strip's one; nothing when there's nothing to know. */
export const PendingRequests = (props: NoticeStripProps) => {
  const { colours } = useTheme();
  const [all, setAll] = useState(false);
  const { height } = useWindowDimensions();

  const harness = harnessName(props.harness);

  const strip: Strip | null = stripOf({
    requests: props.requests,
    working: props.workingSince !== null,
    queue: props.onQueue != null,
    harness,
    subagents: props.subagents ?? [],
    settled: props.settled ?? null,
  });

  if (strip === null) return null;
  const opened = all && strip.more > 0;
  const shown = opened ? noticesOf(props.requests, harness, props.subagents ?? []) : [strip.notice];

  const notices = [
    strip.settled === null ? null : <SecretSettled key="settled" settled={strip.settled} />,
    ...shown.map((notice) =>
      notice === null ? null : (
        <Notice
          key={notice.kind === "working" ? "working" : notice.request.id}
          notice={notice}
          props={props}
        />
      )
    ),
  ];

  return (
    <View style={[styles.strip, panel(colours)]}>
      {opened ? (
        <ScrollView
          style={[styles.notices, { maxHeight: height * EXPANDED_SHARE }]}
          contentContainerStyle={styles.noticeList}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
        >
          {notices}
        </ScrollView>
      ) : (
        <View style={[styles.notices, styles.noticeList]}>{notices}</View>
      )}
      {strip.more > 0 ? <More count={strip.more} open={all} onToggle={() => setAll(!all)} /> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  strip: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 8,
  },
  notices: { flex: 1 },
  noticeList: { gap: 12 },
  column: { gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 30 },
  tight: { gap: 6 },
  text: { flex: 1, minWidth: 0 },
  headline: { ...mobileType.footnote, fontSize: 12, lineHeight: 16, fontWeight: "500" },
  detail: { ...mobileType.index },
  whole: { maxHeight: 160 },
  working: { flexShrink: 1 },
  queue: { marginLeft: "auto", minHeight: 30, paddingHorizontal: 7, justifyContent: "center" },
  time: { ...mobileType.footnote, fontSize: 12, lineHeight: 16, flexShrink: 0 },
  buttons: { flexDirection: "row", alignItems: "center", gap: 4 },
  answer: {
    minHeight: 30,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  quiet: { paddingHorizontal: 7 },
  answerLabel: { ...mobileType.footnote, lineHeight: 16, fontWeight: "500" },
  waiting: { opacity: 0.55 },
  questions: { maxHeight: 260 },
  question: { gap: 6 },
  questionText: { ...mobileType.subhead },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: {
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: "center",
    maxWidth: "100%",
  },
  choiceLabel: { ...mobileType.subhead, fontWeight: "500" },
  more: {
    minHeight: 24,
    paddingHorizontal: 8,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 3,
  },
  moreLabel: { ...mobileType.footnote, fontSize: 12, lineHeight: 16 },
  failed: { ...mobileType.footnote },
});
