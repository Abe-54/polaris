/**
 * The constellation on the unfolded Duo (Paper MX-AG): the star chart across the first half with
 * the constellation's head, and the chosen task's claim in the second. A development build
 * launched with `-polarisDevSpan paper` shows MX-AG's own constellation.
 */
import { mobileFont, mobileType, mobileWeight } from "@polaris/ui/tokens";
import { Schema } from "effect";
import { useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  Settings,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import type { ConstellationSource } from "../constellation/model.ts";
import { useConstellation } from "../constellation/useConstellation.ts";
import { useVerdicts } from "../constellation/useVerdicts.ts";
import { harnessName } from "../home/model/format.ts";
import type { HostConnection } from "../runtime/hostConnection.ts";
import { useHost } from "../runtime/hosts.tsx";
import { StarChart } from "../starChart/index.ts";
import { CHROME_TEXT_SCALE, CONTENT_TEXT_SCALE } from "../theme/textScale.ts";
import { themedStyles } from "../theme/index.ts";
import { ClaimPane, type PaneVerdicts } from "./ClaimPane.tsx";
import { claimChoices, taskKey, useKept } from "./kept.ts";
import { paperSpan } from "./paperSpan.testing.ts";
import type { Rect } from "./posture.ts";
import { useEdgeInsets } from "./useEdgeInsets.ts";
import { chartRows, claimPane, firstChosen, spanChart, spanSummary } from "./span.ts";
import { DEVICE_COPY } from "../app/platformCopy.ts";

const DEV_SPAN =
  __DEV__ && Platform.OS === "ios"
    ? Schema.is(Schema.Literal("paper"))(Settings.get("polarisDevSpan"))
    : false;

const placed = (rect: Rect): ViewStyle => ({
  position: "absolute",
  left: rect.x,
  top: rect.y,
  width: rect.width,
  height: rect.height,
});

const useNow = () => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);

    return () => clearInterval(timer);
  }, []);

  return now;
};

const Header = ({
  name,
  harness,
  onBack,
}: {
  readonly name: string;
  readonly harness: string | null;
  readonly onBack: (() => void) | undefined;
}) => {
  const styles = useStyles();

  return (
    <View style={styles.header}>
      {onBack === undefined ? null : (
        <Pressable
          style={({ pressed }) => [styles.back, pressed ? styles.pressed : null]}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Text style={styles.backGlyph}>‹</Text>
        </Pressable>
      )}
      <View style={styles.titles}>
        <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.sub} numberOfLines={1}>
          {harness === null ? "constellation" : `constellation · ${harnessName(harness)}`}
        </Text>
      </View>
    </View>
  );
};

interface SpanViewProps {
  readonly source: ConstellationSource;
  readonly leadHarness: string | null;
  readonly first: Rect;
  readonly second: Rect;
  readonly onBack?: (() => void) | undefined;
  /** The chosen task's verdict controls; null without a Host to send them to. */
  readonly verdictsFor: (taskId: string) => PaneVerdicts | null;
}

const SpanView = ({ source, leadHarness, first, second, onBack, verdictsFor }: SpanViewProps) => {
  const styles = useStyles();
  const now = useNow();
  const { constellation } = source;
  const [picked, setPicked] = useState<string | null>(null);

  const rows = useMemo(
    () => chartRows(constellation, source.projections, now),
    [constellation, source.projections, now]
  );

  const chart = useMemo(() => spanChart(constellation, rows), [constellation, rows]);
  const taskRows = rows.map((r) => r.row);
  const summary = spanSummary(taskRows);
  const chosen = picked ?? firstChosen(taskRows);

  const pane =
    chosen === null
      ? null
      : claimPane(constellation, source.projections, taskRows, chart, chosen, now);

  const row = taskRows.find((r) => r.id === chosen) ?? null;
  const firstEdges = useEdgeInsets(first);
  const secondEdges = useEdgeInsets(second);

  return (
    <View style={styles.screen}>
      <View
        style={[
          placed(first),
          styles.first,
          { paddingTop: 20 + firstEdges.top, paddingLeft: 24 + firstEdges.left },
        ]}
      >
        <Header name={constellation.name} harness={leadHarness} onBack={onBack} />
        <View style={styles.done}>
          <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.doneCount}>
            {summary.done}
          </Text>
          <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.doneLine}>
            {summary.line}
          </Text>
        </View>
        <ScrollView style={styles.fill} contentContainerStyle={styles.chart}>
          <StarChart
            tasks={chart.tasks}
            bands={chart.bands}
            selectedTaskId={chosen}
            onPressTask={setPicked}
          />
        </ScrollView>
      </View>
      <View
        style={[
          placed(second),
          styles.second,
          {
            paddingTop: secondEdges.top,
            paddingRight: secondEdges.right,
            paddingBottom: secondEdges.bottom,
          },
        ]}
      >
        <ClaimPane
          pane={pane}
          row={row}
          verdicts={chosen === null ? null : verdictsFor(chosen)}
          onChoose={setPicked}
          width={second.width - secondEdges.left - secondEdges.right}
        />
      </View>
    </View>
  );
};

