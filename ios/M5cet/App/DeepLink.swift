// The app's own links (scheme m5cet, Info.plist CFBundleURLTypes) — the Android
// intent filters of MainActivity. The shell only routes them; validating an
// enrolment link is the port of A/account/EnrollLink (M5Net), filling the
// enrolment form is the Renderer's (Android: ui/parts/Forms.enrollLink).

import Foundation

enum DeepLink: Equatable, Sendable {
    /// m5cet://enroll?server=…&code=…&kid=… — the console's QR code.
    case enroll(URL)
    /// An m5cet:// link this version does not know (a newer console, a typo).
    case unsupported(URL)

    static let scheme = "m5cet"

    /// nil for a URL that is not the app's (another scheme).
    init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme else { return nil }
        switch url.host(percentEncoded: false)?.lowercased() {
        case "enroll": self = .enroll(url)
        default: self = .unsupported(url)
        }
    }

    var url: URL {
        switch self {
        case .enroll(let url), .unsupported(let url): url
        }
    }
}
