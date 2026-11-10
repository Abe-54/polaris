/**
 * One Host's Pairings for Settings → Extensions: loads them, pairs (the token
 * comes back once, held only until "Done"), and revokes.
 */
import type { Grant, PairingId } from "@polaris/protocol";
import { useCallback, useEffect, useState } from "react";
import type { RequestOutput } from "../../../shared/api.ts";
import { polaris } from "../bridge.ts";
import { showRefusal } from "../session/dispatch.ts";

export type PairingsState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ready"; readonly pairings: RequestOutput<"extensions.list"> };

export type Paired = RequestOutput<"extensions.pair">;

export const useExtensions = (hostKey: string, enabled: boolean) => {
  const [state, setState] = useState<PairingsState>({ kind: "loading" });

  const load = useCallback(async () => {
    const result = await polaris().request("extensions.list", { hostKey });

    setState(
      result.ok
        ? { kind: "ready", pairings: result.value }
        : { kind: "failed", message: result.error.message }
    );
  }, [hostKey]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  /** The new Pairing and its pairing string, or null when the Host refused. */
  const pair = async (name: string, grant: Grant): Promise<Paired | null> => {
    const result = await polaris().request("extensions.pair", { hostKey, name, grant });

    if (!result.ok) {
      showRefusal("Couldn't pair the extension", result.error, hostKey);

      return null;
    }

    const { pairing } = result.value;
    setState((previous) => ({
      kind: "ready",
      pairings: [...(previous.kind === "ready" ? previous.pairings : []), pairing],
    }));

    return result.value;
  };

  const revoke = async (id: PairingId) => {
    const result = await polaris().request("extensions.revoke", { hostKey, id });

    if (!result.ok) {
      showRefusal("Couldn't revoke the pairing", result.error, hostKey);

      return false;
    }

    setState((previous) =>
      previous.kind === "ready"
        ? { kind: "ready", pairings: previous.pairings.filter((pairing) => pairing.id !== id) }
        : previous
    );

    return true;
  };

  return { state, pair, revoke };
};
