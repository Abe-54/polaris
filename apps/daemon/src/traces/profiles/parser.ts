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
  samples: Schema.mutable(Schema.Array(Schema.Int).check(Schema.isMaxLength(2_000_000))),
  timeDeltas: Schema.mutable(Schema.Array(Schema.Finite).check(Schema.isMaxLength(2_000_000))),
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
  const cpu: unknown = JSON.parse(raw);
  Schema.asserts(CpuProfile, cpu);

  if (cpu.endTime < cpu.startTime || cpu.samples.length !== cpu.timeDeltas.length)
    throw invalidProfile();
  const parents = profileParents(cpu.nodes);
  validateDepths(cpu.nodes, parents);
  const { functions, functionOf } = profileFunctions(cpu.nodes, checkout);

  const durationMs = (cpu.endTime - cpu.startTime) / 1000;
  const { samples, timeDeltas } = chronologicalSamples(cpu);
  const nodes: MutableNode[] = [];
  const stackWeights = new Map<number, number>();
  let active: number[] = [];
  let elapsed = 0;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i]!;
    const stack = stackFor(sample, parents, functionOf);
    let micros = timeDeltas[i]!;

    while (i + 1 < samples.length && samples[i + 1] === sample) {
      micros += timeDeltas[++i]!;
    }

    const ms = micros / 1000;

    if (elapsed + ms > durationMs + 1) throw invalidProfile();
    const time = Math.min(ms, Math.max(0, durationMs - elapsed));
    stackWeights.set(sample, (stackWeights.get(sample) ?? 0) + time);
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

  const remap = new Uint32Array(order.length);

  for (let index = 0; index < order.length; index++) remap[order[index]!] = index;
  const hotFunctions = order.map((i) => functions[i]!);
  const hottest = [...stackWeights].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];

  const hotPath =
    hottest === undefined ? [] : stackFor(hottest, parents, functionOf).map((i) => remap[i]!);

  for (const node of nodes) node.functionIndex = remap[node.functionIndex]!;

  return {
    durationMs,
    clockStartMicros: cpu.startTime,
    hotFunctions,
    hotPath,
    nodes,
  };
};

const chronologicalSamples = (cpu: typeof CpuProfile.Type) => {
  if (!cpu.timeDeltas.some((delta) => delta < 0)) return cpu;
  let time = 0;
  const order = new Uint32Array(cpu.timeDeltas.length);

  for (let index = 0; index < order.length; index++) {
    time += cpu.timeDeltas[index]!;

    if (!Number.isFinite(time) || time < 0 || time > cpu.endTime - cpu.startTime + 1000)
      throw invalidProfile();

    cpu.timeDeltas[index] = time;
    order[index] = index;
  }

  order.sort((a, b) => cpu.timeDeltas[a]! - cpu.timeDeltas[b]!);
  reorderSamples(cpu, order);
  time = 0;

  for (let index = 0; index < order.length; index++) {
    const next = cpu.timeDeltas[index]!;
    cpu.timeDeltas[index] = next - time;
    time = next;
  }

  return cpu;
};

const reorderSamples = (cpu: typeof CpuProfile.Type, order: Uint32Array) => {
  // The worker owns this JSON-parsed buffer; move paired timestamps and IDs in place.
  for (let index = 0; index < order.length; index++) {
    if (order[index] === index) continue;
    const sample = cpu.samples[index]!;
    const time = cpu.timeDeltas[index]!;
    let destination = index;

    while (order[destination] !== index) {
      const source = order[destination]!;
      cpu.samples[destination] = cpu.samples[source]!;
      cpu.timeDeltas[destination] = cpu.timeDeltas[source]!;
      order[destination] = destination;
      destination = source;
    }

    cpu.samples[destination] = sample;
    cpu.timeDeltas[destination] = time;
    order[destination] = destination;
  }
};

type MutableNode = { -readonly [K in keyof ProfileNode]: ProfileNode[K] };

const appendFrames = (
  nodes: MutableNode[],
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
      nodes[index]!.durationMs += durationMs;
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
  const byId = new Set<number>();

  for (const node of cpuNodes) byId.add(node.id);

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

const validateDepths = (
  cpuNodes: ReadonlyArray<typeof CpuNode.Type>,
  parents: Map<number, number>
) => {
  const depths = new Map<number, number>();
  const path: number[] = [];

  for (const node of cpuNodes) {
    let id: number | undefined = node.id;

    while (id !== undefined && !depths.has(id)) {
      if (path.length >= 256) throw invalidProfile();
      path.push(id);
      // Zero marks the current ancestry walk, so revisiting it detects a cycle.
      depths.set(id, 0);
      id = parents.get(id);
    }

    const depth = id === undefined ? 0 : depths.get(id)!;

    if (id !== undefined && depth === 0) throw invalidProfile();
    recordDepths(path, depths, depth);
  }
};

const recordDepths = (path: number[], depths: Map<number, number>, ancestorDepth: number) => {
  let depth = ancestorDepth;

  if (depth + path.length > 256) throw invalidProfile();

  while (path.length > 0) depths.set(path.pop()!, ++depth);
};

const stackFor = (id: number, parents: Map<number, number>, functionOf: Map<number, number>) => {
  if (!functionOf.has(id)) throw invalidProfile();
  const stack: number[] = [];
  let current: number | undefined = id;

  while (current !== undefined) {
    stack.push(functionOf.get(current)!);
    current = parents.get(current);
  }

  return stack.reverse();
};
