/**
 * A development screen: the constellation header over the real thread on a fake Host, as MX-W
 * (12 tasks), MX-X (38) or a worst case. `EXPO_PUBLIC_POLARIS_GALLERY=constellation` (`:moonlit`).
 */
import type { DaemonClient } from "@polaris/client/rpc";
import { ConstellationRejected, type ConstellationStats, Revision } from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HostConnection, LiveHost } from "../../runtime/hostConnection.ts";
import { GalleryHosts } from "../../runtime/hosts.tsx";
import { stats as mxAbStats } from "../stats/fixtures.testing.ts";
import { useTheme } from "../../theme/index.ts";
import { type GalleryHost, galleryHost } from "../../thread/galleryHost.testing.ts";
import { DATASETS as THREADS, sessionId } from "../../thread/worstCase.testing.ts";
import { type GalleryDataset, galleryConstellation } from "./fixtures.testing.ts";
import { ChartedThread } from "./index.tsx";
import { type StressDataset, stressConstellation } from "./worstCase.testing.ts";

type Dataset = GalleryDataset | StressDataset;

const DATASETS: ReadonlyArray<readonly [Dataset, string]> = [
  ["header", "MX-W"],
  ["compressed", "MX-X"],
  ["one", "1"],
  ["thirty", "30"],
  ["worst", "Worst"],
  ["done", "Done"],
  ["refused", "Old host"],
];

/**
 * The fake Host answers ThreadRpcs only; this adds `constellation.stats` with the dataset's. One
 * wrapper per connection, so switching datasets keeps the thread's subscription.
 */
const useStatsHost = (
  connection: HostConnection | null,
  stats: ConstellationStats | null
): HostConnection | null => {
  const current = useRef(stats);
  current.current = stats;

  return useMemo(() => {
    if (connection === null) return null;
    const wrapped = new WeakMap<LiveHost, LiveHost>();

    const answer = () => {
      const read = current.current;

      return read === null
        ? Effect.fail(
            new ConstellationRejected({ findings: [], graph: null, revision: Revision.make(0) })
          )
        : Effect.succeed(read);
    };

    const live = () => {
      const inner = connection.live();

      if (inner === null) return null;
      const known = wrapped.get(inner);

      if (known !== undefined) return known;
      // SAFETY: the screen calls this RPC with one payload and no options, which `answer` serves.
      const client = { ...inner.client, "constellation.stats": answer } as DaemonClient;
      const next = { ...inner, client };

      wrapped.set(inner, next);

      return next;
    };

    return { ...connection, live };
  }, [connection]);
};

// Read whole: Expo inlines EXPO_PUBLIC_ variables only where they are named in full.
const env: unknown = process.env.EXPO_PUBLIC_POLARIS_GALLERY;

const GALLERY = __DEV__ && Predicate.isString(env) ? env : "";

const [PART, THEME] = GALLERY.split(":");

export const constellationGalleryOn = (): boolean => PART === "constellation";

const useGalleryHost = () => {
  const [held, setHeld] = useState<GalleryHost | null>(null);

  useEffect(() => {
    let gone = false;
    let opened: GalleryHost | null = null;

    void galleryHost("gallery-constellation", "mac-studio.local", THREADS.demo()).then((host) => {
      opened = host;

      if (gone) host.close();
      else setHeld(host);
    });

    return () => {
      gone = true;
      opened?.close();
    };
  }, []);

  return held;
};

const Toggle = ({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) => (
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

export const ConstellationGallery = () => {
  const { colours, name, setTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const [dataset, setDataset] = useState<Dataset>("header");
  const host = useGalleryHost();

  // Once: setTheme is new each render, and the tap to switch must stick.
  useEffect(() => {
    setTheme(THEME === "moonlit" ? "moonlit" : "midnight");
  }, []);

  const data = useMemo(() => {
    if (host === null) return null;
    const lead = { sessionId, hostId: host.connection.hostId };

    return dataset === "header" || dataset === "compressed"
      ? { source: galleryConstellation(dataset, lead, Date.now()), stats: mxAbStats() }
      : stressConstellation(dataset, lead, Date.now());
  }, [host, dataset]);

  const connection = useStatsHost(host?.connection ?? null, data?.stats ?? null);

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
        {DATASETS.map(([id, label]) => (
          <Toggle key={id} label={label} on={dataset === id} onPress={() => setDataset(id)} />
        ))}
        <Toggle
          label={name}
          on={false}
          onPress={() => setTheme(name === "midnight" ? "moonlit" : "midnight")}
        />
      </View>
      {connection === null || data === null ? null : (
        <GalleryHosts hosts={[connection]}>
          <ChartedThread
            connection={connection}
            constellationId={`gallery-${dataset}`}
            source={data.source}
            onBack={undefined}
          />
        </GalleryHosts>
      )}
    </View>
  );
};
