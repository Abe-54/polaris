/**
 * The review queue's hero (Paper MX-K): the turn most in need of you, Criticals first, with a
 * pager through the rest; its tally, its top finding, and Open review beside Accept.
 */
import type { RiskFinding } from "@polaris/protocol";
import { mobileFont, mobileType, mobileWeight } from "@polaris/ui/tokens";
import { heroShadow } from "../../theme/shadows.ts";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Celestial, sessionCelestial } from "../../celestial/index.tsx";
import { age, grouped } from "../../home/model/format.ts";
import { titleOf } from "../../home/ui/NeedsYouCard.tsx";
import { LongPressMenu, type MenuAction, sessionMenu } from "../../menus/index.ts";
import { themedStyles, useReducedMotion, useTheme } from "../../theme/index.ts";
import {
  ACCESSIBILITY_SCALE,
  CHROME_TEXT_SCALE,
  CONTENT_TEXT_SCALE,
} from "../../theme/textScale.ts";
import { highest, SEVERITIES } from "../model.ts";
import { SeverityGlyph, severityLabel, severityText } from "../severity.tsx";
import { AskToFix, QueueAccept } from "./actions.tsx";
import { heroKicker, heroMeta, type QueueItem, riskNote } from "./queue.ts";

/** MX-K's hero edge and lift, the same in both themes. */
const HERO_EDGE = "#ffffff1f";

/** Beyond this many pages the kicker's "3 of 12" carries the place alone. */
const MAX_DOTS = 7;

export interface HeroActions {
  readonly now: number;
  readonly withHost: boolean;
  readonly open: (item: QueueItem) => void;
  readonly onMenu: (action: MenuAction) => void;
}

const PageDots = ({ count, index }: { readonly count: number; readonly index: number }) => {
  const styles = useStyles();

  if (count < 2 || count > MAX_DOTS) return null;

  return (
    <View style={styles.dots}>
      {Array.from({ length: count }, (_, n) => (
        <View key={n} style={[styles.dot, n === index ? styles.dotActive : null]} />
      ))}
    </View>
  );
};

const lineLabel = (finding: RiskFinding) =>
  `${finding.path.split("/").at(-1) ?? finding.path}:${finding.lines.start}`;

const TopFinding = ({
  item,
  finding,
}: {
  readonly item: QueueItem;
  readonly finding: RiskFinding;
}) => {
  const styles = useStyles();

  return (
    <View style={styles.finding}>
      <View style={styles.findingTop}>
        <Text
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          style={styles.findingTitle}
          numberOfLines={2}
        >
          {finding.title}
        </Text>
        <Text
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          style={styles.findingPlace}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {lineLabel(finding)}
        </Text>
      </View>
      <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.reason} numberOfLines={3}>
        {finding.reason}
      </Text>
      <View style={styles.fix}>
        <AskToFix item={item} finding={finding} />
      </View>
    </View>
  );
};

const Page = ({ item, actions }: { readonly item: QueueItem; readonly actions: HeroActions }) => {
  const styles = useStyles();
  const { session } = item.row;
  const files = item.turn?.files ?? null;
  const [top] = item.findings;
  const wraps = useWindowDimensions().fontScale >= ACCESSIBILITY_SCALE;
  const note = riskNote(item);

  return (
    <View style={[styles.page, item.row.stale ? styles.stale : null]}>
      <LongPressMenu menu={sessionMenu(item.row)} onAction={actions.onMenu}>
        <Pressable
          accessibilityRole="button"
          onPress={() => actions.open(item)}
          style={({ pressed }) => [styles.head, pressed ? styles.pressed : null]}
        >
          <Celestial
            body={sessionCelestial(session.celestial)}
            harness={session.harness}
            size={24}
          />
          <View style={styles.headText}>
            <View style={styles.titleRow}>
              <Text
                maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
                style={styles.title}
                numberOfLines={2}
              >
                {titleOf(session.title)}
              </Text>
              <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.age}>
                {age(item.row.since, actions.now)}
              </Text>
            </View>
            <View style={[styles.metaRow, wraps ? styles.metaWraps : null]}>
              <Text
                maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
                style={[styles.meta, wraps ? styles.metaWhole : null]}
                numberOfLines={wraps ? 2 : 1}
                ellipsizeMode="middle"
              >
                {heroMeta(item, actions.withHost)}
              </Text>
              {files === null ? null : (
                <>
                  <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.added}>
                    +{grouped(files.added)}
                  </Text>
                  <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.removed}>
                    −{grouped(files.removed)}
                  </Text>
                </>
              )}
            </View>
          </View>
        </Pressable>
      </LongPressMenu>
      <Readout item={item} />
      {top === undefined ? null : <TopFinding item={item} finding={top} />}
      {top === undefined && note !== null ? (
        <Text maxFontSizeMultiplier={CONTENT_TEXT_SCALE} style={styles.note}>
          {note}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          onPress={() => actions.open(item)}
          style={({ pressed }) => [styles.open, pressed ? styles.pressed : null]}
        >
          <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.openLabel}>
            Open review
          </Text>
        </Pressable>
        <QueueAccept item={item} />
      </View>
    </View>
  );
};

