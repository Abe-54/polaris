# Polaris Relay in Rust, and the relay's load generator

A Cargo workspace beside the Bun relay (`apps/relay`):

| Crate | What |
|---|---|
| `relay` (`polaris-relay`) | The Polaris Relay in Rust. Same wire contract, limits, close codes, log lines and environment variables as `apps/relay`, whose README is the contract. |
| `bench` (`relay-bench`) | A load generator that starts a relay build, drives it over its real wire protocol, and reports latency, throughput, and the CPU and memory the relay process used. |

ADR 0104 has the design and the measurements behind it. Our relay on Railway is this build
(`apps/relay/railway.json`).

```sh
cargo build --release          # from apps/relay-rs: target/release/{polaris-relay,relay-bench}
cargo test -p polaris-relay    # unit tests and the raw-socket tests
```

`rust-toolchain.toml` pins the toolchain, and rustup fetches it on the first build. CI's
`relay-rs` job runs `cargo fmt --check`, clippy with warnings as errors, these tests, and the
Bun relay's suite against the release binary.

## The relay

```sh
PORT=8080 target/release/polaris-relay
docker build -f apps/relay-rs/Dockerfile -t polaris-relay-rs .   # from the repository root
docker run -p 8080:8080 polaris-relay-rs
```

It reads the variables of `apps/relay/README.md`, and one of its own:

| Variable | Value |
|---|---|
| `POLARIS_RELAY_WORKERS` | Threads that serve sockets, each its own event loop. Default: the machine's cores, at most 8. `1` serves everything on the main thread. |

Where it differs from the Bun relay, none of it on the wire contract:

- **No `early-message` close.** It checks a key proof before it reads the socket again, so a
  message can't arrive while a proof is being checked.
- **More `endedBy` values** in `relay.connection`: `too-big` (1009), `protocol-error` (1002, a
  WebSocket fault such as an unmasked frame), `idle`, `backpressure` (both dropped without a
  close frame, 1006 to the party) and `shutdown` (1001, on SIGTERM).
- **`PORT=0`** binds a free port, reported in `relay.start`. The tests rely on it.
- **Sockets that have not upgraded are bounded.** As many may be mid-handshake as may be
  connected (`POLARIS_RELAY_MAX_CONNECTIONS`, at least 64); one more is closed unanswered and
  logged as `relay.refused` with `relay-full`. A connection is closed after 32 plain requests.

### The same tests, both builds

`POLARIS_RELAY_COMMAND` points the Bun relay's suite at another build: each test then starts
that command as a process (`apps/relay/src/testing/processRelay.ts`), configured through the
README's environment variables, and reads its log lines from stdout.

```sh
cd apps/relay
POLARIS_RELAY_COMMAND=$PWD/../relay-rs/target/release/polaris-relay bun test src/
```

Every relay, abuse, push, live and process test passes against the Rust build. Its own tests
cover what a WebSocket client library won't send: fragments, frames cut across writes, protocol
faults, pipelined HTTP and its bounds, a receiver that stops reading, the idle ping, and
shutdown (`relay/tests/sockets.rs`).

### Layout

| File | What |
|---|---|
| `wire.rs` | Addresses, the data frame header, control messages, key proofs and tickets. |
| `ws.rs`, `http.rs` | The WebSocket frame codec and the upgrade request. No WebSocket library. |
| `hub.rs` | Who is online and who may reach whom. |
| `conn.rs` | One socket's write side: its queue, direct writes, backpressure. |
| `session.rs` | One socket's read side: frames in, forwards out, control, timers, closing. |
| `server.rs` | Listening, the worker threads, admission, wakes and Live Activity deliveries. |
| `limits.rs`, `live.rs`, `push.rs`, `events.rs`, `config.rs` | Token buckets and the gate, Live Activities, the push client, log lines, environment. |

## The load generator

```sh
target/release/relay-bench list
target/release/relay-bench run --target bun  --json results/bun.json
target/release/relay-bench run --target rust --json results/rust.json
target/release/relay-bench compare results/bun.json results/rust.json
```

`--target` is `bun` (`bun apps/relay/src/main.ts`), `rust` (this workspace's release binary) or
any command that serves a relay on `$PORT`, run from the current directory. Each scenario
starts a fresh relay with the connection gate opened wide, proves real Ed25519 keys, links
pairs, and stamps every frame with its send time; a frame lost, reordered or refused is a
fault and fails the run.

| Scenario | Load | Answers |
|---|---|---|
| `interactive` | 200 pairs, 256 B at 20/s each way | The latency of ordinary traffic |
| `stream` | 40 pairs, 16 KiB at 120/s to the device, 64 B at 30/s back | Input latency beside a stream |
| `contend` | 100 pairs at 20/s beside 4 pairs flooding 64 KiB frames | Ordinary traffic's latency while bulk fills the relay's core |
| `storm` | 100 pairs at 20/s, 2,000 idle hosts, 300 parties a second connecting and leaving | Latency while the relay admits and drops sockets |
| `flood-small` | 32 pairs, 256 B as fast as they arrive | The frame-rate ceiling |
| `flood-large` | 8 pairs, 64 KiB as fast as they arrive | The byte-rate ceiling |
| `connect` | Sockets one at a time, then 64 at once | Socket open to `ready` |
| `idle` | 2,000 silent pairs | Memory per socket, idle CPU |

| Flag | What |
|---|---|
| `--scenario a,b` | Only these scenarios. |
| `--runs N` | N runs per scenario; each metric reports its median. |
| `--warm S` | S seconds of traffic before measuring. Bun's JIT needs about 15 s to reach the speed it holds in service; a short run flatters or slanders it at random. |
| `--threads N` | The load generator's threads (default 4). |
| `--quick` | Smaller sizes, for a smoke test. Not for numbers. |
| `--label`, `--json` | The result's name in tables, and where to write it. |

`relay_cpu_per_frame` is the relay process's user and system CPU time over the window, divided
by the frames it forwarded. `loadgen_cpu` near `--threads` × 100% means the load generator was
the limit, not the relay. The floods and `contend` run with the per-socket rates lifted, and a
load generator too slow to take what it floods is dropped at the backpressure limit, which the
run reports as faults: give it more cores than the relay.

### Getting numbers you can trust

Latency under load measures the machine as much as the relay. On a laptop with other work
running the percentiles swing by 10x between runs. What worked:

- A quiet Linux machine, the relay pinned to its own cores and the load generator to others:

  ```sh
  POLARIS_RELAY_WORKERS=1 taskset -c 2,3 ./relay-bench run --threads 2 --warm 15 \
    --target "taskset -c 0 ./polaris-relay" --label rust --json results/rust-1.json
  ```

- The builds interleaved over several rounds (base, optimized, Rust, then again), and the
  median taken per metric, so drift in the machine falls on all of them.
- The same load generator binary and flags for every build.
- macOS is fine for throughput and CPU per frame, with one caveat: tokio registers sockets for
  write readiness as well as read, and kqueue wakes the relay for it where epoll would not, so
  the Rust relay's CPU reads higher on a Mac than on Linux.

Linux arm64 binaries from a Mac:

```sh
docker run --rm -v "$PWD":/src -w /src -e CARGO_TARGET_DIR=/src/target/linux \
  rust:1-bookworm cargo build --release
```
