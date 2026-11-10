/**
 * A Risk Finding inline in the diff (Paper M5): the expanded card with a 2px rule in its
 * severity, its reason, "Ask {harness} to fix" and the verdict thumbs; other findings fold to one
 * line until tapped. An open Critical card is always expanded and says Accept waits on it; a
 * dismissed one folds with a "dismissed" note.
 */
import type { RiskFinding, VerdictReason } from "@polaris/protocol";
import { mobileType } from "@polaris/ui/tokens";
import { memo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import thumb from "../../assets/review/thumb.png";
import { themedStyles, useTheme } from "../theme/index.ts";
import { findingMeta, VERDICT_REASONS } from "./copy.ts";
import { isDimmed } from "./model.ts";
import { SeverityBadge, severityColour, SeverityGlyph, severityText } from "./severity.tsx";

export interface FindingActions {
  readonly harnessName: string;
  readonly askToFix: (finding: RiskFinding) => void;
  readonly verdict: (finding: RiskFinding, reason: VerdictReason | null) => void;
  /** Findings the user has already judged or asked about on this screen. */
  readonly sent: ReadonlySet<string>;
}

const Thumb = ({ down, onPress }: { readonly down: boolean; readonly onPress: () => void }) => {
  const styles = useStyles();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={down ? "Not a problem" : "Useful finding"}
      hitSlop={6}
      style={styles.thumb}
      onPress={onPress}
    >
      <Image source={thumb} style={[styles.thumbGlyph, down && styles.down]} />
    </Pressable>
  );
};

const Reasons = ({ onPick }: { readonly onPick: (reason: VerdictReason) => void }) => {
  const styles = useStyles();

  return (
    <View style={styles.reasons}>
      <Text style={styles.meta}>Why is this not a problem?</Text>
      <View style={styles.pills}>
        {VERDICT_REASONS.map(({ reason, label }) => (
          <Pressable
            key={reason}
            accessibilityRole="button"
            style={styles.pill}
            onPress={() => onPick(reason)}
          >
            <Text style={styles.pillText}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
};

const Folded = ({ finding, onOpen }: { finding: RiskFinding; onOpen: () => void }) => {
  const styles = useStyles();

  return (
    <Pressable
      accessibilityRole="button"
      style={[styles.folded, isDimmed(finding) && styles.dimmed]}
      onPress={onOpen}
    >
      <SeverityBadge severity={finding.severity} />
      <Text style={styles.foldedTitle} numberOfLines={1}>
        {finding.title}
      </Text>
      <Text style={styles.meta}>
        {finding.status === "dismissed"
          ? `dismissed · ${findingMeta(finding)}`
          : findingMeta(finding)}
      </Text>
    </Pressable>
  );
};

const Card = ({ finding, actions }: { finding: RiskFinding; actions: FindingActions }) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const [asking, setAsking] = useState(false);
  const critical = finding.severity === "critical";
  const sent = actions.sent.has(finding.id);

  return (
    <View style={[styles.card, { borderLeftColor: severityColour(colours, finding.severity) }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{finding.title}</Text>
        <Text style={styles.meta}>{findingMeta(finding)}</Text>
      </View>
      <Text style={styles.reason}>{finding.reason}</Text>
      {critical && finding.status === "open" ? (
        <View style={styles.pausedLine}>
          <SeverityGlyph severity="critical" size={8} />
          <Text style={[styles.meta, { color: severityText(colours, "critical") }]}>
            Accept is paused until this is fixed or dismissed.
          </Text>
        </View>
      ) : null}
      {finding.status === "dismissed" ? <Text style={styles.meta}>Dismissed</Text> : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={sent}
          style={[styles.primary, sent && styles.primarySent]}
          onPress={() => actions.askToFix(finding)}
        >
          <Text style={[styles.primaryText, sent && styles.sentText]}>
            {sent ? "Sent" : `Ask ${actions.harnessName} to fix`}
          </Text>
        </Pressable>
        <View style={styles.spacer} />
        <Thumb down={false} onPress={() => actions.verdict(finding, null)} />
        <Thumb down onPress={() => setAsking((open) => !open)} />
      </View>
      {asking ? (
        <Reasons
          onPick={(reason) => {
            setAsking(false);
            actions.verdict(finding, reason);
          }}
        />
      ) : null}
    </View>
  );
};

export const FindingRowView = memo(function FindingRowView({
  finding,
  expanded,
  onToggle,
  actions,
}: {
  readonly finding: RiskFinding;
  readonly expanded: boolean;
  readonly onToggle: (id: string) => void;
  readonly actions: FindingActions;
}) {
  // An open Critical card never folds (DESIGN.md: nothing hides or dims a critical finding).
  if (!expanded && (finding.severity !== "critical" || finding.status === "dismissed"))
    return <Folded finding={finding} onOpen={() => onToggle(finding.id)} />;

  return <Card finding={finding} actions={actions} />;
});

const useStyles = themedStyles((colours) => ({
  card: {
    borderLeftWidth: 2,
    paddingTop: 14,
    paddingBottom: 16,
    paddingLeft: 18,
    paddingRight: 20,
    gap: 8,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { ...mobileType.label, fontSize: 15, lineHeight: 20, color: colours.textStrong, flex: 1 },
  meta: {
    ...mobileType.index,
    fontFamily: mobileType.footnote.fontFamily,
    color: colours.textSubtle,
  },
  reason: { ...mobileType.subhead, lineHeight: 20, color: colours.textDefault },
  pausedLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 2 },
  primary: {
    height: 34,
    paddingHorizontal: 16,
    borderRadius: 999,
    justifyContent: "center",
    backgroundColor: colours.textStrong,
  },
  primarySent: { backgroundColor: colours.raised },
  primaryText: { ...mobileType.subhead, fontWeight: "500", color: colours.ground },
  sentText: { color: colours.textSubtle },
  spacer: { flex: 1 },
  thumb: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbGlyph: { width: 16, height: 16, tintColor: colours.textSubtle },
  down: { transform: [{ rotate: "180deg" }] },
  reasons: { gap: 8, paddingTop: 4 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pill: {
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 999,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.panel,
  },
  pillText: { ...mobileType.footnote, color: colours.textDefault },
  folded: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 20,
  },
  foldedTitle: { ...mobileType.footnote, color: colours.textDefault, flex: 1 },
  dimmed: { opacity: 0.55 },
}));
