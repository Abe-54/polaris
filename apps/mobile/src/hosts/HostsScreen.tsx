/**
 * Hosts under Settings (Paper MX-AD): instrument rows grouped "Needs a look" and "Connected",
 * each opening the host details sheet (MX-AE). Routes are chosen on the Mac.
 */
import { mobileFont, mobileType } from "@polaris/ui/tokens";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BackBar } from "../app/BackBar.tsx";
import { type FollowedHostState, useFollowedHosts } from "../home/feed/useFollowedHosts.ts";
import { EdgeFade, HORIZON_CLEAR, HorizonScreen } from "../horizon";
import { LINK_ANOTHER_COPY, ScanSheet } from "../link/ScanSheet.tsx";
import { hostMenu, LongPressMenu, useMenuActions } from "../menus/index.ts";
import { useRelay } from "../relay/RelayProvider.tsx";
import { Chevron } from "../settings/icons.tsx";
import { themedStyles, useTheme } from "../theme/index.ts";
import { CHROME_TEXT_SCALE, CONTENT_TEXT_SCALE } from "../theme/textScale.ts";
import { DevSegments } from "../home/ui/DevDataToggle.tsx";
import {
  chooseDevHosts,
  DEV_HOST_LINK,
  DEV_HOST_SHEET,
  type DevHostsData,
  useDevHosts,
  useDevHostsData,
} from "./dev.ts";
import { HostSheet } from "./HostSheet.tsx";
import { useLinkAnother } from "./linkAnother.ts";
import {
  buildHosts,
  hostDetails,
  type HostInput,
  type HostRowModel,
  type HostSection,
  unlinkNote,
} from "./model.ts";
import { StateDot, stateLineColour } from "./StateDot.tsx";

/** Re-renders each second while a Host reconnects, so "42s" counts. */
const useTicking = (active: boolean) => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), active ? 1000 : 60_000);

    return () => clearInterval(timer);
  }, [active]);

  return now;
};

const toInput = ({ connection, status, followed }: FollowedHostState): HostInput => ({
  hostId: connection.hostId,
  name: status.host?.hostname ?? connection.name,
  route: connection.route,
  state: status.state,
  failure: status.failure?.detail ?? null,
  latencyMs: status.latencyMs,
  lastSeenAt: status.lastSeenAt,
  sessions: followed.seen
    ? [...followed.state.sessions.values()].filter(({ session }) => session.state !== "archived")
        .length
    : null,
});

