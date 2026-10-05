// 6.11: a model's identity as the sender of its answers — android
// fn/ModelIdentityTest, the vectors of system-messenger-vectors.json, which
// test/android-fn-611.test.ts checks against client/src/lib/system-messenger.ts
// (the same colours on both). (aPeersFlagsKeepTheIconAndTheMessageCarriesIt
// tests Run.meta / Run.Done — the run client, not ported here.)

import M5Core
import M5Proto
import Testing

@Suite("fn ModelIdentity")
struct FnModelIdentityTests {
    @Test func theSameColourAsTheWeb() throws {
        let colors = try #require(try FnCommandCheckTests.vectors().object("colors"))
        #expect(colors.count == 15)
        for (k, v) in colors { #expect(ModelIdentity.modelColor(k) == v.stringValue, "\(k)") }
        // The vectors the task names, spelled out.
        #expect(ModelIdentity.modelColor("mail") == "#36b234")
        #expect(ModelIdentity.modelColor("hlr") == "#7bb234")
        #expect(ModelIdentity.modelColor("x") == "#34b234")
    }

    @Test func theSameIdentityAsTheWeb() throws {
        let ids = try #require(try FnCommandCheckTests.vectors().array("identities"))
        #expect(ids.count == 6)
        for x in ids {
            let input = try #require(x["in"]?.objectValue), out = try #require(x["out"]?.objectValue)
            let id = ModelIdentity.of(input.string("keyword"), input.string("name"), input.string("icon"))
            #expect(id.keyword == out.string("keyword"))
            #expect(id.name == out.string("name"))
            #expect(id.icon == out.string("icon"))
            #expect(id.color == out.string("color"))
        }
    }

    @Test func fromACommandAndBackThroughTheFlags() throws {
        let c = Command(keyword: "mail", name: "E-mail", summary: "", runtime: "server", visibility: "caller", mine: true)
        let id = ModelIdentity.of(c)
        #expect(id.icon == "mail")
        #expect(id.lucide)
        #expect(id.argb == 0xFF36_B234)
        let j = id.toJson()
        #expect(j.count == 3)
        #expect(j.string("keyword") == "mail")
        #expect(j.string("name") == "E-mail")
        #expect(j.string("icon") == "mail")
        let back = try #require(ModelIdentity.fromJson(j))
        #expect(back.keyword == id.keyword)
        #expect(back.color == id.color)
        #expect(ModelIdentity.fromJson(JSONObject([("name", "x")])) == nil)
        #expect(ModelIdentity.fromJson(JSONObject([("keyword", "bad keyword")])) == nil)
        // A peer's icon that is no lucide name and no emoji: the keyword's instead.
        #expect(ModelIdentity.fromJson(JSONObject([("keyword", "mail"), ("icon", "<img src=x>")]))?.icon == "mail")
        #expect(ModelIdentity.fromJson(JSONObject([("keyword", "fox"), ("icon", "🦊")]))?.icon == "🦊")
        #expect(ModelIdentity.fromJson(JSONObject([("keyword", "fox"), ("icon", "🦊")]))?.lucide == false)
    }

    @Test func anIconAPeerMaySend() {
        #expect(ModelIdentity.safeIcon("phone") == "phone")
        #expect(ModelIdentity.safeIcon(" phone-call ") == "phone-call")
        #expect(ModelIdentity.safeIcon("🦊") == "🦊")
        #expect(ModelIdentity.safeIcon("👩‍💻") == "👩‍💻")
        #expect(ModelIdentity.safeIcon("🇨🇿") == "🇨🇿")
        #expect(ModelIdentity.safeIcon("Phone") == nil) // not a lucide name, has letters
        #expect(ModelIdentity.safeIcon("a b") == nil)
        #expect(ModelIdentity.safeIcon("<b>") == nil)
        #expect(ModelIdentity.safeIcon("🦊🦊🦊🦊🦊🦊🦊🦊🦊") == nil) // too long for one emoji
        #expect(ModelIdentity.safeIcon("") == nil)
        #expect(ModelIdentity.safeIcon(42) == nil)
        #expect(ModelIdentity.safeIcon(nil) == nil)
        #expect(ModelIdentity.safeIcon("\u{0007}") == nil)
    }

    @Test func theAppsOwnSendersArentAPeers() {
        #expect(ModelIdentity.reservedSender("system-messenger"))
        #expect(ModelIdentity.reservedSender("function:mail"))
        #expect(ModelIdentity.reservedSender("system-messenger:mail"))
        #expect(!ModelIdentity.reservedSender("peer-1"))
        let none: String? = nil
        #expect(!ModelIdentity.reservedSender(none))
        #expect(ModelIdentity.fnRunTimeoutMs == 30_000)
        #expect(ModelIdentity.systemMessengerId == "system-messenger")
    }
}
