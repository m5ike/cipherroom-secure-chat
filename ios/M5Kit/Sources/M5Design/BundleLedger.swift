// The bundles on a device and the rules that move them (android/…/update/
// Bundles.java without its files and network): what is offered is fetched
// only when it is new, not failed before and not for a newer app; a fetched
// bundle is staged; on the next start the staged one runs on trial; a trial
// that crashed, a screen of it that failed to draw, or a bundle that no
// longer opens is rolled back to the last good one (or the built-in design);
// a trial that survives 20 s becomes the good one. The app persists the
// ledger (Codable) in its system storage and keeps the sealed contents.

import Foundation

public struct BundleLedger: Codable, Sendable, Hashable {
    public struct Item: Codable, Sendable, Hashable {
        /// staged | good | failed
        public var state: String
        public var version: String?
        public var number: Int?
        public var error: String?
        /// Milliseconds since 1970.
        public var at: Double?
    }

    /// How long a trial must run without a crash to become the good one.
    public static let trialMs: Double = 20_000
    /// Good bundles kept for rolling back.
    public static let keep = 3

    public var items: [String: Item] = [:]
    /// The good bundles, newest first (at most `keep`).
    public var good: [String] = []
    public var active: String = ""
    public var trial: String = ""
    public var staged: String = ""
    public var trialSince: Double = 0
    public var trialCrashed: Bool = false

    public init() {}

    private mutating func item(_ id: String) -> Item { items[id] ?? Item(state: "") }

    // MARK: offers and downloads

    /// Bundles.available: whether a bundle the check-in offers should be fetched.
    public func shouldFetch(id: String, minAppCode: Int, appCode: Int, activeId: String) -> Bool {
        if id.isEmpty || id == activeId || id == staged || id == trial { return false }
        if items[id]?.state == "failed" { return false }
        if minAppCode > appCode { return false }
        return true
    }

    /// A fetched bundle passed every check (BundleVerifier.open): it is staged for the next start.
    public mutating func staged(id: String, version: String, number: Int, now: Double) {
        var it = item(id)
        it.state = "staged"; it.version = version; it.number = number; it.at = now
        items[id] = it
        staged = id
    }

    /// A fetched bundle was refused.
    public mutating func failed(id: String, error: String, now: Double) {
        var it = item(id)
        it.state = "failed"; it.error = error; it.at = now
        items[id] = it
    }

    // MARK: the start

    public struct Loaded {
        /// The design to use (nil: the built-in one).
        public let design: Design?
        /// The bundle in use ("" = built-in).
        public let activeId: String
        /// A trial started now: call `confirmTrial` after `trialMs` without a crash.
        public let trialStarted: Bool
        /// The bundles rolled back on the way, with why.
        public let rolledBack: [(id: String, why: String)]
    }

    /// Bundles.loadActive: a crashed trial rolls back; the staged bundle becomes the trial; the trial
    /// (else the active one) is opened, falling back along the good ones; nothing opens → built-in.
    /// `open` reads a kept content (BundleVerifier.openStored) and throws when it cannot be used.
    public mutating func loadActive(now: Double, open: (String) throws -> Design) -> Loaded {
        var rolled: [(id: String, why: String)] = []
        if !trial.isEmpty && trialCrashed {
            rolled.append((trial, "the app crashed with it"))
            rollback(trial, why: "the app crashed with it", now: now)
        }
        var started = false
        if !staged.isEmpty {
            trial = staged
            trialSince = now
            trialCrashed = false
            staged = ""
            started = true
        }
        var candidate = trial.isEmpty ? active : trial
        while !candidate.isEmpty {
            do {
                let d = try open(candidate)
                return Loaded(design: d, activeId: candidate, trialStarted: started && candidate == trial, rolledBack: rolled)
            } catch {
                let why = (error as? BundleError)?.message ?? (error as? DesignLoadError)?.message ?? "\(error)"
                rolled.append((candidate, why))
                rollback(candidate, why: why, now: now)
                candidate = active
            }
        }
        return Loaded(design: nil, activeId: "", trialStarted: false, rolledBack: rolled)
    }

    /// The trial ran `trialMs` without a crash: it becomes the good, active one. Returns the bundle
    /// ids whose kept contents may be deleted now, given the ids the app keeps.
    @discardableResult
    public mutating func confirmTrial(now: Double, kept: [String] = []) -> [String] {
        if trial.isEmpty || trialCrashed { return [] }
        let id = trial
        active = id
        trial = ""
        var next = [id]
        for g in good where next.count < Self.keep && g != id { next.append(g) }
        good = next
        var it = item(id)
        it.state = "good"; it.at = now
        items[id] = it
        return prunable(kept)
    }

    /// The app crashed: a running trial is rolled back at the next start.
    public mutating func crashed() { if !trial.isEmpty { trialCrashed = true } }

    /// A screen of the trial bundle in use could not be drawn: it is rolled back now (reload the design).
    @discardableResult
    public mutating func renderFailed(screen: String, activeId: String, message: String, now: Double) -> Bool {
        guard !trial.isEmpty, trial == activeId else { return false }
        rollback(trial, why: "screen \(screen): \(message)", now: now)
        return true
    }

    mutating func rollback(_ id: String, why: String, now: Double) {
        var it = item(id)
        it.state = "failed"; it.error = why; it.at = now
        items[id] = it
        trial = ""
        trialCrashed = false
        if id == active { active = good.first { $0 != id } ?? "" }
    }

    /// Kept contents no longer needed: everything but the good ones, the active, the trial and the staged.
    public func prunable(_ kept: [String]) -> [String] {
        let keepSet = Set(good + [active, trial, staged])
        return kept.filter { !keepSet.contains($0) }
    }

    /// Bundles.report: what runs.
    public func report(activeId: String) -> (id: String, version: String, state: String) {
        let version = items[activeId]?.version ?? "built-in"
        return (activeId, activeId.isEmpty ? "built-in" : version, !trial.isEmpty ? "trial" : activeId.isEmpty ? "built-in" : "good")
    }
}
