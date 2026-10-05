// The chat parts against the sample core (Core/Preview PreviewCore): what is registered,
// a message sent (sending → sent → delivered) and its row, a reply and the quote's jump, hiding
// and "Hidden (n)", the long-press menu, forwarding, the #tag filter, the map, the links and the
// room screen drawn with the parts (iPhone and iPad, light and dark).

import M5Core
import M5Design
import M5Proto
import SwiftUI
import XCTest
@testable import M5cet

@MainActor
final class ChatPartsTests: XCTestCase {
    private var core: CoreModels!
    private var room: PreviewRoom!
    private var host: DesignHost!

    override func setUp() async throws {
        core = PreviewCore.install()
        core.rooms.switchTo("team")
        room = try XCTUnwrap(core.rooms.active as? PreviewRoom)
        host = RendererTestSupport.host()
        ChatParts.install(slots: host.services.slots, actions: host.services.actions)
    }

    private func t(_ key: String) -> String { host.translator.t(key) }

    private func wait(_ seconds: Double) async { try? await Task.sleep(for: .milliseconds(Int(seconds * 1000))) }

    // MARK: registration

    func testSlotsAndActionsAreRegistered() {
        let slots = SlotRegistry(builtIns: false)
        let router = AppActionRouter()
        ChatParts.install(slots: slots, actions: router)
        for s in ["messages", "msgBody", "msgHold", "composer"] { XCTAssertTrue(slots.has(s), s) }
        for a in ["msg.quote", "msg.showHidden", "msg.mapPreview", "msg.map", "msg.source", "msg.open", "msg.save", "msg.share",
                  "msg.forward", "msg.forwardRoom", "msg.forwardTo", "message.recipients"] {
            XCTAssertTrue(router.handles(a), a)
        }
        // Every name is one the design format knows.
        for a in ChatParts.actions { XCTAssertNotNil(DesignAction.parse(a, value: .string("x")), a) }
        for s in ChatParts.slots { XCTAssertTrue(SlotRegistry.names.contains(s), s) }
    }

    func testALaterRegistrationWins() {
        let router = AppActionRouter()
        var coreRan = false
        router.register(["msg.quote"]) { _, _ in coreRan = true } // the core's fallback first
        ChatParts.install(slots: SlotRegistry(builtIns: false), actions: router)
        router.dispatch(.msgQuote("m1"), context: ActionContext(host: host, source: nil))
        XCTAssertFalse(coreRan)
        XCTAssertEqual(ChatState.shared.window(host).scrollTarget, "m1")
    }

    // MARK: sending

    func testASentMessageGoesSendingSentDelivered() async throws {
        let composer = core.composer(for: host)
        composer.text = "Ahoj z testu"
        XCTAssertTrue(composer.send())
        XCTAssertEqual(composer.text, "")
        var m = try XCTUnwrap(room.messages.last)
        XCTAssertEqual(m.text, "Ahoj z testu")
        XCTAssertTrue(m.mine)
        XCTAssertEqual(m.status, "sending")
        XCTAssertEqual(room.freshId, m.id)
        // Its row: the outgoing template, in the list, the state the design shows.
        XCTAssertEqual(ChatMessageScope.screen(m), "message.out")
        XCTAssertTrue(MessagesPart.filter(room.messages, tag: "", peek: false, now: EpochMs.now).items.contains { $0.id == m.id })
        await wait(0.6)
        m = try XCTUnwrap(room.message(m.id))
        XCTAssertEqual(m.status, "sent")
        await wait(1.0)
        m = try XCTUnwrap(room.message(m.id))
        XCTAssertEqual(m.status, "delivered")
        let scope = scope(m)
        XCTAssertEqual(scope["msg"]["status"].stringValue, "delivered")
        XCTAssertEqual(scope["msg"]["text"].stringValue, "Ahoj z testu")
    }

