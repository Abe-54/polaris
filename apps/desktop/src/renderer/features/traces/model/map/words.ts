/**
 * The service map's words (Paper T5), set in mono caps by the view: the caller's kicker
 * ("bun test · turn 12"), each node's ("service · 220 spans") and each connector's ("×214 · HTTP").
 */
import type { Caller, MapEdge, MapNode } from "./graph.ts";

const base = (word: string) => word.split("/").at(-1) ?? word;

/** The program and its first two arguments, without directories or flags ("bun run settle.ts"). */
export const shortCommand = (command: string) => {
  const [program = "", ...args] = command.trim().split(/\s+/);
  const kept = args.filter((a) => !a.startsWith("-")).slice(0, 2);

  return [program, ...kept].map(base).join(" ");
};

export const turnWords = (caller: Caller) =>
  caller.turn === null ? "between turns" : `turn ${caller.turn.number}`;

export const callerWords = (caller: Caller): ReadonlyArray<string> =>
  caller.command === null ? [turnWords(caller)] : [shortCommand(caller.command), turnWords(caller)];

export const nodeWords = (node: MapNode, into: ReadonlyArray<MapEdge>): ReadonlyArray<string> => {
  if (node.kind === "service")
    return ["service", `${node.spans} span${node.spans === 1 ? "" : "s"}`];

  if (node.kind === "database") return ["inferred", "database"];
  const protocol = into.find((e) => e.protocol !== null)?.protocol ?? null;

  return protocol === null ? ["inferred"] : ["inferred", protocol];
};

export const edgeWords = (edge: MapEdge): string =>
  edge.protocol === null ? `×${edge.calls}` : `×${edge.calls} · ${edge.protocol}`;
