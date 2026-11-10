/**
 * Push in the app: the notification categories, a registration with every linked Host as it
 * comes live, and answers from approval notifications (apps/mobile/README.md: Push).
 */
import type { RelayAddress } from "@polaris/protocol/relay";
import type { RelayIdentity } from "@polaris/protocol/relay/party";
import * as Notifications from "expo-notifications";
import { useEffect, useRef, useState } from "react";
import { PolarisPush } from "../../modules/polaris-push/index.ts";
import { useHosts } from "../runtime/hosts.tsx";
import { refreshWidgets } from "../widgets/WidgetSync.ts";
import type { Route } from "../app/route.ts";
import { answerOf, PUSH_CATEGORIES, routeOf } from "./answer.ts";
import { answerHost, deliverAnswer, unsentNotice } from "./deliver.ts";
import { useConstellationNotifications } from "./constellations.ts";
import { hostNotifications, useHostNotificationsKey } from "./hostNotifications.ts";
import { type PushDevice, registerPush } from "./registration.ts";

/** A Host linked over the relay: where its registration's ticket points. */
export interface PushLinkedHost {
  readonly hostId: string;
  readonly hostAddress: RelayAddress;
}

const setCategories = () =>
  Promise.all(
    PUSH_CATEGORIES.map((category) =>
      Notifications.setNotificationCategoryAsync(category.identifier, [...category.actions])
    )
  );

/** The device's push identity, or null when notifications aren't allowed. */
const pushDevice = async (identity: RelayIdentity): Promise<PushDevice | null> => {
  const permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });

  if (!permission.granted) return null;
  const token = await Notifications.getDevicePushTokenAsync();

  return {
    token: String(token.data).toLowerCase(),
    environment: PolarisPush.apnsEnvironment(),
    pushKey: await PolarisPush.pushKey(),
    identity,
  };
};

const userInfoOf = (response: Notifications.NotificationResponse): ReadonlyArray<unknown> => {
  const { content, trigger } = response.notification.request;

  return [content.data, trigger !== null && "payload" in trigger ? trigger.payload : null];
};

/** Resolves once `loaded` is true: the linked Hosts are read from the Keychain and added. */
const useLoaded = (loaded: boolean) => {
  // Not Promise.withResolvers: Hermes may lack it.
  const [signal] = useState(() => {
    let resolve = () => {};

    const promise = new Promise<void>((done) => (resolve = done));

    return { promise, resolve: () => resolve() };
  });

  useEffect(() => {
    if (loaded) signal.resolve();
  }, [loaded, signal]);

  return signal.promise;
};

const useAnswers = (loaded: boolean) => {
  const hosts = useHosts();
  const current = useRef(hosts);
  current.current = hosts;
  const ready = useLoaded(loaded);

  useEffect(() => {
    const answer = async (response: Notifications.NotificationResponse) => {
      const found = answerOf({
        actionIdentifier: response.actionIdentifier,
        category: response.notification.request.content.categoryIdentifier,
        userInfo: userInfoOf(response),
      });

      if (found === null) return;
      const id = String(found.dispatch.commandId);
      await PolarisPush.beginAnswer(id);

      try {
        const hosts = () => current.current.map(answerHost);
        const outcome = await deliverAnswer(ready, hosts, found);

        // An answered approval leaves the widgets' needs you count once the feeds catch up.
        if (outcome === "sent") refreshWidgets();

        const host = current.current.find((h) => h.hostId === found.hostId);
        const notice = unsentNotice(outcome, host?.name ?? null);

        if (notice !== null)
          await Notifications.scheduleNotificationAsync({ content: notice, trigger: null });
      } finally {
        await PolarisPush.endAnswer(id);
        Notifications.clearLastNotificationResponse();
      }
    };

    // An action can launch the app before this listener exists; that one is the last response.
    void Notifications.getLastNotificationResponseAsync().then((last) =>
      last === null ? undefined : answer(last)
    );

    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => void answer(response)
    );

    return () => subscription.remove();
  }, [ready]);
};

const useRegistrations = (
  identity: RelayIdentity | null,
  linked: ReadonlyArray<PushLinkedHost>
) => {
  const hosts = useHosts();
  const [device, setDevice] = useState<PushDevice | null>(null);
  const automatic = useConstellationNotifications();
  const switchedOff = useHostNotificationsKey();
  // Per Host, the connection epoch and switches it was registered with: a change registers again.
  const registered = useRef(new Map<string, string>());

  const hadIdentity = useRef(false);

  useEffect(() => {
    if (identity === null) {
      // Unlinked: a new push key, so a Host that still holds the old one can't be read here.
      if (hadIdentity.current) void PolarisPush.rotatePushKey();
      hadIdentity.current = false;
      registered.current.clear();
      setDevice(null);

      return;
    }

    hadIdentity.current = true;
    void setCategories()
      .then(() => pushDevice(identity))
      .then(setDevice);
  }, [identity]);

  useEffect(() => {
    if (device === null) return;

    const sync = () => {
      for (const { hostId, hostAddress } of linked) {
        const host = hosts.find((h) => h.hostId === hostId);
        const live = host?.live() ?? null;

        if (host === undefined || live === null) continue;
        const notifications = hostNotifications.get(hostId);
        const key = `${live.epoch}:${automatic}:${notifications}`;

        if (registered.current.get(hostId) === key) continue;
        registered.current.set(hostId, key);
        void registerPush(host, device, hostAddress, { automatic, notifications }).catch(() =>
          registered.current.delete(hostId)
        );
      }
    };

    sync();
    const unsubscribes = hosts.map((host) => host.subscribe(sync));

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [device, hosts, linked, automatic, switchedOff]);
};

/**
 * Mount once, under HostsProvider, with the device's relay identity, its linked Hosts and
 * whether they were loaded from the Keychain yet.
 */
export const usePush = (
  identity: RelayIdentity | null,
  linked: ReadonlyArray<PushLinkedHost>,
  loaded: boolean
) => {
  useAnswers(loaded);
  useRegistrations(identity, linked);
};

/** Mount under NavigationProvider: tapping a notification opens its session or Constellation. */
export const usePushLinks = (open: (route: Route) => void) => {
  useEffect(() => {
    const follow = (response: Notifications.NotificationResponse | null) => {
      if (response === null) return;

      const route = routeOf({
        actionIdentifier: response.actionIdentifier,
        category: response.notification.request.content.categoryIdentifier,
        userInfo: userInfoOf(response),
      });

      if (route === null) return;
      open(route);
      // Followed once: a later launch doesn't reopen it.
      Notifications.clearLastNotificationResponse();
    };

    // A tap that launched the app is the last response.
    void Notifications.getLastNotificationResponseAsync().then(follow);
    const subscription = Notifications.addNotificationResponseReceivedListener(follow);

    return () => subscription.remove();
  }, [open]);
};
