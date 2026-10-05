// A function's HTML (m5.out.html) in the locked-down web view: the markup is
// sanitized again (a room message may come from any client), the page allows
// nothing but data: pictures and its own style (CSP), no script runs, the rule
// list blocks every load that is not the page's own, and nothing navigates in
// place — a tapped link goes to the app (which asks first).
//
// The probe: a custom URL scheme handler counts what the page tries to load.
// A control web view without the rule list proves the probe sees loads; the
// app's configuration must let none through.

import M5Design
import M5Proto
import UIKit
import WebKit
import XCTest
@testable import M5cet

/// Counts the requests a page makes for m5probe:// addresses.
final class ToolsProbeSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    private let lock = NSLock()
    private var urls: [String] = []
    var requested: [String] { lock.lock(); defer { lock.unlock() }; return urls }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        lock.lock(); urls.append(task.request.url?.absoluteString ?? ""); lock.unlock()
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")!
        task.didReceive(URLResponse(url: task.request.url!, mimeType: "image/png", expectedContentLength: png.count, textEncodingName: nil))
        task.didReceive(png)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}

/// Waits for a page to finish.
@MainActor
final class ToolsLoadWaiter: NSObject, WKNavigationDelegate {
    var finished = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { finished = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { finished = true }
}

/// A navigation as WebKit would describe a tap on a link.
final class ToolsFakeNavigationAction: WKNavigationAction {
    private let req: URLRequest
    private let type: WKNavigationType
    init(_ url: String, _ type: WKNavigationType) {
        req = URLRequest(url: URL(string: url)!)
        self.type = type
        super.init()
    }
    override var request: URLRequest { req }
    override var navigationType: WKNavigationType { type }
}

@MainActor
final class FnHtmlSecurityTests: XCTestCase {
    /// What a hostile peer might put into an html output.
    private static let hostile = """
    <h1 onclick="steal()">Report</h1>
    <script>document.title = 'script ran'</script>
    <img src="m5probe://pixel.png" alt="remote">
    <img src="https://evil.example/x.png">
    <link rel="stylesheet" href="m5probe://style.css" />
    <style>body{background:url(m5probe://bg.png)}</style>
    <iframe src="m5probe://frame.html"></iframe>
    <a href="javascript:alert(1)">bad</a> <a href="https://example.org/ok">ok</a>
    <p style="background-image:url(m5probe://inline.png);color:red">text</p>
    <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=">
    """

    func testTheMarkupIsSanitizedAgain() {
        let safe = FnHtml.sanitize(Self.hostile)
        for bad in ["<script", "onclick", "m5probe:", "evil.example", "<iframe", "<link", "<style", "javascript:"] {
            XCTAssertFalse(safe.contains(bad), "\(bad) survived: \(safe)")
        }
        XCTAssertTrue(safe.contains("https://example.org/ok"), safe)
        XCTAssertTrue(safe.contains("data:image/png;base64,"), safe)
        XCTAssertTrue(safe.contains("style=\"color: red\""), safe) // the url(…) declaration dropped, the colour kept
        XCTAssertFalse(safe.contains("background-image"), safe)
    }

    /// As on the web (client/src/lib/fn-html.ts) and Android: a dropped element that is void in HTML but not in the
    /// sanitizer's list (link, meta, input…) takes everything after it with it — fail-closed, the same on every client.
    func testABareMetaDropsTheRestAsOnTheWeb() {
        XCTAssertEqual(FnHtml.sanitize("<p>before</p><meta charset=\"x\"><p>after</p>"), "<p>before</p>")
        XCTAssertEqual(FnHtml.sanitize("<p>before</p><meta charset=\"x\" /><p>after</p>"), "<p>before</p><p>after</p>")
    }

    func testThePageAllowsOnlyItsOwnPicturesAndStyle() {
        let page = FnHtmlPage.page("<p>x</p>", "body{}")
        XCTAssertTrue(page.contains("Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\""))
        XCTAssertTrue(page.hasPrefix("<!doctype html>"))
        XCTAssertTrue(page.contains("<div class=\"fn-html__body\"><p>x</p></div>"))
        let style = FnHtmlPage.style(FnHtmlPage.Palette(ink: .black, muted: .gray, panel: .lightGray, border: .gray, link: .blue, ok: .white, err: .red, warn: .white))
        XCTAssertTrue(style.contains("color:rgba(0,0,0,1.000)"))
        XCTAssertTrue(style.contains(".m5h-badge--err{background:rgba(255,0,0,0.180);color:rgba(255,0,0,1.000)}"))
        XCTAssertTrue(style.contains("-webkit-user-select:none"))
        XCTAssertEqual(FnHtmlPage.css(DesignColor(argb: 0x8011_2233), 0.5), "rgba(17,34,51,0.251)")
    }

    func testTheWebViewsConfiguration() throws {
        let rules = try compiledRules()
        let c = FnHtmlWeb.configuration(rules: rules)
        XCTAssertFalse(c.defaultWebpagePreferences.allowsContentJavaScript)
        XCTAssertFalse(c.preferences.javaScriptCanOpenWindowsAutomatically)
        XCTAssertFalse(c.websiteDataStore.isPersistent)
        XCTAssertEqual(c.mediaTypesRequiringUserActionForPlayback, .all)
        XCTAssertEqual(c.dataDetectorTypes, [])
        XCTAssertFalse(c.allowsInlineMediaPlayback)
    }

