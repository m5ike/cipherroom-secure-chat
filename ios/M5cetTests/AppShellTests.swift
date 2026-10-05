// The app shell's tests (XCTest, hosted by M5cet.app on the simulator): the bundle is
// what the contract says (docs/ios-architecture.md) — version from package.json, the
// design assets byte for byte as Android ships them, links, NFC, usage texts in the
// nine languages, the embedded extension, watch app and WebRTC.

import XCTest
@testable import M5cet

final class AppShellTests: XCTestCase {
    /// The repository's root, from this file's path (ios/M5cetTests/AppShellTests.swift).
    private static let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    private var info: [String: Any] { Bundle.main.infoDictionary ?? [:] }

    // MARK: identity and version

    func testBundleIdentifier() {
        XCTAssertEqual(Bundle.main.bundleIdentifier, "cz.m5cet.app")
        XCTAssertEqual(info["CFBundleDisplayName"] as? String, "M5cet")
    }

    func testVersionFollowsPackageJson() throws {
        let data = try Data(contentsOf: Self.repo.appendingPathComponent("package.json"))
        let version = try XCTUnwrap((try JSONSerialization.jsonObject(with: data) as? [String: Any])?["version"] as? String)
        let parts = version.split(separator: ".").prefix(3).map { Int($0.prefix { $0.isNumber }) ?? -1 }
        XCTAssertEqual(parts.count, 3)
        XCTAssertEqual(AppInfo.version, parts.map(String.init).joined(separator: "."))
        XCTAssertEqual(AppInfo.build, String(parts[0] * 10000 + parts[1] * 100 + parts[2]))
    }

    // MARK: design assets (one source of truth: android/app/src/main/assets/m5)

