// Formatted HTML (6.6, m5.out.html): FnHtml, the port of
// client/src/lib/fn-html.ts — android fn/FnHtmlTest. The expected strings
// come from the TypeScript itself: the constants below, the card reports of
// client/src/lib/nfc/card-report.ts (fn-html-reports.json) and seeded random
// inputs (fn-html-cases.json) — the result must be the same, character for
// character. (thePageAllowsNothingButItsStyleAndDataPictures tests the
// Android WebView page, FnHtmlView — UI, not ported.)

import Foundation
import M5Core
import M5Proto
import Testing

@Suite("fn FnHtml")
struct FnHtmlTests {
    private func sanitize(_ html: String?) -> String { FnHtml.sanitize(html) }

    private func text(_ html: String) -> String { FnHtml.text(FnHtml.parse(html)) }

    /// { input, sanitizeFnHtml(input), fnHtmlText(parseFnHtml(input)) } — from the TypeScript.
    private static let sameAsTs: [[String]] = [
        ["<p onclick=\"x()\">Hi <script>alert(\"<b>\")</script><b>there</b><style>p{color:red}</style></p><iframe src=\"x\"><p>in</p></iframe><form action=\"/x\"><input value=1>gone</form><svg><a href=\"https://x\">s</a></svg>after",
         "<p>Hi <b>there</b></p>after",
         "Hi there\nafter"],
        ["<div class=\"m5h-kv evil M5H-x m5h-sec\" style=\"color: red; background: url(x); position: fixed; display: flex; font-size:12px; width: expression(1); COLOR : Blue\" id=\"x\" data-x=\"1\" onmouseover=\"y\" title=\"T\">x</div>",
         "<div class=\"m5h-kv m5h-sec\" style=\"color: red; display: flex; font-size: 12px; color: Blue\" title=\"T\">x</div>",
         "x"],
        ["<a href=\"javascript:alert(1)\">a</a><a href=\" https://m5.example/a?b=1&amp;c=2 \">b</a><a href=\"mailto:x@y.z\">c</a><a href=\"data:text/html,x\">d</a><a HREF=HTTP://X/Y target=\"_top\">e</a>",
         "<a>a</a><a href=\"https://m5.example/a?b=1&amp;c=2\">b</a><a href=\"mailto:x@y.z\">c</a><a>d</a><a href=\"HTTP://X/Y\">e</a>",
         "abcde"],
        ["<img src=\"https://x/y.png\" alt=\"net\"><img src=\"data:image/svg+xml;base64,PHN2Zz4=\" alt=\"svg\"><img src=\"data:image/png;base64,iVBO Rw0K Gg==\" alt=\"ok\" width=\"120\" height=\"99999\" onerror=\"x\"><img src=\"data:image/jpeg;base64,/9j/\" width=\" 0x20 \">",
         "<img src=\"data:image/png;base64,iVBORw0KGg==\" alt=\"ok\" width=\"120\"><img src=\"data:image/jpeg;base64,/9j/\" width=\"32\">",
         "[ok]"],
        ["<p title=\"&quot;q&quot; &amp; &#x41;\">&lt;b&gt; &amp;amp; &#128512; &#0;&#xD800; &nbsp;&hellip; &unknown; &amp</p>",
         "<p title=\"&quot;q&quot; &amp; A\">&lt;b&gt; &amp;amp; \u{1F600}  \u{00A0}\u{2026} &amp;unknown; &amp;amp</p>",
         "<b> &amp; \u{1F600}  \u{00A0}\u{2026} &unknown; &amp"],
        ["<details open class=\"m5h-sec\"><summary>S</summary><table class=\"m5h-grid\"><tr><th scope=\"col\" colspan=\"2\">A</th><td rowspan=\"x\">1</td></tr></table></details><ol start=\"3\" reversed><li>a<li>b</ol>x<br/>y<hr>",
         "<details open class=\"m5h-sec\"><summary>S</summary><table class=\"m5h-grid\"><tr><th scope=\"col\" colspan=\"2\">A</th><td>1</td></tr></table></details><ol start=\"3\" reversed><li>a<li>b</li></li></ol>x<br>y<hr>",
         "S\n\nA\t1\n\na\nb\n\nx\ny"],
        ["<div><b>bold <i>both</div>after</b> <p>para <!-- comment --> <!doctype x> <?pi?> 1 < 3 > 2 <a b=>c</p><X-Y>custom</X-Y><DIV DIR=rtl LANG=cs>up</div>",
         "<div><b>bold <i>both</i></b></div>after <p>para    1 &lt; 3 &gt; 2 &lt;a b=&gt;c</p>&lt;X-Y&gt;custom&lt;/X-Y&gt;<div dir=\"rtl\" lang=\"cs\">up</div>",
         "bold both\nafter\npara    1 < 3 > 2 <a b=>c\n<X-Y>custom</X-Y>\nup"],
    ]

