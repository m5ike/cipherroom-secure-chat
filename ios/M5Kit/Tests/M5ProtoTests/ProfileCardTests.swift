// 6.7: who sees what of the profile card — android profile/ProfileCardTest,
// the same rules as the web (test/profile-model.test.ts): only-me never
// reaches another audience, room members get room + public, the public only
// public; defaults are private; what others hand over is rebuilt from checked
// values. (The Java test's lenient JSON is written out strictly here.)

import M5Core
import M5Proto
import Testing

/// A 1×1 PNG as a data: URL.
let profilePng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

/// The tests' card: nickname public, about + photo room, background me; Mobile me, Work room, Blog public.
func profileCard() -> JSONObject {
    let raw: JSON = [
        "nickname": ["value": "Alice", "audience": "public"], "about": ["value": "Climber", "audience": "room"],
        "avatar": ["value": .string(profilePng), "audience": "room"], "cover": ["value": .string(profilePng), "audience": "me"],
        "fields": [
            ["id": "f1", "type": "phone", "label": "Mobile", "value": "+420 777 123 456", "audience": "me"],
            ["id": "f2", "type": "email", "label": "Work", "value": "alice@example.com", "audience": "room"],
            ["id": "f3", "type": "url", "label": "Blog", "value": "https://alice.example", "audience": "public"],
        ],
    ]
    return ProfileCard.normalize(raw.objectValue)
}

/// A JSON object from strict JSON text.
func profileObj(_ s: String) -> JSONObject { JSON.parseObject(s) ?? JSONObject() }

@Suite("profile ProfileCard")
struct ProfileCardTests {
    @Test func onlyMeNeverReachesRoomOrPublic() {
        let room = ProfileCard.viewFor(profileCard(), "room").stringify()
        let pub = ProfileCard.viewFor(profileCard(), "public").stringify()
        for secret in ["+420 777 123 456", "Mobile"] {
            #expect(!room.contains(secret))
            #expect(!pub.contains(secret))
        }
        #expect(!room.contains("audience"))
        #expect(!ProfileCard.viewFor(profileCard(), "room").has("cover"))
    }

    @Test func roomGetsRoomAndPublicThePublicOnlyPublic() {
        let room = ProfileCard.viewFor(profileCard(), "room")
        #expect(room.optString("nickname") == "Alice")
        #expect(room.optString("about") == "Climber")
        #expect(room.optString("avatar") == profilePng)
        #expect(room.array("fields")?.count == 2)
        let pub = ProfileCard.viewFor(profileCard(), "public")
        #expect(pub.optString("nickname") == "Alice")
        #expect(!pub.has("about"))
        #expect(!pub.has("avatar"))
        #expect(pub.array("fields")?.count == 1)
        #expect(pub.array("fields")?[0]["value"] == "https://alice.example")
        #expect(ProfileCard.viewFor(profileCard(), "me").array("fields")?.count == 3)
        #expect(!ProfileCard.publicBody(profileCard()).has("rev"))
    }

    @Test func defaultsArePrivateAndTheNicknameIsMeantToBePublic() {
        let e = ProfileCard.empty()
        #expect(e.object("about")?.optString("audience") == "me")
        #expect(e.object("avatar")?.optString("audience") == "me")
        #expect(e.object("cover")?.optString("audience") == "me")
        #expect(e.object("nickname")?.optString("audience") == "public")
        #expect(ProfileCard.isEmptyView(ProfileCard.viewFor(e, "public")))
        let c = ProfileCard.normalize(profileObj("{\"fields\":[{\"type\":\"phone\",\"value\":\"+420 600 000 000\"}],\"about\":{\"value\":\"x\",\"audience\":\"everyone\"}}"))
        #expect(c.array("fields")?[0]["audience"] == "me")
        #expect(c.object("about")?.optString("audience") == "me")
    }

    @Test func invalidValuesAreNotShared() {
        let c = ProfileCard.normalize(profileObj("{\"fields\":[{\"type\":\"email\",\"value\":\"nope\",\"audience\":\"public\"},{\"type\":\"url\",\"value\":\"javascript:alert(1)\",\"audience\":\"public\"},"
            + "{\"type\":\"phone\",\"value\":\"call me\",\"audience\":\"public\"},{\"type\":\"birthday\",\"value\":\"1990-05-01\",\"audience\":\"public\"}]}"))
        #expect(ProfileCard.viewFor(c, "public").array("fields")?.count == 1)
        #expect(ProfileCard.cleanValue("url", "ftp://x.example") == "")
        #expect(ProfileCard.cleanValue("url", "https://ok.example/x") == "https://ok.example/x")
    }

