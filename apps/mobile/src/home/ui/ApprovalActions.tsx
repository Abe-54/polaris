import { offersAlwaysAllow } from "../../thread/requests.ts";
/**
 * An approval answered in place (Paper MX-C, MX-H): Approve / Always here / Deny under the command,
 * file change or tool; choice chips and Reply… for a question; a secret opens its agent session.
 * Approve is filled white.
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { mobileFont } from "@polaris/ui/tokens";
import { Match } from "effect";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { themedStyles, useTheme } from "../../theme/index.ts";
import { approvalDetail, askLine, quickQuestion } from "../model/lines.ts";
import { haptics } from "../../motion/index.ts";
import type { Reply } from "../model/respond.ts";
import { CONTENT_TEXT_SCALE } from "../../theme/textScale.ts";

export interface ApprovalActionsProps {
  readonly approval: ApprovalRequest;
  /** False while the Host isn't connected: shown, not answerable. */
  readonly enabled: boolean;
  readonly onReply: (reply: Reply) => Promise<void>;
  /** A question this card can't answer inline (several questions): open the agent session. */
  readonly onOpen: () => void;
}

type Sending =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "failed" };

const useSend = (onReply: ApprovalActionsProps["onReply"]) => {
  const [sending, setSending] = useState<Sending>({ kind: "idle" });

  const send = (reply: Reply) => {
    if (reply.kind !== "deny") haptics.approve();
    setSending({ kind: "sending" });
    onReply(reply).then(
      () => setSending({ kind: "idle" }),
      () => setSending({ kind: "failed" })
    );
  };

  return { sending, send };
};

const Failed = ({ sending }: { readonly sending: Sending }) =>
  sending.kind === "failed" ? (
    <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={useStyles().failed}>
      Couldn't send. Try again.
    </Text>
  ) : null;

/** Filled white for Approve and a first choice (never Starlight), outlined for other choices. */
type ButtonKind = "filled" | "outlined" | "plain" | "quiet";

const Button = ({
  label,
  kind = "plain",
  disabled,
  onPress,
}: {
  readonly label: string;
  readonly kind?: ButtonKind;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) => {
  const styles = useStyles();
  const fill = { filled: styles.filled, outlined: styles.outlined, plain: null, quiet: null }[kind];

  const ink = { filled: styles.filledLabel, outlined: null, plain: null, quiet: styles.quietLabel }[
    kind
  ];

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, fill, pressed ? styles.pressed : null]}
    >
      <Text
        maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        style={[styles.label, ink]}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  );
};

const Permission = ({ approval, enabled, onReply, onOpen }: ApprovalActionsProps) => {
  const styles = useStyles();
  const { sending, send } = useSend(onReply);
  const detail = approvalDetail(approval);
  const live = enabled && sending.kind !== "sending";

  return (
    <View style={styles.block}>
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.ask}>
        {askLine(approval)}
      </Text>
      {detail === null ? null : (
        <View style={styles.command}>
          <Text
            maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
            style={styles.commandText}
            numberOfLines={detail.tooLong ? 4 : undefined}
          >
            {detail.text}
          </Text>
        </View>
      )}
      {detail?.tooLong === true ? (
        <Button label="Review it in the agent session" disabled={false} onPress={onOpen} />
      ) : (
        <View style={[styles.buttons, styles.wrap, live ? null : styles.waiting]}>
          <Button
            label="Approve"
            kind="filled"
            disabled={!live}
            onPress={() => send({ kind: "approve" })}
          />
          {offersAlwaysAllow(approval) ? (
            <Button label="Always here" disabled={!live} onPress={() => send({ kind: "always" })} />
          ) : null}
          <Button
            label="Deny"
            kind="quiet"
            disabled={!live}
            onPress={() => send({ kind: "deny" })}
          />
        </View>
      )}
      <Failed sending={sending} />
    </View>
  );
};

