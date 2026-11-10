/**
 * Hosts and a fake bridge for `#computer-use/<scene>`: each Host's computer use status and
 * always-allowed apps, and a setup that walks Off → one step → Screen Recording → Ready.
 */
import {
  AllowedApp,
  AppId,
  type ComputerUseItem,
  ComputerUseItem as Item,
  ComputerUseSetup,
  ComputerUseState,
  ComputerUseStatus,
  DesktopApp,
} from "@polaris/protocol";
import { Option, Predicate, Schema } from "effect";
import type { PolarisApi, Result } from "../../../../shared/api.ts";
import type { HostFacts } from "../model.ts";

export const STEP_MS = 1500;

const mac = (accessibility: boolean, screenRecording: boolean) =>
  ComputerUseState.cases.NeedsSetup.make({
    setup: ComputerUseSetup.cases.MacPermissions.make({ accessibility, screenRecording }),
  });

const app = (id: string, name: string, allowedAt: string) =>
  AllowedApp.make({ app: DesktopApp.make({ id: AppId.make(id), name, icon: null }), allowedAt });

export interface FixtureHost {
  readonly key: string;
  readonly kicker: string;
  readonly facts: HostFacts;
  readonly state: ComputerUseState;
  readonly allowed: ReadonlyArray<AllowedApp>;
}

export const HOSTS: ReadonlyArray<FixtureHost> = [
  {
    key: "studio",
    kicker: "This Mac · Accessibility on, Screen Recording next",
    facts: { name: "Mac Studio", platform: "macos", local: true },
    state: mac(true, false),
    allowed: [
      app("com.apple.iphonesimulator", "Simulator", "2026-11-03T10:00:00Z"),
      app("com.apple.Safari", "Safari", "2026-10-28T10:00:00Z"),
      app("com.apple.Notes", "Notes", "2026-10-21T10:00:00Z"),
    ],
  },
  {
    key: "macbook",
    kicker: "Remote Mac · nothing granted",
    facts: { name: "MacBook Pro", platform: "macos", local: false },
    state: mac(false, false),
    allowed: [],
  },
  {
    key: "vm",
    kicker: "Linux VM · ready",
    facts: { name: "Linux VM", platform: "linux", local: false },
    state: ComputerUseState.cases.Ready.make({}),
    allowed: [app("firefox.desktop", "Firefox", "2026-11-06T10:00:00Z")],
  },
  {
    key: "pi-desktop",
    kicker: "Linux · a package to install",
    facts: { name: "lucas-rpi", platform: "linux", local: false },
    state: ComputerUseState.cases.NeedsSetup.make({
      setup: ComputerUseSetup.cases.LinuxPackages.make({
        packages: ["at-spi2-core"],
        command: "sudo apt-get install -y at-spi2-core",
      }),
    }),
    allowed: [],
  },
  {
    key: "windows",
    kicker: "Windows PC · not signed in",
    facts: { name: "Windows PC", platform: "windows", local: false },
    state: ComputerUseState.cases.NoDesktop.make({}),
    allowed: [],
  },
  {
    key: "pi",
    kicker: "Headless · one line",
    facts: { name: "Raspberry Pi 4", platform: "linux", local: false },
    state: ComputerUseState.cases.NoDesktop.make({}),
    allowed: [],
  },
];

/** This Mac before anything: off, for the first-run card's whole walk. */
export const BLANK: FixtureHost = {
  key: "local",
  kicker: "This Mac · blank",
  facts: { name: "Mac Studio", platform: "macos", local: true },
  state: ComputerUseState.cases.Off.make({}),
  allowed: [],
};

const HostInput = Schema.Struct({
  hostKey: Schema.String,
  permission: Schema.optional(Schema.NullOr(Schema.String)),
  appId: Schema.optional(Schema.String),
});

const ok = <A>(value: A): Result<A> => ({ ok: true, value });

/** Answers `computerUse.*` from the fixtures; opening setup grants a step after `STEP_MS`. */
export const fixtureBridge = (hosts: ReadonlyArray<FixtureHost>): PolarisApi => {
  const states = new Map(hosts.map((h) => [h.key, { ...h }]));
  const listeners = new Map<string, Set<(items: ReadonlyArray<ComputerUseItem>) => void>>();

  const statusOf = (key: string) =>
    ComputerUseStatus.make({
      state: states.get(key)?.state ?? ComputerUseState.cases.NoDesktop.make({}),
      checkedAt: new Date().toISOString(),
    });

  const publish = (key: string) => {
    const host = states.get(key);

    if (host === undefined) return;

    const items = [
      Item.cases.Status.make({ status: statusOf(key) }),
      Item.cases.AllowedApps.make({ apps: host.allowed }),
      Item.cases.ControlledApps.make({ apps: [] }),
    ];

    for (const listener of listeners.get(key) ?? []) listener(items);
  };

  const set = (key: string, state: ComputerUseState) => {
    const host = states.get(key);

    if (host === undefined) return;
    states.set(key, { ...host, state });
    publish(key);
  };

  const later = (key: string, state: ComputerUseState) =>
    setTimeout(() => set(key, state), STEP_MS);

  const answer = (method: string, key: string, input: typeof HostInput.Type) => {
    const host = states.get(key);

    if (host === undefined) return null;

    switch (method) {
      case "computerUse.enable":
        if (Predicate.isTagged(host.state, "Off")) set(key, mac(false, false));
        break;
      case "computerUse.disable":
        set(key, ComputerUseState.cases.Off.make({}));
        break;
      case "computerUse.openSetup":
        later(
          key,
          input.permission === "screen-recording"
            ? ComputerUseState.cases.Ready.make({})
            : mac(true, false)
        );
        break;
      case "computerUse.removeAllowedApp":
        states.set(key, { ...host, allowed: host.allowed.filter((a) => a.app.id !== input.appId) });
        publish(key);

        return ok(states.get(key)?.allowed ?? []);
      default:
        break;
    }

    return ok(statusOf(key));
  };

  return {
    request: async (method, input) => {
      const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(HostInput)(input));
      const result = decoded === undefined ? null : answer(method, decoded.hostKey, decoded);
      // SAFETY: each computerUse.* method answers its documented output above.

      return (result ?? { ok: false, error: { code: "Unsupported", message: "preview" } }) as never;
    },
    subscribe: (kind, input, listener) => {
      const key = Option.getOrUndefined(Schema.decodeUnknownOption(HostInput)(input))?.hostKey;

      if (kind !== "computerUse.watch" || key === undefined) return () => undefined;
      // SAFETY: only `computerUse.watch` is answered, whose items are ComputerUseItems.
      const push = listener.items as (items: ReadonlyArray<ComputerUseItem>) => void;
      const own = listeners.get(key) ?? new Set();

      own.add(push);
      listeners.set(key, own);
      queueMicrotask(() => publish(key));

      return () => own.delete(push);
    },
    onAppEvent: () => () => undefined,
  };
};
