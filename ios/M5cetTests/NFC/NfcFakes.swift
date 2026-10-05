// A Core NFC-shaped radio for the tests (the simulator has no NFC): FakeTag is an
// NfcTagHandle (an NFCTag with its completion-handler API), FakeDriver an
// NfcSessionDriver (NFCTagReaderSession: the sheet, polling, connect, and the
// delegate callbacks on the session queue — invalidate() answers "user canceled",
// as Core NFC does). The cards behind a FakeTag are the simulated chips of
// M5Kit's M5NFC tests, ported (SimCards.swift: EMV, DESFire, ISO 7816 with
// 61xx / 6Cxx, the BAC e-passport from ICAO 9303-11), so M5NFC's readers run
// through the app's transport exactly as they would on a card.

import Foundation
import M5NFC
@testable import M5cet

/* ================================================================ the radio */

/// A card's logic: one raw APDU in, data ‖ SW out (or a thrown error: the card stopped answering).
protocol SimChip: AnyObject {
    func answer(_ apdu: [UInt8]) throws -> [UInt8]
}

final class FakeTag: NfcTagHandle, @unchecked Sendable {
    let kind: NfcTagKind
    let identifier: [UInt8]
    private let lock = NSLock()
    private var _available = true
    private var _apdus = [String]()
    private var _mifare = [String]()

    /// The card behind ISO 7816.
    var chip: SimChip?
    /// MIFARE native commands (Ultralight pages / GET_VERSION).
    var mifare: (([UInt8]) throws -> [UInt8])?
    var ndef = NdefStatus(state: .notSupported, capacity: 0)
    var records = [NdefRecord]()
    var written = [[NdefRecord]]()
    var locked = false
    var blocks = [[UInt8]]()
    var felicaCodes = [[UInt8]]()
    /// Every command fails with this from now on (a Core NFC NSError, e.g. code 100 "tag connection lost").
    var failure: (any Error)?
    /// Commands do not complete (Core NFC waiting on a slow card) — for cancellation and session-end tests.
    var hang = false
    /// Completes on another queue after this delay (Core NFC completes asynchronously); nil = inline.
    var delay: Double?

    init(_ kind: NfcTagKind, uid: [UInt8] = [0x04, 0xa2, 0x3b, 0x11, 0x22, 0x33, 0x80]) { self.kind = kind; identifier = uid }

    var isAvailable: Bool { lock.withLock { _available } }
    func leave() { lock.withLock { _available = false }; failure = NSError(domain: "NFCError", code: 100) }
    /// The APDUs the card received, hex.
    var apdus: [String] { lock.withLock { _apdus } }
    var mifareCommands: [String] { lock.withLock { _mifare } }

    private func complete<T>(_ completion: @escaping NfcCompletion<T>, _ work: () throws -> T) {
        if hang { return }
        let r: Result<T, any Error>
        if let failure { r = .failure(failure) } else { do { r = .success(try work()) } catch { r = .failure(error) } }
        nonisolated(unsafe) let result = r
        if let delay { DispatchQueue.global().asyncAfter(deadline: .now() + delay) { completion(result) } } else { completion(result) }
    }

    func sendAPDU(_ apdu: ApduFrame, completion: @escaping NfcCompletion<ApduReply>) {
        let bytes = apdu.bytes
        lock.withLock { _apdus.append(M5NFC.Hex.encode(bytes)) }
        complete(completion) {
            guard let chip else { throw NSError(domain: "NFCError", code: 102) }
            let r = try chip.answer(bytes)
            return ApduReply(data: Array(r.dropLast(2)), sw1: r[r.count - 2], sw2: r[r.count - 1])
        }
    }

    func sendMiFare(_ frame: [UInt8], completion: @escaping NfcCompletion<[UInt8]>) {
        lock.withLock { _mifare.append(M5NFC.Hex.encode(frame)) }
        complete(completion) {
            guard let mifare else { throw NSError(domain: "NFCError", code: 102) }
            return try mifare(frame)
        }
    }

