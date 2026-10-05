// M5NFC's CardTransport over Core NFC — one per connected tag (Android: the
// android.nfc.Tag a reader got, with IsoDep / MifareUltralight / Ndef / NfcV /
// NfcF; ModelNfcDevice.TagCard, CardOps). Every call goes into the session actor
// (NfcTagSession), which owns the Core NFC tag; this object holds only Sendable
// values, so the readers of M5NFC (EmvReader, MrtdReader, TemplateRunner,
// ModelNfc) use it from any task.
//
// `capabilities` are the device's (`NfcCapabilities.coreNFCiPhone`) narrowed to
// what this tag does: an Ultralight answers MIFARE commands but no APDUs, an
// ISO 7816 card no MIFARE commands — so ModelNfc's "not an ISO-DEP card" and
// NfcPlatform's limits come out as on Android. What iOS cannot do at all
// (MIFARE Classic, raw frames, payment AIDs) is never in them.

import Foundation
import M5NFC

final class CoreNFCTransport: CardTransport, Sendable {
    let session: NfcTagSession
    /// Which connection of the session this is (a restart of polling makes it stale: "card gone").
    let generation: Int
    let kind: NfcTagKind
    let identity: CardIdentity
    let capabilities: NfcCapabilities

    init(session: NfcTagSession, generation: Int, kind: NfcTagKind, identity: CardIdentity, capabilities: NfcCapabilities) {
        self.session = session; self.generation = generation; self.kind = kind; self.identity = identity; self.capabilities = capabilities
    }

    /* ---------------------------------------------------------- CardTransport */

    func transmit(_ apdu: [UInt8]) async throws -> [UInt8] {
        guard capabilities.contains(.iso7816) || capabilities.contains(.desfire) else {
            throw NfcError.unsupported("\(identity.label) is not an ISO-DEP card — it does not take APDUs")
        }
        return try await session.transmit(apdu, generation)
    }

    func identify() async throws -> CardIdentity { identity }

    func mifareCommand(_ frame: [UInt8]) async throws -> [UInt8] {
        guard capabilities.contains(.mifareUltralight) else { throw NfcError.unsupported("this reader does not send MIFARE commands to this card") }
        guard !frame.isEmpty else { throw NfcError(.invalidArgument, "an empty MIFARE command") }
        return try await session.mifare(frame, generation)
    }

    // rawFrame: M5NFC's default — "raw ISO 14443-3 frames are not available on this device (iOS sends APDUs only)".

    /// The records (empty for an empty tag); nil when the tag is not NDEF formatted.
    func readNdef() async throws -> [NdefRecord]? {
        guard capabilities.contains(.ndefRead) else { return nil }
        let status = try await session.ndefStatus(generation)
        if status.state == .notSupported { return nil }
        return try await session.readNdef(generation)
    }

    func writeNdef(_ records: [NdefRecord]) async throws { _ = try await writeMessage(records) }

    /* --------------------------------------------------------------- beyond */

    /// NDEF state and capacity (Android Ndef.getMaxSize / isWritable).
    func ndefStatus() async throws -> NdefStatus {
        guard capabilities.contains(.ndefRead) else { return NdefStatus(state: .notSupported, capacity: 0) }
        return try await session.ndefStatus(generation)
    }

    /// Writes an NDEF message onto whatever the tag takes — Android CardOps.ndefWriteAny: an NDEF tag through
    /// Core NFC (writable, large enough), a blank Ultralight / NTAG straight into its user pages (the CC first).
    /// Returns the message's byte count. MIFARE Classic does not exist on iOS.
    func writeMessage(_ records: [NdefRecord]) async throws -> Int {
        guard capabilities.contains(.ndefWrite) else { throw NfcWriteFailure(.notWritable, needed: 0, available: 0) }
        let bytes = try Ndef.encodeMessage(records)
        let status = try await session.ndefStatus(generation)
        switch status.state {
        case .readOnly: throw NfcWriteFailure(.readOnly, needed: bytes.count, available: status.capacity)
        case .readWrite:
            if status.capacity > 0 && status.capacity < bytes.count { throw NfcWriteFailure(.tooSmall, needed: bytes.count, available: status.capacity) }
            try await session.writeNdef(records, generation)
            return bytes.count
        case .notSupported:
            guard capabilities.contains(.mifareUltralight) else { throw NfcWriteFailure(.notWritable, needed: bytes.count, available: 0) }
            return try await ultralightWrite(bytes)
        }
    }

