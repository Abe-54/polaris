/**
 * A development screen (break-ui): the review queue, a turn's Review, the file diff and MX-T over
 * demo, worst-case, empty, one and huge data. `EXPO_PUBLIC_POLARIS_GALLERY=review` (`:moonlit`).
 */
import { Predicate } from "effect";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { FileDiffScreen } from "../../diff/index.ts";
import { chooseDevHomeData } from "../../home/feed/useHomeHosts.ts";
import { useTheme } from "../../theme/index.ts";
import { CriticalConfirmation, openCriticals } from "../accept/index.ts";
import { ReviewTab } from "../ReviewTab/index.ts";
import { ReviewView } from "../ReviewView.tsx";
import { type GalleryData, reviewDataset } from "./datasets.testing.ts";

type Part = "queue" | "review" | "diff" | "mxt";

const PARTS: ReadonlyArray<readonly [Part, string]> = [
  ["queue", "Queue"],
  ["review", "Review"],
  ["diff", "Diff"],
  ["mxt", "MX-T"],
];

const DATA: ReadonlyArray<readonly [GalleryData, string]> = [
  ["demo", "Demo"],
  ["worst", "Worst"],
  ["empty", "Empty"],
  ["one", "One"],
  ["huge", "Huge"],
];

// Read whole: Expo inlines EXPO_PUBLIC_ variables only where they are named in full.
const env: unknown = process.env.EXPO_PUBLIC_POLARIS_GALLERY;

const GALLERY = __DEV__ && Predicate.isString(env) ? env : "";

const [NAME, THEME, START] = GALLERY.split(":");

export const reviewGalleryOn = (): boolean => NAME === "review";

const noop = () => undefined;

const Toggle = ({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityState={{ selected: on }}
    style={{
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 999,
      backgroundColor: on ? "#ffffff" : "transparent",
    }}
  >
    <Text style={{ fontSize: 11, color: on ? "#000000" : "#a0a0a0" }} allowFontScaling={false}>
      {label}
    </Text>
  </Pressable>
);

const Row = ({ children }: { readonly children: React.ReactNode }) => (
  <View
    style={{
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "center",
      gap: 1,
      padding: 2,
      borderRadius: 999,
      backgroundColor: "#2a2a2acc",
    }}
  >
    {children}
  </View>
);

const MxT = ({ data }: { readonly data: GalleryData }) => {
  const set = reviewDataset(data);
  const criticals = useMemo(() => openCriticals(set.summary.findings), [set]);
  const [open, setOpen] = useState(true);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)}>
        <Text style={{ color: "#a0a0a0" }}>
          {criticals.length === 0 ? "No open criticals: Accept goes straight through" : "Reopen"}
        </Text>
      </Pressable>
      <CriticalConfirmation
        confirming={open && criticals.length > 0 ? criticals : null}
        confirm={() => setOpen(false)}
        dismiss={() => setOpen(false)}
        turnNumber={set.turnNumber}
        agentName={set.harnessName}
        onAsk={noop}
      />
    </View>
  );
};

const Diff = ({ data }: { readonly data: GalleryData }) => {
  const set = reviewDataset(data);
  const [index, setIndex] = useState(0);

  if (set.files.length === 0)
    return (
      <Text style={{ margin: 80, color: "#a0a0a0" }}>No files: Review shows none to open</Text>
    );

  return (
    <FileDiffScreen
      files={set.files}
      index={index}
      onIndexChange={setIndex}
      findings={set.summary.findings}
      onBack={noop}
      actions={{ harnessName: set.harnessName, askToFix: noop, askReviewer: noop }}
    />
  );
};

const Review = ({ data }: { readonly data: GalleryData }) => {
  const set = reviewDataset(data);
  const critical = openCriticals(set.summary.findings).length;

  return (
    <ReviewView
      scope={`gallery/${data}`}
      turnNumber={set.turnNumber}
      sessionTitle={set.sessionTitle}
      harnessName={set.harnessName}
      files={set.files}
      diffProblem={null}
      summary={set.summary}
      accept={critical > 0 ? { kind: "paused", critical } : { kind: "ready" }}
      colourblind={false}
      notice={null}
      sent={new Set()}
      asks={[]}
      askBlocked={null}
      onBack={noop}
      onAccept={noop}
      onSendBack={noop}
      onAskToFix={noop}
      onVerdict={noop}
      onAskReviewer={noop}
    />
  );
};

const Shown = ({ part, data }: { readonly part: Part; readonly data: GalleryData }) => {
  useEffect(() => {
    chooseDevHomeData(data === "demo" ? "paper" : data);
  }, [data]);

  if (part === "queue")
    return <ReviewTab tabBarHeight={0} onOpen={noop} onLink={noop} onHosts={noop} />;

  if (part === "review") return <Review data={data} />;

  return part === "diff" ? <Diff data={data} /> : <MxT data={data} />;
};

const startPart = (): Part => PARTS.find(([id]) => id === START)?.[0] ?? "queue";

export const ReviewGallery = () => {
  const { colours, name, setTheme } = useTheme();
  const [part, setPart] = useState<Part>(startPart);
  const [data, setData] = useState<GalleryData>("worst");
  const [hidden, setHidden] = useState(false);

  // Once: setTheme is new each render, and the tap to switch must stick.
  useEffect(() => {
    setTheme(THEME === "moonlit" ? "moonlit" : "midnight");
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: colours.ground }}>
      <Shown key={`${part}:${data}`} part={part} data={data} />
      <View
        pointerEvents="box-none"
        style={{ position: "absolute", left: 6, right: 6, bottom: 4, alignItems: "center", gap: 2 }}
      >
        {hidden ? null : (
          <>
            <Row>
              {PARTS.map(([id, label]) => (
                <Toggle key={id} label={label} on={part === id} onPress={() => setPart(id)} />
              ))}
              <Toggle
                label={name}
                on={false}
                onPress={() => setTheme(name === "midnight" ? "moonlit" : "midnight")}
              />
            </Row>
            <Row>
              {DATA.map(([id, label]) => (
                <Toggle key={id} label={label} on={data === id} onPress={() => setData(id)} />
              ))}
            </Row>
          </>
        )}
        <Toggle label={hidden ? "•" : "hide"} on={false} onPress={() => setHidden(!hidden)} />
      </View>
    </View>
  );
};
