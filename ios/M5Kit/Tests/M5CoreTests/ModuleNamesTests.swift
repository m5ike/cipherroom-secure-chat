// One owner per name: no two M5Kit modules may declare the same top-level public
// type — a file that imports both would get "ambiguous" errors (6.14: Bytes, Hex,
// TagV2, ShareInvite, ConnTag and HubProof were declared twice). Reads the
// sources (ios/M5Kit/Sources/<module>/**.swift) as ios/scripts/check-duplicate-types.sh
// does. And the byte helpers every module calls through `Bytes` / `Hex`
// (formerly M5NFC's and M5Net's own enums), with their semantics pinned.

import Foundation
import Testing
@testable import M5Core

@Suite struct ModuleNamesTests {
    /// `public` / `open` struct, enum, class, actor, protocol or typealias at the start of a line (top level),
    /// after any attributes and modifiers.
    static let declaration = try! NSRegularExpression(
        pattern: #"^(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:public|open)\s+(?:(?:final|indirect|nonisolated)\s+)*(?:struct|enum|class|actor|protocol|typealias)\s+([A-Za-z_][A-Za-z0-9_]*)"#,
        options: [.anchorsMatchLines])

    /// name → module → the files that declare it.
    static func publicTypes() throws -> [String: [String: [String]]] {
        let sources = Repo.root.appendingPathComponent("ios/M5Kit/Sources")
        var out = [String: [String: [String]]]()
        for module in try FileManager.default.contentsOfDirectory(atPath: sources.path).sorted() {
            let dir = sources.appendingPathComponent(module)
            guard let files = FileManager.default.enumerator(atPath: dir.path) else { continue }
            for case let file as String in files where file.hasSuffix(".swift") {
                let text = try String(contentsOf: dir.appendingPathComponent(file), encoding: .utf8)
                for m in declaration.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                    guard let r = Range(m.range(at: 1), in: text) else { continue }
                    out[String(text[r]), default: [:]][module, default: []].append(module + "/" + file)
                }
            }
        }
        return out
    }

    @Test func noTwoModulesDeclareTheSamePublicType() throws {
        let types = try Self.publicTypes()
        #expect(types.count > 100, "the scan found the modules' types")
        for (name, modules) in types.sorted(by: { $0.key < $1.key }) where modules.count > 1 {
            Issue.record("\(name) is declared in \(modules.keys.sorted().joined(separator: " and ")): \(modules.values.flatMap { $0 }.sorted().joined(separator: ", "))")
        }
        // The six of 6.14 have one owner each.
        for (name, owner) in [("Bytes", "M5Core"), ("Hex", "M5Core"), ("TagV2", "M5Crypto"), ("ShareInvite", "M5Crypto"), ("ConnTag", "M5Crypto"), ("HubProof", "M5Crypto"),
                              ("CallTrack", "M5Proto"), ("CallHistoryStore", "M5Proto")] {
            #expect(types[name].map { Array($0.keys) } == [owner], "\(name)")
        }
    }

    @Test func theScanSeesWhatTheCompilerWouldClashOn() {
        let text = "public enum A {}\n@MainActor public final class B {}\n  public struct Nested {}\npublic typealias C = Int\nenum Internal {}\npublic extension A {}\n"
        let names = Self.declaration.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } }
        #expect(names == ["A", "B", "C"])
    }
}

