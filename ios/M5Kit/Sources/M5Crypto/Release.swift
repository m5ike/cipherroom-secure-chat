// Release manifests (docs/protocol-v4.md § 15, F-02; release.ts; android
// p4/Release.java): release.json lists every file with its size and SHA-256;
// release.json.sig is the developer's Ed25519 signature over its exact bytes.

import M5Core

public enum Release {
    public static let format = "m5cet-release/1"

    /// A path relative to the release root with "/": no leading "/", no "\", no empty, "." or ".." segment.
    public static func isReleasePath(_ path: String?) -> Bool {
        guard let p = path, !p.isEmpty, !p.hasPrefix("/"), !p.contains("\\"), !p.unicodeScalars.contains("\u{0}") else { return false }
        for seg in p.split(separator: "/", omittingEmptySubsequences: false) where seg.isEmpty || seg == "." || seg == ".." { return false }
        return true
    }

    private static func isHex64(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// Parses and validates release.json; files sorted by path (ordinal), no duplicates.
    public static func parse(_ text: String) throws -> JSONObject {
        guard let m = JSON.parseObject(text) else { throw P4Error.malformed("release manifest is not JSON") }
        if m.string("format") != format { throw P4Error.malformed("not an m5cet-release/1 manifest") }
        for f in ["name", "version", "commit", "created"] where m.string(f) == nil { throw P4Error.malformed("manifest \(f) missing") }
        guard let files = m.array("files") else { throw P4Error.malformed("manifest files missing") }
        var previous: String?
        for file in files {
            guard let f = file.objectValue, isReleasePath(f.string("path")), Prim.isSafeCount(f["size"]), let sha = f.string("sha256"), isHex64(sha) else {
                throw P4Error.malformed("bad manifest file entry")
            }
            let path = f.optString("path")
            if let previous, Ordinal.compare(previous, path) >= 0 { throw P4Error.malformed("manifest files not sorted by path") }
            previous = path
        }
        return m
    }

    /// Ed25519 over the exact manifest bytes; signature and key are b64 (surrounding white space ignored). Never throws.
    public static func verifySignature(_ manifestBytes: Bytes, signature: String?, publicKey: String?) -> Bool {
        guard let signature, let publicKey else { return false }
        return Prim.ed25519Verify(publicKey.javaTrimmed, manifestBytes, signature.javaTrimmed)
    }

    public static func sha256Hex(_ bytes: Bytes) -> String { Prim.hex(Prim.H(bytes)) }
}
