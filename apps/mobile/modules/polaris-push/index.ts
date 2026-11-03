/** The native half of push: the push key in the shared Keychain group and the APNs environment. */
import type { PushEnvironment } from "@polaris/protocol/relay";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface PolarisPushNative {
  /** The push key's public half (X9.63, base64url); made on first use. */
  pushKey(): Promise<string>;
  /** Replaces the push key; re-register with every Host afterwards. */
  rotatePushKey(): Promise<string>;
  apnsEnvironment(): PushEnvironment;
  /** Holds a background task while an answer from the lock screen is sent. */
  beginAnswer(id: string): Promise<void>;
  endAnswer(id: string): Promise<void>;
}

export const PolarisPush =
  Platform.OS === "ios" ? requireOptionalNativeModule<PolarisPushNative>("PolarisPush") : null;
