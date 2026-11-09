/**
 * A file's diff full screen (Paper MX-Q): swipe sideways between files, step between hunks, and
 * read findings under their lines. Wider than tall (MX-R), before and after sit side by side.
 */
import type { RiskFinding } from "@polaris/protocol";
import { mobileType } from "@polaris/ui/tokens";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  FlatList,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { DiffFileInput } from "../review/diffRows.ts";
import { fileSeverities, highest, listedFindings } from "../review/model.ts";
import { diffPalette } from "../review/palette.ts";
import { themedStyles, useTheme } from "../theme/index.ts";
import { CHROME_TEXT_SCALE } from "../theme/textScale.ts";
import {
  BackButton,
  Counts,
  Dots,
  EdgeTab,
  fileOf,
  FilePager,
  FindingCount,
  HunkStepper,
  Progress,
  splitPath,
} from "./chrome.tsx";
import { FilePage, type FilePageHandle } from "./FilePage.tsx";
import { useLandscapeWhileOpen } from "./orientation.ts";
import type { FileDiffScreenProps } from "./types.ts";

const NO_FINDINGS: ReadonlyArray<RiskFinding> = [];

/** The pill's height, its padding and the home indicator: what the list scrolls clear of. */
const PAGER_CLEARANCE = 120;

const Fade = ({ colour }: { readonly colour: string }) => (
  <Svg style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}>
    <Defs>
      <LinearGradient id="diff-pager-fade" x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor={colour} stopOpacity={0} />
        <Stop offset="0.3" stopColor={colour} stopOpacity={0.9} />
        <Stop offset="1" stopColor={colour} stopOpacity={1} />
      </LinearGradient>
    </Defs>
    <Rect width="100%" height="100%" fill="url(#diff-pager-fade)" />
  </Svg>
);

const PortraitHeader = ({
  file,
  index,
  count,
  onBack,
  onStep,
}: {
  readonly file: DiffFileInput;
  readonly index: number;
  readonly count: number;
  readonly onBack: (() => void) | undefined;
  readonly onStep: (direction: 1 | -1) => void;
}) => {
  const styles = useStyles();
  const { dir, name } = splitPath(file.diff.name);

  return (
    <View style={styles.header}>
      <BackButton onPress={onBack} size={40} />
      <View style={styles.titles}>
        <View style={styles.titleRow}>
          <Text
            style={styles.name}
            numberOfLines={1}
            ellipsizeMode="middle"
            maxFontSizeMultiplier={CHROME_TEXT_SCALE}
          >
            {name}
          </Text>
          <Counts file={file} />
        </View>
        <Text
          style={styles.subtitle}
          numberOfLines={1}
          ellipsizeMode="head"
          maxFontSizeMultiplier={CHROME_TEXT_SCALE}
        >
          {dir === "" ? fileOf(index, count) : `${dir} · ${fileOf(index, count)}`}
        </Text>
      </View>
      <HunkStepper onStep={onStep} />
    </View>
  );
};

const LandscapeHeader = ({
  file,
  index,
  count,
  findings,
  onBack,
}: {
  readonly file: DiffFileInput;
  readonly index: number;
  readonly count: number;
  readonly findings: ReadonlyArray<RiskFinding>;
  readonly onBack: (() => void) | undefined;
}) => {
  const styles = useStyles();
  const mine = listedFindings(findings).filter((f) => f.path === file.diff.name);

  return (
    <View style={styles.wideHeader}>
      <BackButton onPress={onBack} size={36} />
      <Text
        style={styles.widePath}
        numberOfLines={1}
        ellipsizeMode="head"
        maxFontSizeMultiplier={CHROME_TEXT_SCALE}
      >
        {file.diff.name}
      </Text>
      <Counts file={file} />
      <View style={styles.spacer} />
      <FindingCount count={mine.length} top={highest(fileSeverities(findings, file.diff.name))} />
      <Text style={styles.fileOf} maxFontSizeMultiplier={CHROME_TEXT_SCALE}>
        {fileOf(index, count)}
      </Text>
      <Dots index={index} count={count} />
    </View>
  );
};

