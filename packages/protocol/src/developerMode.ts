/**
 * Developer Mode (ENG-711, ADR 0095): the Host's stored setting, the leases development builds
 * hold on it, and the Workspace that holds Polaris's own code. Capability `developer-mode`,
 * advertised only once a Daemon implements it.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Unsupported } from "./errors.ts";
import { WorkspaceId } from "./ids.ts";

export const DEVELOPER_MODE_CAPABILITY = "developer-mode";

/** `remote`: matched by the Workspace's git remote. `override`: chosen with `setWorkspace`. */
export const PolarisWorkspaceSource = Schema.Literals(["remote", "override"]);

export type PolarisWorkspaceSource = typeof PolarisWorkspaceSource.Type;

const DeveloperModeFields = Schema.Struct({
  /** The Host's stored setting, as the release Desktop App and the Mobile App show it. */
  stored: Schema.Boolean,
  /** Live `developerMode.lease` streams on this Host, from development builds. */
  leases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The Daemon runs from source rather than a packaged build, so it always traces. */
  fromSource: Schema.Boolean,
  /** Whether this Host traces now: `stored`, any lease held, or `fromSource`. */
  effective: Schema.Boolean,
  polarisWorkspaceId: Schema.NullOr(WorkspaceId),
  /** Null exactly when `polarisWorkspaceId` is. */
  polarisWorkspaceSource: Schema.NullOr(PolarisWorkspaceSource),
}).check(
  Schema.makeFilter(
    (mode) =>
      mode.effective === (mode.stored || mode.leases > 0 || mode.fromSource) &&
      (mode.polarisWorkspaceId === null) === (mode.polarisWorkspaceSource === null)
  )
);

export class DeveloperMode extends Schema.Class<DeveloperMode>("DeveloperMode")(
  DeveloperModeFields
) {}

export const DEFAULT_DEVELOPER_MODE = DeveloperMode.make({
  stored: false,
  leases: 0,
  fromSource: false,
  effective: false,
  polarisWorkspaceId: null,
  polarisWorkspaceSource: null,
});

export class DeveloperModeError extends Schema.TaggedError<DeveloperModeError>()(
  "DeveloperModeError",
  {
    /** `unknown-workspace`: `setWorkspace` named a Workspace this Host doesn't have. */
    reason: Schema.Literals(["storage", "unknown-workspace"]),
    message: Schema.String,
  }
) {}

const Errors = Schema.Union([Unsupported, DeveloperModeError]);

export const GetDeveloperMode = Rpc.make("developerMode.get", {
  payload: {},
  success: DeveloperMode,
  error: Unsupported,
});

/** Writes the stored setting; leases are unaffected. Not for a Linked Device. */
export const SetDeveloperMode = Rpc.make("developerMode.set", {
  payload: { enabled: Schema.Boolean },
  success: DeveloperMode,
  error: Errors,
});

/** Overrides the Polaris Workspace, or with null returns to matching by remote. */
export const SetDeveloperModeWorkspace = Rpc.make("developerMode.setWorkspace", {
  payload: { workspaceId: Schema.NullOr(WorkspaceId) },
  success: DeveloperMode,
  error: Errors,
});

/**
 * Holds a lease for as long as the stream runs: the first item counts it, later items follow
 * changes. Ending the stream or closing the connection releases it.
 */
export const LeaseDeveloperMode = Rpc.make("developerMode.lease", {
  payload: {},
  success: DeveloperMode,
  error: Unsupported,
  stream: true,
});

/** The current value at once, then each change. */
export const WatchDeveloperMode = Rpc.make("developerMode.watch", {
  payload: {},
  success: DeveloperMode,
  error: Unsupported,
  stream: true,
});

export class DeveloperModeRpcs extends RpcGroup.make(
  GetDeveloperMode,
  SetDeveloperMode,
  SetDeveloperModeWorkspace,
  LeaseDeveloperMode,
  WatchDeveloperMode
) {}
