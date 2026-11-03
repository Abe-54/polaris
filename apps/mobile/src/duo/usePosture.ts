/**
 * The posture as React state, from `modules/polaris-hinge`: its first answer, then each change,
 * each a JSON report parsed here. Without a separating fold or a supported module, it stays folded.
 * A development build launched with `-polarisDevPosture unfolded|halfFolded` fakes the hinge.
 */
import { Schema } from "effect";
import { type NativeModule, requireOptionalNativeModule } from "expo";
import { useEffect, useMemo, useState } from "react";
import { Platform, Settings, useWindowDimensions } from "react-native";
import { DevPosture, devReport, FOLDED, type Posture, postureOf, readReport } from "./posture.ts";

interface PostureEvent {
  readonly json: string;
}

declare class PolarisHingeModule extends NativeModule<{
  onPosture: (event: PostureEvent) => void;
}> {
  current(): Promise<string>;
}

const native = requireOptionalNativeModule<PolarisHingeModule>("PolarisHinge");

const launched = (): DevPosture | null => {
  if (!__DEV__ || Platform.OS !== "ios") return null;
  const value: unknown = Settings.get("polarisDevPosture");

  return Schema.is(DevPosture)(value) ? value : null;
};

const DEV_POSTURE = launched();

export const usePosture = (): Posture => {
  const [posture, setPosture] = useState<Posture>(FOLDED);
  const { width, height } = useWindowDimensions();

  const forced = useMemo(
    () => (DEV_POSTURE === null ? null : postureOf(devReport(DEV_POSTURE, { width, height }))),
    [width, height]
  );

  useEffect(() => {
    if (native === null || DEV_POSTURE !== null) return;
    let gone = false;

    const take = (json: string) => {
      if (__DEV__) console.log(`POLARIS_POSTURE ${json}`);

      if (!gone) setPosture(postureOf(readReport(json)));
    };

    const subscription = native.addListener("onPosture", (event) => take(event.json));

    void native.current().then(take, () => undefined);

    return () => {
      gone = true;
      subscription.remove();
    };
  }, []);

  return forced ?? posture;
};
