/**
 * Keeps the lock-screen and home-screen widgets (W1, W2) on what Home knows: every change to
 * the followed Hosts rebuilds the snapshot, and the publisher writes it when it differs.
 */
import { requireOptionalNativeModule } from "expo";
import { useEffect, useMemo } from "react";
import { homeHostsOf, useFollowedHosts } from "../home/feed/useFollowedHosts.ts";
import { buildHome } from "../home/model/home.ts";
import { useTheme } from "../theme/index.ts";
import { APP_GROUP, SNAPSHOT_KEY, widgetPublisher } from "./publish.ts";
import { widgetSnapshot } from "./snapshot.ts";
import { THEME_KEY, themePublisher } from "./theme.ts";

/** `modules/polaris-widgets`: optional in builds made before it was added. */
interface PolarisWidgetsModule {
  readonly write: (suite: string, key: string, json: string) => void;
  readonly reload: () => void;
}

const native = requireOptionalNativeModule<PolarisWidgetsModule>("PolarisWidgets");

const publisher = widgetPublisher({
  write: (json) => native?.write(APP_GROUP, SNAPSHOT_KEY, json),
  reload: () => native?.reload(),
});

const publishTheme = themePublisher({
  write: (theme) => native?.write(APP_GROUP, THEME_KEY, theme),
  reload: () => native?.reload(),
});

/**
 * The push path's hook (R5): after a push wake has brought the feeds up to date, or the
 * Notification Service Extension has written the App Group itself, call this to redraw.
 */
export const refreshWidgets = (): void => publisher.refresh();

export const WidgetSync = (): null => {
  const hosts = useFollowedHosts();

  const snapshot = useMemo(() => {
    // Until a Host has been reached this launch, the last snapshot is truer than an empty one.
    if (native === null || !hosts.some(({ followed }) => followed.seen)) return null;

    return widgetSnapshot(
      buildHome(homeHostsOf(hosts), null),
      hosts.filter(({ status }) => status.state === "connected").length
    );
  }, [hosts]);

  useEffect(() => {
    if (snapshot !== null) publisher.publish(snapshot);
  }, [snapshot]);

  const { name } = useTheme();

  // On every launch too: the extensions read Midnight until the app has written its theme.
  useEffect(() => {
    if (native !== null) publishTheme(name);
  }, [name]);

  return null;
};
