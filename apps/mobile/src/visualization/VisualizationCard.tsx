/**
 * A Visualization in the thread (DESIGN.md, Visualizations V7a/V7b): a card at most 300pt tall
 * with its title line, the frame inline without inner scrolling, and Expand to a full-height sheet.
 */
import { mobileType } from "@polaris/ui/tokens";
import { memo, useCallback, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { Celestial } from "../celestial";
import { InstrumentSheet, SheetHeader } from "../sheet/index.tsx";
import { maxHeight } from "../sheet/detents.ts";
import type { CelestialBody, HarnessKind } from "@polaris/protocol";
import { type MobileColours, themedStyles, useTheme } from "../theme/index.ts";
import { CONTENT_TEXT_SCALE } from "../theme/textScale.ts";
import { linkConfirms } from "@polaris/visualization";
import { confirmLink } from "./confirmLink.ts";
import type { Visualization } from "./model.ts";
import { flushState } from "./stateWriter.ts";
import { VisualizationFrame } from "./VisualizationFrame.tsx";

/** The card is 300pt; its title line takes 40. */
export const TITLE_HEIGHT = 40;

export const INLINE_BODY_MAX = 300 - TITLE_HEIGHT;

const FADE = 72;

/** Each Visualization's last reported height, so a remounted card keeps its place. */
const heights = new Map<string, number>();

const useStyles = themedStyles((colours) => makeStyles(colours));

/** The 14pt pixel three-bar glyph. */
const Glyph = ({ faded = false }: { readonly faded?: boolean }) => {
  const styles = useStyles();

  return (
    <View style={[styles.glyph, faded ? styles.glyphFaded : null]}>
      {[6, 14, 10].map((height) => (
        <View key={height} style={[styles.bar, { height }]} />
      ))}
    </View>
  );
};

const Fade = ({ colour }: { readonly colour: string }) => (
  <Svg width="100%" height={FADE} style={{ position: "absolute", bottom: 0 }} pointerEvents="none">
    <Defs>
      <LinearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor={colour} stopOpacity={0} />
        <Stop offset="1" stopColor={colour} stopOpacity={1} />
      </LinearGradient>
    </Defs>
    <Rect width="100%" height={FADE} fill="url(#fade)" />
  </Svg>
);

/** The body after the frame tried to open another page (DESIGN.md, Stopped). */
const Stopped = () => {
  const styles = useStyles();

  return (
    <View style={styles.stopped}>
      <Text style={styles.stoppedTitle} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
        Stopped: it tried to open another page
      </Text>
      <Text style={styles.stoppedBody} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
        A visualization has to stay on its own page, so Polaris removed it. Ask the agent to draw it
        again.
      </Text>
    </View>
  );
};

export interface CardSession {
  readonly body: CelestialBody;
  readonly harness: HarnessKind;
}

export interface VisualizationCardProps {
  readonly visualization: Visualization;
  /** A later Visualization replaces this one: it collapses to its title line. */
  readonly revised: boolean;
  /** It may hold a live WebView now (`live.ts`); otherwise its place is kept empty. */
  readonly live: boolean;
  readonly session: CardSession | undefined;
}

/** The sheet's chrome above its body (padding, grabber, header and gaps), in points. */
const SHEET_CHROME = 76;

const ExpandedSheet = ({
  visualization,
  open,
  onOpenLink,
  onClose,
  onStopped,
}: {
  readonly visualization: Visualization;
  readonly open: boolean;
  readonly onOpenLink: (url: string) => void;
  readonly onClose: () => void;
  readonly onStopped: () => void;
}) => {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();

  const height =
    maxHeight({ height: window.height, topInset: insets.top }) -
    SHEET_CHROME -
    Math.max(insets.bottom, 16);

  return (
    <InstrumentSheet open={open} onClose={onClose} detents={["large"]}>
      <SheetHeader
        title={visualization.title}
        mark={<Glyph />}
        control={
          <Pressable style={styles.done} onPress={onClose} accessibilityRole="button" hitSlop={8}>
            <Text style={styles.doneLabel}>Done</Text>
          </Pressable>
        }
      />
      <View style={[styles.sheetBody, { height }]}>
        {open ? (
          <VisualizationFrame
            visualization={visualization}
            mode="expanded"
            onOpenLink={onOpenLink}
            onStopped={onStopped}
            style={styles.fill}
          />
        ) : null}
      </View>
    </InstrumentSheet>
  );
};

const Drawing = ({
  title,
  session,
}: {
  readonly title: string;
  readonly session: CardSession | undefined;
}) => {
  const styles = useStyles();

  return (
    <View style={styles.card}>
      <View style={[styles.titleLine, styles.titleLive]}>
        {session === undefined ? (
          <Glyph />
        ) : (
          <Celestial body={session.body} harness={session.harness} size={14} working />
        )}
        <Text style={styles.title} numberOfLines={1} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
          {title === "" ? "Drawing…" : `Drawing ${title}…`}
        </Text>
      </View>
      <View style={{ height: INLINE_BODY_MAX }} />
    </View>
  );
};

const Revised = ({
  title,
  open,
  onToggle,
}: {
  readonly title: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}) => {
  const styles = useStyles();

  return (
    <Pressable
      style={[styles.titleLine, styles.revised]}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
    >
      <Glyph faded />
      <Text
        style={styles.revisedTitle}
        numberOfLines={1}
        maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
      >
        {title}
      </Text>
      <Text style={styles.revisedNote}>Revised below</Text>
      <Text style={[styles.chevron, open ? styles.chevronOpen : null]}>›</Text>
    </Pressable>
  );
};

const VisualizationCardView = ({
  visualization,
  revised,
  live,
  session,
}: VisualizationCardProps) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const { id, title } = visualization;
  const [height, setHeight] = useState<number | null>(() => heights.get(id) ?? null);
  const [expanded, setExpanded] = useState(false);
  // The sheet joins the host on the first Expand and stays, so closing can animate.
  const [sheeted, setSheeted] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [openedRevision, setOpenedRevision] = useState(false);
  // Shared by the inline frame and the sheet: one confirm at a time, then none (ENG-634).
  const [confirms] = useState(linkConfirms);

  const openLink = useCallback(
    (url: string) => confirmLink(title, url, confirms),
    [title, confirms]
  );

  const onHeight = useCallback(
    (next: number) => {
      heights.set(id, next);
      setHeight(next);
    },
    [id]
  );

  const stop = useCallback(() => {
    setStopped(true);
    setExpanded(false);
  }, []);

  if (visualization.drawing) return <Drawing title={title} session={session} />;

  if (revised && !openedRevision)
    return <Revised title={title} open={false} onToggle={() => setOpenedRevision(true)} />;

  const shown = Math.min(height ?? INLINE_BODY_MAX, INLINE_BODY_MAX);
  const overflows = height !== null && height > INLINE_BODY_MAX;

  const expand = () => {
    setSheeted(true);
    setExpanded(true);
  };

  // The inline frame steps aside while the sheet is open and reads the saved state on its return.
  const close = () => {
    flushState(id);
    setExpanded(false);
  };

  return (
    <View style={styles.card}>
      {revised ? (
        <Revised title={title} open onToggle={() => setOpenedRevision(false)} />
      ) : (
        <Pressable
          style={styles.titleLine}
          disabled={stopped}
          onPress={expand}
          accessibilityRole="button"
          accessibilityLabel={`${title}, expand`}
        >
          <Glyph />
          <Text style={styles.title} numberOfLines={1} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
            {title}
          </Text>
          {stopped ? null : <Text style={styles.expandGlyph}>⤢</Text>}
        </Pressable>
      )}
      {stopped ? (
        <Stopped />
      ) : (
        <View style={{ height: shown }}>
          {live && !expanded ? (
            <VisualizationFrame
              visualization={visualization}
              mode="inline"
              onHeight={onHeight}
              onOpenLink={openLink}
              onStopped={stop}
              style={styles.fill}
            />
          ) : null}
          {overflows ? (
            <>
              <Fade colour={colours.panel} />
              <Pressable style={styles.tapToExpand} onPress={expand} accessibilityRole="button">
                <Text style={styles.tapLabel} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
                  Tap to expand
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>
      )}
      {stopped || !sheeted ? null : (
        <ExpandedSheet
          visualization={visualization}
          open={expanded}
          onOpenLink={openLink}
          onClose={close}
          onStopped={stop}
        />
      )}
    </View>
  );
};

export const VisualizationCard = memo(VisualizationCardView);

const makeStyles = (colours: MobileColours) =>
  ({
    card: {
      backgroundColor: colours.panel,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colours.hairline,
      overflow: "hidden",
      marginBottom: 8,
    },
    titleLine: {
      height: TITLE_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingLeft: 12,
      paddingRight: 12,
      backgroundColor: colours.well,
      borderBottomWidth: 1,
      borderBottomColor: colours.hairline,
    },
    titleLive: { backgroundColor: colours.raised },
    title: { ...mobileType.subhead, fontWeight: "500", color: colours.textStrong, flex: 1 },
    expandGlyph: { ...mobileType.subhead, color: colours.textSubtle },
    glyph: { width: 14, height: 14, flexDirection: "row", alignItems: "flex-end", gap: 2 },
    glyphFaded: { opacity: 0.6 },
    bar: { width: 3, backgroundColor: colours.textSubtle },
    revised: { backgroundColor: "transparent", borderBottomWidth: 0, marginBottom: 8 },
    revisedTitle: { ...mobileType.subhead, color: colours.textSubtle, flex: 1 },
    revisedNote: { ...mobileType.index, color: colours.textSubtle },
    chevron: { ...mobileType.subhead, color: colours.textFaint },
    chevronOpen: { transform: [{ rotate: "90deg" }] },
    fill: { flex: 1 },
    tapToExpand: {
      position: "absolute",
      bottom: 12,
      alignSelf: "center",
      height: 28,
      paddingHorizontal: 12,
      justifyContent: "center",
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colours.hairline,
      backgroundColor: colours.raised,
    },
    tapLabel: { ...mobileType.footnote, color: colours.textDefault },
    stopped: { padding: 16, gap: 4 },
    stoppedTitle: { ...mobileType.subhead, fontWeight: "500", color: colours.textDefault },
    stoppedBody: { ...mobileType.footnote, color: colours.textSubtle },
    done: {
      height: 30,
      paddingHorizontal: 14,
      justifyContent: "center",
      borderRadius: 15,
      backgroundColor: colours.raised,
      borderWidth: 1,
      borderColor: colours.hairline,
    },
    doneLabel: { ...mobileType.footnote, fontWeight: "500", color: colours.textStrong },
    sheetBody: { paddingHorizontal: 8 },
  }) as const;
