// The operator's gate for the voice changer (6.7) — port of
// android/app/src/main/java/cz/m5cet/app/voice/FxGate.java: the "voiceChanger"
// module of the client configuration (GET /api/client-config › config.modules),
// decided like modules.ts decide() — a module off by default: no rule means off;
// a rule that is on lets in by its default / group access and grants. Asked once
// and again every 10 minutes (a minute after a failure); until the server
// answered it is off.

import Foundation
import M5Core

/// GET /api/client-config of the enrolled server (the integration's HTTP client; unauthenticated).
protocol ClientConfigFetching: AnyObject, Sendable {
    /// The JSON answer of `server` + "/api/client-config".
    func clientConfig(server: String) async throws -> JSONObject
}

enum FxGate {
    static let module = "voiceChanger"

    /// modules.ts decide(…).allowed for a module that is off by default and has no parts.
    static func allowed(modules: JSONObject?, id: String, groups: [String]) -> Bool {
        guard let rule = modules?.object(id) else { return false }
        if rule["enabled"]?.boolValue == false { return false }
        let access = strings(rule.array("groups"))
        let inGroup = access.contains(where: { groups.contains($0) })
        let dflt = accessWord(rule["defaultAccess"], access.isEmpty ? "allow" : "deny")
        let group = accessWord(rule["groupAccess"], "allow")
        if inGroup ? group == "allow" : dflt == "allow" { return true }
        for g in rule.array("grants") ?? [] {
            guard let gr = g.objectValue, groups.contains(gr.optString("group")) else { continue }
            for r in strings(gr.array("rights")) where !r.hasPrefix("-") { return true }
        }
        return false
    }

    private static func accessWord(_ v: JSON?, _ dflt: String) -> String {
        if let s = v?.stringValue, s == "allow" || s == "deny" { return s }
        return dflt
    }

    private static func strings(_ a: [JSON]?) -> [String] { (a ?? []).compactMap(\.stringValue) }

    /// This user's groups: the account's (from the server), "user" when it said none, "guest" signed out.
    static func groups(signedIn: Bool, accountGroups: [String]) -> [String] {
        guard signedIn else { return ["guest"] }
        return accountGroups.isEmpty ? ["user"] : accountGroups
    }
}

/// The gate as the app keeps it: the modules of the server, asked again every 10 minutes.
@MainActor
final class FxGateLoader {
    var fetcher: (any ClientConfigFetching)?
    /// Told when the answer changed (MicFx is worked out again, the screen redrawn).
    var onChange: (() -> Void)?

    private var modules: JSONObject?
    private var modulesFor = ""
    private var nextAsk: Int64 = 0
    private var asking = false
    private var last: Bool?
    private let clock: any Clock

    init(clock: any Clock = SystemClock()) { self.clock = clock }

    /// Whether the voice changer may be on for this user now (asks the server when due).
    func allowed(server: String, groups: [String]) -> Bool {
        if server.isEmpty { return false }
        if clock.now() >= nextAsk || modulesFor != server { ask(server, groups: groups) }
        let m = modulesFor == server ? modules : nil
        let now = m != nil && FxGate.allowed(modules: m, id: FxGate.module, groups: groups)
        last = now
        return now
    }

    /// Ask again at once (the settings screen opened).
    func refresh(server: String, groups: [String]) {
        nextAsk = 0
        _ = allowed(server: server, groups: groups)
    }

    private func ask(_ server: String, groups: [String]) {
        guard !asking, let fetcher else { return }
        asking = true
        nextAsk = clock.now() + 60_000
        Task { @MainActor [weak self] in
            var got: JSONObject?
            do {
                let o = try await fetcher.clientConfig(server: server)
                let config = o.object("config") ?? o
                got = config.object("modules") ?? JSONObject()
            } catch {
                M5Log.shared.warn("voice", "no module policy: \(error)")
            }
            guard let self else { return }
            self.asking = false
            let changed = got != nil && (self.modules == nil || self.modulesFor != server || got != self.modules)
            if let got {
                self.modules = got
                self.modulesFor = server
                self.nextAsk = self.clock.now() + 600_000
            }
            if changed {
                let now = FxGate.allowed(modules: got, id: FxGate.module, groups: groups)
                if self.last != now { self.last = now }
                self.onChange?()
            }
        }
    }
}