    func testAReplyQuotesTheMessageAndItsTapJumpsThere() throws {
        let original = try XCTUnwrap(room.message("m1"))
        ChatActions.reply(original, host: host)
        let composer = core.composer(for: host)
        XCTAssertEqual(composer.replyTo?.id, "m1")
        composer.text = "Odpověď"
        composer.send()
        XCTAssertNil(composer.replyTo)
        let reply = try XCTUnwrap(room.messages.last)
        XCTAssertEqual(reply.replyToId, "m1")
        let quote = scope(reply)["msg"]["replyTo"]
        XCTAssertEqual(quote["id"].stringValue, "m1")
        XCTAssertEqual(quote["sender"].stringValue, "Alice")
        XCTAssertEqual(quote["found"].boolValue, true)
        // The quote's tap (msg.quote): the list scrolls there and flashes it.
        ChatParts.perform(.msgQuote("m1"), host: host)
        let win = ChatState.shared.window(host)
        XCTAssertEqual(win.scrollTarget, "m1")
        XCTAssertEqual(win.flashId, "m1")
        XCTAssertEqual(ChatActions.jump("gone-1", host: host), .missing)
    }

    func testASwipeRepliesOrForwardsWhatItMay() throws {
        let m1 = try XCTUnwrap(room.message("m1"))
        XCTAssertTrue(ChatActions.canReply(m1) && ChatActions.canForward(m1))
        var sealedShut = m1
        sealedShut.sealed = JSONObject()
        sealedShut.sealPlain = nil
        XCTAssertTrue(ChatActions.canReply(sealedShut))
        XCTAssertFalse(ChatActions.canForward(sealedShut)) // its text is the ciphertext
        var gone = m1
        gone.vanished = true
        XCTAssertFalse(ChatActions.canReply(gone))
        XCTAssertFalse(ChatActions.canReply(ChatMessage.system(roomKey: "team", text: "x", now: 1)))
    }

    // MARK: hidden messages

    func testAHiddenMessageLeavesTheListAndHiddenNShowsIt() throws {
        let sink = AuditSink()
        ChatMessageAudit.sink = sink
        defer { ChatMessageAudit.sink = nil }
        let m = try XCTUnwrap(room.message("m9"))
        BubbleHides.hide(room, m, choice: 0)
        let now = EpochMs.now
        var list = MessagesPart.filter(room.messages, tag: "", peek: false, now: now)
        XCTAssertFalse(list.items.contains { $0.id == "m9" })
        XCTAssertTrue(list.hidden.contains("m9"))
        XCTAssertEqual(sink.actions, ["hide"])
        // "Hidden (n)" (msg.showHidden): in its place, dimmed.
        let win = ChatState.shared.window(host)
        win.hiddenIds = list.hidden
        ChatParts.perform(.msgShowHidden(""), host: host)
        XCTAssertTrue(win.peek)
        list = MessagesPart.filter(room.messages, tag: "", peek: win.peek, now: now)
        XCTAssertTrue(list.items.contains { $0.id == "m9" })
        XCTAssertEqual(scope(try XCTUnwrap(room.message("m9")))["msg"]["hidden"].boolValue, true)
        ChatParts.perform(.msgShowHidden(""), host: host)
        XCTAssertFalse(win.peek)
        // Shown again before its time.
        BubbleHides.unhide(room, try XCTUnwrap(room.message("m9")))
        XCTAssertTrue(MessagesPart.filter(room.messages, tag: "", peek: false, now: now).items.contains { $0.id == "m9" })
        XCTAssertEqual(sink.actions, ["hide", "unhide"])
        XCTAssertFalse(sink.entries.contains { $0.stringify().contains("Super") }) // never the text
    }