    @Test func whatOthersHandOverIsRebuiltFromCheckedValues() throws {
        let v = try #require(ProfileCard.normalizeShared(profileObj("{\"v\":1,\"nickname\":\"  Bob\u{202E} \",\"avatar\":\"https://tracker.example/p.png\",\"cover\":\"data:image/svg+xml;base64,PHN2Zz4=\","
            + "\"fields\":[{\"type\":\"email\",\"label\":\"Mail\",\"value\":\"bob@example.org\"},{\"type\":\"evil\",\"label\":\"?\",\"value\":\"free text\"}],\"secret\":\"leak\"}")))
        #expect(v.optString("nickname") == "Bob")
        #expect(!v.has("avatar"))
        #expect(!v.has("cover"))
        #expect(v.array("fields")?.count == 2)
        #expect(v.array("fields")?[1]["type"] == "other")
        #expect(!v.stringify().contains("leak"))
        #expect(ProfileCard.normalizeShared(profileObj("{\"v\":2}")) == nil)
        #expect(ProfileCard.normalizeShared(JSON.string("x")) == nil)
        let big = String(repeating: "y", count: 300_000)
        #expect(ProfileCard.normalizeShared(profileObj("{\"v\":1,\"about\":\"x\"}").with("pad", .string(big)).with("v", 1)) == nil)
    }

    @Test func sizesAreCapped() {
        let nick = String(repeating: "N", count: 100)
        let c = ProfileCard.normalize(JSONObject([("nickname", .object(JSONObject([("audience", "public"), ("value", .string(nick))])))]))
        #expect(c.object("nickname")?.optString("value").utf16.count == ProfileCard.nicknameChars)
        let img = "data:image/jpeg;base64," + String(repeating: "A", count: ProfileCard.avatarBytes * 4 / 3 + 100)
        #expect(ProfileCard.cleanImage(img, ProfileCard.avatarBytes) == "")
        #expect(ProfileCard.cleanImage(profilePng, ProfileCard.avatarBytes) == profilePng)
    }

    @Test func revFollowsTheContent() throws {
        let a = ProfileCard.viewFor(profileCard(), "room").optString("rev")
        #expect(a.utf16.count == 16 && a.unicodeScalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) })
        #expect(ProfileCard.viewFor(profileCard().with("updatedAt", 999), "room").optString("rev") == a)
        var other = profileCard()
        other["about"] = .object(try #require(other.object("about")).with("value", "Coffee"))
        #expect(ProfileCard.viewFor(other, "room").optString("rev") != a)
        // A received copy of the same content has the same rev.
        #expect(ProfileCard.normalizeShared(ProfileCard.viewFor(profileCard(), "room"))?.optString("rev") == a)
    }

    @Test func thePublicNicknamePrefillsTheRoomName() {
        #expect(ProfileCard.prefill(profileCard(), "Pixel 9") == "Alice")
        #expect(ProfileCard.prefill(ProfileCard.empty(), "Pixel 9") == "Pixel 9")
        #expect(ProfileCard.prefill(nil, "Bob") == "Bob")
        // Whatever its audience: it is my own field.
        let c = ProfileCard.normalize(profileObj("{\"nickname\":{\"value\":\"Private Al\",\"audience\":\"me\"}}"))
        #expect(ProfileCard.prefill(c, "x") == "Private Al")
        #expect(!ProfileCard.viewFor(c, "room").has("nickname"))
    }

    @Test func controlAndBidiCharactersAreStripped() {
        #expect(ProfileCard.cleanLine("a\u{0000}b\n\n c\u{202E}", 40) == "ab c")
        #expect(ProfileCard.cleanText("line 1\r\n\r\n\r\n\r\nline 2", 100) == "line 1\n\nline 2")
    }

    /// (beyond the Android test) the typed values' checks and the card's shape.
    @Test func fieldValuesByType() {
        #expect(ProfileCard.cleanValue("phone", "+420 (777) 123-456") == "+420 (777) 123-456")
        #expect(ProfileCard.cleanValue("email", "a@b.cz") == "a@b.cz")
        #expect(ProfileCard.cleanValue("email", "a@b.c") == "")
        #expect(ProfileCard.cleanValue("url", "HTTPS://x.example") == "HTTPS://x.example")
        #expect(ProfileCard.cleanValue("birthday", "5. 10.") == "5. 10.")
        #expect(ProfileCard.cleanValue("birthday", "--10-05") == "--10-05")
        #expect(ProfileCard.cleanValue("birthday", "2026-10-5") == "")
        #expect(ProfileCard.cleanValue("address", "a\n\n\n\nb\t c") == "a\n\nb  c")
        let c = ProfileCard.normalize(profileObj("{\"fields\":[{\"id\":\"same\"},{\"id\":\"same\"},7],\"updatedAt\":-5,\"published\":\"TRUE\"}"))
        let ids = (c.array("fields") ?? []).compactMap { $0["id"]?.stringValue }
        #expect(ids.count == 3 && ids[0] == "same" && ids[1] != "same" && Set(ids).count == 3)
        #expect(c["updatedAt"] == 0)
        #expect(c["published"] == true)
        #expect(c.keys == ["v", "nickname", "about", "avatar", "cover", "fields", "updatedAt", "published"])
    }
}
