// 6.8: the History screen ("log", server/android/design-68-calllog.ts) — a
// port of android/…/ui/parts/CallLogUi.java: $log and the calllog.* actions.
// The design draws the screen; Platform/Calls has the list's logic
// (CallLogItems: collect, filter, search, days, lengths) and the call history
// (AppCallHistory). The native CallHistoryView of Parts/Calls is another way to
// show the same list; this is the design's.
//
// The list is gathered when the screen opens and kept while it is open; the
// filter ($form.logFilter) and the search ($form.logQuery) apply to it on every
// draw. The screen is one of the app's like any other: behind the app lock, and
// it shows nothing a room would not show (a sealed or hidden message only by
// its kind). Locked: what was gathered leaves the memory (forget).
//
// iOS: there is no system call log to erase (calllog.system) — CallKit's
// Recents belong to the Phone app; the iOS design hides that row
// (server/ios/design.ts IOS_LIMITS), the action does nothing here.

import Foundation
import M5Core
import M5Design
import M5Proto
import Observation
import UIKit
import os

@MainActor
@Observable
final class ToolsCallLog {
    static let shared = ToolsCallLog()
    static let log = Logger(subsystem: "cz.m5cet.app", category: "calllog")

    private(set) var all: [CallLogItems.Item] = []
    /// The list was gathered (and the app not locked since).
    private(set) var fresh = false
    private(set) var loading = false
    @ObservationIgnored private var generation = 0
    /// The window that showed the History last ($form.logFilter / logQuery are its).
    @ObservationIgnored weak var host: DesignHost?

    /// The rooms' messages (the room sessions; nil: the connected rooms of the core, in memory).
    @ObservationIgnored var messages: (any CallLogMessageSource)?
    /// The calls kept (Platform/Calls).
    @ObservationIgnored var history: () -> AppCallHistory = { CallSystem.shared.history }
    @ObservationIgnored var core: () -> CoreModels = { CoreModels.shared }
    @ObservationIgnored var now: () -> Int64 = { EpochMs.now }
    @ObservationIgnored var timeZone: TimeZone = .current
    /// The confirmations (UIKit alerts in the app; the tests answer them).
    @ObservationIgnored var confirm: @MainActor (_ message: String, _ choices: [(String, Bool)], _ cancel: String, _ picked: @escaping (Int) -> Void) -> Void = ToolsCallLog.alert

    // MARK: actions

    static let actions = ["calllog.open", "calllog.refresh", "calllog.item", "calllog.call", "calllog.clear", "calllog.system"]

    func run(_ action: String, _ arg: String, host: DesignHost) {
        switch action {
        case "calllog.open": open(host)
        case "calllog.refresh": host.refresh()
        case "calllog.item": item(arg, host: host)
        case "calllog.call": call(arg, host: host)
        case "calllog.clear": clear(host)
        case "calllog.system": Self.log.notice("calllog.system: iOS has no system call log an app may erase")
        default: break
        }
    }

    func open(_ host: DesignHost) {
        if host.form["logFilter"] == nil { host.form["logFilter"] = "all" }
        load(host)
        host.showScreen("log")
    }

    /// Gathers the list again (the calls kept, every saved room's messages).
    func load(_ host: DesignHost?) {
        loading = true
        generation += 1
        let g = generation
        let source = messages ?? CoreCallLogSource(core: core(), now: now)
        let list = CallLogItems.collect(history: history(), messages: source)
        // (Gathered here at once: the rooms' messages are in memory; the calls are one vault record.)
        guard g == generation else { return }
        all = list
        loading = false
        fresh = true
        if host?.screen == "log" { host?.refresh() }
    }

    /// Locked or wiped: what was gathered (calls, every room's messages) does not stay in memory.
    func forget() {
        all = []
        generation += 1
        loading = false
        fresh = false
    }

    // MARK: $log

    /// The newest this many go to the screen (a list of the design draws 200 at most).
    nonisolated static let shownMax = 200

    /// $log: the entries of the filter and search, newest first (at most 200), each with its day.
    func scope(host: DesignHost) -> DesignValue {
        if !fresh && !loading { load(nil) } // opened another way than calllog.open (a design's screen.open)
        let filter = CallLogItems.Filter(rawValue: host.form["logFilter"].map(Expr.toText) ?? "all") ?? .all
        let query = host.form["logQuery"].map(Expr.toText) ?? ""
        let t = host.translator
        return Self.scope(all: all, filter: filter, query: query, loading: loading, history: host.settings.bool("calls.history"),
                          now: now(), timeZone: timeZone, lang: host.services.lang, t: { t.t($0) })
    }

