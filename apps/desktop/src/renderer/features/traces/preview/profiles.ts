/**
 * Profiles on fixtures (DESIGN.md, Traces → Profile; Paper T2): ledger-api restarted with
 * profiling across the overdue run, the failing test's whole command, one from a Daemon that
 * doesn't say how it was made, and a failed one; and a 50,000-node recording for measuring.
 */
import {
  type Profile,
  type ProfileDetail,
  type ProfileFunction,
  ProfileId,
  type ProfileNode,
  type ProfilesSnapshot,
} from "@polaris/protocol";
import type { Result } from "../../../../shared/api.ts";
import type { ProfilesApi } from "../data/profilesApi.ts";
import { FIXTURE_CHECKOUT, FIXTURE_TURNS } from "./fixtures.ts";

/** A call: its function, when it starts after its parent's start, how long, and its calls. */
export interface CallSpec {
  readonly fn: string;
  readonly at: number;
  readonly ms: number;
  readonly calls?: ReadonlyArray<CallSpec>;
}

type Place = Pick<ProfileFunction, "file" | "line">;

const SRC = `${FIXTURE_CHECKOUT.checkout}/src`;

/** Where each fixture function lives: the checkout, a dependency, the runtime, or native. */
const PLACES = {
  recalculateOverdue: { file: `file://${SRC}/invoices/overdue.ts`, line: 30 },
  computeTotals: { file: `file://${SRC}/invoices/overdue.ts`, line: 44 },
  convertCurrency: { file: `file://${SRC}/fx.ts`, line: 8 },
  fetchRate: { file: `file://${SRC}/fx.ts`, line: 23 },
  round: { file: `file://${SRC}/money.ts`, line: 5 },
  "undici.request": {
    file: `file://${FIXTURE_CHECKOUT.checkout}/node_modules/undici/lib/api/api-request.js`,
    line: 171,
  },
  "tls.connect": { file: "node:tls", line: 1716 },
  handshake: { file: "node:tls", line: 1001 },
  writeHead: { file: "node:_http_server", line: 340 },
  "JSON.parse": { file: null, line: null },
  "(garbage collector)": { file: null, line: null },
  "test overdue totals": {
    file: `file://${FIXTURE_CHECKOUT.checkout}/test/overdue.test.ts`,
    line: 12,
  },
  "bun:test": { file: "bun:test", line: null },
} satisfies Record<string, Place>;

const placeOf = (fn: string): Place =>
  Object.entries(PLACES).find(([name]) => name === fn)?.[1] ?? {
    file: `file://${SRC}/report.ts`,
    line: 1,
  };

interface Flat {
  readonly fn: string;
  readonly parent: number | null;
  readonly startMs: number;
  readonly durationMs: number;
}

const flatten = (
  calls: ReadonlyArray<CallSpec>,
  base: number,
  parent: number | null,
  into: Array<Flat>
) => {
  for (const call of calls) {
    const index = into.length;
    const startMs = base + call.at;

    into.push({ fn: call.fn, parent, startMs, durationMs: call.ms });
    flatten(call.calls ?? [], startMs, index, into);
  }
};

/** Inclusive time counts a function once per stack, so recursion isn't counted twice. */
const timesOf = (flat: ReadonlyArray<Flat>) => {
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  const childMs = flat.map(() => 0);

  flat.forEach((f) => {
    if (f.parent !== null) childMs[f.parent] = (childMs[f.parent] ?? 0) + f.durationMs;
  });

  flat.forEach((f, i) => {
    self.set(f.fn, (self.get(f.fn) ?? 0) + Math.max(0, f.durationMs - (childMs[i] ?? 0)));
    let up = f.parent;
    let nested = false;

    while (up !== null && !nested) {
      nested = flat[up]?.fn === f.fn;
      up = flat[up]?.parent ?? null;
    }

    if (!nested) total.set(f.fn, (total.get(f.fn) ?? 0) + f.durationMs);
  });

  return { self, total };
};

/** Builds a ProfileDetail as the Daemon would: functions by total then self time, the hot path. */
export const buildProfile = (profile: Profile, calls: ReadonlyArray<CallSpec>): ProfileDetail => {
  const flat: Array<Flat> = [];

  flatten(calls, 0, null, flat);
  const { self, total } = timesOf(flat);

  const hotFunctions = [...total.keys()]
    .map((name) => ({
      name,
      ...placeOf(name),
      selfMs: self.get(name) ?? 0,
      totalMs: total.get(name) ?? 0,
    }))
    .sort((a, b) => b.totalMs - a.totalMs || b.selfMs - a.selfMs);

  const indexOf = new Map(hotFunctions.map((f, i) => [f.name, i]));

  const nodes: Array<ProfileNode> = flat.map((f) => ({
    parent: f.parent,
    functionIndex: indexOf.get(f.fn) ?? 0,
    startMs: f.startMs,
    durationMs: f.durationMs,
  }));

  // The hottest stack: from the longest root, down the longest child each time.
  const hotPath: Array<number> = [];

  const callsOf = (parent: number | null) =>
    flat.flatMap((f, i) => (f.parent === parent ? [[f, i] as const] : []));

  let level = callsOf(null);

  while (level.length > 0) {
    const [longest, at] = level.reduce((a, b) => (b[0].durationMs > a[0].durationMs ? b : a));

    hotPath.push(indexOf.get(longest.fn) ?? 0);
    level = callsOf(at);
  }

  return { profile, hotFunctions, hotPath, nodes };
};

