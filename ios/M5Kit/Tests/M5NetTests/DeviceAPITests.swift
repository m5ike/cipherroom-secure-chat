// The signed device API: request signatures against vectors signed by the
// server's code (device-vectors.json), the signed policy, the server pin, the
// enrolment link, and a whole device session through the server's real
// /api/ios/* routes replayed (ios-api.json): enrolment with the pin, a signed
// check-in, the sealed command, the design bundle, the signed release record.

import Foundation
import Testing
@testable import M5Net

private let iosBase = "http://127.0.0.1:5000"

@Suite struct DeviceSigningTests {
    let v: NetJSON
    init() throws { v = try Fixtures.device() }

    @Test func requestStringsAndSignaturesAreTheServers() async throws {
        let signer = try SoftwareRequestSigner(derBase64: v.str("devicePkcs8"))
        #expect(try await signer.publicKeySPKI() == v.str("devicePublicKey"))
        #expect(P256Keys.kid(spki: v.str("devicePublicKey")) == v.str("deviceKid"))
        #expect(P256Keys.fingerprint(spki: v.str("devicePublicKey")) == v.str("deviceFingerprint"))
        for r in v.arr("requests") ?? [] {
            let body = Bytes.unb64(r.str("bodyB64"))!
            let s = DeviceSigning.requestString(method: r.str("method"), pathAndQuery: r.str("path"), time: r.str("time"), nonce: r.str("nonce"), body: body)
            #expect(s == r.str("string"))
            // The server's signature verifies here; ours verifies with the same key.
            #expect(P256Keys.verify(spki: v.str("devicePublicKey"), text: s, signature: r.str("signature")))
            let headers = try await DeviceSigning.headers(deviceId: "ios_x", method: r.str("method"), pathAndQuery: r.str("path"), body: body,
                                                          time: Int64(r.str("time"))!, signer: signer, nonce: r.str("nonce"))
            #expect(headers["X-M5-Time"] == r.str("time") && headers["X-M5-Nonce"] == r.str("nonce") && headers["X-M5-Device"] == "ios_x")
            #expect(P256Keys.verify(spki: v.str("devicePublicKey"), text: s, signature: headers["X-M5-Signature"]!))
            #expect(!P256Keys.verify(spki: v.str("devicePublicKey"), text: s + "x", signature: headers["X-M5-Signature"]!))
        }
        let e = try #require(v.obj("enroll"))
        #expect(DeviceSigning.enrollString(signKey: e.str("signKey"), encKey: e.str("encKey"), time: e.int("time")) == e.str("string"))
        #expect(P256Keys.verify(spki: e.str("signKey"), text: e.str("string"), signature: e.str("proof")))
    }

    @Test func aRandomNonceIs16BytesOfBase64url() async throws {
        let h = try await DeviceSigning.headers(deviceId: "d", method: "GET", pathAndQuery: "/x", body: Data(), time: 1, signer: SoftwareRequestSigner())
        #expect(Bytes.unb64url(h["X-M5-Nonce"]!)?.count == 16)
        #expect(Bytes.unb64(h["X-M5-Signature"]!)?.count == 64)
    }

