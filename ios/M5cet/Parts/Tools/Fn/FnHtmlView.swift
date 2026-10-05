// A function's formatted HTML (6.6, m5.out.html; FnHtml.tsx on the web) — a
// port of android/…/fn/FnHtmlView.java in a locked-down WKWebView: no
// JavaScript (allowsContentJavaScript off, nothing injected), no network (a
// WKContentRuleList blocks every load but the page's own data: pictures, and
// the page's Content-Security-Policy allows nothing else either), a
// non-persistent data store (no cookies, storage or cache), no windows, no
// navigation in place: a tapped http(s) / mailto link goes to the app, which
// asks before it opens anything (DesignUrls). The HTML is sanitized again here
// (M5Proto FnHtml — a room message may come from any client) and shown in a
// page whose style maps the report classes (m5h-*) and plain markup to the
// app's theme on a transparent background, so a report looks right in light
// and dark. As tall as the document, never scrolling inside the bubble (a
// wide table scrolls sideways in its m5h-scroll box).
//
// Deviation from Android: a long press on a picture does not open it (the
// WebView's hit test is JavaScript-free on Android; WKWebView has none) — the
// long press is switched off instead (no callout, no text selection).

import M5Design
import M5Proto
import SwiftUI
import WebKit

/// The page around the safe markup — pure (FnHtmlView.page / style / css).
enum FnHtmlPage {
    /// The theme's colours the page uses.
    struct Palette: Sendable, Equatable {
        let ink, muted, panel, border, link, ok, err, warn: DesignColor

        @MainActor
        init(_ look: ToolsLook) {
            ink = look.design("@onSurface"); muted = look.design("@muted"); panel = look.design("@surfaceVariant"); border = look.design("@border")
            link = look.design("@primary"); ok = look.design("@success"); err = look.design("@danger"); warn = look.design("@warning")
        }

        init(ink: DesignColor, muted: DesignColor, panel: DesignColor, border: DesignColor, link: DesignColor, ok: DesignColor, err: DesignColor, warn: DesignColor) {
            self.ink = ink; self.muted = muted; self.panel = panel; self.border = border; self.link = link; self.ok = ok; self.err = err; self.warn = warn
        }
    }

    /// A colour as CSS: rgba(r,g,b,a), with its alpha times a.
    static func css(_ c: DesignColor, _ a: Double = 1) -> String {
        String(format: "rgba(%d,%d,%d,%.3f)", locale: Locale(identifier: "en_US_POSIX"), c.red8, c.green8, c.blue8, c.alpha * a)
    }

    /// The page's style: fn.css (.fn-html__body and the m5h-* classes) in the theme's colours; sizes in CSS px (pt).
    static func style(_ p: Palette) -> String {
        let ink = css(p.ink), muted = css(p.muted), panel = css(p.panel), border = css(p.border), link = css(p.link)
        return "html,body{margin:0;padding:0;background:transparent}"
            + "body{color:" + ink + ";font:14px/1.45 -apple-system,sans-serif;overflow-wrap:anywhere;-webkit-text-size-adjust:none;-webkit-tap-highlight-color:transparent;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}"
            + ".fn-html__body{display:flow-root}"
            + "h1,h2,h3,h4,h5,h6{margin:9.6px 0 4.8px;line-height:1.25}"
            + "h1{font-size:20px}h2{font-size:17.9px}h3,h4{font-size:15.7px}h5,h6{font-size:14.4px}"
            + "p{margin:4.8px 0}ul,ol{margin:4.8px 0;padding-left:20.8px}"
            + "table{border-collapse:collapse;font-size:13.4px}th,td{padding:3.2px 8px;vertical-align:top;text-align:left}"
            + "pre,code,kbd,samp{font-family:ui-monospace,monospace;font-size:12.8px}"
            + "pre{white-space:pre-wrap;word-break:break-all;margin:4.8px 0;padding:8px 9.6px;border-radius:8px;background:" + panel + ";max-height:352px;overflow:auto}"
            + "a{color:" + link + ";text-decoration:underline}img{max-width:100%;height:auto}"
            + "details>summary{font-weight:600;margin:5.6px 0}"
            + "hr{border:0;border-top:1px solid " + border + "}"
            + "blockquote{margin:4.8px 0;padding-left:10px;border-left:3px solid " + border + ";color:" + muted + "}"
            + "mark{background:" + css(p.warn, 0.3) + ";color:inherit}"
            + ".m5h-head{margin-bottom:6.4px}.m5h-title{font-size:16.8px;font-weight:700}"
            + ".m5h-sub,.m5h-muted{color:" + muted + "}"
            + ".m5h-sec{margin:8.8px 0}.m5h-sec>h4,.m5h-sec>summary{font-size:14.7px;font-weight:650;margin:0 0 4.8px}"
            + ".m5h-kv,.m5h-grid{width:100%;border-collapse:collapse}"
            + ".m5h-kv th{color:" + muted + ";font-weight:500;width:36%;padding:2.4px 9.6px 2.4px 0}.m5h-kv td{padding:2.4px 0}"
            + ".m5h-kv--mono td,.m5h-mono,.m5h-pre{font-family:ui-monospace,monospace;font-size:12.5px}"
            + ".m5h-grid th{border-bottom:1px solid " + border + ";font-weight:600;white-space:nowrap}"
            + ".m5h-grid tbody tr:nth-child(even) td{background:" + css(p.panel, 0.6) + "}"
            + ".m5h-scroll{overflow-x:auto;max-width:100%}"
            // A bubble is narrow: a table in a scroll box keeps its lines whole and scrolls sideways instead.
            + ".m5h-scroll>table{width:auto;min-width:100%}.m5h-scroll th,.m5h-scroll td{overflow-wrap:normal;white-space:nowrap}"
            + ".m5h-id{display:flex;gap:12.8px;align-items:flex-start;flex-wrap:wrap}.m5h-id>.m5h-kv{flex:1 1 224px;width:auto}"
            + ".m5h-photos{display:flex;gap:11.2px;flex-wrap:wrap}.m5h-photo{margin:0;max-width:176px}"
            + ".m5h-photo img{display:block;max-width:176px;max-height:224px;border-radius:8px;border:1px solid " + border + ";background:#fff}"
            + ".m5h-photo figcaption{font-size:12px;color:" + muted + ";margin-top:3.2px}"
            + ".m5h-ph{width:120px;height:144px;display:flex;align-items:center;justify-content:center;border:1px dashed " + border + ";border-radius:8px;color:" + muted + ";font-size:12.8px}"
            + ".m5h-badge{display:inline-block;padding:0 6.4px;border-radius:9.6px;font-size:12px;vertical-align:middle}"
            + ".m5h-badge--ok{background:" + css(p.ok, 0.18) + ";color:" + css(p.ok) + "}"
            + ".m5h-badge--err{background:" + css(p.err, 0.18) + ";color:" + css(p.err) + "}"
            + ".m5h-badge--warn{background:" + css(p.warn, 0.2) + ";color:" + css(p.warn) + "}"
            + ".m5h-files{margin:0;padding-left:17.6px}"
    }