/** One overdue request: rates fetched over TLS and parsed, then totals, then the response. */
const request = (at: number): CallSpec => ({
  fn: "recalculateOverdue",
  at,
  ms: 820,
  calls: [
    {
      fn: "convertCurrency",
      at: 6,
      ms: 700,
      calls: [
        {
          fn: "fetchRate",
          at: 4,
          ms: 670,
          calls: [
            {
              fn: "undici.request",
              at: 2,
              ms: 420,
              calls: [
                {
                  fn: "tls.connect",
                  at: 10,
                  ms: 260,
                  calls: [{ fn: "handshake", at: 8, ms: 210 }],
                },
              ],
            },
            { fn: "JSON.parse", at: 430, ms: 200 },
          ],
        },
      ],
    },
    { fn: "computeTotals", at: 712, ms: 96, calls: [{ fn: "round", at: 40, ms: 44 }] },
  ],
});

const LEDGER_MS = 12_400;

const LEDGER_CYCLE = 880;

const ledgerCalls = (): ReadonlyArray<CallSpec> => {
  const calls: Array<CallSpec> = [];

  for (let at = 0; at + LEDGER_CYCLE <= LEDGER_MS; at += LEDGER_CYCLE) {
    calls.push(request(at), { fn: "writeHead", at: at + 824, ms: 24 });
    calls.push({ fn: "(garbage collector)", at: at + 852, ms: 18 });
  }

  return calls;
};

/** The overdue run (BIG_TRACE, 14:02:11.204) is inside it: 0–700 ms of that trace. */
export const LEDGER_PROFILE: Profile = {
  id: ProfileId.make("prof-ledger-api-12"),
  command: "bun run --cwd apps/api dev",
  runtime: "bun",
  pid: 47_118,
  turn: FIXTURE_TURNS[12],
  startedAt: "2026-10-31T14:01:59.504Z",
  durationMs: LEDGER_MS,
  path: "/Users/lucas/.polaris/profiles/prof-ledger-api-12.cpuprofile",
  status: "completed",
  origin: "restart",
  service: "ledger-api",
};

/** The failing test (ERROR_TRACE, 14:01:52.630) as a whole command. */
export const TEST_PROFILE: Profile = {
  id: ProfileId.make("prof-test-overdue-12"),
  command: "bun test overdue-totals",
  runtime: "bun",
  pid: 47_052,
  turn: FIXTURE_TURNS[12],
  startedAt: "2026-10-31T14:01:52.630Z",
  durationMs: 3100,
  path: "/Users/lucas/.polaris/profiles/prof-test-overdue-12.cpuprofile",
  status: "completed",
  origin: "command",
};

/** From a Daemon that predates `origin` and `service`. */
const BACKFILL_PROFILE: Profile = {
  id: ProfileId.make("prof-backfill-11"),
  command: "node scripts/backfill-rates.ts",
  runtime: "node",
  pid: 46_210,
  turn: FIXTURE_TURNS[11],
  startedAt: "2026-10-31T13:41:02.104Z",
  durationMs: 1840,
  path: "/Users/lucas/.polaris/profiles/prof-backfill-11.cpuprofile",
  status: "completed",
};

const FAILED_PROFILE: Profile = {
  id: ProfileId.make("prof-seed-11"),
  command: "bun run seed",
  runtime: "bun",
  pid: 46_007,
  turn: FIXTURE_TURNS[11],
  startedAt: "2026-10-31T13:38:40.000Z",
  durationMs: 0,
  path: null,
  status: "failed",
  origin: "command",
};

const testCalls: ReadonlyArray<CallSpec> = [
  {
    fn: "bun:test",
    at: 0,
    ms: 3100,
    calls: [
      {
        fn: "test overdue totals",
        at: 20,
        ms: 3060,
        calls: [request(40), request(900), request(1760)],
      },
    ],
  },
];

const backfillCalls: ReadonlyArray<CallSpec> = [
  {
    fn: "convertCurrency",
    at: 0,
    ms: 1800,
    calls: [
      { fn: "fetchRate", at: 10, ms: 1700, calls: [{ fn: "JSON.parse", at: 1200, ms: 400 }] },
    ],
  },
];

export const LARGE_PROFILE_NODES = 50_000;

