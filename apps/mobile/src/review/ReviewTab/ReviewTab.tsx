/**
 * The Review tab (Paper MX-K, with MX-M's clean lane): every Host's turns ready to review. The
 * turn most in need of you is the hero, Criticals first, with a pager; the rest wait in wells, and
 * turns with no findings are accepted from the clean lane. Empty, it says why on MX-AV's raised
 * horizon, in place of the one at its foot.
 */
import { Match } from "effect";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, SectionList, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSettledHosts } from "../../home/feed/settled.ts";
import { homeHostsOf, useFollowedHosts } from "../../home/feed/useFollowedHosts.ts";
import { useDevHomeData } from "../../home/feed/useHomeHosts.ts";
import { type HomeHost, unreachableOf } from "../../home/model/home.ts";
import { UnreachablePanel } from "../../home/ui/EmptyHome.tsx";
import { HORIZON_INSET, HorizonScreen } from "../../horizon/index.tsx";
import { useMenuActions } from "../../menus/index.ts";
import { StatePanel } from "../../states/StatePanel.tsx";
import { themedStyles } from "../../theme/index.ts";
import { type ReadyEmpty, type ReadyToReview, readyToReview } from "../ready.ts";
import { QueueHeader } from "./Header.tsx";
import { paperQueueHosts, paperQueueTurns } from "./paperQueue.testing.ts";
import { devQueues, type DevQueue } from "./worstQueue.testing.ts";
import { type HeroActions, ReviewHero } from "./Hero.tsx";
import {
  buildQueue,
  type QueueItem,
  type QueueLane,
  queueItem,
  queueLanes,
  turnKey,
} from "./queue.ts";
import { useQueueTurns } from "./useQueueTurns.tsx";
import { CleanWell, LaneHead, QueueWell } from "./Wells.tsx";

interface Ready {
  readonly hosts: ReadonlyArray<HomeHost>;
  readonly ready: ReadyToReview;
}

const DEV_QUEUES = {
  ...devQueues,
  paper: { hosts: paperQueueHosts, turns: paperQueueTurns },
} satisfies Record<string, DevQueue>;

/** The queue a development build's data toggle chose, or null for the live Hosts. */
const useDevQueue = (): DevQueue | null => {
  const data = useDevHomeData();

  return data === "live" ? null : DEV_QUEUES[data];
};

const useReady = (): Ready => {
  const followed = useFollowedHosts();
  const live = useSettledHosts(useMemo(() => homeHostsOf(followed), [followed]));
  const hosts = useDevQueue()?.hosts ?? live;

  return { hosts, ready: useMemo(() => readyToReview(hosts), [hosts]) };
};

/** The agent sessions ready to review across the followed Hosts. */
export const useReadyToReview = (): ReadyToReview => useReady().ready;

/** Re-renders each minute so ages ("42m") stay true. */
const useNow = () => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => clearInterval(timer);
  }, []);

  return now;
};

/** Why the queue is empty, as MX-AV's raised horizon: only "Nothing to review" has no action. */
const Empty = ({
  empty,
  hosts,
  onLink,
  onHosts,
}: {
  readonly empty: ReadyEmpty;
  readonly hosts: ReadonlyArray<HomeHost>;
  readonly onLink: () => void;
  readonly onHosts: () => void;
}) =>
  Match.value(empty).pipe(
    Match.when("no-hosts", () => (
      <StatePanel
        title="No hosts yet"
        line="Link this iPhone from Polaris on your Mac. Agent sessions ready to review appear here."
        action={{ label: "Link this iPhone", onPress: onLink, primary: true }}
      />
    )),
    Match.when("unreachable", () => (
      <UnreachablePanel
        unreachable={unreachableOf(hosts)}
        line="Agent sessions ready to review appear here as soon as one connects."
        onHosts={onHosts}
      />
    )),
    Match.when("none", () => (
      <StatePanel
        title="Nothing to review"
        line="An agent session appears here when its turn ends."
      />
    )),
    Match.exhaustive
  );

export interface ReviewTabProps {
  readonly tabBarHeight: number;
  readonly onOpen: (hostId: string, sessionId: string) => void;
  readonly onLink: () => void;
  readonly onHosts: () => void;
}

export const ReviewTab = ({ tabBarHeight, onOpen, onLink, onHosts }: ReviewTabProps) => {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { hosts, ready } = useReady();
  const now = useNow();
  const onMenu = useMenuActions();
  const [workspace, setWorkspace] = useState<string | null>(null);
  const read = useQueueTurns(hosts, ready.rows);
  const dev = useDevQueue();
  const turns = dev?.turns ?? read.turns;

  const workspaces = useMemo(
    () => [...new Set(ready.rows.map((row) => row.workspaceName).filter((name) => name !== ""))],
    [ready.rows]
  );

  const shown = workspace !== null && workspaces.includes(workspace) ? workspace : null;

  const queue = useMemo(
    () =>
      buildQueue(
        ready.rows
          .filter((row) => shown === null || row.workspaceName === shown)
          .map((row) => queueItem(row, turns.get(turnKey(row)) ?? null))
      ),
    [ready.rows, turns, shown]
  );

  const actions: HeroActions = {
    now,
    withHost: new Set(ready.rows.map((row) => row.hostId)).size > 1,
    open: (item) => onOpen(item.row.hostId, item.row.session.id),
    onMenu,
  };

  const lanes = useMemo(() => queueLanes(queue), [queue]);

  return (
    <HorizonScreen foot={ready.empty === null}>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        {dev === null ? read.loaders : null}
        <QueueHeader
          queue={ready.empty === null ? queue : null}
          hostCount={hosts.length}
          workspaces={workspaces}
          selected={shown}
          onSelect={setWorkspace}
          onHosts={onHosts}
        />
        {ready.empty === null ? (
          // Virtualized: a clean well mounts its own Accept, and a queue can hold hundreds.
          <SectionList<QueueItem, QueueLane>
            style={styles.list}
            contentContainerStyle={[
              styles.content,
              { paddingBottom: Math.max(HORIZON_INSET, tabBarHeight + 16) },
            ]}
            sections={lanes}
            keyExtractor={keyOfItem}
            ListHeaderComponent={<ReviewHero pages={queue.pages} actions={actions} />}
            renderSectionHeader={({ section }) => (
              <View style={laneStyle}>
                <LaneHead label={section.label} />
              </View>
            )}
            renderItem={({ item, section }) =>
              section.kind === "clean" ? (
                <CleanWell item={item} actions={actions} />
              ) : (
                <QueueWell item={item} actions={actions} />
              )
            }
            ItemSeparatorComponent={Gap}
            stickySectionHeadersEnabled={false}
            initialNumToRender={12}
            maxToRenderPerBatch={10}
            windowSize={7}
          />
        ) : (
          <ScrollView
            style={styles.list}
            contentContainerStyle={{ paddingBottom: tabBarHeight + 16 }}
          >
            <Empty empty={ready.empty} hosts={hosts} onLink={onLink} onHosts={onHosts} />
          </ScrollView>
        )}
      </View>
    </HorizonScreen>
  );
};

const keyOfItem = (item: QueueItem) => item.row.key;

const Gap = () => <View style={gapStyle} />;

// The 6pt the wells keep apart; a lane head keeps it above and below too.
const gapStyle = { height: 6 } as const;

const laneStyle = { paddingVertical: 6 } as const;

const useStyles = themedStyles(() => ({
  screen: { flex: 1 },
  list: { flex: 1 },
  content: { paddingHorizontal: 10 },
}));
