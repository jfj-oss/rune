// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "RuneMini",
    platforms: [.macOS(.v12)],
    targets: [
        // Everything that is not a window: protocol types, state reduction, command mapping, keys, filter, reconnect policy.
        // Foundation only, so its tests run anywhere Swift does.
        .target(name: "RuneMiniCore", path: "Sources/RuneMiniCore"),
        .executableTarget(name: "RuneMini", dependencies: ["RuneMiniCore"], path: "Sources/RuneMini"),
        .testTarget(name: "RuneMiniCoreTests", dependencies: ["RuneMiniCore"], path: "Tests/RuneMiniCoreTests"),
    ]
)
