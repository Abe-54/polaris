/**
 * A computer use approval on the phone (Paper CU4): "Use ‹app›?", who asks and where, the reason,
 * the last frame, then Allow once / Always allow on ‹host› / Deny. Headed input never always-allows.
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { mobileType } from "@polaris/ui/tokens";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Reply } from "../home/model/respond.ts";
import { haptics } from "../motion/index.ts";
import { useTheme } from "../theme/index.ts";
import { CONTENT_TEXT_SCALE, CONTROL_TEXT_SCALE } from "../theme/textScale.ts";
import { type ComputerUseAnswer, computerUseView } from "./approval.ts";
import { LastFrameImage, useLastFrame } from "./LastFrameImage.tsx";

export interface ComputerUseApprovalProps {
  readonly request: ApprovalRequest;
  readonly hostId: string;
  /** The Host's name and the Harness's, as the approval names them. */
  readonly host: string;
  readonly harness: string;
  readonly live: boolean;
  readonly onReply: (reply: Reply) => void;
}

const AnswerButton = ({
  answer,
  live,
  onReply,
}: {
  readonly answer: ComputerUseAnswer;
  readonly live: boolean;
  readonly onReply: (reply: Reply) => void;
}) => {
  const { colours } = useTheme();
  const filled = answer.kind === "filled";

  return (
    <Pressable
      accessibilityRole="button"
      disabled={!live}
      hitSlop={4}
      onPress={() => {
        if (answer.reply.kind !== "deny") haptics.approve();
        onReply(answer.reply);
      }}
      style={({ pressed }) => [
        styles.button,
        filled ? { backgroundColor: colours.textStrong } : null,
        answer.kind === "plain" ? { borderColor: colours.hairline, borderWidth: 1 } : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text
        maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
        numberOfLines={1}
        style={[
          styles.label,
          {
            color: { filled: colours.bg, plain: colours.textDefault, quiet: colours.textSubtle }[
              answer.kind
            ],
          },
        ]}
      >
        {answer.label}
      </Text>
    </Pressable>
  );
};

export const ComputerUseApproval = ({
  request,
  hostId,
  host,
  harness,
  live,
  onReply,
}: ComputerUseApprovalProps) => {
  const { colours } = useTheme();
  const view = computerUseView(request, harness, host);
  const frame = useLastFrame(hostId, request.sessionId, request.id);

  return (
    <View style={styles.block} testID="computer-use-approval">
      <View style={styles.head}>
        <Text
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          style={[styles.title, { color: colours.needsYouText }]}
        >
          {view.title}
        </Text>
        <Text
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          numberOfLines={1}
          style={[styles.who, { color: colours.textSubtle }]}
        >
          {view.who}
        </Text>
      </View>
      {view.reason === null ? null : (
        <Text
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          style={[styles.reason, { color: colours.textDefault }]}
        >
          {view.reason}
        </Text>
      )}
      {frame === null ? null : <LastFrameImage frame={frame} />}
      {view.takeOver === null ? null : (
        <Text
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          style={[styles.note, { color: colours.textSubtle }]}
        >
          {view.takeOver}
        </Text>
      )}
      <View style={[styles.buttons, live ? null : styles.waiting]}>
        {view.answers.map((answer) => (
          <AnswerButton key={answer.label} answer={answer} live={live} onReply={onReply} />
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  block: { gap: 8, paddingTop: 8 },
  head: { gap: 2 },
  title: { ...mobileType.subhead, fontWeight: "500" },
  who: { ...mobileType.footnote },
  reason: { ...mobileType.subhead },
  note: { ...mobileType.footnote },
  buttons: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingTop: 2 },
  waiting: { opacity: 0.55 },
  button: {
    minHeight: 34,
    paddingHorizontal: 15,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    maxWidth: "100%",
  },
  pressed: { opacity: 0.8, transform: [{ scale: 0.97 }] },
  label: { ...mobileType.subhead, fontWeight: "500" },
});
