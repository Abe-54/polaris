/**
 * `polaris extension pair|list|revoke` (ENG-401): Pairings on this Host from
 * a terminal, through the local Daemon's `extensions.*` RPCs, so a revoke
 * closes live connections exactly as from Settings.
 */
import { connectRpcWith } from "@polaris/client";
import {
  DaemonRpcs,
  GRANT_KINDS,
  type GrantKind,
  type Pairing,
  PairingId,
} from "@polaris/protocol";
import { Effect, Match, Predicate } from "effect";
import { renderUnicodeCompact } from "uqr";
import { paths } from "../paths.ts";
import { localDaemonTransport } from "../transport/localDaemon.ts";

export const EXTENSION_USAGE = [
  "usage: polaris extension pair --name <name> --allow <grant,...>",
  "       polaris extension list",
  "       polaris extension revoke <id>",
  "pair and revoke need the Desktop App (Settings › Extensions); a terminal can only list.",
  `grants: ${GRANT_KINDS.join(", ")} (driving a session that approves on its own needs approve as well as turn)`,
].join("\n");

export type ExtensionCommand =
  | { readonly kind: "pair"; readonly name: string; readonly grant: ReadonlyArray<GrantKind> }
  | { readonly kind: "list" }
  | { readonly kind: "revoke"; readonly id: PairingId };

const isGrantKind = (value: string): value is GrantKind =>
  GRANT_KINDS.some((kind) => kind === value);

const flagValue = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const at = args.indexOf(flag);

  return at < 0 ? undefined : args[at + 1];
};

const parsePair = (args: ReadonlyArray<string>): ExtensionCommand | string => {
  const known = new Set(["--name", "--allow"]);
  const name = flagValue(args, "--name")?.trim();
  const allow = flagValue(args, "--allow");
  const stray = args.filter((arg, i) => i % 2 === 0 && !known.has(arg));

  if (args.length % 2 !== 0 || stray.length > 0) return `unexpected ${stray[0] ?? args.at(-1)}`;

  if (name === undefined || name === "") return "--name is required";

  if (allow === undefined) return "--allow is required";
  const kinds = allow.split(",").map((kind) => kind.trim());
  const unknown = kinds.find((kind) => !isGrantKind(kind));

  if (unknown !== undefined) return `unknown grant "${unknown}"`;

  return { kind: "pair", name, grant: kinds.filter(isGrantKind) };
};

/** The command, or the reason the arguments are wrong. */
export const parseExtensionArgs = (args: ReadonlyArray<string>): ExtensionCommand | string => {
  const [verb, ...rest] = args;

  switch (verb) {
    case "pair":
      return parsePair(rest);
    case "list":
      return rest.length === 0 ? { kind: "list" } : `unexpected ${rest[0]}`;
    case "revoke":
      return rest.length === 1 && rest[0] !== undefined
        ? { kind: "revoke", id: PairingId.make(rest[0]) }
        : "revoke takes one pairing id";
    default:
      return verb === undefined ? "missing command" : `unknown command "${verb}"`;
  }
};

const grantLine = (pairing: Pairing) =>
  pairing.grant.length === 0 ? "nothing" : pairing.grant.join(", ");

const usedLine = (pairing: Pairing) =>
  pairing.revokedAt !== null
    ? `revoked ${pairing.revokedAt}`
    : pairing.lastUsedAt === null
      ? "not used yet"
      : `last used ${pairing.lastUsedAt}`;

/** Keep user-supplied text from controlling the terminal or forging output lines. */
const terminalText = (text: string): string =>
  text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (char) => `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0")}`
  );

/** QR capacity must never prevent delivery of the one-time pairing string. */
const pairingQr = (pairingString: string): string => {
  try {
    return `${renderUnicodeCompact(pairingString)}\n\n`;
  } catch {
    return "";
  }
};

export const formatPaired = (
  { pairing, pairingString }: { readonly pairing: Pairing; readonly pairingString: string },
  terminal = process.stdout.isTTY
): string => {
  const qr = terminal ? pairingQr(pairingString) : "";

  return `${qr}Paired ${terminalText(pairing.name)} (${terminalText(pairing.id)}) with ${grantLine(pairing)}.\nThis is the only time the pairing string is shown:\n${pairingString}`;
};

/** One line per Pairing: id, name, Grant, and when it was last used or revoked. */
export const formatPairings = (pairings: ReadonlyArray<Pairing>): string =>
  pairings.length === 0
    ? "No extensions are paired with this host."
    : pairings
        .map((p) => [p.id, p.name, grantLine(p), usedLine(p)].map(terminalText).join("  ·  "))
        .join("\n");

/** `DaemonRpcs` carries the user gate's refusal, which a terminal gets for pair and revoke (ADR 0100). */
const connectCli = (transport: Parameters<typeof connectRpcWith>[1]) =>
  connectRpcWith(DaemonRpcs, transport);

/** A terminal holds no user key, so an agent there can't pair itself an Extension. */
const NEEDS_DESKTOP =
  "pairing and revoking Extensions needs the Desktop App: use Settings › Extensions";

const withDaemon = <A, E>(
  use: (client: Effect.Success<ReturnType<typeof connectCli>>["client"]) => Effect.Effect<A, E>
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const transport = yield* localDaemonTransport(
        process.env.POLARIS_HOST_SOCKET ?? paths().socket
      );

      const { client } = yield* connectCli(transport);

      return yield* use(client);
    })
  ).pipe(Effect.timeout("30 seconds"));

const run = (command: ExtensionCommand) =>
  Match.value(command).pipe(
    Match.discriminatorsExhaustive("kind")({
      pair: ({ name, grant }) =>
        withDaemon((client) => client["extensions.pair"]({ name, grant })).pipe(
          Effect.map((paired) => formatPaired(paired)),
          Effect.catchTag("UserAccessRequired", () => Effect.fail(NEEDS_DESKTOP))
        ),
      list: () =>
        withDaemon((client) => client["extensions.list"]()).pipe(Effect.map(formatPairings)),
      revoke: ({ id }) =>
        withDaemon((client) => client["extensions.revoke"]({ id })).pipe(
          Effect.map(
            (pairing) => `Revoked ${terminalText(pairing.name)} (${terminalText(pairing.id)}).`
          ),
          Effect.catchTag("NotFound", () => Effect.fail(`no pairing ${id} on this host`)),
          Effect.catchTag("UserAccessRequired", () => Effect.fail(NEEDS_DESKTOP))
        ),
    })
  );

export const runExtension = async (args: ReadonlyArray<string>): Promise<number> => {
  const command = parseExtensionArgs(args);

  if (Predicate.isString(command)) {
    console.error(`polaris extension: ${terminalText(command)}\n${EXTENSION_USAGE}`);

    return 2;
  }

  try {
    console.log(await Effect.runPromise(run(command)));

    return 0;
  } catch (error) {
    console.error(
      `polaris extension: ${terminalText(Predicate.isString(error) ? error : String(error))}`
    );

    return 1;
  }
};