/** A deep recursive render: 24 levels, three calls every fourth level, 50,000 nodes over ~2 s. */
const largeCalls = (): ReadonlyArray<CallSpec> => {
  let left = LARGE_PROFILE_NODES;
  let seq = 0;

  const tree = (depth: number, at: number, ms: number): CallSpec => {
    left--;
    seq++;
    const width = depth % 4 === 0 ? 3 : 1;
    const calls: Array<CallSpec> = [];
    const share = ms / width;

    for (let i = 0; i < width && left > 0 && depth < 23; i++)
      calls.push(tree(depth + 1, share * i + share * 0.04, share * 0.92));

    return { fn: `render${depth}_${seq % 97}`, at, ms, calls };
  };

  const roots: Array<CallSpec> = [];

  for (let at = 0; left > 0; at += 100) roots.push(tree(0, at, 95));

  return roots;
};

export const LARGE_PROFILE: Profile = {
  id: ProfileId.make("prof-large"),
  command: "bun run render-report",
  runtime: "bun",
  pid: 47_300,
  turn: FIXTURE_TURNS[12],
  startedAt: "2026-10-31T14:02:40.000Z",
  durationMs: 0,
  path: "/Users/lucas/.polaris/profiles/prof-large.cpuprofile",
  status: "completed",
  origin: "command",
  service: "report-api",
};

const largeDetail = (): ProfileDetail => {
  const calls = largeCalls();
  const last = calls.at(-1);
  const durationMs = last === undefined ? 0 : last.at + last.ms;

  return buildProfile({ ...LARGE_PROFILE, durationMs }, calls);
};

const DETAILS: ReadonlyArray<readonly [Profile, () => ReadonlyArray<CallSpec>]> = [
  [LEDGER_PROFILE, ledgerCalls],
  [TEST_PROFILE, () => testCalls],
  [BACKFILL_PROFILE, () => backfillCalls],
];

export const FIXTURE_PROFILES: ReadonlyArray<Profile> = [
  LEDGER_PROFILE,
  TEST_PROFILE,
  BACKFILL_PROFILE,
  FAILED_PROFILE,
];

const fail = (code: string, message: string, fix: string): Result<never> => ({
  ok: false,
  error: { code, message, fix },
});

export interface ProfilesFixture {
  /** Include the 50,000-node recording, listed first. */
  readonly large?: boolean;
  /** Pids Polaris launched; restarting any other is refused, as the Daemon does. */
  readonly owned?: ReadonlyArray<number>;
}

/** A `ProfilesApi` over the fixtures; restarting an owned pid adds a recording. */
export const fixtureProfilesApi = ({ large = false, owned }: ProfilesFixture = {}): ProfilesApi => {
  const cache = new Map<string, ProfileDetail>();
  const added: Array<Profile> = [];
  const listeners = new Set<(snapshot: ProfilesSnapshot) => void>();

  const listed = (): ProfilesSnapshot => ({
    profiles: [
      ...added,
      ...(large
        ? [{ ...LARGE_PROFILE, durationMs: detailOf(LARGE_PROFILE.id)?.profile.durationMs ?? 0 }]
        : []),
      ...FIXTURE_PROFILES,
    ],
  });

  function detailOf(id: string): ProfileDetail | null {
    const known = cache.get(id);

    if (known !== undefined) return known;

    const made =
      id === LARGE_PROFILE.id && large
        ? largeDetail()
        : DETAILS.flatMap(([p, calls]) => (p.id === id ? [buildProfile(p, calls())] : []))[0];

    if (made === undefined) return null;
    cache.set(id, made);

    return made;
  }

  return {
    watch: (_at, on) => {
      const next = (snapshot: ProfilesSnapshot) => on.next(snapshot);

      listeners.add(next);
      next(listed());

      return () => listeners.delete(next);
    },
    get: (_at, profileId) => {
      const found = detailOf(profileId);

      if (found !== null) return Promise.resolve({ ok: true, value: found });

      return Promise.resolve(
        fail("E-PROFILE-UNAVAILABLE", "This recording has no profile to read", "Record it again")
      );
    },
    attach: () =>
      Promise.resolve(
        fail(
          "E-PROFILE-ATTACH-REFUSED",
          "This process is not registered.",
          "Restart with profiling instead."
        )
      ),
    restart: (_at, pid) => {
      if (owned !== undefined && !owned.includes(pid))
        return Promise.resolve(
          fail(
            "E-PROFILE-PROCESS-NOT-OWNED",
            "Polaris didn't start this process",
            "Start it from an agent session or a Polaris terminal, then restart it with profiling"
          )
        );

      const profile: Profile = {
        ...LEDGER_PROFILE,
        id: ProfileId.make(`prof-restart-${added.length + 1}`),
        pid: pid + 1,
        startedAt: "2026-10-31T14:03:00.000Z",
        durationMs: 0,
        path: null,
        status: "recording",
      };

      added.unshift(profile);

      for (const listener of listeners) listener(listed());

      return Promise.resolve({ ok: true, value: profile });
    },
  };
};
