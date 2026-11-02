/**
 * A development screen of every session row state, the needs you card and the badge, from Home's
 * fixtures. `EXPO_PUBLIC_POLARIS_GALLERY=rows` or `cards`, with `:moonlit` for Moonlit, in a
 * development build; tap the theme's name to switch.
 */
import type { ApprovalRequest } from "@polaris/protocol";
import { mobileFont } from "@polaris/ui/tokens";
import { Predicate } from "effect";
import { type ReactNode, useEffect } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme/index.ts";
import {
  commandApproval,
  constellation,
  minutesAgo,
  NOW,
  question,
  type SessionInput,
  session,
} from "../fixtures.testing.ts";
import type { ConstellationRow, SessionRow as Row } from "../model/home.ts";
import { NeedsYouBadge } from "./NeedsYouBadge.tsx";
import { NeedsYouCard } from "./NeedsYouCard.tsx";
import { ConstellationListRow, SessionRow } from "./rows.tsx";

// Read whole: Expo inlines EXPO_PUBLIC_ variables only where they are named in full.
const env: unknown = process.env.EXPO_PUBLIC_POLARIS_GALLERY;

const GALLERY = __DEV__ && Predicate.isString(env) ? env : "";

const [PART, THEME] = GALLERY.split(":");

export const galleryOn = (): boolean => PART === "rows" || PART === "cards";

const row = (
  input: SessionInput & { readonly minutes: number },
  extra: { readonly approval?: ApprovalRequest; readonly preview?: string } = {}
): Row => ({
  kind: "session",
  key: input.id,
  hostId: "gallery",
  hostName: "mac-studio",
  workspaceName: "polaris",
  session: session({ ...input, updatedAt: minutesAgo(input.minutes) }),
  approval: extra.approval ?? null,
  replyPreview: extra.preview ?? null,
  since: NOW - input.minutes * 60_000,
  stale: false,
});

const ROWS: ReadonlyArray<readonly [string, Row]> = [
  [
    "working",
    row(
      { id: "w", title: "Polaris planning", state: "working", turnCount: 24, minutes: 1 },
      { preview: "Writing index.html" }
    ),
  ],
  [
    "needs you",
    row(
      {
        id: "n",
        title: "Spike GPUI review screen",
        state: "needs-you",
        harness: "codex",
        minutes: 42,
      },
      { approval: commandApproval("n", "r1", "cargo build") }
    ),
  ],
  [
    "done",
    row({
      id: "d",
      title: "Mobile chrome redesign",
      harness: "codex",
      turnCount: 3,
      acceptedThroughIndex: 0,
      minutes: 12,
    }),
  ],
  [
    "failed",
    row({
      id: "f",
      title: "Fix flaky resume test",
      state: "failed",
      lastError: "exit 1 in bun test",
      minutes: 60,
    }),
  ],
  [
    "dormant",
    row({
      id: "z",
      title: "Glossary first pass for the Mobile App onboarding copy",
      state: "dormant",
      minutes: 1440,
    }),
  ],
  [
    "stale (host reconnecting)",
    {
      ...row({ id: "s", title: "Route hosts through the Polaris Relay", minutes: 4 }),
      stale: true,
    },
  ],
];

const CONSTELLATION: ConstellationRow = {
  kind: "constellation",
  key: "c",
  hostId: "gallery",
  hostName: "mac-studio",
  constellation: constellation("Orchestrator overhaul", "lead"),
  lead: session({ id: "lead", state: "working" }),
  since: NOW,
  stale: false,
};

const HERO = row(
  {
    id: "c1",
    title: "Spike GPUI review screen",
    state: "needs-you",
    harness: "codex",
    minutes: 42,
  },
  { approval: commandApproval("c1", "r2", "cargo build --release") }
);

const INBOX = row(
  { id: "c2", title: "Fix eligibility form validation", state: "needs-you", minutes: 18 },
  {
    approval: question("c2", "r3", "Monthly or annual household income?", ["Annual", "Monthly"]),
  }
);

const Kicker = ({ children }: { readonly children: string }) => (
  <Text
    style={{
      fontFamily: mobileFont.mono,
      fontSize: 11,
      lineHeight: 14,
      fontWeight: "500",
      letterSpacing: 0.9,
      color: useTheme().colours.textSubtle,
      paddingHorizontal: 6,
      paddingTop: 10,
      paddingBottom: 4,
    }}
  >
    {children.toUpperCase()}
  </Text>
);

const Frame = ({ inbox, children }: { readonly inbox: boolean; readonly children: ReactNode }) => {
  const { colours } = useTheme();

  return (
    <View
      style={{
        backgroundColor: colours.raised,
        borderColor: colours.hairline,
        borderWidth: 1,
        borderRadius: inbox ? 18 : 26,
        padding: 14,
      }}
    >
      {children}
    </View>
  );
};

export const RowGallery = () => {
  const { colours, name, setTheme } = useTheme();
  const insets = useSafeAreaInsets();
  const noop = () => undefined;

  // Once: setTheme is new each render, and the tap to switch must stick.
  useEffect(() => {
    setTheme(THEME === "moonlit" ? "moonlit" : "midnight");
  }, []);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colours.ground }}
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 40,
        paddingHorizontal: 10,
        gap: 2,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 6 }}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setTheme(name === "midnight" ? "moonlit" : "midnight")}
        >
          <Text style={{ color: colours.textStrong, fontSize: 28, fontWeight: "600" }}>
            {name === "midnight" ? "Midnight" : "Moonlit"}
          </Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <NeedsYouBadge count={2} onPress={noop} />
        <NeedsYouBadge count={120} onPress={noop} />
      </View>
      {PART === "rows" ? (
        <>
          {ROWS.map(([label, item]) => (
            <View key={item.key} style={{ gap: 2 }}>
              <Kicker>{label}</Kicker>
              <SessionRow row={item} now={NOW} withHost={false} onOpen={noop} />
            </View>
          ))}
          <Kicker>constellation</Kicker>
          <ConstellationListRow
            row={CONSTELLATION}
            progress={{ done: 3, working: 1, total: 7 }}
            now={NOW}
            onOpen={noop}
          />
        </>
      ) : (
        <>
          <Kicker>needs you card · hero</Kicker>
          <Frame inbox={false}>
            <NeedsYouCard item={HERO} hostId="gallery" now={NOW} onOpen={noop} />
          </Frame>
          <Kicker>needs you card · inbox</Kicker>
          <Frame inbox>
            <NeedsYouCard item={INBOX} hostId="gallery" now={NOW} onOpen={noop} />
          </Frame>
        </>
      )}
    </ScrollView>
  );
};
