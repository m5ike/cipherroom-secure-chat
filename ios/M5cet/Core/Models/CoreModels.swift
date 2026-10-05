// The parts' way into the app core (Core/README.md): one object, main-actor,
// @Observable — `CoreModels.shared`. At launch Bootstrap installs the real core
// (AppCore's RoomsController, AccountService…); a DEBUG `-M5Screen` preview or
// a SwiftUI #Preview installs PreviewCore (Core/Preview) with the console's
// sample data. A part never needs to know which one it runs on.
//
//   let core = CoreModels.shared
//   core.rooms.active?.messages            // the room on screen
//   core.composer(for: ctx.host).send()    // per window
//   core.variables.register("ai", "ai") { … }   // a screen variable a part owns
//
// Android: what the parts reached through `a.app()` (M5: rooms, account, config,
// settings, voice, where) and through `a.parts` (each other).

import Foundation
import M5Core
import M5Design
import M5Proto
import Observation

/// The signed-in account as the parts read it ($account comes from here too).
@MainActor
protocol AccountModel: AnyObject, Observable {
    var signedIn: Bool { get }
    /// The account's username ("" signed out).
    var username: String { get }
    /// $account of every screen (signedIn, username, displayName, country, phone, email, hasRecovery, passkeys…).
    var scope: DesignValue { get }
    /// The session's bearer token for the server's account APIs (fn, AI, profile) — "" signed out.
    func bearer() async -> String
}

/// The commands engine (Android ui/parts/Fn + fn/Commands, Run, Api, Sse) — the tools agent registers it as
/// `CoreModels.shared.fn`. Without one, nothing is suggested and a typed "/command" is sent as text.
@MainActor
protocol FnEngine: AnyObject {
    /// The characters that start a command ("/" and the operator's triggers).
    var commandChars: [String] { get }
    /// The rooms changed / signed in: commands and usage (Fn.load).
    func load()
    /// The lock: the usage and the open runs' state leave the memory (Fn.forget).
    func forget()
    /// Suggestions under the caret: / commands, @ people, # tags (caret: UTF-16 offset).
    func suggest(text: String, caret: Int, names: [String], recent: [String]) -> Suggestions.Result?
    /// The hint while a command's arguments are typed.
    func hint(text: String, caret: Int) -> ArgHint?
    /// A typed command runs (on the server, its bubble in the room) instead of being sent: true when it took the text.
    func run(room: any RoomModel, text: String, host: DesignHost) -> Bool
    /// A model's answer → the message.model sheet's card (nil = not a model's).
    func modelCard(for message: ChatMessage) -> JSONObject?
}

/// Files of messages in the vault (Platform/Files FileVault): the composer stores big attachments here before a transfer.
@MainActor
protocol MessageFiles: AnyObject {
    /// Stores bytes, returns the vault id ("out-<n>").
    func store(_ data: Data) throws -> String
    /// Streams a file (a picked document) into the vault: its id and size.
    func store(contentsOf url: URL) throws -> (id: String, size: Int64)
    /// The plaintext of a stored file (players, previews, share).
    func read(_ id: String) throws -> Data
    /// A decrypted temporary copy for the share sheet / Quick Look — `discard` it after use.
    func temporaryCopy(_ id: String, name: String) throws -> URL
    func discard(_ copy: URL)
}

/// Screen variables a part owns (Android: Parts.aiScope, nfcScope, CallLogUi.scope, ProfileUi.scope / summary…):
/// the part registers a provider, ScreenStateProvider adds its value to the screen's scope.
/// A provider that reads @Observable state makes the screen follow it.
@MainActor
final class ScreenVariables {
    typealias Provider = @MainActor () -> DesignValue
    private var providers: [String: [String: Provider]] = [:]

    /// `screen` "ai", `name` "ai" → $ai of the "ai" screen. A later registration replaces an earlier one.
    func register(_ screen: String, _ name: String, _ provider: @escaping Provider) {
        providers[screen, default: [:]][name] = provider
    }

    func unregister(_ screen: String, _ name: String) { providers[screen]?[name] = nil }

