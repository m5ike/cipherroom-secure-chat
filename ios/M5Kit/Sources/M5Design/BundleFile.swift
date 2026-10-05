// A downloaded design bundle (.m5ab, docs/android-architecture.md §1.6) — a
// port of android/…/update/BundleFile.java; the format is the server's
// (server/android/crypto.ts sealBundle / bundleFile / packContainer):
//
//   M5AB    "M5AB" | u8 1 | u32 headerLen | header JSON | segments
//   verify  the header's signature (ECDSA P-256 P1363) with the pinned server key, its kid
//   unwrap  the content key (ECIES, purpose "bundle|<id>") for this device
//   decrypt 256 KiB AES-256-GCM segments (AAD "m5bundle/1|<id>|<i>|<last>"), both hashes checked
//   unpack  gzip → M5PK container → files, each checked against the manifest
//
// The cryptography is the app's (BundleCrypto — wired to M5Crypto / CryptoKit).

import Foundation

/// ECIES as the server seals for a device (server/android/crypto.ts eciesSeal).
public struct EciesWire: Sendable, Hashable {
    /// The ephemeral P-256 public key (SPKI, base64).
    public var e: String
    /// The AES-GCM IV (base64).
    public var iv: String
    /// Ciphertext ‖ tag (base64).
    public var ct: String
    public init(e: String, iv: String, ct: String) { self.e = e; self.iv = iv; self.ct = ct }
}

/// The cryptography a bundle needs, provided by the app (M5Crypto / CryptoKit; the device's
/// encryption key stays in the Keychain / Secure Enclave behind `eciesOpen`).
public protocol BundleCrypto: Sendable {
    func sha256(_ data: Data) -> Data
    /// ECDSA P-256 / SHA-256 with an IEEE P1363 signature (r ‖ s, 64 bytes) by the key of this SPKI (DER).
    func verifyP1363(publicKeySpki: Data, message: Data, signature: Data) -> Bool
    /// ECIES open with this device's encryption key: ECDH(device key, `wire.e`), HKDF-SHA256 (salt
    /// "m5cet/android/ecies/1", info "<purpose>|<deviceId>", 32 bytes), AES-256-GCM with AAD
    /// "m5cet/android/ecies/1|<purpose>|<deviceId>".
    func eciesOpen(deviceId: String, purpose: String, wire: EciesWire) throws -> Data
    /// AES-256-GCM: ciphertext ‖ 16-byte tag → plaintext; throws when it does not authenticate.
    func aesGcmOpen(key: Data, iv: Data, ciphertextAndTag: Data, aad: Data) throws -> Data
}

/// Why a bundle was refused (the Java messages).
public struct BundleError: Error, Sendable, Equatable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// Constant-time equality of two byte strings (Crypto.same).
func sameBytes(_ a: Data, _ b: Data?) -> Bool {
    guard let b, a.count == b.count else { return false }
    var d: UInt8 = 0
    for (x, y) in zip(a, b) { d |= x ^ y }
    return d == 0
}

public struct BundleFile: Sendable {
    public static let maxHeader = 4 * 1024 * 1024
    public static let maxContent = 64 * 1024 * 1024

    public let header: [String: DesignValue]
    public let file: Data
    public let bodyAt: Int

    /// The header of an M5AB file (nothing verified yet).
    public static func parse(_ file: Data) throws -> BundleFile {
        let b = [UInt8](file.prefix(9))
        guard file.count >= 9, b[0] == 0x4D, b[1] == 0x35, b[2] == 0x41, b[3] == 0x42, b[4] == 1 else { throw BundleError("not an M5AB bundle") }
        let n = Int(Int32(bitPattern: UInt32(b[5]) << 24 | UInt32(b[6]) << 16 | UInt32(b[7]) << 8 | UInt32(b[8])))
        guard n >= 2, n <= maxHeader, 9 + n <= file.count else { throw BundleError("bad bundle header") }
        let start = file.startIndex
        guard let h = try? DesignValue.parse(file.subdata(in: (start + 9)..<(start + 9 + n))), let o = h.objectValue else { throw BundleError("bad bundle header") }
        return BundleFile(header: o, file: Data(file), bodyAt: 9 + n)
    }

    private func str(_ k: String) -> String { header[k]?.optString("") ?? "" }
    private func int(_ k: String) -> Int { Int(JavaSemantics.intValue(header[k]?.optDouble(0) ?? 0)) }
    private func long(_ k: String) -> Int64 { JavaSemantics.longValue(header[k]?.optDouble(0) ?? 0) }

    public var id: String { str("id") }
    public var number: Int { int("number") }
    public var version: String { str("version") }
    public var channel: String { str("channel") }
    public var created: Int64 { long("created") }
    public var minAppCode: Int { int("minAppCode") }
    public var kid: String { str("kid") }

    /// What the server signed.
    public var signedString: String {
        "m5bundle/1|\(id)|\(number)|\(version)|\(channel)|\(created)|\(minAppCode)|\(long("size"))|\(str("sha256"))|\(int("seg"))|\(int("segments"))|\(str("ctSha256"))"
    }

