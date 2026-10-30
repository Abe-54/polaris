/**
 * Home (Paper MX-C): every Host's agent sessions, needs you as a raised hero card with a pager,
 * then working and recent rows as wells on the ground, over the horizon.
 */
import { mobileFont, mobileType, mobileWeight } from "@polaris/ui/tokens";
import { type ComponentRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  SectionList,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { Celestial, sessionCelestial } from "../celestial/index.tsx";
import { HORIZON_INSET, HorizonScreen } from "../horizon/index.tsx";
import { constellationMenu, type MenuAction, sessionMenu, useMenuActions } from "../menus/index.ts";
import { themedStyles, useReducedMotion, useTheme } from "../theme/index.ts";
import { useHomeHosts } from "./feed/useHomeHosts.ts";
import { type HeroPage, heroKicker, nextUpIndex, nextUpMeta, pageIndex } from "./model/hero.ts";
import { buildHome, type HomeRow, type SessionRow as Row, unreachableOf } from "./model/home.ts";
import {
  constellationsOnScreen,
  type HomeSection,
  homeSections,
  type SeenRow,
} from "./model/sections.ts";
import { useConstellationProgress } from "./ui/constellationProgress.ts";
import { DevDataToggle } from "./ui/DevDataToggle.tsx";
import { EmptyHome, raisesHorizon } from "./ui/EmptyHome.tsx";
import { NeedsYouStar } from "./ui/glyphs.tsx";
import { Header } from "./ui/Header.tsx";
import { NeedsYouCard, titleOf } from "./ui/NeedsYouCard.tsx";
import { ConstellationListRow, SessionRow } from "./ui/rows.tsx";
import { useInbox } from "../inbox/index.ts";
import { CHROME_TEXT_SCALE } from "../theme/textScale.ts";

export interface HomeActions {
  readonly openSession: (hostId: string, sessionId: string) => void;
  readonly openConstellation: (hostId: string, constellationId: string) => void;
  readonly openHosts: () => void;
  readonly link: () => void;
}

/** MX-C's hero edge and lift, the same in both themes. */
const HERO_EDGE = "#ffffff1f";

const HERO_SHADOW = "#000000a0";

/** Beyond this many pages the kicker's "3 of 12" carries the place alone. */
const MAX_DOTS = 7;

const useStyles = themedStyles((c) => ({
  screen: { flex: 1 },
  list: { flex: 1 },
  content: { paddingHorizontal: 10 },
  kicker: {
    fontFamily: mobileFont.mono,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: mobileWeight.medium,
    letterSpacing: 0.88,
    textTransform: "uppercase",
    color: c.textSubtle,
  },
  sectionHead: { paddingTop: 16, paddingBottom: 8, paddingHorizontal: 8 },
  gap: { height: 6 },
  hero: {
    paddingTop: 14,
    paddingBottom: 12,
    paddingHorizontal: 14,
    gap: 10,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: HERO_EDGE,
    backgroundColor: c.raised,
    shadowColor: HERO_SHADOW,
    shadowOpacity: 1,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 16 },
  },
  heroHead: { flexDirection: "row", alignItems: "center", gap: 7 },
  heroKicker: { flex: 1, color: c.needsYouText },
  dots: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: c.textFaint, opacity: 0.6 },
  dotActive: { width: 14, backgroundColor: c.needsYou, opacity: 1 },
  nextUp: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.wellRaised,
  },
  nextUpTitle: {
    ...mobileType.subhead,
    fontWeight: mobileWeight.medium,
    color: c.textDefault,
    flex: 1,
    minWidth: 0,
  },
  nextUpMeta: { ...mobileType.index, color: c.textSubtle },
}));

/** Re-renders each minute so ages ("42m") stay true. */
const useNow = () => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  return now;
};

interface HeroActions {
  readonly now: number;
  readonly open: (row: Row) => void;
  readonly onMenu: (action: MenuAction) => void;
}

