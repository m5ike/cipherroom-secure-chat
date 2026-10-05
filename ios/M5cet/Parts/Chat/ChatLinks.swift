// A link from a message (or "open map") is never opened straight away: the person
// sees the whole address first — the same confirmation as the renderer's url.open
// (title: the host, the address in full, "Open" / "Close" from the design). An
// address with invisible characters (bidi overrides, zero-width) is refused, as
// DesignUrls refuses it (6.10 G-20). Only http(s), mailto and tel get here.
// (The renderer's own alert takes a URLConfirmation, whose initializer M5Design
// keeps internal — so the same alert is shown here.)

import M5Design
import UIKit

@MainActor
enum ChatLinks {
    static func confirm(_ url: URL, host: DesignHost) {
        let s = url.absoluteString
        let scheme = (url.scheme ?? "").lowercased()
        guard ["https", "http", "mailto", "tel"].contains(scheme), visible(s) else {
            host.flash(title: "", text: host.translator.t("security.urlRefused"), level: .warn)
            return
        }
        let t = host.translator
        let title: String = {
            if let h = DesignUrls.host(s), !h.isEmpty { return h }
            return shown(url)
        }()
        let alert = UIAlertController(title: title, message: scheme == "http" || scheme == "https" ? s : shown(url), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: t.t("nav.close"), style: .cancel))
        alert.addAction(UIAlertAction(title: t.t("msg.open"), style: .default) { _ in UIApplication.shared.open(url) })
        ChatFileActions.present(alert)
    }

    /// mailto: / tel: without the scheme.
    static func shown(_ url: URL) -> String {
        let s = url.absoluteString
        for p in ["mailto:", "tel:"] where s.lowercased().hasPrefix(p) { return String(s.dropFirst(p.count)).removingPercentEncoding ?? s }
        return s
    }

    /// No spaces, controls or invisible formatting anywhere in it.
    static func visible(_ s: String) -> Bool {
        !s.unicodeScalars.contains { u in
            switch u.properties.generalCategory {
            case .spaceSeparator, .lineSeparator, .paragraphSeparator, .control, .format: return true
            default: return u.value <= 0x20
            }
        }
    }
}
