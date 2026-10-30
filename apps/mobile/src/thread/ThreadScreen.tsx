/**
 * The agent session thread (MX-E): the header with the session's celestial, the transcript as a
 * virtualized list on the open ground, every Turn in order, older ones paged in on scrolling up,
 * the inline Critical finding, suggested chips and the composer; no horizon. Data comes from the
 * Host's shared connection.
 */
import type {
  CelestialBody,
  HarnessKind,
  RiskFinding,
  SessionId,
  Workspace,
  WorkspaceId,
} from "@polaris/protocol";
import { mobileType } from "@polaris/ui/tokens";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AppState,
  FlatList,
  KeyboardAvoidingView,
  type LayoutRectangle,
  Pressable,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "../app/navigation.tsx";
import { Celestial, sessionCelestial } from "../celestial";
import { useAttachments } from "../composer/useAttachments.ts";
import { sheetContextOf } from "../composer/useModelSheet.ts";
import { useVoiceInput } from "../composer/useVoiceInput.ts";
import type { HostConnection } from "../runtime/hostConnection.ts";
import { useHost, useLiveHost } from "../runtime/hosts.tsx";
import { composerMode } from "./composer.ts";
import { Composer, Suggestions } from "./Composer.tsx";
import { openThread, type ThreadController } from "./controller.ts";
import { latestSecretOutcome } from "./fold.ts";
import { hostThreadSource } from "./hostSource.ts";
import { useMenuActions } from "../menus/index.ts";
import { type MobileColours, themedStyles } from "../theme/index.ts";
import { RiseHorizon, RiseLayer, SLOT_SIZE, useRise } from "./Rise.tsx";
import { Diamond, Row, type RowSession, type ThreadFocus } from "./Row.tsx";
import { type HeaderLine, headerLine, outgoingRows, threadRows, type ThreadRow } from "./rows.ts";
import {
  canReview,
  chipAction,
  openCritical,
  type Suggestion,
  suggestions,
} from "./suggestions.ts";
import { threadKey, threads } from "./threads.ts";
import { useAfter } from "../runtime/useAfter.ts";
import { InboxBadge } from "../inbox/index.ts";
import { ReconnectingLine } from "../states/thread.tsx";
import { CONTENT_TEXT_SCALE } from "../theme/textScale.ts";
import { liveVisualizations, revisedIds } from "../visualization/index.ts";

export interface ThreadScreenProps {
  readonly hostId: string;
  readonly sessionId: SessionId;
  readonly onBack: () => void;
  /** Opens the session in Review (M5); its Review route otherwise. */
  readonly onOpenReview?: () => void;
  /** The iPhone Duo (D6): tapping a step or the finding focuses it; `focusedKey` marks it. */
  readonly onFocus?: (focus: ThreadFocus) => void;
  readonly focusedKey?: string | null;
  /** The iPhone Duo (D7): a minimum height that keeps the chips and composer below the fold. */
  readonly composerSlot?: "inline" | { readonly minHeight: number };
  /** Takes the place of the session's header: a constellation's status above its lead's thread. */
  readonly header?: ReactNode;
  /** Drawn under the header, above the transcript: a constellation's star chart panel. */
  readonly belowHeader?: ReactNode;
  /** After the newest Turn, in the transcript: a constellation's completion card. */
  readonly atLatest?: ReactNode;
  /** Over the suggestions and composer: the lead's notice of a claim handed to the user. */
  readonly aboveComposer?: ReactNode;
  /** Just started from New session: the celestial rises off the horizon into the header (MX-AS). */
  readonly rise?: boolean;
}

interface HeldThread {
  readonly controller: ThreadController | null;
  /** False while the Host reconnects; the controller and its transcript stay. */
  readonly live: boolean;
}

/**
 * The Host and session's thread, opened once the Host is first live and kept
 * through reconnects (`threads.ts`); `live` is false while it reconnects.
 */
