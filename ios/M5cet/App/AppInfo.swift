// What the app is and what it links: the version from the bundle (package.json via
// ios/scripts/sync-version.mjs) and the libraries — M5Kit's modules and WebRTC.

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5NFC
import M5Net
import M5Proto
@preconcurrency import WebRTC

enum AppInfo {
    /// CFBundleShortVersionString — package.json's version (6.14.0).
    static var version: String { info("CFBundleShortVersionString") }
    /// CFBundleVersion — major·10000 + minor·100 + patch (61400), as Android's versionCode.
    static var build: String { info("CFBundleVersion") }

    /// The M5Kit modules the app links (docs/ios-architecture.md § 2).
    static let modules: [String] = [
        M5CoreModule.name, M5CryptoModule.name, M5ProtoModule.name,
        M5NetModule.name, M5DesignModule.name, M5NFCModule.name,
    ]

    /// WebRTC (SPM stasel/WebRTC 150.0.0 — Google's M150, the milestone of Android's
    /// io.github.webrtc-sdk:android:150.7871.01): a class of the framework, proof that it links.
    /// (The framework's Info.plist carries no real version.)
    static var webRTC: String { NSStringFromClass(RTCPeerConnectionFactory.self) }

    private static func info(_ key: String) -> String {
        Bundle.main.object(forInfoDictionaryKey: key) as? String ?? "?"
    }
}