const HostRow = ({
  row,
  last,
  onOpen,
}: {
  readonly row: HostRowModel;
  readonly last: boolean;
  readonly onOpen: () => void;
}) => {
  const styles = useStyles();
  const { colours } = useTheme();
  const offline = row.state === "offline";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.name}, ${row.line}, round trip ${row.roundTrip}, ${row.route}`}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.row,
        last ? null : styles.divided,
        pressed ? styles.pressed : null,
      ]}
    >
      <StateDot state={row.state} />
      <View style={styles.text}>
        <Text
          style={[styles.name, offline ? styles.offlineName : null]}
          numberOfLines={1}
          ellipsizeMode="middle"
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          {row.name}
        </Text>
        <Text
          style={[styles.line, { color: stateLineColour(row.state, colours) }]}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          {row.line}
        </Text>
      </View>
      <View style={styles.meter}>
        <Text
          style={[styles.roundTrip, row.state === "connected" ? null : styles.faint]}
          maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
        >
          {row.roundTrip}
        </Text>
        <Text style={styles.route} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
          {row.route}
        </Text>
      </View>
      <Chevron color={colours.textFaint} />
    </Pressable>
  );
};

const Section = ({
  section,
  first,
  onOpen,
}: {
  readonly section: HostSection;
  readonly first: boolean;
  readonly onOpen: (hostId: string) => void;
}) => {
  const styles = useStyles();
  const onMenu = useMenuActions();

  return (
    <>
      <Text
        style={[styles.kicker, first ? null : styles.laterKicker]}
        accessibilityRole="header"
        accessibilityLabel={`${section.title}, ${section.rows.length}`}
        maxFontSizeMultiplier={CHROME_TEXT_SCALE}
      >
        {`${section.title} · ${section.rows.length}`.toUpperCase()}
      </Text>
      <View style={styles.panel}>
        {section.rows.map((row, index) => (
          <LongPressMenu
            key={row.key}
            menu={hostMenu({ hostId: row.key, name: row.name, state: row.state })}
            onAction={onMenu}
          >
            <HostRow
              row={row}
              last={index === section.rows.length - 1}
              onOpen={() => onOpen(row.key)}
            />
          </LongPressMenu>
        ))}
      </View>
    </>
  );
};

/** MX-AT: the list's last panel, with where to find the code under it. */
const LinkAnotherRow = ({ onLink }: { readonly onLink: () => void }) => {
  const styles = useStyles();
  const { colours } = useTheme();

  return (
    <View style={styles.linkAnother}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${LINK_ANOTHER_COPY.title}, ${LINK_ANOTHER_CAPTION}`}
        onPress={onLink}
        style={({ pressed }) => [styles.panel, styles.row, pressed ? styles.pressed : null]}
      >
        <View style={styles.plus}>
          <Svg width={12} height={12} viewBox="0 0 14 14">
            <Path
              d="M7 1v12M1 7h12"
              stroke={colours.textStrong}
              strokeWidth={1.8}
              strokeLinecap="round"
            />
          </Svg>
        </View>
        <View style={styles.text}>
          <Text style={styles.name} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
            {LINK_ANOTHER_COPY.title}
          </Text>
          <Text style={styles.caption} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
            {LINK_ANOTHER_CAPTION}
          </Text>
        </View>
        <Chevron color={colours.textFaint} />
      </Pressable>
      <Text style={styles.footnote} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
        {LINK_ANOTHER_FOOTNOTE}
      </Text>
    </View>
  );
};

const LINK_ANOTHER_CAPTION = "Its hosts join this list";

const LINK_ANOTHER_FOOTNOTE = "On that Mac, open Polaris → Settings → Devices for the code.";

/** The list ends above the moon (DESIGN.md: no row sits on the horizon); this lifts its last row past the fade. */
const LIST_FOOT = 40;

/** Room under the last row for the development toggle that stands at the list's foot. */
const DEV_TOGGLE_ROOM = 40;

const DEV_CHOICES: ReadonlyArray<readonly [DevHostsData, string]> = [
  ["paper", "Paper"],
  ["worst", "Worst case"],
  ["offline", "All offline"],
  ["one", "One"],
  ["huge", "64"],
  ["empty", "None"],
];

const DevHostsToggle = ({ bottom }: { readonly bottom: number }) => {
  const data = useDevHostsData();

  return data === null ? null : (
    <DevSegments choices={DEV_CHOICES} value={data} onChoose={chooseDevHosts} bottom={bottom} />
  );
};

