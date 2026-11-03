# Polaris Sodium on Android

`PolarisSodiumModule` exposes the same 12 synchronous, buffer-writing functions as the
iOS module. Expo's `Uint8Array.toDirectBuffer()` includes the view's byte offset and
length. JNI uses that view directly and checks lengths before calling libsodium.
The shared JS shim supplies batch hashing, memory clearing, and optional argument handling.

`android/CMakeLists.txt` downloads libsodium 1.0.21 and checks SHA-256
`9e4285c7a419e82dedb0be63a72eea357d6943bc3e28e6735bf600dd4883feaf`.
This is the same release and checksum as `scripts/buildSodium.ts`.
`android/sodium.cmake` reads the portable source list from the pinned release's
`Makefile.am`. It uses the reference C implementations without assembly or CPU-specific
intrinsics. It generates `version.h` in the build directory. No shell, autoconf, downloaded
binaries, or source changes are needed during an Android build.

Gradle uses Expo SDK 58's module plugin and the app's NDK version when supplied.
CMake 3.22.1 must be installed in the Android SDK. Native builds support the app's selected
ABIs. The standalone check builds `x86_64` and `arm64-v8a` at API 24 and sets 16 KB ELF load
alignment. The consumer ProGuard rules preserve JNI class and exception names in releases.

## Build the Android libraries without Gradle

Run from the repository root in PowerShell. The default toolchain is Android SDK CMake
3.22.1 and NDK 27.1.12297006 under `%LOCALAPPDATA%\Android\Sdk`.
Pass `-AndroidSdk`, `-CMakeVersion`, or `-NdkVersion` to select another installed toolchain.

```powershell
& .\apps\mobile\modules\polaris-sodium\testing\build.ps1 `
  -Scratch "$env:TEMP\polaris-sodium build with spaces"
```

The script invokes NDK CMake and clang directly. It writes all build outputs outside the
checkout and reports the path of each library. It never runs the app's Gradle build or
prebuild and never connects to an emulator.

## Check JNI against sodium-native

Use JDK 17 or newer through `JAVA_HOME`. Set `POLARIS_ZIG` to a local Windows Zig executable.
The host check was verified with Zig 0.14.1. Zig is a test tool and is not used by Gradle.
Dependencies must already be installed.

```powershell
& .\apps\mobile\modules\polaris-sodium\testing\build.ps1 `
  -Scratch "$env:TEMP\polaris-sodium build with spaces" -Zig $env:POLARIS_ZIG
```

To check a host JNI library that is already built, run:

```powershell
bun apps/mobile/modules/polaris-sodium/testing/check.ts `
  "$env:TEMP\polaris-sodium build with spaces\host-jni"
```

`NativeProbe.java` loads the production `Sodium.java` and C bridge in a real JVM with
`-Xcheck:jni`. Only Expo's exception base is replaced for the host. The probe preserves
shared backing buffers, offsets, and overlapping views and checks padding for writes
outside them. It compares deterministic results with the existing
`src/sodium/nativeOnBun.testing.ts` adapter over sodium-native. Random outputs cannot match
byte for byte across runs, so random keypairs are checked against sodium-native's key
derivation and signatures for the generated keys.

The check covers every native function, JS batch hashing and memory clearing, empty and
70,000-byte messages, keyed and unkeyed BLAKE2b, optional AD, in-place AEAD, invalid lengths,
invalid X25519 points, and authentication failures. It also bundles the existing
`shimProbe.testing.ts` over this JNI adapter and runs `noiseCheck.ts`'s Noise IK vector,
relay channel, and identity/link-proof known answers.

## Check the full app

The standalone check does not compile the Kotlin module against Expo, package an APK, or
run Hermes on Android. The app owner must verify these during the full release build:

- Expo autolinking includes `dev.lux.polaris.sodium.PolarisSodiumModule`.
- Kotlin compilation and CMake configuration pass from the actual Windows checkout.
- The APK contains `libpolaris_sodium.so` for the selected ABIs.
- A release launch can require `PolarisSodium` without a missing-module or JNI-link error.
- The app's three `runNoiseChecks()` checks pass on Android, including buffer views and
  authentication failures. Pairing and Host relay traffic work through the installed app.
- If release minification is enabled, a release build still resolves JNI methods and
  `SodiumException` through the consumer rules.
