/**
 * The Mobile App's shell: the Hosts (one HostConnection each), the navigation stack, the tabs
 * (Sessions, Review, Settings) with New, and the screen on top, in the chosen theme.
 */
import { Match } from "effect";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StyleSheet, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { NavigationProvider, type Route, useNavigation } from "./app/navigation.tsx";
import {
  ConstellationRoute,
  NewSessionRoute,
  ReviewRoute,
  ReviewTab,
  ThreadRoute,
} from "./app/routes.tsx";
import { SwipeBack } from "./app/SwipeBack.tsx";
import { TabBar } from "./app/TabBar.tsx";
import { DuoShell } from "./duo/DuoShell.tsx";
import { FollowedHostsProvider } from "./home/feed/useFollowedHosts.ts";
import { useHomeHosts } from "./home/feed/useHomeHosts.ts";
import { HomeScreen } from "./home/HomeScreen.tsx";
import { ComposerGallery, composerGalleryOn } from "./composer/Gallery.tsx";
import {
  ConstellationGallery,
  constellationGalleryOn,
} from "./constellation/ConstellationScreen/Gallery.tsx";
import { galleryOn, RowGallery } from "./home/ui/Gallery.tsx";
import { HorizonScreen } from "./horizon";
import { InboxProvider } from "./inbox/index.ts";
import { HostsScreen } from "./hosts/HostsScreen.tsx";
import { NewSessionGallery, newSessionGalleryOn } from "./newSession/Gallery.tsx";
import { LinkGallery, linkGalleryOn } from "./link/Gallery.tsx";
import { LinkScreen } from "./link/LinkScreen.tsx";
import { useLiveActivity } from "./live/useLiveActivity.ts";
import { usePush, usePushLinks } from "./push/usePush.ts";
import { RelayProvider, useRelay } from "./relay/RelayProvider.tsx";
import { runSelfCheck } from "./runtime/selfCheck.ts";
import { AcceptDemo } from "./review/accept/index.ts";
import { ReviewGallery, reviewGalleryOn } from "./review/gallery/Gallery.tsx";
import { SheetDemo, SheetHost } from "./sheet/index.tsx";
import { CheckAlive } from "./runtime/CheckAlive.tsx";
import { HostsProvider } from "./runtime/hosts.tsx";
import { useReadyToReview } from "./review/index.ts";
import { SettingsScreen } from "./settings/index.ts";
import { ContextGallery, contextGalleryOn } from "./duo/ContextGallery.tsx";
import { StarChartGallery, starChartGalleryOn } from "./starChart/Gallery.tsx";
import { StatesGallery, statesGalleryOn } from "./states/index.ts";
import { ThreadGallery, threadGalleryOn } from "./thread/ThreadGallery.tsx";
import { useWidgetLinks } from "./widgets/useWidgetLinks.ts";
import { WidgetSync } from "./widgets/WidgetSync.ts";
import { ThemeProvider, themedStyles } from "./theme/index.ts";

const TAB_BAR = 58;

/** MX-C: the pill's foot sits 30pt up on a 34pt home-indicator inset, a little into it. */
const INTO_INSET = 4;

const Tabs = () => {
  const styles = useStyles();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const bottom = Math.max(insets.bottom - INTO_INSET, 20);
  const readyCount = useReadyToReview().rows.length;
  const noHosts = useHomeHosts().length === 0;
  const tabBarHeight = TAB_BAR + bottom;
  const openHosts = () => navigation.push({ screen: "hosts" });

  return (
    <View style={styles.fill}>
      {Match.value(navigation.tab).pipe(
        Match.when("sessions", () => (
          <HomeScreen
            tabBarHeight={tabBarHeight}
            actions={{
              openSession: (hostId, sessionId) =>
                navigation.push({ screen: "thread", hostId, sessionId }),
              openConstellation: (hostId, constellationId) =>
                navigation.push({ screen: "constellation", hostId, constellationId }),
              openHosts,
              link: () => navigation.push({ screen: "link" }),
            }}
          />
        )),
        Match.when("review", () => (
          <ReviewTab
            tabBarHeight={tabBarHeight}
            onOpen={(hostId, sessionId) =>
              navigation.push({ screen: "review", hostId, sessionId, turnId: null })
            }
            onLink={() => navigation.push({ screen: "link" })}
            onHosts={openHosts}
          />
        )),
        Match.when("settings", () => (
          <HorizonScreen>
            <SettingsScreen tabBarHeight={tabBarHeight} onHosts={openHosts} />
          </HorizonScreen>
        )),
        Match.exhaustive
      )}
      <TabBar
        active={navigation.tab}
        reviewCount={readyCount}
        bottom={bottom}
        onSelect={navigation.selectTab}
        onNew={() => navigation.openNewSession()}
        newDimmed={noHosts}
      />
    </View>
  );
};

