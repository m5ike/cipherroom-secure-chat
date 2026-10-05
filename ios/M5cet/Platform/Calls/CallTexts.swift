// The calls' texts: from the design (CallEnvironment.text — the same keys as
// Android's default design: call.*, ring.*, log.*), with the English of the
// default design when the design has none. Nothing here is the app's own
// wording; the defaults are copied from default-design.json (strings.en).

import Foundation

@MainActor
enum CallTexts {
    static let english: [String: String] = [
        "call.audio": "Voice call",
        "call.video": "Video call",
        "call.end": "Hang up",
        "call.mute": "Mute",
        "call.incoming": "A call in the room",
        "ring.call": "Call",
        "ring.video": "Video call",
        "ring.join": "Join",
        "ring.decline": "Decline",
        "ring.missed": "Missed call",
        "ring.missedWho": "Missed call · {name}",
        "ring.who": "{name} is calling",
        "log.title": "History",
        "log.open": "History of calls and messages",
        "log.today": "Today",
        "log.yesterday": "Yesterday",
        "log.dir.in": "Incoming",
        "log.dir.out": "Outgoing",
        "log.dir.missed": "Missed",
        "log.dir.declined": "Declined",
        "log.video": "video",
        "log.nobody": "nobody came",
        "log.me": "Me",
        "log.empty": "Nothing here yet.",
        "log.noMatch": "Nothing matches.",
        "log.loading": "Loading the history…",
        "log.search": "Search a room, a person or text",
        "log.filter.all": "All",
        "log.filter.calls": "Calls",
        "log.filter.messages": "Messages",
        "log.filter.missed": "Missed",
        "log.callAsk": "Call the room {room}? Everyone connected there hears the call.",
        "log.call.audio": "Call",
        "log.call.video": "With video",
        "log.callBack": "Call again",
        "log.clear": "Clear the call history",
        "log.clearAsk": "Delete the app's call history on this phone? The rooms' messages stay.",
        "log.cleared": "The call history is deleted.",
        "log.gone": "This room is no longer saved in the app.",
        "log.historyOff": "The call history is not kept (Settings › Calls) — you see messages and the calls kept before.",
        "log.limit": "Showing the newest — narrow it with the filter or the search",
        "log.kind.file": "File",
        "log.kind.hidden": "Hidden message",
        "log.kind.sealed": "Sealed message",
        "log.kind.tap": "\"Hold to read\" message",
        "log.kind.vanish": "Vanishing message",
        "nav.close": "Close",
    ]

    static func t(_ key: String, _ env: (any CallEnvironment)? = nil) -> String {
        env?.text(key) ?? english[key] ?? key
    }
}
