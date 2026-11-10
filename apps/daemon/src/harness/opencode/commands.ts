/**
 * OpenCode's commands in a directory, from its server's `GET /command`: custom
 * commands, MCP prompts and Skills. A Turn that starts with one of them runs
 * through `POST /session/{id}/command`, which expands its template the way
 * OpenCode's TUI does (`slashCommandOf`). Of the TUI's own commands only `/compact` is
 * offered; it runs through `summarize` (`OpenCodeSession.ts`).
 */
import { SlashCommand, type SlashCommandKind } from "@polaris/protocol";
import { Effect } from "effect";
import type { HarnessError } from "../HarnessDriver.ts";
import type { OpenCodeClient } from "./Client.ts";
import * as P from "./protocol.ts";

const decodeCommands = P.decoder(P.Commands);

type Command = (typeof P.Command)["Type"];

export const toCommand = (command: Command): SlashCommand => {
  const kind: SlashCommandKind = command.source === "skill" ? "skill" : "command";

  return new SlashCommand({
    name: command.name,
    sigil: "/",
    description: command.description ?? "",
    argumentHint: command.hints.length === 0 ? null : command.hints.join(" "),
    kind,
    source: "user",
    plugin: null,
    run: "text",
    action: null,
    template: null,
  });
};

/** What the directory's OpenCode instance lists; nothing when the answer isn't one. */
export const readCommands = (client: OpenCodeClient) =>
  Effect.map(client.get("/command"), (payload) => decodeCommands(payload) ?? []);

const order = (a: SlashCommand, b: SlashCommand) =>
  a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "skill" ? -1 : 1;

/** OpenCode's TUI command Polaris runs itself. */
export const COMPACT_COMMAND = new SlashCommand({
  name: "compact",
  sigil: "/",
  description: "Summarize the conversation to free up context",
  argumentHint: null,
  kind: "command",
  source: "built-in",
  plugin: null,
  run: "harness",
  action: null,
  template: null,
});

export const listOpenCodeCommands = (
  client: OpenCodeClient
): Effect.Effect<ReadonlyArray<SlashCommand>, HarnessError> =>
  Effect.map(readCommands(client), (commands) => [
    COMPACT_COMMAND,
    ...commands
      .filter((command) => command.name !== COMPACT_COMMAND.name)
      .map(toCommand)
      .sort(order),
  ]);

const SLASH = /^\/(\S+)(?:\s+([\s\S]*))?$/;

/** A prompt that names one of `commands` (`/name args`), as the command and its arguments. */
export const slashCommandOf = (
  prompt: string,
  commands: ReadonlyArray<Command>
): { readonly command: string; readonly arguments: string } | null => {
  const match = SLASH.exec(prompt.trim());

  if (match === null || !commands.some((c) => c.name === match[1])) return null;

  return { command: match[1] ?? "", arguments: match[2]?.trim() ?? "" };
};
