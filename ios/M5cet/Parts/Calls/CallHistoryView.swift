// 6.8: the History screen ("log") — calls and messages of every room, newest
// first, by day; filters all / calls / messages / missed; a search without
// case or accents; a tap opens the room (a message: scrolled to it), the phone
// button calls the room again after a confirmation (everyone connected there
// hears the call). Port of android/app/src/main/java/cz/m5cet/app/ui/parts/
// CallLogUi.java. The list is gathered when the screen opens and kept while it
// is open; it shows nothing a room would not show (a sealed or hidden message
// only by its kind). The screen is behind the app lock like any other.

import SwiftUI

struct CallHistoryView: View {
    var system: CallSystem = .shared
    var messages: (any CallLogMessageSource)?
    var environment: (any CallEnvironment)?
    /// Opens a room (and, for a message, the message's id to scroll to).
    var onOpenRoom: (_ roomKey: String, _ messageId: String?) -> Void = { _, _ in }

    @Environment(\.horizontalSizeClass) private var widthClass
    @State private var all: [CallLogItems.Item] = []
    @State private var loaded = false
    @State private var filter: CallLogItems.Filter = .all
    @State private var query = ""
    @State private var callAsk: CallLogItems.Item?
    @State private var clearAsk = false
    @State private var notice: String?

    private func t(_ key: String) -> String { CallTexts.t(key, environment) }

    var body: some View {
        let shown = CallLogItems.filter(all, filter, query: query)
        List {
            Section {
                Picker(selection: $filter) {
                    ForEach(CallLogItems.Filter.allCases, id: \.self) { f in
                        Text(verbatim: t("log.filter." + f.rawValue)).tag(f)
                    }
                } label: { EmptyView() }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("log.filter")
                if !(environment?.callSettings.history ?? true) {
                    Text(verbatim: t("log.historyOff")).font(.footnote).foregroundStyle(.secondary)
                }
                if let notice {
                    Text(verbatim: notice).font(.footnote).foregroundStyle(.secondary)
                }
            }
            if !loaded {
                Text(verbatim: t("log.loading")).foregroundStyle(.secondary)
            } else if shown.isEmpty {
                Text(verbatim: t(all.isEmpty ? "log.empty" : "log.noMatch")).foregroundStyle(.secondary)
                    .accessibilityIdentifier("log.empty")
            } else {
                ForEach(days(Array(shown.prefix(CallLogItems.shown))), id: \.day) { group in
                    Section(group.title) {
                        ForEach(group.items) { item in row(item) }
                    }
                }
                if shown.count > CallLogItems.shown {
                    Text(verbatim: t("log.limit")).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.horizontal, widthClass == .regular ? 72 : 0, for: .scrollContent)
        .searchable(text: $query, prompt: Text(verbatim: t("log.search")))
        .navigationTitle(Text(verbatim: t("log.title")))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button(role: .destructive) { clearAsk = true } label: { Text(verbatim: t("log.clear")) }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityIdentifier("log.menu")
            }
        }
        .task { reload() }
        .refreshable { reload() }
        .onDisappear {
            // Nothing of the gathered list stays in memory once the screen goes (Android: forget on lock).
            all = []
            loaded = false
        }
        .confirmationDialog(Text(verbatim: t("log.callAsk").replacingOccurrences(of: "{room}", with: callAsk?.room ?? "")),
                            isPresented: Binding(get: { callAsk != nil }, set: { if !$0 { callAsk = nil } }),
                            titleVisibility: .visible, presenting: callAsk) { item in
            Button { dial(item, video: false) } label: { Text(verbatim: t("log.call.audio")) }
            Button { dial(item, video: true) } label: { Text(verbatim: t("log.call.video")) }
            Button(role: .cancel) {} label: { Text(verbatim: t("nav.close")) }
        }
        .confirmationDialog(Text(verbatim: t("log.clearAsk")), isPresented: $clearAsk, titleVisibility: .visible) {
            Button(role: .destructive) {
                system.history.clear()
                notice = t("log.cleared")
                reload()
            } label: { Text(verbatim: t("log.clear")) }
            Button(role: .cancel) {} label: { Text(verbatim: t("nav.close")) }
        }
    }

    private func reload() {
        all = CallLogItems.collect(history: system.history, messages: messages)
        loaded = true
    }