    func testTheMessageDetailsHideWithTheListsUnlock() throws {
        // People's msg.info hides through PeopleParts.hides: one "until the next sign-in" for the details and the list.
        let sink = AuditSink()
        ChatMessageAudit.sink = sink
        defer { ChatMessageAudit.sink = nil }
        let m = try XCTUnwrap(room.message("m7"))
        PeopleParts.hides.hide(room, m, choice: BubbleHides.names.firstIndex(of: "until-signin")!)
        let hidden = try XCTUnwrap(room.message("m7"))
        XCTAssertEqual(hidden.hiddenUntil, ChatMessage.untilSignIn)
        XCTAssertEqual(hidden.hiddenFor, BubbleHides.unlock)
        XCTAssertTrue(MessagesPart.filter(room.messages, tag: "", peek: false, now: EpochMs.now).hidden.contains("m7"))
        XCTAssertEqual(sink.actions, ["hide"]) // the chat's audit line
        XCTAssertEqual(sink.entries.first?.int64("until"), 0)
        PeopleParts.defaultHides.lockDidUnlock() // the next sign-in
        XCTAssertFalse(MessagesPart.filter(room.messages, tag: "", peek: false, now: EpochMs.now).hidden.contains("m7"))
        PeopleParts.hides.unhide(room, hidden)
        XCTAssertEqual(room.message("m7")?.hiddenUntil, 0)
    }

    func testTheNfcPartForwardsThroughTheChatsSheet() throws {
        let forward = try XCTUnwrap(NfcUiHooks.forward)
        var card = ChatMessage()
        card.id = "nfc-card-1"
        card.text = "Karta: 4111 •••• 1111"
        card.senderName = "NFC"
        forward(card, host)
        XCTAssertEqual(host.sheet?.screen, "message.forward")
        XCTAssertEqual(host.form["forward"]?["text"].stringValue, card.text)
        host.closeOverlay()
    }

    func testATagFiltersTheConversation() {
        var m = ChatMessage()
        m.text = "Kdo vezme #faktury? A #faktury2."
        XCTAssertTrue(MessagesPart.matches(m, "faktury"))
        XCTAssertTrue(MessagesPart.matches(m, "faktury2"))
        XCTAssertFalse(MessagesPart.matches(m, "faktur"))
        XCTAssertTrue(MessagesPart.matches(m, ""))
        ChatActions.filter("faktury", host: host)
        XCTAssertEqual(ChatState.shared.window(host).tag, "faktury")
        ChatActions.filter("", host: host)
        XCTAssertEqual(ChatState.shared.window(host).tag, "")
    }

    // MARK: the menu

    func testTheLongPressMenuOffersWhatTheMessageAllows() throws {
        ChatActions.menu(try XCTUnwrap(room.message("m1")), host: host, anchor: "msg/m1")
        var labels = host.menu?.entries.map(\.label) ?? []
        XCTAssertEqual(labels, [t("notify.reply"), t("msg.copy"), t("msg.forward"), t("msg.speak"), t("msg.info")])
        XCTAssertEqual(host.menu?.anchor, "msg/m1")
        // A file: open, save, share; a position: the map.
        ChatActions.menu(try XCTUnwrap(room.message("m3")), host: host, anchor: "msg/m3")
        labels = host.menu?.entries.map(\.label) ?? []
        XCTAssertTrue(labels.contains(t("file.open")) && labels.contains(t("file.save")) && labels.contains(t("file.share")))
        ChatActions.menu(try XCTUnwrap(room.message("m4")), host: host, anchor: "msg/m4")
        XCTAssertTrue(host.menu?.entries.contains { $0.label == t("msg.map") } ?? false)
        // A notice has none.
        host.dismissMenu()
        ChatActions.menu(ChatMessage.system(roomKey: "team", text: "x", now: 1), host: host, anchor: "x")
        XCTAssertNil(host.menu)
    }

    // MARK: forwarding