    /// The header's signature by the pinned server key (SPKI DER).
    public func verify(serverKeySpki: Data, crypto: BundleCrypto) -> Bool {
        guard let sig = Data(base64Encoded: str("sig")) else { return false }
        return crypto.verifyP1363(publicKeySpki: serverKeySpki, message: Data(signedString.utf8), signature: sig)
    }

    /// The content key wrapped for this device.
    public func unwrapKey(deviceId: String, crypto: BundleCrypto) throws -> Data {
        for r in header["recipients"]?.arrayValue ?? [] {
            guard let o = r.objectValue, o["device"]?.optString("") == deviceId else { continue }
            let cek: Data
            do {
                cek = try crypto.eciesOpen(deviceId: deviceId, purpose: "bundle|\(id)",
                                           wire: EciesWire(e: o["e"]?.optString("") ?? "", iv: o["iv"]?.optString("") ?? "", ct: o["ct"]?.optString("") ?? ""))
            } catch {
                throw BundleError("the bundle's key does not open")
            }
            guard cek.count == 32 else { throw BundleError("bad bundle key") }
            return cek
        }
        throw BundleError("the bundle is not encrypted for this device")
    }

    /// The plain content (the gzipped container), every hash checked.
    public func decrypt(cek: Data, crypto: BundleCrypto) throws -> Data {
        let bytes = [UInt8](file)
        let bodyLen = bytes.count - bodyAt
        let ctHash = crypto.sha256(Data(bytes[bodyAt...]))
        guard sameBytes(ctHash, Data(base64Encoded: str("ctSha256"))) else { throw BundleError("bundle ciphertext hash mismatch") }
        let size = long("size")
        let seg = Int64(int("seg"))
        let segments = Int64(int("segments"))
        guard size >= 0, size <= Int64(Self.maxContent), seg >= 1024, segments >= 1, seg * (segments - 1) <= size else {
            throw BundleError("bad bundle segmentation")
        }
        var out = Data(capacity: Int(size))
        var at = bodyAt
        for i in 0..<Int(segments) {
            let last = Int64(i) == segments - 1
            let plainLen = Int(last ? size - seg * (segments - 1) : seg)
            guard at + 12 + plainLen + 16 <= bytes.count else { throw BundleError("truncated bundle") }
            let iv = Data(bytes[at..<(at + 12)])
            let ct = Data(bytes[(at + 12)..<(at + 12 + plainLen + 16)])
            let plain: Data
            do {
                plain = try crypto.aesGcmOpen(key: cek, iv: iv, ciphertextAndTag: ct, aad: Data("m5bundle/1|\(id)|\(i)|\(last ? "1" : "0")".utf8))
            } catch {
                throw BundleError("a bundle segment does not authenticate")
            }
            out.append(plain)
            at += 12 + plainLen + 16
        }
        guard at == bytes.count, bodyLen > 0 else { throw BundleError("bundle has trailing bytes") }
        guard out.count == Int(size), sameBytes(crypto.sha256(out), Data(base64Encoded: str("sha256"))) else { throw BundleError("bundle content hash mismatch") }
        return out
    }
}

/// The files of a bundle's plain content: the M5PK container, the manifest first and checked.
public struct BundleContents: Sendable {
    /// The files in the container's order (the manifest first).
    public let entries: [(path: String, data: Data)]
    public let files: [String: Data]
    public let manifest: [String: DesignValue]

    public var version: String { manifest["version"]?.optString("") ?? "" }
    public var minAppCode: Int { Int(JavaSemantics.intValue(manifest["minAppCode"]?.optDouble(0) ?? 0)) }

    /// BundleFile.unpack: gunzip (at most 64 MiB), the container, every file against the manifest.
    public static func unpack(_ gzipped: Data, crypto: BundleCrypto) throws -> BundleContents {
        let c: [UInt8]
        do {
            c = [UInt8](try Gzip.decompress(gzipped, limit: BundleFile.maxContent))
        } catch let e as Gzip.Failure {
            throw BundleError(e.tooLarge ? "bundle too large" : "bad bundle compression")
        }
        let entries = try container(c)
        var files: [String: Data] = [:]
        var order: [(String, Data)] = []
        for (path, data) in entries {
            if files[path] == nil { order.append((path, data)) } else if let i = order.firstIndex(where: { $0.0 == path }) { order[i] = (path, data) }
            files[path] = data
        }
        guard let manifestBytes = files["manifest.json"], order.first?.0 == "manifest.json" else { throw BundleError("the bundle has no manifest") }
        guard let m = try? DesignValue.parse(manifestBytes), let manifest = m.objectValue else { throw BundleError("bad manifest") }
        guard let list = manifest["files"]?.objectValue, JavaSemantics.intValue(manifest["format"]?.optDouble(0) ?? 0) == 1 else {
            throw BundleError("unknown bundle format")
        }
        for (path, infoValue) in list {
            guard let info = infoValue.objectValue else { throw BundleError("bad manifest") }
            let data = files[path]
            let size = Int(JavaSemantics.intValue(info["size"]?.optDouble(-1) ?? -1))
            guard let data, data.count == size, hex(crypto.sha256(data)) == (info["sha256"]?.optString("") ?? "") else {
                throw BundleError("bundle file \(path) does not match its manifest")
            }
        }
        return BundleContents(entries: order.map { (path: $0.0, data: $0.1) }, files: files, manifest: manifest)
    }