    /// A blank Type 2 tag: the CC (page 3) when it has none, then the NDEF TLV from page 4 (CardOps.ultralightNdefWrite).
    private func ultralightWrite(_ ndef: [UInt8]) async throws -> Int {
        let page3 = try? await session.mifare([0x30, 0x03], generation)
        let cc = (page3?.count ?? 0) >= 4 ? Array(page3![0..<4]) : nil
        var capacity = cc.flatMap { Ndef.parseT2Cc($0)?.dataBytes } ?? 0
        if capacity == 0 {
            // No CC: the size from GET_VERSION (NTAG213 / 215 / 216, Ultralight EV1), else a plain Ultralight's 48 B.
            let v = try? await session.mifare([0x60], generation)
            capacity = CoreNFCTransport.t2Capacity(getVersion: v)
        }
        let pages: [(page: Int, data: [UInt8])]
        do { pages = try Ndef.t2WritePages(ndef, capacity: capacity, writeCc: cc.flatMap(Ndef.parseT2Cc) == nil) }
        catch { throw NfcWriteFailure(.tooSmall, needed: Ndef.ndefTlv(ndef).count, available: capacity) }
        for p in pages {
            let ack = try await session.mifare([0xa2, UInt8(p.page)] + p.data, generation)
            if ack.count == 1 && ack[0] & 0x0f != 0x0a { throw NfcError(.cardError, "the tag refused page \(p.page) (NAK \(ack[0]))") }
        }
        return ndef.count
    }

    /// The user memory of a Type 2 tag from its GET_VERSION storage byte (NTAG21x, Ultralight EV1), else 48 B.
    static func t2Capacity(getVersion v: [UInt8]?) -> Int {
        guard let v, v.count >= 7 else { return 48 }
        switch v[6] {
        case 0x0f: return 144   // NTAG213
        case 0x11: return 504   // NTAG215
        case 0x13: return 888   // NTAG216
        case 0x0b: return 48    // Ultralight EV1 (MF0UL11)
        case 0x0e: return 128   // Ultralight EV1 (MF0UL21)
        default: return 48
        }
    }

    /// Makes the tag permanently read-only (Android Ndef.makeReadOnly). Irreversible — `NfcService.lockTag`
    /// asks for the explicit confirmation before it gets here.
    func writeLock() async throws {
        guard capabilities.contains(.ndefLock) else { throw NfcError.unsupported("this tag cannot be locked") }
        let status = try await session.ndefStatus(generation)
        if status.state == .notSupported { throw NfcError(.cardError, "not-ndef") }
        if status.state == .readOnly { return }
        try await session.writeLock(generation)
    }

    /// ISO 15693: the blocks (Read Single Block, high data rate) until one fails, at most `maxBlocks` (CardOps.nfcvRead).
    func iso15693Read(maxBlocks: Int = 64) async throws -> NfcJSONObject {
        guard capabilities.contains(.iso15693) else { throw NfcError.unsupported("not an ISO 15693 tag") }
        var blocks = [NfcJSON]()
        for b in 0..<maxBlocks {
            do { blocks.append(.string(M5NFC.Hex.encode(try await session.readBlock(b, generation)))) }
            catch let e as NfcError where e.code == .cardGone || e.code == .cancelled { throw e }
            catch { break }
        }
        return ["uid": .string(identity.uid), "blocks": .array(blocks)]
    }

    /// ISO 15693 Write Single Block (CardOps.nfcvWrite).
    func iso15693Write(block: Int, data: [UInt8]) async throws {
        guard capabilities.contains(.iso15693) else { throw NfcError.unsupported("not an ISO 15693 tag") }
        guard (0...255).contains(block), !data.isEmpty else { throw NfcError(.invalidArgument, "a block number 0–255 and its data") }
        try await session.writeBlock(block, data, generation)
    }

    /// FeliCa: IDm, the current system code, PMm and the card's systems (CardOps.felicaSystems).
    func felicaSystems() async throws -> NfcJSONObject {
        guard capabilities.contains(.felica), case .feliCa(let idm, let code) = kind else { throw NfcError.unsupported("not a FeliCa card") }
        var out: NfcJSONObject = ["idm": .string(M5NFC.Hex.encode(idm)), "systemCode": .string(M5NFC.Hex.encode(code))]
        if let pmm = try? await session.felicaPmm(code, generation) { out["pmm"] = .string(M5NFC.Hex.encode(pmm)) }
        if let systems = try? await session.felicaSystemCodes(generation) { out["systems"] = NfcJSON(systems.map { M5NFC.Hex.encode($0) }) }
        out["note"] = .string(NfcTexts.t("nfc.note.felicaPublic", "Public systems only; a service's blocks (Read Without Encryption) need the service code."))
        return out
    }
}

/// A write that failed for a reason the person can act on (Android CardOps.NfcWriteException).
struct NfcWriteFailure: Error, Sendable, Equatable, LocalizedError {
    enum Kind: Sendable, Equatable { case readOnly, tooSmall, notWritable }
    let kind: Kind
    let needed: Int
    let available: Int

    init(_ kind: Kind, needed: Int, available: Int) { self.kind = kind; self.needed = needed; self.available = available }

    /// Android's reason words.
    var errorDescription: String? {
        switch kind {
        case .readOnly: return "read-only"
        case .tooSmall: return "too-small (needs \(needed) B, holds \(available) B)"
        case .notWritable: return "not-writable"
        }
    }

    /// The design's text for it (nfc.err.*).
    func text(_ t: NfcSheetTexts) -> String {
        switch kind {
        case .readOnly: return t.readOnly
        case .tooSmall: return t.tooSmall(needed, available)
        case .notWritable: return t.notWritable
        }
    }
}