    func testForwardingGoesThroughTheSheet() throws {
        let m = try XCTUnwrap(room.message("m1"))
        if core.rooms.room("family") == nil { core.rooms.switchTo("family"); core.rooms.switchTo("team") }
        ChatParts.perform(.msgForward("m1"), host: host)
        var f = try XCTUnwrap(host.form["forward"])
        XCTAssertEqual(f["step"].stringValue, "room")
        XCTAssertEqual(f["sender"].stringValue, "Alice")
        XCTAssertEqual(f["text"].stringValue, m.text)
        XCTAssertGreaterThanOrEqual(f["rooms"].arrayValue?.count ?? 0, 2)
        XCTAssertEqual(host.sheet?.screen, "message.forward")
        ChatParts.perform(.msgForwardRoom("team"), host: host)
        f = try XCTUnwrap(host.form["forward"])
        XCTAssertEqual(f["step"].stringValue, "who")
        XCTAssertEqual(f["people"].arrayValue?.compactMap { $0["name"].stringValue }, ["Alice", "Bob"])
        let before = room.messages.count
        ChatParts.perform(.msgForwardTo(""), host: host)
        XCTAssertEqual(room.messages.count, before + 1)
        let sent = try XCTUnwrap(room.messages.last)
        XCTAssertEqual(sent.forwardedFrom, "Alice")
        XCTAssertEqual(sent.text, m.text)
        XCTAssertTrue(sent.to.isEmpty)
        XCTAssertNil(host.sheet)
    }

    // MARK: the scope of a row

    func testTheRowsScopeIsAndroids() throws {
        // A run: Bob's file, then the position from Alice (another person) — no run; two of Alice's within minutes — a run.
        let items = MessagesPart.filter(room.messages, tag: "", peek: false, now: EpochMs.now).items
        let i = try XCTUnwrap(items.firstIndex { $0.id == "m9" })
        let prev = items[i - 1]
        let s = scope(items[i], previous: prev)
        XCTAssertEqual(s["msg"]["cont"].boolValue, BubbleRuns.continues(prev, items[i]))
        XCTAssertEqual(s["msg"]["sender"].stringValue, "Alice")
        XCTAssertEqual(s["msg"]["senderFlag"].boolValue, false)
        XCTAssertEqual(s["msg"]["model"], .null)
        XCTAssertEqual(s[ChatMessageScope.roomKeyName].stringValue, "team")
        // An operator's notice says it is the operator's.
        var notice = ChatMessage.system(roomKey: "team", text: "Údržba v 18:00", now: 1)
        notice.id = Names.noticeId + "1"
        notice.senderName = "📌 Someone"
        let n = scope(notice)["msg"]
        XCTAssertEqual(n["sender"].stringValue, "📌 " + t("notice.operator"))
        XCTAssertEqual(n["text"].stringValue, "📌 " + t("notice.operator") + ": Údržba v 18:00")
        // The slot finds its message again from the row's scope.
        XCTAssertEqual(ChatMessageScope.message(scope(try XCTUnwrap(room.message("m2"))))?.id, "m2")
    }

    func testAPositionMessageDrawsTheMapWhenTheOperatorHasMaps() throws {
        let m = try XCTUnwrap(room.message("m4"))
        ChatMapPolicies.setForTesting(nil, server: core.server)
        XCTAssertEqual(scope(m)["msg"]["mapPreview"].boolValue, false) // no policy yet: the pin
        ChatMapPolicies.setForTesting(ChatMapPolicy.parse(JSONObject([("map", .object(JSONObject()))])), server: core.server)
        XCTAssertNotNil(MapBubble.policy(for: m))
        XCTAssertEqual(scope(m)["msg"]["mapPreview"].boolValue, true)
        XCTAssertEqual(scope(m)["msg"]["position"].boolValue, true)
        ChatMapPolicies.setForTesting(ChatMapPolicy.parse(JSONObject([("map", .object(JSONObject([("enabled", false)])))])), server: core.server)
        XCTAssertNil(MapBubble.policy(for: m))
        XCTAssertEqual(MapBubble.coords(50.08804, 14.42076, 12), "50.08804, 14.42076 ± 12 m")
    }

    // MARK: places, links, media