const Chevron = ({ color }: { readonly color: string }) => (
  <Svg width={8} height={12} viewBox="0 0 8 12">
    <Path d="M2 2l4 4-4 4" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
  </Svg>
);

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

const NextUp = ({
  row,
  now,
  onPress,
}: {
  readonly row: Row;
  readonly now: number;
  readonly onPress: () => void;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Shows it in the card"
      onPress={onPress}
      style={styles.nextUp}
    >
      <Celestial
        body={sessionCelestial(row.session.celestial)}
        harness={row.session.harness}
        size={16}
      />
      <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.nextUpTitle} numberOfLines={1}>
        {titleOf(row.session.title)}
      </Text>
      <Text maxFontSizeMultiplier={CHROME_TEXT_SCALE} style={styles.nextUpMeta}>
        {nextUpMeta(row, now)}
      </Text>
      <Chevron color={colours.textFaint} />
    </Pressable>
  );
};

/** The raised needs you card: a page per waiting row, swiped or stepped through next up. */
const NeedsYouHero = ({
  rows,
  actions,
}: {
  readonly rows: ReadonlyArray<Row>;
  readonly actions: HeroActions;
}) => {
  const styles = useStyles();
  const reduced = useReducedMotion();
  const pager = useRef<ComponentRef<typeof ScrollView>>(null);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState<HeroPage>({ key: rows[0]?.key ?? null, index: 0 });
  const index = pageIndex(rows, page);
  const next = nextUpIndex(index, rows.length);
  const nextRow = next === null ? undefined : rows[next];

  // Keeps the pager on its row as rows above it are answered.
  useEffect(() => {
    pager.current?.scrollTo({ x: index * width, animated: false });
  }, [index, width]);

  const show = (to: number) => {
    setPage({ key: rows[to]?.key ?? null, index: to });
    pager.current?.scrollTo({ x: to * width, animated: !reduced });
  };

  const onSettle = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width === 0) return;
    const to = Math.round(nativeEvent.contentOffset.x / width);

    setPage({ key: rows[to]?.key ?? null, index: to });
  };

  return (
    <View style={styles.hero}>
      <View style={styles.heroHead}>
        <NeedsYouStar size={10} />
        <Text
          maxFontSizeMultiplier={CHROME_TEXT_SCALE}
          style={[styles.kicker, styles.heroKicker]}
          accessibilityRole="header"
        >
          {heroKicker(index, rows.length)}
        </Text>
        <PageDots count={rows.length} index={index} />
      </View>
      <View onLayout={({ nativeEvent }: LayoutChangeEvent) => setWidth(nativeEvent.layout.width)}>
        <ScrollView
          ref={pager}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          scrollEnabled={rows.length > 1}
          onMomentumScrollEnd={onSettle}
        >
          {rows.map((row) => (
            <View key={row.key} style={{ width }}>
              <NeedsYouCard
                item={row}
                hostId={row.hostId}
                now={actions.now}
                onOpen={() => actions.open(row)}
                menu={{ menu: sessionMenu(row), onAction: actions.onMenu }}
              />
            </View>
          ))}
        </ScrollView>
      </View>
      {nextRow === undefined || next === null ? null : (
        <NextUp row={nextRow} now={actions.now} onPress={() => show(next)} />
      )}
    </View>
  );
};

const ConstellationRowWithProgress = ({
  row,
  now,
  onScreen,
  onOpen,
  onMenu,
}: {
  readonly row: Extract<HomeRow, { kind: "constellation" }>;
  readonly now: number;
  readonly onScreen: boolean;
  readonly onOpen: () => void;
  readonly onMenu: (action: MenuAction) => void;
}) => (
  <ConstellationListRow
    row={row}
    now={now}
    onOpen={onOpen}
    menu={{ menu: constellationMenu(row), onAction: onMenu }}
    progress={useConstellationProgress(row.hostId, row.constellation.id, onScreen)}
  />
);

