/**
 * The half-folded Duo idle (Paper MX-AF, after D8): a monitor. Above the fold the sky with the
 * time and agent sessions as celestials on the horizon; below it the needs you items, the first
 * as a raised hero, dimmed at night. "Reply…" opens that agent session as the laptop (D7).
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { mobileFont, mobileType, mobileWeight } from "@polaris/ui/tokens";
import { heroShadow } from "../theme/shadows.ts";
import { Match } from "effect";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, Settings, Text, View } from "react-native";
import { devHomeDataOn, useHomeHosts } from "../home/feed/useHomeHosts.ts";
import { DevDataToggle } from "../home/ui/DevDataToggle.tsx";
import { buildHome, type SessionRow } from "../home/model/home.ts";
import { age, harnessName, shortHostName } from "../home/model/format.ts";
import { approvalDetail, quickQuestion } from "../home/model/lines.ts";
import { type Reply, respond } from "../home/model/respond.ts";
import { haptics } from "../motion/index.ts";
import { useHosts } from "../runtime/hosts.tsx";
import { CONTENT_TEXT_SCALE, CONTROL_TEXT_SCALE } from "../theme/textScale.ts";
import { themedStyles } from "../theme/index.ts";
import {
  isNight,
  skyLine,
  starLimit,
  starsOf,
  moreLine,
  targetsOf,
  wantsDetail,
  wantsLine,
} from "./monitor.ts";
import { MonitorSky, useMinute } from "./MonitorSky.tsx";
import type { Rect } from "./posture.ts";
import { useEdgeInsets } from "./useEdgeInsets.ts";

/** MX-AF's hero edge and lift, as Home's (MX-C). */
const HERO_EDGE = "#ffffff1f";

/** A development build launched with `-polarisDevNight 1|0` forces the night dimming on or off. */
const DEV_NIGHT: boolean | null = (() => {
  if (!__DEV__ || Platform.OS !== "ios") return null;
  const value: unknown = Settings.get("polarisDevNight");

  return value === "1" || value === "0" ? value === "1" : null;
})();

/** Room under the last target for the development data toggle, so it never covers a row. */
const DEV_TOGGLE_ROOM = 48;

type Send = (row: SessionRow, approval: ApprovalRequest, reply: Reply) => Promise<void>;

interface Choice {
  readonly label: string;
  readonly reply: Reply;
}

const choicesOf = (approval: ApprovalRequest): ReadonlyArray<Choice> => {
  if (approval.kind === "question")
    return (quickQuestion(approval)?.choices ?? [])
      .slice(0, 2)
      .map((text) => ({ label: text, reply: { kind: "answer", text } }));

  return approvalDetail(approval)?.tooLong === true
    ? []
    : [
        { label: "Approve", reply: { kind: "approve" } },
        { label: "Always here", reply: { kind: "always" } },
      ];
};

/** Sends one reply at a time; a refusal says so under the buttons. */
const useSend = (send: () => (reply: Reply) => Promise<void>) => {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const go = (reply: Reply) => {
    setBusy(true);
    setFailed(false);

    send()(reply).then(
      () => {
        setBusy(false);

        if (reply.kind !== "deny") haptics.approve();
      },
      () => {
        setBusy(false);
        setFailed(true);
      }
    );
  };

  return { busy, failed, go };
};

const Permission = ({
  approval,
  live,
  go,
  onReply,
}: {
  readonly approval: ApprovalRequest;
  readonly live: boolean;
  readonly go: (reply: Reply) => void;
  readonly onReply: () => void;
}) => {
  const styles = useStyles();
  const detail = approvalDetail(approval);
  const choices = choicesOf(approval);

  return (
    <>
      <View style={styles.command}>
        <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.wants}>
          {approval.kind === "question" || approval.kind === "secret"
            ? "Asks"
            : wantsLine(approval.kind)}
        </Text>
        {/* Never clipped: what Approve allows is shown whole; a longer one goes to Reply…. */}
        <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.commandText}>
          {wantsDetail(detail?.text ?? approval.title)}
        </Text>
      </View>
      <View style={[styles.buttons, live ? null : styles.waiting]}>
        {choices.map((choice, index) => (
          <Pressable
            key={choice.label}
            accessibilityRole="button"
            disabled={!live}
            onPress={() => go(choice.reply)}
            style={({ pressed }) => [
              styles.button,
              index === 0 ? styles.approve : styles.outline,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text
              maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.9}
              style={index === 0 ? styles.approveLabel : styles.buttonLabel}
            >
              {choice.label}
            </Text>
          </Pressable>
        ))}
        {choices.length === 0 ? (
          <Pressable
            accessibilityRole="button"
            onPress={onReply}
            style={[styles.button, styles.outline]}
          >
            <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.buttonLabel}>
              Reply…
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!live}
          onPress={() => go({ kind: "deny" })}
          style={({ pressed }) => [
            styles.button,
            styles.outline,
            styles.deny,
            pressed ? styles.pressed : null,
          ]}
        >
          <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.quietLabel}>
            Deny
          </Text>
        </Pressable>
      </View>
    </>
  );
};

