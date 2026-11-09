/**
 * A finding in a turn's Review (Paper MX-N): open, a well with its reason, its diff hunk inline
 * (P2's `HunkView`, without its own finding card: the well is the card), "Ask {harness} to fix", "Ask the reviewer" and "Not a problem"; folded, one
 * row in a group of wells. An open Critical finding never folds; a dismissed one folds and says so.
 */
import type { RiskFinding, VerdictReason } from "@polaris/protocol";
import { mobileType } from "@polaris/ui/tokens";
import { memo, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { HunkView } from "../../diff/index.ts";
import { themedStyles, useTheme } from "../../theme/index.ts";
import {
  ACCESSIBILITY_SCALE,
  CONTENT_TEXT_SCALE,
  CONTROL_TEXT_SCALE,
} from "../../theme/textScale.ts";
import { findingMeta, VERDICT_REASONS } from "../copy.ts";
import { isDimmed } from "../model.ts";
import type { DiffPalette } from "../palette.ts";
import { LeadGlyph, SeverityGlyph } from "../severity.tsx";
import type { FindingHunk } from "./hunk.ts";

export interface WellActions {
  readonly harnessName: string;
  /** Findings already sent to the agent from this screen. */
  readonly sent: ReadonlySet<string>;
  readonly askToFix: (finding: RiskFinding) => void;
  readonly askReviewer: (finding: RiskFinding) => void;
  readonly verdict: (finding: RiskFinding, reason: VerdictReason) => void;
  readonly openFile: (index: number) => void;
}

/** "upload.ts:41": the file's name and the first flagged line; "dismissed · …" once dismissed. */
export const findingPlace = (finding: RiskFinding) => {
  const place = `${finding.path.split("/").pop() ?? finding.path}:${finding.lines.start}`;

  return finding.status === "dismissed" ? `dismissed · ${place}` : place;
};

const ThumbDown = ({ colour }: { readonly colour: string }) => (
  <Svg width={16} height={16} viewBox="0 0 16 16">
    <Path
      d="M11 9l-2.5 5c-1 0-1.7-.8-1.5-1.8L7.4 10H4c-.9 0-1.5-.8-1.3-1.7l1-4.5C3.9 3.1 4.5 2.5 5.2 2.5H11zM13.5 9H11V2.5h2.5z"
      fill="none"
      stroke={colour}
      strokeWidth={1.3}
      strokeLinejoin="round"
    />
  </Svg>
);

const Reasons = ({ onPick }: { readonly onPick: (reason: VerdictReason) => void }) => {
  const styles = useStyles();

  return (
    <View style={styles.reasons}>
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.meta}>
        Why is this not a problem?
      </Text>
      <View style={styles.pills}>
        {VERDICT_REASONS.map(({ reason, label }) => (
          <Pressable
            key={reason}
            accessibilityRole="button"
            style={styles.pill}
            onPress={() => onPick(reason)}
          >
            <Text maxFontSizeMultiplier={CONTROL_TEXT_SCALE} style={styles.pillText}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
};

const Hunk = ({
  finding,
  hunk,
  palette,
  onOpen,
}: {
  readonly finding: RiskFinding;
  readonly hunk: FindingHunk | null;
  readonly palette: DiffPalette;
  readonly onOpen: (index: number) => void;
}) => {
  const styles = useStyles();

  if (hunk === null)
    return (
      <View style={styles.hunk}>
        <Text style={styles.path}>{`${finding.path}:${finding.lines.start}`}</Text>
      </View>
    );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${finding.path}`}
      style={styles.hunk}
      onPress={() => onOpen(hunk.index)}
    >
      <HunkView file={hunk.file} hunk={hunk.hunk} palette={palette} label={hunk.file.name} />
    </Pressable>
  );
};

const Actions = ({
  finding,
  actions,
  onNotAProblem,
}: {
  readonly finding: RiskFinding;
  readonly actions: WellActions;
  readonly onNotAProblem: () => void;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const sent = actions.sent.has(finding.id);

  return (
    <View style={styles.actions}>
      <Pressable
        accessibilityRole="button"
        disabled={sent}
        style={[styles.primary, sent && styles.primarySent]}
        onPress={() => actions.askToFix(finding)}
      >
        <Text
          maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
          numberOfLines={1}
          style={[styles.primaryText, sent && styles.sentText]}
        >
          {sent ? "Sent" : `Ask ${actions.harnessName} to fix`}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        style={styles.secondary}
        onPress={() => actions.askReviewer(finding)}
      >
        <Text
          maxFontSizeMultiplier={CONTROL_TEXT_SCALE}
          numberOfLines={1}
          style={styles.secondaryText}
        >
          Ask the reviewer
        </Text>
      </Pressable>
      <View style={styles.spacer} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Not a problem"
        hitSlop={6}
        style={styles.thumb}
        onPress={onNotAProblem}
      >
        <ThumbDown colour={colours.textSubtle} />
      </Pressable>
    </View>
  );
};

export const FindingWell = memo(function FindingWell({
  finding,
  hunk,
  palette,
  actions,
}: {
  readonly finding: RiskFinding;
  readonly hunk: FindingHunk | null;
  readonly palette: DiffPalette;
  readonly actions: WellActions;
}) {
  const styles = useStyles();
  const [asking, setAsking] = useState(false);
  const wraps = useWindowDimensions().fontScale >= ACCESSIBILITY_SCALE;

  return (
    <View style={[styles.well, isDimmed(finding) && styles.dimmed]}>
      <View style={styles.head}>
        <View style={[styles.titleRow, wraps && styles.wraps]}>
          <LeadGlyph severity={finding.severity} size={9} lineHeight={20} />
          <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.title}>
            {finding.title}
          </Text>
          <Text
            maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
            style={[styles.meta, wraps && styles.under]}
          >
            {finding.status === "dismissed"
              ? `dismissed · ${findingMeta(finding)}`
              : findingMeta(finding)}
          </Text>
        </View>
        {finding.reason === "" ? null : (
          <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.reason}>
            {finding.reason}
          </Text>
        )}
      </View>
      <Hunk finding={finding} hunk={hunk} palette={palette} onOpen={actions.openFile} />
      <Actions finding={finding} actions={actions} onNotAProblem={() => setAsking((o) => !o)} />
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
});

/** A folded finding: one row in a group of wells; `first` and `last` round the group's ends. */
export const FoldedFinding = memo(function FoldedFinding({
  finding,
  first,
  last,
  onOpen,
}: {
  readonly finding: RiskFinding;
  readonly first: boolean;
  readonly last: boolean;
  readonly onOpen: (id: string) => void;
}) {
  const styles = useStyles();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Shows the finding and its diff"
      onPress={() => onOpen(finding.id)}
      style={[styles.folded, first && styles.groupTop, last && styles.groupBottom]}
    >
      <View style={[styles.foldedRow, !first && styles.rule, isDimmed(finding) && styles.dimmed]}>
        <SeverityGlyph severity={finding.severity} size={9} />
        <Text
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          numberOfLines={1}
          style={styles.foldedTitle}
        >
          {finding.title}
        </Text>
        <Text
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          numberOfLines={1}
          ellipsizeMode="middle"
          style={styles.place}
        >
          {findingPlace(finding)}
        </Text>
      </View>
    </Pressable>
  );
});

const useStyles = themedStyles((colours) => ({
  well: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.well,
    overflow: "hidden",
  },
  dimmed: { opacity: 0.55 },
  head: { gap: 3, paddingTop: 12, paddingBottom: 10, paddingHorizontal: 14 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  /** At accessibility sizes the meta goes under the title, which keeps the row's width. */
  wraps: { flexWrap: "wrap" },
  under: { width: "100%", paddingLeft: 17, marginTop: 0 },
  title: { ...mobileType.label, lineHeight: 20, flex: 1, color: colours.textStrong },
  meta: { ...mobileType.index, marginTop: 2, color: colours.textSubtle },
  reason: { ...mobileType.footnote, color: colours.textSubtle },
  hunk: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.ground,
  },
  path: { ...mobileType.index, fontSize: 11, color: colours.textFaint, padding: 14 },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
    paddingLeft: 12,
    paddingRight: 10,
  },
  primary: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 999,
    justifyContent: "center",
    flexShrink: 1,
    backgroundColor: colours.textStrong,
  },
  primarySent: { backgroundColor: colours.raised },
  primaryText: {
    ...mobileType.subhead,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
    color: colours.ground,
  },
  sentText: { color: colours.textSubtle },
  secondary: {
    height: 34,
    paddingHorizontal: 11,
    borderRadius: 999,
    justifyContent: "center",
    flexShrink: 1,
    borderWidth: 1,
    borderColor: colours.hairline,
  },
  secondaryText: {
    ...mobileType.subhead,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
    color: colours.textDefault,
  },
  spacer: { flex: 1 },
  thumb: { width: 30, height: 34, alignItems: "center", justifyContent: "center" },
  reasons: { gap: 8, paddingHorizontal: 14, paddingBottom: 14 },
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
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.well,
    paddingHorizontal: 14,
  },
  groupTop: { borderTopWidth: 1, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  groupBottom: { borderBottomWidth: 1, borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
  foldedRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 },
  rule: { borderTopWidth: 1, borderTopColor: colours.hairline },
  foldedTitle: { ...mobileType.subhead, fontWeight: "500", flex: 1, color: colours.textDefault },
  place: { ...mobileType.index, color: colours.textSubtle, flexShrink: 0, maxWidth: "45%" },
}));
