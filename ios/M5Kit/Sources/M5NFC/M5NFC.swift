// M5NFC — the NFC / smart-card logic of the M5cet apps without the radio
// (docs/ios-architecture.md § 3: A/nfc/* → M5NFC; the CoreNFC transport and the
// UI are the app's, M5cet/Platform/NFC). Pure Foundation / CryptoKit /
// CommonCrypto, so it builds for iOS, iPadOS, watchOS and macOS. See README.md.

/// The module's name (the app's placeholder screen shows it) and the port's version.
public enum M5NFCModule {
    public static let name = "M5NFC"
    /// The Android / web release this port follows.
    public static let portOf = "6.14.0"
}