    func queryNdefStatus(completion: @escaping NfcCompletion<NdefStatus>) { complete(completion) { ndef } }

    func readNdef(completion: @escaping NfcCompletion<[NdefRecord]>) {
        complete(completion) {
            guard ndef.state != .notSupported else { throw NSError(domain: "NFCError", code: 403) }
            return records
        }
    }

    func writeNdef(_ records: [NdefRecord], completion: @escaping NfcCompletion<Void>) {
        complete(completion) {
            if ndef.state == .readOnly { throw NSError(domain: "NFCError", code: 400) }
            written.append(records)
            self.records = records
        }
    }

    func writeLock(completion: @escaping NfcCompletion<Void>) {
        complete(completion) { locked = true; ndef.state = .readOnly }
    }

    func readBlock(_ block: Int, completion: @escaping NfcCompletion<[UInt8]>) {
        complete(completion) {
            guard block < blocks.count else { throw NSError(domain: "NFCError", code: 102) }
            return blocks[block]
        }
    }

    func writeBlock(_ block: Int, _ data: [UInt8], completion: @escaping NfcCompletion<Void>) {
        complete(completion) {
            guard block < blocks.count else { throw NSError(domain: "NFCError", code: 102) }
            blocks[block] = data
        }
    }

    func felicaSystemCodes(completion: @escaping NfcCompletion<[[UInt8]]>) { complete(completion) { felicaCodes } }

    func felicaPmm(systemCode: [UInt8], completion: @escaping NfcCompletion<[UInt8]>) {
        complete(completion) { [0x01, 0x20, 0x22, 0x04, 0x27, 0x67, 0x4e, 0xff] }
    }
}

/// The system sheet. Its callbacks reach the session on the session queue, as Core NFC's do.
final class FakeDriver: NfcSessionDriver, @unchecked Sendable {
    let request: NfcSessionRequest
    let queue: DispatchSerialQueue
    let events: NfcSessionEvents
    private let lock = NSLock()
    private var _alert = ""
    private var _begun = 0, _restarts = 0
    private var _invalidations = [String?]()
    /// What the "person" does when the sheet opens / polling restarts.
    var onBegin: ((FakeDriver) -> Void)?
    var onRestart: ((FakeDriver) -> Void)?
    var connectError: (any Error)?

    init(_ request: NfcSessionRequest, _ queue: DispatchSerialQueue, _ events: NfcSessionEvents) {
        self.request = request; self.queue = queue; self.events = events
    }

    var alertMessage: String {
        get { lock.withLock { _alert } }
        set { lock.withLock { _alert = newValue } }
    }
    var begun: Int { lock.withLock { _begun } }
    var restarts: Int { lock.withLock { _restarts } }
    /// invalidate(errorMessage:) calls: nil = success (the alert stays), else the error text.
    var invalidations: [String?] { lock.withLock { _invalidations } }

    func begin() {
        lock.withLock { _begun += 1 }
        queue.async {
            self.events.becameActive()
            self.onBegin?(self)
        }
    }

    func restartPolling() {
        lock.withLock { _restarts += 1 }
        queue.async { self.onRestart?(self) }
    }

    func invalidate(errorMessage: String?) {
        lock.withLock { _invalidations.append(errorMessage) }
        // Core NFC reports an app's own invalidate as "user canceled" (200).
        queue.async { self.events.invalidated(NSError(domain: "NFCError", code: 200)) }
    }

    func connect(_ tag: any NfcTagHandle, completion: @escaping @Sendable ((any Error)?) -> Void) {
        let e = connectError
        queue.async { completion(e) }
    }

    /// Tags come into the field.
    func detect(_ tags: [FakeTag]) { queue.async { self.events.detected(tags.map { $0 as any NfcTagHandle }) } }

