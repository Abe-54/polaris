/**
 * A turn's Review on iPhone (Paper MX-N with MX-O's pager): the Risk Summary hero, findings first
 * with their hunks inline, the file list, and Send back / Accept. Ask the reviewer (MX-S), the
 * walkthrough (MX-U), the Critical confirmation (MX-T) and a file full screen (MX-Q) open over it.
 * Presentational: `ReviewScreen` feeds it from a Host.
 */
import type { RiskFinding, RiskSummary, VerdictReason } from "@polaris/protocol";
import { mobileType } from "@polaris/ui/tokens";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  ScrollView,
  type ScrollViewInstance,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FileDiffScreen } from "../diff/index.ts";
import { grouped } from "../home/model/format.ts";
import { themedStyles, useTheme } from "../theme/index.ts";
import { CHROME_TEXT_SCALE, CONTENT_TEXT_SCALE } from "../theme/textScale.ts";
import { CriticalConfirmation, openCriticals, useAcceptReview } from "./accept/index.ts";
import { ActionBar } from "./ActionBar.tsx";
import { type DiffFileInput, fileLines, type LineRow } from "./diffRows.ts";
import type { WellActions } from "./FindingCard/Well.tsx";
import { type AcceptState, listedFindings, tally } from "./model.ts";
import { diffPalette } from "./palette.ts";
import type { AskEntry } from "./ReviewScreen/useAsks.ts";
import { AskSheet } from "./ReviewView/AskSheet.tsx";
import { BackButton } from "./ReviewView/Back.tsx";
import { Files } from "./ReviewView/Files.tsx";
import { Findings } from "./ReviewView/Findings.tsx";
import { Hero } from "./ReviewView/Hero.tsx";
import { SeverityPager } from "./ReviewView/Pager.tsx";
import { usePager } from "./ReviewView/usePager.ts";
import { walkthroughLine } from "./ReviewView/walkthrough.ts";
import { WalkthroughSheet } from "./ReviewView/WalkthroughSheet.tsx";

export interface ReviewViewProps {
  /** The agent session, `hostId/sessionId`, which keeps what Accept was confirmed despite. */
  readonly scope: string;
  readonly turnNumber: number;
  readonly sessionTitle: string;
  readonly harnessName: string;
  readonly files: ReadonlyArray<DiffFileInput> | null;
  /** Why the diff can't show, in the user's words. */
  readonly diffProblem: string | null;
  readonly summary: RiskSummary | null;
  readonly accept: AcceptState;
  readonly colourblind: boolean;
  readonly notice: string | null;
  /** Findings already sent to the agent from this screen. */
  readonly sent: ReadonlySet<string>;
  /** Questions to the reviewer, oldest first. */
  readonly asks: ReadonlyArray<AskEntry>;
  /** Why a question can't go to the reviewer now; null when it can. */
  readonly askBlocked: string | null;
  readonly onBack?: (() => void) | undefined;
  readonly onAccept: () => void;
  readonly onSendBack: (reply: string) => void;
  readonly onAskToFix: (finding: RiskFinding, lines: ReadonlyArray<LineRow>) => void;
  readonly onVerdict: (finding: RiskFinding, reason: VerdictReason | null) => void;
  readonly onAskReviewer: (finding: RiskFinding, question: string) => void;
}

const Header = ({ props }: { readonly props: ReviewViewProps }) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const palette = diffPalette(colours, props.colourblind);
  const files = props.files ?? [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  return (
    <View style={styles.header}>
      {props.onBack === undefined ? null : <BackButton onPress={props.onBack} />}
      <View style={styles.titles}>
        <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.title}>
          Turn {props.turnNumber}
        </Text>
        <View style={styles.subtitle}>
          <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} numberOfLines={1} style={styles.meta}>
            {props.sessionTitle} · {files.length} {files.length === 1 ? "file" : "files"}
          </Text>
          <Text
            maxFontSizeMultiplier={CHROME_TEXT_SCALE}
            style={[styles.count, { color: palette.addedText }]}
          >
            +{grouped(added)}
          </Text>
          <Text
            maxFontSizeMultiplier={CHROME_TEXT_SCALE}
            style={[styles.count, { color: palette.removedText }]}
          >
            −{grouped(removed)}
          </Text>
        </View>
      </View>
    </View>
  );
};

const Kicker = ({ text }: { readonly text: string }) => {
  const styles = useStyles();

  return (
    <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.kicker}>
      {text.toUpperCase()}
    </Text>
  );
};

/** The sheets and screens that open over the Review: which one, and for what. */
const useOverlays = () => {
  const [asking, setAsking] = useState<RiskFinding | null>(null);
  const [walkthrough, setWalkthrough] = useState(false);
  const [file, setFile] = useState<number | null>(null);

  return { asking, setAsking, walkthrough, setWalkthrough, file, setFile };
};

