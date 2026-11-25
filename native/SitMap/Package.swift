// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SitMap",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "SitMap", targets: ["SitMap"])],
    targets: [
        .target(name: "SitMapCore"),
        .executableTarget(name: "SitMap", dependencies: ["SitMapCore"]),
        .testTarget(name: "SitMapCoreTests", dependencies: ["SitMapCore"])
    ]
)