const useController = (connection: HostConnection | null, sessionId: SessionId): HeldThread => {
  const live = useLiveHost(connection);
  const [controller, setController] = useState<ThreadController | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const opened = connection !== null && (live !== null || controller !== null);

  useEffect(() => {
    const first = liveRef.current;

    if (!opened || connection === null) return;

    const lease = threads.acquire(
      threadKey(connection.hostId, sessionId),
      first === null
        ? null
        : () =>
            openThread(hostThreadSource(connection, first), sessionId, {
              hostName: connection.name,
            })
    );

    if (lease === null) return;
    setController(lease.controller);

    return () => {
      lease.release();
      setController(null);
    };
  }, [opened, connection, sessionId]);

  // A new epoch is a new connection: writes that failed while it was down go again.
  const epoch = live?.epoch ?? null;

  useEffect(() => {
    if (epoch !== null) controller?.reconnected();
  }, [controller, epoch]);

  useEffect(() => {
    controller?.hostLive(live !== null);
  }, [controller, live]);

  return { controller, live: live !== null };
};

const noSubscribe = () => () => {};

const useThreadState = (controller: ThreadController | null) =>
  useSyncExternalStore(controller?.subscribe ?? noSubscribe, () => controller?.get() ?? null);

/** The session's look in the header: its celestial, working while a Turn runs. */
interface HeaderBody {
  readonly body: CelestialBody;
  readonly harness: HarnessKind;
  readonly working: boolean;
}

const Header = ({
  title,
  line,
  celestial,
  criticals,
  onBack,
  onReview,
  rising = false,
  away = false,
  onSlot,
}: {
  readonly title: string;
  readonly line: HeaderLine;
  readonly celestial: HeaderBody | null;
  readonly criticals: number;
  readonly onBack: () => void;
  /** Opens the session's Review; absent until a Turn has ended. */
  readonly onReview?: (() => void) | undefined;
  /** The celestial is still on its way up (MX-AS): its slot stays empty. */
  readonly rising?: boolean;
  /** The Host is reconnecting (MX-AV): the celestial dims, nothing else changes. */
  readonly away?: boolean;
  /** The slot's place in the header, for the rise to land in. */
  readonly onSlot?: (slot: LayoutRectangle) => void;
}) => {
  const styles = useStyles();

  return (
    <View style={styles.header}>
      <Pressable
        style={styles.back}
        onPress={onBack}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <Text style={styles.backGlyph} allowFontScaling={false}>
          ‹
        </Text>
      </Pressable>
      {celestial === null ? null : (
        <View
          style={rising ? styles.slotEmpty : away ? styles.slotAway : null}
          onLayout={({ nativeEvent }) => onSlot?.(nativeEvent.layout)}
        >
          <Celestial
            body={celestial.body}
            harness={celestial.harness}
            size={SLOT_SIZE}
            working={celestial.working}
          />
        </View>
      )}
      <View style={styles.titles}>
        <Text style={styles.title} numberOfLines={1} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
          {title}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
          <Text style={styles.subtitleState}>{line.state}</Text>
          {line.rest === "" ? "" : ` · ${line.rest}`}
        </Text>
      </View>
      {criticals === 0 ? null : (
        <View style={styles.pill}>
          <Diamond />
          <Text style={styles.pillLabel}>{criticals} critical</Text>
        </View>
      )}
      {onReview === undefined ? null : (
        <Pressable
          style={styles.pill}
          onPress={onReview}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Open review"
        >
          <Text style={styles.pillLabel} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
            Review
          </Text>
        </Pressable>
      )}
      <InboxBadge />
    </View>
  );
};

const FindingRow = ({
  finding,
  onPress,
}: {
  readonly finding: RiskFinding;
  readonly onPress?: (() => void) | undefined;
}) => {
  const styles = useStyles();

  return (
    <Pressable style={styles.finding} disabled={onPress === undefined} onPress={onPress}>
      <Diamond />
      <Text style={styles.findingTitle} numberOfLines={2}>
        {finding.title}
      </Text>
      <Text style={styles.findingWhere} numberOfLines={1}>
        {finding.path.slice(finding.path.lastIndexOf("/") + 1)}:{finding.lines.start}
      </Text>
    </Pressable>
  );
};

/** Hosts the Workspace's name once the Host's Snapshot has it. */
const useWorkspace = (controller: ThreadController | null, workspaceId: WorkspaceId | null) => {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);

  useEffect(() => {
    if (controller === null || workspaceId === null) return;
    let gone = false;
    void controller.workspace(workspaceId).then((found) => {
      if (!gone) setWorkspace(found);
    });

    return () => {
      gone = true;
    };
  }, [controller, workspaceId]);

  return workspace;
};