    /// The Content-Security-Policy of the page: only data: pictures and its own style.
    static let csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

    /// The document the web view loads: safe markup (FnHtml.serialize) under the CSP.
    static func page(_ safeHtml: String, _ style: String) -> String {
        "<!doctype html><html><head><meta charset=\"utf-8\">"
            + "<meta http-equiv=\"Content-Security-Policy\" content=\"" + csp + "\">"
            + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            + "<style>" + style + "</style></head><body><div class=\"fn-html__body\">" + safeHtml + "</div></body></html>"
    }

    /// What may leave the page when someone taps it: http(s) and mailto (the app asks before it opens it).
    static func linkTarget(_ url: URL?) -> String? {
        guard let url, let scheme = url.scheme?.lowercased(), ["https", "http", "mailto"].contains(scheme) else { return nil }
        return url.absoluteString
    }

    /// The rule list: every load is blocked, but data: (the page's pictures) and about: (the page itself).
    static let blockRules = """
    [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^data:"},"action":{"type":"ignore-previous-rules"}},
     {"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}}]
    """

    static let ruleListId = "cz.m5cet.fnhtml.block-remote.v1"
}

/// The compiled rule list (once per launch; the store keeps it compiled).
@MainActor
enum FnHtmlRules {
    private static var compiled: WKContentRuleList?
    private static var waiting: [(WKContentRuleList?) -> Void] = []
    private static var compiling = false

    static func get(_ done: @escaping (WKContentRuleList?) -> Void) {
        if let compiled { done(compiled); return }
        waiting.append(done)
        if compiling { return }
        compiling = true
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: FnHtmlPage.ruleListId, encodedContentRuleList: FnHtmlPage.blockRules) { list, _ in
            MainActor.assumeIsolated {
                compiled = list
                compiling = false
                let w = waiting
                waiting = []
                for f in w { f(list) }
            }
        }
    }
}

/// The configuration of every page: no scripts, no storage, no media autoplay, no data detectors, no windows.
@MainActor
enum FnHtmlWeb {
    static func configuration(rules: WKContentRuleList) -> WKWebViewConfiguration {
        let c = WKWebViewConfiguration()
        c.websiteDataStore = .nonPersistent()
        c.defaultWebpagePreferences.allowsContentJavaScript = false
        c.preferences.javaScriptCanOpenWindowsAutomatically = false
        c.preferences.isFraudulentWebsiteWarningEnabled = false
        c.preferences.isTextInteractionEnabled = false
        c.allowsInlineMediaPlayback = false
        c.allowsAirPlayForMediaPlayback = false
        c.allowsPictureInPictureMediaPlayback = false
        c.mediaTypesRequiringUserActionForPlayback = .all
        c.dataDetectorTypes = []
        c.upgradeKnownHostsToHTTPS = false
        c.userContentController.add(rules)
        return c
    }

