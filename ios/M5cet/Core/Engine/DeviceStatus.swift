// This device and its server (android core/Config, push/Checkin, core/Define,
// ui/parts/Forms.Enroll's submit): enrolled or not, the server's origin, the
// signed policy (rooms.max, lock…), the check-in, $define (GET /api/define,
// cached in the system tier's "define" record like Android). Platform/Push owns
// the full device service (APNs tokens, check-in scheduling, signed commands,
// design bundles); until it is installed the core runs this one over M5Net's
// DeviceState / DeviceEnrollment / Checkin — the same records ("config",
// "define"), so the Push service takes over the state as it is.

import Foundation
import M5Core
import M5Design
import M5Net
import UIKit
import os

/// What the core needs of the device service.
@MainActor
protocol DeviceEnrolling: AnyObject {
    var enrolled: Bool { get }
    /// The server's origin ("" before the enrolment).
    var server: String { get }
    var state: DeviceState? { get }
    /// $define (m5mobile.define) — {} when none.
    var define: DesignValue { get }
    /// /api/ios/info, the pins, /enroll, the signed policy; throws with the server's message.
    func enroll(server: String, code: String, name: String, pinKid: String) async throws
    /// A check-in (policy, define); false when the server could not be reached.
    @discardableResult func checkIn(reason: String) async -> Bool
}

@MainActor
final class CoreDeviceService: DeviceEnrolling {
    private let security: any CoreSecurity
    private let client: DeviceAPIClient
    private(set) var state: DeviceState?
    private(set) var define: DesignValue = .object([:])
    /// The policy changed (rooms.max, the lock policy).
    var onPolicy: (@MainActor (DeviceState) -> Void)?
    private static let log = Logger(subsystem: "cz.m5cet.app", category: "device")

    init(security: any CoreSecurity, client: DeviceAPIClient = DeviceAPIClient()) {
        self.security = security
        self.client = client
    }

    var enrolled: Bool { state?.enrolled ?? false }
    var server: String { state?.server ?? "" }

    /// The stored state (system tier, readable while locked).
    func load() async {
        state = await DeviceState.load(from: security.systemState)
        if let doc = security.systemRecords.record("define"), let v = doc.object("values") { define = v.designValue }
    }

    static func description(name: String) -> DeviceDescription {
        let d = UIDevice.current
        var sys = utsname()
        uname(&sys)
        let model = withUnsafeBytes(of: &sys.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        return DeviceDescription(name: name.isEmpty ? d.name : name, model: model, modelName: d.model, idiom: d.userInterfaceIdiom == .pad ? "pad" : "phone",
                                 os: "iOS", osVersion: d.systemVersion, appVersion: AppInfo.version, appCode: Int(AppInfo.build) ?? 0,
                                 locale: Locale.preferredLanguages.first ?? "en", sdk: 0, manufacturer: "Apple")
    }

    func enroll(server: String, code: String, name: String, pinKid: String) async throws {
        let encKey = try security.encryptionKeySPKI()
        let st = try await DeviceEnrollment.enroll(base: server, code: code, device: Self.description(name: name), push: PushTokens(),
                                                   pins: [CoreConfig.serverKeyPin, pinKid.isEmpty ? nil : pinKid], signer: security.requestSigner,
                                                   encKey: encKey, client: client)
        await st.save(to: security.systemState)
        state = st
        Self.log.info("enrolled")
        onPolicy?(st)
        await refreshDefine()
    }

    @discardableResult
    func checkIn(reason: String) async -> Bool {
        guard var st = state, st.enrolled else { return false }
        do {
            let creds = try DeviceEnrollment.credentials(st, signer: security.requestSigner)
            let body = Checkin.body(device: Self.description(name: ""), status: DeviceStatusReport(locked: security.isLocked), push: PushTokens(), config: .ios)
            let answer = try await client.checkin(creds, body: body)
            _ = st.apply(serverAnswer: answer)
            await st.save(to: security.systemState)
            state = st
            onPolicy?(st)
        } catch {
            Self.log.notice("check-in failed: \(String(describing: error), privacy: .public)")
            return false
        }
        await refreshDefine()
        return true
    }

    /// GET /api/define?scope=ios → { ok, values, updatedAt }; the cached copy stays on any failure.
    func refreshDefine() async {
        guard let base = state?.server, !base.isEmpty, let url = URL(string: base + "/api/define?scope=ios") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let o = JSON.parseObject(String(decoding: data, as: UTF8.self)), o.bool("ok") == true, let v = o.object("values") else { return }
            define = v.designValue
            security.systemRecords.put("define", JSONObject([("values", .object(v)), ("updatedAt", .int(o.optInt64("updatedAt")))]))
        } catch {
            Self.log.debug("define: not now")
        }
    }
}
