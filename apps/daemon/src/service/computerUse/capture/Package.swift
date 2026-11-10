// swift-tools-version: 6.0
// For `swift test` only: the Daemon build compiles Sources/ with swiftc (`../build.ts`).
import PackageDescription

let package = Package(
  name: "polaris-capture",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "polaris-capture"),
    .testTarget(name: "CaptureTests", dependencies: ["polaris-capture"]),
  ]
)