/** MX-K's readout: every cell a well in its severity's colour; only an open Critical is tinted. */
const Readout = ({ item }: { readonly item: QueueItem }) => {
  const styles = useStyles();
  const { colours } = useTheme();

  return (
    <View style={styles.readout}>
      {SEVERITIES.map((severity) => {
        const count = item.tally[severity];
        const tinted = severity === "critical" && count > 0;

        return (
          <View
            key={severity}
            accessibilityLabel={`${count} ${severityLabel[severity].toLowerCase()}`}
            style={[styles.cell, tinted ? styles.criticalCell : null]}
          >
            <SeverityGlyph severity={severity} size={9} />
            <Text
              maxFontSizeMultiplier={CHROME_TEXT_SCALE}
              style={[styles.cellCount, { color: severityText(colours, severity) }]}
            >
              {count}
            </Text>
          </View>
        );
      })}
    </View>
  );
};

const Kicker = ({
  item,
  index,
  count,
}: {
  readonly item: QueueItem;
  readonly index: number;
  readonly count: number;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const top = highest(SEVERITIES.filter((s) => item.tally[s] > 0));

  return (
    <View style={styles.kickerRow}>
      {top === null ? null : <SeverityGlyph severity={top} size={9} />}
      <Text
        maxFontSizeMultiplier={CHROME_TEXT_SCALE}
        style={[
          styles.kicker,
          { color: top === null ? colours.textSubtle : severityText(colours, top) },
        ]}
        accessibilityRole="header"
      >
        {heroKicker(index, count)}
      </Text>
      <PageDots count={count} index={index} />
    </View>
  );
};

/** The raised hero: a page per turn not in the clean lane, swiped through. */
export const ReviewHero = ({
  pages,
  actions,
}: {
  readonly pages: ReadonlyArray<QueueItem>;
  readonly actions: HeroActions;
}) => {
  const styles = useStyles();
  const reduced = useReducedMotion();
  const pager = useRef<ComponentRef<typeof ScrollView>>(null);
  const [width, setWidth] = useState(0);
  const [key, setKey] = useState<string | null>(pages[0]?.row.key ?? null);
  const found = pages.findIndex((item) => item.row.key === key);
  const index = found === -1 ? 0 : found;
  const current = pages[index];

  // Keeps the pager on its turn as the queue reorders around it.
  useEffect(() => {
    pager.current?.scrollTo({ x: index * width, animated: false });
  }, [index, width, reduced]);

  const onSettle = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width === 0) return;
    setKey(pages[Math.round(nativeEvent.contentOffset.x / width)]?.row.key ?? null);
  };

  if (current === undefined) return null;

  return (
    <View style={styles.hero}>
      <Kicker item={current} index={index} count={pages.length} />
      <View onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}>
        <ScrollView
          ref={pager}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEnabled={pages.length > 1}
          onMomentumScrollEnd={onSettle}
        >
          {pages.map((item) => (
            <View key={item.row.key} style={{ width }}>
              <Page item={item} actions={actions} />
            </View>
          ))}
        </ScrollView>
      </View>
    </View>
  );
};

const mono = { fontFamily: mobileFont.mono, fontSize: 12, lineHeight: 16 } as const;

const useStyles = themedStyles((c) => ({
  hero: {
    paddingTop: 14,
    paddingBottom: 12,
    paddingHorizontal: 14,
    gap: 12,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: HERO_EDGE,
    backgroundColor: c.raised,
    ...heroShadow,
  },
  kickerRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  kicker: {
    flex: 1,
    fontFamily: mobileFont.mono,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: mobileWeight.medium,
    letterSpacing: 0.88,
    textTransform: "uppercase",
  },
  dots: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: c.textFaint, opacity: 0.6 },
  dotActive: { width: 14, backgroundColor: c.textStrong, opacity: 1 },
  page: { gap: 12 },
  stale: { opacity: 0.55 },
  pressed: { opacity: 0.7 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  title: {
    flex: 1,
    fontFamily: mobileFont.sans,
    fontSize: 16,
    lineHeight: 21,
    fontWeight: mobileWeight.medium,
    color: c.textStrong,
  },
  age: { ...mono, paddingTop: 2, color: c.textSubtle, fontVariant: ["tabular-nums"] },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  /** At accessibility sizes the counts move under the meta line instead of squeezing it. */
  metaWraps: { flexWrap: "wrap" },
  metaWhole: { width: "100%" },
  meta: { ...mobileType.footnote, lineHeight: 18, color: c.textSubtle, flexShrink: 1 },
  added: { ...mono, color: c.diffAddedText },
  removed: { ...mono, color: c.diffRemovedText },
  note: { ...mono, color: c.textFaint },
  finding: {
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.wellRaised,
  },
  findingTop: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  findingTitle: {
    ...mobileType.subhead,
    fontWeight: mobileWeight.medium,
    color: c.textStrong,
    flex: 1,
  },
  findingPlace: { ...mono, color: c.textSubtle, maxWidth: 140 },
  reason: { ...mobileType.footnote, lineHeight: 18, color: c.textSubtle },
  fix: { flexDirection: "row", marginLeft: -15, marginTop: -4, marginBottom: -8 },
  readout: { flexDirection: "row", gap: 6 },
  cell: {
    flex: 1,
    height: 32,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    backgroundColor: c.wellRaised,
  },
  criticalCell: {
    borderWidth: 1,
    borderColor: `${c.severityCritical}40`,
    backgroundColor: c.severityCriticalFill,
  },
  cellCount: { ...mobileType.subhead, fontWeight: mobileWeight.medium },
  actions: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 6,
  },
  open: {
    height: 34,
    justifyContent: "center",
    paddingHorizontal: 15,
    borderRadius: 999,
    backgroundColor: c.textStrong,
  },
  openLabel: { ...mobileType.subhead, fontWeight: mobileWeight.medium, color: c.ground },
}));
