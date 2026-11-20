// swift-tools-version:5.7
import PackageDescription

var targets: [Target] = [
    // Everything that is not a window: protocol types, state reduction, command mapping, keys, filter, reconnect policy.
    // Foundation only, so its tests run anywhere Swift does (they are run in a Linux swift container as well as on the Mac).
    .target(name: "RuneMiniCore", path: "Sources/RuneMiniCore"),
    .testTarget(name: "RuneMiniCoreTests", dependencies: ["RuneMiniCore"], path: "Tests/RuneMiniCoreTests"),
]
#if os(macOS)
// The app itself: AppKit, MediaPlayer, Carbon. Not built off the Mac.
targets.append(.executableTarget(name: "RuneMini", dependencies: ["RuneMiniCore"], path: "Sources/RuneMini"))
#endif

let package = Package(
    name: "RuneMini",
    platforms: [.macOS(.v12)],
    targets: targets
)
