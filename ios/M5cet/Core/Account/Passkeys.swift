// Passkeys on iOS (android account/Passkeys.java over Credential Manager):
// AuthenticationServices' platform provider — creating a passkey and getting an
// assertion for the server's relying party, both with the PRF extension
// (iOS 18+: the account root, the vault slot keys). The relying party must be
// in the app's associated domains (webcredentials:$(M5_WEBCREDENTIALS_DOMAIN)
// in M5cet.entitlements, ios/README.md) or iOS refuses the request.
//
// The ceremonies are behind `PasskeyAuthorizing` so the account flows run in
// tests with a fake authenticator (the unsigned simulator cannot use passkeys).

import AuthenticationServices
import Foundation
import M5Net
import UIKit

/// Why a ceremony did not end with a credential (Android Passkeys.Result codes).
struct PasskeyFailure: Error, Equatable {
    /// cancelled | no-passkey | unsupported | rp-unverified | failed
    let code: String
    let message: String
}

/// Creating passkeys and asserting them.
@MainActor
protocol PasskeyAuthorizing: AnyObject {
    func create(_ options: PasskeyCreationOptions) async throws -> PasskeyRegistration
    func assert(_ options: PasskeyRequestOptions) async throws -> PasskeyAssertion
}

/// The system's passkeys (ASAuthorizationPlatformPublicKeyCredentialProvider) with PRF.
@MainActor
final class SystemPasskeys: NSObject, PasskeyAuthorizing, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var pending: CheckedContinuation<ASAuthorization, any Error>?
    private var controller: ASAuthorizationController?

    func create(_ o: PasskeyCreationOptions) async throws -> PasskeyRegistration {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: o.rpId)
        let r = provider.createCredentialRegistrationRequest(challenge: o.challenge, name: o.userName, userID: o.userId)
        r.displayName = o.displayName
        r.userVerificationPreference = Self.uv(o.userVerification)
        r.excludedCredentials = o.excludeCredentials.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        r.prf = .inputValues(ASAuthorizationPublicKeyCredentialPRFRegistrationInput.InputValues(saltInput1: o.prfSalt))
        let auth = try await perform(r)
        guard let c = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration, let att = c.rawAttestationObject else {
            throw PasskeyFailure(code: "failed", message: "no registration")
        }
        return PasskeyRegistration(credentialId: c.credentialID, clientDataJSON: c.rawClientDataJSON, attestationObject: att, transports: ["internal", "hybrid"],
                                   prfFirst: c.prf?.first.map { $0.withUnsafeBytes { Data($0) } })
    }

    func assert(_ o: PasskeyRequestOptions) async throws -> PasskeyAssertion {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: o.rpId)
        let r = provider.createCredentialAssertionRequest(challenge: o.challenge)
        r.userVerificationPreference = Self.uv(o.userVerification)
        r.allowedCredentials = o.allowCredentials.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        if o.wantsPrf {
            r.prf = .inputValues(ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: Passkey.prfSalt))
        }
        let auth = try await perform(r)
        guard let c = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw PasskeyFailure(code: "failed", message: "no assertion")
        }
        return PasskeyAssertion(credentialId: c.credentialID, clientDataJSON: c.rawClientDataJSON, authenticatorData: c.rawAuthenticatorData,
                                signature: c.signature, userHandle: c.userID, prfFirst: c.prf.map { $0.first.withUnsafeBytes { Data($0) } })
    }

    private static func uv(_ s: String) -> ASAuthorizationPublicKeyCredentialUserVerificationPreference {
        switch s {
        case "discouraged": .discouraged
        case "preferred": .preferred
        default: .required
        }
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        if pending != nil { throw PasskeyFailure(code: "failed", message: "a passkey request is already open") }
        return try await withCheckedThrowingContinuation { c in
            pending = c
            let ctrl = ASAuthorizationController(authorizationRequests: [request])
            ctrl.delegate = self
            ctrl.presentationContextProvider = self
            controller = ctrl
            ctrl.performRequests()
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        nonisolated(unsafe) let a = authorization
        MainActor.assumeIsolated { finish(.success(a)) }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: any Error) {
        let failure = Self.failure(error)
        MainActor.assumeIsolated { finish(.failure(failure)) }
    }

    private func finish(_ r: Result<ASAuthorization, any Error>) {
        let c = pending
        pending = nil
        controller = nil
        c?.resume(with: r)
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
            return scene?.keyWindow ?? scene?.windows.first ?? ASPresentationAnchor()
        }
    }

    /// AuthenticationServices' errors as Android's codes.
    nonisolated static func failure(_ error: any Error) -> PasskeyFailure {
        let e = error as NSError
        if e.domain == ASAuthorizationError.errorDomain, let code = ASAuthorizationError.Code(rawValue: e.code) {
            switch code {
            case .canceled: return PasskeyFailure(code: "cancelled", message: e.localizedDescription)
            case .notHandled, .unknown: return PasskeyFailure(code: "no-passkey", message: e.localizedDescription)
            case .invalidResponse, .notInteractive, .failed: return PasskeyFailure(code: "failed", message: e.localizedDescription)
            case .matchedExcludedCredential: return PasskeyFailure(code: "failed", message: e.localizedDescription)
            default: break
            }
        }
        // The relying party is not one of the app's associated domains (webcredentials), or the domain does not name the app.
        if e.domain == "com.apple.AuthenticationServices.AuthorizationError" || e.localizedDescription.localizedCaseInsensitiveContains("associated domain") {
            return PasskeyFailure(code: "rp-unverified", message: e.localizedDescription)
        }
        return PasskeyFailure(code: "failed", message: e.localizedDescription)
    }
}
