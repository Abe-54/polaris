---
status: proposed
amends: ADR 0080
---

# The Relay forwards with one write per turn, and has a Rust build

## Context

Everything a Linked Device does away from its Host's network crosses the Polaris Relay
(ADR 0080): the Mobile App's requests, and now heavier traffic such as the browser. Its latency
is added to every one of them, in both directions (ENG-849).

We had no numbers. `apps/relay-rs/bench` now drives a relay build over its real wire protocol
and reports latency, throughput and what the relay process used. Profiling the Bun relay under
it showed where the time went:

- **One `sendto` per forwarded frame.** In a flood of small frames about 90% of the relay's CPU
  was the kernel writing one frame at a time. The JavaScript on the path was about 340 ns of
  6 µs a frame.
- **Copies and schema decoding per frame.** Each forward decoded the address through Effect
  Schema and built a new frame around the payload.
- **A scan of every listed device** whenever a host left or changed its list, to drop the
  entries it had emptied. With 2,000 hosts online and parties coming and going, the relay did
  little else.

## Decision

**The relay writes to each socket once per event-loop turn, forwards a frame in the buffer it
arrived in, and exists in two builds held to one contract: Bun (`apps/relay`) and Rust
(`apps/relay-rs`).**

### The Bun relay

- **Small frames share a write.** Each party subscribes to a topic of its own, and a data frame
  under 8 KiB is published to the destination's topic. Bun sends what was published to a socket
  in one write when the loop turn ends. A direct `send` to that socket sends what is pending
  first, so control messages and large frames keep their place in the order.
- **Large frames are sent at once.** At 8 KiB and over, the write is already most of the cost
  and sharing it gains nothing.
- **The frame is forwarded in place.** Source and destination addresses have the same length,
  so the sender's address is written over the destination's and the received buffer goes on.
  The header is checked by hand, to the same rules as `decodeDataFrame` and `RelayAddress`.
- **Leaving costs what the host listed.** The hub drops an emptied entry as it unlists the
  device, with no scan.

### The Rust relay

- **One event loop per core, and a socket never changes loops.** The main thread accepts and
  hands sockets round-robin to worker threads, each a single-threaded tokio runtime
  (`POLARIS_RELAY_WORKERS`; default the cores, at most 8).
- **The sender's task writes to the receiver's socket.** A forward is read, checked and queued
  on the destination's buffer under a short lock, and every socket touched in a read turn is
  flushed when the turn ends: one write per socket per turn, with no task woken to do it. A
  frame of 8 KiB or more is written straight from the read buffer when nothing is queued ahead.
- **One read per frame.** A short read tells the relay the socket is drained, so it does not
  read again to hear "nothing more".
- **A read turn is about one large frame.** A connection reads 64 KiB, finishes the frame it
  is in, and lets the loop's other connections run, so bulk on one socket delays the others
  by one frame.
- **No WebSocket or HTTP library on the path.** The frame codec, the upgrade and the masking
  are a few hundred lines that work on the read buffer in place.
- **Log lines are written before the close frame**, so a line exists by the time its party
  sees the close.

### One contract

`apps/relay/README.md` stays the contract. The Bun relay's suite runs against any build:
`POLARIS_RELAY_COMMAND` starts that command per test in place of the in-process relay. Every
test passes against both. The Rust relay's own tests cover what a WebSocket client library
cannot send.

## Measurements

A Raspberry Pi 4 (four Cortex-A72 cores, Linux 6.18), the relay pinned to one core and the
load generator to two others, 15 s of traffic before each measurement, Bun 1.4.4. Each figure
is the median of three rounds that ran the builds in turn. "Before" is the Bun relay as it was.

| | Before | Bun | Rust |
|---|---|---|---|
| **Ordinary traffic**: 200 pairs, 8,000 frames a second | | | |
| latency p50 | 0.52 ms | 0.48 ms | 0.36 ms |
| latency p99 | 2.29 ms | 1.81 ms | 1.51 ms |
| relay CPU per frame | 70 µs | 59 µs | 46 µs |
| **Input beside a stream**: 40 pairs, 75 MiB/s | | | |
| input latency p50 | 3.15 ms | 1.33 ms | 0.56 ms |
| input latency p99 | 21.5 ms | 3.7 ms | 1.9 ms |
| relay CPU | 99% of a core | 80% | 46% |
| **Traffic while 300 parties a second come and go**, 2,000 hosts idle | | | |
| latency p50 | 679 ms | 0.63 ms | 0.26 ms |
| latency p99 | 2.8 s | 23 ms | 1.0 ms |
| socket open to `ready` p50 | 3.6 s | 2.5 ms | 1.4 ms |
| **Ceilings** on one core | | | |
| 256 B frames | 28,000/s | 101,000/s | 103,000/s |
| 64 KiB frames | 114 MiB/s | 138 MiB/s | 205 MiB/s |
| sockets opened and proven | 935/s | 968/s | 1,742/s |
| **Memory** | | | |
| under ordinary traffic | 49 MiB | 47 MiB | 4.5 MiB |
| 4,000 idle sockets | 62 MiB | 63 MiB | 16 MiB |

