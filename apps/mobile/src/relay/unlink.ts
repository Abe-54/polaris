/**
 * Unlink on the phone (RX1-3): each Host revokes this iPhone's key over its own session
 * before the Keychain forgets it. A Host that doesn't answer keeps trusting the key, and
 * the user may forget it on this iPhone anyway (`leaving`); it trusts the key until unlinked on the Mac.
 */
import { Effect } from "effect";
import { unregisterLiveActivity } from "../live/registration.ts";
import { UNREGISTER_WAIT_MS, unregisterPush } from "../push/registration.ts";
import type { HostConnection } from "../runtime/hostConnection.ts";

/** How long Unlink waits for each Host to revoke this iPhone. */
export const REVOKE_WAIT_MS = 5_000;

export type RevokingHost = Pick<HostConnection, "hostId" | "run">;

/** The ids of the Hosts that revoked this device; the rest still accept its key. */
export const revokeOnHosts = async (
  hosts: ReadonlyArray<RevokingHost>,
  waitMs = REVOKE_WAIT_MS
): Promise<ReadonlySet<string>> => {
  const answers = await Promise.all(
    hosts.map((host) =>
      Promise.race([
        host
          .run((client) => Effect.asVoid(client["devices.unlinkSelf"]()))
          .then(
            () => host.hostId,
            () => null
          ),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs)),
      ])
    )
  );

  return new Set(answers.flatMap((id) => (id === null ? [] : [id])));
};

export interface Unlinked<H> {
  /** The ids of the targeted Hosts that revoked this iPhone. */
  readonly revoked: ReadonlySet<string>;
  /** Every Host still linked: the ones left alone, and targets that didn't answer. */
  readonly kept: ReadonlyArray<H>;
  /** Targets that didn't answer: they still trust this iPhone's key. */
  readonly stillTrusting: ReadonlyArray<H>;
}

export interface Left<H> {
  /** The Hosts this iPhone still follows. */
  readonly kept: ReadonlyArray<H>;
  /** True when none are left: the keys go too, so the next link starts as a new device. */
  readonly forgetKeys: boolean;
}

/**
 * What this iPhone keeps once the `gone` Hosts leave it, revoked or forgotten without an answer.
 * A forgotten Host can be linked again; one still kept is refused a new key (`checkLinkedHosts`).
 */
export const leaving = <H extends { readonly hostId: string }>(
  hosts: ReadonlyArray<H>,
  gone: ReadonlySet<string>
): Left<H> => {
  const kept = hosts.filter((host) => !gone.has(host.hostId));

  return { kept, forgetKeys: kept.length === 0 };
};

/** Unlinks this iPhone from the `targets` among the linked `hosts`; the others stay linked. */
export const unlinkFrom = async <H extends { readonly hostId: string }>(
  hosts: ReadonlyArray<H>,
  connections: ReadonlyArray<RevokingHost>,
  targets: ReadonlySet<string>,
  waitMs = { revoke: REVOKE_WAIT_MS, unregister: UNREGISTER_WAIT_MS }
): Promise<Unlinked<H>> => {
  const open = connections.filter(
    (connection) =>
      targets.has(connection.hostId) && hosts.some((host) => host.hostId === connection.hostId)
  );

  // Each Host drops the push and Live Activity registrations, then revokes the key.
  await Promise.all([
    unregisterPush(open, waitMs.unregister),
    unregisterLiveActivity(open, waitMs.unregister),
  ]);
  const revoked = await revokeOnHosts(open, waitMs.revoke);

  return {
    revoked,
    kept: leaving(hosts, revoked).kept,
    stillTrusting: hosts.filter((host) => targets.has(host.hostId) && !revoked.has(host.hostId)),
  };
};
