// Argon2id v 0x13 (RFC 9106) — the room KDF of the web client (hash-wasm;
// 64 MiB, 3 passes, 1 lane, 32 bytes) through the vendored reference C
// implementation (CArgon2). Like android chat/Argon2.java, one derivation runs
// at a time: each holds its whole memory (64 MiB for a room), and rooms
// connecting together would otherwise run a phone out of memory.

import CArgon2
import M5Core
import Synchronization

public enum Argon2 {
    /// The reference implementation's error (a negative ARGON2_* code), e.g. a salt shorter than 8 bytes.
    public struct Failure: Error, Sendable, Equatable { public let code: Int32 }

    private static let oneAtATime = Mutex(())

    /// Argon2id of `password` and `salt`: `length` bytes. `memoryKiB` m, `passes` t, `lanes` p;
    /// `secret` (K) and `data` (X) are optional (RFC 9106).
    public static func argon2id(password: Bytes, salt: Bytes, passes: Int, memoryKiB: Int, lanes: Int = 1, length: Int = 32,
                                secret: Bytes? = nil, data: Bytes? = nil) throws -> Bytes {
        guard passes >= 1, lanes >= 1, length >= 4, memoryKiB >= 1 else { throw Failure(code: -1) }
        var out = Bytes(repeating: 0, count: length)
        let k = secret ?? [], x = data ?? []
        let rc: Int32 = oneAtATime.withLock { _ in
            password.withUnsafeBufferPointer { pw in
                salt.withUnsafeBufferPointer { s in
                    k.withUnsafeBufferPointer { kp in
                        x.withUnsafeBufferPointer { xp in
                            out.withUnsafeMutableBufferPointer { o in
                                m5_argon2id_ext(pw.baseAddress, pw.count, s.baseAddress, s.count,
                                                k.isEmpty ? nil : kp.baseAddress, k.count, x.isEmpty ? nil : xp.baseAddress, x.count,
                                                UInt32(passes), UInt32(memoryKiB), UInt32(lanes), o.baseAddress, o.count)
                            }
                        }
                    }
                }
            }
        }
        if rc != 0 { throw Failure(code: rc) }
        return out
    }
}