const Live = ({
  connection,
  constellationId,
  ...view
}: {
  readonly connection: HostConnection;
  readonly constellationId: string;
} & Pick<SpanViewProps, "first" | "second" | "onBack">) => {
  const styles = useStyles();
  const feed = useConstellation(connection, constellationId);
  const verdicts = useVerdicts(connection, constellationId);
  const [choices, setChoice] = useKept(claimChoices);

  if (feed.kind === "failed") return <Text style={styles.note}>{feed.message}</Text>;

  if (feed.kind === "connecting")
    return <Text style={styles.note}>Loading the constellation…</Text>;

  const { source } = feed;
  const now = Date.now();

  const verdictsFor = (taskId: string): PaneVerdicts | null => {
    const row = chartRows(source.constellation, source.projections, now).find(
      (r) => r.row.id === taskId
    )?.row;

    if (row === undefined) return null;
    const key = taskKey(connection.hostId, constellationId, taskId);

    return {
      delivery: verdicts.find(row),
      send: verdicts.send(row),
      cancel: () => verdicts.cancel(row),
      unsent: choices.get(key) ?? null,
      onUnsent: (next) => setChoice(key, next),
    };
  };

  return (
    <SpanView
      source={source}
      leadHarness={feed.lead?.harness ?? null}
      verdictsFor={verdictsFor}
      {...view}
    />
  );
};

/** MX-AG's constellation, answering nowhere: its choices are kept, its verdicts go nowhere. */
const Paper = (view: Pick<SpanViewProps, "first" | "second" | "onBack">) => {
  const source = useMemo(() => paperSpan(Date.now()), []);
  const [choices, setChoice] = useKept(claimChoices);

  return (
    <SpanView
      source={source}
      leadHarness="claude"
      verdictsFor={(taskId) => ({
        delivery: null,
        send: () => undefined,
        cancel: () => undefined,
        unsent: choices.get(taskId) ?? null,
        onUnsent: (next) => setChoice(taskId, next),
      })}
      {...view}
    />
  );
};

export interface ConstellationSpanProps {
  readonly hostId: string;
  readonly constellationId: string;
  readonly first: Rect;
  readonly second: Rect;
  readonly onBack?: () => void;
}

export const ConstellationSpan = ({ hostId, constellationId, ...view }: ConstellationSpanProps) => {
  const styles = useStyles();
  const connection = useHost(hostId);

  if (DEV_SPAN) return <Paper {...view} />;

  return (
    <View style={styles.screen}>
      {connection === null ? (
        <Text style={styles.note}>This host isn't linked to this {DEVICE_COPY.phone}.</Text>
      ) : (
        <Live connection={connection} constellationId={constellationId} {...view} />
      )}
    </View>
  );
};

const useStyles = themedStyles((c) => ({
  screen: { flex: 1, backgroundColor: c.ground },
  fill: { flex: 1 },
  note: { ...mobileType.footnote, color: c.textSubtle, padding: 24 },
  first: {
    gap: 16,
    paddingTop: 20,
    paddingHorizontal: 24,
    borderRightWidth: 1,
    borderRightColor: c.hairline,
  },
  second: { backgroundColor: c.panel },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  back: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.raised,
  },
  pressed: { opacity: 0.7 },
  backGlyph: { fontSize: 20, lineHeight: 22, color: c.textDefault },
  titles: { flex: 1, minWidth: 0 },
  name: {
    fontFamily: mobileFont.sans,
    fontSize: 17,
    lineHeight: 22,
    fontWeight: mobileWeight.medium,
    color: c.textStrong,
  },
  sub: { ...mobileType.footnote, color: c.textSubtle },
  done: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 10 },
  doneCount: {
    fontFamily: mobileFont.sans,
    fontSize: 28,
    lineHeight: 32,
    fontWeight: "300",
    color: c.textStrong,
  },
  doneLine: { ...mobileType.subhead, lineHeight: 20, color: c.textSubtle },
  chart: { paddingBottom: 24 },
}));