    /// iOS ends the session (200 the person closed the sheet, 201 the 60 s limit, 203 busy…).
    func systemInvalidate(_ code: Int) { queue.async { self.events.invalidated(NSError(domain: "NFCError", code: code)) } }
}

/// The drivers a test's sessions made, and the script they follow.
final class NfcRig: @unchecked Sendable {
    private let lock = NSLock()
    private var _drivers = [FakeDriver]()
    /// Called when a sheet opens (default: nothing comes).
    var onBegin: ((FakeDriver) -> Void)?
    var onRestart: ((FakeDriver) -> Void)?
    /// No reader (iPad): the factory makes nothing.
    var noReader = false

    var drivers: [FakeDriver] { lock.withLock { _drivers } }
    var last: FakeDriver? { drivers.last }

    var factory: NfcSessionDriverFactory {
        { [self] request, queue, events in
            if noReader { return nil }
            let d = FakeDriver(request, queue, events)
            d.onBegin = onBegin
            d.onRestart = onRestart
            lock.withLock { _drivers.append(d) }
            return d
        }
    }

    /// Presents `tag` as soon as the sheet opens.
    func present(_ tag: FakeTag) { onBegin = { $0.detect([tag]) } }

    /// Waits (briefly) until `cond` holds.
    func wait(_ what: String = "condition", _ cond: @Sendable () -> Bool) async {
        for _ in 0..<300 where !cond() { try? await Task.sleep(for: .milliseconds(10)) }
    }
}

struct FakeHce: HceProbe {
    var configured = false
    var supported = false
    var isEligible = false
    func eligible() async -> Bool { isEligible }
}

/// Every text as "⟨key⟩", so the tests see which design key the sheet used.
struct KeyTexts: NfcTextProvider {
    func t(_ key: String, _ en: String) -> String { "⟨\(key)⟩" }
}

@MainActor
func makeNfcService(_ rig: NfcRig, readingAvailable: Bool = true, hce: FakeHce = FakeHce(), http: (any ShareInviteHTTP)? = nil,
                 aids: [String] = IOSAids.infoPlist) -> NfcService {
    NfcService(configuration: .init(allowedAids: aids), readingAvailable: readingAvailable, factory: rig.factory, hce: hce, kdf: M5TagKdf(), http: http,
               timing: .init(restartDelay: .milliseconds(20), releaseGrace: .milliseconds(50)))
}

/// A session with fakes (tests of the session itself).
func makeNfcSession(_ rig: NfcRig, texts: NfcSheetTexts = NfcSheetTexts(KeyTexts()), caps: NfcCapabilities = .coreNFCiPhone,
                 aids: [String] = IOSAids.infoPlist, alert: String = "HOLD") -> NfcTagSession {
    NfcTagSession(request: NfcSessionRequest(polling: .all, aids: [], alert: alert), texts: texts, deviceCapabilities: caps, allowedAids: aids,
                  timing: .init(restartDelay: .milliseconds(20), releaseGrace: .milliseconds(50)), factory: rig.factory)
}

/* ================================================================ byte helpers (M5NFC tests' Support.swift) */

func hx(_ h: String) -> [UInt8] { M5NFC.Hex.decode(h) }
func hexs(_ u: [UInt8]) -> String { M5NFC.Hex.encode(u) }
func latin(_ s: String) -> [UInt8] { M5NFC.Bytes.latin1(s) }
func bytes8(_ v: Int...) -> [UInt8] { v.map { UInt8(truncatingIfNeeded: $0) } }
func filled(_ n: Int, _ v: Int) -> [UInt8] { [UInt8](repeating: UInt8(v), count: n) }
func ok9000(_ resp: [UInt8]) -> [UInt8] { resp + [0x90, 0x00] }
func swb(_ s: Int) -> [UInt8] { [UInt8((s >> 8) & 0xff), UInt8(s & 0xff)] }