export const ReviewView = (props: ReviewViewProps) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollViewInstance>(null);
  const { colourblind, harnessName, sent, onAskToFix, onVerdict } = props;
  const palette = useMemo(() => diffPalette(colours, colourblind), [colours, colourblind]);
  const all = useMemo(() => props.summary?.findings ?? [], [props.summary]);
  const findings = useMemo(() => listedFindings(all), [all]);
  const files = useMemo(() => props.files ?? [], [props.files]);
  const counts = useMemo(() => tally(all), [all]);
  const pager = usePager(findings, scroll);
  const overlays = useOverlays();

  const accept = useAcceptReview({
    scope: props.scope,
    state: props.accept,
    findings: all,
    onAccept: props.onAccept,
  });

  const askToFix = useCallback(
    (finding: RiskFinding) => onAskToFix(finding, fileLines(files, finding.path)),
    [onAskToFix, files]
  );

  const actions = useMemo<WellActions>(
    () => ({
      harnessName,
      sent,
      askToFix,
      askReviewer: overlays.setAsking,
      verdict: onVerdict,
      openFile: overlays.setFile,
    }),
    [harnessName, sent, askToFix, overlays.setAsking, onVerdict, overlays.setFile]
  );

  const asking = overlays.asking;
  const head = props.summary?.key.head.slice(0, 6);

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.screen, { paddingTop: insets.top }]}>
      <Header props={props} />
      <View style={styles.body}>
        <ScrollView
          ref={scroll}
          contentContainerStyle={styles.content}
          onScroll={pager.onScroll}
          scrollEventThrottle={16}
        >
          <View onLayout={(e) => pager.onHeroTop(e.nativeEvent.layout.y)}>
            <Hero
              summary={props.summary}
              fileCount={files.length}
              counts={counts}
              positions={pager.positions}
              onPage={pager.onPage}
              onWalkthrough={() => overlays.setWalkthrough(true)}
              onReadoutLayout={pager.onReadoutBottom}
            />
          </View>
          {props.diffProblem === null ? null : (
            <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.problem}>
              {props.diffProblem}
            </Text>
          )}
          {findings.length === 0 ? null : <Kicker text={`Findings · ${findings.length}`} />}
          <Findings
            findings={findings}
            files={files}
            expanded={pager.expanded}
            palette={palette}
            actions={actions}
            onExpand={pager.onExpand}
            onPlace={pager.onPlace}
          />
          {files.length === 0 ? null : <Kicker text={`Files · ${files.length}`} />}
          <Files files={files} palette={palette} onOpen={overlays.setFile} />
        </ScrollView>
        {pager.pinned ? (
          <View style={styles.pinned}>
            <SeverityPager
              compact
              counts={counts}
              positions={pager.positions}
              onPage={pager.onPage}
            />
          </View>
        ) : null}
      </View>
      <ActionBar
        accept={props.accept}
        turnNumber={props.turnNumber}
        criticals={openCriticals(all).length}
        bottomInset={insets.bottom}
        notice={props.notice}
        onAccept={accept.accept}
        onSendBack={props.onSendBack}
      />
      {overlays.file === null ? null : (
        <View style={StyleSheet.absoluteFill}>
          <FileDiffScreen
            files={files}
            index={overlays.file}
            onIndexChange={overlays.setFile}
            findings={findings}
            colourblind={colourblind}
            actions={actions}
            onBack={() => overlays.setFile(null)}
          />
        </View>
      )}
      <AskSheet
        finding={asking}
        caption={`Turn ${props.turnNumber}${head === undefined ? "" : ` · read ${files.length} ${files.length === 1 ? "file" : "files"} at ${head}`}`}
        asks={asking === null ? [] : props.asks.filter((a) => a.findingId === asking.id)}
        blocked={props.askBlocked}
        harnessName={harnessName}
        fixSent={asking !== null && sent.has(asking.id)}
        onAsk={props.onAskReviewer}
        onAskToFix={askToFix}
        onVerdict={(finding, reason) => {
          overlays.setAsking(null);
          onVerdict(finding, reason);
        }}
        onClose={() => overlays.setAsking(null)}
      />
      <WalkthroughSheet
        groups={overlays.walkthrough ? (walkthroughLine(props.summary)?.groups ?? null) : null}
        turnNumber={props.turnNumber}
        onClose={() => overlays.setWalkthrough(false)}
      />
      <CriticalConfirmation
        confirming={accept.confirming}
        confirm={accept.confirm}
        dismiss={accept.dismiss}
        turnNumber={props.turnNumber}
        agentName={harnessName}
        onAsk={(criticals: ReadonlyArray<RiskFinding>) => {
          accept.dismiss();
          criticals.forEach(askToFix);
        }}
      />
    </KeyboardAvoidingView>
  );
};

const useStyles = themedStyles((colours) => ({
  screen: { flex: 1, backgroundColor: colours.ground },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 4,
    paddingBottom: 12,
    paddingHorizontal: 16,
  },
  titles: { flex: 1, gap: 1, minWidth: 0 },
  title: { ...mobileType.title, fontWeight: "600", color: colours.textStrong },
  subtitle: { flexDirection: "row", alignItems: "center", gap: 6 },
  meta: { ...mobileType.footnote, color: colours.textSubtle, flexShrink: 1 },
  count: { ...mobileType.index, flexShrink: 0 },
  body: { flex: 1 },
  content: { paddingHorizontal: 10, paddingBottom: 140 },
  problem: {
    ...mobileType.footnote,
    color: colours.textSubtle,
    paddingTop: 12,
    paddingHorizontal: 8,
  },
  kicker: {
    ...mobileType.index,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "500",
    letterSpacing: 0.9,
    color: colours.textSubtle,
    paddingTop: 18,
    paddingBottom: 4,
    paddingHorizontal: 8,
  },
  pinned: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 44,
    justifyContent: "center",
    paddingHorizontal: 10,
    backgroundColor: colours.ground,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colours.hairline,
  },
}));
