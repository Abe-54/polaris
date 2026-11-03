/**
 * Settings (Paper MX-G): Appearance with a card per dark, then Hosts, Notifications and Motion.
 * Notifications holds the switch for when a constellation needs you, for every host, and opens
 * iOS Settings; each host's own switch is on its details sheet (ENG-561).
 */
import { mobileFont, mobileType } from "@polaris/ui/tokens";
import {
  ActionSheetIOS,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { PolarisPush } from "../../modules/polaris-push/index.ts";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFollowedHosts } from "../home/feed/useFollowedHosts.ts";
import { HORIZON_INSET } from "../horizon";
import { useMotionPreference, useTheme } from "../theme";
import {
  Chevron,
  DeveloperModeGlyph,
  HostsGlyph,
  MotionGlyph,
  NotificationsGlyph,
} from "./icons.tsx";
import {
  developerModeLine,
  hostsLine,
  MOTION_CHOICES,
  motionLine,
  notificationsLine,
  THEME_CARDS,
} from "./model.ts";
import {
  constellationNotifications,
  useConstellationNotifications,
} from "../push/constellations.ts";
import { useDeveloperMode } from "./useDeveloperMode.ts";
import { ThemeCard } from "./ThemeCard.tsx";
import { ACCESSIBILITY_SCALE, CONTENT_TEXT_SCALE } from "../theme/textScale.ts";
import { InboxBadge } from "../inbox/index.ts";

const Row = ({
  Glyph,
  title,
  line,
  more = null,
  note = null,
  last = false,
  onPress,
}: {
  readonly Glyph: (props: { readonly color: string }) => React.JSX.Element;
  readonly title: string;
  readonly line: string;
  readonly more?: string | null;
  readonly note?: string | null;
  readonly last?: boolean;
  /** Absent for a row that only shows a value: no chevron, nothing to press. */
  readonly onPress?: () => void;
}) => {
  const { colours } = useTheme();
  // At accessibility sizes the line wraps; below them the names truncate and the note stays.
  const wraps = useWindowDimensions().fontScale >= ACCESSIBILITY_SCALE;
  const lineStyle = [styles.rowLine, { color: colours.textSubtle }];
  const kept = [more === null ? "" : ` ${more}`, note === null ? "" : ` · ${note}`];

  return (
    <Pressable
      accessibilityRole={onPress === undefined ? "text" : "button"}
      disabled={onPress === undefined}
      accessibilityLabel={[title, line, more, note].filter((part) => part !== null).join(", ")}
      onPress={onPress}
      style={[
        styles.row,
        last ? null : { borderBottomColor: colours.hairline, borderBottomWidth: 1 },
      ]}
    >
      <View style={[styles.tile, { backgroundColor: colours.raised }]}>
        <Glyph color={colours.textDefault} />
      </View>
      <View style={styles.rowText}>
        <Text
          style={[styles.rowTitle, { color: colours.textStrong }]}
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          {title}
        </Text>
        <View style={styles.lineRow}>
          <Text
            style={[lineStyle, styles.names]}
            maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
            numberOfLines={wraps ? 0 : 1}
          >
            {line}
            {wraps ? kept[0] : null}
            {wraps ? <Text style={{ color: colours.needsYouText }}>{kept[1]}</Text> : null}
          </Text>
          {wraps ? null : (
            <Text
              style={[lineStyle, styles.kept]}
              maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
              numberOfLines={1}
            >
              {kept[0]}
              <Text style={{ color: colours.needsYouText }}>{kept[1]}</Text>
            </Text>
          )}
        </View>
      </View>
      {onPress === undefined ? null : <Chevron color={colours.textFaint} />}
    </Pressable>
  );
};

const chooseMotion = (setMotion: (motion: (typeof MOTION_CHOICES)[number]["motion"]) => void) =>
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: "Motion",
      options: [...MOTION_CHOICES.map((choice) => choice.label), "Cancel"],
      cancelButtonIndex: MOTION_CHOICES.length,
    },
    (index) => {
      const choice = MOTION_CHOICES[index];

      if (choice !== undefined) setMotion(choice.motion);
    }
  );

