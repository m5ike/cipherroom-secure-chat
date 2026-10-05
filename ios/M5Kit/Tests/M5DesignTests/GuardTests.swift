import Foundation
import Testing
@testable import M5Design

/// ActionGuardTest.java: an action of the design cannot carry data it computed off the phone,
/// nor change a privacy setting.
@Suite struct ActionGuardTests {
    /// A bubble's scope: a decrypted message, the log of every room, the open person.
    static let scope = Scope([
        "msg": .obj(["text": "the secret plaintext", "id": "msg-1"]),
        "log": [.obj(["preview": "another secret"])],
        "form": .obj(["person": .obj(["username": "alice"])]),
        "value": 1.2,
    ])

    static func check(_ action: String, _ raw: String?, own: String? = nil) -> ActionGuard.Refusal? {
        let value = raw.map { (try? Expr.value($0, scope, .keys)) ?? .null }
        return ActionGuard.check(action, raw: raw, value: value, own: own)
    }

    @Test func whatReadsData() {
        #expect(!Expr.readsData(nil))
        #expect(!Expr.readsData("https://help.example/android"))
        #expect(!Expr.readsData("{_'help.url'}"))
        #expect(!Expr.readsData("=_('help.url')"))
        #expect(!Expr.readsData("='https://a.example/' + 'x'"))
        #expect(!Expr.readsData("a {{literal} brace"))
        #expect(Expr.readsData("{$msg.text}"))
        #expect(Expr.readsData("https://e.example/?q={$msg.text|upper}"))
        #expect(Expr.readsData("=$msg.text"))
        #expect(Expr.readsData("{=$log[0].preview}"))
        #expect(Expr.readsData("{=true ? 'x' : $msg.text}"))
        #expect(Expr.readsData("{=_('k') + $msg.text}"))
        #expect(Expr.readsData("=-$msg.n"))
        #expect(Expr.readsData("=!$msg.n"))
        #expect(Expr.readsData("={'unclosed"))
        #expect(Expr.readsData("x {unclosed"))
    }

    @Test func networkActionsTakeOnlyTheDesignsLiteral() {
        for action in ["url.open", "lib.run", "fn.run", "profile.public"] {
            #expect(Self.check(action, "https://evil.example/?{$msg.text}") == .computed, "\(action)")
            #expect(Self.check(action, "=$msg.text") == .computed, "\(action)")
            #expect(Self.check(action, "{=$log[0].preview}") == .computed, "\(action)")
            #expect(ActionGuard.check(action, raw: nil, value: "https://evil.example/x", own: nil) == .computed, "\(action): a value without the raw text")
        }
        #expect(Self.check("url.open", "https://help.example/android") == nil)
        #expect(Self.check("url.open", "{_'help.url'}") == nil)
        #expect(Self.check("lib.run", "lock-and-rooms") == nil)
        #expect(Self.check("fn.run", "/help") == nil)
        #expect(Self.check("profile.public", "bob") == nil)
        #expect(ActionGuard.check("lib.run", raw: nil, value: nil, own: nil) == nil)
    }

    @Test func profilePublicMayNameTheOpenPersonOnly() {
        #expect(Self.check("profile.public", "{$form.person.username}", own: "alice") == nil)
        #expect(Self.check("profile.public", "{$msg.text}", own: "alice") == .computed)
        #expect(Self.check("profile.public", "{$form.person.username}", own: nil) == .computed)
        #expect(Self.check("profile.public", "{$form.person.username}", own: "") == .computed)
    }