    @Test func thePolicyAppliesOnlyAsTheServerSignedItForThisDevice() throws {
        let key = v.obj("server")!.str("publicKey")
        let p = try #require(SignedDevicePolicy.open(v.obj("policy"), serverKey: key, deviceId: "ios_vector0001", lastAt: 0))
        #expect(p.at == 1_800_000_000_000)
        #expect(p.policy.obj("lock")?.bool("screenshots", true) == false)
        #expect(p.policy.obj("rooms")?.int("max") == 5)
        #expect(SignedDevicePolicy.open(v.obj("policy"), serverKey: key, deviceId: "ios_vector0001", lastAt: 1_800_000_000_000) != nil) // the same again
        #expect(SignedDevicePolicy.open(v.obj("policy"), serverKey: key, deviceId: "ios_vector0001", lastAt: 1_800_000_000_001) == nil) // a replay
        #expect(SignedDevicePolicy.open(v.obj("policyOtherDevice"), serverKey: key, deviceId: "ios_vector0001", lastAt: 0) == nil)
        #expect(SignedDevicePolicy.open(v.obj("policy"), serverKey: v.str("devicePublicKey"), deviceId: "ios_vector0001", lastAt: 0) == nil)
        let tampered = v.obj("policy")!.with("policy", .string(v.obj("policy")!.str("policy").replacingOccurrences(of: "\"screenshots\":false", with: "\"screenshots\":true")))
        #expect(SignedDevicePolicy.open(tampered, serverKey: key, deviceId: "ios_vector0001", lastAt: 0) == nil)
        #expect(SignedDevicePolicy.open(v.obj("policy")!.with("at", 1_800_000_000_002), serverKey: key, deviceId: "ios_vector0001", lastAt: 0) == nil)
        #expect(SignedDevicePolicy.open(nil, serverKey: key, deviceId: "ios_vector0001", lastAt: 0) == nil)
        #expect(SignedDevicePolicy.open(.object([:]), serverKey: key, deviceId: "ios_vector0001", lastAt: 0) == nil)
        #expect(SignedDevicePolicy.open(v.obj("policy"), serverKey: "", deviceId: "ios_vector0001", lastAt: 0) == nil)
        // Android's vector (SignedPolicyTest): the same format.
        let nodeKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkbXImCDqgGYKZpLQXxNgmWauLY/95ict9xpD99v0DRKBB2FBS04nu/7QDeGD/yDfS0KdIil5PTqP65jPmBRXGQ=="
        let nodeWire = try NetJSON.parse(#"{"at":1767225600000,"policy":"{\"lock\":{\"pinLength\":6,\"maxAttempts\":8,\"wipe\":true,\"screenshots\":false,\"autolockSeconds\":60},\"logs\":\"errors\"}","sig":"MBx8PB0dZ3HvzifYelc46hPRQ2zAg2mDDTCvM+ZHQJ35DKYjsonwez7y8QzZCZ7XhKzqhAiVITVTdWqF0DUHOw=="}"#)
        #expect(SignedDevicePolicy.open(nodeWire, serverKey: nodeKey, deviceId: "and_test1", lastAt: 0)?.policy.obj("lock")?.int("maxAttempts") == 8)
        #expect(SignedDevicePolicy.open(nodeWire, serverKey: nodeKey, deviceId: "and_other", lastAt: 0) == nil)
    }

    @Test func theServerStateAppliesAnswers() throws {
        let key = v.obj("server")!.str("publicKey")
        var st = DeviceState(server: iosBase, deviceId: "ios_vector0001", serverKey: key, serverKid: v.obj("server")!.str("kid"))
        #expect(st.apply(serverAnswer: ["policySigned": v.obj("policy")!, "pollSeconds": 600, "apns": ["topic": "cz.m5cet.app"]]) == .applied(at: 1_800_000_000_000))
        #expect(st.maxRooms == 5 && st.pollSeconds == 900 && st.push?.str("topic") == "cz.m5cet.app")
        #expect(st.apply(serverAnswer: ["policySigned": v.obj("policyOlder")!]) == .ignored(reason: "a policy with a bad or old signature was ignored"))
        #expect(st.apply(serverAnswer: ["policy": ["lock": ["wipe": false]]]) == .ignored(reason: "an unsigned policy was ignored"))
        #expect(st.lockPolicy.bool("wipe") == true)
        #expect(DeviceState(json: st.json) == st)
    }

    @Test func releaseRecordsAreCheckedAgainstTheirSignedString() throws {
        let key = v.obj("server")!.str("publicKey")
        let ios = try ReleaseWatcher.verify(v.obj("iosReleaseAnswer")!, serverKey: key)
        #expect(ios.build == 61500 && ios.store == "appstore" && ios.minBuild == 61450 && ios.notes("cs") == "Rychlejší" && ios.notes("de") == "Faster")
        #expect(ios.signedString == v.obj("iosReleaseAnswer")!.str("signed"))
        let android = try ReleaseWatcher.verify(v.obj("releaseAnswer")!, serverKey: key)
        #expect(android.build == 61500 && android.version == "6.15.0")
        // Another record's signature, a forged signed string, another key: refused.
        let swapped = v.obj("iosReleaseAnswer")!.with("release", v.obj("iosReleaseAnswer")!.obj("release")!.with("url", "https://evil.example/app"))
        #expect(throws: NetError.self) { try ReleaseWatcher.verify(swapped, serverKey: key) }
        #expect(throws: NetError.self) { try ReleaseWatcher.verify(v.obj("iosReleaseAnswer")!, serverKey: v.str("devicePublicKey")) }
        var w = ReleaseWatcher()
        #expect(w.onCheckin(ios, appCode: 61400) == .available(ios, isNew: true))
        #expect(w.onCheckin(ios, appCode: 61400) == .available(ios, isNew: false))
        #expect(w.onCheckin(ios, appCode: 61500) == .none)
        #expect(ReleaseWatcher.mustUpdate(appCode: 61400, serverMinBuild: 0, release: ios))
        #expect(!ReleaseWatcher.mustUpdate(appCode: 61460, serverMinBuild: 0, release: ReleaseRecord(ios.raw.with("mandatory", false))))
        #expect(ReleaseWatcher.mustUpdate(appCode: 61460, serverMinBuild: 61500, release: nil))
    }

    @Test func controlMessagesAreCheckedOpenedAndDeduplicated() async throws {
        let key = v.obj("server")!.str("publicKey")
        let opener = try TestEciesOpener(pkcs8Base64: v.str("devicePkcs8"))
        let store = MemoryNetStateStore()
        let inbox = ControlInbox(store: store, opener: opener)
        guard case .command(let c) = await inbox.handle(v.obj("push")!, deviceId: "ios_vector0001", serverKey: key, via: "apns") else {
            Issue.record("not opened"); return
        }
        #expect(c.kind == .lock && c.payload.str("reason") == "lost" && c.via == "apns")
        guard case .duplicate = await inbox.handle(v.obj("push")!, deviceId: "ios_vector0001", serverKey: key, via: "checkin") else { Issue.record("not a duplicate"); return }
        guard case .dropped(let why) = await inbox.handle(v.obj("pushExpired")!, deviceId: "ios_vector0001", serverKey: key, via: "apns") else { Issue.record("expired kept"); return }
        #expect(why.contains("expired"))
        guard case .dropped = await inbox.handle(v.obj("push")!.with("i", "msg_other"), deviceId: "ios_vector0001", serverKey: key, via: "apns") else { Issue.record("forged id"); return }
        guard case .dropped = await inbox.handle(v.obj("push")!, deviceId: "ios_other", serverKey: key, via: "apns") else { Issue.record("other device"); return }
        // The APNs payload carries the wire under "m5".
        #expect(ControlInbox.wire(fromPush: ["aps": ["alert": "x"], "m5": v.obj("push")!]) == v.obj("push"))
        #expect(ControlInbox.wire(fromPush: ["aps": ["alert": "x"]]) == nil)
    }

    @Test func theAndroidInteropVectorsOpen() async throws {
        let and = try #require(try Fixtures.interop().obj("android"))
        let opener = try TestEciesOpener(pkcs8Base64: and.str("devicePkcs8"))
        // The server's design bundle for this device.
        let file = try DesignBundleFile.parse(Bytes.unb64(and.str("bundle"))!)
        #expect(file.verify(serverKey: and.str("serverPublicKey")))
        #expect(!file.verify(serverKey: and.str("devicePublicKey")))
        #expect(file.header.kid == and.str("serverKid"))
        let state = DeviceState(server: iosBase, deviceId: and.str("deviceId"), serverKey: and.str("serverPublicKey"), serverKid: and.str("serverKid"))
        let bundle = try await DesignBundles.open(Bytes.unb64(and.str("bundle"))!, id: file.header.id, appCode: 70000, state: state, opener: opener)
        #expect(bundle.content.prefix(2) == Data([0x1F, 0x8B])) // gzip: the M5PK container for M5Design
        await #expect(throws: NetError.self) { try await DesignBundles.open(Bytes.unb64(and.str("bundle"))!, id: file.header.id, appCode: 50000, state: state, opener: opener) }
        var other = state
        other.deviceId = "and_other"
        await #expect(throws: NetError.self) { try await DesignBundles.open(Bytes.unb64(and.str("bundle"))!, id: file.header.id, appCode: 70000, state: other, opener: opener) }
        // A flipped ciphertext byte.
        var broken = Bytes.unb64(and.str("bundle"))!
        broken[broken.count - 20] ^= 1
        await #expect(throws: NetError.self) { try await DesignBundles.open(broken, id: file.header.id, appCode: 70000, state: state, opener: opener) }
        // The server's control message (its content says exp: 2 — read with a clock before that).
        let inbox = ControlInbox(store: MemoryNetStateStore(), opener: opener, clock: NetClock { 1 })
        let outcome = await inbox.handle(and.obj("push")!, deviceId: and.str("deviceId"), serverKey: and.str("serverPublicKey"), via: "fcm")
        guard case .command(let c) = outcome else { Issue.record("push not opened: \(outcome)"); return }
        #expect(c.kind == .flash && c.payload.str("text") == "ahoj")
    }
}

@Suite struct ServerKeyPinTests {
    let key = Bytes.b64(SoftwareRequestSigner().key.publicKey.derRepresentation)
    let other = Bytes.b64(SoftwareRequestSigner().key.publicKey.derRepresentation)

