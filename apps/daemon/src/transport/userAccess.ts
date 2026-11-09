/**
 * User access (ENG-700, ADR 0100): which connections may make user-only requests
 * (`@polaris/protocol` `userAccess.ts`). The Host keeps only digests of enrolled user keys
 * in `~/.polaris/user-access.json`; the first key it sees is enrolled, later unknown ones are not.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideUserAccess,
  type HostId,
  type LinkedDevice,
  UserAccessGate,
  UserKey,
} from "@polaris/protocol";
import { Effect, Option, Predicate, Redacted, Schema } from "effect";
import type { Rpc } from "effect/rpc";
import { admissionOf } from "../extensions/admission.ts";
import { pairingOf } from "../extensions/connection.ts";
import { deviceOf } from "../linkedDevices/connection.ts";
import { paths } from "../paths.ts";

const Enrolment = Schema.Struct({
  digest: Schema.String,
  label: Schema.String,
  enrolledAt: Schema.String,
});

const EnrolmentFile = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), keys: Schema.Array(Enrolment) })
);

type Enrolments = typeof EnrolmentFile.Type;

const decodeFile = Schema.decodeUnknownOption(EnrolmentFile);

const encodeFile = Schema.encodeSync(EnrolmentFile);

const decodeKey = Schema.decodeUnknownOption(UserKey);

/** Of a `dispatch` payload, the gate needs only the Command's tag. */
const dispatchTag = Schema.decodeUnknownOption(
  Schema.Struct({ command: Schema.Struct({ _tag: Schema.String }) })
);

export const userAccessFile = (root: string = paths().root) => join(root, "user-access.json");

const held = new WeakSet<Rpc.ServerClient>();

/** Whether this connection's `hello` presented an enrolled user key. */
export const hasUserAccess = (client: Rpc.ServerClient): boolean => held.has(client);

const digestOf = (hostId: HostId, key: string) =>
  createHash("sha256")
    .update(JSON.stringify(["polaris-user-access-v1", hostId, key]))
    .digest("hex");

/** None when the file is unreadable or corrupt: then nothing is enrolled anew over it. */
const readEnrolments = (file: string): Option.Option<Enrolments> => {
  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

    return missing ? Option.some({ version: 1, keys: [] }) : Option.none();
  }

  return decodeFile(text);
};

const writeEnrolments = (file: string, enrolments: Enrolments) => {
  const partial = `${file}.${randomBytes(8).toString("hex")}.part`;
  writeFileSync(partial, encodeFile(enrolments), { mode: 0o600, flag: "wx" });
  chmodSync(partial, 0o600);
  renameSync(partial, file);
};

export interface UserKeyInput {
  readonly hostId: HostId;
  readonly key: Redacted.Redacted<unknown> | undefined;
  /** Shown when listing enrolments, e.g. the Desktop App's device label. */
  readonly label: string;
  /** Defaults to `~/.polaris/user-access.json`. */
  readonly file?: string | undefined;
  readonly now?: () => Date;
}

/**
 * Binds `hello`'s user key to the connection: enrolled, or the first key this Host sees.
 * Synchronous from read to write, so two first hellos can't both enrol. Once held, kept.
 */
export const bindUserAccess = (client: Rpc.ServerClient, input: UserKeyInput): boolean => {
  if (held.has(client)) return true;

  const key = input.key === undefined ? Option.none() : decodeKey(Redacted.value(input.key));

  if (Option.isNone(key)) return false;
  const file = input.file ?? userAccessFile();
  const enrolments = readEnrolments(file);

  if (Option.isNone(enrolments)) return false;
  const digest = digestOf(input.hostId, key.value);
  const known = enrolments.value.keys.some((entry) => entry.digest === digest);

  if (!known && enrolments.value.keys.length > 0) return false;

  if (!known) {
    const enrolledAt = (input.now?.() ?? new Date()).toISOString();

    try {
      writeEnrolments(file, { version: 1, keys: [{ digest, label: input.label, enrolledAt }] });
    } catch {
      return false;
    }
  }

  held.add(client);

  return true;
};

/** Whether a request comes from a token-less Client, the only kind this gate decides for. */
const tokenlessClient = (client: Rpc.ServerClient, transport: TransportFacts) => {
  const admission = admissionOf(client);

  return (
    !transport.tokenRequired(client) &&
    !admission.tokenRequired &&
    admission.role !== "extension" &&
    pairingOf(client) === null &&
    (transport.deviceOf?.(client) ?? deviceOf(client)) === null
  );
};

export interface TransportFacts {
  readonly tokenRequired: (client: Rpc.ServerClient) => boolean;
  /** The Linked Device a connection came in as, from the transport rather than annotations. */
  readonly deviceOf?: (client: Rpc.ServerClient) => LinkedDevice | null;
}

/**
 * The user gate: Extensions and Linked Devices pass to their own gates; a token-less
 * Client without user access is refused what `USER_RPCS` and `USER_COMMANDS` mark `user`.
 */
export const userAccessGateFor = (transport: TransportFacts) =>
  UserAccessGate.of((effect, { client, rpc, payload }) => {
    if (Predicate.isTagged(rpc, "hello") || !tokenlessClient(client, transport)) return effect;

    const command = Predicate.isTagged(rpc, "dispatch")
      ? Option.getOrNull(Option.map(dispatchTag(payload), (p) => p.command._tag))
      : null;

    const refusal = decideUserAccess(rpc._tag, command, hasUserAccess(client));

    return refusal === null ? effect : Effect.fail(refusal);
  });
