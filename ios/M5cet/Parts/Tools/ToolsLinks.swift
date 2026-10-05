// A link tapped in a function's output, an AI answer or a form (Android
// DesignUrls.confirmOpen): the whole address is shown first — its host as the
// title — and opens only after the person confirms; an address that cannot be
// read in full (not https, longer than 300 characters, hidden characters) is
// refused with the design's words. Never a web view of the app's own.
//
// (The shell's own confirmation, DesignHost.confirmOpen, takes an M5Design
// URLConfirmation whose initializer is internal to M5Design — so the same
// dialog is shown here with the same texts until it is public.)

import M5Design
import UIKit

@MainActor
enum ToolsLinks {
    /// Opens the address after a confirmation (UIApplication.open), or says why not.
    static func confirmOpen(_ url: String, host: DesignHost) {
        let t = host.translator
        guard DesignUrls.openable(url), let target = URL(string: url) else {
            host.flash(title: "", text: t.t("security.urlRefused"), level: .warn)
            return
        }
        guard let top = ToolsSheets.top() else { return }
        let a = UIAlertController(title: DesignUrls.host(url) ?? url, message: url, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: t.t("nav.close"), style: .cancel))
        a.addAction(UIAlertAction(title: t.t("msg.open"), style: .default) { _ in UIApplication.shared.open(target) })
        top.present(a, animated: true)
    }
}
