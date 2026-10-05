// Errors and texts of M5NFC.

import Foundation
import Synchronization

/// Why an NFC operation did not complete. `code` is the contract's word
/// (client/src/lib/nfc/errors.ts NfcErrorCode, PaceException codes).
public struct NfcError: Error, Sendable, CustomStringConvertible, LocalizedError, Equatable {
    public enum Code: String, Sendable {
        /// The card answered something unusable, or the transport failed.
        case io
        /// The card left the field (a CoreNFC "tag connection lost").
        case cardGone = "card-gone"
        /// This device / transport / variant cannot do it (an iOS limit included).
        case unsupported
        case cancelled
        /// A malformed answer (secure messaging, TLV).
        case protocolError = "protocol"
        /// The card refused the password / key, or its token did not verify.
        case authFailed = "auth-failed"
        /// Another status word.
        case cardError = "card-error"
        case invalidArgument = "invalid-argument"
        /// G-18: a command that is not a read was stopped before the card.
        case notARead = "not-a-read"
    }

    public let code: Code
    public let message: String
    /// The status word as 4 hex digits, when a status word was the reason.
    public let sw: String?

    public init(_ code: Code, _ message: String, sw: String? = nil) {
        self.code = code; self.message = message; self.sw = sw
    }

    public var description: String { message }
    public var errorDescription: String? { message }

    public static func io(_ m: String) -> NfcError { NfcError(.io, m) }
    public static func cardGone(_ m: String = "the card left the field") -> NfcError { NfcError(.cardGone, m) }
    public static func unsupported(_ m: String) -> NfcError { NfcError(.unsupported, m) }
    public static func protocolError(_ m: String) -> NfcError { NfcError(.protocolError, m) }
}

/// The text of any error, as Java's `e.getMessage()` (falling back to the type's name).
func errorText(_ e: Error) -> String {
    if let n = e as? NfcError { return n.message }
    if let p = e as? NfcJSON.ParseError { return p.message }
    let d = (e as? LocalizedError)?.errorDescription ?? String(describing: e)
    return d.isEmpty ? String(describing: type(of: e)) : d
}

/// The app's strings for the few texts the readers write themselves
/// (Android `cz.m5cet.app.core.Texts`): the design's keys, English when the
/// app has none. The app installs its design strings once (`NfcTexts.install`).
public enum NfcTexts {
    /// Looks a key up in the app's language; nil (or the key itself) = not translated.
    public typealias Lookup = @Sendable (_ key: String) -> String?
    /// A counted text in the app's language with "{n}" filled; nil = not translated.
    public typealias PluralLookup = @Sendable (_ key: String, _ n: Int) -> String?

    private static let store = Mutex<(Lookup?, PluralLookup?)>((nil, nil))

    /// Installs the app's design strings (call once at start; again when the language changes).
    public static func install(_ lookup: Lookup?, plural: PluralLookup? = nil) { store.withLock { $0 = (lookup, plural) } }

    /// The text for `key`, else the English `en`.
    public static func t(_ key: String, _ en: String) -> String {
        let s = store.withLock { $0.0 }?(key)
        return s == nil || s == key || s!.isEmpty ? en : s!
    }

    /// With "{0}", "{1}" … filled.
    public static func f(_ key: String, _ en: String, _ args: String...) -> String {
        var s = t(key, en)
        for (i, a) in args.enumerated() { s = s.replacingOccurrences(of: "{\(i)}", with: a) }
        return s
    }

    /// A counted text: the app's plural form, else the English with "{n}" filled.
    public static func n(_ key: String, _ n: Int, _ en: String) -> String {
        let s = store.withLock { $0.1 }?(key, n)
        return s == nil || s == key || s!.isEmpty ? en.replacingOccurrences(of: "{n}", with: String(n)) : s!
    }
}
