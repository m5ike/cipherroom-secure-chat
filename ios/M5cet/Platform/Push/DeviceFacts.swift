// What this device says about itself at enrolment and check-in (Android
// net/Server.enroll's fields, push/Checkin.state): the model, the system, the
// app's build, the battery, the network, the lock, the permissions — and which
// APNs environment its tokens belong to (the aps-environment entitlement).

import AVFoundation
import Foundation
import LocalAuthentication
import M5Net
import Network
import UIKit
import UserNotifications

/// The device's side of /enroll and /checkin.
@MainActor
protocol DeviceFactsProviding: AnyObject {
    /// The enrolment's / check-in's description (`name`: what the person typed; nil: the device's).
    func description(name: String?) -> DeviceDescription
    /// The check-in's state report.
    func status(bundle: NetJSON?, push: String, policyAt: Millis) -> DeviceStatusReport
    /// "sandbox" or "production" — the APNs environment the tokens are for (the server's names).
    var apnsEnvironment: String { get }
}

/// The aps-environment of this build: the provisioning profile's entitlement (development / production);
/// none (App Store, TestFlight) is production; the simulator and an unsigned build are development.
/// The server's names are "sandbox" and "production" (server/ios/routes.ts apnsEnvOf drops anything else).
enum ApnsEnvironment {
    static func entitlement(bundle: Bundle = .main) -> String {
        #if targetEnvironment(simulator)
        return "development"
        #else
        guard let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision"), let data = try? Data(contentsOf: url) else {
            return "production"
        }
        return fromProvision(data) ?? "production"
        #endif
    }

    /// The aps-environment inside a provisioning profile (a CMS envelope around a plist).
    static func fromProvision(_ data: Data) -> String? {
        let text = String(decoding: data, as: UTF8.self)
        guard let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>", range: start.upperBound..<text.endIndex) else { return nil }
        let xml = Data(text[start.lowerBound..<end.upperBound].utf8)
        guard let plist = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any],
              let ents = plist["Entitlements"] as? [String: Any] else { return nil }
        return ents["aps-environment"] as? String
    }

    /// The wire value: development → "sandbox".
    static func wire(_ entitlement: String) -> String { entitlement == "production" ? "production" : "sandbox" }
}

@MainActor
final class SystemDeviceFacts: DeviceFactsProviding {
    private let monitor = NWPathMonitor()
    private var path: NWPath?
    /// The app's lock (Platform/Security), nil before it is installed.
    var lock: () -> AppLock? = { SecurityCenter.shared?.lock }
    /// How many rooms are connected (the room session sets it).
    var rooms: () -> Int = { 0 }
    /// The app's language (the design's), else the device's among the nine.
    var language: () -> String = { NeutralTexts.deviceLanguage }
    /// Where the app's data lives (its size is reported).
    var dataDirs: () -> [URL] = { SecurityCenter.shared.map { [$0.paths.root, $0.paths.shared] } ?? [] }
    private var notificationsAllowed = false

    init() {
        monitor.pathUpdateHandler = { [weak self] p in Task { @MainActor in self?.path = p } }
        monitor.start(queue: DispatchQueue(label: "cz.m5cet.app.network"))
        UIDevice.current.isBatteryMonitoringEnabled = true
        refreshPermissions()
    }

    func refreshPermissions() {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] s in
            let ok = s.authorizationStatus == .authorized || s.authorizationStatus == .provisional || s.authorizationStatus == .ephemeral
            Task { @MainActor in self?.notificationsAllowed = ok }
        }
    }

    var apnsEnvironment: String { ApnsEnvironment.wire(ApnsEnvironment.entitlement()) }

    /// Not a metered or constrained network (the policy's update.wifiOnly).
    var unmetered: Bool {
        guard let p = path else { return true }
        return !p.isExpensive && !p.isConstrained
    }

    static var modelIdentifier: String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim }
        var u = utsname()
        uname(&u)
        return withUnsafeBytes(of: &u.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }

    static var idiom: String {
        switch UIDevice.current.userInterfaceIdiom {
        case .pad: "pad"
        case .mac: "mac"
        case .vision: "vision"
        case .tv: "tv"
        default: "phone"
        }
    }

    func description(name: String?) -> DeviceDescription {
        let d = UIDevice.current
        let n = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return DeviceDescription(name: n.isEmpty ? d.name : n, model: Self.modelIdentifier, modelName: d.model, idiom: Self.idiom,
                                 os: d.systemName, osVersion: d.systemVersion, appVersion: AppInfo.version, appCode: Int(AppInfo.build) ?? 0,
                                 locale: language())
    }

    func status(bundle: NetJSON?, push: String, policyAt: Millis) -> DeviceStatusReport {
        let d = UIDevice.current
        let level = d.batteryLevel
        let lock = lock()
        let network: String
        if let p = path, p.status == .satisfied {
            network = p.usesInterfaceType(.wifi) ? "wifi" : p.usesInterfaceType(.cellular) ? "cellular" : p.usesInterfaceType(.wiredEthernet) ? "ethernet" : "other"
        } else {
            network = path == nil ? "other" : "none"
        }
        refreshPermissions()
        var perms: [String] = []
        if notificationsAllowed { perms.append("POST_NOTIFICATIONS") }
        if AVAudioApplication.shared.recordPermission == .granted { perms.append("RECORD_AUDIO") }
        if AVCaptureDevice.authorizationStatus(for: .video) == .authorized { perms.append("CAMERA") }
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        let biometry = switch context.biometryType {
        case .faceID: "faceID"
        case .touchID: "touchID"
        case .opticID: "opticID"
        default: "none"
        }
        let lockMode = lock.map { $0.biometricAvailable ? "biometric" : $0.isSetUp ? "pin" : "none" } ?? "none"
        return DeviceStatusReport(battery: level < 0 ? -1 : Int((level * 100).rounded()), charging: d.batteryState == .charging || d.batteryState == .full,
                                  network: network, locked: lock?.isLocked ?? false, rooms: rooms(), bundle: bundle, push: push, lockMode: lockMode,
                                  failedAttempts: lock?.attempts ?? 0, storage: dataDirs().reduce(0) { $0 + Self.size(of: $1) }, permissions: perms,
                                  policyAt: policyAt, biometry: biometry)
    }

    /// A folder's size in bytes (Android Checkin.folderSize).
    static func size(of url: URL) -> Int64 {
        guard let e = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) else { return 0 }
        var n: Int64 = 0
        for case let f as URL in e {
            if let v = try? f.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]), v.isRegularFile == true { n += Int64(v.fileSize ?? 0) }
        }
        return n
    }
}