    @Test func byteIdenticalToTheTypeScript() {
        for c in Self.sameAsTs {
            #expect(sanitize(c[0]) == c[1], "\(c[0])")
            #expect(text(c[0]) == c[2], "\(c[0])")
        }
    }

    @Test func randomInputsAsTheTypeScriptReadsThem() throws {
        let cases = try #require(try FnRepo.fnVectors("fn-html-cases.json").array("cases"))
        #expect(cases.count >= 300)
        var failures = 0
        for x in cases {
            let c = try #require(x.objectValue)
            let input = try #require(c.string("in"))
            if sanitize(input) != c.string("html") || text(input) != c.string("text") { failures += 1 }
            #expect(sanitize(input) == c.string("html"), "\(input)")
            #expect(text(input) == c.string("text"), "\(input)")
            if failures > 5 { break }
        }
    }

    @Test func dropsScriptsStylesFramesAndFormsWithWhatIsInside() {
        #expect(sanitize("a<script>x<script>y</script>z</script>b") == "ab")
        #expect(sanitize("a<STYLE type=\"text/css\">p { color: red }</STYLE>b") == "ab")
        #expect(sanitize("a<iframe src=\"https://x\"><p>inside</p></iframe>b") == "ab")
        #expect(sanitize("a<form><input name=x><button>go</button>text</form>b") == "ab")
        #expect(sanitize("a<object><embed></object>b") == "ab")
        // A self-closed one drops nothing after it; an unclosed one drops the rest.
        #expect(sanitize("a<script/><b>b</b>") == "a<b>b</b>")
        #expect(sanitize("a<svg><p>never</p>") == "a")
        // Unknown tags go, their text stays; a name with "-" is no tag at all.
        #expect(sanitize("<custom>x</custom><i>y</i>") == "x<i>y</i>")
        #expect(sanitize("<custom-el>x</custom-el>") == "&lt;custom-el&gt;x&lt;/custom-el&gt;")
    }

    @Test func dropsHandlersAndUnknownAttributes() {
        #expect(sanitize("<p onclick=\"a()\" ONLOAD=b id=\"i\" data-x=1 hidden contenteditable>x</p>") == "<p>x</p>")
        #expect(sanitize("<a target=\"_blank\" rel=\"opener\" download>x</a>") == "<a>x</a>")
        #expect(sanitize("<td scope=\"row\">x") == "<td>x</td>")
        #expect(sanitize("<th scope=row colspan=2>x") == "<th scope=\"row\" colspan=\"2\">x</th>")
        #expect(sanitize("<span title=t lang=cs dir=ltr dir=sideways>x</span>") == "<span title=\"t\" lang=\"cs\" dir=\"ltr\">x</span>")
        // A repeated attribute keeps its first place and its last good value.
        #expect(sanitize("<p title=a class=m5h-a title=b class=bad>x</p>") == "<p title=\"b\" class=\"m5h-a\">x</p>")
    }

