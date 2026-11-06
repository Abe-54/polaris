import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConnectionStatusView, InstallFlowView, MachineView } from "../../../shared/api.ts";
import {
  ago,
  attentionCard,
  type CardAction,
  connectionLine,
  elapsed,
  hostCaption,
  needsUser,
  offerFacts,
  outcomeNote,
} from "./model.ts";
import { setClientPlatform } from "../../../shared/platform.ts";

const status = (patch: Partial<ConnectionStatusView> = {}): ConnectionStatusView => ({
  state: "connected",
  failure: null,
  attempt: 0,
  since: 1_000,
  nextAttemptAt: null,
  host: null,
  capabilities: [],
  epoch: 1,
  latencyMs: null,
  lastSeenAt: null,
  ...patch,
});

const install = (patch: Partial<InstallFlowView> = {}): InstallFlowView => ({
  step: "idle",
  activity: null,
  offer: null,
  outcome: null,
  problem: null,
  ...patch,
});

const machine = (patch: Partial<MachineView> = {}): MachineView => ({
  daemon: null,
  key: "pi",
  kind: "ssh",
  label: "Raspberry Pi 4",
  colour: null,
  alias: "pi",
  target: null,
  enabled: true,
  forwardAgent: false,
  remoteCommand: null,
  status: status(),
  install: install(),
  ...patch,
});

const attention = (reason: string, detail = "stderr line", older?: "daemon" | "client") =>
  machine({
    status: status({
      state: "needs-attention",
      failure: {
        kind: "needs-attention",
        reason,
        detail,
        older,
      },
    }),
  });

// The copy names the Client's machine ("this Mac"); pin the platform it expects.
beforeEach(() => setClientPlatform("darwin"));

afterEach(() => setClientPlatform(null));

describe("attention cards", () => {
  test.each<[string, CardAction | null, CardAction | null]>([
    ["host-key-unknown", "open-ssh", "retry"],
    ["host-key-changed", null, "copy-detail"],
    ["auth-failed", "retry", "open-ssh"],
    ["daemon-not-running", "start-daemon", "retry"],
    ["daemon-untrusted", "retry", null],
    ["protocol-mismatch", "check", null],
    ["polaris-not-installed", "check", null],
    ["ssh-config-error", "retry", null],
    ["ssh-missing", "retry", null],
    ["wsl-missing", "copy-detail", "retry"],
    ["wsl-distro-missing", "retry", null],
  ])("%s: the card offers its own fix, then its fallback", (reason, fix, secondary) => {
    const model = attentionCard(attention(reason));

    expect(model?.reason).toBe(reason);
    expect(model?.fix?.action ?? null).toBe(fix);
    expect(model?.secondary?.action ?? null).toBe(secondary);
  });

  test("a WSL Host's reasons: WSL gone (copy the install command), the distro gone (retry or remove)", () => {
    const distro = { ...attention("wsl-missing"), kind: "wsl" as const, alias: "Ubuntu" };
    expect(attentionCard(distro)).toMatchObject({
      detail: "wsl --install --no-distribution",
      fix: { action: "copy-detail" },
      secondary: { action: "retry" },
    });
    expect(
      attentionCard({ ...distro, status: attention("wsl-distro-missing").status })
    ).toMatchObject({
      title: "WSL no longer lists a distro called Ubuntu",
      fix: { action: "retry" },
      secondary: null,
    });
  });

  test("a changed host key never gets a one-click fix", () => {
    const model = attentionCard(attention("host-key-changed"));
    expect(model?.fix).toBeNull();
    expect(model?.detail).toBe("ssh-keygen -R pi");
    expect(model?.secondary?.action).toBe("copy-detail");
  });

  test("auth shows ssh's own line", () => {
    expect(
      attentionCard(attention("auth-failed", "pi@10.0.0.9: Permission denied (publickey)."))?.detail
    ).toBe("pi@10.0.0.9: Permission denied (publickey).");
  });

  test("this Mac with nothing installed offers Install with no approval; its log shows when stopped", () => {
    const local = { kind: "local" as const, key: "local", alias: null, label: "This Mac" };
    const missing = { ...attention("polaris-not-installed"), ...local };

    expect(attentionCard(missing)).toMatchObject({
      title: "Polaris isn't installed on This Mac",
      fix: { label: "Install", action: "check" },
    });
    expect(attentionCard(missing)?.body).toContain("~/.polaris");

    const log = "no Daemon is listening on /s.sock\n/h/.polaris/logs/daemon.err.log:\nkilled";
    const stopped = { ...attention("daemon-not-running", log), ...local };

    expect(attentionCard(stopped)).toMatchObject({
      detail: log,
      fix: { action: "start-daemon" },
    });
  });

  test("a protocol mismatch names the older side and offers the fix on that side", () => {
    expect(attentionCard(attention("protocol-mismatch", "v", "daemon"))).toMatchObject({
      title: "Raspberry Pi 4 runs an older daemon",
      fix: { label: "Upgrade", action: "check" },
    });
    expect(attentionCard(attention("protocol-mismatch", "v", "client"))).toMatchObject({
      title: "Polaris on this Mac is older than the daemon on Raspberry Pi 4",
      fix: { action: "retry" },
    });
  });

  test("upgrading a Windows daemon says its terminals end; elsewhere it hands off", () => {
    const older = attention("protocol-mismatch", "v", "daemon");

    expect(attentionCard(older)?.body).toBe(
      "The upgrade hands off in place; working agent sessions keep going."
    );

    const restarts =
      "The upgrade restarts the daemon: agent sessions recover, but its terminals end.";

    // This PC before any hello: the local Host of a Windows Client is the Windows daemon.
    setClientPlatform("win32");
    expect(attentionCard({ ...older, kind: "local" })?.body).toBe(restarts);
    // A WSL distro on the same PC runs the Linux daemon, which hands off.
    expect(attentionCard({ ...older, kind: "wsl" })?.body).not.toBe(restarts);
  });

  test("the install flow's card wins over the connection's while it runs", () => {
    const installing = {
      ...attention("polaris-not-installed"),
      install: install({ step: "installing", activity: "Copying the build over SSH" }),
    };

    expect(attentionCard(installing)).toMatchObject({
      reason: "installing",
      body: "Copying the build over SSH",
    });

    // The approval card is its own component, not a HostStateCard.
    const approval = {
      ...attention("polaris-not-installed"),
      install: install({ step: "approval" }),
    };

    expect(attentionCard(approval)).toBeNull();
    expect(needsUser(approval)).toBe(true);
  });

  test("an ssh failure during the check defers to the Connection State's card", () => {
    const failed = {
      ...attention("host-key-unknown"),
      install: install({
        step: "blocked",
        problem: { kind: "ssh", message: "Host key verification failed.", command: null },
      }),
    };

    expect(attentionCard(failed)?.reason).toBe("host-key-unknown");
    expect(attentionCard({ ...failed, status: status() })?.reason).toBe("ssh");
  });

  test("problems: host setup, failures, unsupported, and linger's admin command", () => {
    const setup = machine({
      install: install({
        step: "blocked",
        problem: {
          kind: "host-setup",
          message: "The host lacks libstdc++.",
          command: "apk add libstdc++ libgcc",
        },
      }),
    });

    expect(attentionCard(setup)).toMatchObject({
      reason: "host-setup",
      detail: "apk add libstdc++ libgcc",
    });

    const failed = machine({
      install: install({
        step: "blocked",
        problem: { kind: "failed", message: "exit 1", command: null },
      }),
    });

    expect(attentionCard(failed)?.fix).toEqual({ label: "Try again", action: "check" });

    const linger = machine({
      install: install({
        step: "ready",
        outcome: {
          kind: "installed",
          version: "0.2.0",
          from: null,
          notes: [],
          adminCommand: "sudo loginctl enable-linger pi",
        },
      }),
    });

    expect(attentionCard(linger)).toMatchObject({ reason: "linger", fix: null });
    expect(needsUser(machine())).toBe(false);
  });
});