    @Test func aSettingsKeyIsLiteralItsValueWithinTheRule() {
        #expect(Self.check("setting.set", "voice.rate={$value}") == nil)
        #expect(Self.check("setting.set", "voice.rate=1.5") == nil)
        #expect(Self.check("setting.set", "voice.lang=de") == nil)
        #expect(Self.check("setting.set", "voice.rate=99") == .outside)
        #expect(Self.check("setting.set", "voice.lang={$msg.text}") == .outside)
        #expect(Self.check("setting.set", "{$msg.text}=1") == .computedKey)
        #expect(Self.check("setting.set", "=$msg.text + '=1'") == .computedKey)
        #expect(Self.check("setting.set", "voice.{$msg.n}rate=1") == .computedKey)
        #expect(Self.check("setting.set", "voice.{=''}rate=1") == nil)
        #expect(ActionGuard.check("setting.set", raw: nil, value: "voice.rate=1", own: nil) == .computedKey)
        #expect(Self.check("setting.set", "no.such.key=1") == .unknown)
        #expect(Self.check("setting.set", "voice.rate") == nil)
        #expect(Self.check("look.set", "look.font=sans") == nil)
        #expect(Self.check("look.set", "appearance.accent=") == nil)
        #expect(ActionGuard.check("look.set", raw: "appearance.preset={$p.value}", value: "appearance.preset=ocean", own: nil) == nil)
        #expect(ActionGuard.check("look.set", raw: "look.variant={$v.value}", value: "look.variant=the secret", own: nil) == .outside)
    }

    @Test func theSyncedNotificationSettingsCarryNoMessage() {
        #expect(Self.check("setting.set", "notify.quietFrom={$msg.text}") == .privacy)
        #expect(Self.check("setting.set", "notify.quietFrom=22:00") == .privacy)
        #expect(Self.check("setting.set", "notify.order=android,email") == .privacy)
    }

    @Test func privacySettingsAreNeverTheDesigns() {
        for raw in ["callLog=true", "calls.logName=people", "conversations.names=true", "notify.privacy=content", "voice.engine=server",
                    "location.track=true", "nfc.emulate=true", "messages.readReceipts=true", "people.contacts=true"] {
            #expect(Self.check("setting.set", raw) == .privacy, "\(raw)")
        }
        #expect(Self.check("setting.toggle", "callLog") == .privacy)
        #expect(Self.check("setting.toggle", "conversations.names") == .privacy)
        #expect(Self.check("setting.toggle", "location.track") == .privacy)
        #expect(Self.check("setting.toggle", "messages.enterSends") == nil)
        #expect(Self.check("setting.toggle", "{$msg.text}") == .computedKey)
        #expect(Self.check("setting.toggle", "voice.rate") == .unknown)
    }

    @Test func otherActionsAreUntouched() {
        #expect(Self.check("msg.info", "{$msg.id}") == nil)
        #expect(Self.check("screen.open", "settings") == nil)
        #expect(Self.check("flash", "{_'look.preview.pressed'}") == nil)
        #expect(Self.check("copy", "{$msg.text}") == nil)
        #expect(ActionGuard.check(nil, raw: nil, value: nil, own: nil) == nil)
    }

    @Test func aLiteralKeyIsTheTextBeforeTheFirstEqualsAndBeforeAnyPlaceholder() {
        #expect(ActionGuard.literalKey("voice.rate={$value}") == "voice.rate")
        #expect(ActionGuard.literalKey(" voice.rate = 1") == "voice.rate")
        #expect(ActionGuard.literalKey("{$k}=1") == nil)
        #expect(ActionGuard.literalKey("=$k") == nil)
        #expect(ActionGuard.literalKey("noequals") == nil)
        #expect(ActionGuard.literalKey("=1") == nil)
        #expect(ActionGuard.literalKey(nil) == nil)
    }

    /// Every action of the built-in design with an argument (trees, menus, libraries).
    static func collect(_ v: DesignValue, _ out: inout [(String, String)]) {
        switch v {
        case .object(let o):
            let action = o["action"]?.stringValue ?? o["do"]?.stringValue ?? ""
            if !action.isEmpty, case .string(let arg)? = o["arg"] { out.append((action, arg)) }
            for x in o.values { collect(x, &out) }
        case .array(let a): for x in a { collect(x, &out) }
        default: break
        }
    }

