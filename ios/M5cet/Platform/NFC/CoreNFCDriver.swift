// The real radio: NFCTagReaderSession and the four Core NFC tag types behind the
// seams of NfcSeams.swift (Android: NfcAdapter.enableReaderMode with
// FLAG_READER_NFC_A | B | F | V and the tech classes). Everything here runs on
// the session's queue — Core NFC calls the delegate and the completions there,
// and NfcTagSession (whose executor is that queue) is the only caller.
//
// iPhone only: on iPad, the simulator and Apple Watch `readingAvailable` is false
// and no session is made.

import CoreNFC
import Foundation
import M5NFC

/// NFCTagReaderSession as an `NfcSessionDriver`; also its delegate.
final class CoreNFCSessionDriver: NSObject, NfcSessionDriver, NFCTagReaderSessionDelegate {
    private let events: NfcSessionEvents
    private var session: NFCTagReaderSession?

    /// Whether this device reads NFC tags at all (iPhone 7 and later; never iPad / simulator / watch).
    static var readingAvailable: Bool { NFCTagReaderSession.readingAvailable }

    /// The factory NfcService uses: nil when there is no reader.
    static let factory: NfcSessionDriverFactory = { request, queue, events in
        guard NFCTagReaderSession.readingAvailable else { return nil }
        return CoreNFCSessionDriver(request: request, queue: queue, events: events)
    }

    private init?(request: NfcSessionRequest, queue: DispatchSerialQueue, events: NfcSessionEvents) {
        self.events = events
        super.init()
        var polling: NFCTagReaderSession.PollingOption = []
        if request.polling.contains(.iso14443) { polling.insert(.iso14443) }
        if request.polling.contains(.iso15693) { polling.insert(.iso15693) }
        if request.polling.contains(.iso18092) { polling.insert(.iso18092) }
        if request.polling.contains(.pace) { polling.insert(.pace) }
        if #available(iOS 26.4, *) {
            // Per reading: only the AIDs it needs are tried at discovery (the e-ID before a payment directory).
            let config = NFCTagReaderSession.Configuration(pollingOption: polling, iso7816SelectIdentifiers: request.aids, feliCaSystemCodes: [])
            session = NFCTagReaderSession(configuration: config, delegate: self, queue: queue)
        } else {
            guard let s = NFCTagReaderSession(pollingOption: polling, delegate: self, queue: queue) else { return nil }
            session = s
        }
        session?.alertMessage = request.alert
    }

    var alertMessage: String {
        get { session?.alertMessage ?? "" }
        set { session?.alertMessage = newValue }
    }

    func begin() { session?.begin() }
    func restartPolling() { session?.restartPolling() }

    func invalidate(errorMessage: String?) {
        if let m = errorMessage { session?.invalidate(errorMessage: m) } else { session?.invalidate() }
    }

    func connect(_ tag: any NfcTagHandle, completion: @escaping @Sendable ((any Error)?) -> Void) {
        guard let t = tag as? CoreNFCTag, let session else { completion(NfcError.cardGone()); return }
        session.connect(to: t.tag, completionHandler: completion)
    }

    // NFCTagReaderSessionDelegate — on the session queue.

    func tagReaderSessionDidBecomeActive(_ session: NFCTagReaderSession) { events.becameActive() }

    func tagReaderSession(_ session: NFCTagReaderSession, didInvalidateWithError error: any Error) {
        events.invalidated(error)
        self.session = nil
    }

    func tagReaderSession(_ session: NFCTagReaderSession, didDetect tags: [NFCTag]) {
        events.detected(tags.map { CoreNFCTag($0) })
    }
}

/// One Core NFC tag as an `NfcTagHandle`.
final class CoreNFCTag: NfcTagHandle {
    let tag: NFCTag
    let kind: NfcTagKind
    let identifier: [UInt8]

    init(_ tag: NFCTag) {
        self.tag = tag
        switch tag {
        case .iso7816(let t):
            var pace = false
            if #available(iOS 26.4, *) { pace = t.supportsPACE }
            kind = .iso7816(initialSelectedAid: t.initialSelectedAID, historicalBytes: t.historicalBytes.map { [UInt8]($0) },
                            applicationData: t.applicationData.map { [UInt8]($0) }, supportsPace: pace)
            identifier = [UInt8](t.identifier)
        case .miFare(let t):
            let family: String
            switch t.mifareFamily {
            case .ultralight: family = "ultralight"
            case .plus: family = "plus"
            case .desfire: family = "desfire"
            default: family = "unknown"
            }
            kind = .miFare(family: family, historicalBytes: t.historicalBytes.map { [UInt8]($0) })
            identifier = [UInt8](t.identifier)
        case .iso15693(let t):
            kind = .iso15693(icManufacturer: t.icManufacturerCode)
            identifier = [UInt8](t.identifier)
        case .feliCa(let t):
            kind = .feliCa(idm: [UInt8](t.currentIDm), systemCode: [UInt8](t.currentSystemCode))
            identifier = [UInt8](t.currentIDm)
        @unknown default:
            kind = .miFare(family: "unknown", historicalBytes: nil)
            identifier = []
        }
    }

    var isAvailable: Bool { tag.isAvailable }