    nonisolated static func scope(all: [CallLogItems.Item], filter: CallLogItems.Filter, query: String, loading: Bool, history: Bool,
                                  now: Int64, timeZone: TimeZone, lang: String, t: (String) -> String) -> DesignValue {
        let list = CallLogItems.filter(all, filter, query: query)
        var items = [DesignValue]()
        var lastDay = -1
        for it in list.prefix(shownMax) {
            let d = CallLogItems.daysAgo(it.at, now: now, timeZone: timeZone)
            let day = d == 0 ? t("log.today") : d == 1 ? t("log.yesterday") : dayText(it.at, lang: lang, timeZone: timeZone)
            items.append(item(it, day: day, newDay: d != lastDay, t: t))
            lastDay = d
        }
        return ["loading": .bool(loading && all.isEmpty), "empty": .bool(list.isEmpty), "count": .number(Double(list.count)),
                "shown": .number(Double(min(shownMax, list.count))), "more": .bool(list.count > shownMax), "history": .bool(history),
                "items": .array(items)]
    }

    /// "5. 10. 2026" in the app's language (DateFormat.MEDIUM of its locale).
    nonisolated static func dayText(_ at: Int64, lang: String, timeZone: TimeZone) -> String {
        var style = Date.FormatStyle(date: .abbreviated, time: .omitted).locale(Locale(identifier: lang))
        style.timeZone = timeZone
        return Date(timeIntervalSince1970: Double(at) / 1000).formatted(style)
    }

    nonisolated static func item(_ it: CallLogItems.Item, day: String, newDay: Bool, t: (String) -> String) -> DesignValue {
        let people = it.people.joined(separator: ", ")
        return ["id": .string(it.id), "type": .string(it.type), "dir": .string(it.dir), "what": .string(it.what), "room": .string(it.room),
                "people": .string(people), "time": .number(Double(it.at)), "day": .string(day), "newDay": .bool(newDay),
                "seconds": .number(Double(it.seconds)), "length": .string(CallLogItems.length(it.seconds)), "video": .bool(it.video),
                "preview": .string(it.preview), "detail": .string(it.isCall ? callDetail(it, people, t) : messageDetail(it, people, t)),
                "icon": .string(icon(it)), "color": .string(color(it)), "callable": .bool(it.isCall && it.saved)]
    }

    /// "Incoming · video · 12:04 · Alice, Bob"
    nonisolated static func callDetail(_ it: CallLogItems.Item, _ people: String, _ t: (String) -> String) -> String {
        var s = t("log.dir." + it.dir)
        if it.video { s += " · " + t("log.video") }
        let len = CallLogItems.length(it.seconds)
        if !len.isEmpty { s += " · " + len }
        if !people.isEmpty { s += " · " + people } else if it.dir == CallTrack.Kind.outgoing.rawValue { s += " · " + t("log.nobody") }
        return s
    }

    /// "Alice: the text" / "Me → Bob: …" — a sealed, hold-to-read, vanishing or hidden one only by its kind.
    nonisolated static func messageDetail(_ it: CallLogItems.Item, _ people: String, _ t: (String) -> String) -> String {
        let who = it.dir == "out" ? t("log.me") + (people.isEmpty ? "" : " → " + people) : people
        let what: String
        switch it.what {
        case "text", "fn": what = it.preview
        case "file": what = "📎 " + it.preview
        default: what = t("log.kind." + it.what)
        }
        return who.isEmpty ? what : who + ": " + what
    }

    /// The design's (lucide) icon of an entry.
    nonisolated static func icon(_ it: CallLogItems.Item) -> String {
        let out = it.dir == "out"
        if it.isCall {
            let gone = it.dir == CallTrack.Kind.missed.rawValue || it.dir == CallTrack.Kind.declined.rawValue
            if it.video { return gone ? "video-off" : "video" }
            return gone ? "phone-off" : out ? "phone-outgoing" : "phone"
        }
        switch it.what {
        case "sealed": return "message-square-lock"
        case "tap": return "eye"
        case "vanish": return "timer"
        case "hidden": return "eye-off"
        case "file": return "paperclip"
        case "fn": return "terminal"
        default: return out ? "send-horizontal" : "message-circle"
        }
    }

    nonisolated static func color(_ it: CallLogItems.Item) -> String {
        if it.dir == CallTrack.Kind.missed.rawValue { return "@danger" }
        if it.dir == CallTrack.Kind.declined.rawValue { return "@muted" }
        if it.isCall { return it.dir == "out" ? "@primary" : "@success" }
        return it.dir == "out" ? "@primary" : "@muted"
    }

