// Design bundles on the device (Android update/Bundles, docs/android-architecture.md § 5):
//
//   offered (check-in) → download (GET /api/ios/bundles/:id) → verify (the pinned server key, its kid,
//   the id, the app's build) → unwrap (the device's encryption key) → decrypt → check (hashes, the
//   container, the manifest, every screen parses: M5Design BundleVerifier) → staged, kept sealed by
//   the vault's SYS key (readable while locked — the lock screen itself is drawn from the design)
//   → the trial at the next start → good after 20 s, or back to the last good one / the built-in.
//
// Storage follows Android: the ledger is the SYS record "bundles" (M5Design BundleLedger, Codable),
// each content is Application Support/m5/bundles/<id>.bin = Vault.seal(.sys, "bundle-<id>", content)
// (Data Protection completeUntilFirstUserAuthentication; the wipe removes it with the rest of m5/).
//
// For the Renderer (the integration connects it): `design` is the bundle's design (nil: use the
// built-in default-design.json), `revision` changes with it, `onChange` tells. A screen of a trial
// that fails to draw → `renderFailed(screen:message:)`; the app keeps running 20 s → `confirmTrial()`
// (scheduled by `loadActive`). iOS has no crash handler: a trial that was started three times without
// reaching its 20 s is treated as crashed (Android: Bundles.onCrash) and rolled back.

import Foundation
import M5Design
import M5Net
import Observation
import os

/// Where the ledger and the sealed contents live (the vault in the app, memory in tests).
protocol BundleStorage: AnyObject, Sendable {
    func loadLedger() -> BundleLedger
    func saveLedger(_ ledger: BundleLedger)
    /// The trial counter ({id, starts}).
    func loadTrial() -> (id: String, starts: Int)
    func saveTrial(id: String, starts: Int)
    func content(_ id: String) throws -> Data
    func keep(_ id: String, content: Data) throws
    func delete(_ id: String)
    func keptIds() -> [String]
    func removeAll()
}

@MainActor
@Observable
final class DesignBundleStore {
    enum Download: String, Sendable { case none, available, downloading, ready, failed }

    /// The active bundle's design (with the built-in one behind its texts), nil: the built-in design.
    private(set) var design: Design?
    /// The bundle in use ("" = built-in).
    private(set) var activeId = ""
    private(set) var activeVersion = "built-in"
    /// The bundle in use is on trial (not yet confirmed).
    private(set) var onTrial = false
    /// Changes whenever `design` does (SwiftUI can key a reload on it).
    private(set) var revision = 0
    /// The newest offer's download.
    private(set) var download: Download = .none
    private(set) var progress = 0.0
    /// The staged bundle's version ("" when none) — "Install" makes it the trial (`installNow`).
    private(set) var stagedVersion = ""

    @ObservationIgnored private let storage: any BundleStorage
    @ObservationIgnored private let crypto: any BundleCrypto
    @ObservationIgnored private let appCode: Int
    @ObservationIgnored private let now: () -> Double
    @ObservationIgnored private var ledger: BundleLedger
    @ObservationIgnored private var trialTask: Task<Void, Never>?
    @ObservationIgnored private var observers: [(Design?) -> Void] = []
    @ObservationIgnored private var offered: BundleOffer?
    @ObservationIgnored private let logger = Logger(subsystem: "cz.m5cet.app", category: "bundle")
    /// The built-in design (Bundle.main m5/default-design.json) that backs a bundle's texts.
    @ObservationIgnored var builtIn: () -> Design? = { DesignBundleStore.loadBuiltIn() }
    /// Events for the server ("bundle-installed", "bundle-failed", "bundle-rollback", "update-available").
    @ObservationIgnored var event: (String, NetJSON) -> Void = { _, _ in }
    /// A staged bundle is ready (Android MainActivity.offerUpdate("bundle")); a rollback happened.
    @ObservationIgnored var onReady: ((String) -> Void)?
    @ObservationIgnored var onRolledBack: ((String) -> Void)?
    /// How long a trial must run.
    @ObservationIgnored var trialDuration: Duration = .milliseconds(Int(BundleLedger.trialMs))
    /// Started trials that never reached their time before it counts as a crash.
    static let crashStarts = 3

    init(storage: any BundleStorage, crypto: any BundleCrypto, appCode: Int, now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.storage = storage
        self.crypto = crypto
        self.appCode = appCode
        self.now = now
        ledger = storage.loadLedger()
    }

    /// The ledger as stored (tests, the console's status).
    var state: BundleLedger { ledger }

    /// Called with the new design (nil: built-in) after every change.
    func onChange(_ observer: @escaping (Design?) -> Void) { observers.append(observer) }

    private func changed(_ d: Design?) {
        design = d
        revision += 1
        for o in observers { o(d) }
    }

    // MARK: the start

