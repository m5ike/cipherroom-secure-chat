// New versions of the app (Android: update/Releases). On iOS there is no APK:
// a release is a VERSION RECORD the operator publishes (docs/ios-server.md § 5)
// — version, build, the App Store or TestFlight link, notes per language, the
// minimum build (older apps must update), a staged rollout — signed by the
// pinned server key over
//
//   "m5iosrelease/1|" + id + "|" + version + "|" + build + "|" + bundleId + "|" + channel + "|" + store + "|" + url + "|" + minBuild
//
// The App Store installs; the app only shows the record and opens its link.
// An app below the server's minimum asks for the update before anything else.

import Foundation

public struct ReleaseRecord: Sendable, Equatable {
    public let id: String
    /// "6.15.0".
    public let version: String
    /// The build (CFBundleVersion: major·10000 + minor·100 + patch). Android records: versionCode.
    public let build: Int64
    public let bundleId: String
    /// "stable", "beta", "dev".
    public let channel: String
    /// "appstore" or "testflight".
    public let store: String
    /// Where to get it (https://apps.apple.com…, testflight.apple.com…).
    public let url: String
    /// Notes per language ({cs, en, …}).
    public let notes: [String: String]
    /// Apps below this build must update; 0 = none.
    public let minBuild: Int64
    /// The share of devices (0–100 %) told about it.
    public let rollout: Int64
    /// The server says this device must update.
    public let mandatory: Bool
    public let raw: NetJSON

    public init(_ j: NetJSON) {
        id = j.str("id")
        version = j.str("version", j.str("versionName"))
        build = j["build"]?.int64Value ?? j.int("versionCode")
        bundleId = j.str("bundleId", j.str("packageName"))
        channel = j.str("channel")
        store = j.str("store")
        url = j.str("url")
        var n: [String: String] = [:]
        if let o = j.obj("notes")?.objectValue { for (k, v) in o { if let s = v.stringValue { n[k] = s } } } else if let s = j["notes"]?.stringValue, !s.isEmpty { n["en"] = s }
        notes = n
        minBuild = j.int("minBuild")
        rollout = j.int("rollout", 100)
        mandatory = j.bool("mandatory")
        raw = j
    }

    /// The notes in `lang`, else English, else any.
    public func notes(_ lang: String) -> String { notes[lang] ?? notes["en"] ?? notes.values.first ?? "" }

    /// The string the server signs (server/ios/releases.ts iosReleaseSignedString).
    public var signedString: String {
        ["m5iosrelease/1", id, version, String(build), bundleId, channel, store, url, String(minBuild)].joined(separator: "|")
    }

    /// Android's signed string of the same record (crypto.ts releaseSignedString), for an Android record.
    public var androidSignedString: String {
        ["m5release/1", id, String(build), version, raw.str("packageName"), raw.str("apkSha256"), raw.str("certSha256"), String(raw.int("size"))]
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
        guard let release, release.build > appCode else {
            available = nil
            return .none
        }
        let isNew = available?.id != release.id
        available = release
        return .available(release, isNew: isNew)
    }

    /// Must this app be updated before it is used? Below the server's minimum build (`updateRequired` of the
    /// check-in, /info's minBuild), or a release the server marks mandatory for it.
    public static func mustUpdate(appCode: Int, serverMinBuild: Int64, release: ReleaseRecord?) -> Bool {
        if serverMinBuild > 0, Int64(appCode) < serverMinBuild { return true }
        if let r = release, r.minBuild > 0, Int64(appCode) < r.minBuild { return true }
        if let r = release, r.mandatory, r.build > appCode { return true }
        return false
    }

    /// GET /releases/:id checked: `signed` is THIS record's signed string (iOS, or Android's for an Android record)
    /// and the pinned server key signed it.
    public static func verify(_ answer: NetJSON, serverKey: String) throws -> ReleaseRecord {
        guard let rel = answer.obj("release") else { throw NetError.badAnswer("no release in the answer") }
        let record = ReleaseRecord(rel)
        let signed = answer.str("signed")
        guard signed == record.signedString || (rel["apkSha256"] != nil && signed == record.androidSignedString) else {
            throw NetError.security("the release's signature is for another record")
        }
        guard P256Keys.verify(spki: serverKey, text: signed, signature: answer.str("signature")) else {
            throw NetError.security("the release is not signed by the server")
        }
        return record
    }
}
