/**
 * Review's foot (Paper MX-N): Send back and Accept in one floating pill over a fade to the ground.
 * Accept keeps a ◆ count of open Criticals (at accessibility sizes it drops the turn number, so the
 * count still fits) and goes through MX-T's confirmation (P3's accept);
 * Send back opens a one-line reply first, so the agent session gets the user's words as its next Turn.
 */
import { mobileType } from "@polaris/ui/tokens";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { themedStyles, useTheme } from "../theme/index.ts";
import { ACCESSIBILITY_SCALE, CONTROL_TEXT_SCALE } from "../theme/textScale.ts";
import { AcceptChip, canAccept } from "./accept/index.ts";
import { acceptLabel } from "./copy.ts";
import type { AcceptState } from "./model.ts";

export interface ActionBarProps {
  readonly accept: AcceptState;
  readonly turnNumber: number;
  /** Open Critical findings, for Accept's ◆ count. */
  readonly criticals: number;
  readonly bottomInset: number;
  readonly notice: string | null;
  readonly onAccept: () => void;
  readonly onSendBack: (reply: string) => void;
}

const Fade = ({ ground }: { readonly ground: string }) => (
  <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none">
    <Defs>
      <LinearGradient id="bar-fade" x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor={ground} stopOpacity={0} />
        <Stop offset="0.28" stopColor={ground} stopOpacity={0.9} />
        <Stop offset="1" stopColor={ground} stopOpacity={1} />
      </LinearGradient>
    </Defs>
    <Rect width="100%" height="100%" fill="url(#bar-fade)" />
  </Svg>
);

const Reply = ({ onSend, onCancel }: { onSend: (reply: string) => void; onCancel: () => void }) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const [text, setText] = useState("");
  const ready = text.trim() !== "";

  return (
    <View style={styles.reply}>
      <TextInput
        maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="What should change?"
        placeholderTextColor={colours.textFaint}
        autoFocus
        returnKeyType="send"
        onSubmitEditing={() => ready && onSend(text)}
      />
      <Pressable accessibilityRole="button" style={styles.ghost} onPress={onCancel}>
        <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.ghostText}>
          Cancel
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !ready }}
        disabled={!ready}
        style={[styles.send, !ready && styles.sendOff]}
        onPress={() => onSend(text)}
      >
        <Text
          maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
          style={[styles.sendText, !ready && styles.sendTextOff]}
        >
          Send
        </Text>
      </Pressable>
    </View>
  );
};

export const ActionBar = (props: ActionBarProps) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const [replying, setReplying] = useState(false);
  const enabled = canAccept(props.accept);
  const large = useWindowDimensions().fontScale >= ACCESSIBILITY_SCALE;

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(props.bottomInset, 12) }]}>
      <Fade ground={colours.ground} />
      {props.notice === null ? null : (
        <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.notice}>
          {props.notice}
        </Text>
      )}
      {replying ? (
        <Reply
          onCancel={() => setReplying(false)}
          onSend={(reply) => {
            setReplying(false);
            props.onSendBack(reply);
          }}
        />
      ) : null}
      <View style={styles.pill}>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          onPress={() => setReplying(true)}
        >
          <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.secondaryText}>
            Send back
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !enabled }}
          disabled={!enabled}
          style={({ pressed }) => [
            styles.accept,
            enabled ? styles.acceptOn : styles.acceptOff,
            pressed && styles.pressed,
          ]}
          onPress={props.onAccept}
        >
          <Text
            maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
            numberOfLines={1}
            style={[styles.acceptText, enabled ? styles.acceptTextOn : styles.acceptTextOff]}
          >
            {acceptLabel(props.accept, props.turnNumber, !large)}
          </Text>
          {enabled ? <AcceptChip count={props.criticals} /> : null}
        </Pressable>
      </View>
    </View>
  );
};

const useStyles = themedStyles((colours) => ({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    gap: 10,
    paddingTop: 24,
    paddingHorizontal: 12,
  },
  notice: { ...mobileType.footnote, color: colours.failedText, paddingHorizontal: 8 },
  pill: {
    flexDirection: "row",
    gap: 8,
    padding: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.panel,
  },
  secondary: {
    height: 46,
    paddingHorizontal: 20,
    borderRadius: 999,
    justifyContent: "center",
    backgroundColor: colours.raised,
  },
  secondaryText: { ...mobileType.heading, lineHeight: 20, color: colours.textStrong },
  accept: {
    flex: 1,
    height: 46,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
  },
  acceptOn: { backgroundColor: colours.textStrong },
  acceptOff: { backgroundColor: colours.raised },
  acceptText: { ...mobileType.heading, lineHeight: 20, flexShrink: 1 },
  acceptTextOn: { color: colours.ground },
  acceptTextOff: { color: colours.textSubtle },
  pressed: { opacity: 0.8 },
  reply: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: {
    ...mobileType.callout,
    flex: 1,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    color: colours.textDefault,
    backgroundColor: colours.raised,
    borderWidth: 1,
    borderColor: colours.hairline,
  },
  ghost: { height: 40, justifyContent: "center", paddingHorizontal: 4 },
  ghostText: { ...mobileType.subhead, color: colours.textSubtle },
  send: {
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 999,
    justifyContent: "center",
    backgroundColor: colours.textStrong,
  },
  sendOff: { backgroundColor: colours.raised },
  sendText: { ...mobileType.subhead, fontWeight: "500", color: colours.ground },
  sendTextOff: { color: colours.textFaint },
}));