    func testThePlaceSheetUsesTheAppsOneTable() throws {
        // The sheet's pickers are Platform/Location's GeoLinks (Android's and the web's table): Apple Maps first, then the web.
        let nav = GeoLinks.iosChoices(GeoLinks.nav, 50.0875, 14.4213, "Jana") { _ in false }
        XCTAssertEqual(nav.first?.id, "apple")
        XCTAssertTrue(nav.dropFirst().allSatisfy(\.web))
        XCTAssertTrue(GeoLinks.iosChoices(GeoLinks.ride, 50.0875, 14.4213, "") { _ in false }.contains { !$0.prefill }) // Bolt & co.: pasted
        XCTAssertEqual(GeoLinks.destinationText(50.0875, 14.4213), "50.087500, 14.421300")
        // "Open map": Apple Maps with the sender's name, never the address of anything else.
        XCTAssertEqual(Where.appleMapsPinWeb(50.0875, 14.4213, "Jana"), "https://maps.apple.com/?ll=50.087500,14.421300&q=Jana")
        XCTAssertTrue(ChatLinks.visible(Where.appleMapsPinWeb(50.0875, 14.4213, "Jana Nováková")))
        // The kinds of a message agree with Where (one pattern).
        let m = try XCTUnwrap(room.message("m4"))
        XCTAssertEqual(BubbleKinds.isPositionMessage(m), Where.isPositionMessage(text: m.text, sealed: false))
    }

    func testTheTextsSpans() {
        let a = MessageTextView.attributed("Kdo vezme #Faktury. @Mike https://example.com/a?b=1 +420 777 123 456", accent: .red)
        let links = a.runs.compactMap(\.link).map(\.absoluteString)
        XCTAssertTrue(links.contains("m5tag:faktury"))
        XCTAssertTrue(links.contains("https://example.com/a?b=1"))
        XCTAssertTrue(links.contains { $0.hasPrefix("tel:") })
        XCTAssertTrue(a.runs.contains { $0.inlinePresentationIntent == .stronglyEmphasized && String(a[$0.range].characters) == "@Mike" })
        XCTAssertFalse(ChatLinks.visible("https://example.com/\u{202E}gpj.exe"))
        XCTAssertTrue(ChatLinks.visible("https://example.com/a"))
    }

    func testAttachmentsTypesAndPreviews() {
        func file(_ name: String, _ mime: String?, image: Bool = false) -> ChatMessage {
            var m = ChatMessage()
            m.fileName = name
            m.fileMime = mime
            m.fileImage = image
            return m
        }
        XCTAssertEqual(MediaPreviews.type(file("a.png", "image/png", image: true)), .image)
        XCTAssertEqual(MediaPreviews.type(file("v.m4a", "audio/mp4")), .audio)
        XCTAssertEqual(MediaPreviews.type(file("c.mp4", "video/mp4")), .video)
        XCTAssertEqual(MediaPreviews.type(file("x.pdf", "application/octet-stream")), .pdf)
        XCTAssertEqual(MediaPreviews.type(file("notes.md", nil)), .text)
        XCTAssertEqual(MediaPreviews.type(file("a.zip", "application/zip")), .other)
        XCTAssertEqual(MediaPreviews.icon(.audio), "file-headphone")
        XCTAssertEqual(MediaPreviews.textHead(Data("\n\nfirst\n\tsecond\nthird".utf8), lines: 2), "first\n second")
        let long = String(repeating: "x", count: 200)
        XCTAssertEqual(MediaPreviews.textHead(Data(long.utf8), lines: 8), String(repeating: "x", count: 160) + "…")
        // An inline file is read from its data URL, without the vault.
        var inline = file("a.txt", "text/plain")
        inline.fileDataUrl = "data:text/plain;base64," + Data("hello".utf8).base64EncodedString()
        XCTAssertEqual(try? ChatVaultMedia.data(inline), Data("hello".utf8))
        XCTAssertTrue(ChatVaultMedia.ready(inline))
        var transfer = file("b.bin", nil)
        transfer.filePath = "in-1"
        transfer.fileProgress = 0.4
        XCTAssertFalse(ChatVaultMedia.ready(transfer))
        transfer.fileProgress = -1
        XCTAssertTrue(ChatVaultMedia.ready(transfer))
    }

