// DEBUG only: screenshots of People's dialogs in sample mode —
//   -M5People "<action>:<argument>"   runs one People action once the room's panel shows
//                                     ("people.open:peer-alice", "people.verify:peer-alice", "msg.info:m8", "msg.sender:m1")
//   -M5UsersDock left|right|bottom|none, -M5UsersAutoHide YES   the panel's place in sample mode
// e.g. xcrun simctl launch <udid> cz.m5cet.app -M5Screen room -M5People msg.info:m8
// Compiled out of Release.

#if DEBUG
import Foundation
import M5Design

@MainActor
enum PeopleDebug {
    private static var ran = false

    static func runOnce(_ host: DesignHost) {
        guard !ran, let v = UserDefaults.standard.string(forKey: "M5People"), !v.isEmpty else { return }
        ran = true
        let parts = v.split(separator: ":", maxSplits: 1).map(String.init)
        let action = parts[0], arg = parts.count > 1 ? parts[1] : ""
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(900))
            _ = host.runner.runFromApp(action, value: .string(arg))
        }
    }
}

/// The people records in memory (sample mode, tests): an always-open vault.
final class PeopleMemoryVault: PeopleVault, @unchecked Sendable {
    private let lock = NSLock()
    private var records: [String: Data] = [:]
    private var open = true

    var isUnlocked: Bool { lock.withLock { open } }

    func setUnlocked(_ on: Bool) { lock.withLock { open = on } }

    func readRecord(_ name: String) -> Data? { lock.withLock { open ? records[name] : nil } }

    func writeRecord(_ name: String, _ data: Data) throws { lock.withLock { if open { records[name] = data } } }
}
#endif
