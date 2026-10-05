// Erases everything the app keeps (Android security/Wiper): the encrypted stores,
// the lock inbox, vault files, caches, preferences, the App Group's data and every
// Keychain item and Secure Enclave key (without the keys any copy of the files is
// noise). Before that it signs one last event for the server — while the device key
// still exists — and keeps just that request, which holds no secret, until it could
// be delivered (pending-wipe.json, as Android's).
//
// quiet (the duress PIN): the next start shows the empty app without the "data
// erased" notice — the server still hears of it.
//
// A remote wipe: Android ends the process after the report. iOS lets no app remove
// itself from the switcher; the report is sent (at most 8 s), the app's memory is
// reset, and a backgrounded app exits (no screen is showing it).

import Foundation
import os

/// What the report needs from the network layer (M5Net): a signed request for the events endpoint.
protocol WipeReportSigner: Sendable {
    /// POST <server>/api/ios/events with this body, signed now (the device key still exists);
    /// nil when the device is not enrolled.
    func signedEventsRequest(body: Data) throws -> PendingRequest?
}

/// One request kept for later (Android: {url, headers, body (base64), quiet}).
struct PendingRequest: Codable, Sendable, Equatable {
    var url: String
    var headers: [String: String]
    var body: String
    var quiet: Bool?
}

/// Sends a kept request; returns the HTTP status.
protocol WipeTransport: Sendable {
    func send(_ request: PendingRequest) async throws -> Int
}

@MainActor
final class Wiper {
    let paths: SecurityPaths
    private let vault: Vault
    private let keyring: Keyring
    private let stores: [any SecureStore]
    private let inbox: LockInbox
    private let clock: any LockClock
    /// Other directories to empty (caches, tmp).
    var extraDirs: [URL]
    /// UserDefaults domains to remove (the app's, the App Group's).
    var defaultsDomains: [String]
    var signer: (any WipeReportSigner)?
    var transport: (any WipeTransport)?
    /// What else goes (notifications, shortcuts, calls, location, scheduled tasks…) — Android Wiper.teardown.
    private var teardown: [(String, @MainActor () -> Void)] = []
    private let logger = Logger(subsystem: "cz.m5cet.app", category: "wipe")

    init(paths: SecurityPaths, vault: Vault, keyring: Keyring, stores: [any SecureStore], inbox: LockInbox, clock: any LockClock,
         extraDirs: [URL] = [], defaultsDomains: [String] = []) {
        self.paths = paths
        self.vault = vault
        self.keyring = keyring
        self.stores = stores
        self.inbox = inbox
        self.clock = clock
        self.extraDirs = extraDirs
        self.defaultsDomains = defaultsDomains
    }

    /// Something else to stop or remove at a wipe (each runs once, errors are its own).
    func addTeardown(_ name: String, _ action: @escaping @MainActor () -> Void) { teardown.append((name, action)) }

    /// The wipe event's body (Android: {"events": [{id, type, at, detail: {reason, attempts}}]}).
    static func eventBody(reason: String, remote: Bool, attempts: Int, at: Int64) -> Data {
        let event: SecRecord = ["id": Bytes.b64url(Bytes.random(12)), "type": remote ? "remote-wipe" : "wipe", "at": at,
                                "detail": ["reason": reason, "attempts": attempts] as SecRecord]
        return SecJSON.data(["events": [event]])
    }

    /// Erases everything now. The report (when enrolled) is prepared first and sent after.
    func wipe(reason: String, remote: Bool, attempts: Int, quiet: Bool = false) {
        logger.warning("wiping all local data: \(reason, privacy: .public)")
        prepareReport(reason: reason, remote: remote, attempts: attempts, quiet: quiet)
        inbox.close() // the lock inbox takes nothing more (its files go below)
        for (name, action) in teardown {
            action()
            logger.debug("wipe: \(name, privacy: .public) torn down")
        }
        vault.forgetAll()
        keyring.deleteAll()
        for s in stores { s.deleteAll() }
        let keep = paths.pendingWipe
        ProtectedFiles.deleteTree(paths.root, keeping: keep)
        ProtectedFiles.deleteTree(paths.shared, keeping: keep)
        for d in extraDirs {
            for child in (try? FileManager.default.contentsOfDirectory(at: d, includingPropertiesForKeys: nil)) ?? [] {
                ProtectedFiles.deleteTree(child, keeping: keep)
            }
        }
        for domain in defaultsDomains {
            UserDefaults.standard.removePersistentDomain(forName: domain)
            UserDefaults(suiteName: domain)?.removePersistentDomain(forName: domain)
        }
    }

    private func prepareReport(reason: String, remote: Bool, attempts: Int, quiet: Bool) {
        guard let signer else { return }
        do {
            let body = Self.eventBody(reason: reason, remote: remote, attempts: attempts, at: clock.now().wallMs)
            guard var request = try signer.signedEventsRequest(body: body) else { return }
            if quiet { request.quiet = true }
            try ProtectedFiles.ensureDirectory(paths.pendingWipe.deletingLastPathComponent(), protection: .completeUntilFirstUserAuthentication)
            try ProtectedFiles.writeDurable(JSONEncoder().encode(request), to: paths.pendingWipe, protection: .completeUntilFirstUserAuthentication)
        } catch {
            logger.error("the wipe event could not be prepared")
        }
    }

    // MARK: the report

    var hasPending: Bool { FileManager.default.fileExists(atPath: paths.pendingWipe.path) }

    var pending: PendingRequest? {
        guard let d = try? Data(contentsOf: paths.pendingWipe) else { return nil }
        return try? JSONDecoder().decode(PendingRequest.self, from: d)
    }

    /// The pending report is of a quiet wipe (the duress PIN): no "data erased" notice.
    var pendingQuiet: Bool { pending?.quiet ?? false }

    /// Delivers the last event of a wiped device (retried on every start). True when it is gone.
    @discardableResult
    func sendPending() async -> Bool {
        guard let request = pending, let transport else { return !hasPending }
        do {
            let status = try await transport.send(request)
            // Delivered — or refused for good (an unknown device): nothing to retry.
            if (200..<300).contains(status) || ((400..<500).contains(status) && status != 429) {
                try? FileManager.default.removeItem(at: paths.pendingWipe)
                return true
            }
        } catch {
            logger.info("reporting the wipe later")
        }
        return false
    }
}