export const HostsScreen = ({ onBack }: { readonly onBack: () => void }) => {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const relay = useRelay();
  const followed = useFollowedHosts();
  const dev = useDevHosts();
  const hosts = dev ?? followed.map(toInput);
  const [openId, setOpenId] = useState<string | null>(DEV_HOST_SHEET);
  const [unlinkLeft, setUnlinkLeft] = useState<string | null>(null);
  const linkAnother = useLinkAnother(DEV_HOST_LINK);
  const now = useTicking(hosts.some(({ state }) => state === "reconnecting"));
  const model = buildHosts(hosts, now);
  const open = hosts.find((host) => host.hostId === openId) ?? null;

  const relayLinked = (host: HostInput) =>
    dev === null ? relay.routeOf(host.hostId) === "relay" : host.route === "relay";

  const unlink = (hostId: string) => () => {
    setOpenId(null);

    if (dev !== null) return;
    void relay
      .unlinkHost(hostId)
      .then((kept) => setUnlinkLeft(unlinkNote(kept.map((host) => host.hostName))));
  };

  return (
    <HorizonScreen>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <BackBar label="Settings" onBack={onBack} />
        <View style={styles.list}>
          <ScrollView
            contentContainerStyle={[
              styles.content,
              { paddingBottom: dev === null ? LIST_FOOT : LIST_FOOT + DEV_TOGGLE_ROOM },
            ]}
          >
            <View style={styles.head}>
              <Text
                style={styles.title}
                accessibilityRole="header"
                maxFontSizeMultiplier={CONTENT_TEXT_SCALE}
              >
                Hosts
              </Text>
              <Text style={styles.summary} maxFontSizeMultiplier={CONTENT_TEXT_SCALE}>
                {model.summary}
              </Text>
            </View>
            <View style={styles.sections}>
              {model.sections.map((section, index) => (
                <Section
                  key={section.title}
                  section={section}
                  first={index === 0}
                  onOpen={setOpenId}
                />
              ))}
              <LinkAnotherRow onLink={linkAnother.open} />
              {unlinkLeft === null ? null : <Text style={styles.note}>{unlinkLeft}</Text>}
            </View>
          </ScrollView>
          <EdgeFade />
        </View>
      </View>
      <HostSheet
        details={open === null ? null : hostDetails(open, now)}
        onClose={() => setOpenId(null)}
        onUnlink={open !== null && relayLinked(open) ? unlink(open.hostId) : null}
      />
      <ScanSheet
        key={linkAnother.sheet.round}
        open={linkAnother.sheet.open}
        {...LINK_ANOTHER_COPY}
        onClose={linkAnother.close}
        onLink={relay.link}
        onLinked={linkAnother.close}
      />
      <DevHostsToggle bottom={HORIZON_CLEAR + 4} />
    </HorizonScreen>
  );
};

const useStyles = themedStyles((colours) => ({
  screen: { flex: 1 },
  list: { flex: 1, marginBottom: HORIZON_CLEAR },
  content: { paddingTop: 4 },
  head: { paddingHorizontal: 16, paddingBottom: 12, gap: 6 },
  title: { ...mobileType.largeTitle, fontWeight: "600", lineHeight: 41, color: colours.textStrong },
  summary: { ...mobileType.footnote, color: colours.textSubtle, fontVariant: ["tabular-nums"] },
  sections: { paddingHorizontal: 10, gap: 10 },
  kicker: {
    fontFamily: mobileFont.mono,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "500",
    letterSpacing: 0.88,
    color: colours.textSubtle,
    paddingHorizontal: 8,
    paddingTop: 6,
  },
  laterKicker: { paddingTop: 10 },
  panel: {
    backgroundColor: colours.panel,
    borderColor: colours.hairline,
    borderWidth: 1,
    borderRadius: 20,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  divided: { borderBottomWidth: 1, borderBottomColor: colours.hairline },
  pressed: { backgroundColor: colours.raised },
  text: { flex: 1, minWidth: 0 },
  name: { ...mobileType.heading, color: colours.textStrong },
  offlineName: { color: colours.textSubtle },
  line: { ...mobileType.footnote },
  meter: { alignItems: "flex-end", flexShrink: 0 },
  roundTrip: {
    fontFamily: mobileFont.mono,
    fontSize: 13,
    lineHeight: 18,
    color: colours.textDefault,
    fontVariant: ["tabular-nums"],
  },
  faint: { color: colours.textFaint },
  route: { ...mobileType.tab, fontWeight: "400", lineHeight: 15, color: colours.textFaint },
  linkAnother: { gap: 8, paddingTop: 6 },
  plus: {
    width: 28,
    height: 28,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colours.hairline,
    backgroundColor: colours.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  caption: { ...mobileType.footnote, color: colours.textSubtle },
  footnote: {
    ...mobileType.footnote,
    fontSize: 12,
    lineHeight: 16,
    color: colours.textFaint,
    paddingHorizontal: 14,
  },
  note: { ...mobileType.footnote, color: colours.textFaint, paddingHorizontal: 14 },
}));
