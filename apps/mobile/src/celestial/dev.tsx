/**
 * Celestial previews as the app's root when Metro's environment asks for one
 * (`EXPO_PUBLIC_POLARIS_CELESTIAL=sheet|bench`): every body in both darks, or 30 rows with 10 working.
 */
import { CELESTIAL_MOONS, CELESTIAL_PLANETS, CELESTIAL_STARS } from "@polaris/protocol";
import { Predicate } from "effect";
import { celestialLabelFont } from "../theme/fonts.ts";
import { useEffect, useRef, useState } from "react";
import { ScrollView, type ScrollViewInstance, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { type AppearanceStore, ThemeName, ThemeProvider, useTheme } from "../theme";
import { serializeAppearance } from "../theme/appearance.ts";
import { displayBudget, frameStats, statsLine } from "../review/bench/frames.ts";
import { Celestial } from "./Celestial.tsx";

const BODIES = [...CELESTIAL_PLANETS, ...CELESTIAL_STARS, ...CELESTIAL_MOONS];

const HARNESSES = ["claude", "codex", "opencode", "gemini"] as const;

/** A store that always answers one theme, so each half of the sheet is a real ThemeProvider. */
const fixed = (theme: ThemeName): AppearanceStore => ({
  read: () => serializeAppearance({ theme, motion: "full" }),
  write: async () => undefined,
});

const label = { color: "#9a9ca4", fontSize: 10, fontFamily: celestialLabelFont } as const;

const Column = () => {
  const { name, colours } = useTheme();

  return (
    <View style={{ flex: 1, backgroundColor: colours.ground, padding: 8, gap: 4 }}>
      <Text style={label}>{name}</Text>
      {BODIES.map((body, i) => (
        <View key={body} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Celestial body={body} harness={HARNESSES[i % 4] ?? "claude"} size={32} />
          <Celestial body={body} harness={HARNESSES[i % 4] ?? "claude"} size={24} working />
          <Celestial body={body} harness="claude" size={16} dormant />
          <Text style={label}>{body}</Text>
        </View>
      ))}
    </View>
  );
};

const Sheet = () => (
  <ScrollView contentContainerStyle={{ flexDirection: "row" }}>
    {(["midnight", "moonlit"] as const).map((theme) => (
      <ThemeProvider key={theme} store={fixed(theme)}>
        <Column />
      </ThemeProvider>
    ))}
  </ScrollView>
);

/** Frame intervals from requestAnimationFrame for `ms`. */
const record = (ms: number): Promise<Array<number>> =>
  new Promise((resolve) => {
    const intervals: Array<number> = [];
    const start = performance.now();
    let last: number | null = null;

    const tick = (now: number) => {
      if (last !== null) intervals.push(now - last);
      last = now;

      if (now - start < ms) requestAnimationFrame(tick);
      else resolve(intervals);
    };

    requestAnimationFrame(tick);
  });

const ROWS = Array.from({ length: 30 }, (_, i) => ({
  body: BODIES[i % BODIES.length] ?? "ringed",
  harness: HARNESSES[i % 3] ?? "claude",
  working: i % 3 === 0,
}));

/** 30 session rows, 10 working, scrolled by JS like the diff bench; the result on screen and in the log. */
const Bench = () => {
  const scroll = useRef<ScrollViewInstance>(null);
  const [result, setResult] = useState("measuring…");

  useEffect(() => {
    void (async () => {
      const idle = await record(3000);
      const budget = displayBudget(idle);
      let y = 0;

      const timer = setInterval(() => {
        y = (y + 12) % 800;
        scroll.current?.scrollTo({ y, animated: false });
      }, 16);

      const scrolling = await record(5000);

      clearInterval(timer);

      const lines = [
        statsLine("still", frameStats(idle, budget)),
        statsLine("scrolling", frameStats(scrolling, budget)),
      ];

      console.log(`POLARIS_CELESTIAL_BENCH ${JSON.stringify(lines)}`);
      setResult(lines.join("\n"));
    })();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      <Text style={{ ...label, color: "#f4f5f7", padding: 8 }}>{result}</Text>
      <ScrollView ref={scroll}>
        {ROWS.map((row, i) => (
          <View
            key={i}
            style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 12, height: 56 }}
          >
            <Celestial body={row.body} harness={row.harness} size={24} working={row.working} />
            <Text style={{ color: "#e3e4e8", fontSize: 15 }}>
              {row.body} {row.working ? "· working" : ""}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
};

/** The preview root, or null when none was asked for. */
export const celestialPreviewRoot = (): (() => React.JSX.Element) | null => {
  // Read whole: Expo inlines EXPO_PUBLIC_ variables only where they are named in full.
  const env: unknown = process.env.EXPO_PUBLIC_POLARIS_CELESTIAL;

  if (!Predicate.isString(env) || env === "") return null;

  return () => (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#000000" }}>
        {env === "bench" ? <Bench /> : <Sheet />}
      </SafeAreaView>
    </SafeAreaProvider>
  );
};