    func testATemporaryCopyIsDeletedAfterUse() throws {
        var m = ChatMessage()
        m.fileName = "../secret.txt"
        m.fileDataUrl = "data:text/plain;base64," + Data("plain".utf8).base64EncodedString()
        let url = try ChatVaultMedia.temporaryCopy(m)
        XCTAssertTrue(url.path.hasPrefix(FileManager.default.temporaryDirectory.path) || url.path.contains("/tmp/"))
        XCTAssertFalse(url.lastPathComponent.contains("/"))
        XCTAssertEqual(try Data(contentsOf: url), Data("plain".utf8))
        ChatVaultMedia.discard(url)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }

    func testAVanishingMessageCountsOnlyItsTimeOnScreen() throws {
        var m = ChatMessage()
        m.id = "v-test"
        m.vanishSeconds = 2
        XCTAssertEqual(ChatState.shared.vanishLeft(m), 2)
        XCTAssertFalse(ChatState.shared.useVanish(m, 1000))
        XCTAssertEqual(ChatState.shared.vanishLeft(m), 1)
        XCTAssertTrue(ChatState.shared.useVanish(m, 1000))
        ChatState.shared.forget(m.id)
        XCTAssertEqual(ChatState.shared.vanishLeft(m), 2)
    }

    func testTheVoiceFlowsWords() {
        XCTAssertEqual(ComposerVoice.errorKey(nil), "voice.failed")
        XCTAssertEqual(ComposerVoice.errorKey("tts-none"), "speakSend.noVoice")
        XCTAssertEqual(ComposerVoice.errorKey("tts-server-off: 503"), "speakSend.serverOff")
        XCTAssertEqual(ComposerVoice.errorKey("declined"), "speakSend.declined")
        XCTAssertEqual(ComposerVoice.errorKey("tts-failed: boom"), "speakSend.failed")
        XCTAssertEqual(ComposerVoice.detail("tts-failed: boom"), "boom")
        XCTAssertEqual(ComposerVoice.detail("x"), "")
    }

    func testSpeakAndSendFlows() async throws {
        let fake = FakeVoice()
        let saved = ChatVoiceHub.service
        ChatVoiceHub.service = fake
        defer { ChatVoiceHub.service = saved }
        let composer = core.composer(for: host)
        let v = ComposerVoice(composer: composer, host: host)
        v.withMic = { then in then() }
        // No dictation on this phone: "as voice" with an empty field says so and sends nothing.
        fake.canDictate = false
        composer.text = ""
        var before = room.messages.count
        v.asVoice()
        XCTAssertEqual(v.state, .idle)
        XCTAssertEqual(room.messages.count, before)
        // "Send the text as voice": the field spoken into a voice message, sent without the text; the field empties.
        composer.text = "Ahoj všichni"
        v.asVoice()
        XCTAssertEqual(v.state, .speaking)
        XCTAssertTrue(composer.voiceBusy) // Send waits meanwhile
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(v.state, .idle)
        XCTAssertFalse(composer.voiceBusy)
        XCTAssertEqual(fake.spoken, ["Ahoj všichni"])
        var sent = try XCTUnwrap(room.messages.last)
        XCTAssertEqual(sent.fileMime, "audio/mp4")
        XCTAssertTrue(sent.fileName?.hasPrefix("hlas-") ?? false)
        XCTAssertEqual(sent.text, "")
        XCTAssertEqual(composer.text, "")
        // "Speak it, send text": dictation into the field, the stop square, then the text goes as a message.
        fake.canDictate = true
        before = room.messages.count
        v.asText()
        XCTAssertEqual(v.state, .dictating)
        try await Task.sleep(for: .milliseconds(50))
        fake.say("Jsem na cestě", final: true)
        XCTAssertEqual(composer.text, "Jsem na cestě")
        v.toggleDictation() // the square: finish the words
        fake.end()
        XCTAssertEqual(v.state, .idle)
        XCTAssertEqual(room.messages.count, before + 1)
        sent = try XCTUnwrap(room.messages.last)
        XCTAssertEqual(sent.text, "Jsem na cestě")
        XCTAssertEqual(composer.text, "")
        // A voice that failed leaves the text in the field.
        fake.ttsError = "tts-none"
        composer.text = "Zkouška"
        v.asVoice()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(v.state, .idle)
        XCTAssertEqual(composer.text, "Zkouška")
    }