No run lost, reordered or refused a frame. At the 256 B ceiling of the two new builds the load
generator was at its own limit too, so theirs may be higher. The Bun build's p99 under churn is
the least steady figure here: 23 to 39 ms from round to round.

What the figures say:

- **The old relay's worst cases are gone in both builds.** Under churn it fell seconds behind,
  and beside a stream on a full core it added 20 ms to input.
- **On ordinary traffic the Bun changes are modest** (p99 down a fifth) **and the Rust build
  takes a further quarter off p50.** Most of what is left is the kernel and the load generator.
- **The Rust build does the same work on a half to two thirds of the old relay's CPU** and a
  quarter to a tenth of its memory, so it keeps its latency at loads where the Bun build has started to
  queue.
- These are a slow core's numbers. On the relay's own hardware every figure is lower and the
  network between a phone and the relay is tens of milliseconds, so the gain that reaches a
  user is in the tails: a busy relay, a stream beside input, a redeploy's reconnect storm.

**Workers.** With two cores, the Rust build with two workers against one: the same latency
within noise (ordinary traffic p50 0.31 against 0.37 ms, p99 1.5 against 1.4 ms; no difference
beside a stream or under churn) for 10 to 25% more CPU per frame, since most forwards then
cross threads. Workers add room, not speed. The default still takes the cores it is given, so
a relay never queues on one core while others sit idle.

**Ordinary traffic while bulk fills the core.** Four pairs flooding 64 KiB frames beside 100
pairs at 20 frames a second, the load generator on three cores. Ordinary traffic's p50 was
37 ms before, 29 ms on the Bun build and 1.9 ms on the Rust build (p99 53, 58 and 24 ms), which
carried twice the bulk meanwhile (156 against 76 MiB/s). The Rust figure is a choice: a read
turn takes 64 KiB and ends at the next frame boundary, so a busy connection holds its loop for
about one large frame. With 1 MiB turns the p50 was 18 ms and no more bulk got through, and
ordinary traffic on its own measured the same at either size.

## Considered Options

- **Batching forwards with `setImmediate` in the Bun relay.** Throughput rose 1.4x, but an
  idle loop does not run the callback until something else wakes it: interactive p50 went from
  0.27 ms to 2 ms and p99 to 167 ms. Publishing gets the same single write with no wait.
- **A multi-threaded tokio runtime with work stealing.** It spent about 50 µs of CPU per frame
  on ordinary traffic waking and parking workers, more than the Bun relay. Loops that never
  share a socket need none of that.
- **A task per socket for writes, fed by a channel.** Each forward then costs a wake-up and a
  second scheduling pass before the write; writing from the sender's task costs neither.
- **A WebSocket library (`tokio-tungstenite`).** It hands over each message as an owned buffer
  and writes per message. The load generator uses it, which is fine on that side.
- **io_uring.** Not tried. It is Linux only, and the relay's CPU is already mostly `recvfrom`
  and `sendto` in the kernel, so fewer system calls per frame come first. Worth a look if the
  relay ever fills a core in service.

## Consequences

- The Bun relay's `dropped` count no longer sees frames lost on the publish path. A socket
  over its backpressure limit is still closed.
- Two builds must stay in step. A change to the relay's behaviour lands in both, with the test
  that names it in `apps/relay/src`, where it runs against both.
- The Rust relay adds `endedBy` values (`too-big`, `protocol-error`, `idle`, `backpressure`,
  `shutdown`) and never closes with `early-message`; `apps/relay-rs/README.md` lists them.
- CI's `relay-rs` job formats, lints and tests `apps/relay-rs`, then runs the Bun relay's suite
  against its binary, whenever either relay or the protocol changes (ENG-861).
- Railway still runs the Bun build. Switching is a change of Dockerfile in
  `apps/relay/railway.json` (ENG-862); that decision is why this ADR is proposed and not
  accepted.
- Each party's topic costs the Bun relay about 0.4 KiB a socket.
- On macOS the Rust relay is woken for write readiness that Linux does not report, so its CPU
  reads higher on a Mac. Measure on Linux.