    @Test func theRightKeyPasses() throws {
        let kid = P256Keys.kid(spki: key)
        #expect(try ServerKeyPin.check(publicKey: key, statedKid: kid) == kid)
        #expect(try ServerKeyPin.check(publicKey: key, statedKid: kid, pins: ["", nil, kid]) == kid)
        #expect(try ServerKeyPin.check(publicKey: key, statedKid: kid, pins: [P256Keys.fingerprint(spki: key), kid]) == kid)
    }

    /// The attack of V6: a forged server repeats the expected kid but sends its own key.
    @Test func aForgedServerRepeatingTheKidIsRefused() {
        let pinned = P256Keys.kid(spki: key)
        expectRefusal("does not match the key id") { try ServerKeyPin.check(publicKey: other, statedKid: pinned, pins: [pinned]) }
        expectRefusal("is not the pinned key") { try ServerKeyPin.check(publicKey: other, statedKid: P256Keys.kid(spki: other), pins: [pinned]) }
        expectRefusal("is not the pinned key") { try ServerKeyPin.check(publicKey: other, statedKid: P256Keys.kid(spki: other), pins: ["", pinned]) }
    }

    @Test func everyFormOfThePinNamesTheKey() {
        let hash = Bytes.sha256(Bytes.unb64(key)!)
        let hex = Bytes.hex(hash)
        #expect(ServerKeyPin.matches(spki: key, pin: P256Keys.kid(spki: key)))
        #expect(ServerKeyPin.matches(spki: key, pin: P256Keys.fingerprint(spki: key)))
        #expect(ServerKeyPin.matches(spki: key, pin: P256Keys.fingerprint(spki: key).replacingOccurrences(of: " ", with: "")))
        #expect(ServerKeyPin.matches(spki: key, pin: hex))
        let colons = stride(from: 0, to: hex.count, by: 2).map { i in String(hex.uppercased()[hex.index(hex.startIndex, offsetBy: i)..<hex.index(hex.startIndex, offsetBy: i + 2)]) }.joined(separator: ":")
        #expect(ServerKeyPin.matches(spki: key, pin: colons))
        #expect(ServerKeyPin.matches(spki: key, pin: Bytes.b64url(hash)))
        #expect(ServerKeyPin.matches(spki: key, pin: Bytes.b64(hash)))
        #expect(ServerKeyPin.matches(spki: key, pin: "  " + P256Keys.kid(spki: key) + " "))
        for o in [P256Keys.kid(spki: other), P256Keys.fingerprint(spki: other), Bytes.hex(Bytes.sha256(Bytes.unb64(other)!)), "", "x", String(hex.prefix(40))] {
            #expect(!ServerKeyPin.matches(spki: key, pin: o), "\(o)")
        }
        #expect(!ServerKeyPin.matches(spki: key, pin: nil))
    }