    func testTheLockForgetsWhatThePartsHold() {
        ChatState.shared.hold("m6", true)
        ChatState.shared.putImage(UIImage(systemName: "star")!, "m1")
        let win = ChatState.shared.window(host)
        win.tag = "x"
        win.peek = true
        ChatParts.forget()
        XCTAssertFalse(ChatState.shared.isHeld("m6"))
        XCTAssertNil(ChatState.shared.image("m1"))
        XCTAssertEqual(win.tag, "")
        XCTAssertFalse(win.peek)
    }

    // MARK: drawing

    func testTheRoomScreenDrawsWithTheParts() {
        let state = SampleScreenState()
        for (size, regular) in [(RendererTestSupport.iPhone, false), (RendererTestSupport.iPadLandscape, true)] {
            for dark in [false, true] {
                let h = RendererTestSupport.host(state: state)
                ChatParts.install(slots: h.services.slots, actions: h.services.actions)
                h.toneOverride = dark
                h.showScreen("room", transition: false)
                let (vc, window) = RendererTestSupport.show(DesignShell(host: h), size: size, regular: regular, dark: dark)
                RunLoop.main.run(until: Date().addingTimeInterval(0.3))
                let image = RendererTestSupport.draw(vc.view)
                XCTAssertEqual(image.size, size)
                window.isHidden = true
            }
        }
    }

    // MARK: helpers

    private func scope(_ m: ChatMessage, previous: ChatMessage? = nil) -> Scope {
        let byId = Dictionary(room.messages.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        return ChatMessageScope.scope(m, previous: previous, room: room, byId: byId, roster: ChatRoster(room: room, userName: "Mike"),
                                      tr: { self.t($0) }, has: { ChatIcons.has($0) }, settings: host.settings, now: EpochMs.now)
    }
}

/// The composer's voice without a microphone: dictation and speech the test drives.
@MainActor
private final class FakeVoice: ChatVoiceService {
    var canDictate = true
    var ttsError: String?
    var spoken: [String] = []
    private var onText: ((String, Bool) -> Void)?
    private var onEnded: ((String) -> Void)?

    func microphone() async -> ChatMicAccess { .granted }
    func startRecording() -> Bool { true }
    var recordingElapsedMs: Int64 { 0 }
    var recordingLevel: Double { 0 }
    func stopRecording(keep: Bool) async -> ChatVoiceClip? { nil }
    var dictationAvailable: Bool { canDictate }
    var dictating: Bool { onEnded != nil }
    var listening: Bool { onEnded != nil }

    func dictate(onText: @escaping @MainActor (String, Bool) -> Void, onEnded: @escaping @MainActor (String) -> Void) {
        self.onText = onText
        self.onEnded = onEnded
    }

    func stopDictation() {}
    func say(_ text: String, final: Bool) { onText?(text, final) }

    func end() {
        let e = onEnded
        onText = nil
        onEnded = nil
        e?("")
    }

    func textToVoiceMessage(_ text: String, roomKey: String) async -> (clip: ChatVoiceClip?, error: String?) {
        spoken.append(text)
        if let ttsError { return (nil, ttsError) }
        return (ChatVoiceClip(data: Data(repeating: 1, count: 64), mime: "audio/mp4", durationMs: 900), nil)
    }

    func voiceToText(_ clip: ChatVoiceClip, roomKey: String) async -> (text: String?, error: String?) { ("text", nil) }
    func say(_ text: String) {}
}

@MainActor
private final class AuditSink: MessageAuditSink {
    var entries: [JSONObject] = []
    var actions: [String] { entries.map { $0.optString("action") } }
    func record(_ entry: JSONObject, roomKey: String) { entries.append(entry) }
    func flush() {}
}
