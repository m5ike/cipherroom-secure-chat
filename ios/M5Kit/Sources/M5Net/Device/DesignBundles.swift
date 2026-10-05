// Design bundles from the server (Android: update/BundleFile + the download of
// update/Bundles; docs/android-architecture.md §1.6, server/android/crypto.ts):
//
//   "M5AB" | u8 1 | u32 headerLength | header JSON | segments
//   header: { id, number, version, channel, created, minAppCode, size, sha256,
//             seg, segments, ctSha256, kid, sig, recipients: [{device, e, iv, ct}] }
//   sig     P1363 by the pinned server key over
//           "m5bundle/1|id|number|version|channel|created|minAppCode|size|sha256|seg|segments|ctSha256"
//   segment iv(12) ‖ AES-256-GCM(content key, aad "m5bundle/1|id|i|last") — 256 KiB of plain each
//
// Here: download, verify (the server's signature and kid, the id asked for,
// the app's version, the ciphertext's hash), unwrap the content key for this
// device (EciesOpener, purpose "bundle|<id>"), decrypt and check the content's
// hash. What comes out is the plain content — a gzipped M5PK container that
// M5Design unpacks, checks against its manifest and loads; the staging, trial
// and rollback of Bundles.java are the app's (M5Design + Platform).

import CryptoKit
import Foundation

/// A bundle the check-in offers.
public struct BundleOffer: Sendable, Equatable {
    public let id: String
    public let number: Int64
    public let version: String
    public let size: Int64
    public let minAppCode: Int64
    public let notes: String
    public init(_ j: NetJSON) {
        id = j.str("id")
        number = j.int("number")
        version = j.str("version")
        size = j.int("size")
        minAppCode = j.int("minAppCode")
        notes = j.str("notes")
    }
}

public struct DesignBundleHeader: Sendable, Equatable {
    public let id: String
    public let number: Int64
    public let version: String
    public let channel: String
    public let created: Int64
    public let minAppCode: Int64
    public let size: Int64
    public let sha256: String
    public let seg: Int64
    public let segments: Int64
    public let ctSha256: String
    public let kid: String
    public let sig: String
    /// device id → the content key sealed for it.
    public let recipients: [(device: String, wire: EciesEnvelope)]
    public let raw: NetJSON

    public static func == (a: DesignBundleHeader, b: DesignBundleHeader) -> Bool { a.raw == b.raw }

    init(_ j: NetJSON) {
        id = j.str("id")
        number = j.int("number")
        version = j.str("version")
        channel = j.str("channel")
        created = j.int("created")
        minAppCode = j.int("minAppCode")
        size = j.int("size")
        sha256 = j.str("sha256")
        seg = j.int("seg")
        segments = j.int("segments")
        ctSha256 = j.str("ctSha256")
        kid = j.str("kid")
        sig = j.str("sig")
        recipients = (j.arr("recipients") ?? []).compactMap { r in EciesEnvelope(r).map { (r.str("device"), $0) } }
        raw = j
    }

    /// bundleSignedString (crypto.ts).
    public var signedString: String {
        ["m5bundle/1", id, String(number), version, channel, String(created), String(minAppCode), String(size), sha256, String(seg), String(segments), ctSha256]
            .joined(separator: "|")
    }
}

public struct DesignBundleFile: Sendable {
    public static let maxHeader = 4 * 1024 * 1024
    public static let maxContent: Int64 = 64 * 1024 * 1024

    public let header: DesignBundleHeader
    public let file: Data
    public let bodyOffset: Int

    public static func parse(_ file: Data) throws -> DesignBundleFile {
        let b = [UInt8](file.prefix(9))
        guard file.count >= 9, b[0] == UInt8(ascii: "M"), b[1] == UInt8(ascii: "5"), b[2] == UInt8(ascii: "A"), b[3] == UInt8(ascii: "B"), b[4] == 1 else {
            throw NetError.security("not an M5AB bundle")
        }
        let n = Int(Bytes.be32(file, 5) ?? 0)
        guard n >= 2, n <= maxHeader, 9 + n <= file.count else { throw NetError.security("bad bundle header") }
        let start = file.startIndex
        guard let j = try? NetJSON.parse(file[(start + 9)..<(start + 9 + n)]), case .object = j else { throw NetError.security("bad bundle header") }
        return DesignBundleFile(header: DesignBundleHeader(j), file: file, bodyOffset: 9 + n)
    }

    public var body: Data { file.suffix(from: file.startIndex + bodyOffset) }