describe("rows", () => {
  test("the Connection column", () => {
    expect(connectionLine(machine({ alias: null }), 0)).toEqual({
      state: "connected",
      label: "Connected",
      caption: "local",
      retry: false,
    });
    // A remote Host shows its latency, never its platform (DESIGN.md, Settings · Hosts).
    expect(connectionLine(machine({ status: status({ latencyMs: 4 }) }), 0).caption).toBe("4 ms");
    expect(connectionLine(machine(), 0).caption).toBeNull();
    expect(connectionLine(machine({ status: status({ latencyMs: 0 }) }), 0).caption).toBe("<1 ms");
    expect(
      connectionLine(machine({ status: status({ state: "reconnecting", since: 1_000 }) }), 41_000)
    ).toEqual({
      state: "reconnecting",
      label: "Reconnecting",
      caption: "for 40s",
      retry: false,
    });
    expect(connectionLine(machine({ status: null }), 0).state).toBe("off");

    const day = 24 * 3_600_000;
    const offline = status({ state: "offline", since: 5 * day, lastSeenAt: 2 * day });
    expect(connectionLine(machine({ status: offline }), 5 * day)).toEqual({
      state: "offline",
      label: "Offline",
      caption: "last seen 3d ago",
      retry: true,
    });
    expect(connectionLine(machine({ status: status({ state: "offline" }) }), 0).caption).toBe(
      "not reached yet"
    );
  });

  test("how long ago", () => {
    expect([ago(20_000), ago(12 * 60_000), ago(3 * 3_600_000), ago(49 * 3_600_000)]).toEqual([
      "just now",
      "12m ago",
      "3h ago",
      "2d ago",
    ]);
  });

  test("elapsed time", () => {
    expect([elapsed(12_000), elapsed(245_000), elapsed(3_720_000)]).toEqual([
      "12s",
      "4m 05s",
      "1h 02m",
    ]);
  });

  test("captions and notes", () => {
    expect(hostCaption(machine(), 1)).toBe("ssh pi · 1 workspace");
    expect(hostCaption(machine({ alias: null }), 2)).toBe("This Mac · 2 workspaces");
    expect(hostCaption(machine(), null)).toBe("ssh pi");
    expect(hostCaption(machine({ kind: "wsl", alias: "Ubuntu" }), 1)).toBe(
      "wsl Ubuntu · 1 workspace"
    );
    expect(
      outcomeNote(
        machine({
          install: install({
            step: "ready",
            outcome: {
              kind: "upgraded",
              version: "0.2.0",
              from: "0.1.0",
              notes: [],
              adminCommand: null,
            },
          }),
        })
      )
    ).toBe("Daemon upgraded 0.1.0 → 0.2.0");
  });

  test("the approval facts show the whole SHA-256 in two lines", () => {
    const sha = "9f2c41d70be3a6f158c2e9d47a10b3e5c6d82f47e19a0c3b5d7f2e86b4a1e41a";

    const facts = offerFacts(
      machine({
        install: install({
          step: "approval",
          offer: { platform: "linux-arm64", version: "0.1.0", sha256: sha, sizeBytes: 38_200_000 },
        }),
      })
    );

    expect(facts?.map((f) => f.value)).toEqual([
      "linux-arm64",
      "polaris 0.1.0 · 38.2 MB",
      "9f2c41d7 0be3a6f1 58c2e9d4 7a10b3e5\nc6d82f47 e19a0c3b 5d7f2e86 b4a1e41a",
      "~/.polaris on pi",
    ]);
  });
});