    // MARK: rows

    private func row(_ it: CallLogItems.Item) -> some View {
        HStack(spacing: 12) {
            Image(systemName: Self.symbol(it))
                .font(.body.weight(.semibold))
                .foregroundStyle(Self.color(it))
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: it.room).font(.body.weight(.medium)).lineLimit(1)
                Text(verbatim: it.isCall ? callDetail(it) : messageDetail(it))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Text(Date(timeIntervalSince1970: Double(it.at) / 1000), format: .dateTime.hour().minute())
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
            if it.isCall && it.saved {
                Button { callAsk = it } label: {
                    Image(systemName: it.video ? "video.fill" : "phone.fill")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text(verbatim: t("log.callBack")))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { open(it) }
        .accessibilityIdentifier("log.item")
    }

    /// "Incoming · video · 12:04 · Alice, Bob"
    private func callDetail(_ it: CallLogItems.Item) -> String {
        var s = t("log.dir." + it.dir)
        if it.video { s += " · " + t("log.video") }
        let len = CallLogItems.length(it.seconds)
        if !len.isEmpty { s += " · " + len }
        let people = it.people.joined(separator: ", ")
        if !people.isEmpty { s += " · " + people } else if it.dir == CallTrack.Kind.outgoing.rawValue { s += " · " + t("log.nobody") }
        return s
    }

    /// "Alice: the text" / "Me → Bob: …" — a sealed, hold-to-read, vanishing or hidden one only by its kind.
    private func messageDetail(_ it: CallLogItems.Item) -> String {
        let people = it.people.joined(separator: ", ")
        let who = it.dir == "out" ? t("log.me") + (people.isEmpty ? "" : " → " + people) : people
        let what: String
        switch it.what {
        case "text", "fn": what = it.preview
        case "file": what = "📎 " + it.preview
        default: what = t("log.kind." + it.what)
        }
        return who.isEmpty ? what : who + ": " + what
    }

    static func symbol(_ it: CallLogItems.Item) -> String {
        let out = it.dir == "out"
        if it.isCall {
            let gone = it.dir == CallTrack.Kind.missed.rawValue || it.dir == CallTrack.Kind.declined.rawValue
            if it.video { return gone ? "video.slash" : "video" }
            return gone ? "phone.down" : out ? "phone.arrow.up.right" : "phone.arrow.down.left"
        }
        switch it.what {
        case "sealed": return "lock.doc"
        case "tap": return "eye"
        case "vanish": return "timer"
        case "hidden": return "eye.slash"
        case "file": return "paperclip"
        case "fn": return "terminal"
        default: return out ? "paperplane" : "message"
        }
    }

    static func color(_ it: CallLogItems.Item) -> Color {
        if it.dir == CallTrack.Kind.missed.rawValue { return .red }
        if it.dir == CallTrack.Kind.declined.rawValue { return .secondary }
        if it.isCall { return it.dir == "out" ? .accentColor : .green }
        return it.dir == "out" ? .accentColor : .secondary
    }

    // MARK: days

    private struct Day {
        let day: Int
        let title: String
        var items: [CallLogItems.Item]
    }

    private func days(_ items: [CallLogItems.Item]) -> [Day] {
        let now = CallTrack.millis()
        var out: [Day] = []
        for it in items {
            let d = CallLogItems.daysAgo(it.at, now: now, timeZone: .current)
            if out.last?.day == d { out[out.count - 1].items.append(it); continue }
            let title = d == 0 ? t("log.today") : d == 1 ? t("log.yesterday")
                : Date(timeIntervalSince1970: Double(it.at) / 1000).formatted(date: .abbreviated, time: .omitted)
            out.append(Day(day: d, title: title, items: [it]))
        }
        return out
    }

    // MARK: actions

    private func open(_ it: CallLogItems.Item) {
        guard it.saved else { notice = t("log.gone"); return }
        onOpenRoom(it.roomKey, it.isCall ? nil : it.msgId)
    }

    private func dial(_ it: CallLogItems.Item, video: Bool) {
        guard it.saved else { notice = t("log.gone"); return }
        onOpenRoom(it.roomKey, nil)
        Task { await system.startCall(roomKey: it.roomKey, video: video) }
    }
}
