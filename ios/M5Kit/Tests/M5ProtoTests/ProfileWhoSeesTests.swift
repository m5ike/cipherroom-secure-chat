// 6.10: who sees what of the profile — android profile/WhoSeesTest: the
// summary in Settings and the editor, and what a tap on a sender's avatar may
// show: another member only what they shared with the room, me only what
// members see of me.

import M5Core
import M5Proto
import Testing

@Suite("profile WhoSees")
struct ProfileWhoSeesTests {
    @Test func eachAudienceSeesItsOwnAndTheWiderOnes() {
        #expect(WhoSees.seenBy(profileCard(), "public") == ["nickname", "field:2"])
        #expect(WhoSees.seenBy(profileCard(), "room") == ["nickname", "about", "avatar", "field:1", "field:2"])
        #expect(WhoSees.seenBy(profileCard(), "me") == ["nickname", "about", "avatar", "cover", "field:0", "field:1", "field:2"])
        #expect(WhoSees.onlyMe(profileCard()) == ["cover", "field:0"])
    }

    @Test func theSummaryMatchesWhatTheViewsCarry() {
        for viewer in ["public", "room", "me"] {
            let view = ProfileCard.viewFor(profileCard(), viewer)
            let seen = WhoSees.seenBy(profileCard(), viewer)
            #expect(view.array("fields")?.count == seen.filter { $0.hasPrefix("field:") }.count, "\(viewer)")
            for k in ["nickname", "about", "avatar", "cover"] { #expect(view.has(k) == seen.contains(k), "\(viewer) \(k)") }
        }
        let s = WhoSees.summary(profileCard())
        #expect(s.array("public")?.count == 2)
        #expect(s.array("room")?.count == 5)
        #expect(s.array("me")?.count == 2)
    }

    @Test func anEmptyOrInvalidItemIsSharedWithNoOne() {
        let c = ProfileCard.normalize(profileObj("{\"nickname\":{\"value\":\"\",\"audience\":\"public\"},\"fields\":[{\"type\":\"phone\",\"value\":\"call me\",\"audience\":\"public\"},{\"type\":\"email\",\"value\":\"a@b.cz\",\"audience\":\"public\"}]}"))
        #expect(WhoSees.seenBy(c, "public") == ["field:1"])
        #expect(WhoSees.onlyMe(c) == []) // the invalid phone is not "only me" either: it is nobody's
        #expect(WhoSees.seenBy(ProfileCard.empty(), "me") == [])
        #expect(WhoSees.seenBy(nil, "room") == [])
    }

    @Test func aSenderShowsOnlyWhatTheySharedWithTheRoom() throws {
        // What a member's phone sends the room is their "room" view: nothing marked only-me is in it.
        var sent = ProfileCard.viewFor(profileCard(), "room")
        let shown = try #require(WhoSees.senderView(sent, nil, false))
        #expect(shown.optString("nickname") == "Alice")
        #expect(shown.array("fields")?.count == 2)
        #expect(!shown.stringify().contains("+420 777 123 456"))
        #expect(!shown.has("cover"))
        // Anything else they hand over is checked again: a field that is not what it claims is dropped.
        sent["fields"] = .array((sent.array("fields") ?? []) + [.object(JSONObject([("type", "phone"), ("label", "x"), ("value", "<script>")]))])
        sent["audience"] = "me"
        let again = try #require(WhoSees.senderView(sent, nil, false))
        #expect(again.array("fields")?.count == 2)
        #expect(!again.has("audience"))
        // Nothing shared, or not a profile at all: nothing to show (the sheet says so).
        #expect(WhoSees.senderView(nil, nil, false) == nil)
        #expect(WhoSees.senderView(profileObj("{\"v\":1,\"fields\":[]}"), nil, false) == nil)
        #expect(WhoSees.senderView(profileObj("{\"nickname\":\"x\"}"), nil, false) == nil) // no version: not a profile
    }

    @Test func myOwnAvatarShowsWhatMembersSeeOfMe() throws {
        let mine = try #require(WhoSees.senderView(nil, profileCard(), true))
        #expect(mine.has("avatar"))
        #expect(!mine.has("cover")) // only me
        #expect(mine.array("fields")?.count == 2)
        #expect(WhoSees.senderView(nil, nil, true) == nil) // signed out: no card
        #expect(WhoSees.senderView(profileCard(), ProfileCard.empty(), true) == nil) // what someone else sent never stands in for mine
    }
}