const ListRow = ({
  row,
  now,
  withHost,
  onScreen,
  actions,
  onMenu,
}: {
  readonly row: HomeRow;
  readonly now: number;
  readonly withHost: boolean;
  readonly onScreen: boolean;
  readonly actions: HomeActions;
  readonly onMenu: (action: MenuAction) => void;
}) =>
  row.kind === "constellation" ? (
    <ConstellationRowWithProgress
      row={row}
      now={now}
      onScreen={onScreen}
      onOpen={() => actions.openConstellation(row.hostId, row.constellation.id)}
      onMenu={onMenu}
    />
  ) : (
    <SessionRow
      row={row}
      now={now}
      withHost={withHost}
      menu={{ menu: sessionMenu(row), onAction: onMenu }}
      onOpen={() => actions.openSession(row.hostId, row.session.id)}
    />
  );

const SectionHead = ({ section }: { readonly section: HomeSection }) => {
  const styles = useStyles();

  return (
    <View style={styles.sectionHead}>
      <Text
        maxFontSizeMultiplier={CHROME_TEXT_SCALE}
        style={styles.kicker}
        accessibilityRole="header"
      >
        {section.label}
      </Text>
    </View>
  );
};

const Gap = () => <View style={useStyles().gap} />;

const VIEWABILITY = { itemVisiblePercentThreshold: 1 } as const;

export const HomeScreen = ({
  actions,
  tabBarHeight,
}: {
  readonly actions: HomeActions;
  readonly tabBarHeight: number;
}) => {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const shownHosts = useHomeHosts();
  const [workspace, setWorkspace] = useState<string | null>(null);
  const now = useNow();
  const onMenu = useMenuActions();
  const inbox = useInbox();

  const home = useMemo(() => buildHome(shownHosts, workspace), [shownHosts, workspace]);
  const unreachable = useMemo(() => unreachableOf(shownHosts), [shownHosts]);

  const hero: HeroActions = {
    now,
    open: (row) => actions.openSession(row.hostId, row.session.id),
    onMenu,
  };

  const withHost = shownHosts.length > 1;
  const sections = useMemo(() => homeSections(home), [home]);
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(() => new Set());

  const onViewable = useCallback(
    ({ viewableItems }: { readonly viewableItems: ReadonlyArray<SeenRow> }) =>
      setOnScreen(constellationsOnScreen(viewableItems)),
    []
  );

  return (
    <HorizonScreen foot={!raisesHorizon(home.empty)}>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <Header
          home={home}
          selected={workspace}
          onSelect={setWorkspace}
          onHosts={actions.openHosts}
          onInbox={inbox.open}
        />
        <SectionList<HomeRow, HomeSection>
          style={styles.list}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: Math.max(HORIZON_INSET, tabBarHeight + 16) },
          ]}
          sections={home.empty === null ? sections : []}
          keyExtractor={(row) => row.key}
          stickySectionHeadersEnabled={false}
          initialNumToRender={12}
          windowSize={5}
          viewabilityConfig={VIEWABILITY}
          onViewableItemsChanged={onViewable}
          ListHeaderComponent={
            home.sections.needsYou.length > 0 ? (
              <NeedsYouHero rows={home.sections.needsYou} actions={hero} />
            ) : undefined
          }
          ListEmptyComponent={
            home.empty === null ? undefined : (
              <EmptyHome
                empty={home.empty}
                unreachable={unreachable}
                workspace={workspace}
                onLink={actions.link}
                onHosts={actions.openHosts}
                onAll={() => setWorkspace(null)}
              />
            )
          }
          renderSectionHeader={({ section }) => <SectionHead section={section} />}
          ItemSeparatorComponent={Gap}
          renderItem={({ item }) => (
            <ListRow
              row={item}
              now={now}
              withHost={withHost}
              onScreen={onScreen.has(item.key)}
              actions={actions}
              onMenu={onMenu}
            />
          )}
        />
      </View>
      <DevDataToggle bottom={tabBarHeight + 8} />
    </HorizonScreen>
  );
};
