// The profile store's pure decisions (android profile/Profiles.java has no
// unit test of its own; these follow its code): the save's public step and
// outcome, the lookups' states, the rooms' view and the trees' icons.

import M5Core
import M5Proto
import Testing

@Suite("profile Profiles")
struct ProfilesTests {
    @Test func aSavePublishesThePublicViewOrWithdrawsIt() throws {
        let plan = Profiles.planSave(profileCard(), now: 1_234)
        #expect(plan.card["updatedAt"] == 1_234)
        guard case .publish(let body) = plan.step else { Issue.record("not a publish: \(plan.step)"); return }
        let view = try #require(body.object("profile"))
        #expect(!view.has("rev"))
        #expect(view.optString("nickname") == "Alice")
        #expect(view.array("fields")?.count == 1)
        let ok = Profiles.finishSave(plan, publicError: nil)
        #expect(ok.outcome == "published")
        #expect(ok.publicError == "")
        #expect(ok.card["published"] == true)
        // Nothing public any more, but something was: withdrawn.
        let privateCard = ProfileCard.normalize(profileObj("{\"nickname\":{\"value\":\"Al\",\"audience\":\"me\"},\"published\":true}"))
        let w = Profiles.planSave(privateCard, now: 5)
        #expect(w.step == .withdraw)
        let withdrawn = Profiles.finishSave(w, publicError: nil)
        #expect(withdrawn.outcome == "withdrawn")
        #expect(!withdrawn.card.has("published"))
        // Never published, nothing public: nothing to do.
        #expect(Profiles.planSave(ProfileCard.empty(), now: 5).step == .none)
        // A failed public step still saves the card, as it was.
        let failed = Profiles.finishSave(plan, publicError: "offline")
        #expect(failed.outcome == "none")
        #expect(failed.publicError == "offline")
        #expect(!failed.card.has("published"))
        #expect(Profiles.finishSave(w, publicError: "error").card["published"] == true)
    }

    @Test func lookups() throws {
        #expect(Profiles.isUsername("alice_1"))
        #expect(!Profiles.isUsername("al"))
        #expect(!Profiles.isUsername("al ice"))
        #expect(!Profiles.isUsername(nil))
        #expect(Profiles.lookupState("loading", nil, "") == profileObj("{\"state\":\"loading\",\"accountKey\":\"\"}"))
        let key = String(repeating: "A", count: 43) + "="
        let ok = Profiles.lookupResult(JSONObject([("profile", .object(ProfileCard.viewFor(profileCard(), "public"))), ("accountKey", .string(key))]))
        #expect(ok.optString("state") == "ok")
        #expect(ok.optString("accountKey") == key)
        #expect(ok.object("profile")?.optString("nickname") == "Alice")
        #expect(Profiles.lookupResult(JSONObject([("profile", .object(ProfileCard.viewFor(profileCard(), "public"))), ("accountKey", "short")])).optString("accountKey") == "")
        #expect(Profiles.lookupResult(profileObj("{\"profile\":{\"v\":2}}")).optString("state") == "none")
        #expect(Profiles.lookupFailure(status: 404).optString("state") == "none")
        #expect(Profiles.lookupFailure(status: 500).optString("state") == "error")
        #expect(Profiles.lookupFailure(status: nil).optString("state") == "error")
    }

    @Test func whatTheRoomsAndTheTreesGet() throws {
        #expect(Profiles.roomView(nil) == nil)
        #expect(Profiles.roomView(ProfileCard.empty()) == nil)
        #expect(Profiles.roomView(profileCard())?.has("cover") == false)
        #expect(Profiles.myPhoto(profileCard()) == profilePng)
        #expect(Profiles.myPhoto(nil) == "")
        #expect(Profiles.icon("phone") == "phone")
        #expect(Profiles.icon("birthday") == "gift")
        #expect(Profiles.icon("weird") == "file-text")
        #expect(Profiles.audienceIcon("public") == "globe")
        #expect(Profiles.audienceIcon("room") == "users")
        #expect(Profiles.audienceIcon("me") == "lock")
        let drawn = try #require(Profiles.drawn(ProfileCard.viewFor(profileCard(), "room")))
        #expect(drawn.array("fields")?.compactMap { $0["icon"]?.stringValue } == ["mail", "globe"])
        #expect(drawn.optString("nickname") == "Alice")
        #expect(Profiles.drawn(profileObj("{\"fields\":[1]}")) == nil)
        #expect(Profiles.cacheSize == 64)
    }
}