    private func find(_ id: String) -> CallLogItems.Item? { all.first { $0.id == id } }

    private func savedRoom(_ key: String) -> Bool { core().rooms.saved(key) != nil || core().rooms.room(key) != nil }

    // MARK: entries

    /// An entry's room (a message: the room scrolls to it).
    func item(_ id: String, host: DesignHost) {
        guard let it = find(id) else { return }
        guard it.saved, savedRoom(it.roomKey) else { host.flash(title: "", text: host.translator.t("log.gone"), level: .warn); return }
        let rooms = core().rooms
        rooms.switchTo(it.roomKey)
        host.showScreen("room")
        if it.type == CallLogItems.msg {
            // The room's messages may still be on their way from the vault.
            let msgId = it.msgId, key = it.roomKey
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(300))
                if let r = rooms.room(key) {
                    if r.message(msgId) == nil { try? await Task.sleep(for: .milliseconds(900)) }
                    r.revealRequest = msgId
                }
            }
        }
    }

    /// Calls an entry's room again — only after the person confirms it (everyone connected there hears the call).
    func call(_ id: String, host: DesignHost) {
        guard let it = find(id) else { return }
        guard it.saved, savedRoom(it.roomKey) else { host.flash(title: "", text: host.translator.t("log.gone"), level: .warn); return }
        let t = host.translator
        confirm(t.t("log.callAsk").replacingOccurrences(of: "{room}", with: it.room),
                [(t.t("log.call.audio"), false), (t.t("log.call.video"), false)], t.t("nav.close")) { [weak self, weak host] i in
            guard let self, let host else { return }
            self.dial(it.roomKey, video: i == 1, host: host)
        }
    }

    private func dial(_ roomKey: String, video: Bool, host: DesignHost) {
        core().rooms.switchTo(roomKey)
        host.showScreen("room")
        // The call itself is the core's (call.audio / call.video: permissions, CallKit).
        host.runner.runFromApp(video ? "call.video" : "call.audio", value: nil)
    }

    /// Deletes the app's call history (asked first).
    func clear(_ host: DesignHost) {
        let t = host.translator
        confirm(t.t("log.clearAsk"), [(t.t("log.clear"), true)], t.t("nav.close")) { [weak self, weak host] _ in
            guard let self, let host else { return }
            self.history().clear()
            host.flash(title: "", text: host.translator.t("log.cleared"), level: .success)
            self.load(host)
        }
    }

    /// A UIKit alert (Android's AlertDialog): the message, the choices, a cancel.
    static func alert(_ message: String, _ choices: [(String, Bool)], _ cancel: String, _ picked: @escaping (Int) -> Void) {
        guard let top = ToolsSheets.top() else { return }
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        for (i, c) in choices.enumerated() {
            a.addAction(UIAlertAction(title: c.0, style: c.1 ? .destructive : .default) { _ in picked(i) })
        }
        a.addAction(UIAlertAction(title: cancel, style: .cancel))
        top.present(a, animated: true)
    }
}

/// The History's messages from the core: the saved rooms, and the messages of the connected ones (in memory).
/// A room that is not connected shows only its calls until the core lends its history (Core request).
@MainActor
final class CoreCallLogSource: CallLogMessageSource {
    private let core: CoreModels
    private let now: () -> Int64

    init(core: CoreModels, now: @escaping () -> Int64) {
        self.core = core
        self.now = now
    }

    func savedRooms() -> [CallLogRoom] { core.rooms.items.map { CallLogRoom(key: $0.key, label: $0.name) } }

    func messages(ofRoom roomKey: String) -> [CallLogRoomMessage] {
        guard let r = core.rooms.room(roomKey) else { return [] }
        let n = now()
        return r.messages.map { Self.message($0, now: n) }
    }

    /// A chat message as the log may look at it (ActivityLog.message's inputs); a hide until the unlock counts as hidden.
    static func message(_ m: ChatMessage, now: Int64) -> CallLogRoomMessage {
        var x = CallLogItems.Message(id: m.id, createdAt: m.createdAt, mine: m.mine, senderName: m.senderName, text: m.text)
        x.to = m.to
        x.kind = m.kind
        x.deleted = m.deleted
        x.expired = m.expired(now)
        x.sealed = m.sealed != nil
        x.tap = m.tap
        x.vanishing = m.vanishSeconds > 0 || m.vanished
        x.fileName = m.fileName
        x.fnKeyword = m.fn.map { $0.optString("keyword") }
        let hidden = m.hiddenUntil == ChatMessage.untilSignIn || m.hiddenUntil > now
        return CallLogRoomMessage(message: x, hidden: hidden)
    }
}
