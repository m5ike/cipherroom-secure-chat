// The lock inbox's format (Android LockBoxTest, case for case): items sealed to a
// generation's public key while the data key is gone, opened only with the private
// key the data key seals; in order, each once; a crash keeps what was written. And
// the format byte for byte: a generation written by Android's algorithm (made with
// node:crypto — PKCS#8 key, ECDH, HKDF, AES-GCM, the same labels) opens here.

import CryptoKit
import XCTest
@testable import M5cet

final class LockBoxTests: XCTestCase {
    /// A lock: a generation whose private key is sealed by the data key and written; only the public key stays.
    private struct Generation {
        let pub: P256.KeyAgreement.PublicKey
        let kid: String
        let key: URL, log: URL
        var seq: Int64 = 0

        init(_ dir: URL, dek: SecretBytes) throws {
            let kp = LockBox.newKeyPair()
            pub = kp.publicKey
            kid = LockBox.kid(pub)
            key = dir.appendingPathComponent(kid + ".key")
            log = dir.appendingPathComponent(kid + ".log")
            try LockBox.wrapKey(dek: dek, kid: kid, kp).write(to: key)
        }

        mutating func add(_ text: String) throws {
            seq += 1
            let line = LockBox.line(try LockBox.seal(pub, kid: kid, seq: seq, Data(text.utf8)))
            if let h = try? FileHandle(forWritingTo: log) {
                try h.seekToEnd()
                try h.write(contentsOf: line)
                try h.close()
            } else {
                try line.write(to: log)
            }
        }
    }

    private func texts(_ o: LockBox.Opened) -> [String] { o.items.map { String(decoding: $0, as: UTF8.self) } }

    func testSealedItemsOpenInOrderWithTheDataKey() throws {
        let dir = TempDir()
        let dek = SecretBytes(random: 32)
        var g = try Generation(dir.url, dek: dek)
        for i in 1...5 { try g.add("{\"t\":\"msg\",\"n\":\(i)}") }
        let onDisk = try Data(contentsOf: g.log) + Data(contentsOf: g.key)
        XCTAssertNil(onDisk.range(of: Data("\"t\":\"msg\"".utf8)), "nothing of it is readable in the files")
        let priv = try LockBox.unwrapKey(dek: dek, kid: g.kid, Data(contentsOf: g.key))
        let o = LockBox.openAll(priv, kid: g.kid, try LockBox.read(g.log))
        XCTAssertEqual(o.failed, 0)
        XCTAssertEqual(texts(o), (1...5).map { "{\"t\":\"msg\",\"n\":\($0)}" })
    }

    func testTheOrderIsTheSeqAndAnItemCountsOnce() throws {
        let dir = TempDir()
        let dek = SecretBytes(random: 32)
        let g = try Generation(dir.url, dek: dek)
        var recs = try (1...6).map { try LockBox.seal(g.pub, kid: g.kid, seq: Int64($0), Data("item \($0)".utf8)) }
        recs.reverse()
        recs.append(recs[3]) // a line written twice
        let priv = try LockBox.unwrapKey(dek: dek, kid: g.kid, Data(contentsOf: g.key))
        XCTAssertEqual(texts(LockBox.openAll(priv, kid: g.kid, recs)), (1...6).map { "item \($0)" })
    }

    func testAnotherDataKeyOpensNothing() throws {
        let dir = TempDir()
        let dek = SecretBytes(random: 32)
        var g = try Generation(dir.url, dek: dek)
        try g.add("secret")
        let wrapped = try Data(contentsOf: g.key)
        XCTAssertThrowsError(try LockBox.unwrapKey(dek: SecretBytes(random: 32), kid: g.kid, wrapped), "another data key")
        XCTAssertThrowsError(try LockBox.unwrapKey(dek: dek, kid: "another-kid", wrapped), "another generation's name")
        XCTAssertThrowsError(try LockBox.unwrapKey(dek: dek, kid: g.kid, Data(count: 10)), "not a key")
        let o = LockBox.openAll(LockBox.newKeyPair(), kid: g.kid, try LockBox.read(g.log))
        XCTAssertEqual(o.items.count, 0)
        XCTAssertEqual(o.failed, 1)
    }

