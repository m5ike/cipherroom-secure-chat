// Contract 3 for real (Renderer/README.md): where the app is and what each
// screen sees — the port of MainActivity.route's inputs and scopeFor's switch
// (android/…/ui/MainActivity.java). @Observable: everything it reads is
// observable (the rooms, the account, the lock's revision, the core's route
// revision, the parts' screen variables), so the renderer resolves a screen
// again whenever something it showed changed.

import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Net
import M5Proto
import Observation
import UIKit

@MainActor
@Observable
final class AppScreenState: ScreenStateProvider {
    @ObservationIgnored unowned let core: AppCore

    /// The enrolment form's error (enrollError) and the join form's (joinError) — the forms set them.
    var enrollError = ""
    var joinError = ""
    /// The splash's status line.
    var splashStatus = ""
    /// The lock pad's model while the lock screen shows (one for the app: the lock is the app's, every window shows it).
    private(set) var lockPad: LockPadModel?

    init(core: AppCore) { self.core = core }

    // MARK: - route (MainActivity.route)

    var routeState: AppRouteState {
        _ = core.routeRevision
        _ = core.security.lockRevision
        return AppRouteState(enrolled: core.device.enrolled, lockSetUp: core.security.isSetUp, locked: core.security.isLocked,
                             hasActiveRoom: core.rooms.activeController != nil, wipedNotice: core.security.wipedNotice)
    }

    var define: DesignValue { _ = core.routeRevision; return core.device.define }
    var account: DesignValue { core.account.scope }

    /// The lock pad for the screen now (setup until a PIN exists), made anew when the mode changes.
    func lockPadModel() -> LockPadModel? {
        let setup = !core.security.isSetUp
        if let p = lockPad, (p.mode == .setup) == setup { return p }
        lockPad = core.security.makeLockPad(setup: setup)
        return lockPad
    }

    /// The pad is gone (unlocked): its typed digits go with it.
    func dropLockPad() { lockPad?.clear(); lockPad = nil }

    // MARK: - variables (MainActivity.scopeFor)

    func variables(for screen: String, context: ScreenContext) -> [String: DesignValue] {
        variables(for: screen, context: context, host: nil)
    }

    /// The core's values of a screen, and over them what the parts registered (core.variables: $users, $profile,
    /// $ai, $nfc…) — a part's value wins (People owns $users of "room" and "call").
    func variables(for screen: String, context: ScreenContext, host: DesignHost?) -> [String: DesignValue] {
        var s = own(screen)
        for (k, v) in core.models.variables.values(for: screen, host: host) { s[k] = v }
        return s
    }

    private func own(_ screen: String) -> [String: DesignValue] {
        var s: [String: DesignValue] = [:]
        switch screen {
        case "splash":
            s["status"] = .string(splashStatus)
            s["busy"] = true
        case "lock":
            s["lock"] = lockScope()
        case "enroll":
            let server = core.hosts.first.flatMap { $0.form["server"]?.stringValue } ?? CoreConfig.defaultServer
            s["enroll"] = ["server": .string(server), "error": .string(enrollError)]
        case "rooms":
            let r = core.rooms
            s["rooms"] = r.scope
            s["selectedCount"] = .number(Double(r.selectedCount))
            s["connectedCount"] = .number(Double(r.connectedCount))
            s["unreadTotal"] = .number(Double(r.unreadTotal))
        case "join":
            s["error"] = .string(joinError)
        case "room", "call":
            let r = core.rooms.activeController
            s["room"] = roomScope(r)
            s["rooms"] = .array(core.rooms.connectedSessions.map { roomScope($0) })
            s["me"] = ["name": .string(r?.myName ?? core.userName)]
            // $users (the panel's state and list) is People's (core.variables "room" / "call" → "users").
            let call = r?.call ?? CallInfo()
            s["call"] = ["active": .bool(call.active), "mode": .string(call.video ? "video" : "audio"), "muted": .bool(call.muted),
                         "peers": .number(Double(max(0, (r?.userCount ?? 0) - 1)))]
        case "settings.user":
            s["keys"] = keysScope()
            s["connection"] = connectionScope()
        case "settings.voice", "voice", "dictate.options":
            s["voice"] = core.models.tools.voice
            s["voices"] = .array([])
        case "settings.location":
            let allowed = core.device.state?.policy.obj("location")?.bool("track", true) ?? true
            s["location"] = ["permitted": .bool(core.models.position?.permitted ?? false), "tracking": false, "allowed": .bool(allowed)]
        case "settings.security":
            var sec = core.security.securityScope(t: core.t).objectValue ?? [:]
            sec["ktAlert"] = .string(core.rooms.ktAlert)
            s["security"] = .object(sec)
        case "attach", "send.options":
            if let h = hostShowing(screen) { s["composer"] = core.models.composer(for: h).scope }
        case "tools":
            s["tools"] = core.models.tools.toolsScope
        case "call.options":
            s["call"] = ["active": .bool(core.rooms.activeController?.call.active ?? false)]
        case "nfc":
            s["room"] = roomScope(core.rooms.activeController)
        case "update":
            s["update"] = ["kind": "bundle", "version": "", "size": 0, "notes": "", "progress": 1, "state": "none"]
        case "about":
            let st = core.device.state
            s["device"] = ["id": .string(st?.deviceId ?? ""), "model": .string(CoreDeviceService.description(name: "").model)]
            s["server"] = ["url": .string(st?.server ?? ""), "kid": .string(st?.serverKid ?? ""), "fingerprint": .string(st?.serverFingerprint ?? "")]
        default:
            break
        }
        return s
    }

