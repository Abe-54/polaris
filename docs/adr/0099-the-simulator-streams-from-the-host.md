---
status: accepted
---

# The Simulator streams from the Host, on Expo's device hub

## Context

The Simulator shows an iOS Simulator or Android Emulator in an Agent Session's Output, for the
user and its agents. ADR 0092 put the Browser in the Desktop App and rejected a Host-side
browser streamed as frames. A Simulator can't follow it: an iOS Simulator only runs on a Mac with
Xcode, which is often the Host and not the Client (or neither).

## Decision

- **The Host runs the Simulator and streams it.** This reverses 0092's pattern, deliberately.
  Only Hosts that can run one pay anything: the tab shows on Macs and on Hosts with the Android
  emulator, never on the Pi. Agents keep their Simulator with no Desktop App open, which 0092 gave
  up for the Browser.
- **Expo's `expo-device-hub` is the engine**, pinned and installed by the Daemon like
  agent-browser: serve-sim (iOS: private SimulatorKit capture, VideoToolbox H.264, HID input) and
  serve-emu (Android). Writing our own capture on private frameworks was rejected; Expo tracks
  each Xcode release. `agent-device` drives Simulators for agents.
- **The hub is a supervised child process** on loopback with a token: a crash in its native addon
  can't take the Daemon down. It starts on first use and is killed when idle, because serve-sim
  captures at 60 Hz until the device shuts down whether or not anyone watches. A restart also
  clears input that wedges in long-running hubs (expo/expo-device-hub#569).
- **Frames reach a remote Client as byte streams in the Polaris protocol** (ADR 0093), not SSH
  forwarding; a local Host's renderer connects to the hub's loopback port directly.
- **Polaris never ships GPL code**: serve-emu's ffmpeg/libx264 is the user's install.

## Consequences

Private Apple symbols can break with any Xcode release until Expo ships a fix. A zero-copy local
path (a shared IOSurface in the Desktop App) is possible later but would be ours to maintain.