    func testAnItemIsBoundToItsPlace() throws {
        let dir = TempDir()
        let dek = SecretBytes(random: 32)
        let g = try Generation(dir.url, dek: dek)
        let priv = try LockBox.unwrapKey(dek: dek, kid: g.kid, Data(contentsOf: g.key))
        let rec = try LockBox.seal(g.pub, kid: g.kid, seq: 3, Data("third".utf8))
        XCTAssertEqual(try LockBox.open(priv, kid: g.kid, rec), Data("third".utf8))
        var moved = rec
        moved["s"] = 1
        XCTAssertThrowsError(try LockBox.open(priv, kid: g.kid, moved), "seq")
        XCTAssertThrowsError(try LockBox.open(priv, kid: "other", rec), "kid")
        var flipped = rec
        var ct = Bytes.unb64(rec.jString("ct"))!
        ct[0] ^= 1
        flipped["ct"] = Bytes.b64(ct)
        XCTAssertThrowsError(try LockBox.open(priv, kid: g.kid, flipped), "changed")
        XCTAssertThrowsError(try LockBox.open(priv, kid: g.kid, ["s": 1]), "not an item")
    }

    func testACrashKeepsWhatWasWrittenAndAPartialLineIsSkipped() throws {
        let dir = TempDir()
        let dek = SecretBytes(random: 32)
        var g = try Generation(dir.url, dek: dek)
        try g.add("one")
        try g.add("two")
        let third = LockBox.line(try LockBox.seal(g.pub, kid: g.kid, seq: 3, Data("three".utf8)))
        let h = try FileHandle(forWritingTo: g.log)
        try h.seekToEnd()
        try h.write(contentsOf: third.prefix(third.count / 2))
        try h.close()
        let recs = try LockBox.read(g.log)
        XCTAssertEqual(recs.count, 2)
        let priv = try LockBox.unwrapKey(dek: dek, kid: g.kid, Data(contentsOf: g.key))
        XCTAssertEqual(texts(LockBox.openAll(priv, kid: g.kid, recs)), ["one", "two"])
        let h2 = try FileHandle(forWritingTo: g.log)
        try h2.seekToEnd()
        try h2.write(contentsOf: Data([0x0a]))
        try h2.close()
        g.seq = 3
        try g.add("four")
        XCTAssertEqual(texts(LockBox.openAll(priv, kid: g.kid, try LockBox.read(g.log))), ["one", "two", "four"])
    }

    func testNoLogIsNoItemsAndEveryItemHasItsOwnKey() throws {
        XCTAssertTrue(try LockBox.read(TempDir().url.appendingPathComponent("none.log")).isEmpty)
        let kp = LockBox.newKeyPair()
        let kid = LockBox.kid(kp.publicKey)
        let a = try LockBox.seal(kp.publicKey, kid: kid, seq: 1, Data("same".utf8))
        let b = try LockBox.seal(kp.publicKey, kid: kid, seq: 1, Data("same".utf8))
        XCTAssertNotEqual(a.jString("e"), b.jString("e"))
        XCTAssertNotEqual(a.jString("ct"), b.jString("ct"))
    }

    // MARK: Android's format, byte for byte

