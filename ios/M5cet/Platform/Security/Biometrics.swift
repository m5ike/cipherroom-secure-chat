// The platform's biometric prompt (Android security/Biometric) — LocalAuthentication.
// A success hands back the LAContext that evaluated it; the Secure Enclave then uses
// the biometric key ("bio", biometryCurrentSet) with that context for exactly the
// unwrap of the data key — the key is released by the hardware, not merely "allowed".
//
// Android's KeyPermanentlyInvalidatedException (a new fingerprint) is the changed
// domain state here: the biometric enrolment's hash is kept at enrolment; another one
// at the unlock means the key no longer opens — biometrics are switched off
// ("key-invalidated") before any prompt. The Secure Enclave refuses such a key anyway.

import Foundation
import LocalAuthentication

enum BiometricOutcome {
    /// Authenticated: the context to use the biometric key with.
    case success(LAContext)
    /// The user chose the PIN ("Use PIN"), cancelled, or the system did.
    case cancelled
    /// The system's own lock-out after too many rejected tries (the PIN unlocks it).
    case lockout
    /// Not possible now (no biometrics, not enrolled).
    case unavailable
}

/// The biometric prompt — the system's in the app, a scripted one in the tests.
@MainActor
protocol BiometricAuthenticator: AnyObject {
    /// Biometrics can be used now (enrolled, allowed).
    var available: Bool { get }
    /// "faceID", "touchID", "opticID" or "" — the lock screen's icon.
    var kind: String { get }
    /// The current biometric enrolment's hash (nil: none / unknown).
    var enrolmentHash: Data? { get }
    func authenticate(reason: String, fallbackTitle: String) async -> BiometricOutcome
}

@MainActor
final class SystemBiometrics: BiometricAuthenticator {
    var available: Bool {
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    }

    var kind: String {
        let c = LAContext()
        var error: NSError?
        _ = c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        return switch c.biometryType {
        case .faceID: "faceID"
        case .touchID: "touchID"
        case .opticID: "opticID"
        default: ""
        }
    }

    var enrolmentHash: Data? {
        let c = LAContext()
        var error: NSError?
        _ = c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        return c.domainState.biometry.stateHash
    }

    func authenticate(reason: String, fallbackTitle: String) async -> BiometricOutcome {
        let c = LAContext()
        c.localizedFallbackTitle = fallbackTitle
        c.localizedCancelTitle = fallbackTitle
        c.touchIDAuthenticationAllowableReuseDuration = 0
        let result: Result<Bool, any Error> = await withCheckedContinuation { done in
            c.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, error in
                done.resume(returning: error.map { .failure($0) } ?? .success(ok))
            }
        }
        switch result {
        case .success(let ok):
            return ok ? .success(c) : .cancelled
        case .failure(let e as LAError):
            switch e.code {
            case .biometryLockout: return .lockout
            case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet: return .unavailable
            default: return .cancelled
            }
        case .failure:
            return .cancelled
        }
    }
}