    @Test func aBrokenKeyIsRefused() {
        expectRefusal("no key") { try ServerKeyPin.check(publicKey: "", statedKid: "abc") }
        expectRefusal("no key") { try ServerKeyPin.check(publicKey: nil, statedKid: "abc") }
        expectRefusal("not a valid P-256 key") { try ServerKeyPin.check(publicKey: "not base64!", statedKid: "abc") }
        expectRefusal("not a valid P-256 key") { try ServerKeyPin.check(publicKey: Bytes.b64(Data(count: 91)), statedKid: "abc") }
        expectRefusal("does not match the key id") { try ServerKeyPin.check(publicKey: key, statedKid: nil) }
    }

    @Test func theKeyMustNotChangeDuringEnrolment() throws {
        try ServerKeyPin.same(checked: key, answered: key, answeredKid: P256Keys.kid(spki: key))
        expectRefusal("changed its key") { try ServerKeyPin.same(checked: key, answered: other, answeredKid: P256Keys.kid(spki: other)) }
        expectRefusal("does not match the key id") { try ServerKeyPin.same(checked: key, answered: key, answeredKid: P256Keys.kid(spki: other)) }
        expectRefusal("changed its key") { try ServerKeyPin.same(checked: "", answered: "", answeredKid: "") }
    }

    func expectRefusal(_ words: String, _ body: () throws -> Void) {
        do {
            try body()
            Issue.record("accepted, expected: \(words)")
        } catch let e as NetError {
            #expect("\(e)".contains(words), "\(e)")
        } catch {
            Issue.record("\(error)")
        }
    }
}

@Suite struct EnrollLinkTests {
    let kid = "DbEdmBPXJKyqeplx"

