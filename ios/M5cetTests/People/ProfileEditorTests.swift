// The profile on screen (ProfileUi.java): $profile of the editor (fields, who sees
// what, the preview per audience, dirty), the form's values into the working copy,
// the audience menu, the field dialog's result, the save and its outcome words,
// $myProfile of Settings, a sender's sheet ($form.sender) and the picture encoder
// (crop, scale, byte cap, no metadata).

import ImageIO
import M5Core
import M5Design
import M5Proto
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import M5cet

@MainActor
final class ProfileEditorTests: XCTestCase {
    private func editor(_ w: PeopleWorld) -> ProfileEditor {
        let e = ProfileEditor()
        e.profiles = { w.profiles }
        e.account = { w.core.account }
        return e
    }

    func testTheEditorsScope() throws {
        let w = PeopleWorld.make()
        let e = editor(w)
        let p = e.scope(w.host)
        XCTAssertEqual(p["signedIn"], true)
        XCTAssertEqual(p["ready"], true)
        XCTAssertEqual(p["dirty"], false)
        XCTAssertEqual(p["initials"], "Mike")
        // The form got the card's values (the inputs and switches are bound to it).
        XCTAssertEqual(w.host.form["pfNick"], "Mike")
        XCTAssertEqual(w.host.form["pfNickAud"], "public")
        XCTAssertEqual(w.host.form["pfAboutAud"], "room")
        XCTAssertEqual(w.host.form["pfPreview"], "room")
        let fields = try XCTUnwrap(p["fields"].arrayValue)
        XCTAssertEqual(fields.count, 2)
        XCTAssertEqual(fields[0]["typeLabel"], .string(w.host.peopleText("pf.type.phone")))
        XCTAssertEqual(fields[0]["icon"], "phone")
        XCTAssertEqual(fields[0]["audIcon"], "lock")
        XCTAssertEqual(fields[1]["audLabel"], .string(w.host.peopleText("pf.aud.public")))
        XCTAssertEqual(fields[0]["invalid"], false)
        XCTAssertEqual(p["canAdd"], true)
        // Who sees what, by name.
        XCTAssertEqual(p["whoSees"]["public"]["count"], 2)
        XCTAssertEqual(p["whoSees"]["public"]["text"], .string(w.host.peopleText("pf.nickname") + ", Blog"))
        XCTAssertEqual(p["whoSees"]["room"]["count"], 3)
        XCTAssertEqual(p["whoSees"]["me"]["text"], "Mobil")
        // The preview as room members see it: nickname, about, the blog — not the phone.
        XCTAssertEqual(p["preview"]["nickname"], "Mike")
        XCTAssertEqual(p["preview"]["fields"].arrayValue?.count, 1)
        XCTAssertEqual(p["preview"]["empty"], false)
        // Typed in the form: the draft follows, the screen says unsaved.
        w.host.form["pfNick"] = "Michal"
        w.host.form["pfPreview"] = "public"
        let q = e.scope(w.host)
        XCTAssertEqual(q["dirty"], true)
        XCTAssertEqual(q["preview"]["nickname"], "Michal")
        XCTAssertNil(q["preview"]["about"].stringValue, "the about text is for room members only")
    }

    func testSignedOutAndStillOpening() {
        let w = PeopleWorld.make(card: nil)
        let e = editor(w)
        XCTAssertEqual(e.scope(w.host)["ready"], false)
        let account = w.core.account as! PeopleFakeAccount
        account.signedIn = false
        account.username = ""
        let s = e.scope(w.host)
        XCTAssertEqual(s["signedIn"], false)
        XCTAssertEqual(e.summary(t: w.host.peopleText)["name"], .string(w.host.peopleText("set.user.signedOut")))
    }

    func testTheSummaryOnTopOfSettings() {
        let w = PeopleWorld.make()
        let s = editor(w).summary(t: w.host.peopleText)
        XCTAssertEqual(s["ready"], true)
        XCTAssertEqual(s["name"], "Mike")
        XCTAssertEqual(s["counts"]["public"], 2)
        XCTAssertEqual(s["counts"]["room"], 3)
        XCTAssertEqual(s["counts"]["me"], 1)
    }