    func testDesignAssetsAreTheAndroidOnes() throws {
        for name in ["default-design", "icons", "themes"] {
            let bundled = try XCTUnwrap(Bundle.main.url(forResource: name, withExtension: "json", subdirectory: "m5"), "\(name).json not bundled")
            let source = Self.repo.appendingPathComponent("android/app/src/main/assets/m5/\(name).json")
            XCTAssertEqual(try Data(contentsOf: bundled), try Data(contentsOf: source), "\(name).json differs from Android's")
        }
        let design = try Data(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "default-design", withExtension: "json", subdirectory: "m5")))
        XCTAssertNotNil(try JSONSerialization.jsonObject(with: design) as? [String: Any])
    }

    // MARK: links

    func testURLSchemeIsRegistered() throws {
        let types = try XCTUnwrap(info["CFBundleURLTypes"] as? [[String: Any]])
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        XCTAssertTrue(schemes.contains(DeepLink.scheme))
    }

    func testDeepLinks() throws {
        let enroll = try XCTUnwrap(URL(string: "m5cet://enroll?server=chat.example.com&code=AB-12&kid=abcdefghijklmnop"))
        XCTAssertEqual(DeepLink(url: enroll), .enroll(enroll))
        let upper = try XCTUnwrap(URL(string: "M5CET://ENROLL?server=x"))
        XCTAssertEqual(DeepLink(url: upper), .enroll(upper))
        let other = try XCTUnwrap(URL(string: "m5cet://room/abc"))
        XCTAssertEqual(DeepLink(url: other), .unsupported(other))
        XCTAssertNil(DeepLink(url: try XCTUnwrap(URL(string: "https://chat.example.com/enroll"))))
    }

    @MainActor
    func testModelKeepsALinkUntilTaken() throws {
        let model = AppModel()
        model.open(try XCTUnwrap(URL(string: "mailto:someone@example.com")))
        XCTAssertNil(model.pendingLink)
        let url = try XCTUnwrap(URL(string: "m5cet://enroll?server=chat.example.com"))
        model.open(url)
        XCTAssertEqual(model.takePendingLink(), .enroll(url))
        XCTAssertNil(model.takePendingLink())
    }

    // MARK: Info.plist

    func testUsageDescriptions() {
        let keys = ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription",
                    "NSLocationWhenInUseUsageDescription", "NSLocationAlwaysAndWhenInUseUsageDescription",
                    "NSContactsUsageDescription", "NSBluetoothAlwaysUsageDescription", "NFCReaderUsageDescription",
                    "NSFaceIDUsageDescription", "NSLocalNetworkUsageDescription", "NSPhotoLibraryAddUsageDescription"]
        for key in keys {
            XCTAssertFalse((info[key] as? String ?? "").isEmpty, key)
        }
        // Translated in every app language (InfoPlist.xcstrings → <lang>.lproj/InfoPlist.strings).
        for lang in ["en", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"] {
            let path = Bundle.main.path(forResource: "InfoPlist", ofType: "strings", inDirectory: nil, forLocalization: lang)
            let table = path.flatMap { NSDictionary(contentsOfFile: $0) as? [String: String] } ?? [:]
            for key in keys { XCTAssertFalse((table[key] ?? "").isEmpty, "\(lang): \(key)") }
        }
    }

    func testBackgroundModes() {
        let modes = Set(info["UIBackgroundModes"] as? [String] ?? [])
        XCTAssertEqual(modes, ["remote-notification", "voip", "audio", "fetch", "location", "processing"])
        XCTAssertEqual(info["BGTaskSchedulerPermittedIdentifiers"] as? [String], ["cz.m5cet.app.checkin"])
    }

    func testNFCApplications() throws {
        let aids = try XCTUnwrap(info["com.apple.developer.nfc.readersession.iso7816.select-identifiers"] as? [String])
        XCTAssertEqual(aids.first, "A0000002471001", "the e-ID first (Core NFC tries them in order; payment AIDs are refused on iPhone anyway)")
        for aid in ["A0000002471001", "D2760000850101", "A0000000031010", "A0000000041010", "A0000000043060",
                    "A00000002501", "A0000000651010", "A0000001523010", "A000000333010101"] {
            XCTAssertTrue(aids.contains(aid), aid)
        }
        XCTAssertEqual(Set(aids).count, aids.count, "no duplicates")
        for aid in aids {
            XCTAssertTrue(aid.count % 2 == 0 && (10...32).contains(aid.count) && aid.allSatisfy(\.isHexDigit) && aid == aid.uppercased(), aid)
        }
    }

    func testEncryptionIsDeclared() {
        XCTAssertEqual(info["ITSAppUsesNonExemptEncryption"] as? Bool, true)
    }

    func testIPadMultitasking() {
        XCTAssertNotEqual(info["UIRequiresFullScreen"] as? Bool, true)
        // The raw file: infoDictionary resolves "~ipad" keys for the device it runs on.
        let raw = NSDictionary(contentsOf: Bundle.main.bundleURL.appendingPathComponent("Info.plist")) as? [String: Any]
        XCTAssertEqual((raw?["UISupportedInterfaceOrientations~ipad"] as? [String])?.count, 4)
        let scenes = info["UIApplicationSceneManifest"] as? [String: Any]
        XCTAssertEqual(scenes?["UIApplicationSupportsMultipleScenes"] as? Bool, true)
    }

    // MARK: linked and embedded

    func testLinkedLibraries() {
        XCTAssertEqual(AppInfo.modules, ["M5Core", "M5Crypto", "M5Proto", "M5Net", "M5Design", "M5NFC"])
        XCTAssertEqual(AppInfo.webRTC, "RTCPeerConnectionFactory")
        let frameworks = Bundle.main.privateFrameworksURL?.appendingPathComponent("WebRTC.framework")
        XCTAssertTrue(FileManager.default.fileExists(atPath: frameworks?.path ?? ""), "WebRTC.framework embedded")
    }

    func testExtensionAndWatchAppAreEmbedded() throws {
        let appex = try XCTUnwrap(Bundle.main.builtInPlugInsURL).appendingPathComponent("M5cetNotifications.appex")
        let nse = try XCTUnwrap(Bundle(url: appex), "notification extension embedded")
        XCTAssertEqual(nse.bundleIdentifier, "cz.m5cet.app.notifications")
        XCTAssertEqual(nse.object(forInfoDictionaryKey: "CFBundleVersion") as? String, AppInfo.build)

        let watchURL = Bundle.main.bundleURL.appendingPathComponent("Watch/M5cetWatch.app")
        let watch = try XCTUnwrap(Bundle(url: watchURL), "watch app embedded")
        XCTAssertEqual(watch.bundleIdentifier, "cz.m5cet.app.watchkitapp")
        XCTAssertEqual(watch.object(forInfoDictionaryKey: "WKCompanionAppBundleIdentifier") as? String, "cz.m5cet.app")
        XCTAssertEqual(watch.object(forInfoDictionaryKey: "CFBundleVersion") as? String, AppInfo.build)
    }
}