    @Test func theConsolesLink() throws {
        let l = try #require(EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fchat.fir.ma&kid=\(kid)"))
        #expect(l.server == "https://chat.fir.ma" && l.code == "" && l.kid == kid)
        #expect(EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fchat.fir.ma&kid=\(kid)&code=ABCD-EFGH-JKLM")?.code == "ABCD-EFGH-JKLM")
    }

    @Test func theServerIsNormalised() {
        #expect(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma")?.server == "https://chat.fir.ma")
        #expect(EnrollLink.parse("m5cet://enroll?server=HTTPS%3A%2F%2FChat.Fir.MA%2F%2F")?.server == "https://chat.fir.ma")
        #expect(EnrollLink.parse("m5cet://enroll?server=https%3A%2F%2Fchat.example.com%3A8443%2Fm5%2F")?.server == "https://chat.example.com:8443/m5")
        #expect(EnrollLink.parse("m5cet://enroll?server=http%3A%2F%2F192.168.1.20%3A5000")?.server == "http://192.168.1.20:5000")
        #expect(EnrollLink.parse("m5cet://enroll?server=https://chat.fir.ma&kid=\(kid)")?.server == "https://chat.fir.ma")
        #expect(EnrollLink.parse("m5cet://enroll?server=+chat.fir.ma+")?.server == "https://chat.fir.ma")
    }

    @Test func notAServer() {
        for link in ["m5cet://enroll", "m5cet://enroll?kid=\(kid)", "m5cet://enroll?server=", "m5cet://enroll?server=%20%20",
                     "m5cet://enroll?server=javascript%3Aalert(1)", "m5cet://enroll?server=ftp%3A%2F%2Fchat.fir.ma",
                     "m5cet://enroll?server=file%3A%2F%2F%2Fetc%2Fpasswd", "m5cet://enroll?server=https%3A%2F%2Fuser%40evil.example",
                     "m5cet://enroll?server=https%3A%2F%2Fchat.fir.ma%2F%3Fx%3D1", "m5cet://enroll?server=https%3A%2F%2Fchat.fir.ma%23frag",
                     "m5cet://enroll?server=https%3A%2F%2Fchat.fir.ma%3A99999", "m5cet://enroll?server=https%3A%2F%2F",
                     "m5cet://enroll?server=https%3A%2F%2Fchat%ZZfir.ma"] {
            #expect(EnrollLink.parse(link) == nil, "\(link)")
        }
    }

    @Test func aDamagedKidIsRefused() {
        #expect(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=short") == nil)
        #expect(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=\(kid)X") == nil)
        #expect(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=DbEdmBPX%2FKyqeplx") == nil)
        #expect(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=DbEdmBPX%3CKyqeplx") == nil)
        #expect(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=")?.kid == "")
        #expect(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&kid=Ab-_0123456789xy")?.kid == "Ab-_0123456789xy")
    }

    @Test func junkIsIgnored() {
        let l = EnrollLink.parse("m5cet://enroll?utm_source=qr&server=chat.fir.ma&code=%3Cscript%3E&x&=y&kid=\(kid)&junk=%ZZ")
        #expect(l?.server == "https://chat.fir.ma" && l?.code == "" && l?.kid == kid)
        #expect(EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&code=abcd-+efgh")?.code == "ABCD-EFGH")
        let first = EnrollLink.parse("m5cet://enroll?server=chat.fir.ma&server=evil.example&code=AAAA&code=BBBB")
        #expect(first?.server == "https://chat.fir.ma" && first?.code == "AAAA")
    }

    @Test func onlyEnrolmentLinks() {
        #expect(EnrollLink.isEnrollLink("M5CET://ENROLL?server=chat.fir.ma"))
        #expect(EnrollLink.parse("M5CET://ENROLL?server=chat.fir.ma") != nil)
        #expect(!EnrollLink.isEnrollLink("m5cet://join?server=chat.fir.ma"))
        #expect(EnrollLink.parse("m5cet://join?server=chat.fir.ma") == nil)
        #expect(EnrollLink.parse("https://chat.fir.ma/enroll?server=chat.fir.ma") == nil)
        #expect(EnrollLink.parse("m5cet:enroll?server=chat.fir.ma") == nil)
        #expect(EnrollLink.parse("not a link at all") == nil)
        #expect(EnrollLink.parse(nil) == nil)
    }