@Suite struct ByteHelpersTests {
    @Test func hexBothCasesStrictAndLenient() {
        #expect(Hex.encode([0x00, 0xA4, 0xFF]) == "00a4ff")
        #expect(Hex.upper([0x00, 0xA4, 0xFF]) == "00A4FF")
        #expect(Hex.upper(Data([0x0F])) == "0F")
        #expect(Hex.upper(ArraySlice<UInt8>([1, 2])) == "0102")
        #expect(Hex.decode("00a4FF") == [0x00, 0xA4, 0xFF])
        #expect(Hex.decode("0g") == nil && Hex.decode("abc") == nil && Hex.decode("") == [])
        // Apdu.unhex: "0x" anywhere and non-digits dropped, an odd last digit ignored.
        #expect(Hex.decodeLenient("0x00 A4:ff") == [0x00, 0xA4, 0xFF])
        #expect(Hex.decodeLenient("0X1 2 3") == [0x12])
        #expect(Hex.decodeLenient("zz") == [])
        #expect(Hex.isUpperHexBytes("00A4") && !Hex.isUpperHexBytes("00a4") && !Hex.isUpperHexBytes("0A4") && !Hex.isUpperHexBytes(""))
        #expect(Hex.nibble(UInt8(ascii: "f")) == 15 && Hex.nibble(UInt8(ascii: "F")) == 15 && Hex.nibble(UInt8(ascii: "g")) == nil)
    }

    @Test func apduHelpers() {
        #expect(Bytes.u8(0, 0xA4, 0x1FF, -1) == [0x00, 0xA4, 0xFF, 0xFF])
        #expect(Bytes.concat([1], [2, 3], []) == [1, 2, 3])
        #expect(Bytes.concat([[1], [2]]) == [1, 2])
        #expect(Bytes.slice([1, 2, 3, 4], 1, 3) == [2, 3])
        #expect(Bytes.slice([1, 2, 3], 2) == [3])
        #expect(Bytes.slice([1, 2, 3], -5, 99) == [1, 2, 3])
        #expect(Bytes.slice([1, 2, 3], 3) == [] && Bytes.slice([1, 2, 3], 2, 1) == [])
        #expect(Bytes.latin1("Aé") == [0x41, 0xE9])
        #expect(Bytes.latin1String([0x41, 0xE9]) == "Aé")
        #expect(Bytes.asciiString([0x41, 0xE9]) == "A\u{FFFD}")
        #expect(Bytes.utf8("é") == [0xC3, 0xA9])
        #expect(Bytes.constantTimeEqual([1, 2], [1, 2]) && !Bytes.constantTimeEqual([1, 2], [1, 3]) && !Bytes.constantTimeEqual([1], [1, 2]))
        #expect(Bytes.filled(3, 7) == [7, 7, 7] && Bytes.filled(-1, 7) == [])
    }

    /// The wire's `Data` forms (M5Net): base64 as the server's Buffer reads it — padding optional, spaces around
    /// it ignored, either alphabet with `unb64any`.
    @Test func wireData() {
        let d = Data([0xFB, 0xFF, 0x00])
        #expect(Bytes.b64(d) == "+/8A")
        #expect(Bytes.b64url(d) == "-_8A")
        #expect(Bytes.b64url(Data([0xFB])) == "-w")
        #expect(Bytes.unb64("+/8A") == d && Bytes.unb64(" +/8A ") == d)
        #expect(Bytes.unb64("-w") == nil && Bytes.unb64("a") == nil && Bytes.unb64("a===") == nil)
        #expect(Bytes.unb64("+w") == Data([0xFB]) && Bytes.unb64("+w=") == Data([0xFB]))
        #expect(Bytes.unb64url("-_8A") == d && Bytes.unb64url("-w==") == Data([0xFB]) && Bytes.unb64url("+w") == nil && Bytes.unb64url("a") == nil)
        #expect(Bytes.unb64any("-w") == Data([0xFB]) && Bytes.unb64any("+w") == Data([0xFB]))
        #expect(Bytes.hex(d) == "fbff00" && Bytes.unhex("FBff00") == d && Bytes.unhex("f") == nil)
        #expect(Bytes.same(d, Data([0xFB, 0xFF, 0x00])) && !Bytes.same(d, Data([0xFB])) && Bytes.same("a", "a") && !Bytes.same("a", "b"))
        let w = Data([9, 0, 0, 1, 2, 9])
        #expect(Bytes.be32(w, 1) == 0x0000_0102 && Bytes.be32(w.dropFirst(1), 0) == 0x0000_0102 && Bytes.be32(w, 3) == nil && Bytes.be32(w, -1) == nil)
    }
}