    @Test func classKeepsOnlyReportClasses() {
        #expect(sanitize("<div class=\" m5h-kv  app-header m5h-kv--mono M5H-X m5h- \">x</div>") == "<div class=\"m5h-kv m5h-kv--mono\">x</div>")
        #expect(sanitize("<div class=\"btn primary\">x</div>") == "<div>x</div>")
        #expect(sanitize("<div class=\"m5h-1 m5h-2 m5h-3 m5h-4 m5h-5 m5h-6 m5h-7 m5h-8 m5h-9\">x</div>") == "<div class=\"m5h-1 m5h-2 m5h-3 m5h-4 m5h-5 m5h-6 m5h-7 m5h-8\">x</div>")
    }

    @Test func styleKeepsHarmlessPropertiesWithoutUrls() {
        #expect(sanitize("<p style=\"color:red;position:fixed;font-weight: 600\">x</p>") == "<p style=\"color: red; font-weight: 600\">x</p>")
        #expect(sanitize("<p style=\"background-color: url(javascript:x)\">x</p>") == "<p>x</p>")
        #expect(sanitize("<p style=\"width: expression(alert(1)); color: var(--x); border: attr(x); color: a\\62 c\">x</p>") == "<p>x</p>")
        #expect(sanitize("<p style=\"background-color: URL (x); color: blue; margin: {}\">x</p>") == "<p style=\"color: blue\">x</p>")
        #expect(sanitize("<p style=\"display: flex; display: contents\">x</p>") == "<p style=\"display: flex\">x</p>")
        #expect(FnHtml.safeStyle(" COLOR : red ;;") == "color: red")
    }

    @Test func linksOnlyHttpAndMailto() {
        #expect(sanitize("<a href=\"https://m5.example/x\">a</a>") == "<a href=\"https://m5.example/x\">a</a>")
        #expect(sanitize("<a href=\"javascript:alert(1)\">a</a>") == "<a>a</a>")
        #expect(sanitize("<a href=\"java&#x73;cript:alert(1)\">a</a>") == "<a>a</a>")
        #expect(sanitize("<a href=\"/relative\">a</a>") == "<a>a</a>")
        #expect(sanitize("<a href=\"https://x y\">a</a>") == "<a>a</a>")
        #expect(sanitize("<a href=\"ftp://x\">a</a>") == "<a>a</a>")
        #expect(sanitize("<a href=\"  mailto:a@b.c\n\">a</a>") == "<a href=\"mailto:a@b.c\">a</a>")
        #expect(FnHtml.safeHref("https://") == nil)
        #expect(FnHtml.safeHref("HTTPS://X") == "HTTPS://X")
    }

    @Test func picturesOnlyAsDataImages() {
        let png = "data:image/png;base64,iVBORw0KGgo="
        #expect(sanitize("<img src=\"" + png + "\" alt=\"a\">") == "<img src=\"" + png + "\" alt=\"a\">")
        // Any other source: no picture, no element.
        #expect(sanitize("<img src=\"https://tracker.example/p.gif\" alt=\"a\">") == "")
        #expect(sanitize("<img src=\"data:image/svg+xml;base64,PHN2Zz4=\">") == "")
        #expect(sanitize("<img src=\"data:text/html;base64,PHA+\">") == "")
        #expect(sanitize("<img src=\"data:image/png,raw\">") == "")
        #expect(sanitize("<img src=\"data:image/png;base64,AA===\">") == "")
        #expect(sanitize("<img alt=\"none\">") == "")
        // White space inside the data goes (a long base64 may be wrapped).
        #expect(sanitize("<img src=\"data:image/jpeg;base64,/9j/\n4AAQ\">") == "<img src=\"data:image/jpeg;base64,/9j/4AAQ\">")
        #expect(FnHtml.imageSrc("data:image/webp;base64,UklGRg=="))
        #expect(!FnHtml.imageSrc("data:image/webp;base64,"))
        // Sizes: integers in range only.
        #expect(sanitize("<img src=\"" + png + "\" width=\"\" height=\"4e3\">") == "<img src=\"" + png + "\" width=\"0\" height=\"4000\">")
        #expect(sanitize("<img src=\"" + png + "\" width=\"4001\" height=\"1.5\">") == "<img src=\"" + png + "\">")
    }

