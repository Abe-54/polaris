/**
 * The constellation header (Paper MX-W, compressing to MX-X): a panel above the lead's thread
 * with the done count, the stats chip, the star chart and its legend. Tap only. Once the thread
 * scrolls back it folds to its top row (`collapse.ts`).
 */
import { mobileFont, mobileType } from "@polaris/ui/tokens";
import { useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { StarChart, StarLegend, starCounts } from "../../starChart/index.ts";
import { CHROME_TEXT_SCALE } from "../../theme/textScale.ts";
import { themedStyles } from "../../theme/index.ts";
import { type ChartFit, chartFit } from "./fit.ts";
import type { StarChartData } from "./stars.ts";

/** The chart's share of the screen; past it the waves compress to dots, then bands fold away. */
export const CHART_SHARE = 0.22;

export interface ChartPanelProps {
  readonly chart: StarChartData;
  /** The stats chip's reading, e.g. "1h 12m". */
  readonly stats: string;
  readonly selectedTaskId: string | null;
  /** Only the top row: the done count and the stats chip. */
  readonly collapsed?: boolean;
  readonly onPressTask: (taskId: string) => void;
  readonly onOpenStats: () => void;
  readonly onViewAll: () => void;
}

export const ChartPanel = ({
  chart,
  stats,
  selectedTaskId,
  collapsed = false,
  onPressTask,
  onOpenStats,
  onViewAll,
}: ChartPanelProps) => {
  const styles = useStyles();
  const { done } = starCounts(chart.tasks);
  const { height } = useWindowDimensions();
  const [width, setWidth] = useState<number | null>(null);
  const fit = width === null ? null : chartFit(chart, width, height * CHART_SHARE);

  return (
    <View style={styles.panel}>
      <View style={styles.top}>
        <Text style={styles.kicker} maxFontSizeMultiplier={CHROME_TEXT_SCALE} numberOfLines={1}>
          CONSTELLATION
        </Text>
        <Text style={styles.done} maxFontSizeMultiplier={CHROME_TEXT_SCALE} numberOfLines={1}>
          {done} of {chart.tasks.length} done
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Stats, ${stats}`}
          hitSlop={8}
          onPress={onOpenStats}
          style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
        >
          <Text style={styles.chipText} maxFontSizeMultiplier={CHROME_TEXT_SCALE}>
            {stats} ›
          </Text>
        </Pressable>
      </View>
      {collapsed ? null : (
        <ChartBody
          chart={chart}
          fit={fit}
          selectedTaskId={selectedTaskId}
          onLayoutWidth={setWidth}
          onPressTask={onPressTask}
          onViewAll={onViewAll}
        />
      )}
    </View>
  );
};

/** The chart, its "+n more bands" and the legend: what folds away. */
const ChartBody = ({
  chart,
  fit,
  selectedTaskId,
  onLayoutWidth,
  onPressTask,
  onViewAll,
}: {
  readonly chart: StarChartData;
  readonly fit: ChartFit | null;
  readonly selectedTaskId: string | null;
  readonly onLayoutWidth: (width: number) => void;
  readonly onPressTask: (taskId: string) => void;
  readonly onViewAll: () => void;
}) => {
  const styles = useStyles();

  return (
    <>
      <View onLayout={(event) => onLayoutWidth(event.nativeEvent.layout.width)}>
        {fit === null ? null : (
          <StarChart
            tasks={fit.tasks}
            bands={chart.bands}
            compact={fit.compact}
            selectedTaskId={selectedTaskId}
            onPressTask={onPressTask}
          />
        )}
      </View>
      {fit === null || fit.hiddenBands === 0 ? null : (
        <Pressable accessibilityRole="button" hitSlop={6} onPress={onViewAll}>
          <Text style={styles.more} maxFontSizeMultiplier={CHROME_TEXT_SCALE}>
            +{fit.hiddenBands} more {fit.hiddenBands === 1 ? "band" : "bands"}
          </Text>
        </Pressable>
      )}
      <StarLegend tasks={chart.tasks} compact={fit?.compact ?? false} onViewAll={onViewAll} />
    </>
  );
};

const useStyles = themedStyles((colours) => ({
  panel: {
    marginHorizontal: 16,
    marginBottom: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 20,
    gap: 10,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.panel,
  },
  // One line: the kicker gives way to the done count and the chip, which never truncate.
  top: { flexDirection: "row", alignItems: "center", gap: 8 },
  kicker: {
    fontFamily: mobileFont.mono,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "500",
    letterSpacing: 0.88,
    flexShrink: 1,
    minWidth: 0,
    color: colours.textSubtle,
  },
  done: {
    ...mobileType.footnote,
    fontSize: 13,
    lineHeight: 18,
    flexGrow: 1,
    flexShrink: 0,
    minWidth: 0,
    color: colours.textDefault,
  },
  chip: {
    flexShrink: 0,
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.raised,
  },
  chipText: {
    fontFamily: mobileFont.mono,
    fontSize: 12,
    lineHeight: 16,
    color: colours.textDefault,
  },
  more: { ...mobileType.footnote, fontSize: 12, lineHeight: 16, color: colours.textSubtle },
  pressed: { opacity: 0.7 },
}));