    /// The header's signature by the server key (SPKI, base64).
    public func verify(serverKey: String) -> Bool { P256Keys.verify(spki: serverKey, text: header.signedString, signature: header.sig) }

    public var ciphertextHashMatches: Bool {
        guard let want = Bytes.unb64(header.ctSha256) else { return false }
        return Bytes.same(Bytes.sha256(body), want)
    }

    /// The content key sealed for this device, nil when the bundle is not for it.
    public func recipient(deviceId: String) -> EciesEnvelope? { header.recipients.first { $0.device == deviceId }?.wire }

    /// The plain content (gzipped M5PK), every hash checked.
    public func decrypt(cek: Data) throws -> Data {
        guard cek.count == 32 else { throw NetError.security("bad bundle key") }
        guard ciphertextHashMatches else { throw NetError.security("bundle ciphertext hash mismatch") }
        let size = header.size, seg = header.seg, segments = header.segments
        guard size >= 0, size <= Self.maxContent, seg >= 1024, segments >= 1, seg * (segments - 1) <= size else { throw NetError.security("bad bundle segmentation") }
        let key = SymmetricKey(data: cek)
        var out = Data(capacity: Int(size))
        var at = file.startIndex + bodyOffset
        for i in 0..<segments {
            let last = i == segments - 1
            let plainLen = Int(last ? size - seg * (segments - 1) : seg)
            guard at + 12 + plainLen + 16 <= file.endIndex else { throw NetError.security("truncated bundle") }
            let iv = file[at..<(at + 12)]
            let ct = file[(at + 12)..<(at + 12 + plainLen)]
            let tag = file[(at + 12 + plainLen)..<(at + 12 + plainLen + 16)]
            do {
                let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct, tag: tag)
                out.append(try AES.GCM.open(box, using: key, authenticating: Data("m5bundle/1|\(header.id)|\(i)|\(last ? "1" : "0")".utf8)))
            } catch {
                throw NetError.security("bundle segment \(i) does not open")
            }
            at += 12 + plainLen + 16
        }
        guard at == file.endIndex, file.count > bodyOffset else { throw NetError.security("bundle has trailing bytes") }
        guard let want = Bytes.unb64(header.sha256), Bytes.same(Bytes.sha256(out), want) else { throw NetError.security("bundle content hash mismatch") }
        return out
    }
}

/// A bundle downloaded, verified and decrypted: its header and its plain content (gzipped M5PK for M5Design).
public struct VerifiedDesignBundle: Sendable {
    public let header: DesignBundleHeader
    public let content: Data
}

public enum DesignBundles {
    /// Is an offer worth downloading? Not the active / staged / trial one, not one that failed, not for a newer app.
    public static func wanted(_ offer: BundleOffer, appCode: Int, activeId: String, stagedId: String, trialId: String, failed: Set<String>) -> Bool {
        !offer.id.isEmpty && offer.id != activeId && offer.id != stagedId && offer.id != trialId && !failed.contains(offer.id) && offer.minAppCode <= appCode
    }

    /// Downloads and checks one bundle (Bundles.download): the server's signature and kid, the id, the app's version,
    /// the content key for this device, every hash. Throws NetError.security when a check fails.
    public static func download(id: String, appCode: Int, state: DeviceState, credentials: DeviceCredentials, client: DeviceAPIClient,
                                opener: any EciesOpener, progress: HTTPProgress? = nil) async throws -> VerifiedDesignBundle {
        let raw = try await client.bundle(credentials, id: id, progress: progress)
        return try await open(raw, id: id, appCode: appCode, state: state, opener: opener)
    }

    /// The checks of `download` on a file already fetched.
    public static func open(_ raw: Data, id: String, appCode: Int, state: DeviceState, opener: any EciesOpener) async throws -> VerifiedDesignBundle {
        let file = try DesignBundleFile.parse(raw)
        guard file.header.id == id else { throw NetError.security("the server sent another bundle") }
        guard file.header.kid == state.serverKid, file.verify(serverKey: state.serverKey) else { throw NetError.security("the bundle's signature is not the server's") }
        guard file.header.minAppCode <= appCode else { throw NetError.security("the bundle needs a newer app") }
        guard let wire = file.recipient(deviceId: state.deviceId) else { throw NetError.security("the bundle is not encrypted for this device") }
        var cek = try await opener.open(wire, deviceId: state.deviceId, purpose: "bundle|\(file.header.id)")
        defer { cek.resetBytes(in: 0..<cek.count) }
        guard cek.count == 32 else { throw NetError.security("bad bundle key") }
        return VerifiedDesignBundle(header: file.header, content: try file.decrypt(cek: cek))
    }
}
