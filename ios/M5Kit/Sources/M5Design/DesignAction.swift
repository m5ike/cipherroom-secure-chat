// Every action a screen tree, a menu, a swipe row or a library can name
// (server/android/design.ts ACTIONS, 122 of them) as a typed value with its
// argument read exactly as android/…/ui/Actions.java reads it: the argument's
// text `s` (Expr.toText of its value, "" for none), defaults ("screen.open" →
// "rooms", "menu.open" → "main", "users.dock" → "right"), and the arguments
// Android ignores (an empty room key for room.switch, a language it does not
// know) giving no action at all.

import Foundation

public enum DesignAction: Sendable, Hashable {
    // navigation, menus, sheets
    case screenOpen(String)
    case back
    case menuOpen(String)
    case sheetOpen(String)
    case sheetClose
    // rooms
    case roomJoin
    case roomSwitch(String)
    case roomToggle(String)
    case roomsConnect
    /// "" = the active room.
    case roomLeave(String)
    case roomForget(String)
    case roomDelete(String)
    case roomClone(String)
    case roomEdit(String)
    // messages and the composer
    case messageSend
    case messageReply(String)
    case messageCopy(String)
    case messageKind(String)
    case messageRecipients
    case compose(String)
    case sendOption(String)
    case msgMap(String)
    case msgSource(String)
    case msgOpen(String)
    case msgInfo(String)
    case msgMapPreview(String)
    case msgSave(String)
    case msgShare(String)
    case msgForward(String)
    case msgShowHidden(String)
    case msgQuote(String)
    case msgSender(String)
    case msgForwardRoom(String)
    case msgForwardTo(String)
    // the user panel
    case usersToggle
    case usersDock(String)
    /// nil = toggle.
    case usersAutoHide(Bool?)
    // calls
    case callAudio
    case callVideo
    case callAudioText
    case callEnd
    case callMute
    case callCamera
    case callSwitchCamera
    case callSpeaker
    // lock, security, account
    case lockNow
    case lockBiometric
    case pinChange
    case biometricToggle
    case wipeAsk
    case ktDismiss
    case accountSignIn
    case accountSignUp
    case accountSignOut(everywhere: Bool)
    case accountRecovery
    case accountAddPasskey
    case accountRegister
    // look, language, settings
    case themeToggle
    /// "" = the phone's language.
    case langSet(String)
    case settingSet(key: String, value: String)
    case settingToggle(String)
    case lookSet(key: String, value: String)
    case lookReset
    case appearanceReset
    case systemSettings(String)
    // updates
    case updateCheck
    case updateInstall
    case updateLater
    // small things
    case flash(String)
    case urlOpen(String)
    /// computed: the argument read data (ActionGuard.computed) — shown and confirmed first.
    case copy(String, computed: Bool)
    case share(String, computed: Bool)
    case fnRun(String)
    case libRun(String)
    /// `set name=value` into $form.
    case setForm(name: String, value: String)
    // voice
    case voiceSpeak(String)
    case voiceStop
    case voiceDictate
    case voiceFxTest
    case voiceFxReset
    // AI
    case aiSend
    case aiStop
    case aiClear
    // NFC
    case nfcRead
    case nfcWrite
    case nfcEmulate
    case nfcStop
    case nfcWorkbench
    case nfcBuilder
    case nfcReader(String)
    // notifications, conversations
    case notifyUp(String)
    case notifyDown(String)
    case notifyUse(String)
    case notifyDrop(String)
    case notifyTest(String)
    case notifySync(String)
    case conversationsSettings(String)
    // people
    case peopleOpen(String)
    case peopleSelect(String)
    case peopleAll(String)
    case peopleNone(String)
    case peopleMessage(String)
    case peopleCall(String)
    case peopleVideo(String)
    case peopleVerify(String)
    case peopleLink(String)
    case peopleUnlink(String)
    case peopleUnlinkAll(String)
    // profile
    case profileOpen(String)
    case profilePick(String)
    case profileClear(String)
    case profileField(String)
    case profileSync(String)
    case profileSave(String)
    case profilePublic(String)
    case profileAudience(String)
    // history (call log)
    case calllogOpen(String)
    case calllogRefresh(String)
    case calllogItem(String)
    case calllogCall(String)
    case calllogClear(String)
    case calllogSystem(String)

    /// An action this version does not know (Android logs "unknown action" and does nothing).
    case unknown(String)

