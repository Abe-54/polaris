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
ABIs. Native libraries are built at API 24 with 16 KB ELF load
alignment. The consumer ProGuard rules preserve JNI class and exception names in releases.