    @Test func entitiesDecodedAndEscapedAgain() {
        #expect(sanitize("<p>&lt;b&gt; &amp; &quot; &apos; &nbsp; &MDASH; &#65; &#x1f600;</p>") == "<p>&lt;b&gt; &amp; &quot; ' \u{00A0} \u{2014} A \u{1F600}</p>")
        #expect(sanitize("<p title='\"<>&amp;'>x</p>") == "<p title=\"&quot;&lt;&gt;&amp;\">x</p>")
        // Unknown, unterminated or out of range: as written (or nothing, for a bad number).
        #expect(sanitize("&bogus; &amp &#x1100000;") == "&amp;bogus; &amp;amp &amp;#x1100000;")
        #expect(sanitize("&#x110000;") == "")
        #expect(sanitize("&#0;&#xD800;&#1114112;") == "")
        #expect(FnHtml.decodeEntities("&lt;b&gt; &amp; x") == "<b> & x")
    }

    @Test func brokenMarkupIsText() {
        #expect(sanitize("a < b") == "a &lt; b")
        #expect(sanitize("<p") == "&lt;p")
        #expect(sanitize("<a href=\"x>") == "&lt;a href=&quot;x&gt;")
        #expect(sanitize("</ p>") == "&lt;/ p&gt;")
        #expect(sanitize("<!-- <script>x</script> -->ok") == "ok")
        #expect(sanitize("<!-- never closed <b>x</b>") == "")
    }

    private func count(_ s: String, _ what: String) -> Int { s.components(separatedBy: what).count - 1 }

    @Test func depthAndSizeAreBounded() {
        let out = sanitize(String(repeating: "<div>", count: 200) + "x")
        #expect(count(out, "<div>") == 200)
        #expect(out.hasSuffix("</div>"))
        #expect(count(sanitize(String(repeating: "<b>x</b>", count: 30_000)), "<b>") == 10_000)
        #expect(sanitize(nil) == "")
    }

    @Test func pathologicalInputFinishesFast() {
        let input = String(repeating: "<a ", count: 200_000)
        let clock = ContinuousClock()
        let start = clock.now
        let out = sanitize(input)
        #expect(clock.now - start < .seconds(2), "took \(clock.now - start)")
        #expect(out == input.replacingOccurrences(of: "<", with: "&lt;"))
        // A tag with very many attributes, a never-ending quote, a huge hex size: no deep recursion, no big numbers.
        #expect(sanitize("<div" + String(repeating: " a", count: 300_000) + ">x") == "<div>x</div>")
        #expect(sanitize("<p title=\"" + String(repeating: "<p ", count: 500_000)).hasPrefix("&lt;p title=&quot;&lt;p &lt;p "))
        #expect(sanitize("<img width=\"0x" + String(repeating: "0", count: 1_000_000) + "1\" src=\"data:image/png;base64,AAAA\">") == "<img width=\"1\" src=\"data:image/png;base64,AAAA\">")
    }