    func testTheAudienceMenuAndTheFieldDialogsResult() throws {
        let w = PeopleWorld.make()
        let e = editor(w)
        _ = e.scope(w.host)
        e.audienceMenu("1", host: w.host, anchor: ActionSource("chip-1"))
        let menu = try XCTUnwrap(w.host.menu)
        XCTAssertEqual(menu.anchor, "chip-1")
        XCTAssertEqual(menu.entries.map(\.icon), ["lock", "users", "globe"])
        XCTAssertEqual(menu.entries.map(\.checked), [false, false, true])
        menu.entries[1].run()
        XCTAssertEqual(e.draft?.array("fields")?[1].objectValue?.optString("audience"), "room")
        // A base item's audience goes through its switch in the form.
        e.audienceMenu("about", host: w.host, anchor: ActionSource("chip-about"))
        try XCTUnwrap(w.host.menu).entries[2].run()
        XCTAssertEqual(w.host.form["pfAboutAud"], "public")
        XCTAssertEqual(e.draft?.object("about")?.optString("audience"), "public")
        XCTAssertEqual(ProfileEditor.audienceLabel("room", w.host.peopleText), w.host.peopleText("pf.aud.room.short"))
        XCTAssertEqual(ProfileEditor.baseAudienceKey("cover"), "pfCoverAud")
        XCTAssertNil(ProfileEditor.baseAudienceKey("3"))
    }

    func testSavingSaysWhatHappenedToThePublicPart() async {
        let w = PeopleWorld.make()
        let e = editor(w)
        PeopleParts.install(services: w.host.services)
        _ = e.scope(w.host)
        w.host.form["pfNick"] = "Michal"
        e.run("profile.save", "", host: w.host, source: nil)
        XCTAssertTrue(e.busy)
        await PeopleWorld.settle()
        XCTAssertFalse(e.busy)
        XCTAssertEqual(e.msg, w.host.peopleText("pf.saved.published"))
        XCTAssertEqual(w.profiles.card?.object("nickname")?.optString("value"), "Michal")
        XCTAssertEqual(e.scope(w.host)["dirty"], false)
        XCTAssertEqual(w.room.profileChanges, 1, "the rooms share the new room view")
        // The public step failed: saved in the vault all the same, and it says so.
        w.profiles.publicError = "HTTP 503"
        e.run("profile.save", "", host: w.host, source: nil)
        await PeopleWorld.settle()
        XCTAssertEqual(e.msg, w.host.peopleText("pf.saved.publicFailed") + " HTTP 503")
    }

    func testASendersSheet() {
        let w = PeopleWorld.make()
        var m = ChatMessage()
        m.id = "m1"; m.senderId = "peer-alice"; m.senderName = "Alice"; m.text = "Ahoj"
        let s = ProfileEditor.sender(w.room, m, profiles: w.profiles, myUsername: "bystry-sokol-7k3q", t: w.host.peopleText)
        XCTAssertEqual(s.optString("title"), "Alice Nováková")
        XCTAssertEqual(s.bool("nickDiffers"), true)
        XCTAssertEqual(s.bool("present"), true)
        XCTAssertEqual(s.bool("canMessage"), true)
        XCTAssertEqual(s.optString("username"), "alice-novak")
        XCTAssertEqual(s.bool("has"), true)
        XCTAssertEqual(s.object("profile")?.optString("about"), "Lezu a piju kávu.")
        // My own message: how room members see me (never what is only mine).
        var mine = ChatMessage()
        mine.id = "m2"; mine.mine = true; mine.senderName = "Mike"; mine.senderId = "peer-me"
        let me = ProfileEditor.sender(w.room, mine, profiles: w.profiles, myUsername: "bystry-sokol-7k3q", t: w.host.peopleText)
        XCTAssertEqual(me.optString("username"), "bystry-sokol-7k3q")
        XCTAssertEqual(me.bool("canMessage"), false)
        XCTAssertNil(me.object("profile")?.array("fields")?.first { $0.objectValue?.optString("value") == "+420 777 123 456" })
        // Someone who left: not present; nothing shared.
        var gone = ChatMessage()
        gone.id = "m3"; gone.senderId = "peer-gone"; gone.senderName = "Zdeněk"
        let g = ProfileEditor.sender(w.room, gone, profiles: w.profiles, myUsername: "", t: w.host.peopleText)
        XCTAssertEqual(g.bool("present"), false)
        XCTAssertEqual(g.bool("has"), false)
        XCTAssertEqual(g.object("profile")?.array("fields")?.count, 0)
    }

