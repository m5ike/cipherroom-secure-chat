// What follows a passkey ceremony (android account/AccountDialogs.after): a
// notice, or a choice (an unknown passkey or none → create an account). iOS's
// "rp-unverified" is the server's apple-app-site-association not naming this
// app (Team ID + bundle id) — the operator needs those, not a certificate.

import Foundation
import M5Design

@MainActor
enum AccountDialogs {
    static func after(_ r: AccountResult, signUp: Bool, core: AppCore, host: DesignHost) async {
        let t = core.t
        host.refresh()
        if r.ok {
            if signUp && r.deviceBound {
                await CoreDialogs.notice(title: t("passkey.boundTitle"), message: t("passkey.boundText").replacingOccurrences(of: "{user}", with: r.username))
                return
            }
            host.flash(title: "", text: t("set.user.viaPasskey") + " · " + r.username, level: .success)
            return
        }
        let server = URL(string: core.device.server)?.host ?? core.device.server
        switch r.code {
        case "cancelled": host.flash(title: "", text: t("passkey.cancelled"), level: .info)
        case "rp-unverified":
            let appId = (Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String ?? "TEAMID.") + (Bundle.main.bundleIdentifier ?? "cz.m5cet.app")
            // The iOS design's words (what the server must publish), then the line itself and the system's reason.
            let why = t("passkey.rpText").replacingOccurrences(of: "{host}", with: server)
            await CoreDialogs.notice(title: t("passkey.rpTitle"),
                                     message: why + "\n\n{\"webcredentials\":{\"apps\":[\"\(appId)\"]}}" + (r.message.isEmpty ? "" : "\n\n" + r.message))
        case "unknown-passkey":
            let name = r.username.isEmpty ? "M5cet" : "M5cet · " + r.username
            await offerAccount(core, host, t("passkey.unknownTitle"),
                               t("passkey.unknownText").replacingOccurrences(of: "{server}", with: server) + "\n\n" + t("passkey.unknownHint").replacingOccurrences(of: "{name}", with: name))
        case "no-passkey": await offerAccount(core, host, t("passkey.noneTitle"), t("passkey.noneText").replacingOccurrences(of: "{server}", with: server))
        case "unsupported": await CoreDialogs.notice(title: t("passkey.problem"), message: t("passkey.unsupported"))
        case "no-prf", "wrong-key", "orphan", "no-root": await CoreDialogs.notice(title: t("passkey.problem"), message: r.message)
        case "rate-limited": await CoreDialogs.notice(title: t("passkey.rateLimitedTitle"), message: t("passkey.rateLimitedText").replacingOccurrences(of: "{server}", with: server))
        default: host.flash(title: "", text: r.message.isEmpty ? t("voice.failed") : r.message, level: .error)
        }
    }

    private static func offerAccount(_ core: AppCore, _ host: DesignHost, _ title: String, _ text: String) async {
        guard await CoreDialogs.confirm(title: title, message: text, yes: core.t("passkey.createAccount"), no: core.t("passkey.later")) else { return }
        let r = await core.account.signUp()
        await after(r, signUp: true, core: core, host: host)
    }
}