    /// The tag's NDEF side (every Core NFC tag type is an NFCNDEFTag).
    private var ndef: any NFCNDEFTag {
        switch tag {
        case .iso7816(let t): return t
        case .miFare(let t): return t
        case .iso15693(let t): return t
        case .feliCa(let t): return t
        @unknown default: fatalError("a Core NFC tag type this build does not know")
        }
    }

    static func apdu(_ f: ApduFrame) -> NFCISO7816APDU {
        NFCISO7816APDU(instructionClass: f.cla, instructionCode: f.ins, p1Parameter: f.p1, p2Parameter: f.p2,
                       data: Data(f.data), expectedResponseLength: f.expectedResponseLength)
    }

    func sendAPDU(_ apdu: ApduFrame, completion: @escaping NfcCompletion<ApduReply>) {
        let reply: @Sendable (Result<NFCISO7816ResponseAPDU, any Error>) -> Void = { r in
            completion(r.map { ApduReply(data: $0.payload.map { [UInt8]($0) } ?? [], sw1: $0.statusWord1, sw2: $0.statusWord2) })
        }
        switch tag {
        case .iso7816(let t): t.sendCommand(apdu: Self.apdu(apdu), resultHandler: reply)
        case .miFare(let t): t.sendMiFareISO7816Command(Self.apdu(apdu), resultHandler: reply)
        default: completion(.failure(NfcError.unsupported("this card does not talk ISO 7816")))
        }
    }

    func sendMiFare(_ frame: [UInt8], completion: @escaping NfcCompletion<[UInt8]>) {
        guard case .miFare(let t) = tag else { completion(.failure(NfcError.unsupported("not a MIFARE tag"))); return }
        t.sendMiFareCommand(commandPacket: Data(frame)) { r in completion(r.map { [UInt8]($0) }) }
    }

    func queryNdefStatus(completion: @escaping NfcCompletion<NdefStatus>) {
        ndef.queryNDEFStatus { status, capacity, error in
            if let error { completion(.failure(error)); return }
            let s: NdefStatus.State
            switch status {
            case .readWrite: s = .readWrite
            case .readOnly: s = .readOnly
            default: s = .notSupported
            }
            completion(.success(NdefStatus(state: s, capacity: capacity)))
        }
    }

    func readNdef(completion: @escaping NfcCompletion<[NdefRecord]>) {
        ndef.readNDEF { message, error in
            if let error {
                // An NDEF tag with nothing on it: no records (Android: getNdefMessage() == null).
                if NfcErrorMap.code(error) == NfcErrorMap.ndefZeroLengthMessage { completion(.success([])) } else { completion(.failure(error)) }
                return
            }
            completion(.success((message?.records ?? []).map(Self.record)))
        }
    }

    func writeNdef(_ records: [NdefRecord], completion: @escaping NfcCompletion<Void>) {
        let message = NFCNDEFMessage(records: records.map(Self.payload))
        ndef.writeNDEF(message) { error in completion(error.map { .failure($0) } ?? .success(())) }
    }

    func writeLock(completion: @escaping NfcCompletion<Void>) {
        ndef.writeLock { error in completion(error.map { .failure($0) } ?? .success(())) }
    }

    func readBlock(_ block: Int, completion: @escaping NfcCompletion<[UInt8]>) {
        guard case .iso15693(let t) = tag else { completion(.failure(NfcError.unsupported("not an ISO 15693 tag"))); return }
        t.readSingleBlock(requestFlags: [.highDataRate], blockNumber: UInt8(truncatingIfNeeded: block)) { r in completion(r.map { [UInt8]($0) }) }
    }

    func writeBlock(_ block: Int, _ data: [UInt8], completion: @escaping NfcCompletion<Void>) {
        guard case .iso15693(let t) = tag else { completion(.failure(NfcError.unsupported("not an ISO 15693 tag"))); return }
        t.writeSingleBlock(requestFlags: [.highDataRate], blockNumber: UInt8(truncatingIfNeeded: block), dataBlock: Data(data)) { error in
            completion(error.map { .failure($0) } ?? .success(()))
        }
    }

    func felicaSystemCodes(completion: @escaping NfcCompletion<[[UInt8]]>) {
        guard case .feliCa(let t) = tag else { completion(.failure(NfcError.unsupported("not a FeliCa card"))); return }
        t.requestSystemCode { r in completion(r.map { $0.map { [UInt8]($0) } }) }
    }

    func felicaPmm(systemCode: [UInt8], completion: @escaping NfcCompletion<[UInt8]>) {
        guard case .feliCa(let t) = tag else { completion(.failure(NfcError.unsupported("not a FeliCa card"))); return }
        t.polling(systemCode: Data(systemCode), requestCode: .noRequest, timeSlot: .max1) { r in
            completion(r.map { [UInt8]($0.manufactureParameter) })
        }
    }

    /// NFCNDEFPayload → M5NFC's record.
    static func record(_ p: NFCNDEFPayload) -> NdefRecord {
        NdefRecord(tnf: p.typeNameFormat.rawValue, type: [UInt8](p.type), id: [UInt8](p.identifier), payload: [UInt8](p.payload))
    }

    /// M5NFC's record → NFCNDEFPayload.
    static func payload(_ r: NdefRecord) -> NFCNDEFPayload {
        NFCNDEFPayload(format: NFCTypeNameFormat(rawValue: r.tnf) ?? .unknown, type: Data(r.type), identifier: Data(r.id), payload: Data(r.payload))
    }
}
