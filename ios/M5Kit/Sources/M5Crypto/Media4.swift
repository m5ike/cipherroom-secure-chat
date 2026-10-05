// Call media keys of protocol 4 (docs/protocol-v4.md § 9; media4.ts; android
// p4/Media4.java) — the frame IV and the sealed-frame layout of
// media-frames.ts. The mobile apps keep WebRTC's own DTLS-SRTP (their hello
// has no "media" cap); this is the byte layout, checked against the vectors.
//
//   IV = epoch (4 bytes, big-endian) ‖ frame counter (8 bytes, big-endian)
//   frame = clear prefix ‖ AES-GCM(prefix as AAD) ‖ IV ‖ clear length ‖ 0x6d 0xe3

import M5Core

public enum Media4 {
    public static let frameLimit: Int64 = 1 << 32
    private static let trailer: Bytes = [0x6d, 0xe3]

    /// § 9 frame IV.
    public static func frameIv(_ epoch: Int64, _ counter: Int64) throws -> Bytes {
        if epoch < 0 || epoch > 0xffff_ffff { throw P4Error.malformed("epoch is a 32-bit unsigned integer") }
        if counter < 0 || counter >= frameLimit { throw P4Error.malformed("frame counter out of range") }
        return ByteOps.be32(UInt32(epoch)) + ByteOps.be64(UInt64(counter))
    }

    /// media-frames.ts sealFrame: the first `clear` bytes stay readable (and are the AAD).
    public static func sealFrame(_ key: Bytes, _ frame: Bytes, clear: Int, iv: Bytes) throws -> Bytes {
        if clear < 0 || clear > frame.count || clear > 255 { throw P4Error.malformed("clear prefix") }
        let prefix = Array(frame[0..<clear])
        let ct = try Prim.aesGcmSeal(key, iv, prefix, Array(frame[clear...]))
        return prefix + ct + iv + [UInt8(clear)] + trailer
    }

    /// media-frames.ts openFrame; nil when the frame is not sealed or does not open.
    public static func openFrame(_ key: Bytes, _ b: Bytes) -> Bytes? {
        let overhead = 16 + 12 + 1 + 2
        guard b.count >= overhead, b[b.count - 2] == trailer[0], b[b.count - 1] == trailer[1], Int(b[b.count - 3]) <= b.count - overhead else { return nil }
        let clear = Int(b[b.count - 3])
        let ivAt = b.count - 3 - 12
        let prefix = Array(b[0..<clear])
        guard let plain = try? Prim.aesGcmOpen(key, Array(b[ivAt..<ivAt + 12]), prefix, Array(b[clear..<ivAt])) else { return nil }
        return prefix + plain
    }
}
