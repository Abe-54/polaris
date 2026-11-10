/**
 * Whether the helper app holds the macOS grants computer use needs, read from agent-desktop's
 * `status` run inside the helper, so the answer is the helper's own and not the Daemon's.
 */
import { Option, Schema } from "effect";

const Permission = Schema.Struct({ state: Schema.String });

const Status = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      permissions: Schema.Struct({ accessibility: Permission, screen_recording: Permission }),
    }),
  })
);

const decodeStatus = Schema.decodeUnknownOption(Status);

export type ComputerUseGrant = "accessibility" | "screen recording";

export interface ComputerUsePermissions {
  /** `needs setup`: the user has yet to allow the helper in System Settings. */
  readonly state: "ready" | "needs setup";
  /** The grants still missing, in the order the user is asked for them. */
  readonly missing: ReadonlyArray<ComputerUseGrant>;
}

const held = (state: string) => state === "granted" || state === "not_required";

/** Reads `agent-desktop status`' JSON; none when it isn't that. */
export const permissionsOf = (status: string): Option.Option<ComputerUsePermissions> =>
  Option.map(decodeStatus(status), ({ data: { permissions } }) => {
    const missing: Array<ComputerUseGrant> = [
      ...(held(permissions.accessibility.state) ? [] : ["accessibility" as const]),
      ...(held(permissions.screen_recording.state) ? [] : ["screen recording" as const]),
    ];

    return { state: missing.length === 0 ? "ready" : "needs setup", missing };
  });