const VIEWABILITY = { itemVisiblePercentThreshold: 50, minimumViewTime: 250 };

const keyOf = (row: ThreadRow) => row.key;

export const ThreadScreen = ({
  hostId,
  sessionId,
  onBack,
  onOpenReview,
  onFocus,
  focusedKey = null,
  composerSlot = "inline",
  header,
  belowHeader,
  atLatest,
  aboveComposer,
  rise: risen = false,
}: ThreadScreenProps) => {
  const connection = useHost(hostId);
  const rise = useRise(risen);
  const navigation = useNavigation();
  const styles = useStyles();
  const onMenuAction = useMenuActions();
  const { controller, live } = useController(connection, sessionId);
  const state = useThreadState(controller);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const visible = useRef<ReadonlyArray<string>>([]);
  const fold = state?.fold ?? null;
  const workspaceId = fold?.session.workspaceId ?? null;
  const workspace = useWorkspace(controller, workspaceId);

  const stageTarget = useMemo(
    () =>
      connection === null || workspaceId === null ? null : { connection, workspaceId, sessionId },
    [connection, workspaceId, sessionId]
  );

  const attachments = useAttachments(stageTarget);

  const voice = useVoiceInput({
    connection,
    text: state?.text ?? "",
    onText: (text) => controller?.type(text),
  });

  const steers = state?.steers;
  const queued = state?.queued;
  const sends = state?.sends;

  const rows = useMemo(
    // The list is inverted: the newest row first, at the bottom of the screen.
    () =>
      [
        ...threadRows(fold?.turns ?? [], expanded),
        ...outgoingRows(steers ?? [], queued, sends),
      ].reverse(),
    [fold?.turns, expanded, steers, queued, sends]
  );

  const revised = useMemo(() => revisedIds(fold?.turns ?? []), [fold?.turns]);
  const [onScreen, setOnScreen] = useState<ReadonlyArray<number>>([]);
  const liveFrames = useMemo(() => liveVisualizations(rows, onScreen), [rows, onScreen]);

  const editSteer = useCallback((id: string) => controller?.editSteer(id), [controller]);
  const sendAgain = useCallback((id: string) => controller?.sendAgain(id), [controller]);

  const rowsRef = useRef<ReadonlyArray<ThreadRow>>(rows);
  rowsRef.current = rows;

  const findings = state?.findings ?? [];
  const critical = openCritical(findings);

  const criticals = useMemo(
    () => findings.filter((f) => f.severity === "critical" && f.status === "open"),
    [findings]
  );

  const criticalPaths = useMemo(() => new Set(criticals.map((f) => f.path)), [criticals]);

  const harness = fold?.session.harness ?? null;
  const planet = fold?.session.celestial ?? null;

  const rowSession = useMemo(
    (): RowSession | undefined =>
      harness === null ? undefined : { hostId, sessionId, body: sessionCelestial(planet), harness },
    [hostId, sessionId, planet, harness]
  );

  const toggle = useCallback(
    (key: string) =>
      setExpanded((open) => {
        const next = new Set(open);

        if (!next.delete(key)) next.add(key);

        return next;
      }),
    []
  );

  const report = useCallback(() => {
    if (AppState.currentState === "active") controller?.seen(visible.current);
  }, [controller]);

  const reportRef = useRef(report);
  reportRef.current = report;

  const onViewable = useRef(
    ({
      viewableItems,
    }: {
      readonly viewableItems: ReadonlyArray<{ readonly index?: number | null | undefined }>;
    }) => {
      setOnScreen(viewableItems.flatMap(({ index }) => (index == null ? [] : [index])));
      visible.current = viewableItems.flatMap((token) => {
        const row: ThreadRow | undefined =
          token.index === null || token.index === undefined
            ? undefined
            : rowsRef.current[token.index];

        return row === undefined ? [] : [row.turnId];
      });
      reportRef.current();
    }
  );

  // Brief reconnects (the app coming back, a network change) stay quiet.
  const away = useAfter(!live);
  const slowToOpen = useAfter(state === null || fold === null);

  // A new Turn ending on screen, or coming back to the app, moves the read position.
  useEffect(report, [report, fold?.turns]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", () => reportRef.current());

    return () => listener.remove();
  }, []);

  if (connection === null)
    return (
      <Missing
        onBack={onBack}
        header={header}
        belowHeader={belowHeader}
        text="This host isn't linked to this iPhone"
      />
    );

  if (state === null || fold === null)
    return (
      <Missing
        onBack={onBack}
        header={header}
        belowHeader={belowHeader}
        text={state?.failure ?? (slowToOpen ? "Connecting…" : "")}
      />
    );

  const { session } = fold;
  const last = fold.turns.at(-1)?.turn ?? null;

  const mode = composerMode({
    state: session.state,
    lastTurn: last?.status ?? null,
    pendingApprovals: fold.pendingApprovals,
    canSteer: controller?.canSteer ?? false,
  });

  const chips = suggestions({
    state: session.state,
    lastTurn: last?.status ?? null,
    findings,
  });

  const openReview = () =>
    onOpenReview === undefined
      ? navigation.push({ screen: "review", hostId, sessionId, turnId: null })
      : onOpenReview();

  const pick = (chip: Suggestion) => {
    const action = chipAction(chip, hostId, sessionId);

    if (action.kind === "fill") controller?.type(action.text);
    else openReview();
  };

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={styles.screen} behavior="padding">
        {header ?? (
          <Header
            title={session.title === "" ? "Untitled" : session.title}
            line={headerLine(session, workspace?.name ?? null)}
            celestial={{
              body: sessionCelestial(session.celestial),
              harness: session.harness,
              working: session.state === "working" || session.state === "starting",
            }}
            criticals={criticals.length}
            onBack={onBack}
            onReview={canReview(fold.turns.map(({ turn }) => turn.status)) ? openReview : undefined}
            away={away}
            rising={rise.rising}
            onSlot={rise.onSlot}
          />
        )}
        {belowHeader}
        <View
          style={styles.list}
          onLayout={({ nativeEvent }) => rise.onTranscript(nativeEvent.layout)}
        >
          <RiseHorizon rise={rise} />
          <FlatList
            style={styles.list}
            contentContainerStyle={styles.listContent}
            data={rows}
            inverted
            keyExtractor={keyOf}
            renderItem={({ item }) => (
              <Row
                row={item}
                criticalPaths={criticalPaths}
                onToggle={toggle}
                onFocus={onFocus}
                focused={item.key === focusedKey}
                onEditSteer={editSteer}
                onSendAgain={sendAgain}
                hostId={hostId}
                hostName={connection.name}
                session={rowSession}
                onMenuAction={onMenuAction}
                revised={revised}
                liveFrames={liveFrames}
              />
            )}
            ListHeaderComponent={
              <>
                {atLatest}
                {critical === null ? null : (
                  <FindingRow
                    finding={critical}
                    onPress={
                      onFocus === undefined || last === null
                        ? undefined
                        : () =>
                            onFocus({
                              key: `finding:${critical.id}`,
                              turnId: last.id,
                              kind: "finding",
                              label: critical.title,
                              paths: [critical.path],
                            })
                    }
                  />
                )}
              </>
            }
            // Inverted: the end is the top, the oldest Turn; older ones page in from there.
            onEndReached={() => controller?.loadOlder()}
            onEndReachedThreshold={1.5}
            ListFooterComponent={<OlderNote loading={state.older === "loading"} />}
            initialNumToRender={16}
            maxToRenderPerBatch={12}
            windowSize={9}
            removeClippedSubviews
            onViewableItemsChanged={onViewable.current}
            viewabilityConfig={VIEWABILITY}
            keyboardDismissMode="interactive"
          />
        </View>
        <View
          style={[
            styles.bottom,
            composerSlot === "inline"
              ? null
              : { minHeight: composerSlot.minHeight, justifyContent: "flex-end" },
          ]}
        >
          {away ? <ReconnectingLine host={connection.name} onRetry={connection.retryNow} /> : null}
          {aboveComposer}
          <Suggestions items={chips} onPick={pick} />
          <Composer
            mode={mode}
            text={state.text}
            harness={session.harness}
            model={session.model}
            celestial={session.celestial}
            requests={{
              requests: fold.pendingApprovals,
              answering: state.answering,
              errors: state.requestErrors,
              enabled: live,
              onRespond: (requestId, decision) => void controller?.respond(requestId, decision),
              onProvideSecret: (requestId, typed) =>
                void controller?.provideSecret(requestId, typed),
              settled: latestSecretOutcome(fold),
            }}
            subagents={fold.subagents}
            contextUsage={session.contextUsage}
            sheet={sheetContextOf(connection, live, fold)}
            workingSince={last?.status === "working" ? last.startedAt : null}
            draftStatus={state.draftStatus}
            error={state.error}
            onChange={(text) => controller?.type(text)}
            attach={attachments.input}
            attaching={attachments.staging}
            voice={voice}
            onSend={() => {
              voice?.release();
              const sent = attachments.submission();
              void controller?.submit(sent.attachments).then((taken) => {
                if (taken) sent.done();
              });
            }}
            onQueue={() => {
              voice?.release();
              const held = attachments.submission();

              if (controller?.queue(held.attachments) === true) held.done();
            }}
            onStop={() => void controller?.interrupt()}
          />
        </View>
        <RiseLayer
          rise={rise}
          body={sessionCelestial(session.celestial)}
          harness={session.harness}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

