/**
 * The constellation view on iPhone (Paper MX-W, MX-X; DESIGN.md Mobile chrome redesign · phase
 * 2): the lead's thread under the star chart panel. A star opens its task sheet (MX-Z); past
 * about 30 tasks "View all tasks" opens the list; the stats chip opens the stats sheet.
 */
import { SessionId } from "@polaris/protocol";
import { mobileType } from "@polaris/ui/tokens";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "../../app/navigation.tsx";
import { shortHostName } from "../../home/model/format.ts";
import type { HostConnection, HostStatus } from "../../runtime/hostConnection.ts";
import { useHost, useHostStatus } from "../../runtime/hosts.tsx";
import { useAfter } from "../../runtime/useAfter.ts";
import { themedStyles } from "../../theme/index.ts";
import { ThreadScreen } from "../../thread/index.ts";
import { elapsed } from "../copy.ts";
import { type ConstellationSource, constellationView } from "../model.ts";
import { CompletionCardContent, reportedPrice, useConstellationStats } from "../stats/index.ts";
import { useConstellation } from "../useConstellation.ts";
import { useVerdicts } from "../useVerdicts.ts";
import { ChartPanel } from "./ChartPanel.tsx";
import { ClaimNotice } from "./ClaimNotice.tsx";
import { taskDetail } from "./detail.ts";
import { type OpenSheet, renderClaimSheet, renderStatsSheet } from "./sheets.tsx";
import { starChartOf } from "./stars.ts";
import { TaskSheet } from "./TaskSheet.tsx";
import { TasksSheet } from "./TasksSheet.tsx";
import { chipReading, claimNotice, completes, reviewTurnOf } from "./wiring.ts";

/** Re-render elapsed times while the screen is open; nothing runs on the Host for it. */
const useNow = (everyMs: number) => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);

    return () => clearInterval(timer);
  }, [everyMs]);

  return now;
};

/** `value` as of the last tick of `now`: a busy constellation re-reads its stats once a tick. */
const useThrottled = <T,>(value: T, now: number): T => {
  const [held, setHeld] = useState(value);

  useEffect(() => {
    setHeld(value);
  }, [now]);

  return held;
};

const awayLine = (status: HostStatus): string | null => {
  if (status.state === "connected") return null;

  if (status.state === "offline") return "The host is offline";

  return status.state === "needs-attention" ? "The host needs attention" : "Reconnecting…";
};

/** The stats chip's reading: how long the constellation has run, stopping once it completes. */
const runTime = (source: ConstellationSource, now: number): string => {
  const c = source.constellation;
  const until = c.state === "completed" || c.state === "archived" ? Date.parse(c.updatedAt) : now;

  return elapsed(Date.parse(c.createdAt), until);
};

export interface ChartedThreadProps {
  readonly connection: HostConnection;
  readonly constellationId: string;
  readonly source: ConstellationSource;
  readonly onBack: (() => void) | undefined;
}

