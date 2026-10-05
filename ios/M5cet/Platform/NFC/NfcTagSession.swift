// One reading with the system NFC sheet (Android: reader mode while an op is
// armed, ReaderMode / InternalReader): begin, wait for a card, connect, run the
// commands, end with a success or an error text.
//
// Concurrency (Swift 6): Core NFC's sessions and tags are not Sendable and call
// back on the dispatch queue they were given. This actor *is* that queue — its
// executor is the session's DispatchSerialQueue — so the delegate callbacks enter
// it synchronously (`assumeIsolated`), every Core NFC object stays inside it, and
// only Sendable values (bytes, CardIdentity, NdefRecord) leave it. The readers of
// M5NFC run outside (on the cooperative pool) and reach the card through
// `CoreNFCTransport`, which calls back in here for each command.
//
// Each command's completion is tracked (`PendingCalls`), so a session that ends
// — the person closes the sheet, iOS's 60 s limit, the card leaves, the task is
// cancelled — fails every command still waiting instead of leaving it hanging.

import Dispatch
import Foundation
import M5NFC
import Synchronization

actor NfcTagSession {
    /// Timing of the sheet (Apple's sample restarts polling ~500 ms after a "multiple tags" message).
    struct Timing: Sendable {
        var restartDelay: Duration = .milliseconds(500)
        /// How long to wait for the system's didInvalidate before letting the driver go anyway.
        var releaseGrace: Duration = .seconds(5)
    }

    /// Which detected tags a reading takes (others: "This card can't do that", polling again).
    typealias Accept = @Sendable (NfcTagKind) -> Bool

    nonisolated let queue: DispatchSerialQueue
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    let request: NfcSessionRequest
    let texts: NfcSheetTexts
    /// The device's capabilities (`NfcCapabilities.coreNFCiPhone`, + `.emulation` with HCE); a tag gets their intersection with its own.
    let deviceCapabilities: NfcCapabilities
    /// Info.plist's AIDs: SELECT of anything else is refused before it reaches the card.
    let allowedAids: [String]
    let timing: Timing
    private let factory: NfcSessionDriverFactory

    private var driver: (any NfcSessionDriver)?
    private var started = false
    private(set) var active = false
    /// How the session ended (nil while it runs).
    private(set) var end: NfcErrorMap.SessionEnd?
    private var waiter: CheckedContinuation<CoreNFCTransport, any Error>?
    private var accept: Accept = { _ in true }
    private var waitTimer: Task<Void, Never>?
    private var restartTask: Task<Void, Never>?
    /// The connected tag, and which connection it is (a restart makes earlier transports stale).
    private var tag: (any NfcTagHandle)?
    /// The tag being connected (Core NFC's connect completes on the session queue).
    private var connecting: (any NfcTagHandle)?
    private var generation = 0
    nonisolated let pending = PendingCalls()

    /// The sheet's texts so far (newest last) — what the person saw; tests read it.
    private(set) var alerts: [String] = []

    init(request: NfcSessionRequest, texts: NfcSheetTexts, deviceCapabilities: NfcCapabilities, allowedAids: [String],
         timing: Timing = Timing(), factory: @escaping NfcSessionDriverFactory) {
        queue = DispatchSerialQueue(label: "cz.m5cet.nfc.session")
        self.request = request
        self.texts = texts
        self.deviceCapabilities = deviceCapabilities
        self.allowedAids = allowedAids
        self.timing = timing
        self.factory = factory
    }

    /* ------------------------------------------------------------ the card */

    /// Starts the sheet (if not yet) and waits for an accepted card, connected — at most `timeout`
    /// (nil: until iOS ends the session). Throws NfcError: cancelled, unsupported, io (timeout / busy).
    func waitForCard(timeout: Duration?, accept: @escaping Accept = { _ in true }) async throws -> CoreNFCTransport {
        if let end { throw NfcErrorMap.error(for: end) }
        if Task.isCancelled { throw NfcError(.cancelled, "Cancelled") }
        self.accept = accept
        if !started {
            started = true
            guard let d = factory(request, queue, NfcSessionEvents(session: self)) else {
                end = .unavailable("This device has no NFC reader (iPad and Apple Watch have none).")
                throw NfcErrorMap.error(for: end!)
            }
            driver = d
            setAlert(request.alert)
            d.begin()
        } else {
            setAlert(request.alert)
            driver?.restartPolling()
        }
        tag = nil
        generation += 1
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<CoreNFCTransport, any Error>) in
                waiter = c
                if let timeout {
                    waitTimer = Task { [weak self] in
                        try? await Task.sleep(for: timeout)
                        if Task.isCancelled { return }
                        await self?.waitTimedOut(timeout)
                    }
                }
            }
        } onCancel: {
            self.cancel()
        }
    }

    /// The error of a wait that saw no card in time.
    nonisolated static func noCard(_ seconds: Int) -> NfcError { NfcError(.io, "No card was presented within \(seconds) s.") }

    private func waitTimedOut(_ timeout: Duration) {
        guard waiter != nil else { return }
        let s = Int(timeout.components.seconds)
        finishWaiting(.failure(Self.noCard(s)))
        stop(errorMessage: texts.timeout(s), end: .timeout)
    }

    private func finishWaiting(_ r: Result<CoreNFCTransport, any Error>) {
        waitTimer?.cancel()
        waitTimer = nil
        guard let w = waiter else { return }
        waiter = nil
        w.resume(with: r)
    }

    /* ------------------------------------------------------------ the sheet */

    /// Sets the sheet's text.
    func setAlert(_ text: String) {
        guard end == nil else { return } // the sheet is closing: a late progress text does not replace its last word
        alerts.append(text)
        driver?.alertMessage = text
    }

    /// Ends the session as a success (the sheet shows `message` with a check mark).
    func succeed(_ message: String? = nil) {
        if let message { setAlert(message) }
        stop(errorMessage: nil, end: .byApp)
    }

    /// Ends the session with an error text on the sheet.
    func fail(_ message: String) {
        stop(errorMessage: message, end: .byApp)
    }

    /// Ends the session from anywhere (the task was cancelled, the screen closed): every waiting command fails.
    nonisolated func cancel() {
        pending.failAll(NfcError(.cancelled, "Cancelled"))
        queue.async { self.assumeIsolated { $0.stop(errorMessage: nil, end: .userCancelled) } }
    }

    private func stop(errorMessage: String?, end e: NfcErrorMap.SessionEnd) {
        guard end == nil else { return }
        end = e
        restartTask?.cancel()
        finishWaiting(.failure(NfcErrorMap.error(for: e)))
        pending.failAll(NfcErrorMap.error(for: e))
        tag = nil
        if let d = driver {
            if let m = errorMessage { alerts.append(m) }
            d.invalidate(errorMessage: errorMessage)
            // The system answers with didInvalidate; let the driver go then (or after a grace period).
            let grace = timing.releaseGrace
            Task { [weak self] in
                try? await Task.sleep(for: grace)
                await self?.releaseDriver()
            }
        }
    }

    private func releaseDriver() { driver = nil }

    /* ------------------------------------------------- the driver's callbacks */

    func didBecomeActive() { active = true }

    func didDetect(_ tags: [any NfcTagHandle]) {
        guard end == nil, waiter != nil, let d = driver else { return }
        if tags.count > 1 {
            setAlert(texts.multipleTags)
            restartLater()
            return
        }
        guard let t = tags.first else { return }
        if !accept(t.kind) {
            setAlert(texts.notThisCard)
            restartLater()
            return
        }
        let gen = generation
        connecting = t
        d.connect(t) { [weak self] error in
            guard let self else { return }
            self.queue.async { self.assumeIsolated { $0.connected(gen, error) } }
        }
    }

    private func connected(_ gen: Int, _ error: (any Error)?) {
        guard let t = connecting, end == nil, gen == generation, waiter != nil else { return }
        connecting = nil
        if let error {
            let e = NfcErrorMap.command(error)
            if e.code == .cardGone { setAlert(request.alert); restartLater(); return } // it left while connecting: look again
            finishWaiting(.failure(e))
            stop(errorMessage: texts.failure(e), end: .byApp)
            return
        }
        tag = t
        setAlert(texts.reading)
        // An Ultralight's GET_VERSION tells an NTAG (Android TagTech.looksNtag); the rest is public activation data.
        if case .miFare("ultralight", _) = t.kind {
            t.sendMiFare([0x60]) { [weak self] r in
                let ntag = TagTech.looksNtag(getVersion: try? r.get())
                guard let self else { return }
                self.queue.async { self.assumeIsolated { $0.identified(gen, ntag: ntag) } }
            }
        } else {
            identified(gen, ntag: false)
        }
    }

    /// The card's public identity; the transport goes to the reader.
    private func identified(_ gen: Int, ntag: Bool) {
        guard let t = tag, end == nil, gen == generation, waiter != nil else { return }
        let kind = t.kind
        let tech = TagTech.map(ios: kind.iosTag, ntag: ntag)
        let memory = NfcCatalog.techInfo(tech).memory
        var selected: String? = nil
        if case .iso7816(let aid, _, _, _) = kind { selected = aid.uppercased() }
        let id = CardIdentity(uid: M5NFC.Hex.encode(t.identifier), tech: tech, ats: kind.historicalBytes.map { M5NFC.Hex.encode($0) },
                              memory: memory.isEmpty ? nil : memory, selectedAid: selected)
        let caps = kind.capabilities.intersection(deviceCapabilities)
        finishWaiting(.success(CoreNFCTransport(session: self, generation: gen, kind: kind, identity: id, capabilities: caps)))
    }

    private func restartLater() {
        restartTask?.cancel()
        let delay = timing.restartDelay
        restartTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            if Task.isCancelled { return }
            await self?.restartNow()
        }
    }

    private func restartNow() {
        guard end == nil, waiter != nil else { return }
        setAlert(request.alert)
        driver?.restartPolling()
    }

    func didInvalidate(_ error: any Error) {
        active = false
        let e = NfcErrorMap.sessionEnd(error)
        if end == nil {
            end = e
            finishWaiting(.failure(NfcErrorMap.error(for: e)))
            pending.failAll(NfcErrorMap.error(for: e))
            tag = nil
        }
        driver = nil
    }

    /* ------------------------------------------------------------ commands */

    /// The connected tag of this transport's connection, or why there is none.
    private func current(_ gen: Int) throws -> any NfcTagHandle {
        if let end { throw NfcErrorMap.error(for: end) }
        guard gen == generation, let t = tag else { throw NfcError.cardGone("the card was replaced by another one") }
        return t
    }

    /// One Core NFC call, its completion tracked: the session ending or the task's cancellation fails it.
    private func call<T: Sendable>(_ gen: Int, _ start: (any NfcTagHandle, @escaping NfcCompletion<T>) throws -> Void) async throws -> T {
        if Task.isCancelled { throw NfcError(.cancelled, "Cancelled") }
        let t = try current(gen)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<T, any Error>) in
                let id = pending.add { c.resume(throwing: $0) }
                do {
                    try start(t) { [pending] result in
                        guard pending.take(id) else { return }
                        c.resume(with: result.mapError { NfcErrorMap.command($0) })
                    }
                } catch {
                    if pending.take(id) { c.resume(throwing: error) }
                }
            }
        } onCancel: {
            self.cancel()
        }
    }

    /// An APDU: data ‖ SW1 SW2, exactly as the card answered (61xx / 6Cxx included).
    func transmit(_ apdu: [UInt8], _ gen: Int) async throws -> [UInt8] {
        let frame: ApduFrame
        do { frame = try ApduFrame.parse(apdu) } catch { throw NfcError(.invalidArgument, "not an APDU: \(error.reason)") }
        if frame.data.count > ApduFrame.maxData || frame.expectedResponseLength > ApduFrame.maxLe {
            throw NfcError(.invalidArgument, "the APDU is longer than Core NFC sends")
        }
        if let why = CoreNFCRules.selectRefusal(frame, allowed: allowedAids) { throw NfcError(.unsupported, why) }
        let reply: ApduReply = try await call(gen) { t, done in
            guard t.kind.isoDep else { throw NfcError.unsupported("this card does not talk ISO 7816 (it is not an ISO-DEP card)") }
            t.sendAPDU(frame, completion: done)
        }
        return reply.bytes
    }

    func mifare(_ frame: [UInt8], _ gen: Int) async throws -> [UInt8] {
        try await call(gen) { t, done in
            guard case .miFare = t.kind else { throw NfcError.unsupported("this reader does not send MIFARE commands to this card") }
            t.sendMiFare(frame, completion: done)
        }
    }

    func ndefStatus(_ gen: Int) async throws -> NdefStatus {
        try await call(gen) { t, done in t.queryNdefStatus(completion: done) }
    }

    func readNdef(_ gen: Int) async throws -> [NdefRecord] {
        try await call(gen) { t, done in t.readNdef(completion: done) }
    }

    func writeNdef(_ records: [NdefRecord], _ gen: Int) async throws {
        try await call(gen) { t, done in t.writeNdef(records, completion: done) }
    }

    func writeLock(_ gen: Int) async throws {
        try await call(gen) { t, done in t.writeLock(completion: done) }
    }

    func readBlock(_ block: Int, _ gen: Int) async throws -> [UInt8] {
        try await call(gen) { t, done in
            guard case .iso15693 = t.kind else { throw NfcError.unsupported("not an ISO 15693 tag") }
            t.readBlock(block, completion: done)
        }
    }

    func writeBlock(_ block: Int, _ data: [UInt8], _ gen: Int) async throws {
        try await call(gen) { t, done in
            guard case .iso15693 = t.kind else { throw NfcError.unsupported("not an ISO 15693 tag") }
            t.writeBlock(block, data, completion: done)
        }
    }

    func felicaSystemCodes(_ gen: Int) async throws -> [[UInt8]] {
        try await call(gen) { t, done in
            guard case .feliCa = t.kind else { throw NfcError.unsupported("not a FeliCa card") }
            t.felicaSystemCodes(completion: done)
        }
    }

    func felicaPmm(_ systemCode: [UInt8], _ gen: Int) async throws -> [UInt8] {
        try await call(gen) { t, done in
            guard case .feliCa = t.kind else { throw NfcError.unsupported("not a FeliCa card") }
            t.felicaPmm(systemCode: systemCode, completion: done)
        }
    }
}

/// The commands waiting for Core NFC's completion: each resumed exactly once — by its completion, or by
/// `failAll` when the session ends first.
final class PendingCalls: Sendable {
    private let calls = Mutex<(next: Int, fail: [Int: @Sendable (any Error) -> Void])>((0, [:]))

    /// Registers a call; `fail` resumes it with an error.
    func add(_ fail: @escaping @Sendable (any Error) -> Void) -> Int {
        calls.withLock { s in
            s.next += 1
            s.fail[s.next] = fail
            return s.next
        }
    }

    /// Takes the call out; false when it was already resumed (by `failAll`).
    func take(_ id: Int) -> Bool { calls.withLock { $0.fail.removeValue(forKey: id) != nil } }

    func failAll(_ error: any Error) {
        let all = calls.withLock { s in
            let f = Array(s.fail.values)
            s.fail.removeAll()
            return f
        }
        for f in all { f(error) }
    }

    var count: Int { calls.withLock { $0.fail.count } }
}