    /// Reads an action and its argument as Actions.run does. nil: the action does nothing
    /// with this argument (an empty room key for room.switch, a language the app does not know…).
    ///   name     the action's name
    ///   value    the argument's value (the raw text evaluated in the element's scope), nil for none
    ///   computed whether the argument read data (copy / share are confirmed first then)
    public static func parse(_ name: String, value: DesignValue?, computed: Bool = false) -> DesignAction? {
        let s = value.map { Expr.toText($0) } ?? ""
        func keyValue() -> (String, String)? {
            let u = Array(s.utf16)
            let eq = JavaSemantics.indexOf(u, 0x3D)
            guard eq > 0 else { return nil }
            return (JavaSemantics.trim(JavaSemantics.string(u[0..<eq])), JavaSemantics.string(u[(eq + 1)...]))
        }
        switch name {
        case "screen.open": return .screenOpen(s.isEmpty ? "rooms" : s)
        case "back": return .back
        case "menu.open": return .menuOpen(s.isEmpty ? "main" : s)
        case "room.join": return .roomJoin
        case "room.switch": return s.isEmpty ? nil : .roomSwitch(s)
        case "room.toggle": return .roomToggle(s)
        case "rooms.connect": return .roomsConnect
        case "room.leave": return .roomLeave(s)
        case "room.forget": return .roomForget(s)
        case "room.delete": return .roomDelete(s)
        case "room.clone": return .roomClone(s)
        case "room.edit": return .roomEdit(s)
        case "message.send": return .messageSend
        case "message.reply": return .messageReply(s)
        case "message.copy": return .messageCopy(s)
        case "users.toggle": return .usersToggle
        case "users.dock": return .usersDock(s.isEmpty ? "right" : s)
        case "users.autoHide": return .usersAutoHide(s.isEmpty ? nil : Expr.truthy(value))
        case "call.audio": return .callAudio
        case "call.video": return .callVideo
        case "call.end": return .callEnd
        case "call.mute": return .callMute
        case "kt.dismiss": return .ktDismiss
        case "lock.now": return .lockNow
        case "lock.biometric": return .lockBiometric
        case "theme.toggle": return .themeToggle
        case "lang.set":
            let l = s == "system" ? "" : s
            return l.isEmpty || DesignLocales.isLocale(l) ? .langSet(l) : nil
        case "update.check": return .updateCheck
        case "update.install": return .updateInstall
        case "update.later": return .updateLater
        case "flash": return .flash(s)
        case "url.open": return .urlOpen(s)
        case "copy": return .copy(s, computed: computed)
        case "share": return .share(s, computed: computed)
        case "fn.run": return s.hasPrefix("/") ? .fnRun(s) : nil
        case "set": return keyValue().map { .setForm(name: $0.0, value: $0.1) }
        case "lib.run": return .libRun(s)
        case "setting.set": return keyValue().map { .settingSet(key: $0.0, value: JavaSemantics.trim($0.1)) }
        case "setting.toggle": return .settingToggle(JavaSemantics.trim(s))
        case "sheet.open": return .sheetOpen(s)
        case "sheet.close": return .sheetClose
        case "look.set": return keyValue().map { .lookSet(key: $0.0, value: JavaSemantics.trim($0.1)) }
        case "look.reset": return .lookReset
        case "compose": return .compose(s)
        case "message.kind": return .messageKind(s)
        case "message.recipients": return .messageRecipients
        case "msg.map": return .msgMap(s)
        case "msg.source": return .msgSource(s)
        case "msg.open": return .msgOpen(s)
        case "msg.info": return .msgInfo(s)
        case "msg.mapPreview": return .msgMapPreview(s)
        case "msg.save": return .msgSave(s)
        case "msg.share": return .msgShare(s)
        case "msg.forward": return .msgForward(s)
        case "msg.showHidden": return .msgShowHidden(s)
        case "msg.quote": return .msgQuote(s)
        case "msg.sender": return .msgSender(s)
        case "msg.forwardRoom": return .msgForwardRoom(s)
        case "msg.forwardTo": return .msgForwardTo(s)
        case "voice.speak": return s.isEmpty ? nil : .voiceSpeak(s)
        case "voice.stop": return .voiceStop
        case "voice.dictate": return .voiceDictate
        case "ai.send": return .aiSend
        case "ai.stop": return .aiStop
        case "ai.clear": return .aiClear
        case "nfc.read": return .nfcRead
        case "nfc.write": return .nfcWrite
        case "nfc.emulate": return .nfcEmulate
        case "nfc.stop": return .nfcStop
        case "nfc.workbench": return .nfcWorkbench
        case "nfc.builder": return .nfcBuilder
        case "nfc.reader": return ["internal", "usb", "bluetooth"].contains(s) ? .nfcReader(s) : nil
        case "account.signin": return .accountSignIn
        case "account.signup": return .accountSignUp
        case "account.signout": return .accountSignOut(everywhere: s == "everywhere")
        case "account.recovery": return .accountRecovery
        case "account.addPasskey": return .accountAddPasskey
        case "account.register": return .accountRegister
        case "pin.change": return .pinChange
        case "biometric.toggle": return .biometricToggle
        case "wipe.ask": return .wipeAsk
        case "system.settings": return .systemSettings(s)
        case "notify.up": return .notifyUp(s)
        case "notify.down": return .notifyDown(s)
        case "notify.use": return .notifyUse(s)
        case "notify.drop": return .notifyDrop(s)
        case "notify.test": return .notifyTest(s)
        case "notify.sync": return .notifySync(s)
        case "conversations.settings": return .conversationsSettings(s)
        case "call.audioText": return .callAudioText
        case "call.camera": return .callCamera
        case "call.switchCamera": return .callSwitchCamera
        case "call.speaker": return .callSpeaker
        case "appearance.reset": return .appearanceReset
        case "people.open": return .peopleOpen(s)
        case "people.select": return .peopleSelect(s)
        case "people.all": return .peopleAll(s)
        case "people.none": return .peopleNone(s)
        case "people.message": return .peopleMessage(s)
        case "people.call": return .peopleCall(s)
        case "people.video": return .peopleVideo(s)
        case "people.verify": return .peopleVerify(s)
        case "people.link": return .peopleLink(s)
        case "people.unlink": return .peopleUnlink(s)
        case "people.unlinkAll": return .peopleUnlinkAll(s)
        case "profile.open": return .profileOpen(s)
        case "profile.pick": return .profilePick(s)
        case "profile.clear": return .profileClear(s)
        case "profile.field": return .profileField(s)
        case "profile.sync": return .profileSync(s)
        case "profile.save": return .profileSave(s)
        case "profile.public": return .profilePublic(s)
        case "profile.audience": return .profileAudience(s)
        case "calllog.open": return .calllogOpen(s)
        case "calllog.refresh": return .calllogRefresh(s)
        case "calllog.item": return .calllogItem(s)
        case "calllog.call": return .calllogCall(s)
        case "calllog.clear": return .calllogClear(s)
        case "calllog.system": return .calllogSystem(s)
        case "voiceFx.test": return .voiceFxTest
        case "voiceFx.reset": return .voiceFxReset
        case "send.option": return .sendOption(s)
        default: return .unknown(name)
        }
    }