    /// "M5PK" | u8 1 | u32 count | (u16 pathLen | path | u32 len | data)* — paths with ".." or a leading "/" refused.
    static func container(_ c: [UInt8]) throws -> [(String, Data)] {
        guard c.count >= 9, c[0] == 0x4D, c[1] == 0x35, c[2] == 0x50, c[3] == 0x4B, c[4] == 1 else { throw BundleError("not an M5PK container") }
        func be32(_ at: Int) -> Int { Int(Int32(bitPattern: UInt32(c[at]) << 24 | UInt32(c[at + 1]) << 16 | UInt32(c[at + 2]) << 8 | UInt32(c[at + 3]))) }
        let count = be32(5)
        var out: [(String, Data)] = []
        var at = 9
        var i = 0
        while i < count {
            guard at + 2 <= c.count else { throw BundleError("truncated container") }
            let pl = Int(c[at]) << 8 | Int(c[at + 1])
            at += 2
            guard at + pl + 4 <= c.count else { throw BundleError("truncated container") }
            let path = String(decoding: c[at..<(at + pl)], as: UTF8.self)
            at += pl
            let len = be32(at)
            at += 4
            guard len >= 0, at + len <= c.count else { throw BundleError("truncated container") }
            if path.contains("..") || path.hasPrefix("/") { throw BundleError("bad path in the container") }
            out.append((path, Data(c[at..<(at + len)])))
            at += len
            i += 1
        }
        guard at == c.count else { throw BundleError("trailing bytes in the container") }
        return out
    }

    /// The container the server packs (tests and tools): paths as the server allows them.
    public static func pack(_ entries: [(String, Data)]) -> Data {
        var out = Data("M5PK".utf8)
        out.append(1)
        func u32(_ v: Int) { out.append(contentsOf: [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)]) }
        u32(entries.count)
        for (path, data) in entries {
            let p = Data(path.utf8)
            out.append(contentsOf: [UInt8(p.count >> 8 & 0xFF), UInt8(p.count & 0xFF)])
            out.append(p)
            u32(data.count)
            out.append(data)
        }
        return out
    }

    static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
}

/// The steps a device takes with a downloaded bundle (Bundles.download without the network and the storage).
public enum BundleVerifier {
    public struct Verified: Sendable {
        public let file: BundleFile
        /// The plain content (gzipped container) — what the app keeps (sealed) for the next start.
        public let content: Data
        public let contents: BundleContents
        /// The design, parsed (a bundle is kept only when it parses).
        public let design: Design
    }

    /// Verifies and opens a downloaded bundle: the id asked for, the server's kid and signature, the
    /// app version, the device's key, every hash, the container, the manifest, the design.
    public static func open(file raw: Data, expectedId: String, serverKeySpki: Data, serverKid: String, deviceId: String, appCode: Int,
                            crypto: BundleCrypto) throws -> Verified {
        let bundle = try BundleFile.parse(raw)
        guard bundle.id == expectedId else { throw BundleError("the server sent another bundle") }
        guard bundle.kid == serverKid, bundle.verify(serverKeySpki: serverKeySpki, crypto: crypto) else { throw BundleError("the bundle's signature is not the server's") }
        guard bundle.minAppCode <= appCode else { throw BundleError("the bundle needs a newer app") }
        var cek = try bundle.unwrapKey(deviceId: deviceId, crypto: crypto)
        defer { cek.resetBytes(in: 0..<cek.count) }
        let content = try bundle.decrypt(cek: cek, crypto: crypto)
        let contents = try BundleContents.unpack(content, crypto: crypto)
        let design: Design
        do {
            design = try Design.fromFiles(bundleId: bundle.id, version: bundle.version, files: contents.files)
        } catch let e as DesignLoadError {
            throw BundleError(e.message)
        }
        return Verified(file: bundle, content: content, contents: contents, design: design)
    }

    /// Bundles.open: a kept content at the next start — the container, the manifest's app version, the design.
    public static func openStored(content: Data, id: String, appCode: Int, crypto: BundleCrypto) throws -> Design {
        let contents = try BundleContents.unpack(content, crypto: crypto)
        guard contents.minAppCode <= appCode else { throw BundleError("the bundle needs a newer app") }
        do {
            return try Design.fromFiles(bundleId: id, version: contents.version, files: contents.files)
        } catch let e as DesignLoadError {
            throw BundleError(e.message)
        }
    }
}
