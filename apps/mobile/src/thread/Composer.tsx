/**
 * The composer (Paper MX-E): suggested chips above it; inside, the floating notice strip, the
 * field, and one row of the model chip (its sheet holds harness, model, effort and permissions),
 * the Subagents' moons, the context ring, attach, mic, and Send, or Stop while a Turn works;
 * Queue sits in the strip's Working row, never in the control row (ENG-557).
 */
import type { CelestialBody, ContextUsage, HarnessKind, Subagent } from "@polaris/protocol";
import type { DraftStatus } from "@polaris/client/continuity";
import { mobileType } from "@polaris/ui/tokens";
import { type ReactNode, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { ContextRing, ModelChip, SendButton, SubagentMoons } from "../composer/ControlRow.tsx";
import { ModelControl } from "../composer/ModelControl.tsx";
import {
  contextRing,
  fitControlRow,
  moonsOf,
  type RowFit,
  type RowParts,
  sendPress,
} from "../composer/controlRow.ts";
import {
  AttachButton,
  type AttachInput,
  AttachmentChips,
  MicButton,
  type VoiceInput,
} from "../composer/controls.tsx";
import type { ModelSheetContext } from "../composer/useModelSheet.ts";
import { usePastedImages } from "../composer/usePastedImages.ts";
import { haptics } from "../motion";
import { useTheme } from "../theme";
import { CONTENT_TEXT_SCALE } from "../theme/textScale.ts";
import { type ComposerMode, placeholderFor } from "./composer.ts";
import { PendingRequests, type PendingRequestsProps } from "./PendingRequests.tsx";
import { Diamond } from "./Row.tsx";
import type { Suggestion } from "./suggestions.ts";

export const Suggestions = ({
  items,
  onPick,
}: {
  readonly items: ReadonlyArray<Suggestion>;
  readonly onPick: (item: Suggestion) => void;
}) => {
  const { colours } = useTheme();

  return items.length === 0 ? null : (
    <View style={styles.suggested}>
      <Text
        style={[styles.suggestedLabel, { color: colours.textFaint }]}
        maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
      >
        Suggested
      </Text>
      <View style={styles.chips}>
        {items.map((item) => (
          <Pressable
            key={item.kind}
            style={[styles.chip, { borderColor: colours.hairline }]}
            onPress={() => onPick(item)}
            accessibilityRole="button"
          >
            {item.kind === "fix" ? <Diamond /> : null}
            <Text
              style={[styles.chipLabel, { color: colours.textDefault }]}
              maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
};

export interface ComposerProps {
  readonly mode: ComposerMode;
  readonly text: string;
  readonly harness: HarnessKind;
  readonly model: string | null;
  readonly celestial?: CelestialBody | null | undefined;
  /** When the Turn in flight started; null when none is working. */
  readonly workingSince: string | null;
  readonly draftStatus: DraftStatus | null;
  readonly error: string | null;
  /** The session's open requests, for the notice strip; null shows none. */
  readonly requests?: PendingRequestsProps | null;
  readonly subagents?: ReadonlyArray<Subagent>;
  readonly contextUsage?: ContextUsage | null;
  /** What the model sheet changes; null leaves the chip a label. */
  readonly sheet?: ModelSheetContext | null;
  /** Attach, where the Host stages attachments; null hides it. */
  readonly attach?: AttachInput | null;
  /** Attachments are still on their way: Send waits for them. */
  readonly attaching?: boolean;
  /** The mic, where the Host transcribes voice; null hides it. */
  readonly voice?: VoiceInput | null;
  /** Over the field: a new session's place line (MX-AO). */
  readonly head?: ReactNode;
  /** In the model chip's place: a new session's own chip and sheet. */
  readonly control?: ReactNode;
  /** The field's placeholder, when the mode's own doesn't fit. */
  readonly placeholder?: string;
  /** A session not started yet: there is no context to ring. */
  readonly unstarted?: boolean;
  /** False keeps Send off though there is text: a new session with nowhere to start yet. */
  readonly canSend?: boolean;
  readonly autoFocus?: boolean;
  readonly onChange: (text: string) => void;
  readonly onSend: () => void;
  readonly onQueue: () => void;
  readonly onStop: () => void;
}

/** What's said over the field: an error, a dictation or attach problem, or a draft not saved. */
const noticeOf = (props: ComposerProps): { text: string; failed: boolean } | null => {
  if (props.error !== null) return { text: props.error, failed: true };
  const failure = props.voice?.failure ?? null;

  if (failure !== null) return { text: failure, failed: true };
  const caption = props.attach?.caption ?? null;

  if (caption !== null) return { text: caption, failed: false };

  return props.draftStatus === "unsaved" ? { text: "Draft not saved", failed: false } : null;
};

const FieldNotice = ({
  notice,
}: {
  readonly notice: { readonly text: string; readonly failed: boolean } | null;
}) => {
  const { colours } = useTheme();

  return notice === null ? null : (
    <Text
      style={[styles.notice, { color: notice.failed ? colours.failedText : colours.textSubtle }]}
      maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
    >
      {notice.text}
    </Text>
  );
};

/** The ring, attach and the mic, as many as the row has room for. */
const Tools = ({
  fit,
  usage,
  attach,
  voice,
}: {
  readonly fit: RowFit;
  readonly usage: ContextUsage | null;
  readonly attach: AttachInput | null;
  readonly voice: VoiceInput | null;
}) => (
  <>
    {fit.ring ? <ContextRing ring={contextRing(usage)} words={fit.ringWords} /> : null}
    {attach === null ? null : <AttachButton onPress={attach.pick} compact />}
    {voice === null || !fit.mic ? null : <MicButton voice={voice} large />}
  </>
);

/** The session's model chip, opening its sheet where the Host can change it. */
const SessionChip = (props: ComposerProps & { readonly working: boolean }) => {
  const celestial = props.celestial ?? null;

  return props.sheet == null ? (
    <ModelChip
      harness={props.harness}
      celestial={celestial}
      label={props.model ?? "Default"}
      working={props.working}
      onPress={null}
    />
  ) : (
    <ModelControl context={props.sheet} celestial={celestial} working={props.working} />
  );
};

/** What the control row has room for, at its measured width and the text size. */
const useRowFit = (parts: RowParts) => {
  const [width, setWidth] = useState<number | null>(null);
  const { fontScale } = useWindowDimensions();

  return [fitControlRow(width, fontScale, parts), setWidth] as const;
};

/** Send or Stop, with Stop deaf for a moment after a send (`sendPress`). */
const useSend = (stop: boolean, props: Pick<ComposerProps, "onSend" | "onStop">) => {
  const sentAt = useRef<number | null>(null);

  return () => {
    const now = Date.now();
    const press = sendPress({ stop, now, sentAt: sentAt.current });

    if (press === "stop") {
      haptics.stop();
      props.onStop();
    } else if (press === "send") {
      sentAt.current = now;
      haptics.send();
      props.onSend();
    }
  };
};

export const Composer = (props: ComposerProps) => {
  const { colours } = useTheme();
  const { mode, text, harness, workingSince, attach = null, voice = null } = props;
  const blocked = mode.kind === "blocked";
  const working = workingSince !== null;
  const empty = text.trim() === "" || props.attaching === true || props.canSend === false;
  const stop = working && text.trim() === "";
  const fieldId = usePastedImages(attach, !blocked);
  const moons = moonsOf(props.subagents ?? []);
  const queue = mode.kind === "steer" && !empty;

  const [fit, measure] = useRowFit({
    running: moons.running,
    attach: attach !== null && !blocked,
    mic: voice !== null && !blocked,
  });

  const send = useSend(stop, props);

  return (
    <View style={[styles.box, { backgroundColor: colours.panel, borderColor: colours.hairline }]}>
      {props.requests == null ? null : (
        <PendingRequests
          {...props.requests}
          harness={harness}
          subagents={props.subagents ?? []}
          workingSince={workingSince}
          onQueue={queue ? props.onQueue : null}
        />
      )}
      {props.head}
      <View style={styles.field}>
        {attach === null ? null : <AttachmentChips attach={attach} />}
        <FieldNotice notice={noticeOf(props)} />
        <TextInput
          style={[styles.input, { color: colours.textStrong }]}
          value={text}
          onChangeText={props.onChange}
          placeholder={props.placeholder ?? placeholderFor(mode)}
          placeholderTextColor={colours.textFaint}
          editable={!blocked}
          autoFocus={props.autoFocus}
          multiline
          accessibilityLabel="Message"
          nativeID={fieldId}
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        />
      </View>
      <View style={styles.row} onLayout={({ nativeEvent }) => measure(nativeEvent.layout.width)}>
        {props.control ?? <SessionChip {...props} working={working} />}
        <SubagentMoons harness={harness} moons={moons} shown={fit.moons} />
        <View style={styles.spring} />
        <Tools
          fit={props.unstarted === true ? { ...fit, ring: false } : fit}
          usage={props.contextUsage ?? null}
          attach={blocked ? null : attach}
          voice={blocked ? null : voice}
        />
        <SendButton
          stop={stop}
          disabled={!stop && (empty || blocked)}
          label={mode.kind === "queue" ? "Queue a follow-up" : "Send"}
          onPress={send}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  suggested: { gap: 10, marginHorizontal: 4 },
  suggestedLabel: { ...mobileType.footnote, fontSize: 12, lineHeight: 16 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipLabel: { ...mobileType.subhead, fontWeight: "500" },
  box: { borderRadius: 22, borderWidth: 1, padding: 6, gap: 6 },
  field: { gap: 8, paddingHorizontal: 6, paddingTop: 4 },
  notice: { ...mobileType.footnote },
  input: {
    ...mobileType.body,
    fontSize: 16,
    lineHeight: 21,
    minHeight: 36,
    maxHeight: 140,
    paddingVertical: 8,
    paddingHorizontal: 0,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  spring: { flex: 1 },
});
