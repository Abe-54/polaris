/**
 * This iPhone's switch per Host (Paper MX-AE, ENG-561), on by default: off and that Host sends
 * it no pushes. Each Host learns its own from this device's push registration.
 */
import * as SecureStore from "expo-secure-store";
import { useCallback, useSyncExternalStore } from "react";
import { createHostSwitches } from "./hostSwitches.ts";

const KEY = "polaris.push.hosts-off";

export const hostNotifications = createHostSwitches({
  load: () => SecureStore.getItemAsync(KEY),
  save: (value) => SecureStore.setItemAsync(KEY, value),
});

/** One Host's switch, re-rendering when it changes. */
export const useHostNotifications = (hostId: string): boolean =>
  useSyncExternalStore(
    hostNotifications.subscribe,
    useCallback(() => hostNotifications.get(hostId), [hostId])
  );

/** Every Host's switch as one value that changes with any of them, for registering again. */
export const useHostNotificationsKey = (): string =>
  useSyncExternalStore(hostNotifications.subscribe, hostNotifications.key);