    func testMsgSenderOpensTheSheetWithTheSendersProfile() {
        let w = PeopleWorld.make()
        PeopleParts.install(services: w.host.services)
        var m = ChatMessage()
        m.id = "m1"; m.senderId = "peer-alice"; m.senderName = "Alice"; m.text = "Ahoj"; m.createdAt = PeopleFakeRoom.t0
        w.room.messages = [m]
        PeopleParts.showSender("m1", host: w.host)
        XCTAssertEqual(w.host.sheet?.screen, "message.sender")
        XCTAssertEqual(w.host.form["sender"]?["title"], "Alice Nováková")
    }

    func testThePublicProfileOnRequestAndWhetherItIsVerified() async throws {
        let w = PeopleWorld.make()
        w.profiles.publicProfiles["alice-novak"] = JSONObject([("profile", .object(JSONObject([("v", 1), ("nickname", "Alice N.")]))),
                                                               ("accountKey", .string(String(repeating: "A", count: 43)))])
        w.room.accountKeys["peer-alice"] = String(repeating: "A", count: 43)
        w.profiles.fetchPublic("alice-novak")
        XCTAssertEqual(w.person("peer-alice")?.object("profile")?.optString("publicState"), "loading")
        await PeopleWorld.settle()
        let pf = try XCTUnwrap(w.person("peer-alice")?.object("profile"))
        XCTAssertEqual(pf.optString("publicState"), "ok")
        XCTAssertEqual(pf.object("public")?.optString("nickname"), "Alice N.")
        XCTAssertEqual(pf.bool("publicVerified"), true)
    }

    // MARK: pictures

    private func picture(_ w: Int, _ h: Int) -> Data {
        let r = UIGraphicsImageRenderer(size: CGSize(width: w, height: h), format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }())
        let img = r.image { ctx in
            for i in 0..<16 {
                UIColor(hue: CGFloat(i) / 16, saturation: 0.8, brightness: 0.9, alpha: 1).setFill()
                ctx.fill(CGRect(x: CGFloat(i) * CGFloat(w) / 16, y: 0, width: CGFloat(w) / 16, height: CGFloat(h)))
            }
        }
        // A JPEG with a GPS position in its metadata.
        let out = NSMutableData()
        let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil)!
        let gps: [CFString: Any] = [kCGImagePropertyGPSLatitude: 50.08, kCGImagePropertyGPSLongitude: 14.42]
        CGImageDestinationAddImage(dest, img.cgImage!, [kCGImagePropertyGPSDictionary: gps, kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary)
        CGImageDestinationFinalize(dest)
        return out as Data
    }

    func testAPictureBecomesACleanSmallJpeg() throws {
        let raw = picture(3000, 2000)
        let avatar = try ProfileImageEncoder.encode(raw, kind: "avatar")
        XCTAssertTrue(avatar.hasPrefix("data:image/jpeg;base64,"))
        let bytes = try XCTUnwrap(Data(base64Encoded: String(avatar.dropFirst("data:image/jpeg;base64,".count))))
        XCTAssertLessThanOrEqual(bytes.count, ProfileCard.avatarBytes)
        let src = try XCTUnwrap(CGImageSourceCreateWithData(bytes as CFData, nil))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any])
        XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, 256)
        XCTAssertEqual(props[kCGImagePropertyPixelHeight] as? Int, 256)
        XCTAssertNil(props[kCGImagePropertyGPSDictionary], "no position leaves the phone")
        XCTAssertNil(props[kCGImagePropertyExifDictionary])
        // The background: a 3:1 band, 1200 × 400.
        let cover = try ProfileImageEncoder.encode(raw, kind: "cover")
        let cb = try XCTUnwrap(Data(base64Encoded: String(cover.dropFirst("data:image/jpeg;base64,".count))))
        let cp = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(CGImageSourceCreateWithData(cb as CFData, nil)!, 0, nil) as? [CFString: Any])
        XCTAssertLessThanOrEqual(cb.count, ProfileCard.coverBytes)
        XCTAssertEqual((cp[kCGImagePropertyPixelWidth] as? Int).map { Double($0) / Double(cp[kCGImagePropertyPixelHeight] as! Int) } ?? 0, 3, accuracy: 0.02)
        // Not a picture.
        XCTAssertThrowsError(try ProfileImageEncoder.encode(Data("hello".utf8), kind: "avatar")) { e in
            XCTAssertEqual(e as? ProfileImages.Failure, .notAnImage)
        }
    }
}