/** The lead's thread under the star chart panel, and the sheets the panel opens. */
export const ChartedThread = ({
  connection,
  constellationId,
  source,
  onBack,
}: ChartedThreadProps) => {
  const styles = useStyles();
  const verdicts = useVerdicts(connection, constellationId);
  const navigation = useNavigation();
  const now = useNow(30_000);
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [lastClaim, setLastClaim] = useState<string | null>(null);
  const view = useMemo(() => constellationView(source, now, opened), [source, now, opened]);
  const chart = useMemo(() => starChartOf(source), [source]);
  const notice = useMemo(() => claimNotice(source, chart, now), [source, chart, now]);
  const c = source.constellation;
  const statsRevision = useThrottled(c.revision, now);
  const stats = useConstellationStats(connection, constellationId, statsRevision);
  const read = stats.kind === "ready" ? stats.stats : null;

  const close = () => setSheet(null);
  const openTask = (taskId: string) => setSheet({ kind: "task", taskId });

  const openClaim = (taskId: string) => {
    setLastClaim(taskId);
    setSheet({ kind: "claim", taskId });
  };

  const selected = sheet?.kind === "task" ? sheet.taskId : null;
  const star = chart.tasks.find((t) => t.id === selected) ?? null;

  const hostName = (hostId: string) =>
    hostId === connection.hostId ? shortHostName(connection.name) : hostId;

  const detail = star === null ? null : taskDetail(source, star, hostName, now);

  // The lead's last Turn opens in Review, as its thread's Review pill would.
  const reviewButton = (turn: ReturnType<typeof reviewTurnOf>) =>
    turn === null
      ? {}
      : {
          reviewTurn: {
            label: turn.label,
            onPress: () =>
              navigation.push({
                screen: "review",
                hostId: connection.hostId,
                sessionId: view.leadSessionId,
                turnId: turn.turnId,
              }),
          },
        };

  const slot = {
    sheet,
    onClose: close,
    source,
    connection,
    verdicts,
    now,
    chart,
    stats,
    lastClaim,
  };

  return (
    <>
      <ThreadScreen
        hostId={connection.hostId}
        sessionId={SessionId.make(view.leadSessionId)}
        onBack={onBack ?? (() => undefined)}
        belowHeader={
          <ChartPanel
            chart={chart}
            stats={chipReading(runTime(source, now), read, reportedPrice)}
            selectedTaskId={selected}
            onPressTask={openTask}
            onOpenStats={() => setSheet({ kind: "stats" })}
            onViewAll={() => setSheet({ kind: "tasks" })}
          />
        }
        aboveComposer={
          notice === null ? undefined : <ClaimNotice notice={notice} onOpen={openClaim} />
        }
        atLatest={
          completes(c.state)
            ? (last) => (
                <View style={styles.latest}>
                  <CompletionCardContent
                    source={source}
                    stats={read}
                    {...reviewButton(reviewTurnOf(last))}
                    onViewAllTasks={() => setSheet({ kind: "tasks" })}
                  />
                </View>
              )
            : undefined
        }
      />
      <TasksSheet
        open={sheet?.kind === "tasks"}
        onClose={close}
        view={view}
        verdicts={verdicts}
        hostId={connection.hostId}
        constellationId={constellationId}
        onToggleGroup={(group, next) => setOpened((m) => new Map(m).set(group, next))}
        onPressTask={openTask}
      />
      <TaskSheet
        detail={detail}
        onClose={close}
        onOpenWorker={(session) => {
          close();
          navigation.push({
            screen: "thread",
            hostId: session.hostId,
            sessionId: SessionId.make(session.sessionId),
          });
        }}
        onReviewClaim={openClaim}
      />
      {renderClaimSheet(slot)}
      {renderStatsSheet(slot)}
    </>
  );
};

const Live = ({
  connection,
  constellationId,
  onBack,
}: {
  readonly connection: HostConnection;
  readonly constellationId: string;
  readonly onBack: (() => void) | undefined;
}) => {
  const status = useHostStatus(connection);
  const feed = useConstellation(connection, constellationId);
  // Brief reconnects (the app coming back, a network change) stay quiet.
  const away = useAfter(status.state !== "connected");
  const shown: HostStatus = away ? status : { ...status, state: "connected" };

  if (feed.kind === "failed") return <Waiting text={feed.message} />;

  if (feed.kind !== "live")
    return <Waiting text={awayLine(shown) ?? "Loading the constellation…"} />;

  return (
    <ChartedThread
      connection={connection}
      constellationId={constellationId}
      source={feed.source}
      onBack={onBack}
    />
  );
};

const Waiting = ({ text }: { readonly text: string }) => {
  const styles = useStyles();

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <Text style={styles.meta}>{text}</Text>
    </SafeAreaView>
  );
};

export interface ConstellationScreenProps {
  readonly hostId: string;
  readonly constellationId: string;
  readonly onBack?: () => void;
}

export const ConstellationScreen = ({
  hostId,
  constellationId,
  onBack,
}: ConstellationScreenProps) => {
  const connection = useHost(hostId);

  return connection === null ? (
    <Waiting text="This host isn't linked to this iPhone." />
  ) : (
    <Live connection={connection} constellationId={constellationId} onBack={onBack} />
  );
};

const useStyles = themedStyles((colours) => ({
  screen: { flex: 1, backgroundColor: colours.ground },
  meta: { ...mobileType.footnote, padding: 20, color: colours.textSubtle },
  latest: { paddingHorizontal: 4, paddingVertical: 8 },
}));
