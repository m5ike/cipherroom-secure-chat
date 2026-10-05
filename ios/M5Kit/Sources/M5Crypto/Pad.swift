// Padding (docs/protocol-v4.md § 10; pad.ts; android p4/Pad.java), ISO/IEC 7816-4:
//   pad(m)   = m ‖ 0x80 ‖ 0x00…  up to the smallest PAD_BUCKETS entry that is
//              >= len(m) + 1; above 65 536, the next multiple of 65 536
//   unpad(m) = strip trailing 0x00, then require and strip one 0x80

import M5Core

public enum Pad {
    private static let top = P4.padBuckets.last!

    /// The padded length (marker included) of a message of `length` bytes.
    public static func paddedLength(_ length: Int) -> Int {
        precondition(length >= 0, "message length")
        let need = length + 1
        for bucket in P4.padBuckets where bucket >= need { return bucket }
        return (need + top - 1) / top * top
    }

    public static func pad(_ message: Bytes) -> Bytes {
        var out = message
        out.append(0x80)
        out.append(contentsOf: Bytes(repeating: 0, count: paddedLength(message.count) - message.count - 1))
        return out
    }

    /// The message inside; a missing 0x80 marker is `malformed`.
    public static func unpad(_ padded: Bytes) throws -> Bytes {
        var i = padded.count - 1
        while i >= 0 && padded[i] == 0 { i -= 1 }
        if i < 0 || padded[i] != 0x80 { throw P4Error.malformed("bad padding") }
        return Array(padded[0..<i])
    }
}