const chooseNotifications = (on: boolean) =>
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: "Notifications",
      message: "When a constellation needs you, on this iPhone, for every host",
      options: [
        on ? "Turn off constellation notifications" : "Turn on constellation notifications",
        "Open iOS Settings",
        "Cancel",
      ],
      cancelButtonIndex: 2,
    },
    (index) => {
      if (index === 0) constellationNotifications.set(!on);

      if (index === 1) void Linking.openSettings();
    }
  );

export const SettingsScreen = ({
  tabBarHeight,
  onHosts,
}: {
  readonly tabBarHeight: number;
  readonly onHosts: () => void;
}) => {
  const insets = useSafeAreaInsets();
  const { colours } = useTheme();
  const { motion, setMotion } = useMotionPreference();
  const constellations = useConstellationNotifications();

  const followed = useFollowedHosts();
  const developerMode = developerModeLine(useDeveloperMode(followed));

  const hosts = hostsLine(
    followed.map(({ connection, status }) => ({
      name: status.host?.hostname ?? connection.name,
      state: status.state,
    }))
  );

  const panel = { backgroundColor: colours.panel, borderColor: colours.hairline };

  return (
    <ScrollView
      style={[styles.fill, { marginTop: insets.top }]}
      contentContainerStyle={{
        paddingTop: 6,
        paddingBottom: Math.max(HORIZON_INSET, tabBarHeight + 24),
      }}
    >
      <View style={styles.titleRow}>
        <Text
          style={[styles.large, { color: colours.textStrong }]}
          accessibilityRole="header"
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          Settings
        </Text>
        <InboxBadge />
      </View>
      <View style={styles.panels}>
        <View style={[styles.panel, styles.appearance, panel]}>
          <Text
            style={[styles.kicker, { color: colours.textSubtle }]}
            accessibilityRole="header"
            accessibilityLabel="Appearance"
            maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
          >
            APPEARANCE
          </Text>
          <View style={styles.cards} accessibilityRole="radiogroup">
            {THEME_CARDS.map((card) => (
              <ThemeCard key={card.name} {...card} />
            ))}
          </View>
        </View>
        <View style={[styles.panel, styles.links, panel]}>
          <Row
            Glyph={HostsGlyph}
            title="Hosts"
            line={hosts.names}
            more={hosts.more}
            note={hosts.note}
            onPress={onHosts}
          />
          <Row
            Glyph={NotificationsGlyph}
            title="Notifications"
            line={PolarisPush === null ? "Not available on this device" : notificationsLine(constellations)}
            {...(PolarisPush === null ? {} : { onPress: () => chooseNotifications(constellations) })}
          />
          <Row
            Glyph={MotionGlyph}
            title="Motion"
            line={motionLine(motion)}
            onPress={() => chooseMotion(setMotion)}
          />
          <Row Glyph={DeveloperModeGlyph} title="Developer mode" line={developerMode} last />
        </View>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  fill: { flex: 1 },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingRight: 16,
  },
  large: { ...mobileType.largeTitle, flexShrink: 1, paddingHorizontal: 16, paddingBottom: 14 },
  panels: { paddingHorizontal: 10, gap: 10 },
  panel: { borderRadius: 22, borderWidth: 1 },
  appearance: { gap: 12, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 16 },
  links: { paddingHorizontal: 12, paddingVertical: 2 },
  kicker: {
    fontFamily: mobileFont.mono,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "500",
    letterSpacing: 0.88,
  },
  cards: { flexDirection: "row", gap: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 4,
  },
  tile: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  rowTitle: { ...mobileType.heading },
  rowLine: { ...mobileType.footnote },
  lineRow: { flexDirection: "row" },
  names: { flexShrink: 1 },
  kept: { flexShrink: 0 },
});