/** Which page a pager scrolled `x` points across shows. */
export const pageAt = (x: number, width: number, count: number): number =>
  Math.min(Math.max(0, Math.round(x / Math.max(1, width))), Math.max(0, count - 1));

export const FileDiffScreen = ({
  files,
  index,
  onIndexChange,
  findings = NO_FINDINGS,
  colourblind = false,
  onBack,
  actions,
}: FileDiffScreenProps) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const layout = width > height ? "split" : "unified";
  const palette = useMemo(() => diffPalette(colours, colourblind), [colours, colourblind]);
  const pager = useRef<FlatList<DiffFileInput>>(null);
  const current = useRef<FilePageHandle>(null);
  const shown = useRef(index);
  const side = layout === "split" ? Math.max(insets.left, insets.right, 16) : 0;
  const pageWidth = width - side * 2;
  const file = files[index];

  useLandscapeWhileOpen();

  // A page change from outside (the pill, the edge tab, the caller) scrolls the pager to it.
  useEffect(() => {
    if (shown.current === index || files[index] === undefined) return;
    shown.current = index;
    pager.current?.scrollToIndex({ index, animated: true });
  }, [index, files]);

  const go = useCallback(
    (to: number) => {
      if (files[to] !== undefined) onIndexChange(to);
    },
    [files, onIndexChange]
  );

  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = pageAt(event.nativeEvent.contentOffset.x, pageWidth, files.length);

    shown.current = page;

    if (page !== index) onIndexChange(page);
  };

  const bottomInset = layout === "split" ? insets.bottom + 12 : PAGER_CLEARANCE;

  const render = useCallback<ListRenderItem<DiffFileInput>>(
    ({ item, index: at }) => (
      <FilePage
        ref={at === index ? current : undefined}
        file={item}
        findings={findings}
        palette={palette}
        layout={layout}
        width={pageWidth}
        bottomInset={bottomInset}
        actions={actions}
      />
    ),
    [index, findings, palette, layout, pageWidth, bottomInset, actions]
  );

  if (file === undefined) return <View style={styles.screen} />;

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: layout === "split" ? 0 : insets.top, paddingHorizontal: side },
      ]}
    >
      {layout === "split" ? (
        <LandscapeHeader
          file={file}
          index={index}
          count={files.length}
          findings={findings}
          onBack={onBack}
        />
      ) : (
        <>
          <PortraitHeader
            file={file}
            index={index}
            count={files.length}
            onBack={onBack}
            onStep={(direction) => current.current?.step(direction)}
          />
          <Progress files={files} index={index} />
        </>
      )}
      <FlatList
        key={layout}
        ref={pager}
        data={files}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(f) => f.diff.name}
        renderItem={render}
        extraData={render}
        initialScrollIndex={index}
        getItemLayout={(_, at) => ({ length: pageWidth, offset: pageWidth * at, index: at })}
        windowSize={3}
        initialNumToRender={1}
        maxToRenderPerBatch={1}
        onMomentumScrollEnd={settle}
      />
      {layout === "unified" && files[index + 1] !== undefined ? (
        <EdgeTab onPress={() => go(index + 1)} />
      ) : null}
      {layout === "unified" ? (
        <View style={[styles.foot, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Fade colour={colours.ground} />
          <FilePager files={files} index={index} onGo={go} />
        </View>
      ) : null}
    </View>
  );
};

const useStyles = themedStyles((colours) => ({
  screen: { flex: 1, backgroundColor: colours.ground },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 4,
    paddingBottom: 10,
    paddingHorizontal: 16,
  },
  titles: { flex: 1, minWidth: 0, gap: 1 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: {
    ...mobileType.index,
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "500",
    color: colours.textStrong,
    flexShrink: 1,
  },
  subtitle: { ...mobileType.index, color: colours.textSubtle },
  wideHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 14,
    paddingBottom: 10,
  },
  widePath: {
    ...mobileType.index,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "500",
    color: colours.textStrong,
    flexShrink: 1,
  },
  spacer: { flex: 1 },
  fileOf: { ...mobileType.index, color: colours.textSubtle, textTransform: "uppercase" },
  foot: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 28,
    paddingHorizontal: 12,
  },
}));
