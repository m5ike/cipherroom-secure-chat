// The chat parts (Android ui/parts MessageList, MsgBody, HoldArea, Composer and the
// bubble / media pieces) installed into the app — one line in App/Bootstrap.swift:
//
//   ChatParts.install(into: model)
//
// Slots: messages, msgBody, msgHold, composer. Actions the parts' views own:
// msg.quote, msg.showHidden, msg.mapPreview, msg.map, msg.source, msg.open,
// msg.save, msg.share (Core/README.md: the chat agent's), and the composer's own
// UI: msg.forward, msg.forwardRoom, msg.forwardTo (the forward sheet) and
// message.recipients (who gets the next message). A later registration wins.
// The lock clears what the parts hold (pictures, held messages, the lists' state);
// an unlock ends the hides "until the next sign-in".

import M5Design
import M5Proto
import SwiftUI

@MainActor
enum ChatParts {
    static let slots = ["messages", "msgBody", "msgHold", "composer"]
    static let actions = ["msg.quote", "msg.showHidden", "msg.mapPreview", "msg.map", "msg.source", "msg.open", "msg.save", "msg.share",
                          "msg.forward", "msg.forwardRoom", "msg.forwardTo", "message.recipients"]

    static func install(into model: AppModel) {
        install(slots: model.design.slots, actions: model.design.actions)
        // The composer's voice: Platform/Voice's VoiceService, asking in the design's words.
        let services = model.design
        ChatVoiceHub.service = VoiceServiceChatVoice(texts: { [weak services] key in
            guard let services else { return key }
            return Translator(design: services.design, lang: services.lang).t(key)
        })
    }

    static func install(slots: SlotRegistry, actions: AppActionRouter) {
        slots.register("messages") { ctx in AnyView(MessagesPart(ctx: ctx)) }
        slots.register("msgBody") { ctx in AnyView(MsgBodyView(ctx: ctx)) }
        slots.register("msgHold") { ctx in AnyView(HoldAreaView(ctx: ctx)) }
        slots.register("composer") { ctx in AnyView(ComposerPart(ctx: ctx)) }
        actions.register(Self.actions) { action, ctx in perform(action, host: ctx.host) }
        if let center = SecurityCenter.shared { center.add(lock) }
    }

    /// Parts.onMessageAction and its neighbours.
    static func perform(_ action: DesignAction, host: DesignHost) {
        func find(_ id: String) -> ChatMessage? { ChatActions.message(id) }
        switch action {
        case .msgQuote(let id): ChatActions.quote(id, host: host)
        case .msgShowHidden: ChatActions.toggleHidden(host: host)
        case .msgMapPreview(let id): if let m = find(id) { ChatActions.mapPreview(m, host: host) }
        case .msgMap(let id): if let m = find(id) { ChatActions.openMap(m, host: host) }
        case .msgSource(let id): if let m = find(id) { ChatActions.playSource(m, host: host) }
        case .msgOpen(let id): if let m = find(id), m.fileName != nil { ChatActions.openFile(m, host: host) }
        case .msgSave(let id): if let m = find(id), m.fileName != nil { ChatActions.saveFile(m, host: host) }
        case .msgShare(let id): if let m = find(id), m.fileName != nil { ChatActions.shareFile(m, host: host) }
        case .msgForward(let id): if let m = find(id) { ChatForward.start(m, host: host) }
        case .msgForwardRoom(let key): ChatForward.pickRoom(key, host: host)
        case .msgForwardTo(let id): ChatForward.send(to: id, host: host)
        case .messageRecipients: ChatForward.pickRecipients(host: host)
        default: break
        }
    }

    /// The lock: what the parts hold of the open app leaves the memory; an unlock begins a new "sign-in".
    private static let lock = ChatLock()

    /// 6.12 (F-16): the core may call this too (Android Parts.forget).
    static func forget() {
        ChatState.shared.forgetAll()
        VoiceService.shared.player.stop()
        Task { await MapTiles.shared.clear() }
    }
}

@MainActor
private final class ChatLock: LockParticipant {
    func lockDidForget() { ChatParts.forget() }
    func lockDidUnlock() { BubbleHides.unlocked() }
}
