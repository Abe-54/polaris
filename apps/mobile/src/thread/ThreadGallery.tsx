/**
 * A development screen: the real thread over a fake Host, with Demo, Worst case, One and Empty
 * data, a 320pt frame, a dropped connection, and Drop, which loses the next send's answer.
 * `EXPO_PUBLIC_POLARIS_GALLERY=thread` (or `thread:moonlit`) in a development build; launched
 * with `-polarisDevThreadState reconnecting|queued|failed` it plays that MX-AV state on Demo.
 */
import { Predicate, Schema } from "effect";
import { useEffect, useState } from "react";
import { Platform, Pressable, Settings, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GalleryHosts } from "../runtime/hosts.tsx";
import { ThemeName, useTheme } from "../theme/index.ts";
import { type GalleryHost, galleryHost } from "./galleryHost.testing.ts";
import { ThreadScreen } from "./ThreadScreen.tsx";
import { threadKey, threads } from "./threads.ts";
import { DATASETS, type Dataset, sessionId } from "./worstCase.testing.ts";
import { setVisualsScene } from "../visualization/gallery.testing.ts";

// Read whole: Expo inlines EXPO_PUBLIC_ variables only where they are named in full.
const env: unknown = process.env.EXPO_PUBLIC_POLARIS_GALLERY;

const GALLERY = __DEV__ && Predicate.isString(env) ? env : "";

const [PART, THEME] = GALLERY.split(":");

export const threadGalleryOn = (): boolean => PART === "thread";

const DevThreadState = Schema.Literals(["reconnecting", "queued", "failed"]);

/** A development build's launch argument, parsed with `schema`; null when absent or not one. */
const launched = <A,>(key: string, schema: Schema.Codec<A, A>): A | null => {
  const value: unknown = __DEV__ && Platform.OS === "ios" ? Settings.get(key) : undefined;

  return Schema.is(schema)(value) ? value : null;
};

const SCRIPT = launched("polarisDevThreadState", DevThreadState);

/** `-polarisDevData worst` plays a launched state over the worst case instead of the demo. */
const DATA = launched("polarisDevData", Schema.Literals(["worst", "visuals"]));

const WORST = DATA === "worst";

// A release bundle resolves gallery.testing.ts to an empty module (ENG-555).
if (__DEV__)
  setVisualsScene(
    launched("polarisDevVisuals", Schema.Literals(["loan", "revised", "probe"])) ?? "all"
  );

const MOONLIT = THEME === "moonlit" || launched("polarisDevTheme", ThemeName) === "moonlit";

/** Plays the launched state: the Host drops, then a message goes into it, or its answer is lost. */
const useScript = (host: GalleryHost | null, setOffline: (offline: boolean) => void) =>
  useEffect(() => {
    if (host === null || SCRIPT === null) return;

    if (SCRIPT === "failed") host.dropNextAnswer();
    else setOffline(true);

    const timer = setTimeout(() => {
      if (SCRIPT === "reconnecting") return;
      const lease = threads.acquire(threadKey(host.connection.hostId, sessionId), null);
      lease?.controller.type("Rerun the flaky relay test before you push.");
      void lease?.controller.submit().finally(() => lease.release());
    }, 1500);

    return () => clearTimeout(timer);
  }, [host, setOffline]);

const SEGMENTS: ReadonlyArray<readonly [Dataset, string]> = [
  ["demo", "Demo"],
  ["worst", "Worst case"],
  ["one", "One"],
  ["empty", "Empty"],
  ["visuals", "Visuals"],
];

const HOST_NAMES: Readonly<Record<Dataset, string>> = {
  demo: "mac-studio",
  worst: "aleksandra-wisniewska-kowalczyk-macbook-pro-16-northwind",
  one: "pi",
  empty: "mac-studio",
  started: "mac-studio",
  visuals: "mac-studio",
};

const useGalleryHost = (dataset: Dataset) => {
  const [held, setHeld] = useState<GalleryHost | null>(null);

  useEffect(() => {
    let gone = false;
    let opened: GalleryHost | null = null;

    void galleryHost(`gallery-${dataset}`, HOST_NAMES[dataset], DATASETS[dataset]()).then(
      (host) => {
        opened = host;

        if (gone) host.close();
        else setHeld(host);
      }
    );

    return () => {
      gone = true;
      opened?.close();
      setHeld(null);
    };
  }, [dataset]);

  return held;
};

const Toggle = ({
  label,
  on,
  onPress,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly onPress: () => void;
}) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityState={{ selected: on }}
    style={{
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: on ? "#ffffff" : "transparent",
    }}
  >
    <Text style={{ fontSize: 12, color: on ? "#000000" : "#a0a0a0" }} allowFontScaling={false}>
      {label}
    </Text>
  </Pressable>
);

/** `-polarisDevData visuals` opens the Visualizations; a launched state plays on Demo. */
const initialDataset = (): Dataset => {
  if (DATA === "visuals") return "visuals";

  return SCRIPT === null || WORST ? "worst" : "demo";
};

export const ThreadGallery = () => {
  const { colours, name, setTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const [dataset, setDataset] = useState<Dataset>(initialDataset);
  const [narrow, setNarrow] = useState(false);
  const [offline, setOffline] = useState(false);
  const host = useGalleryHost(dataset);
  useScript(host, setOffline);

  // Once: setTheme is new each render, and the tap to switch must stick.
  useEffect(() => {
    setTheme(MOONLIT ? "moonlit" : "midnight");
  }, []);
  useEffect(() => {
    host?.setLive(!offline);
  }, [host, offline]);

  return (
    <View style={{ flex: 1, backgroundColor: colours.ground }}>
      <View
        style={{
          marginTop: insets.top,
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: 2,
          padding: 3,
          marginHorizontal: 8,
          borderRadius: 999,
          backgroundColor: "#2a2a2a",
        }}
      >
        {SEGMENTS.map(([key, label]) => (
          <Toggle key={key} label={label} on={dataset === key} onPress={() => setDataset(key)} />
        ))}
        <Toggle label="320" on={narrow} onPress={() => setNarrow(!narrow)} />
        <Toggle label="Offline" on={offline} onPress={() => setOffline(!offline)} />
        <Toggle label="Drop" on={false} onPress={() => host?.dropNextAnswer()} />
        <Toggle
          label={name}
          on={false}
          onPress={() => setTheme(name === "midnight" ? "moonlit" : "midnight")}
        />
      </View>
      <View style={{ flex: 1, width: narrow ? 320 : "100%", alignSelf: "center" }}>
        {host === null ? null : (
          <GalleryHosts hosts={[host.connection]}>
            <ThreadScreen
              key={dataset}
              hostId={host.connection.hostId}
              sessionId={sessionId}
              onBack={() => undefined}
            />
          </GalleryHosts>
        )}
      </View>
    </View>
  );
};
