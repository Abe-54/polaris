import { basename, resolve } from "node:path";
import { Effect } from "effect";
import { TurnItem, type WorkspaceId } from "@polaris/protocol";
import type { EventStore } from "../../store/EventStore.ts";
import { contains } from "./read.ts";

export const applicationProgram = (program: string, args: ReadonlyArray<string> = []) => {
  const name = basename(program)
    .replace(/\.(?:exe|cmd)$/i, "")
    .toLowerCase();

  if (
    args.length === 0 ||
    args.some((arg) => ["--version", "-v", "--help", "-h", "--check", "-c"].includes(arg))
  )
    return false;

  if (name === "node") return true;

  if (name === "deno") return ["run", "task", "test", "serve", "eval", "bench"].includes(args[0]!);

  if (name === "bun")
    return !["install", "add", "remove", "update", "pm", "build"].includes(args[0]!);

  return (
    ["npm", "pnpm", "yarn"].includes(name) &&
    ["run", "run-script", "start", "dev", "test", "exec", "dlx"].includes(args[0]!)
  );
};

export const applicationCommand = (command: string) => {
  const commands =
    /(?:^|[;&|]\s*)(?:[^\s=]+=[^\s]+\s+)*((?:[^\s"']*[\\/])?(?:node|deno|bun|npm|pnpm|yarn)(?:\.exe|\.cmd)?)\s+([^;&|\n]*)/g;

  return [...command.matchAll(commands)].some((match) =>
    applicationProgram(match[1]!, match[2]!.trim().split(/\s+/).filter(Boolean))
  );
};

/** Settings reads examine recent recorded commands; requesting an environment alone is not launch evidence. */
export const observedApplication = Effect.fnUntraced(function* (
  events: EventStore["Service"],
  workspaceId: WorkspaceId,
  checkout: string
) {
  const model = yield* events.model;

  const turnIds = [...model.sessions.values()]
    .filter(
      ({ session }) =>
        session.workspaceId === workspaceId && contains(checkout, resolve(session.cwd))
    )
    .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
    .slice(0, 16)
    .flatMap(({ turns }) => turns.slice(-2).map((turn) => turn.id));

  if (turnIds.length === 0) return false;
  const items = yield* events.readTurnItems({ turnIds, upTo: model.sequence });

  return [...items.values()].some((turn) =>
    turn.some(
      (item) =>
        TurnItem.guards.CommandExecution(item) &&
        applicationCommand(item.command) &&
        ((item.status === "completed" && item.exitCode === 0) || item.backgroundTaskId != null)
    )
  );
});
