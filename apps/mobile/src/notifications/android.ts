import * as Notifications from "expo-notifications";
import { useEffect, useState } from "react";
import { AppState, Linking, Platform } from "react-native";
import { PolarisLiveActivity } from "../../modules/polaris-live-activity/index.ts";

export const openAndroidNotificationSettings = () =>
  Linking.sendIntent("android.settings.APP_NOTIFICATION_SETTINGS", [
    { key: "android.provider.extra.APP_PACKAGE", value: "dev.lux.polaris.mobile" },
  ]).catch(() => Linking.openSettings());

/** Android has local live updates; it does not register for remote push. */
export const useAndroidLiveUpdatePermission = (linked: boolean) => {
  const [allowed, setAllowed] = useState(Platform.OS !== "android");

  useEffect(() => {
    if (Platform.OS !== "android" || !linked || PolarisLiveActivity === null) return;
    const native = PolarisLiveActivity;
    let current = true;

    const refresh = () => {
      if (current) setAllowed(native.enabled());
    };

    // enabled() creates the native live-update channel before Android's permission prompt.
    refresh();

    if (Number(Platform.Version) >= 33)
      void Notifications.requestPermissionsAsync().then(refresh, refresh);

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });

    return () => {
      current = false;
      subscription.remove();
    };
  }, [linked]);

  return Platform.OS !== "android" || (linked && allowed);
};
