/**
 * A development screen of every session row state, the needs you card and the badge, from Home's
 * fixtures. `EXPO_PUBLIC_POLARIS_GALLERY=rows` or `cards`, with `:moonlit` for Moonlit, in a
 * development build; tap the theme's name to switch.
 */
import { mobileFont } from "@polaris/ui/tokens";
import { Predicate } from "effect";
import { type ReactNode, useEffect } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme/index.ts";
import { NOW } from "../fixtures.testing.ts";
import { NeedsYouBadge } from "./NeedsYouBadge.tsx";
import { NeedsYouCard } from "./NeedsYouCard.tsx";
import { CONSTELLATION, HERO, INBOX, ROWS } from "./galleryRows.testing.ts";
import { ConstellationListRow, SessionRow } from "./rows.tsx";

// Read whole: Expo inlines EXPO_PUBLIC_ variables only where they are named in full.
const env: unknown = process.env.EXPO_PUBLIC_POLARIS_GALLERY;

const GALLERY = __DEV__ && Predicate.isString(env) ? env : "";

const [PART, THEME] = GALLERY.split(":");

export const galleryOn = (): boolean => PART === "rows" || PART === "cards";

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