    /// Bundles.loadActive: a crashed trial rolls back; the staged bundle becomes the trial; the trial (else the
    /// active one) is opened, falling back along the good ones; nothing opens → the built-in design.
    @discardableResult
    func loadActive() -> Design? {
        let t = now()
        var trial = storage.loadTrial()
        if !ledger.trial.isEmpty {
            trial = trial.id == ledger.trial ? (trial.id, trial.starts) : (ledger.trial, 1)
            if trial.starts >= Self.crashStarts { ledger.crashed() }
        }
        let loaded = ledger.loadActive(now: t) { id in
            try BundleVerifier.openStored(content: try storage.content(id), id: id, appCode: appCode, crypto: crypto)
        }
        for r in loaded.rolledBack {
            logger.warning("rolled back a bundle")
            event("bundle-rollback", ["id": .string(r.id), "error": .string(r.why), "now": .string(ledger.active)])
            onRolledBack?(r.id)
        }
        if ledger.trial.isEmpty {
            storage.saveTrial(id: "", starts: 0)
        } else {
            let starts = trial.id == ledger.trial && !loaded.trialStarted ? trial.starts + 1 : 1
            storage.saveTrial(id: ledger.trial, starts: starts)
        }
        storage.saveLedger(ledger)
        activeId = loaded.activeId
        onTrial = !ledger.trial.isEmpty && ledger.trial == loaded.activeId
        let report = ledger.report(activeId: loaded.activeId)
        activeVersion = report.version
        stagedVersion = ledger.staged.isEmpty ? "" : ledger.items[ledger.staged]?.version ?? ""
        let d = loaded.design.map { b in builtIn().map { b.withFallback($0) } ?? b }
        changed(d)
        if onTrial { scheduleConfirm() }
        return d
    }

    private func scheduleConfirm() {
        trialTask?.cancel()
        let wait = trialDuration
        trialTask = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled else { return }
            self?.confirmTrial()
        }
    }

    /// The trial ran its time: it becomes the good, active one (Bundles.confirmTrial).
    func confirmTrial() {
        guard !ledger.trial.isEmpty, !ledger.trialCrashed else { return }
        let id = ledger.trial
        let prunable = ledger.confirmTrial(now: now(), kept: storage.keptIds())
        for p in prunable { storage.delete(p) }
        storage.saveLedger(ledger)
        storage.saveTrial(id: "", starts: 0)
        onTrial = false
        let it = ledger.items[id]
        event("bundle-installed", ["id": .string(id), "version": .string(it?.version ?? ""), "number": .int(Int64(it?.number ?? 0))])
        logger.info("a bundle is good")
    }

    /// A screen of the trial bundle could not be drawn: it rolls back now and the design reloads (Bundles.onRenderFailure).
    @discardableResult
    func renderFailed(screen: String, message: String) -> Bool {
        let trial = ledger.trial
        guard ledger.renderFailed(screen: screen, activeId: activeId, message: message, now: now()) else { return false }
        storage.saveLedger(ledger)
        event("bundle-rollback", ["id": .string(trial), "error": .string("screen \(screen): \(message)"), "now": .string(ledger.active)])
        onRolledBack?(trial)
        trialTask?.cancel()
        loadActive()
        return true
    }

    /// The person (or the console's test) wants the previous design back: the trial — or the active bundle — fails.
    @discardableResult
    func rollback(reason: String = "rolled back") -> Bool {
        if !ledger.trial.isEmpty { return renderFailed(screen: "-", message: reason) }
        guard !activeId.isEmpty else { return false }
        let id = activeId
        if var it = ledger.items[id] {
            it.state = "failed"
            it.error = reason
            it.at = now()
            ledger.items[id] = it
        }
        ledger.good.removeAll { $0 == id }
        ledger.active = ledger.good.first ?? ""
        storage.saveLedger(ledger)
        event("bundle-rollback", ["id": .string(id), "error": .string(reason), "now": .string(ledger.active)])
        onRolledBack?(id)
        loadActive()
        return true
    }

    /// "Install" (update.install for a bundle): the staged bundle becomes the trial now.
    func installNow() {
        trialTask?.cancel()
        loadActive()
    }

    // MARK: offers and downloads

    /// What the check-in offers (Bundles.available): fetched when new and the policy lets it download now.
    /// `fetch`: GET /bundles/:id; `verify`: the server key and device (from the enrolment).
    func offer(_ offer: BundleOffer, autoDownload: Bool, wifiOnly: Bool, unmetered: Bool, fetch: @escaping Fetch, keys: Keys) async {
        guard ledger.shouldFetch(id: offer.id, minAppCode: Int(offer.minAppCode), appCode: appCode, activeId: activeId) else { return }
        if offered?.id != offer.id {
            event("update-available", ["kind": "bundle", "id": .string(offer.id), "version": .string(offer.version)])
        }
        offered = offer
        if autoDownload && (!wifiOnly || unmetered) {
            await download(offer, fetch: fetch, keys: keys)
        } else {
            download = .available
        }
    }

    typealias Fetch = @Sendable (_ id: String, _ progress: @escaping HTTPProgress) async throws -> Data

    struct Keys: Sendable {
        var serverKey: String
        var serverKid: String
        var deviceId: String
    }

    /// Downloads and checks one bundle (Bundles.download); staged for the next start.
    @discardableResult
    func download(_ offer: BundleOffer, fetch: @escaping Fetch, keys: Keys) async -> Bool {
        if download == .downloading { return false }
        download = .downloading
        progress = 0
        let id = offer.id
        do {
            let raw = try await fetch(id) { [weak self] done, total in
                let p = total > 0 ? Double(done) / Double(total) : 0
                Task { @MainActor in self?.progress = p }
            }
            guard let spki = Data(base64Encoded: keys.serverKey) else { throw BundleError("the server key is not readable") }
            let v = try BundleVerifier.open(file: raw, expectedId: id, serverKeySpki: spki, serverKid: keys.serverKid, deviceId: keys.deviceId,
                                            appCode: appCode, crypto: crypto)
            try storage.keep(id, content: v.content)
            ledger.staged(id: id, version: v.file.version, number: v.file.number, now: now())
            storage.saveLedger(ledger)
            stagedVersion = v.file.version
            download = .ready
            progress = 1
            logger.info("a bundle is staged")
            onReady?(id)
            return true
        } catch {
            let why = (error as? BundleError)?.message ?? "\(error)"
            ledger.failed(id: id, error: why, now: now())
            storage.saveLedger(ledger)
            event("bundle-failed", ["id": .string(id), "error": .string(why)])
            download = .failed
            progress = 0
            logger.error("a bundle was refused")
            return false
        }
    }

    /// Bundles.report: what runs ({id, version, state}) — the check-in's state.bundle.
    var report: NetJSON {
        let r = ledger.report(activeId: activeId)
        return ["id": .string(r.id), "version": .string(r.version), "state": .string(r.state)]
    }

    /// The design's $update for a bundle (Android Parts.updateScope).
    var scope: [String: Any] {
        ["kind": "bundle", "version": stagedVersion, "size": 0.0, "notes": offered?.notes ?? "", "progress": download == .ready ? 1.0 : progress,
         "state": !stagedVersion.isEmpty ? "ready" : download == .downloading ? "downloading" : download == .failed ? "failed" : "none"]
    }

    /// The wipe: nothing kept, the built-in design.
    func reset() {
        trialTask?.cancel()
        storage.removeAll()
        ledger = BundleLedger()
        activeId = ""
        activeVersion = "built-in"
        onTrial = false
        stagedVersion = ""
        download = .none
        progress = 0
        offered = nil
        changed(nil)
    }

    static func loadBuiltIn() -> Design? {
        guard let url = Bundle.main.url(forResource: "default-design", withExtension: "json", subdirectory: "m5"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? Design.fromJSON(data)
    }
}