/// Tag (1–3 bytes) + DER length + the values.
func tlv(_ tag: Int, _ values: [UInt8]...) -> [UInt8] {
    let v = values.flatMap { $0 }
    var w = [UInt8]()
    if tag > 0xffff { w.append(UInt8((tag >> 16) & 0xff)) }
    if tag > 0xff { w.append(UInt8((tag >> 8) & 0xff)) }
    w.append(UInt8(tag & 0xff))
    let n = v.count
    if n < 0x80 { w.append(UInt8(n)) } else if n <= 0xff { w += [0x81, UInt8(n)] } else if n <= 0xffff { w += [0x82, UInt8(n >> 8), UInt8(n & 0xff)] }
    else { w += [0x83, UInt8(n >> 16), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)] }
    return w + v
}

func oidTLV(_ dotted: String) -> [UInt8] { tlv(0x06, Asn1.oidBytes(dotted)) }
func intTLV(_ n: Int) -> [UInt8] { tlv(0x02, [UInt8(n & 0xff)]) }

func apduData(_ cmd: [UInt8]) -> [UInt8] { cmd.count > 5 ? Array(cmd[5..<min(cmd.count, 5 + Int(cmd[4]))]) : [] }

enum NfcRepo {
    /// ios/M5cetTests/NFC/NfcFakes.swift → the repository root.
    static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static func json(_ path: String) throws -> NfcJSON { try NfcJSON.parse(try Data(contentsOf: root.appendingPathComponent(path))) }
}

/* ================================================================ the cards (M5NFC SimCards.swift) */

/// A card that refuses anything that is not a read (VERIFY, GENERATE AC, writes) — the readers must only read.
class LoggingChip: SimChip {
    var seen = [String]()
    var forbidden = [String]()
    final func answer(_ cmd: [UInt8]) throws -> [UInt8] {
        let h = hexs(cmd)
        seen.append(h)
        let cla = Int(cmd[0]), ins = Int(cmd[1])
        if ins == 0x20 || (cla == 0x80 && ins == 0xae) || ins == 0xd6 || ins == 0xdc || ins == 0xe2 { forbidden.append(h); throw NSError(domain: "NFCError", code: 102) }
        return respond(cmd)
    }
    func respond(_ cmd: [UInt8]) -> [UInt8] { swb(0x6d00) }
}

enum NfcSim {
    static let dir1 = tlv(0x61, tlv(0x4f, hx("A0000002471001")), tlv(0x50, latin("ICAO eMRTD")))
    static let dir2 = tlv(0x61, tlv(0x4f, hx("A0000000041010")), tlv(0x50, latin("MASTERCARD")), tlv(0x51, hx("3F00")))
    static let atr = tlv(0x43, bytes8(0xf0)) + tlv(0x47, bytes8(0x94, 0x81, 0xc1))
    static let pdol = hx("9F66049F02069F37045F2A02")
}

/// A plain ISO 7816-4 card: MF, EF.DIR with two records (the first through GET RESPONSE), EF.ATR answering 6Cxx first.
final class IsoSim: LoggingChip {
    var current = -1
    var pending: [UInt8]?
    override func respond(_ cmd: [UInt8]) -> [UInt8] {
        let ins = Int(cmd[1]), p1 = Int(cmd[2])
        if ins == 0xa4 {
            let d = apduData(cmd)
            let fid = d.count == 2 ? Int(d[0]) << 8 | Int(d[1]) : -1
            if [0x3f00, 0x2f00, 0x2f01].contains(fid) { current = fid; return swb(0x9000) }
            return swb(0x6a82)
        }
        if ins == 0xb2 {
            if current != 0x2f00 { return swb(0x6986) }
            if p1 == 1 { pending = NfcSim.dir1; return swb(0x6100 | NfcSim.dir1.count) }
            if p1 == 2 { return ok9000(NfcSim.dir2) }
            return swb(0x6a83)
        }
        if ins == 0xc0 {
            guard let out = pending else { return swb(0x6985) }
            pending = nil
            return ok9000(out)
        }
        if ins == 0xb0 {
            if current != 0x2f01 { return swb(0x6986) }
            let le = cmd.count == 5 ? Int(cmd[4]) : -1
            if le != NfcSim.atr.count { return swb(0x6c00 | NfcSim.atr.count) }
            return ok9000(NfcSim.atr)
        }
        return swb(0x6d00)
    }
}