    @Test func theBuiltInDesignStillWorks() throws {
        var all: [(String, String)] = []
        Self.collect(Fixtures.builtIn.document.value, &all)
        #expect(all.count > 50)
        var literal = 0
        for (action, raw) in all {
            if ActionGuard.literal.contains(action) {
                literal += 1
                if action == "profile.public" { #expect(raw == "{$form.person.username}") }
                else { #expect(!Expr.readsData(raw), "\(action) \(raw)") }
            }
            if ActionGuard.keyValue.contains(action) || action == "setting.toggle" {
                let key = action == "setting.toggle" ? JavaSemantics.trim(raw) : ActionGuard.literalKey(raw)
                #expect(key != nil && !SettingSchema.privacy(key), "\(action) \(raw)")
            }
        }
        #expect(literal > 0)
    }
}

/// DesignShareTest.java and DesignUrlsTest.java.
@Suite struct DesignShareAndUrlTests {
    static let scope = Scope(["msg": .obj(["text": "the secret plaintext"])])

    static func computed(_ raw: String?) -> Bool { ActionGuard.computed(raw, raw.map { (try? Expr.value($0, scope, .keys)) ?? .null }) }

    @Test func whichTextsAreConfirmedFirst() {
        #expect(Self.computed("{$msg.text}"))
        #expect(Self.computed("=$msg.text"))
        #expect(Self.computed("Look: {$msg.text}"))
        #expect(Self.computed("{$room.name}"))
        #expect(!Self.computed("https://help.example/android"))
        #expect(!Self.computed("{_'help.text'}"))
        #expect(!Self.computed("=_('help.text')"))
    }

    @Test func theDialogShowsEverythingThatGoes() {
        #expect(DesignShare.shown("plain text") == "plain text")
        #expect(DesignShare.shown("two\nlines\tand a tab") == "two\nlines\tand a tab")
        #expect(DesignShare.shown("Alice\u{202E}nimda") == "Alice[U+202E]nimda")
        #expect(DesignShare.shown("a\u{200B}b\u{FEFF}") == "a[U+200B]b[U+FEFF]")
        #expect(DesignShare.shown("bell\u{7}") == "bell[U+0007]")
        #expect(DesignShare.shown("emoji 🙂 kept") == "emoji 🙂 kept")
        #expect(DesignShare.shown("private \u{E000} use") == "private [U+E000] use")
        #expect(DesignShare.shown(nil) == "")
    }

    @Test func tooLongIsRefusedNotCut() {
        let x = String(repeating: "x", count: DesignShare.max)
        #expect(DesignShare.fits(x))
        #expect(!DesignShare.fits(x + "y"))
        #expect(DesignShare.fits(String(repeating: "🙂", count: DesignShare.max)))
        #expect(!DesignShare.fits(nil))
    }

    static func msg(_ text: String) -> Scope { Scope(["msg": .obj(["text": .string(text), "photo": "data:image/png;base64,iVBORw0KGgo="])]) }
    static func load(_ raw: String, _ sc: Scope) -> String { DesignUrls.image(raw: raw, bound: Expr.toText((try? Expr.value(raw, sc, .keys)) ?? .null)) }

    @Test func aTemplatedRemoteImageIsNotFetched() {
        let sc = Self.msg("the secret plaintext")
        #expect(Self.load("https://evil.example/{$msg.text}", sc) == "")
        #expect(Self.load("https://evil.example/x.png?{$msg.text|upper}", sc) == "")
        #expect(Self.load("=$msg.text", Self.msg("https://evil.example/leak")) == "")
        #expect(Self.load("{$msg.text}", Self.msg("https://evil.example/leak")) == "")
    }

    @Test func localSourcesMayBeComputed() {
        let sc = Self.msg("hi")
        #expect(Self.load("=$msg.photo", sc) == "data:image/png;base64,iVBORw0KGgo=")
        #expect(Self.load("asset:logo.png", sc) == "asset:logo.png")
        #expect(Self.load("asset:{$msg.text}", sc) == "asset:hi")
    }

    @Test func aFixedRemoteImageStays() {
        #expect(Self.load("https://cdn.example/logo.png", Self.msg("x")) == "https://cdn.example/logo.png")
        #expect(DesignUrls.image(raw: " https://cdn.example/logo.png ", bound: "https://cdn.example/logo.png") == "https://cdn.example/logo.png")
    }

    @Test func urlOpenOffersOnlyWhatThePersonCanReadInFull() {
        #expect(DesignUrls.openable("https://help.example/android?x=1#top"))
        var at = "https://e.example/"
        while at.count < DesignUrls.urlMax { at += "a" }
        #expect(DesignUrls.openable(at))
        #expect(!DesignUrls.openable(at + "a"))
        #expect(!DesignUrls.openable("https://e.example/a b"))
        #expect(!DesignUrls.openable("https://e.example/a\tb"))
        #expect(!DesignUrls.openable("https://e.example/a\nb"))
        #expect(!DesignUrls.openable("https://e.example/a\u{a0}b"))
        #expect(!DesignUrls.openable("https://e.example/\u{202E}gnp.exe"))
        #expect(!DesignUrls.openable("https://e.example/\u{2066}x\u{2069}"))
        #expect(!DesignUrls.openable("https://e.example/a\u{200B}b"))
        #expect(!DesignUrls.openable("https://e.example/\u{FEFF}"))
        #expect(!DesignUrls.openable("https://e.example/\u{0}"))
        #expect(!DesignUrls.openable("http://e.example/"))
        #expect(!DesignUrls.openable("https://"))
        #expect(!DesignUrls.openable("javascript:alert(1)"))
        #expect(!DesignUrls.openable(nil))
        #expect(DesignUrls.host("https://help.example/a?b") == "help.example")
    }

    @Test func anythingElseIsRefused() {
        #expect(DesignUrls.image(raw: "http://plain.example/x.png", bound: "http://plain.example/x.png") == "")
        #expect(DesignUrls.image(raw: "file:///sdcard/x.png", bound: "file:///sdcard/x.png") == "")
        #expect(DesignUrls.image(raw: "content://x/y", bound: "content://x/y") == "")
        #expect(DesignUrls.image(raw: nil, bound: "https://cdn.example/a.png") == "")
        #expect(DesignUrls.image(raw: "https://a", bound: nil) == "")
        #expect(DesignUrls.image(raw: "https://a.example/x", bound: "https://b.example/x") == "")
    }
}

/// SettingSchemaTest.java and the settings model (core/Settings.java).
@Suite struct SettingSchemaTests {
    static func ok(_ key: String, _ value: DesignValue) -> Bool {
        guard let v = SettingsModel.coerce(SettingsModel.defaults[key], value) else { return false }
        return SettingSchema.valid(key, v)
    }

    @Test func everyDefaultFitsItsRuleAndEveryKeyHasOne() {
        for (k, v) in SettingsModel.defaultList {
            #expect(SettingSchema.valid(k, v), "\(k) = \(v)")
            if case .bool = v {} else { #expect(SettingSchema.ruled.contains(k), "no rule for \(k)") }
        }
        for k in SettingSchema.ruled { #expect(SettingsModel.defaults[k] != nil, "a rule for a setting that does not exist: \(k)") }
        #expect(SettingsModel.defaultList.count == SettingsModel.defaults.count) // no key twice
    }

    @Test func aDesignsTextCannotHideInATextSetting() {
        #expect(Self.ok("notify.quietFrom", "22:00"))
        #expect(Self.ok("notify.quietTo", "07:30"))
        #expect(!Self.ok("notify.quietFrom", "the secret plaintext"))
        #expect(!Self.ok("notify.quietFrom", "24:00"))
        #expect(!Self.ok("notify.quietFrom", "22:00 and more"))
        #expect(!Self.ok("notify.quietFrom", "7:00"))
        #expect(Self.ok("notify.order", "android,webpush,email"))
        #expect(Self.ok("notify.order", "email"))
        #expect(Self.ok("notify.order", ""))
        #expect(!Self.ok("notify.order", "sms"))
        #expect(!Self.ok("notify.order", "android,webpush,email,android"))
        #expect(!Self.ok("notify.order", "android,secret"))
        #expect(Self.ok("notify.privacy", ""))
        #expect(Self.ok("notify.privacy", "content"))
        #expect(!Self.ok("notify.privacy", "everything"))
        #expect(Self.ok("voice.lang", ""))
        #expect(Self.ok("voice.lang", "cs"))
        #expect(Self.ok("voice.lang", "pt-BR"))
        #expect(!Self.ok("voice.lang", "cs-the-secret"))
        #expect(!Self.ok("voice.lang", "hello world"))
        #expect(!Self.ok("voice.voice", "x\u{202E}y"))
        #expect(!Self.ok("voice.voice", "line\nbreak"))
        #expect(Self.ok("voice.voice", "cs-cz-x-jfs-local"))
        #expect(!Self.ok("appearance.accent", "#12345"))
        #expect(Self.ok("appearance.accent", "#1e88e5"))
        #expect(Self.ok("appearance.accent", "violet"))
        #expect(!Self.ok("appearance.preset", "Ocean Blue"))
        #expect(!Self.ok("look.font", "comic"))
    }

    @Test func numbersStayInTheirRange() {
        #expect(Self.ok("voice.rate", "1.2"))
        #expect(Self.ok("voice.rate", 2.0))
        #expect(!Self.ok("voice.rate", 99))
        #expect(!Self.ok("voice.rate", "NaN"))
        #expect(!Self.ok("voice.rate", "Infinity"))
        #expect(!Self.ok("location.interval", 1))
        #expect(Self.ok("location.interval", "900"))
        #expect(Self.ok("messages.ttlMinutes", 0))
        #expect(!Self.ok("messages.ttlMinutes", -1))
        #expect(Self.ok("voiceFx.pitch", -12))
        #expect(!Self.ok("voiceFx.echo", 2))
        #expect(!Self.ok("look.speed", "fast"))
    }

    @Test func whatTheDesignsChoicesOfferIsAllowed() {
        for v in ["", "cs", "en", "de", "sk", "pl", "fr", "es", "it"] { #expect(Self.ok("voice.lang", .string(v)), "\(v)") }
        for v in ["4", "15", "60", "300", "1800", "3600", "7200"] { #expect(Self.ok("messages.vanishSeconds", .string(v)), "\(v)") }
        for v in ["0", "60", "1440", "10080"] { #expect(Self.ok("messages.ttlMinutes", .string(v)), "\(v)") }
        for v in ["15", "60", "300", "900"] { #expect(Self.ok("location.interval", .string(v)), "\(v)") }
        for v in ["", "red", "orange", "green", "blue", "violet"] { #expect(Self.ok("appearance.accent", .string(v)), "\(v)") }
        for v in ["0.85", "1", "1.15", "1.3", "1.5", "0.8"] { #expect(Self.ok("appearance.fontScale", .string(v)), "\(v)") }
        for v in ["", "sans", "serif", "mono", "condensed", "medium", "light", "casual", "cursive"] { #expect(Self.ok("look.font", .string(v)), "\(v)") }
        for v in ["design", "motorsport", "midnight", "nord"] { #expect(Self.ok("appearance.preset", .string(v)), "\(v)") }
        for v in ["app", "room", "people"] { #expect(Self.ok("calls.logName", .string(v)), "\(v)") }
        for v in ["off", "higher", "lower", "deep", "robot", "echo", "whisper", "anonymous", "custom"] { #expect(Self.ok("voiceFx.preset", .string(v)), "\(v)") }
        for h in 0..<48 { #expect(Self.ok("notify.quietFrom", .string(String(format: "%02d:%@", h / 2, h % 2 == 0 ? "00" : "30")))) }
        #expect(Self.ok("nfc.keyDictionary", "A0A1A2A3A4A5\nD3:F7:D3:F7:D3:F7, FFFFFFFFFFFF # factory"))
        #expect(!Self.ok("nfc.keyDictionary", "A0A1A2A3A4A5\u{200B}"))
    }

    @Test func privacyKeysAreOutOfTheDesignsReach() {
        for k in ["callLog", "calls.logName", "calls.history", "conversations.on", "conversations.names", "notify.privacy", "notify.quietFrom", "notify.order",
                  "notify.away", "voice.engine", "voice.autoplay", "voice.dictateSend", "location.track", "location.inHeader", "location.precise",
                  "nfc.emulate", "nfc.keyDictionary", "messages.receipts", "messages.readReceipts", "people.contacts", "security.shufflePin"] {
            #expect(SettingSchema.privacy(k), "\(k)")
        }
        for k in ["voice.rate", "voice.lang", "appearance.tone", "look.font", "look.variant", "messages.enterSends", "voiceFx.preset", "nfc.reader"] {
            #expect(!SettingSchema.privacy(k), "\(k)")
        }
        #expect(SettingSchema.privacy(nil))
    }

    @Test func aWrongTypeIsNoValue() {
        #expect(SettingsModel.coerce(true, "maybe") == nil)
        #expect(SettingsModel.coerce(1.0, "one") == nil)
        #expect(!SettingSchema.valid("voice.rate", "1.0"))
        #expect(!SettingSchema.valid("voice.lang", 1.0))
        #expect(!SettingSchema.valid("voice.lang", nil))
        #expect(SettingSchema.valid("messages.enterSends", true))
        #expect(SettingsModel.coerce("", .string(String(repeating: "a", count: 500)))?.stringValue?.count == 200)
    }

    @Test func theModelReadsWritesAndNests() {
        var s = SettingsModel(data: ["voice": .obj(["rate": 9]), "look.font": "serif", "notify": .obj(["quietFrom": "the secret"])])
        #expect(s.get("voice.rate") == 1.0)              // outside its rule: the default
        #expect(s.str("look.font") == "serif")            // a flat key is read too
        #expect(s.get("notify.quietFrom") == "22:00")     // a stored value from before the rules
        let set1 = s.set("voice.rate", "1.5")
        #expect(set1)
        #expect(s.num("voice.rate") == 1.5)
        #expect(s.data["voice"]?["rate"] == 1.5)
        let set2 = s.set("voice.rate", "9"), set3 = s.set("no.such", "1")
        #expect(!set2 && !set3)
        let toggled = s.toggle("messages.enterSends")
        #expect(toggled && s.bool("messages.enterSends"))
        let notToggled = s.toggle("voice.rate")
        #expect(!notToggled)
        let privacy = s.set("calls.logName", "people")     // the model itself does not guard privacy (the user's own switch)
        #expect(privacy)
        let scope = s.scope()
        #expect(scope["voice"]["rate"] == 1.5)
        #expect(scope["messages"]["enterSends"] == true)
        #expect(scope["callLog"] == false)
        #expect(scope["notify"]["message"] == true)
        #expect(scope["voiceFx"]["preset"] == "deep")
        // the look's keys
        let v1 = s.lookSet("look.variant", "teal")
        let v2 = s.lookSet("appearance.preset", "nord")   // nord offers no teal: back to its own colour
        #expect(v1 && v2)
        #expect(s.str("look.variant") == "")
        let v3 = s.lookSet("voice.rate", "1")
        #expect(!v3)
        s.lookReset()
        #expect(s.str("appearance.preset") == "design")
    }
}
