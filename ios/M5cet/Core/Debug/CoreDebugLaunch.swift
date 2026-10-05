// DEBUG only: drive the real app on a simulator without taps (screenshots against
// a local dev server, docs). Compiled out of Release.
//
//   -M5CoreServer http://127.0.0.1:5871     enrol with this server (open enrolment) when not enrolled
//   -M5CorePin 123456                       set the PIN up, or unlock with it
//   -M5CoreJoin "Room|passphrase|Name"       join the room and show it
//   -M5CoreScreen <screen>                   then show this screen of the design instead (rooms, settings.notify…)
//   -M5CoreSaved "Room2|pass|Name;Room3|…"   more saved rooms (not connected)
//   -M5CoreBot "Alice|hello;how are you"     a second person in this process: joins the same room on the same
//                                            server (its own memory stores, real WebRTC to the app) and says these
//   -M5CoreSay "text;text"                   the app's user says these once the bot is there
//
// e.g. xcrun simctl launch <udid> cz.m5cet.app -M5CoreServer http://127.0.0.1:5871 -M5CorePin 123456 \
//        -M5CoreJoin "Team|team passphrase|Mike" -M5CoreBot "Alice|Ahoj!;Jak to jde?" -M5CoreSay "Dobře, díky"

#if DEBUG
import Foundation
import M5Core
import M5Crypto
import M5Design
import M5Net
import M5Proto
import os

@MainActor
enum CoreDebugLaunch {
    private static var args: UserDefaults { .standard }
    private static func arg(_ k: String) -> String? { args.string(forKey: k).flatMap { $0.isEmpty ? nil : $0 } }
    private static let log = Logger(subsystem: "cz.m5cet.app", category: "debug")
    private static var bot: AppCore?

    static var active: Bool { arg("M5CoreServer") != nil || arg("M5CorePin") != nil || arg("M5CoreJoin") != nil }

    static func run(_ core: AppCore) async {
        guard active else { return }
        for _ in 0..<100 where core.hosts.isEmpty { try? await Task.sleep(for: .milliseconds(50)) }
        if let server = arg("M5CoreServer"), !core.device.enrolled {
            do { try await core.device.enroll(server: server, code: "", name: "iPhone simulator", pinKid: "") } catch { log.error("enrol: \(String(describing: error), privacy: .public)") }
            await core.start()
        }
        if let pin = arg("M5CorePin"), let lock = SecurityCenter.shared?.lock {
            if !lock.isSetUp { try? await lock.setUp(pin: pin) } else if lock.isLocked { _ = await lock.unlock(pin: pin) }
            core.routeChanged()
        }
        // Still locked (another PIN set up here): the automation stops — the lock screen stays.
        if SecurityCenter.shared?.lock.isLocked ?? false {
            log.error("still locked: the automation stops")
            return
        }
        try? await Task.sleep(for: .milliseconds(800))
        for spec in (arg("M5CoreSaved") ?? "").split(separator: ";") {
            let p = spec.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            if p.count >= 3 { core.rooms.add(p[0], passphrase: p[1], userName: p[2]); core.rooms.toggleSelected(RoomKeys.normalizeRoom(p[0])) }
        }
        guard let join = arg("M5CoreJoin") else {
            if let s = arg("M5CoreScreen") { core.hosts.first?.showScreen(s) }
            return
        }
        let p = join.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard p.count >= 3 else { return }
        let key = core.rooms.join(room: p[0], passphrase: p[1], userName: p[2])
        if let h = core.hosts.first { h.showScreen(arg("M5CoreScreen") ?? "room") }
        if let b = arg("M5CoreBot") { await startBot(b, room: p[0], passphrase: p[1], server: core.device.server, key: key, core: core) }
    }

    /// A second person in this process (memory stores, its own hub socket, real WebRTC to the app's room).
    private static func startBot(_ spec: String, room: String, passphrase: String, server: String, key: String, core: AppCore) async {
        let parts = spec.split(separator: "|", maxSplits: 1).map(String.init)
        let name = parts.first ?? "Alice"
        let lines = parts.count > 1 ? parts[1].split(separator: ";").map(String.init) : []
        let suite = "cz.m5cet.debug.bot"
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        let botCore = AppCore(security: MemorySecurity(), device: BotDevice(server: server), services: DesignServices(store: SettingsStore(defaults: d)),
                              wires: DirectRtcWires(), fileStore: MemoryFileStore(), passkeys: SystemPasskeys())
        bot = botCore
        _ = botCore.rooms.join(room: room, passphrase: passphrase, userName: name)
        // Wait for the channel between the two.
        for _ in 0..<300 {
            if botCore.rooms.controller(key)?.peers.isEmpty == false, core.rooms.controller(key)?.peers.isEmpty == false { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        try? await Task.sleep(for: .milliseconds(1500))
        for line in lines {
            botCore.rooms.controller(key)?.sendText(line)
            try? await Task.sleep(for: .milliseconds(900))
        }
        for line in (arg("M5CoreSay") ?? "").split(separator: ";").map(String.init) {
            if let host = core.hosts.first {
                let c = core.models.composer(for: host)
                if let last = core.rooms.controller(key)?.messages.last(where: { !$0.mine && $0.kind == "text" }), line.hasPrefix("^") {
                    c.setReply(last.id)
                    c.text = String(line.dropFirst())
                } else {
                    c.text = line
                }
                c.send()
            }
            try? await Task.sleep(for: .milliseconds(900))
        }
    }
}

/// The bot's device: enrolled with the same server.
@MainActor
private final class BotDevice: DeviceEnrolling {
    let server: String
    init(server: String) { self.server = server }
    var enrolled: Bool { true }
    var state: DeviceState? { DeviceState(server: server, deviceId: "bot", serverKey: "k") }
    var define: DesignValue { .object([:]) }
    var prefill: (server: String, code: String, kid: String, seq: Int)? { nil }
    var suggestedServer: String { server }
    func enroll(server: String, code: String, name: String, pinKid: String) async throws {}
    func checkIn(reason: String) async -> Bool { true }
    func takeLinkNotice(t: (String) -> String) -> (text: String, level: FlashLevel)? { nil }
}

/// RoomRtc without CallSystem (no CallKit, no call screen) — the bot's WebRTC side.
@MainActor
final class DirectRtcWires: RoomWireFactory {
    private var links: [String: RtcLinkAdapter] = [:]
    private var rooms: [String: RoomRtc] = [:]

    func attach(roomKey: String, label: String, controller: RoomController) -> any RoomWire {
        let link = RtcLinkAdapter()
        link.controller = controller
        let rtc = RoomRtc(roomKey: roomKey, label: label)
        rtc.link = link
        links[roomKey] = link
        rooms[roomKey] = rtc
        return RtcWire(rtc: rtc)
    }

    func detach(roomKey: String) {
        rooms.removeValue(forKey: roomKey)?.destroy()
        links[roomKey] = nil
    }
}
#endif