/// A MIFARE DESFire EV1: GetVersion in three frames, two applications, 4 KB free, the PICC's key settings.
final class DesfireSim: LoggingChip {
    var frame = 0
    override func respond(_ cmd: [UInt8]) -> [UInt8] {
        switch hexs(cmd) {
        case "9060000000": frame = 1; return hx("04010101001A05") + swb(0x91af)
        case "90AF000000":
            if frame == 1 { frame = 2; return hx("04010101041A05") + swb(0x91af) }
            if frame == 2 { frame = 0; return hx("04112233445566BA7C1234561219") + swb(0x9100) }
            return swb(0x911c)
        case "906A000000": return hx("5634120D0C0B") + swb(0x9100)
        case "906E000000": return hx("001000") + swb(0x9100)
        case "9045000000": return hx("0F81") + swb(0x9100)
        default: return swb(0x911c)
        }
    }
}

/// An EMV card with one application (PPSE, SELECT, GPO with its PDOL checked, the AFL's record).
final class EmvSim: LoggingChip {
    let aid = "A0000000041010"
    var selected: String?
    override func respond(_ cmd: [UInt8]) -> [UInt8] {
        let cla = Int(cmd[0]), ins = Int(cmd[1])
        if ins == 0xa4 && cmd[2] == 0x04 {
            let name = hexs(apduData(cmd))
            if name == hexs(latin("2PAY.SYS.DDF01")) {
                selected = "PPSE"
                return ok9000(tlv(0x6f, tlv(0x84, latin("2PAY.SYS.DDF01")), tlv(0xa5, tlv(0xbf0c, tlv(0x61, tlv(0x4f, hx(aid)), tlv(0x50, latin("MASTERCARD")), tlv(0x87, bytes8(1)))))))
            }
            if name == aid { selected = aid; return ok9000(tlv(0x6f, tlv(0x84, hx(aid)), tlv(0xa5, tlv(0x50, latin("MASTERCARD")), tlv(0x9f38, NfcSim.pdol)))) }
            return swb(0x6a82)
        }
        if cla == 0x80 && ins == 0xca { return swb(0x6a88) }
        if cla == 0x80 && ins == 0xa8 {
            guard selected == aid else { return swb(0x6985) }
            return ok9000(tlv(0x77, tlv(0x82, hx("1980")), tlv(0x94, hx("08010100"))))
        }
        if ins == 0xb2 {
            guard selected == aid else { return swb(0x6a82) }
            if cmd[3] >> 3 == 1 && cmd[2] == 1 {
                return ok9000(tlv(0x70, tlv(0x5a, hx("5413330089020011")), tlv(0x5f24, hx("281231")), tlv(0x5f20, latin("NOVAK/JAN"))))
            }
            return swb(0x6a83)
        }
        return swb(0x6d00)
    }
}

/* ================================================================ the e-passport (M5NFC MrtdDeepTest) */

enum NfcDoc {
    static let mrz = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\nL898902C<3UTO6908061F9406236ZE184226B<<<<<10"
    static let key = MrzKey("L898902C", "690806", "940623")
    static let jpeg = bytes8(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10) + latin("JFIF") + filled(600, 7) + bytes8(0xff, 0xd9)
    static let dg1 = tlv(0x61, tlv(0x5f1f, latin(mrz.replacingOccurrences(of: "\n", with: ""))))
    static let dg2 = tlv(0x75, tlv(0x7f61, tlv(0x02, bytes8(1)), tlv(0x7f60, tlv(0xa1, tlv(0x80, bytes8(1, 1))), tlv(0x5f2e, latin("FAC\0") + [UInt8](repeating: 0, count: 40) + jpeg))))
    static let com = tlv(0x60, tlv(0x5f01, latin("0107")), tlv(0x5f36, latin("040000")), tlv(0x5c, bytes8(0x61, 0x75)))

