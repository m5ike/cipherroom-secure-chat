// DEBUG only: a snapshot as the iPhone would send it (the console's sample rooms, Czech strings), for SwiftUI
// previews and screenshots without an iPhone —
//   -M5WatchSample ok|locked|off|away     start with it instead of WatchConnectivity
// e.g. xcrun simctl launch <watch udid> cz.m5cet.app.watchkitapp -M5WatchSample ok
// Compiled out of Release.

#if DEBUG
import Foundation

enum WatchSample {
    /// The launch argument's state, nil without it.
    static var requested: String? { UserDefaults.standard.string(forKey: "M5WatchSample").flatMap { $0.isEmpty ? nil : $0 } }

    static func snapshot(now: Int64, state: WatchState = .ok, expired: Bool = false) -> WatchSnapshot {
        let strings: [String: String] = [
            "app": "M5cet", "rooms.title": "Místnosti", "notify.message": "Nová zpráva", "notify.reply": "Odpovědět",
            "notify.markRead": "Přečteno", "room.connecting": "Připojuji…", "watch.open": "Otevřít v iPhonu",
            "watch.write": "Diktovat nebo psát…", "watch.quick": "Rychlé odpovědi", "watch.locked": "Zamčeno v iPhonu",
            "watch.locked.hint": "Odemkněte M5cet v iPhonu a místnosti se tu ukážou.", "log.kind.sealed": "Zapečetěná zpráva",
            "attach.file": "Soubor", "attach.position": "Poloha", "log.kind.tap": "Zpráva „podržte a čtěte“",
            "log.kind.vanish": "Mizející zpráva",
        ]
        let quick = ["OK", "Ano", "Ne", "Jsem na cestě", "Napíšu později"]
        guard state == .ok else {
            return WatchSnapshot(epoch: "samplegeneration", seq: 1, at: now, exp: 0, state: state, reason: state == .off ? "off" : "lock",
                                 lang: "cs", strings: strings, quick: quick, unread: 0, rooms: [])
        }
        var t = now - 9 * 60_000
        func m(_ id: String, _ kind: String, _ text: String, from: String = "Alice", mine: Bool = false, status: String = "") -> WatchMessage {
            t += 60_000
            return WatchMessage(id: id, kind: kind, sender: mine ? "" : from, mine: mine, at: t, text: text, status: mine ? status : "")
        }
        let team = [
            m("m1", WatchKind.text, "Ahoj, jak to jde?"),
            m("m2", WatchKind.text, "Dobře, díky! Posílám plán na zítřek.", mine: true, status: "read"),
            m("m3", WatchKind.file, "", from: "Bob"),
            m("m4", WatchKind.location, ""),
            m("m5", WatchKind.sealed, "", mine: true, status: "delivered"),
            m("m6", WatchKind.tap, ""),
            m("m7", WatchKind.vanish, "", from: "Bob"),
            m("m9", WatchKind.text, "Super, jdu na to 👍"),
        ]
        let rooms = [
            WatchRoom(id: "rsampleteam", name: "Tým", unread: 2, status: "joined", at: t, preview: "Alice: Super, jdu na to 👍", reply: true, messages: team),
            WatchRoom(id: "rsamplefamily", name: "Rodina", unread: 0, status: "connecting", at: t - 3_600_000, preview: "", reply: true, messages: []),
            WatchRoom(id: "rsamplework", name: "Práce", unread: 0, status: "saved", at: 0, preview: "", reply: false, messages: nil),
        ]
        return WatchSnapshot(epoch: "samplegeneration", seq: 1, at: now, exp: expired ? now - 1 : now + WatchWire.lifetimeMs, state: .ok, reason: "",
                             lang: "cs", strings: strings, quick: quick, unread: 2, rooms: rooms)
    }
}
#endif