    @Test func sameServer() {
        #expect(EnrollLink.sameServer("https://chat.fir.ma", "chat.fir.ma/"))
        #expect(EnrollLink.sameServer("https://Chat.Fir.ma", "https://chat.fir.ma"))
        #expect(!EnrollLink.sameServer("https://chat.fir.ma", "http://chat.fir.ma"))
        #expect(!EnrollLink.sameServer("https://chat.fir.ma", "https://chat.fir.ma:8443"))
        #expect(!EnrollLink.sameServer("https://chat.fir.ma", ""))
        #expect(!EnrollLink.sameServer(nil, nil))
        #expect(EnrollLink.sameHost("http://chat.fir.ma", "https://chat.fir.ma"))
        #expect(EnrollLink.sameHost("chat.fir.ma", "https://chat.fir.ma/"))
        #expect(!EnrollLink.sameHost("https://chat.fir.ma.evil.example", "https://chat.fir.ma"))
        #expect(!EnrollLink.sameHost("https://chat.fir.ma:8443", "https://chat.fir.ma"))
        #expect(!EnrollLink.sameHost("", "https://chat.fir.ma"))
    }
}

/// A device's session through the server's real /api/ios/* routes, replayed (fixtures/ios-api.json).
@Suite struct IOSDeviceSessionTests {
    let s: NetJSON
    init() throws { s = try Fixtures.json(Fixtures.here.appendingPathComponent("ios-api.json")) }

    var device: DeviceDescription {
        DeviceDescription(name: "Test iPhone", model: "iPhone17,1", modelName: "iPhone 17 Pro", idiom: "phone", os: "iOS", osVersion: "26.0", locale: "cs")
    }

    /// The server as it answered (the answers of the captured session, by path).
    func server(enrollKey: String? = nil) -> StubHTTP {
        let s = self.s
        return StubHTTP { req in
            switch (req.method, req.url.path) {
            case ("GET", "/api/ios/info"): return StubHTTP.json(s.obj("info")!)
            case ("POST", "/api/ios/enroll"):
                var e = s.obj("enroll")!
                if let enrollKey { e = e.with("server", e.obj("server")!.with("publicKey", .string(enrollKey))) }
                return StubHTTP.json(e)
            case ("POST", "/api/ios/checkin"): return StubHTTP.json(s.obj("checkin")!)
            case ("GET", let p) where p.hasPrefix("/api/ios/bundles/"):
                return HTTPResponse(status: 200, headers: ["Content-Type": "application/vnd.m5cet.bundle"], body: Bytes.unb64(s.str("bundleFile"))!)
            case ("GET", let p) where p.hasPrefix("/api/ios/releases/"): return StubHTTP.json(s.obj("release")!)
            case ("POST", "/api/ios/ack"): return StubHTTP.json(s.obj("ack")!)
            case ("POST", "/api/ios/events"): return StubHTTP.json(s.obj("events")!)
            case ("POST", "/api/ios/notify"): return StubHTTP.json(Int(s.obj("notify")!.int("status")), s.obj("notify")!.obj("body")!)
            default: return StubHTTP.json(404, ["ok": false, "message": "no"])
            }
        }
    }