const Screen = () => {
  const navigation = useNavigation();
  const relay = useRelay();
  const [first] = relay.hosts;
  const mustLink = !__DEV__ && relay.loaded && first === undefined;
  const [pairing, setPairing] = useState(false);

  useEffect(() => {
    if (mustLink) setPairing(true);
  }, [mustLink]);

  // A release build has no other route to a Host, so a fresh phone links first; the screen stays
  // through "Linked this iPhone" and moves on by itself.
  if (mustLink || pairing) return <LinkScreen onLinked={() => setPairing(false)} />;

  const render = (route: Route) =>
    Match.value(route).pipe(
      Match.discriminatorsExhaustive("screen")({
        tabs: () => <Tabs />,
        hosts: () => <HostsScreen onBack={navigation.back} />,
        thread: ({ hostId, sessionId, rise }) => (
          <ThreadRoute hostId={hostId} sessionId={sessionId} rise={rise} onBack={navigation.back} />
        ),
        newSession: ({ workspaceId }) => (
          <NewSessionRoute workspaceId={workspaceId} onBack={navigation.back} />
        ),
        constellation: ({ hostId, constellationId }) => (
          <ConstellationRoute
            hostId={hostId}
            constellationId={constellationId}
            onBack={navigation.back}
          />
        ),
        review: ({ hostId, sessionId, turnId }) => (
          <ReviewRoute
            hostId={hostId}
            sessionId={sessionId}
            turnId={turnId}
            onBack={navigation.back}
          />
        ),
        link: () => <LinkScreen onLinked={navigation.back} onCancel={navigation.back} />,
      })
    );

  return <SwipeBack layers={navigation.layers} render={render} onBack={navigation.back} />;
};

/** Registers for push and the Live Activity with each linked Host, and answers from both. */
const Push = () => {
  const relay = useRelay();
  usePush(relay.keys?.identity ?? null, relay.hosts, relay.loaded);
  useLiveActivity(relay.keys?.identity ?? null, relay.hosts, relay.loaded);

  return null;
};

const Shell = () => {
  const styles = useStyles();
  const navigation = useNavigation();

  useWidgetLinks(navigation.open);
  usePushLinks(navigation.open);

  if (galleryOn()) return <RowGallery />;

  if (starChartGalleryOn()) return <StarChartGallery />;

  if (contextGalleryOn()) return <ContextGallery />;

  if (threadGalleryOn())
    return (
      <SheetHost>
        <InboxProvider>
          <ThreadGallery />
        </InboxProvider>
      </SheetHost>
    );

  if (constellationGalleryOn())
    return (
      <SheetHost>
        <InboxProvider>
          <ConstellationGallery />
        </InboxProvider>
      </SheetHost>
    );

  if (reviewGalleryOn())
    return (
      <SheetHost>
        <InboxProvider>
          <ReviewGallery />
        </InboxProvider>
      </SheetHost>
    );

  if (newSessionGalleryOn())
    return (
      <SheetHost>
        <InboxProvider>
          <NewSessionGallery />
        </InboxProvider>
      </SheetHost>
    );

  if (linkGalleryOn())
    return (
      <SheetHost>
        <LinkGallery />
      </SheetHost>
    );

  if (statesGalleryOn())
    return (
      <SheetHost>
        <StatesGallery />
      </SheetHost>
    );

  if (composerGalleryOn())
    return (
      <SheetHost>
        <ComposerGallery />
      </SheetHost>
    );

  return (
    <SheetHost>
      <InboxProvider>
        <View style={styles.fill}>
          <DuoShell>
            <Screen />
          </DuoShell>
          {__DEV__ ? <SheetDemo /> : null}
          {__DEV__ ? <AcceptDemo /> : null}
        </View>
      </InboxProvider>
    </SheetHost>
  );
};

export const App = () => {
  useEffect(() => {
    if (!__DEV__) return;
    void runSelfCheck().then((results) => {
      const failed = results.filter((result) => !result.ok);

      console.log(
        failed.length === 0
          ? `Runtime check: ${results.length} of ${results.length} pass on this engine`
          : `Runtime check failed: ${failed.map((result) => `${result.name} (${result.detail})`).join(", ")}`
      );
    });
  }, []);

  return (
    <ThemeProvider>
      <GestureHandlerRootView style={rootStyles.root}>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <HostsProvider>
            <RelayProvider>
              <FollowedHostsProvider>
                <WidgetSync />
                <CheckAlive />
                <Push />
                <NavigationProvider>
                  <Shell />
                </NavigationProvider>
              </FollowedHostsProvider>
            </RelayProvider>
          </HostsProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ThemeProvider>
  );
};

const useStyles = themedStyles((colours) => ({
  fill: { flex: 1, backgroundColor: colours.ground },
}));

const rootStyles = StyleSheet.create({ root: { flex: 1 } });