const ReplyField = ({
  onSend,
  onCancel,
}: {
  readonly onSend: (text: string) => void;
  readonly onCancel: () => void;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const [text, setText] = useState("");

  return (
    <TextInput
      maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
      autoFocus
      style={styles.reply}
      value={text}
      onChangeText={setText}
      placeholder="Reply…"
      placeholderTextColor={colours.textFaint}
      returnKeyType="send"
      onSubmitEditing={() => (text.trim() === "" ? onCancel() : onSend(text.trim()))}
      onBlur={() => {
        if (text.trim() === "") onCancel();
      }}
    />
  );
};

const Question = ({ approval, enabled, onReply, onOpen }: ApprovalActionsProps) => {
  const styles = useStyles();
  const { sending, send } = useSend(onReply);
  const [replying, setReplying] = useState(false);
  const quick = quickQuestion(approval);
  const live = enabled && sending.kind !== "sending";

  return (
    <View style={styles.block}>
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.question}>
        <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.ask}>
          Asks ·{" "}
        </Text>
        {quick?.text ?? approval.title}
      </Text>
      {replying ? (
        <ReplyField
          onCancel={() => setReplying(false)}
          onSend={(text) => {
            setReplying(false);
            send({ kind: "answer", text });
          }}
        />
      ) : (
        <View style={[styles.buttons, styles.wrap, live ? null : styles.waiting]}>
          {(quick?.choices ?? []).map((choice, index) => (
            <Button
              key={choice}
              label={choice}
              kind={index === 0 ? "filled" : "outlined"}
              disabled={!live}
              onPress={() => send({ kind: "answer", text: choice })}
            />
          ))}
          <Button
            label={quick === null ? "Answer…" : "Reply…"}
            kind="quiet"
            disabled={!live}
            onPress={() => (quick === null ? onOpen() : setReplying(true))}
          />
        </View>
      )}
      <Failed sending={sending} />
    </View>
  );
};

/** A session that needs you with no request in its feed: what it waits on is in the thread. */
export const OpenToAnswer = ({ onOpen }: { readonly onOpen: () => void }) => {
  const styles = useStyles();

  return (
    <View style={styles.block}>
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.ask}>
        Waiting for your reply
      </Text>
      <View style={styles.buttons}>
        <Button label="Open the agent session" kind="outlined" disabled={false} onPress={onOpen} />
      </View>
    </View>
  );
};

/** A Secret Request is typed only into its card in the agent session: never Approve or Deny. */
const Secret = ({ approval, onOpen }: ApprovalActionsProps) => {
  const styles = useStyles();

  return (
    <View style={styles.block}>
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.question}>
        <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.ask}>
          {askLine(approval)} ·{" "}
        </Text>
        {approval.title}
      </Text>
      <View style={styles.buttons}>
        <Button label="Open to answer" kind="outlined" disabled={false} onPress={onOpen} />
      </View>
    </View>
  );
};

export const ApprovalActions = (props: ApprovalActionsProps) =>
  Match.value(props.approval.kind).pipe(
    Match.when("question", () => <Question {...props} />),
    Match.when("secret", () => <Secret {...props} />),
    Match.orElse(() => <Permission {...props} />)
  );

/** Paper MX-C's approval block: 14pt medium controls, 34pt pills, the command in a ground well. */
const useStyles = themedStyles((colours) => ({
  block: { gap: 8, paddingTop: 8 },
  ask: {
    fontFamily: mobileFont.sans,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "500",
    color: colours.needsYouText,
  },
  command: {
    backgroundColor: colours.ground,
    borderColor: colours.hairline,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  commandText: {
    fontFamily: mobileFont.mono,
    fontSize: 13,
    lineHeight: 18,
    color: colours.textDefault,
  },
  buttons: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 2 },
  wrap: { flexWrap: "wrap" },
  waiting: { opacity: 0.55 },
  button: {
    minHeight: 34,
    paddingHorizontal: 15,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    maxWidth: "100%",
  },
  filled: { backgroundColor: colours.textStrong },
  outlined: {
    backgroundColor: colours.raised,
    borderColor: colours.hairline,
    borderWidth: 1,
  },
  pressed: { opacity: 0.8, transform: [{ scale: 0.97 }] },
  label: {
    fontFamily: mobileFont.sans,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "500",
    color: colours.textDefault,
  },
  filledLabel: { color: colours.panel },
  quietLabel: { color: colours.textSubtle },
  question: {
    fontFamily: mobileFont.sans,
    fontSize: 14,
    lineHeight: 19,
    color: colours.textDefault,
  },
  reply: {
    fontFamily: mobileFont.sans,
    fontSize: 15,
    lineHeight: 21,
    color: colours.textStrong,
    borderWidth: 1,
    borderColor: colours.hairline,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  failed: {
    fontFamily: mobileFont.sans,
    fontSize: 13,
    lineHeight: 18,
    color: colours.failedText,
  },
}));
