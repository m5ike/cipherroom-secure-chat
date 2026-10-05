// How the calls' parts come on screen until the Renderer places them in the
// design's slots: `.callPresentation()` on the app's root shows the call
// screen while a room's call is on (it can be put away and comes back with
// the next call) and asks before a call-back from Recents dials (Android: the
// History's "Call the room …?").

import SwiftUI

struct CallPresentation: ViewModifier {
    var system: CallSystem = .shared
    var environment: (any CallEnvironment)?

    @State private var dismissedRoom: String?

    func body(content: Content) -> some View {
        let room = system.activeCallRoom
        content
            .fullScreenCover(isPresented: Binding(
                get: { room != nil && dismissedRoom != room?.roomKey },
                set: { if !$0 { dismissedRoom = room?.roomKey } })) {
                if let room {
                    CallScreen(room: room, system: system, environment: environment) { dismissedRoom = room.roomKey }
                }
            }
            .onChange(of: room?.roomKey) { _, key in if key == nil { dismissedRoom = nil } }
            .confirmationDialog(
                Text(verbatim: CallTexts.t("log.callAsk", environment)
                    .replacingOccurrences(of: "{room}", with: system.pendingCallBack.flatMap { system.directory?.label(ofRoom: $0) } ?? "")),
                isPresented: Binding(get: { system.pendingCallBack != nil }, set: { if !$0 { system.pendingCallBack = nil } }),
                titleVisibility: .visible
            ) {
                Button { callBack(video: false) } label: { Text(verbatim: CallTexts.t("log.call.audio", environment)) }
                Button { callBack(video: true) } label: { Text(verbatim: CallTexts.t("log.call.video", environment)) }
                Button(role: .cancel) { system.pendingCallBack = nil } label: { Text(verbatim: CallTexts.t("nav.close", environment)) }
            }
    }

    private func callBack(video: Bool) {
        guard let key = system.pendingCallBack else { return }
        system.pendingCallBack = nil
        Task { await system.startCall(roomKey: key, video: video) }
    }
}

extension View {
    /// The call screen while a call is on, and the call-back question (see CallPresentation).
    func callPresentation(_ system: CallSystem = .shared, environment: (any CallEnvironment)? = nil) -> some View {
        modifier(CallPresentation(system: system, environment: environment))
    }
}