/** At the top of the thread while older Turns are on their way. */
const OlderNote = ({ loading }: { readonly loading: boolean }) => {
  const styles = useStyles();

  return loading ? <Text style={styles.older}>Loading earlier turns…</Text> : null;
};

const Missing = ({
  text,
  onBack,
  header,
  belowHeader,
}: {
  readonly text: string;
  readonly onBack: () => void;
  readonly header: ReactNode;
  readonly belowHeader: ReactNode;
}) => {
  const styles = useStyles();

  return (
    <SafeAreaView style={styles.screen}>
      {header ?? (
        <Header
          title=""
          line={{ state: "", rest: "" }}
          celestial={null}
          criticals={0}
          onBack={onBack}
        />
      )}
      {belowHeader}
      <Text style={styles.missing}>{text}</Text>
    </SafeAreaView>
  );
};

// The arrow defers `makeStyles`, defined just below.
const useStyles = themedStyles((colours) => makeStyles(colours));

const makeStyles = (colours: MobileColours) =>
  ({
    screen: { flex: 1, backgroundColor: colours.ground },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingTop: 4,
      paddingBottom: 12,
      paddingLeft: 14,
      paddingRight: 16,
    },
    back: { width: 20, height: 36, justifyContent: "center" },
    slotEmpty: { opacity: 0 },
    slotAway: { opacity: 0.35 },
    backGlyph: { fontSize: 32, lineHeight: 34, color: colours.starlight },
    titles: { flex: 1, minWidth: 0, gap: 2 },
    title: { ...mobileType.title, fontWeight: "600", color: colours.textStrong },
    subtitle: { ...mobileType.index, color: colours.textSubtle },
    subtitleState: { fontWeight: "500", color: colours.textDefault },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      height: 30,
      paddingHorizontal: 10,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colours.hairline,
      backgroundColor: colours.panel,
    },
    pillLabel: { ...mobileType.footnote, fontWeight: "500", color: colours.textDefault },
    list: { flex: 1 },
    listContent: { paddingHorizontal: 12, paddingTop: 16, paddingBottom: 12 },
    finding: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      minHeight: 40,
      paddingLeft: 12,
      marginHorizontal: 6,
      borderLeftWidth: 2,
      borderLeftColor: colours.severityCritical,
      marginBottom: 8,
    },
    findingTitle: {
      ...mobileType.callout,
      fontWeight: "500",
      color: colours.textStrong,
      flex: 1,
    },
    findingWhere: { ...mobileType.index, color: colours.textFaint },
    // MX-E: the composer's foot sits on the home-indicator inset, with nothing added.
    bottom: { gap: 10, paddingHorizontal: 10, paddingTop: 4 },
    older: { ...mobileType.footnote, color: colours.textFaint, textAlign: "center", padding: 12 },
    missing: { ...mobileType.callout, color: colours.textSubtle, padding: 16 },
  }) as const;