    static func make(rules: WKContentRuleList, delegate: any WKNavigationDelegate & WKUIDelegate) -> WKWebView {
        let w = WKWebView(frame: CGRect(x: 0, y: 0, width: 300, height: 48), configuration: configuration(rules: rules))
        w.isOpaque = false
        w.backgroundColor = .clear
        w.scrollView.backgroundColor = .clear
        w.scrollView.isScrollEnabled = false
        w.scrollView.bounces = false
        w.scrollView.showsVerticalScrollIndicator = false
        w.scrollView.contentInsetAdjustmentBehavior = .never
        w.allowsLinkPreview = false
        w.allowsBackForwardNavigationGestures = false
        w.isInspectable = false
        w.navigationDelegate = delegate
        w.uiDelegate = delegate
        return w
    }
}

/// The HTML output in a bubble.
struct FnHtmlView: View {
    let html: String
    let look: ToolsLook
    /// A link someone tapped (http(s) / mailto) — the app asks before opening it.
    var openLink: (String) -> Void
    /// The page could not be made or shown (reported once).
    var failed: (String) -> Void

    @State private var prepared: (page: String, text: String)?
    @State private var fallback = false
    @State private var height: CGFloat = 48
    @ScaledMetric(relativeTo: .body) private var unit: CGFloat = 1

    var body: some View {
        Group {
            if fallback {
                Text(verbatim: prepared?.text ?? "")
                    .toolsFont(14)
                    .foregroundStyle(look.color("@onSurface"))
                    .fixedSize(horizontal: false, vertical: true)
            } else if let prepared {
                FnHtmlWebView(page: prepared.page, zoom: min(unit, 2), height: $height, openLink: openLink, gone: { crashed in
                    if crashed { failed("the HTML could not be shown (the page crashed)") }
                    fallback = true
                })
                .frame(height: height)
            } else {
                Color.clear.frame(height: 40)
            }
        }
        .task(id: html) {
            // Up to 2 MB of markup: parsed off the main actor.
            let style = FnHtmlPage.style(FnHtmlPage.Palette(look))
            let source = html
            let made = await Task.detached(priority: .userInitiated) { () -> (String, String) in
                let tree = FnHtml.parse(source)
                return (FnHtmlPage.page(FnHtml.serialize(tree), style), FnHtml.text(tree))
            }.value
            prepared = (made.0, made.1)
        }
    }
}

/// The WKWebView, made when the row is on screen and let go when it leaves.
struct FnHtmlWebView: UIViewRepresentable {
    let page: String
    let zoom: CGFloat
    @Binding var height: CGFloat
    let openLink: (String) -> Void
    /// The content process died for good (true: it crashed) — the text instead.
    let gone: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UIView {
        let box = UIView()
        box.backgroundColor = .clear
        context.coordinator.box = box
        FnHtmlRules.get { [weak coordinator = context.coordinator] rules in
            guard let coordinator else { return }
            guard let rules else { coordinator.parent.gone(false); return }
            coordinator.attach(rules: rules)
        }
        return box
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.web?.pageZoom = zoom
    }

    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) { coordinator.release() }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: FnHtmlWebView
        weak var box: UIView?
        private(set) var web: WKWebView?
        private var observation: NSKeyValueObservation?
        private var restarts = 0
        private var rules: WKContentRuleList?

        init(_ parent: FnHtmlWebView) { self.parent = parent }

        func attach(rules: WKContentRuleList) {
            guard let box, web == nil else { return }
            self.rules = rules
            let w = FnHtmlWeb.make(rules: rules, delegate: self)
            w.pageZoom = parent.zoom
            w.frame = box.bounds
            w.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            box.addSubview(w)
            web = w
            observation = w.scrollView.observe(\.contentSize, options: [.new]) { [weak self] sv, _ in
                let h = ceil(sv.contentSize.height)
                MainActor.assumeIsolated {
                    guard let self, h > 0, abs(h - self.parent.height) > 0.5 else { return }
                    self.parent.height = h
                }
            }
            w.loadHTMLString(parent.page, baseURL: nil)
        }

        func release() {
            observation?.invalidate()
            observation = nil
            web?.stopLoading()
            web?.navigationDelegate = nil
            web?.uiDelegate = nil
            web?.removeFromSuperview()
            web = nil
        }

        /// Nothing navigates in place: the page itself loads, a tapped http(s) / mailto link goes to the app.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            let url = action.request.url
            if action.navigationType == .other, url == nil || url?.scheme == "about" { return .allow }
            if action.navigationType == .linkActivated, let target = FnHtmlPage.linkTarget(url) { parent.openLink(target) }
            return .cancel
        }

        /// No windows of its own.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if action.navigationType == .linkActivated, let target = FnHtmlPage.linkTarget(action.request.url) { parent.openLink(target) }
            return nil
        }

        /// No long-press menu (no link preview, no copy of a picture to elsewhere).
        func webView(_ webView: WKWebView, contextMenuConfigurationFor elementInfo: WKContextMenuElementInfo) async -> UIContextMenuConfiguration? {
            nil
        }

        /// The content process was stopped (memory) or crashed: once or twice again, then the text.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard webView == web else { return }
            release()
            restarts += 1
            if restarts > 2 { parent.gone(true); return }
            if let rules { attach(rules: rules) }
        }
    }
}