    @Test func cardReportsSurviveIntact() throws {
        let reports = try #require(try FnRepo.fnVectors("fn-html-reports.json").array("reports"))
        #expect(reports.count == 3)
        for x in reports {
            let r = try #require(x.objectValue)
            let input = try #require(r.string("in"))
            let name = r.string("name") ?? ""
            #expect(sanitize(input) == r.string("html"), "\(name)")
            #expect(sanitize(input) == input, "\(name): nothing of a report is dropped")
            #expect(text(input) == r.string("text"), "\(name)")
            #expect(sanitize(sanitize(input)) == input, "\(name)")
        }
        let emv = try #require(reports[0]["in"]?.stringValue)
        #expect(emv.contains("<table class=\"m5h-kv\">"))
        #expect(emv.contains("<table class=\"m5h-grid\">"))
        #expect(emv.contains("<details class=\"m5h-sec\"><summary>"))
        #expect(emv.contains("BILLA &amp; CO"))
        #expect(emv.contains("&lt;script&gt;alert(1)&lt;/script&gt;"))
        let eid = try #require(reports[1]["in"]?.stringValue)
        #expect(eid.contains("<div class=\"m5h-id\"><figure class=\"m5h-photo\"><img src=\"data:image/jpeg;base64,/9j/4AECA//Z\""))
        #expect(eid.contains("m5h-badge m5h-badge--ok"))
        // The tree: the face is an img with its data URI.
        let tree = FnHtml.parse(eid)
        #expect(tree[0].tag == "div")
        #expect(tree[0].attr("class") == "m5h-report m5h-report--mrtd")
        #expect(text(eid).contains("ERIKSSON, ANNA MARIA"))
    }

    @Test func textOfATree() {
        #expect(text("<h4>Head</h4><table><tr><th>A</th><td>1</td></tr></table><p>x<br>y <img src=\"data:image/png;base64,AA==\" alt=\"pic\"></p>") == "Head\n\nA\t1\n\nx\ny [pic]")
        #expect(text("<p>a</p>  \n\n\n\n<p>b</p>") == "a\n\nb")
        #expect(text("") == "")
    }

    /* ------------------------------------------------- Outputs, type html */

    @Test func outputCheckSanitizesAndKeepsTheTitle() {
        let title = String(repeating: "T", count: 305)
        let c = Outputs.check(.object(JSONObject([("type", "html"), ("html", "<p onclick=x>Hi &amp; bye</p><script>1</script>"), ("title", .string(title))])))
        #expect(c.ok)
        fnSame("{\"type\":\"html\",\"html\":\"<p>Hi &amp; bye</p>\",\"title\":\"" + String(repeating: "T", count: 300) + "\"}", c.output)
        fnSame("{\"type\":\"html\",\"html\":\"\"}", Outputs.check(.object(JSONObject([("type", "html"), ("html", ""), ("title", "")]))).output)
    }

    @Test func outputCheckRefusesOversizeAndNonStrings() {
        let big = String(repeating: "x", count: FnHtml.max + 1)
        let c = Outputs.check(.object(JSONObject([("type", "html"), ("html", .string(big))])))
        #expect(!c.ok)
        #expect(c.reason == "html: html must be a string (up to 2000000 characters)")
        #expect(Outputs.check(.object(JSONObject([("type", "html"), ("html", 5)]))).reason == "html: html must be a string (up to 2000000 characters)")
        #expect(!Outputs.check(.object(JSONObject([("type", "html")]))).ok)
        // A peer's message: no output larger than the message may carry.
        let many = String(repeating: "<b>x</b>", count: 120_000)
        let peer: [JSON] = [.object(JSONObject([("type", "html"), ("html", .string(many))])), .object(JSONObject([("type", "html"), ("html", "<i>ok</i>")]))]
        fnSame("[{\"type\":\"html\",\"html\":\"<i>ok</i>\"}]", Outputs.sanitize(.array(peer)))
    }

    @Test func markdownOfHtmlIsItsText() {
        let outputs = fnList("[{\"type\":\"html\",\"title\":\"Card\",\"html\":\"<h4>Head</h4><table><tr><th>A</th><td>1</td></tr></table><p>x<br>y <img src=\\\"data:image/png;base64,AA==\\\" alt=\\\"pic\\\"></p>\"},{\"type\":\"text\",\"text\":\"after\"}]")
        #expect(Outputs.toMarkdown(outputs) == "**Card**\n\nHead\n\nA\t1\n\nx\ny [pic]\n\nafter")
    }
}
