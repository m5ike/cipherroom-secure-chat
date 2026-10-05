// swift-tools-version:6.2
// M5Kit — the logic of the M5cet iOS / iPadOS / watchOS apps without UI
// (docs/ios-architecture.md). Each target is a port of a part of the Android
// app (android/app/src/main/java/cz/m5cet/app) and is tested with `swift test`
// on macOS against the same vectors as the web client and the Android app.
// Only the coordinator edits this file.

import PackageDescription

let package = Package(
    name: "M5Kit",
    platforms: [.iOS(.v26), .watchOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "M5Kit", targets: ["M5Core", "M5Crypto", "M5Proto", "M5Net", "M5Design", "M5NFC"]),
    ],
    targets: [
        .target(name: "CArgon2", path: "Sources/CArgon2", cSettings: [.unsafeFlags(["-O3"])]),  // Argon2id at -O0 (Debug) is ~8× slower
        .target(name: "M5Core", path: "Sources/M5Core"),
        .target(name: "M5Crypto", dependencies: ["CArgon2", "M5Core"], path: "Sources/M5Crypto", exclude: ["README.md"]),
        .target(name: "M5Proto", dependencies: ["M5Core", "M5Crypto"], path: "Sources/M5Proto", exclude: ["README.md"]),
        .target(name: "M5Net", dependencies: ["M5Core", "M5Crypto", "M5Proto"], path: "Sources/M5Net", exclude: ["README.md"]),
        .target(name: "M5Design", dependencies: ["M5Core"], path: "Sources/M5Design", exclude: ["README.md", "ELEMENTS.md"]),
        .target(name: "M5NFC", dependencies: ["M5Core", "M5Crypto"], path: "Sources/M5NFC", exclude: ["README.md"]),
        .testTarget(name: "M5CoreTests", dependencies: ["M5Core"], path: "Tests/M5CoreTests"),
        .testTarget(name: "M5CryptoTests", dependencies: ["M5Crypto", "M5Core"], path: "Tests/M5CryptoTests"),
        .testTarget(name: "M5ProtoTests", dependencies: ["M5Proto", "M5Crypto", "M5Core"], path: "Tests/M5ProtoTests"),
        .testTarget(name: "M5NetTests", dependencies: ["M5Net", "M5Proto", "M5Crypto", "M5Core"], path: "Tests/M5NetTests", exclude: ["fixtures"]),
        .testTarget(name: "M5DesignTests", dependencies: ["M5Design", "M5Core"], path: "Tests/M5DesignTests", exclude: ["fixtures"]),
        .testTarget(name: "M5NFCTests", dependencies: ["M5NFC", "M5Core", "M5Crypto"], path: "Tests/M5NFCTests"),
    ],
    swiftLanguageModes: [.v6]
)