    /// A generation as Android's LockBox writes it (node:crypto, the algorithm of LockBox.java).
    private static let android = """
    {"dek":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=","kid":"YX45olIiRd8fakq3","spki":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEHZNUzBvgDvGYeJoCLynIYEXZz258CQdYSmOYuuDOSwGdaw0lwXwGJgGG6Wya7MY7JiA3uVUezMWoJVh4s7l0gQ==","wrapped":"/onmXsdjwjE901a2A2o512wPUE3uJdpGpz5C2UGRXt+/gcongVbUgafOC1rj479UR4WAJILzYcd1X1CdNqrgJ2D0BZHrbQssGz4toUtpa38MKKaWizy3S4/FmyBD/yyAfwLnF70gIGNN2Hywb7LIO9Qh/CuxcAc3j8AaLlzeqGWEn1vyAyzdNdV83/dYKgOLIHNtOkFRqESKl6kBMI44GC99CyGffw==","items":[{"s":1,"e":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEUeJ8AXYqB3y4ONNNG7dlYQLp+nr5eBtTVH0lkjaQT1f11KI7Lns5bPamgX6naQLa9y62pjF4dwHwBDDiU6y5tg==","iv":"vctoLlpHohOpcxMl","ct":"60kd087ileSUZlOXqGwXs69zfyJ6yuvDQV6uE3JF25VVn5byHT344FKMjJdj8yfZ9WmxrOEAQBBdwbxpOhx6pYKm5ZqbY9XjV5ACbE0yUgVJaw=="},{"s":2,"e":"MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEKkl8D2PAzT23rnFxQ6ta1lGvK1e+cNl1yLL8hgl4Negbeoy089rEbgNJ8IDtWBY1D3IwwmwT2rTYVFozGZdL9A==","iv":"ILw68Tw6czcX5r40","ct":"QfiT+p+LFWnYa9TzjCPYpC3zVqyKIuVsJbkf03u6gZfDqBbSEQAC/b8B9TAwgKeo"}],"texts":["{\\"t\\":\\"msg\\",\\"room\\":\\"r1\\",\\"m\\":{\\"id\\":\\"a\\",\\"kind\\":\\"text\\",\\"text\\":\\"ahoj\\"}}","{\\"t\\":\\"pin\\",\\"slot\\":\\"s\\",\\"kid\\":\\"k\\"}"]}
    """

    func testAnAndroidGenerationOpensHere() throws {
        let v = try XCTUnwrap(SecJSON.parse(Self.android))
        let dek = SecretBytes(try XCTUnwrap(Bytes.unb64(v.jString("dek"))))
        let kid = v.jString("kid")
        XCTAssertEqual(EcP256.kid(spki: v.jString("spki")), kid, "the kid is base64url(SHA-256(SPKI))[0..16]")
        let priv = try LockBox.unwrapKey(dek: dek, kid: kid, try XCTUnwrap(Bytes.unb64(v.jString("wrapped"))))
        XCTAssertEqual(EcP256.spki(priv.publicKey), v.jString("spki"), "node's PKCS#8 reads as the same key")
        let items = try XCTUnwrap(v["items"] as? [SecRecord])
        let o = LockBox.openAll(priv, kid: kid, items.reversed())
        XCTAssertEqual(o.failed, 0)
        XCTAssertEqual(texts(o), try XCTUnwrap(v["texts"] as? [String]))
        // …and what iOS seals to that generation, Android's algorithm opens the same way (it is the same code path).
        let mine = try LockBox.seal(priv.publicKey, kid: kid, seq: 3, Data("from iOS".utf8))
        XCTAssertEqual(Set(mine.keys), ["s", "e", "iv", "ct"])
        XCTAssertEqual(try LockBox.open(priv, kid: kid, mine), Data("from iOS".utf8))
        // iOS's wrapped key is PKCS#8 under the same AAD (a migration tool reads either).
        let rewrapped = try LockBox.wrapKey(dek: dek, kid: kid, priv)
        let pkcs8 = try SecCrypto.openWithIV(dek, rewrapped, aad: Data("m5/lockbox/1|key|\(kid)".utf8))
        XCTAssertEqual(pkcs8.prefix(2), Data([0x30, 0x81]), "a DER SEQUENCE (PKCS#8)")
    }
}