/// The vault-backed storage (Android: vault.dir()/bundles/<id>.bin, the system tier's "bundles").
final class VaultBundleStorage: BundleStorage, @unchecked Sendable {
    let vault: Vault
    let store: VaultNetStateStore
    let dir: URL

    init(vault: Vault) {
        self.vault = vault
        store = VaultNetStateStore(vault: vault)
        dir = vault.paths.root.appendingPathComponent("bundles", isDirectory: true)
    }

    func loadLedger() -> BundleLedger {
        guard let d = try? vault.get(.sys, "bundles"), let l = try? JSONDecoder().decode(BundleLedger.self, from: d) else { return BundleLedger() }
        return l
    }

    func saveLedger(_ ledger: BundleLedger) {
        guard let d = try? JSONEncoder().encode(ledger) else { return }
        try? vault.put(.sys, "bundles", d, durable: true)
    }

    func loadTrial() -> (id: String, starts: Int) {
        let j = store.loadNow("bundles-trial")
        return (j?.str("id") ?? "", Int(j?.int("starts") ?? 0))
    }

    func saveTrial(id: String, starts: Int) { store.saveNow("bundles-trial", ["id": .string(id), "starts": .int(Int64(starts))]) }

    private func file(_ id: String) -> URL {
        dir.appendingPathComponent(id.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") } + ".bin")
    }

    func content(_ id: String) throws -> Data {
        guard let sealed = try? Data(contentsOf: file(id)) else { throw BundleError("the bundle's file is missing") }
        return try vault.open(.sys, "bundle-" + id, sealed)
    }

    func keep(_ id: String, content: Data) throws {
        try ProtectedFiles.ensureDirectory(dir, protection: .completeUntilFirstUserAuthentication)
        let sealed = try vault.seal(.sys, "bundle-" + id, content)
        try ProtectedFiles.writeDurable(sealed, to: file(id), protection: .completeUntilFirstUserAuthentication)
    }

    func delete(_ id: String) { try? FileManager.default.removeItem(at: file(id)) }

    func keptIds() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "bin" }.map { $0.deletingPathExtension().lastPathComponent }
    }

    func removeAll() {
        try? FileManager.default.removeItem(at: dir)
        vault.delete(.sys, "bundles")
        vault.delete(.sys, "bundles-trial")
    }
}