    static func name(_ cn: String) -> [UInt8] { tlv(0x30, tlv(0x31, tlv(0x30, oidTLV("2.5.4.6"), tlv(0x13, latin("UT")))), tlv(0x31, tlv(0x30, oidTLV("2.5.4.3"), tlv(0x0c, latin(cn))))) }

    static func certificate() -> [UInt8] {
        let tbs = tlv(0x30, tlv(0xa0, intTLV(2)), tlv(0x02, bytes8(0x12, 0x34)), tlv(0x30, oidTLV("1.2.840.113549.1.1.11")), name("CSCA Utopia"),
                    tlv(0x30, tlv(0x17, latin("240101000000Z")), tlv(0x17, latin("340101000000Z"))), name("DS Utopia 1"),
                    tlv(0x30, tlv(0x30, oidTLV("1.2.840.113549.1.1.1")), tlv(0x03, bytes8(0))))
        return tlv(0x30, tbs, tlv(0x30, oidTLV("1.2.840.113549.1.1.11")), tlv(0x03, bytes8(0, 1, 2)))
    }

    static func sod(_ groups: [(Int, [UInt8])]) -> [UInt8] {
        var hashes = [UInt8]()
        for (n, g) in groups.sorted(by: { $0.0 < $1.0 }) { hashes += tlv(0x30, intTLV(n), tlv(0x04, NfcHash.sha256(g))) }
        let lds = tlv(0x30, intTLV(0), tlv(0x30, oidTLV("2.16.840.1.101.3.4.2.1")), tlv(0x30, hashes))
        let signedData = tlv(0x30, intTLV(3), tlv(0x31, tlv(0x30, oidTLV("2.16.840.1.101.3.4.2.1"))), tlv(0x30, oidTLV("2.23.136.1.1.1"), tlv(0xa0, tlv(0x04, lds))),
                           tlv(0xa0, certificate()), tlv(0x31))
        return tlv(0x77, tlv(0x30, oidTLV("1.2.840.113549.1.7.2"), tlv(0xa0, signedData)))
    }

    static func files() -> [Int: [UInt8]] {
        [0x011e: com, 0x011d: sod([(1, dg1), (2, dg2)]), 0x0101: dg1, 0x0102: dg2]
    }
}

/// A BAC chip from the spec: plain until mutual authentication, then every APDU in secure messaging.
final class BacChip: SimChip {
    var log = [String]()
    var selected = [Int]()
    let files: [Int: [UInt8]]
    let kenc: [UInt8], kmac: [UInt8]
    var rndIcc = [UInt8]()
    var ksenc: [UInt8]?, ksmac = [UInt8](), ssc = [UInt8]()
    var current: Int?

    init(_ key: MrzKey, _ files: [Int: [UInt8]]) {
        self.files = files
        let k = Bac.keys(key)
        kenc = k.kenc; kmac = k.kmac
    }

    static func inc(_ s: inout [UInt8]) { var i = s.count - 1; while i >= 0 { s[i] &+= 1; if s[i] != 0 { break }; i -= 1 } }
    static func unpad(_ d: [UInt8]) -> [UInt8] { var i = d.count - 1; while i >= 0 && d[i] == 0 { i -= 1 }; return Array(d[0..<max(0, i)]) }

