/**
 * Each Host's Deepgram key for Settings → Voice: whether it is set (`voice.settings`), and
 * setting or removing it (`voice.setKey`). The key is passed straight through, never stored.
 */
import { useCallback, useEffect, useState } from "react";
import type { IpcError } from "../../../../shared/api.ts";
import { polaris } from "../../bridge.ts";
import type { VoiceKeyState } from "../model/voice.ts";

const LOADING: VoiceKeyState = { kind: "loading" };

/** `asked`: the Hosts that can answer now; the others are never asked. */
export const useVoiceKeys = (asked: ReadonlyArray<string>) => {
  const [states, setStates] = useState<Readonly<Record<string, VoiceKeyState>>>({});
  const askedKey = asked.join("\n");

  const put = useCallback(
    (hostKey: string, state: VoiceKeyState) =>
      setStates((previous) => ({ ...previous, [hostKey]: state })),
    []
  );

  useEffect(() => {
    for (const hostKey of askedKey === "" ? [] : askedKey.split("\n")) {
      void polaris()
        .request("voice.settings", { hostKey })
        .then((result) =>
          put(
            hostKey,
            result.ok
              ? { kind: "ready", settings: result.value }
              : { kind: "failed", message: result.error.message }
          )
        );
    }
  }, [askedKey, put]);

  /** Stores `key` on the Host, or removes it (null); answers the Host's refusal, if any. */
  const setKey = useCallback(
    async (hostKey: string, key: string | null): Promise<IpcError | null> => {
      const result = await polaris().request("voice.setKey", {
        hostKey,
        provider: "deepgram",
        key,
      });

      if (!result.ok) return result.error;
      put(hostKey, { kind: "ready", settings: result.value });

      return null;
    },
    [put]
  );

  const stateOf = (hostKey: string): VoiceKeyState => states[hostKey] ?? LOADING;

  return { stateOf, setKey };
};
