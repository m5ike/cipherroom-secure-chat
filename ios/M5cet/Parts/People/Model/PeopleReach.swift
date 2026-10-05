// "Message / call via M5cet" for a linked contact arriving from Siri, the share
// sheet, the contact card or an m5cet://people link (Platform/Contacts' ContactReach
// — Android contacts/ContactIntents): the window side of it. The reach asks whether
// the app is on its screens, which rooms are connected and who is in them; once it
// found the person, their room comes on screen and — a message — only they are
// chosen with the composer focused (People.privateTo), or — a call — the room's
// call after the question (calls are the room's, as on the web).

import Foundation
import M5Core
import M5Design
import M5Proto

@MainActor
final class PeopleReach: ContactReachHost {
    static let shared = PeopleReach()

    /// The window People last worked in (the slot's or an action's host).
    weak var host: DesignHost?
    var core: () -> CoreModels = { CoreModels.shared }
    var people: () -> PeopleModel = { PeopleModel.shared }

    var ready: Bool {
        guard let h = host else { return false }
        let st = h.services.state.routeState
        return st.enrolled && st.lockSetUp && !st.locked && !["", "splash", "lock", "enroll"].contains(h.screen)
    }

    var contactsEnabled: Bool { host?.settings.bool("people.contacts") ?? false }

    var activeRoom: String? {
        let k = core().rooms.activeKey
        return k.isEmpty ? nil : k
    }

    /// RoomSession.peopleScope per connected room; "settling" while the room or one of its peers is still connecting.
    func connectedRooms() -> [ContactReachRoom] {
        core().rooms.open.map { r in
            let settling = r.status == "connecting" || r.people.contains { $0.channel == "connecting" }
            return ContactReachRoom(key: r.key, label: r.label, settling: settling, lastActivity: r.lastActivity,
                                    people: r.people.compactMap { $0.scope.json.objectValue })
        }
    }

    func text(_ key: String) -> String { host?.peopleText(key) ?? key }

    func notice(_ text: String, level: String) { host?.flash(title: "", text: text, level: FlashLevel(rawValue: level) ?? .info) }

    func reach(_ kind: ContactReachKind, roomKey: String, peerId: String, username: String) {
        guard let host, let r = core().rooms.room(roomKey) else { return }
        let who = r.peerName(peerId) ?? username
        host.closeOverlay()
        core().rooms.switchTo(roomKey)
        if host.screen == "room" { host.reshow() } else { host.showScreen("room") }
        switch kind {
        case .call:
            // Calls are the room's (as on the web): everyone connected there hears it — so it is asked first.
            SecureDialog.alert(host: host, title: nil, message: PeopleTexts.fill(host.peopleText("people.callAsk"), name: who, other: r.label), actions: [
                .init(label: host.peopleText("people.call")) { [weak host] in _ = host?.runner.runFromApp("call.audio", value: nil) },
                .init(label: host.peopleText("nav.close"), role: .cancel),
            ])
        case .message:
            people().privateTo(peerId, host: host)
        }
    }
}