    func run(_ ins: Int, _ p1: Int, _ p2: Int, _ data: [UInt8], _ le: Int?) -> ([UInt8], Int) {
        if ins == 0xa4 && p1 == 0x04 { return ([], hexs(data) == "A0000002471001" ? 0x9000 : 0x6a82) }
        if ins == 0xa4 {
            guard data.count >= 2 else { return ([], 0x6a80) }
            let fid = Int(data[0]) << 8 | Int(data[1])
            selected.append(fid)
            if files[fid] == nil { return ([], 0x6a82) }
            current = fid
            return ([], 0x9000)
        }
        if ins == 0xb0 {
            guard let c = current, let f = files[c] else { return ([], 0x6986) }
            let off = p1 << 8 | p2
            let n = le == nil || le == 0 ? 256 : le!
            let end = min(f.count, off + n)
            return (off < end ? Array(f[off..<end]) : [], off + n > f.count ? 0x6282 : 0x9000)
        }
        return ([], 0x6d00)
    }

    func answer(_ a: [UInt8]) throws -> [UInt8] {
        log.append(hexs(a))
        guard let ksenc else {
            let ins = Int(a[1]), p1 = Int(a[2]), p2 = Int(a[3])
            if ins == 0x84 { rndIcc = NfcCrypto.random(8); return rndIcc + swb(0x9000) }
            if ins == 0x82 {
                let body = Array(a[5..<(5 + Int(a[4]))])
                let eifd = Array(body[0..<32]), mifd = Array(body[32..<40])
                guard try Des.retailMac(kmac, Des.pad(eifd)) == mifd else { return swb(0x6300) }
                let s = try Des.tdesCbcDecrypt(kenc, eifd)
                let rndIfd = Array(s[0..<8]), kifd = Array(s[16..<32])
                guard Array(s[8..<16]) == rndIcc else { return swb(0x6300) }
                let kicc = NfcCrypto.random(16)
                let eicc = try Des.tdesCbcEncrypt(kenc, rndIcc + rndIfd + kicc)
                let micc = try Des.retailMac(kmac, Des.pad(eicc))
                let seed = (0..<16).map { kifd[$0] ^ kicc[$0] }
                self.ksenc = Bac.deriveKey(seed, 1); ksmac = Bac.deriveKey(seed, 2)
                ssc = Array(rndIcc[4..<8]) + Array(rndIfd[4..<8])
                return eicc + micc + swb(0x9000)
            }
            let lc = a.count > 5 ? Int(a[4]) : 0
            let le: Int? = a.count == 5 ? Int(a[4]) : a.count > 5 + lc ? Int(a[5 + lc]) : nil
            let r = run(ins, p1, p2, a.count > 5 ? Array(a[5..<(5 + lc)]) : [], le)
            return r.0 + swb(r.1)
        }
        guard a[0] & 0x0c == 0x0c else { return swb(0x6987) }
        var do87: [UInt8]?, do97: [UInt8]?, do8e: [UInt8]?
        for n in BerTlv.decode(Array(a[5..<(5 + Int(a[4]))]), recurse: false) {
            if n.tag == 0x87 { do87 = n.value } else if n.tag == 0x97 { do97 = n.value } else if n.tag == 0x8e { do8e = n.value }
        }
        BacChip.inc(&ssc)
        let macIn = Des.pad(ssc + Des.pad(Array(a[0..<4])) + (do87.map { tlv(0x87, $0) } ?? []) + (do97.map { tlv(0x97, $0) } ?? []))
        guard let mac = do8e, try Des.retailMac(ksmac, macIn) == mac else { return swb(0x6988) }
        let data = try do87.map { BacChip.unpad(try Des.tdesCbcDecrypt(ksenc, Array($0[1...]))) } ?? []
        let r = run(Int(a[1]), Int(a[2]), Int(a[3]), data, do97.map { Int($0[0]) })
        BacChip.inc(&ssc)
        let r87 = r.0.isEmpty ? [] : tlv(0x87, bytes8(0x01), try Des.tdesCbcEncrypt(ksenc, Des.pad(r.0)))
        let r99 = tlv(0x99, swb(r.1))
        let rmac = try Des.retailMac(ksmac, Des.pad(ssc + r87 + r99))
        return r87 + r99 + tlv(0x8e, rmac) + swb(0x9000)
    }
}
