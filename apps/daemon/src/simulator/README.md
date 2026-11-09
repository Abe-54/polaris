# The Simulator on the Daemon

The Host's iOS Simulators and Android emulators stream from the Host (ADR 0099): the Daemon runs expo-device-hub, and Clients talk to it directly with the port and token `simulator.attach` gives them. This folder holds support detection (`support.ts`, `index.ts`, ENG-829's D1) and the hub's lifecycle behind the `simulator.*` RPCs (`hub.ts`, D2). The research behind it is `docs/research/2026-11-09-simulator-hub-spike.md`.

## SimulatorHub

`SimulatorHub` (`hub.ts`) is the service. `transport/simulatorHandlers.ts` serves the RPCs over it, and `transport/serve.ts` provides it under the Engine so the Harnesses' Simulator MCP server can call it.

| RPC | What it does |
|---|---|
| `simulator.watch` | `Snapshot` of support and Simulators, then `SupportChanged`, `SimulatorChanged` and `SimulatorRemoved`. Lists iOS with `simctl` (never starts the hub); polls every 10 s only while a watch is open. Android comes from the hub while it runs. |
| `simulator.boot` | Boots through the hub and records the id as booted by Polaris. |
| `simulator.shutdown` | Refuses a Simulator Polaris didn't boot with `SimulatorNotBootedByPolaris` unless `force`. iOS shuts down through serve-sim's grid route, which closes its capture first (`simctl` hangs otherwise). |
| `simulator.restart` | Restarts the hub; every open attach gets `Attached` again. |
| `simulator.attach` | Holds the hub up and sends `Attached { port, token }`, again after every restart. Remote Clients reach the loopback port through `hostAddress.open` byte streams (ADR 0093). Opening it makes the Simulator the session's shown one. |
| `simulator.sessionFeed` | `Showing` first (and `AgentDriving` if an agent drives now), then every change. |

### The in-Daemon API

The Simulator MCP server calls these; none starts the hub or needs a Desktop App, and each restarts the hub's idle clock.

- `agentOpened(sessionId, id)`: the session shows `id` (`Showing` when it changed), then `AgentOpened { id }`.
- `agentDriving(sessionId)`: scoped. `AgentDriving { active: true }` when the first holder opens, `false` when the last closes.
- `shown(sessionId)`: the session's shown Simulator, or null. Held in memory; a Daemon restart forgets it.
- `agentBooted(id)`: an agent booted `id` itself, so Polaris shuts it down when the hub idles out.

## The hub process

`hubProcess.ts` starts one hub per Host with `BUN_BE_BUN=1 <polaris> <hub> --host 127.0.0.1 --port <free> --require-token`, its state dir and `TMPDIR` under `~/.polaris/simulator/hub/`. That directory is cleared before every start and removed after every stop, so serve-sim's per-device files (one holds the dead hub's token) never carry over. The hub picks its own token; the Daemon reads it from the state file once `/healthz` answers. The Daemon never loads `/vendor/serve-sim/`, whose page spawns a helper that outlives the hub.

`supervisor.ts` owns the lifecycle, one start, stop or restart at a time:

- **Start** on the first attach, boot, shutdown or restart.
- **Crash**: an exit nobody asked for restarts after 1, 2, 5, 15, then 30 s while the hub is wanted (held, or an agent called within the idle time); a hub that ran a minute resets the backoff.
- **Wedge**: frames alone don't prove liveness (a still screen streams ~4.5 fps), so every 30 s while attached it opens an input socket per attached iOS Simulator, waits for `0x83`, sends a no-op scroll and a `0x11` barrier, and restarts the hub when the `0x91` doesn't come back in 2 s (`hubClient.ts`). A socket never admitted, or one whose capture says input is unavailable, is not a wedge.
- **Idle**: no attach open and no agent call for `HUB_IDLE_MS` (5 minutes; `POLARIS_SIMULATOR_IDLE_MS` overrides it for end-to-end runs) shuts down the Simulators Polaris booted, then SIGTERMs the hub, with SIGKILL after 60 s. Capture never idles out inside the hub, so this is the only idle mechanism.

`bootedStore.ts` keeps the booted-by-Polaris ids in `~/.polaris/simulator/booted.json` across Daemon restarts; an id is forgotten once the Simulator is seen shut down, so a later boot by someone else is theirs. Polaris never creates or erases Simulators.

## Tests

`hub.test.ts` and `hub.lifecycle.test.ts` run the service against `fakeHub.testing.ts`, a stand-in process with the hub's flags, state file, token gate, device routes and input barrier: idle stop, crash restart, wedge restart and booted-by-Polaris shutdown. `hub.real.slow.test.ts` runs a real hub on a throwaway `polaris-test-<random>` Simulator it creates and deletes; it is skipped on a Host without an iOS runtime.