    /// Whether a menu shows the item as dangerous (ui/look/Menus.dangerous).
    public static func dangerous(_ name: String?) -> Bool {
        ["room.delete", "room.forget", "wipe.ask", "people.unlinkAll"].contains(name ?? "")
    }
}

/// The action vocabulary as the console documents it (name, argument, help) and the
/// app code an action needs (server/android/bundle.ts NEEDS).
public enum ActionCatalog {
    public struct Entry: Sendable, Hashable {
        public let action: String
        public let arg: String
        public let help: String
        /// The Android app code that first had it (60000: from the start).
        public let since: Int
    }

    public static let names: [String] = entries.map(\.action)

    public static func entry(_ action: String) -> Entry? { byName[action] }

    public static func isKnown(_ action: String) -> Bool { byName[action] != nil }

    private static let byName: [String: Entry] = Dictionary(uniqueKeysWithValues: entries.map { ($0.action, $0) })

    private static func e(_ a: String, _ arg: String, _ help: String, _ since: Int = 60000) -> Entry { Entry(action: a, arg: arg, help: help, since: since) }

    public static let entries: [Entry] = [
        e("screen.open", "screen id", "Open a screen (settings, about, rooms…)"),
        e("back", "", "Back / close"),
        e("menu.open", "menu id", "Show a menu of the design (main, room)"),
        e("room.join", "", "The form to join a new room"),
        e("room.switch", "room key", "Make a connected room the active one (or connect it)"),
        e("room.toggle", "room key", "Select / unselect a room in the list"),
        e("rooms.connect", "", "Connect every selected room"),
        e("room.leave", "room key (empty = active)", "Disconnect a room"),
        e("room.forget", "room key", "Remove a saved room"),
        e("message.send", "", "Send the composer's text"),
        e("message.reply", "message id", "Reply to a message"),
        e("message.copy", "message id", "Copy a message"),
        e("users.toggle", "", "Show / hide the user panel"),
        e("users.dock", "none | left | right | bottom", "Dock the user panel to an edge"),
        e("users.autoHide", "true | false (empty = toggle)", "Pin or auto-hide the docked panel"),
        e("call.audio", "", "Start / join a voice call in the room"),
        e("call.video", "", "Start / join a video call"),
        e("call.end", "", "Hang up"),
        e("call.mute", "", "Mute / unmute"),
        e("lock.now", "", "Lock the app"),
        e("lock.biometric", "", "Unlock with biometrics"),
        e("theme.toggle", "", "Light / dark"),
        e("lang.set", "en | cs | de | es | it | fr | sk | sl | fi | system", "Language (6.13: nine; system = as the phone)"),
        e("update.check", "", "Look for a new bundle or release"),
        e("update.install", "", "Install what was downloaded"),
        e("update.later", "", "Remind later"),
        e("flash", "text", "Show a flash message"),
        e("url.open", "https URL", "Open a web page"),
        e("copy", "text", "Copy to the clipboard"),
        e("share", "text", "The system share sheet"),
        e("fn.run", "/command args", "Run a Functions command in the active room"),
        e("lib.run", "library name", "Run an action library of the design"),
        e("set", "name=value", "Set a value in $form"),
        // 6.1
        e("setting.set", "key=value", "Change a setting (Settings: voice.rate=1.2, location.inHeader=true…)"),
        e("setting.toggle", "key", "Switch a yes/no setting"),
        e("sheet.open", "screen id", "Show a screen of the design as a sheet from the bottom (attach, tools…)"),
        e("sheet.close", "", "Close the sheet"),
        e("compose", "photo | camera | file | location | voice | voiceText | asVoice | dictate", "The composer: a picture, the camera, a file, the position, a voice message, speech sent as text…"),
        e("message.kind", "normal | tap | vanish[:seconds] | seal[:code]", "The kind of the next message (they combine)"),
        e("message.recipients", "", "Choose who gets the next message (a private message)"),
        e("msg.map", "message id", "Open the sender's position on a map"),
        e("msg.source", "message id", "Play the recording a transcript came from"),
        e("msg.open", "message id", "Open the message's file in another app"),
        e("voice.speak", "text", "Read a text aloud (the voice settings)"),
        e("voice.stop", "", "Stop reading"),
        e("voice.dictate", "", "Start / stop dictation (the voice tool)"),
        e("ai.send", "", "Send $form.aiInput to the AI assistant"),
        e("ai.stop", "", "Stop the answer"),
        e("ai.clear", "", "A new conversation"),
        e("nfc.read", "", "Read a tag (a room's connection card with $form.nfcPin)"),
        e("nfc.write", "", "Write the active room to a tag, sealed with $form.nfcPin"),
        e("nfc.emulate", "", "Answer as a tag with the active room's card (another phone reads it)"),
        e("nfc.stop", "", "Stop reading / writing / answering"),
        e("account.signin", "", "Sign in with a passkey"),
        e("account.signup", "", "Create an account with a new passkey"),
        e("account.signout", "everywhere (empty = this device)", "Sign out"),
        e("pin.change", "", "Change the PIN"),
        e("biometric.toggle", "", "Unlock with biometrics on / off"),
        e("wipe.ask", "", "Erase all data (asks first)"),
        e("system.settings", "notifications | app | location", "The phone's settings for the app"),
        e("call.audioText", "", "A call where my messages are spoken into it and what the others say is written"),
        e("call.camera", "", "Camera on / off in a video call"),
        e("call.switchCamera", "", "Front / back camera"),
        e("call.speaker", "", "Speaker / earpiece"),
        e("appearance.reset", "", "The design's look again (no own tone, accent or size)"),
        // 6.2
        e("account.recovery", "", "Create (or replace) the account's recovery code"),
        e("account.addPasskey", "", "Add a passkey with PRF to the signed-in account"),
        e("people.open", "person id", "A person's detail (users.person as a sheet)"),
        e("people.select", "person id", "Add / remove a person from who gets the next message"),
        e("people.all", "", "Everyone connected gets the next message (each selected)"),
        e("people.none", "", "Clear the selection (the next message goes to everyone)"),
        e("people.message", "person id", "A private message to only this person"),
        e("people.call", "person id", "A voice call (the room's call)"),
        e("people.video", "person id", "A video call (the room's call)"),
        e("people.verify", "person id", "Compare the safety number and mark the person verified"),
        e("people.link", "person id", "Link a signed-in person with a contact of the phone"),
        e("people.unlink", "person id", "Remove the link with the phone contact"),
        e("people.unlinkAll", "", "Remove every link with the phone's contacts (asks first)"),
        e("msg.info", "message id", "The message's details"),
        e("msg.mapPreview", "message id", "A header position's map in a dialog"),
        e("msg.save", "message id", "Save the message's file"),
        e("msg.share", "message id", "Share the message's file with another app"),
        e("msg.forward", "message id", "Forward the message to a room or a person"),
        e("msg.showHidden", "", "Show / leave out the room's hidden messages"),
        e("look.set", "key=value", "Change the look (appearance.* or look.*) in place"),
        e("look.reset", "", "The design's own look again, in place"),
        // 6.3
        e("nfc.workbench", "", "Open the NFC workbench"),
        e("nfc.builder", "", "Open the M5Cet card builder"),
        e("nfc.reader", "internal|usb|bluetooth", "Choose the NFC reader"),
        // 6.4
        e("account.register", "", "Open the registration form"),
        // 6.7
        e("notify.up", "android | webpush | email", "A channel a place earlier in the order the server tries", 60700),
        e("notify.down", "android | webpush | email", "A channel a place later", 60700),
        e("notify.use", "android | webpush | email", "Use a channel (at the end of the order)", 60700),
        e("notify.drop", "android | webpush | email", "Leave a channel out", 60700),
        e("notify.test", "", "A test notification through the account's channels", 60700),
        e("notify.sync", "", "Send the notification settings to the server now", 60700),
        e("voiceFx.test", "", "The voice changer's test: record 4 s through it and play them back", 60700),
        e("voiceFx.reset", "", "The voice changer's custom values back to the defaults", 60700),
        e("room.delete", "room key", "Asks first, then deletes a saved room from the list", 60700),
        e("room.clone", "room key", "Saves a copy of a saved room under a new name", 60700),
        e("room.edit", "room key", "The join form filled with a saved room", 60700),
        e("profile.open", "", "Settings › Public profile: the editor", 60700),
        e("profile.pick", "avatar | cover", "Pick the photo or the background", 60700),
        e("profile.clear", "avatar | cover", "Remove the photo or the background", 60700),
        e("profile.field", "field index | new", "Edit a field or add one, in a dialog", 60700),
        e("profile.sync", "", "Take the form's values into the editor and draw it again", 60700),
        e("profile.save", "", "Save: the whole card sealed into the vault, the public part on the server", 60700),
        e("profile.public", "username", "Look up the public profile of a person's username", 60700),
        // 6.8
        e("send.option", "asVoice | voiceText | seal[:code] | newCode | vanish[:seconds] | tap | none", "An option of the messages sent from the composer on / off", 60800),
        e("calllog.open", "", "The History screen (calls and messages of every room)", 60800),
        e("calllog.refresh", "", "Apply $form.logFilter and $form.logQuery to the History", 60800),
        e("calllog.item", "entry id", "Open an entry's room", 60800),
        e("calllog.call", "entry id", "Call an entry's room again — after a confirmation", 60800),
        e("calllog.clear", "", "Delete the app's call history on this phone (asks first)", 60800),
        e("calllog.system", "", "Remove every call this app wrote into the phone's call log (asks first)", 60800),
        e("conversations.settings", "room | (empty)", "The phone's settings of the room on screen as a conversation", 60800),
        // 6.10
        e("msg.quote", "the original's message id", "A reply's quote card: scroll to the message it answers", 61000),
        e("msg.sender", "message id", "A sender's avatar: their profile as they share it with the room", 61000),
        e("msg.forwardRoom", "room key (empty = back to the rooms)", "The forward sheet: forward into this connected room", 61000),
        e("msg.forwardTo", "person id (empty = everyone in the room)", "The forward sheet: send the forwarded message", 61000),
        e("profile.audience", "field index | nickname | about | avatar | cover", "Who sees an item of the profile", 61000),
        // 6.12
        e("kt.dismiss", "", "Key transparency's alert: the person saw it", 61200),
    ]
}