    /// The registered variables of a screen.
    func values(for screen: String) -> [String: DesignValue] { (providers[screen] ?? [:]).mapValues { $0() } }

    func has(_ screen: String, _ name: String) -> Bool { providers[screen]?[name] != nil }
}

/// The tools' shared state (Android `tools` scope, M5.voice / Nfc availability) and the hooks the tool parts install.
@MainActor
@Observable
final class ToolsModel {
    /// $tools of the "tools" sheet: which tools this device has.
    var nfcAvailable = false
    var voiceAvailable = true
    var aiAvailable = true
    /// $voice (dictating, listening, speaking, available) — the Voice service keeps it current.
    var voice: DesignValue = ["dictating": false, "listening": false, "speaking": false, "available": false]

    var toolsScope: DesignValue { ["ai": .bool(aiAvailable), "voice": .bool(voiceAvailable), "nfc": .bool(nfcAvailable)] }
}

@MainActor
@Observable
final class CoreModels {
    /// The core the parts use now (Bootstrap: the real one; DEBUG previews: PreviewCore).
    static var shared = CoreModels(rooms: NoRooms(), account: NoAccount())

    /// Every room (saved, connected, active).
    var rooms: any RoomsModel
    /// The account (signed in or not; $account).
    var account: any AccountModel
    /// The tools' availability and state.
    let tools = ToolsModel()
    /// Screen variables the parts own.
    @ObservationIgnored let variables = ScreenVariables()
    /// The commands engine (tools agent), nil until one is installed.
    @ObservationIgnored var fn: (any FnEngine)?
    /// Positions (Platform/Location), nil without one.
    @ObservationIgnored var position: (any PositionSource)?
    /// The vault's message files (Platform/Files).
    @ObservationIgnored var files: (any MessageFiles)?
    /// This device's chat name (Config.userName — the join form's default nickname, $me.name).
    var userName = ""
    /// The server's origin ("https://chat.example.com"), "" before the enrolment.
    var server = ""

    @ObservationIgnored private var composers: [ObjectIdentifier: ComposerModel] = [:]

    init(rooms: any RoomsModel, account: any AccountModel) {
        self.rooms = rooms
        self.account = account
    }

    /// The composer of a window (one per DesignHost; its $form holds the kinds and recipients).
    func composer(for host: DesignHost) -> ComposerModel {
        let id = ObjectIdentifier(host)
        if let c = composers[id], c.host != nil { return c }
        composers = composers.filter { $0.value.host != nil }
        let c = ComposerModel(host: host, core: self)
        composers[id] = c
        return c
    }

    /// Every window's composer (the lock clears them all).
    var allComposers: [ComposerModel] { composers.values.filter { $0.host != nil } }
}

/// Nothing yet (before the bootstrap installs the core): no rooms.
@MainActor
@Observable
final class NoRooms: RoomsModel {
    var loaded: Bool { false }
    var items: [RoomItem] { [] }
    var activeKey: String { "" }
    var open: [any RoomModel] { [] }
    var selectedCount: Int { 0 }
    var connectedCount: Int { 0 }
    var unreadTotal: Int { 0 }
    var maxRooms: Int { 8 }
    var ktAlert: String { "" }
    func room(_ key: String) -> (any RoomModel)? { nil }
    func byServerId(_ id: String) -> (any RoomModel)? { nil }
    func saved(_ key: String) -> SavedRoom? { nil }
    func card(_ key: String) -> JSONObject? { nil }
    func switchTo(_ key: String) {}
    func toggleSelected(_ key: String) {}
    func connectSelected() {}
    func leave(_ key: String) {}
    func forget(_ key: String) {}
    func join(room: String, passphrase: String, userName: String) -> String { "" }
    func clone(_ key: String) -> String? { nil }
    func update(_ oldKey: String, room: String, passphrase: String, userName: String) -> String? { nil }
    func setVisible(_ visible: Bool) {}
    func dismissKtAlert() {}
}

/// Signed out.
@MainActor
@Observable
final class NoAccount: AccountModel {
    var signedIn: Bool { false }
    var username: String { "" }
    var scope: DesignValue { ["signedIn": false] }
    func bearer() async -> String { "" }
}
