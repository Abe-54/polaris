import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute, relative } from "node:path";
import { Schema } from "effect";
import { redactText } from "../redact.ts";
import {
  ProfileError,
  type ProfileDetail,
  type ProfileFunction,
  type ProfileNode,
} from "@polaris/protocol";

const Nonnegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const CpuNode = Schema.Struct({
  id: Schema.Int,
  callFrame: Schema.Struct({
    functionName: Schema.String.check(Schema.isMaxLength(8192)),
    url: Schema.String.check(Schema.isMaxLength(16384)),
    lineNumber: Schema.Int,
  }),
  children: Schema.optionalKey(Schema.Array(Schema.Int)),
});

const CpuProfile = Schema.Struct({
  startTime: Nonnegative,
  endTime: Nonnegative,
  nodes: Schema.Array(CpuNode).check(Schema.isMaxLength(200_000)),
  samples: Schema.Array(Schema.Int).check(Schema.isMaxLength(2_000_000)),
  timeDeltas: Schema.Array(Nonnegative).check(Schema.isMaxLength(2_000_000)),
});

export const invalidProfile = () =>
  new ProfileError({
    code: "E-PROFILE-INVALID",
    message: "The CPU profile is malformed or exceeds the capture limits.",
    fix: "Run a shorter command with Node or Bun CPU profiling and retry.",
  });

const location = (url: string, checkout: string): string | null => {
  if (!url || /^(?:bun|builtin|native):/.test(url)) return null;
  let path = url;

  if (url.startsWith("file:")) {
    try {
      path = fileURLToPath(url);
    } catch {
      return redactText(url);
    }
  }

  if (!isAbsolute(path)) return redactText(path);
  let local = relative(checkout, path);

  if (local === ".." || local.startsWith("../") || isAbsolute(local)) {
    try {
      path = realpathSync(path);
      local = relative(checkout, path);
    } catch {}
  }

  return redactText(
    local !== ".." && !local.startsWith("../") && !isAbsolute(local) ? local : path
  );
};

/** All JSON validation, graph traversal and sample aggregation run in the profile worker. */
export const parseProfile = (
  raw: string,
  checkout: string
): Omit<ProfileDetail, "profile"> & { durationMs: number; clockStartMicros: number } => {
  const cpu = Schema.decodeUnknownSync(Schema.fromJsonString(CpuProfile))(raw);

  if (cpu.endTime < cpu.startTime || cpu.samples.length !== cpu.timeDeltas.length)
    throw invalidProfile();
  const parents = profileParents(cpu.nodes);
  const { functions, functionOf } = profileFunctions(cpu.nodes, checkout);
  const stacks = profileStacks(cpu.nodes, parents, functionOf);

  const durationMs = (cpu.endTime - cpu.startTime) / 1000;
  const nodes: ProfileNode[] = [];
  const stackWeights = new Map<number, number>();
  let active: number[] = [];
  let elapsed = 0;

  for (let i = 0; i < cpu.samples.length; i++) {
    const stack = stacks.get(cpu.samples[i]!);

    if (stack === undefined) throw invalidProfile();
    const ms = cpu.timeDeltas[i]! / 1000;

    if (elapsed + ms > durationMs + 1) throw invalidProfile();
    const time = Math.min(ms, Math.max(0, durationMs - elapsed));
    stackWeights.set(cpu.samples[i]!, (stackWeights.get(cpu.samples[i]!) ?? 0) + time);
    functions[stack.at(-1)!]!.selfMs += time;

    for (const f of new Set(stack)) functions[f]!.totalMs += time;
    active = appendFrames(nodes, active, stack, elapsed, time);
    elapsed += time;

    if (nodes.length > 500_000) throw invalidProfile();
  }

  const order = functions
    .map((_, i) => i)
    .sort(
      (a, b) =>
        functions[b]!.totalMs - functions[a]!.totalMs ||
        functions[b]!.selfMs - functions[a]!.selfMs ||
        a - b
    );

  const remap = new Map(order.map((old, index) => [old, index]));
  const hotFunctions = order.map((i) => functions[i]!);
  const hottest = [...stackWeights].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
  const hotPath = hottest === undefined ? [] : stacks.get(hottest)!.map((i) => remap.get(i)!);

  return {
    durationMs,
    clockStartMicros: cpu.startTime,
    hotFunctions,
    hotPath,
    nodes: nodes.map((n) => ({ ...n, functionIndex: remap.get(n.functionIndex)! })),
  };
};

const appendFrames = (
  nodes: ProfileNode[],
  previous: number[],
  stack: number[],
  startMs: number,
  durationMs: number
): number[] => {
  const active: number[] = [];
  let shared = true;

  for (let depth = 0; depth < stack.length; depth++) {
    const old = previous[depth];
    shared = shared && old !== undefined && nodes[old]!.functionIndex === stack[depth];

    if (shared) {
      const index = old!;
      nodes[index] = { ...nodes[index]!, durationMs: nodes[index]!.durationMs + durationMs };
      active.push(index);
    } else {
      active.push(nodes.length);
      nodes.push({
        parent: active[depth - 1] ?? null,
        functionIndex: stack[depth]!,
        startMs,
        durationMs,
      });
    }
  }

  return active;
};

type MutableFunction = { -readonly [K in keyof ProfileFunction]: ProfileFunction[K] };

const profileParents = (cpuNodes: ReadonlyArray<typeof CpuNode.Type>) => {
  const byId = new Map(cpuNodes.map((node) => [node.id, node]));

  if (byId.size !== cpuNodes.length) throw invalidProfile();
  const parents = new Map<number, number>();

  for (const node of cpuNodes) {
    for (const child of node.children ?? []) {
      if (!byId.has(child) || parents.has(child)) throw invalidProfile();
      parents.set(child, node.id);
    }
  }

  return parents;
};

const profileFunctions = (cpuNodes: ReadonlyArray<typeof CpuNode.Type>, checkout: string) => {
  const functions: MutableFunction[] = [];
  const indices = new Map<string, number>();
  const functionOf = new Map<number, number>();
  const files = new Map<string, string | null>();

  for (const node of cpuNodes) {
    const frame = node.callFrame;

    if (!files.has(frame.url)) files.set(frame.url, location(frame.url, checkout));
    const file = files.get(frame.url)!;
    const line = file === null || frame.lineNumber < 0 ? null : frame.lineNumber + 1;
    const key = JSON.stringify([redactText(frame.functionName), file, line]);
    let index = indices.get(key);

    if (index === undefined) {
      index = functions.length;
      indices.set(key, index);
      functions.push({
        name: redactText(frame.functionName) || "(anonymous)",
        file,
        line,
        selfMs: 0,
        totalMs: 0,
      });
    }

    functionOf.set(node.id, index);
  }

  return { functions, functionOf };
};

const profileStacks = (
  cpuNodes: ReadonlyArray<typeof CpuNode.Type>,
  parents: Map<number, number>,
  functionOf: Map<number, number>
) => {
  const stacks = new Map<number, number[]>();

  for (const node of cpuNodes) {
    const stack: number[] = [];
    const seen = new Set<number>();
    let id: number | undefined = node.id;

    while (id !== undefined) {
      if (seen.has(id) || stack.length >= 256) throw invalidProfile();
      seen.add(id);
      stack.push(functionOf.get(id)!);
      id = parents.get(id);
    }

    stacks.set(node.id, stack.reverse());
  }

  return stacks;
};
