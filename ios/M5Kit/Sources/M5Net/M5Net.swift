// M5Net — the network layer of the M5cet iOS / iPadOS / watchOS apps
// (docs/ios-architecture.md § 3: A/net, A/account, A/push, A/update and the
// hub parts of A/chat, A/rtc, A/security/{ServerPin,SignedPolicy}).
//
// What it holds: the signaling hub client (protocol v2 frames, the join proof,
// resume, presence, keepalive, reconnects, rate limits, several rooms), the
// relay with per-recipient envelopes and the key directory over the hub, key
// transparency over HTTP, the signed device API (/api/ios/*: enrolment,
// check-in with the signed policy, control messages, design bundles, releases,
// events), the account API (passkey ceremonies' JSON, sessions, vault slots,
// notification settings) and the ICE servers. Cryptography it does not do
// itself comes in through small protocols (README.md) that M5Crypto and the
// app's Platform layer (Secure Enclave, Keychain) implement.

public enum M5NetModule { public static let name = "M5Net" }

/// What this build tells servers about itself. The app sets `appVersion` / `appCode` at start
/// (CFBundleShortVersionString, the build number major·10000+minor·100+patch).
public enum M5NetInfo {
    public static let defaultVersion = "6.14.0"
    public static let defaultCode = 61400
    /// "M5cet-iOS/<version>" (Android: "M5cet-Android/<version>").
    public static var userAgent: String { "M5cet-iOS/\(defaultVersion)" }
    public static func userAgent(version: String, platform: String = "iOS") -> String { "M5cet-\(platform)/\(version)" }
}