    private func compiledRules() throws -> WKContentRuleList {
        var list: WKContentRuleList?
        var done = false
        FnHtmlRules.get { list = $0; done = true }
        toolsWait(10) { done }
        return try XCTUnwrap(list, "the rule list did not compile")
    }

    /// Loads raw HTML (no CSP — to test the rule list and the script switch on their own) and returns what it requested.
    private func load(_ html: String, appConfiguration: Bool) throws -> (requested: [String], title: String) {
        let probe = ToolsProbeSchemeHandler()
        let config: WKWebViewConfiguration = appConfiguration ? FnHtmlWeb.configuration(rules: try compiledRules()) : {
            let c = WKWebViewConfiguration()
            c.websiteDataStore = .nonPersistent()
            return c
        }()
        config.setURLSchemeHandler(probe, forURLScheme: "m5probe")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: config)
        let waiter = ToolsLoadWaiter()
        web.navigationDelegate = waiter
        let window = UIWindow(frame: web.frame)
        window.addSubview(web)
        window.isHidden = false
        defer { window.isHidden = true }
        web.loadHTMLString(html, baseURL: nil) // as the app loads its pages (about:blank)
        toolsWait(15) { waiter.finished }
        toolsSettle(1.0)
        return (probe.requested, web.title ?? "")
    }

    func testTheProbeSeesLoadsWithoutTheLockdown() throws {
        let r = try load("<html><head><title>t</title></head><body><img src=\"m5probe://pixel.png\"><script>document.title='script ran'</script></body></html>", appConfiguration: false)
        XCTAssertTrue(r.requested.contains { $0.contains("pixel.png") }, "the probe saw nothing: \(r.requested)")
        XCTAssertEqual(r.title, "script ran")
    }

    func testTheAppsWebViewLoadsNothingAndRunsNoScript() throws {
        let raw = "<html><head><title>t</title><link rel=\"stylesheet\" href=\"m5probe://style.css\"></head><body>"
            + "<img src=\"m5probe://pixel.png\"><script src=\"m5probe://code.js\"></script><script>document.title='script ran'</script>"
            + "<iframe src=\"m5probe://frame.html\"></iframe><p style=\"background-image:url(m5probe://inline.png)\">x</p></body></html>"
        let r = try load(raw, appConfiguration: true)
        XCTAssertEqual(r.requested, [], "the page loaded: \(r.requested)")
        XCTAssertEqual(r.title, "t", "a script ran")
    }

    func testTheAppsOwnPageOfAHostileOutput() throws {
        // The whole path: sanitize, page with its CSP, the app's configuration.
        let page = FnHtmlPage.page(FnHtml.serialize(FnHtml.parse(Self.hostile)), "body{}")
        let r = try load(page, appConfiguration: true)
        XCTAssertEqual(r.requested, [])
        XCTAssertNotEqual(r.title, "script ran")
    }

    func testNothingNavigatesInPlaceALinkGoesToTheApp() async throws {
        var opened: [String] = []
        let view = FnHtmlWebView(page: "", zoom: 1, height: .constant(48), openLink: { opened.append($0) }, gone: { _ in })
        let c = FnHtmlWebView.Coordinator(view)
        let web = WKWebView()
        let start = await c.webView(web, decidePolicyFor: ToolsFakeNavigationAction("about:blank", .other))
        XCTAssertEqual(start, .allow)
        let tap = await c.webView(web, decidePolicyFor: ToolsFakeNavigationAction("https://example.org/ok", .linkActivated))
        XCTAssertEqual(tap, .cancel)
        let mail = await c.webView(web, decidePolicyFor: ToolsFakeNavigationAction("mailto:a@b.cz", .linkActivated))
        XCTAssertEqual(mail, .cancel)
        let js = await c.webView(web, decidePolicyFor: ToolsFakeNavigationAction("javascript:alert(1)", .linkActivated))
        XCTAssertEqual(js, .cancel)
        let auto = await c.webView(web, decidePolicyFor: ToolsFakeNavigationAction("https://evil.example/redirect", .other))
        XCTAssertEqual(auto, .cancel) // not a tap: never opened
        let form = await c.webView(web, decidePolicyFor: ToolsFakeNavigationAction("https://evil.example/post", .formSubmitted))
        XCTAssertEqual(form, .cancel)
        XCTAssertEqual(opened, ["https://example.org/ok", "mailto:a@b.cz"])
        XCTAssertNil(c.webView(web, createWebViewWith: WKWebViewConfiguration(), for: ToolsFakeNavigationAction("https://x.example", .other), windowFeatures: WKWindowFeatures()))
    }

    func testALinkIsOpenedOnlyAfterTheConfirmationAndOnlyHttps() {
        let host = toolsHost()
        // An address that cannot be read in full is refused with the design's words.
        ToolsLinks.confirmOpen("http://example.org", host: host)
        XCTAssertEqual(host.flashes.last?.text, host.translator.t("security.urlRefused"))
        XCTAssertTrue(DesignUrls.openable("https://example.org/ok"))
        XCTAssertFalse(DesignUrls.openable("mailto:a@b.cz"))
        XCTAssertNil(FnHtmlPage.linkTarget(URL(string: "javascript:alert(1)")))
        XCTAssertNil(FnHtmlPage.linkTarget(URL(string: "file:///etc/passwd")))
        XCTAssertEqual(FnHtmlPage.linkTarget(URL(string: "https://a.cz")), "https://a.cz")
    }
}