    @Test func enrolsChecksInAndOpensWhatTheServerSent() async throws {
        let http = server()
        let client = DeviceAPIClient(http: HTTPClient(transport: http))
        let signer = try SoftwareRequestSigner(derBase64: s.str("devicePkcs8"))
        let spki = try await signer.publicKeySPKI()
        let info = s.obj("info")!
        let push = PushTokens(token: String(repeating: "c0ffee", count: 10) + "abcd", apnsEnv: "sandbox")
        var state = try await DeviceEnrollment.enroll(base: iosBase, code: "", device: device, push: push, pins: [info.obj("server")!.str("kid")],
                                                      signer: signer, encKey: spki, client: client)
        #expect(state.deviceId == s.str("deviceId"))
        #expect(state.serverKey == info.obj("server")!.str("publicKey"))
        #expect(state.serverFingerprint == info.obj("server")!.str("fingerprint"))
        #expect(state.policyAt > 0 && state.lockPolicy.int("pinLength") == 6)
        // The enrolment body carries the fields the server read, and its proof verifies.
        let enrollReq = try #require(http.requests.first { $0.url.path == "/api/ios/enroll" }?.jsonBody)
        #expect(Set(enrollReq.objectValue!.keys) == Set(s.obj("enrollRequest")!.objectValue!.keys))
        #expect(P256Keys.verify(spki: spki, text: DeviceSigning.enrollString(signKey: spki, encKey: spki, time: enrollReq.int("time")), signature: enrollReq.str("proof")))

        // The check-in: signed as the server checks it, the answer applied.
        let creds = try DeviceEnrollment.credentials(state, signer: signer)
        let status = DeviceStatusReport(battery: 80, network: "wifi", rooms: 1, push: "poll", lockMode: "pin", storage: 1024, policyAt: state.policyAt, biometry: "faceID")
        let result = try await Checkin.run(client: client, credentials: creds, state: &state, device: device, status: status, push: PushTokens())
        let req = try #require(http.requests.first { $0.url.path == "/api/ios/checkin" })
        let canonical = DeviceSigning.requestString(method: "POST", pathAndQuery: "/api/ios/checkin", time: req.headers["X-M5-Time"]!, nonce: req.headers["X-M5-Nonce"]!, body: req.body!)
        #expect(P256Keys.verify(spki: spki, text: canonical, signature: req.headers["X-M5-Signature"]!))
        #expect(req.headers["X-M5-Device"] == state.deviceId)
        #expect(Set(req.jsonBody!.objectValue!.keys).isSubset(of: Set(s.obj("checkinRequest")!.objectValue!.keys)))
        #expect(Set(req.jsonBody!.obj("state")!.objectValue!.keys) == Set(s.obj("checkinRequest")!.obj("state")!.objectValue!.keys))
        #expect(result.push == "poll" && !result.updateRequired)
        #expect(result.bundle?.id == s.str("buildId"))
        #expect(result.release?.build == 61500 && result.release?.url.hasPrefix("https://apps.apple.com/") == true)

        // The sealed command.
        let opener = try TestEciesOpener(pkcs8Base64: s.str("devicePkcs8"))
        let inbox = ControlInbox(store: MemoryNetStateStore(), opener: opener)
        let wire = try #require(result.commands.first { $0.str("i") == s.str("commandId") })
        guard case .command(let cmd) = await inbox.handle(wire, deviceId: state.deviceId, serverKey: state.serverKey, via: "checkin") else { Issue.record("command"); return }
        #expect(cmd.kind == .lock && cmd.payload.str("reason") == "lost")
        #expect(try await client.ack(creds, id: cmd.id, ok: true, result: ["locked": true], error: nil).str("status") == "done")

        // The design bundle: signed by the pinned key, sealed for this device.
        let bundle = try await DesignBundles.download(id: result.bundle!.id, appCode: 61400, state: state, credentials: creds, client: client, opener: opener)
        #expect(bundle.header.id == s.str("buildId") && bundle.header.kid == state.serverKid)
        #expect(bundle.content.prefix(2) == Data([0x1F, 0x8B]))
        #expect(DesignBundles.wanted(result.bundle!, appCode: 61400, activeId: "", stagedId: "", trialId: "", failed: []))
        #expect(!DesignBundles.wanted(result.bundle!, appCode: 61399, activeId: "", stagedId: "", trialId: "", failed: []))

        // The release record, signed.
        let record = try ReleaseWatcher.verify(try await client.release(creds, id: result.release!.id), serverKey: state.serverKey)
        #expect(record.version == "6.15.0" && record.notes("cs") == "Rychlejší")

        // Events; the account link refused without a session.
        #expect(try await client.events(creds, [DeviceEvent(type: "unlock", at: 1)]) == 1)
        await #expect(throws: HTTPError.self) { try await client.notify(creds, on: true, token: "not-a-session") }
    }

