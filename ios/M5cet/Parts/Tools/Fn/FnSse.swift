// Server-Sent Events as the server writes them ("event: x\ndata: {json}\n\n",
// ": ping" in between) — a port of android/…/fn/Sse.java (readEvents() in
// client/src/lib/ai.ts): a block ends at a blank line, "event:" names it
// (default "message"), the "data:" lines joined by "\n" are its JSON; a block
// without data or with data that is not a JSON object is skipped. Chunks may
// split anywhere — the blocks are cut on the bytes ("\n\n" is ASCII, so a
// UTF-8 character is never cut in two).

import Foundation
import M5Core
import M5Proto

struct FnSse: Sendable {
    /// One event may be this large (a run's outputs arrive in one "done").
    static let maxBlock = 64 << 20

    private var buf: [UInt8] = []
    /// Where the search for the next "\n\n" goes on (a large block arrives in many chunks).
    private var scanned = 0

    init() {}

    /// Adds bytes as they arrive; returns every complete block's event, in order.
    mutating func feed(_ chunk: Data) throws -> [(String, JSONObject)] {
        buf.append(contentsOf: chunk)
        var out = [(String, JSONObject)]()
        var start = 0
        var i = Swift.max(0, scanned)
        while i + 1 < buf.count {
            if buf[i] == 0x0A && buf[i + 1] == 0x0A {
                if let e = Self.emit(buf[start..<i]) { out.append(e) }
                start = i + 2
                i = start
                continue
            }
            i += 1
        }
        if start > 0 { buf.removeFirst(start) }
        scanned = Swift.max(0, buf.count - 1)
        if buf.count > Self.maxBlock { throw FnFailure.network("an event is too large") }
        return out
    }

    /// The same for text (tests; a whole stream).
    mutating func feed(_ text: String) throws -> [(String, JSONObject)] { try feed(Data(text.utf8)) }

    private static func emit(_ block: ArraySlice<UInt8>) -> (String, JSONObject)? {
        var event = "message"
        var data: String?
        // Lines on the byte "\n" (as Java's split("\n", -1): a "\r" before it stays in the line).
        for bytes in block.split(separator: 0x0A, omittingEmptySubsequences: false) {
            let line = String(decoding: bytes, as: UTF8.self)
            if line.hasPrefix("event:") {
                event = Js.trim(String(line.dropFirst(6)))
            } else if line.hasPrefix("data:") {
                let d = line.hasPrefix("data: ") ? String(line.dropFirst(6)) : String(line.dropFirst(5))
                data = data.map { $0 + "\n" + d } ?? d
            }
        }
        guard let data, case .object(let o)? = try? Js.parse(data) else { return nil }
        return (event, o)
    }
}
