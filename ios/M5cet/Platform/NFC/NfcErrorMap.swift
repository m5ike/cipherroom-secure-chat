// Core NFC's errors (NFCErrorDomain, NFCReaderError codes) as M5NFC's NfcError —
// the words the readers and a model's answer use (Android: TagLostException →
// card gone, IOException → io). Pure: it works on (domain, code), so the tests
// map plain NSErrors without a radio. The codes are NFCReaderError's raw values
// (NFCError.h); NfcErrorMapTests checks them against the SDK.

import Foundation
import M5NFC

enum NfcErrorMap {
    static let domain = "NFCError"

    // NFCReaderError raw values (NFCError.h).
    static let unsupportedFeature = 1, securityViolation = 2, invalidParameter = 3, invalidParameterLength = 4, parameterOutOfBound = 5
    static let radioDisabled = 6, ineligible = 7, accessNotAccepted = 8
    static let tagConnectionLost = 100, retryExceeded = 101, tagResponseError = 102, sessionInvalidated = 103, tagNotConnected = 104, packetTooLong = 105
    static let userCanceled = 200, sessionTimeout = 201, terminatedUnexpectedly = 202, systemIsBusy = 203, firstNDEFTagRead = 204
    static let invalidConfiguration = 300
    static let ndefTagNotWritable = 400, ndefTagUpdateFailure = 401, ndefTagSizeTooSmall = 402, ndefZeroLengthMessage = 403

    /// How a session ended (NFCTagReaderSessionDelegate didInvalidateWithError).
    enum SessionEnd: Sendable, Equatable {
        /// The person closed the sheet.
        case userCancelled
        /// iOS ended it (the 60 s limit).
        case timeout
        /// Another app or the system holds the reader.
        case busy
        /// No NFC here / the reader cannot run (iPad, no entitlement, radio off, ineligible).
        case unavailable(String)
        /// The app's own invalidate (success or an error text it showed).
        case byApp
        case other(String)
    }

    static func code(_ error: any Error) -> Int? {
        let ns = error as NSError
        return ns.domain == domain ? ns.code : nil
    }

    /// The reason a session ended, from its invalidation error.
    static func sessionEnd(_ error: any Error) -> SessionEnd {
        switch code(error) {
        case userCanceled: return .userCancelled
        case sessionTimeout: return .timeout
        case systemIsBusy: return .busy
        case unsupportedFeature: return .unavailable("This device has no NFC reader (iPad and Apple Watch have none).")
        case securityViolation: return .unavailable("Core NFC refused the session: the app's NFC entitlement or its Info.plist NFC keys are missing.")
        case radioDisabled: return .unavailable("NFC is turned off on this iPhone.")
        case ineligible, accessNotAccepted: return .unavailable("This iPhone is not eligible for this NFC reader.")
        case invalidConfiguration: return .unavailable("Core NFC refused the reader configuration.")
        // invalidateSession() by the app ends with "session invalidated" or user canceled on some versions.
        case sessionInvalidated: return .byApp
        default:
            let m = (error as NSError).localizedDescription
            return .other(m.isEmpty ? "The NFC session ended." : m)
        }
    }

    /// The NfcError for a session end (what a pending read gets).
    static func error(for end: SessionEnd) -> NfcError {
        switch end {
        case .userCancelled, .byApp: return NfcError(.cancelled, "Cancelled")
        case .timeout: return NfcError(.io, "The NFC session timed out (iOS ends a reading after 60 s).")
        case .busy: return NfcError(.io, "NFC is busy — another reading is running. Try again.")
        case .unavailable(let why): return NfcError(.unsupported, why)
        case .other(let m): return NfcError(.io, m)
        }
    }

    /// A tag command's error as M5NFC's NfcError. `end`: how the session ended, when it did.
    static func command(_ error: any Error, sessionEnd end: SessionEnd? = nil) -> NfcError {
        if let n = error as? NfcError { return n }
        switch code(error) {
        case tagConnectionLost, tagNotConnected: return .cardGone("the card left the field")
        case sessionInvalidated: return self.error(for: end ?? .byApp)
        case retryExceeded: return NfcError(.io, "the card stopped answering (retries exceeded)")
        case tagResponseError: return NfcError(.io, "the card's answer was not valid")
        case packetTooLong: return NfcError(.invalidArgument, "the command is longer than Core NFC sends to this card")
        case securityViolation: return NfcError(.unsupported, "Core NFC refused the command (an application not listed in Info.plist?)")
        case invalidParameter, invalidParameterLength, parameterOutOfBound, invalidConfiguration:
            return NfcError(.invalidArgument, "Core NFC refused the command's parameters")
        case unsupportedFeature: return NfcError(.unsupported, "This device has no NFC reader (iPad and Apple Watch have none).")
        case radioDisabled: return NfcError(.unsupported, "NFC is turned off on this iPhone.")
        case ndefTagNotWritable: return NfcError(.cardError, "read-only")
        case ndefTagSizeTooSmall: return NfcError(.cardError, "too-small")
        case ndefTagUpdateFailure: return NfcError(.io, "write-failed")
        case userCanceled: return NfcError(.cancelled, "Cancelled")
        case sessionTimeout: return self.error(for: .timeout)
        case systemIsBusy: return self.error(for: .busy)
        default:
            let m = (error as NSError).localizedDescription
            return NfcError(.io, m.isEmpty ? "NFC error" : m)
        }
    }
}
