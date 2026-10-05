// New versions of the app (Android: update/Releases). On iOS there is no APK:
// a release is a VERSION RECORD the operator publishes — its version, where
// to get it (an App Store or TestFlight link) and whether it is mandatory —
// and the server's minimum app version; an app below the minimum asks the
// person to update (docs/ios-architecture.md § 4). The record is signed by the
// pinned server key like Android's ("m5release/1|…"); the App Store installs.

import Foundation

public struct ReleaseRecord: Sendable, Equatable {
    public let id: String
    public let versionCode: Int64
    public let versionName: String
    public let channel: String
    public let mandatory: Bool
    public let notes: String
    /// Where to get it (App Store / TestFlight); "" when the record has none.
    public let url: String
    /// The lowest app version (code) the server still serves, 0 = none.
    public let minAppCode: Int64
    public let raw: NetJSON

    public init(_ j: NetJSON) {
        id = j.str("id")
        versionCode = j.int("versionCode")
        versionName = j.str("versionName")
        channel = j.str("channel")
        mandatory = j.bool("mandatory")
        notes = j.str("notes")
        url = j.str("url", j.str("storeUrl", j.str("testflightUrl")))
        minAppCode = j.int("minAppCode")
        raw = j
    }

    /// Android's signed string of a release (crypto.ts releaseSignedString), from the record's own fields.
    public var androidSignedString: String {
        ["m5release/1", id, String(versionCode), versionName, raw.str("packageName"), raw.str("apkSha256"), raw.str("certSha256"), String(raw.int("size"))]
            .joined(separator: "|")
    }
}

public enum ReleaseCheck: Sendable, Equatable {
    /// Nothing newer.
    case none
    /// A newer version; `isNew`: not the one announced before (tell the person once).
    case available(ReleaseRecord, isNew: Bool)
}

public struct ReleaseWatcher: Sendable {
    public private(set) var available: ReleaseRecord?
    public init() {}

    /// The check-in's release (Releases.onCheckin): newer than this app, or nothing.
    public mutating func onCheckin(_ release: ReleaseRecord?, appCode: Int) -> ReleaseCheck {
        guard let release, release.versionCode > appCode else {
            available = nil
            return .none
        }
        let isNew = available?.id != release.id
        available = release
        return .available(release, isNew: isNew)
    }

    /// Must this app be updated before it is used (below the server's minimum, or a mandatory newer release)?
    public static func mustUpdate(appCode: Int, serverMinAppCode: Int64, release: ReleaseRecord?) -> Bool {
        if serverMinAppCode > 0, Int64(appCode) < serverMinAppCode { return true }
        if let r = release, r.minAppCode > 0, Int64(appCode) < r.minAppCode { return true }
        if let r = release, r.mandatory, r.versionCode > appCode { return true }
        return false
    }

    /// GET /releases/:id checked: the server's signature over `signed`, and `signed` names THIS record
    /// (Android's exact string, or an "m5release/…" string carrying its id, version code and name).
    public static func verify(_ answer: NetJSON, serverKey: String) throws -> ReleaseRecord {
        guard let rel = answer.obj("release") else { throw NetError.badAnswer("no release in the answer") }
        let record = ReleaseRecord(rel)
        let signed = answer.str("signed")
        guard P256Keys.verify(spki: serverKey, text: signed, signature: answer.str("signature")) else {
            throw NetError.security("the release is not signed by the server")
        }
        if signed == record.androidSignedString { return record }
        let parts = signed.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard parts.first?.hasPrefix("m5release/") == true, parts.count >= 4, parts[1] == record.id, parts[2] == String(record.versionCode),
              parts[3] == record.versionName else {
            throw NetError.security("the release's signature is for another record")
        }
        return record
    }
}