    @Test func aPinThatDoesNotNameTheServersKeyStopsTheEnrolment() async throws {
        let client = DeviceAPIClient(http: HTTPClient(transport: server()))
        let signer = try SoftwareRequestSigner(derBase64: s.str("devicePkcs8"))
        await #expect(throws: NetError.self) {
            _ = try await DeviceEnrollment.enroll(base: iosBase, code: "", device: device, push: PushTokens(), pins: ["DbEdmBPXJKyqeplx"], signer: signer,
                                                  encKey: try await signer.publicKeySPKI(), client: client)
        }
        // The key changes between /info and /enroll.
        let switched = DeviceAPIClient(http: HTTPClient(transport: server(enrollKey: try await SoftwareRequestSigner().publicKeySPKI())))
        await #expect(throws: NetError.self) {
            _ = try await DeviceEnrollment.enroll(base: iosBase, code: "", device: device, push: PushTokens(), pins: [], signer: signer,
                                                  encKey: try await signer.publicKeySPKI(), client: switched)
        }
    }

    @Test func aWipedDeviceIsToldSo() async throws {
        let http = StubHTTP { _ in StubHTTP.json(403, ["ok": false, "code": "device-wiped", "message": "This device is wiped."]) }
        var state = DeviceState(server: iosBase, deviceId: "ios_x", serverKey: "k", serverKid: "k")
        let creds = DeviceCredentials(server: iosBase, deviceId: "ios_x", signer: SoftwareRequestSigner())
        await #expect(throws: CheckinError.device(status: "wiped")) {
            _ = try await Checkin.run(client: DeviceAPIClient(http: HTTPClient(transport: http)), credentials: creds, state: &state, device: device,
                                      status: DeviceStatusReport(), push: PushTokens())
        }
    }

    @Test func requestsSignedForLaterVerifyAndCarryTheServersPrefix() async throws {
        let signer = try SoftwareRequestSigner(derBase64: s.str("devicePkcs8"))
        let client = DeviceAPIClient(http: HTTPClient(transport: server()))
        let creds = DeviceCredentials(server: "https://chat.example.com/m5", deviceId: "ios_x", signer: signer)
        let p = try await client.presignEvents(creds, [DeviceEvent(id: "evfixture02", type: "wipe", at: 5)])
        #expect(p.url == "https://chat.example.com/m5/api/ios/events")
        let canonical = DeviceSigning.requestString(method: "POST", pathAndQuery: "/m5/api/ios/events", time: p.headers["X-M5-Time"]!, nonce: p.headers["X-M5-Nonce"]!, body: p.body)
        #expect(P256Keys.verify(spki: try await signer.publicKeySPKI(), text: canonical, signature: p.headers["X-M5-Signature"]!))
        #expect(try NetJSON.parse(p.body).arr("events")?.first?.str("type") == "wipe")
    }

    @Test func androidBodiesKeepAndroidsFields() {
        let d = DeviceDescription(name: "Pixel", model: "Pixel 9", os: "Android", osVersion: "16", locale: "en", sdk: 36, manufacturer: "Google")
        let b = Checkin.body(device: d, status: DeviceStatusReport(push: "fcm"), push: PushTokens(token: "fcm-token"), config: .android)
        #expect(b.int("sdk") == 36 && b.str("fcmToken") == "fcm-token" && b["apnsToken"] == nil && b["osVersion"] == nil)
        let i = Checkin.body(device: device, status: DeviceStatusReport(), push: PushTokens(token: "", voip: "ab"), config: .ios)
        #expect(i.str("apnsToken", "x") == "" && i.str("voipToken") == "ab" && i["apnsEnv"] == nil && i["sdk"] == nil && i.str("osVersion") == "26.0")
    }
}

@Suite struct HTTPClientTests {
    @Test func errorsCarryTheServersCodeMessageAndRetryAfter() async throws {
        let http = HTTPClient(transport: StubHTTP { _ in HTTPResponse(status: 429, headers: ["Retry-After": "30"], body: Data(#"{"ok":false,"code":"rate-limited","message":"slow down"}"#.utf8)) })
        do {
            _ = try await http.json("GET", URL(string: "https://h/x")!)
            Issue.record("no error")
        } catch let e as HTTPError {
            #expect(e.status == 429 && e.code == "rate-limited" && e.message == "slow down" && e.retryAfter == 30)
            #expect(AccountErrors.refusalCode(status: e.status, code: e.code) == "rate-limited")
        }
        let html = HTTPClient(transport: StubHTTP { _ in HTTPResponse(status: 502, body: Data("<html>".utf8)) })
        await #expect(throws: HTTPError.self) { _ = try await html.json("GET", URL(string: "https://h/x")!) }
        let notJSON = HTTPClient(transport: StubHTTP { _ in HTTPResponse(status: 200, body: Data("[1]".utf8)) })
        await #expect(throws: NetError.badAnswer("not a JSON answer")) { _ = try await notJSON.json("GET", URL(string: "https://h/x")!) }
    }

    @Test func requestsCarryTheAppsHeaders() async throws {
        let stub = StubHTTP { _ in StubHTTP.json(["ok": true]) }
        let http = HTTPClient(transport: stub, userAgent: M5NetInfo.userAgent(version: "6.14.0"))
        _ = try await http.json("POST", URL(string: "https://h/x")!, body: ["a": 1])
        _ = try await http.json("GET", URL(string: "https://h/y")!, body: ["ignored": true])
        #expect(stub.requests[0].headers["User-Agent"] == "M5cet-iOS/6.14.0")
        #expect(stub.requests[0].headers["Content-Type"] == "application/json" && stub.requests[0].body == Data(#"{"a":1}"#.utf8))
        #expect(stub.requests[1].body == nil)
        #expect(normalizeServer(" chat.fir.ma// ") == "https://chat.fir.ma")
        #expect(normalizeServer("HTTP://x") == "HTTP://x")
    }
}
