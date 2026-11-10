import { type Capability, FileError, type HostInfo, Unsupported } from "@polaris/protocol";
import { Effect, Stream } from "effect";

export type DefaultOptions = {
  readonly hostInfo: HostInfo;
  readonly capabilities: ReadonlyArray<Capability>;
  /** Where this Host's enrolled user keys live (`userAccess.ts`). */
  readonly userAccessFile?: string;
};

export const notYet = (what: string) => `${what} is not available on this Daemon yet`;

export const fileError = (path: string, what: string) =>
  new FileError({ path, code: "ENOTSUP", message: notYet(what) });

/** A request that fails as `Unsupported` for `capability`. */
export const unsupported = (capability: string) => () =>
  Effect.fail(new Unsupported({ capability }));

/** A feed that fails as `Unsupported` for `capability`. */
export const unsupportedFeed = (capability: string) => () =>
  Stream.fail(new Unsupported({ capability }));