const Question = ({
  approval,
  live,
  go,
  onReply,
}: {
  readonly approval: ApprovalRequest;
  readonly live: boolean;
  readonly go: (reply: Reply) => void;
  readonly onReply: () => void;
}) => {
  const styles = useStyles();
  const quick = quickQuestion(approval);

  return (
    <>
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.ask}>
        <Text style={styles.wants}>Asks </Text>
        {quick?.text ?? approval.title}
      </Text>
      <View style={[styles.chips, live ? null : styles.waiting]}>
        {choicesOf(approval).map((choice) => (
          <Pressable
            key={choice.label}
            accessibilityRole="button"
            disabled={!live}
            onPress={() => go(choice.reply)}
            style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
          >
            <Text
              maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
              numberOfLines={1}
              style={styles.chipLabel}
            >
              {choice.label}
            </Text>
          </Pressable>
        ))}
        <Pressable accessibilityRole="button" onPress={onReply} style={styles.chipQuiet}>
          <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.chipQuietLabel}>
            Reply…
          </Text>
        </Pressable>
      </View>
    </>
  );
};

/** A Secret Request is typed only into its card in the agent session: no Approve, no Deny. */
const Secret = ({
  approval,
  onReply,
}: {
  readonly approval: ApprovalRequest;
  readonly onReply: () => void;
}) => {
  const styles = useStyles();

  return (
    <>
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.ask}>
        <Text style={styles.wants}>Asks for a secret </Text>
        {approval.title}
      </Text>
      <View style={styles.chips}>
        <Pressable accessibilityRole="button" onPress={onReply} style={styles.chip}>
          <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.chipLabel}>
            Open to answer
          </Text>
        </Pressable>
      </View>
    </>
  );
};

const Target = ({
  row,
  hero,
  now,
  send,
  onReply,
}: {
  readonly row: SessionRow;
  readonly hero: boolean;
  readonly now: number;
  readonly send: Send;
  readonly onReply: (row: SessionRow) => void;
}) => {
  const styles = useStyles();
  const approval = row.approval;

  const { busy, failed, go } = useSend(
    () => (reply) =>
      approval === null ? Promise.reject(new Error("answered")) : send(row, approval, reply)
  );

  if (approval === null) return null;
  const live = !row.stale && !busy;

  const Body = Match.value(approval.kind).pipe(
    Match.when("question", () => Question),
    Match.when("secret", () => Secret),
    Match.orElse(() => Permission)
  );

  return (
    <View style={hero ? styles.hero : styles.well}>
      <View style={styles.titleLine}>
        <Text
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          style={[styles.title, hero ? styles.heroTitle : null]}
          numberOfLines={1}
        >
          {row.session.title === "" ? "Untitled agent session" : row.session.title}
        </Text>
        <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} numberOfLines={1} style={styles.meta}>
          {[
            harnessName(row.session.harness),
            shortHostName(row.hostName),
            age(row.since, now),
          ].join(" · ")}
        </Text>
      </View>
      <Body approval={approval} live={live} go={go} onReply={() => onReply(row)} />
      {failed ? <Text style={styles.failed}>Couldn't send. Try again.</Text> : null}
    </View>
  );
};

export interface MonitorProps {
  readonly top: Rect;
  readonly bottom: Rect;
  readonly division: Rect;
  readonly onReply: (hostId: string, sessionId: string) => void;
}