    /// The window that shows this screen or sheet (a sheet's $composer is its window's).
    private func hostShowing(_ screen: String) -> DesignHost? {
        core.hosts.first { $0.sheet?.screen == screen || $0.screen == screen } ?? core.hosts.first
    }

    /// $lock (MainActivity.setupLock / showLock): mode, setup, step, error, wait, attempts, left, biometricAvailable.
    private func lockScope() -> DesignValue {
        _ = core.security.lockRevision
        let f = core.security.lockFacts
        let setup = !core.security.isSetUp
        let pad = lockPad
        let step: String = switch pad?.step {
        case .confirm: "confirm"
        default: "enter"
        }
        let error = pad?.error.map { core.t($0) } ?? ""
        return ["mode": .string(!setup && f.biometricAvailable ? "biometric" : "pin"), "setup": .bool(setup), "step": .string(step), "error": .string(error),
                "wait": .number(Double(setup ? 0 : f.waitSeconds)), "attempts": .number(Double(f.attempts)), "left": .number(Double(setup ? f.maxAttempts : f.left)),
                "biometricAvailable": .bool(!setup && f.biometricAvailable), "pinLength": .number(Double(f.pinLength))]
    }

    /// MainActivity.roomScope.
    func roomScope(_ r: RoomController?) -> DesignValue {
        guard let r else { return ["key": "", "name": "", "users": 0, "unread": 0, "status": "offline", "connected": false] }
        return r.scope
    }

    /// The device, its key, the chat identity, the server's key (Settings › User › Keys).
    private func keysScope() -> DesignValue {
        var identity = "—"
        if let ci = core.security.chatIdentity(create: false) {
            let h = Crypto.hex(Crypto.sha256(((try? Crypto.unb64(ci.publicKey)) ?? []))).uppercased()
            let c = Array(h)
            if c.count >= 16 { identity = String(c[0..<4]) + " " + String(c[4..<8]) + " " + String(c[8..<12]) + " " + String(c[12..<16]) }
        }
        let st = core.device.state
        return ["device": .string(st?.deviceId ?? ""), "deviceKey": .string(core.deviceKid), "identity": .string(identity), "server": .string(st?.serverFingerprint ?? "")]
    }

    /// Settings › User › Connection (MainActivity.connectionScope).
    private func connectionScope() -> DesignValue {
        let joined = core.rooms.connectedCount
        return ["server": .string(core.device.server), "rooms": .number(Double(joined)), "status": .string(joined > 0 ? "joined" : "offline"),
                "push": .string(core.pushMode), "checkin": .number(Double(core.lastCheckin)), "protocol": 2,
                "crypto": "p4 (ML-KEM-768 + ECDH) · v3", "turn": .number(Double(core.iceCount)), "ktAlert": .string(core.rooms.ktAlert)]
    }
}
