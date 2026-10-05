// PushKit's VoIP pushes (AppModel.voip, registered by the app shell's
// PushKitBridge): the token for the server and the calls they announce.
//
// iOS terminates an app that does not report a call to CallKit for every VoIP
// push, so each one is reported before this returns — opened (Platform/Push's
// VoIPPayloadOpening: the server's signature, ECIES with this device's key, the
// same checks as Android's push/Control) or not: a push that cannot be opened
// still gets a neutral call ("M5cet"), ended at once.
//
// 6.14 (call wake, server/ios/commands.ts voipCallContent): the sealed content is
// {id, kind: "call" | "call-end", at, exp (at + 60 s), payload: {call, room, who,
// video, at}} — `call` the call's id (VoIPCallInvite.id), `room` the hub's room id
// (the opener maps it to the saved room), `who` the caller ("" below the user's
// privacy level "sender"). See README › VoIP push a buzení při hovoru.
//
// The token: AppModel keeps it (voipToken, hex) and so does this handler; the
// network code sends it to the server at enroll / check-in (/api/ios, field
// "voipToken" next to the APNs token) and again when it changes (onToken).

import Foundation

@MainActor
final class VoIPPushHandler: VoIPPushHandling {
    let center: CallCenter
    /// Opens a payload (Platform/Push). Without one every push is a neutral call, ended at once.
    var opener: (any VoIPPayloadOpening)?
    /// The PushKit token (hex), nil when iOS withdrew it.
    private(set) var tokenHex: String?
    private var tokenObservers: [(String?) -> Void] = []

    init(center: CallCenter) {
        self.center = center
    }

    /// Called with every new token (and nil when it is withdrawn) — the network code sends it.
    func onToken(_ observer: @escaping (String?) -> Void) {
        tokenObservers.append(observer)
        if let tokenHex { observer(tokenHex) }
    }

    func didUpdate(voipToken token: Data?) {
        tokenHex = token?.hexString
        for o in tokenObservers { o(tokenHex) }
    }

    func didReceiveVoIPPush(_ payload: [AnyHashable: Any], completion: @escaping () -> Void) {
        let invite = opener?.openCallInvite(payload)
        center.reportVoIP(invite, completion: completion)
    }
}