export const Monitor = ({ top, bottom, division, onReply }: MonitorProps) => {
  const styles = useStyles();
  const hosts = useHomeHosts();
  const connections = useHosts();
  const now = useMinute();
  const home = useMemo(() => buildHome(hosts, null), [hosts]);
  const skyEdges = useEdgeInsets(top);
  const footEdges = useEdgeInsets(bottom);
  const skyWidth = top.width - skyEdges.left - skyEdges.right;
  const stars = useMemo(() => starsOf(home, starLimit(skyWidth)), [home, skyWidth]);
  const targets = targetsOf(home, 4);
  const night = DEV_NIGHT ?? isNight(now.getHours());

  const send: Send = (row, approval, reply) => {
    const connection = connections.find((c) => c.hostId === row.hostId);

    return connection === undefined
      ? Promise.reject(new Error("host gone"))
      : connection.run((client) => respond(client, approval, reply));
  };

  return (
    <View style={styles.monitor}>
      <MonitorSky rect={top} stars={stars} now={now} line={skyLine(home)} edges={skyEdges} />
      <View style={{ height: division.height }} />
      <ScrollView
        style={[{ height: bottom.height }, night ? styles.night : null]}
        contentContainerStyle={[
          styles.bottom,
          {
            paddingLeft: 24 + footEdges.left,
            paddingRight: 24 + footEdges.right,
            paddingBottom: 32 + footEdges.bottom + (devHomeDataOn() ? DEV_TOGGLE_ROOM : 0),
          },
        ]}
      >
        {targets.length === 0 ? (
          home.working === 0 ? null : (
            <Text style={styles.calm}>Nothing needs you.</Text>
          )
        ) : (
          <>
            <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.kicker}>
              Needs you · {home.needsYou}
            </Text>
            {targets.map((row, index) => (
              <Target
                key={row.key}
                row={row}
                hero={index === 0}
                now={now.getTime()}
                send={send}
                onReply={(r) => onReply(r.hostId, r.session.id)}
              />
            ))}
            {home.needsYou > targets.length ? (
              <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.more}>
                {moreLine(home.needsYou - targets.length)}
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
      <DevDataToggle bottom={footEdges.bottom + 8} />
    </View>
  );
};

const sans = (fontSize: number, lineHeight: number, medium = false) => ({
  fontFamily: mobileFont.sans,
  fontSize,
  lineHeight,
  fontWeight: medium ? mobileWeight.medium : mobileWeight.regular,
});

const useStyles = themedStyles((c) => ({
  monitor: { flex: 1, backgroundColor: c.ground },
  night: { opacity: 0.55 },
  bottom: { gap: 12, paddingHorizontal: 24, paddingTop: 28, paddingBottom: 32 },
  calm: { ...mobileType.callout, color: c.textSubtle, alignSelf: "center", paddingTop: 80 },
  kicker: {
    fontFamily: mobileFont.mono,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: mobileWeight.medium,
    letterSpacing: 0.88,
    textTransform: "uppercase",
    color: c.textSubtle,
  },
  hero: {
    gap: 12,
    padding: 18,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: HERO_EDGE,
    backgroundColor: c.raised,
    ...heroShadow,
  },
  well: {
    gap: 10,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.well,
  },
  titleLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 10 },
  title: { ...sans(17, 22, true), flexGrow: 1, flexShrink: 1, flexBasis: 160, color: c.textStrong },
  heroTitle: { fontSize: 19, lineHeight: 24 },
  meta: { ...sans(13, 18), flexShrink: 1, color: c.textSubtle },
  more: { ...sans(13, 18), color: c.textSubtle, alignSelf: "center" },
  command: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: c.well,
  },
  wants: { ...sans(14, 19), color: c.needsYouText },
  commandText: { fontFamily: mobileFont.mono, fontSize: 14, lineHeight: 19, color: c.textDefault },
  ask: { ...sans(14, 20), color: c.textDefault },
  /** Narrow halves wrap Deny under the two that answer, rather than shrinking their words. */
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  waiting: { opacity: 0.55 },
  button: {
    flexGrow: 1,
    flexBasis: 120,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  approve: { flexBasis: 112, backgroundColor: c.textStrong },
  outline: { borderWidth: 1, borderColor: HERO_EDGE, backgroundColor: c.well },
  deny: { flexBasis: 96 },
  pressed: { opacity: 0.8, transform: [{ scale: 0.97 }] },
  approveLabel: { ...sans(17, 22, true), color: c.panel },
  buttonLabel: { ...sans(17, 22, true), color: c.textDefault },
  quietLabel: { ...sans(17, 22, true), color: c.textSubtle },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: HERO_EDGE,
    backgroundColor: c.raised,
  },
  chipLabel: { ...sans(15, 20, true), color: c.textStrong },
  chipQuiet: { paddingVertical: 9, paddingHorizontal: 16 },
  chipQuietLabel: { ...sans(15, 20, true), color: c.textSubtle },
  failed: { ...mobileType.footnote, color: c.failedText },
}));
