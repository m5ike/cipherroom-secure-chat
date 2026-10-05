// An MPEG-4 file without its top-level `free` / `skip` padding. AVFoundation's
// writer (ExtAudioFile) reserves ~23 kB of it after `moov` so the header could
// grow in place; for a voice message of a few seconds that is more than the
// audio, and it decides whether the message goes inline or as a file transfer
// (Android's Composer: inline when small). The padding goes and every chunk
// offset (`stco` / `co64` in moov › trak › mdia › minf › stbl) moves with the
// data after it; anything unexpected leaves the file as it was. Pure
// (VoiceClipCodecTests).

import Foundation

enum Mp4Compact {
    private struct Box { let type: String; let start: Int; let size: Int; let header: Int }

    private static func u32(_ b: [UInt8], _ at: Int) -> UInt32 { UInt32(b[at]) << 24 | UInt32(b[at + 1]) << 16 | UInt32(b[at + 2]) << 8 | UInt32(b[at + 3]) }

    private static func u64(_ b: [UInt8], _ at: Int) -> UInt64 { UInt64(u32(b, at)) << 32 | UInt64(u32(b, at + 4)) }

    /// The boxes in b[from..<to]; nil when they do not tile it exactly.
    private static func boxes(_ b: [UInt8], from: Int, to: Int) -> [Box]? {
        var out = [Box]()
        var at = from
        while at < to {
            guard at + 8 <= to else { return nil }
            var size = Int(u32(b, at)), header = 8
            let type = String(decoding: b[(at + 4)..<(at + 8)], as: UTF8.self)
            if size == 1 {
                guard at + 16 <= to else { return nil }
                let large = u64(b, at + 8)
                guard large <= UInt64(Int.max) else { return nil }
                size = Int(large); header = 16
            } else if size == 0 {
                size = to - at
            }
            guard size >= header, at + size <= to else { return nil }
            out.append(Box(type: type, start: at, size: size, header: header))
            at += size
        }
        return out
    }

    private static let containers: Set<String> = ["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"]

    static func withoutFree(_ data: Data) -> Data {
        let b = [UInt8](data)
        guard let top = boxes(b, from: 0, to: b.count), top.first?.type == "ftyp" else { return data }
        let removed = top.filter { $0.type == "free" || $0.type == "skip" }
        guard !removed.isEmpty else { return data }
        /// Where an old offset lands once the removed boxes before it are gone.
        func moved(_ o: UInt64) -> UInt64? {
            var shift: UInt64 = 0
            for r in removed {
                if UInt64(r.start) >= o { break }
                if o < UInt64(r.start + r.size) { return nil } // an offset inside the padding: not ours to move
                shift += UInt64(r.size)
            }
            return o - shift
        }
        var out = [UInt8]()
        out.reserveCapacity(b.count)
        for box in top where box.type != "free" && box.type != "skip" {
            var bytes = Array(b[box.start..<(box.start + box.size)])
            if box.type == "moov" {
                guard patch(&bytes, from: box.header, to: bytes.count, moved: moved) else { return data }
            }
            out += bytes
        }
        return Data(out)
    }

    /// Moves the chunk offsets of every stco / co64 under b[from..<to]; false when the boxes do not parse.
    private static func patch(_ b: inout [UInt8], from: Int, to: Int, moved: (UInt64) -> UInt64?) -> Bool {
        guard let children = boxes(b, from: from, to: to) else { return false }
        for c in children {
            let body = c.start + c.header
            if containers.contains(c.type) {
                if !patch(&b, from: body, to: c.start + c.size, moved: moved) { return false }
            } else if c.type == "stco" || c.type == "co64" {
                guard body + 8 <= c.start + c.size else { return false }
                let n = Int(u32(b, body + 4))
                let width = c.type == "stco" ? 4 : 8
                guard body + 8 + n * width <= c.start + c.size else { return false }
                for i in 0..<n {
                    let at = body + 8 + i * width
                    let old = width == 4 ? UInt64(u32(b, at)) : u64(b, at)
                    guard let new = moved(old) else { return false }
                    for k in 0..<width { b[at + k] = UInt8(truncatingIfNeeded: new >> UInt64(8 * (width - 1 - k))) }
                }
            }
        }
        return true
    }
}
