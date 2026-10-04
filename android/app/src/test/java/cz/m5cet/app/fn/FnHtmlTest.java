package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Formatted HTML (6.6, m5.out.html): FnHtml, the port of
 * client/src/lib/fn-html.ts. The expected strings come from the TypeScript
 * itself (sanitizeFnHtml / fnHtmlText run with tsx): the constants below, the
 * card reports of client/src/lib/nfc/card-report.ts (fn-html-reports.json)
 * and seeded random inputs (fn-html-cases.json) — the Java result must be the
 * same, character for character.
 */
public class FnHtmlTest {
    private static String sanitize(String html) { return FnHtml.sanitize(html); }

    private static String text(String html) { return FnHtml.text(FnHtml.parse(html)); }

    private static JSONObject resource(String name) throws Exception {
        try (InputStream in = FnHtmlTest.class.getResourceAsStream(name)) {
            assertTrue(name + " is on the test class path", in != null);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8));
        }
    }

    /** { input, sanitizeFnHtml(input), fnHtmlText(parseFnHtml(input)) } — from the TypeScript. */
    private static final String[][] SAME_AS_TS = {
        { "<p onclick=\"x()\">Hi <script>alert(\"<b>\")</script><b>there</b><style>p{color:red}</style></p><iframe src=\"x\"><p>in</p></iframe><form action=\"/x\"><input value=1>gone</form><svg><a href=\"https://x\">s</a></svg>after",
          "<p>Hi <b>there</b></p>after",
          "Hi there\nafter" },
        { "<div class=\"m5h-kv evil M5H-x m5h-sec\" style=\"color: red; background: url(x); position: fixed; display: flex; font-size:12px; width: expression(1); COLOR : Blue\" id=\"x\" data-x=\"1\" onmouseover=\"y\" title=\"T\">x</div>",
          "<div class=\"m5h-kv m5h-sec\" style=\"color: red; display: flex; font-size: 12px; color: Blue\" title=\"T\">x</div>",
          "x" },
        { "<a href=\"javascript:alert(1)\">a</a><a href=\" https://m5.example/a?b=1&amp;c=2 \">b</a><a href=\"mailto:x@y.z\">c</a><a href=\"data:text/html,x\">d</a><a HREF=HTTP://X/Y target=\"_top\">e</a>",
          "<a>a</a><a href=\"https://m5.example/a?b=1&amp;c=2\">b</a><a href=\"mailto:x@y.z\">c</a><a>d</a><a href=\"HTTP://X/Y\">e</a>",
          "abcde" },
        { "<img src=\"https://x/y.png\" alt=\"net\"><img src=\"data:image/svg+xml;base64,PHN2Zz4=\" alt=\"svg\"><img src=\"data:image/png;base64,iVBO Rw0K Gg==\" alt=\"ok\" width=\"120\" height=\"99999\" onerror=\"x\"><img src=\"data:image/jpeg;base64,/9j/\" width=\" 0x20 \">",
          "<img src=\"data:image/png;base64,iVBORw0KGg==\" alt=\"ok\" width=\"120\"><img src=\"data:image/jpeg;base64,/9j/\" width=\"32\">",
          "[ok]" },
        { "<p title=\"&quot;q&quot; &amp; &#x41;\">&lt;b&gt; &amp;amp; &#128512; &#0;&#xD800; &nbsp;&hellip; &unknown; &amp</p>",
          "<p title=\"&quot;q&quot; &amp; A\">&lt;b&gt; &amp;amp; \uD83D\uDE00  \u00A0\u2026 &amp;unknown; &amp;amp</p>",
          "<b> &amp; \uD83D\uDE00  \u00A0\u2026 &unknown; &amp" },
        { "<details open class=\"m5h-sec\"><summary>S</summary><table class=\"m5h-grid\"><tr><th scope=\"col\" colspan=\"2\">A</th><td rowspan=\"x\">1</td></tr></table></details><ol start=\"3\" reversed><li>a<li>b</ol>x<br/>y<hr>",
          "<details open class=\"m5h-sec\"><summary>S</summary><table class=\"m5h-grid\"><tr><th scope=\"col\" colspan=\"2\">A</th><td>1</td></tr></table></details><ol start=\"3\" reversed><li>a<li>b</li></li></ol>x<br>y<hr>",
          "S\n\nA\t1\n\na\nb\n\nx\ny" },
        { "<div><b>bold <i>both</div>after</b> <p>para <!-- comment --> <!doctype x> <?pi?> 1 < 3 > 2 <a b=>c</p><X-Y>custom</X-Y><DIV DIR=rtl LANG=cs>up</div>",
          "<div><b>bold <i>both</i></b></div>after <p>para    1 &lt; 3 &gt; 2 &lt;a b=&gt;c</p>&lt;X-Y&gt;custom&lt;/X-Y&gt;<div dir=\"rtl\" lang=\"cs\">up</div>",
          "bold both\nafter\npara    1 < 3 > 2 <a b=>c\n<X-Y>custom</X-Y>\nup" },
    };

    @Test
    public void byteIdenticalToTheTypeScript() {
        for (String[] c : SAME_AS_TS) {
            assertEquals(c[0], c[1], sanitize(c[0]));
            assertEquals(c[0], c[2], text(c[0]));
        }
    }

    @Test
    public void randomInputsAsTheTypeScriptReadsThem() throws Exception {
        JSONArray cases = resource("fn-html-cases.json").getJSONArray("cases");
        assertTrue(cases.length() >= 300);
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            assertEquals(c.getString("in"), c.getString("html"), sanitize(c.getString("in")));
            assertEquals(c.getString("in"), c.getString("text"), text(c.getString("in")));
        }
    }

    @Test
    public void dropsScriptsStylesFramesAndFormsWithWhatIsInside() {
        assertEquals("ab", sanitize("a<script>x<script>y</script>z</script>b"));
        assertEquals("ab", sanitize("a<STYLE type=\"text/css\">p { color: red }</STYLE>b"));
        assertEquals("ab", sanitize("a<iframe src=\"https://x\"><p>inside</p></iframe>b"));
        assertEquals("ab", sanitize("a<form><input name=x><button>go</button>text</form>b"));
        assertEquals("ab", sanitize("a<object><embed></object>b"));
        // A self-closed one drops nothing after it; an unclosed one drops the rest.
        assertEquals("a<b>b</b>", sanitize("a<script/><b>b</b>"));
        assertEquals("a", sanitize("a<svg><p>never</p>"));
        // Unknown tags go, their text stays; a name with "-" is no tag at all.
        assertEquals("x<i>y</i>", sanitize("<custom>x</custom><i>y</i>"));
        assertEquals("&lt;custom-el&gt;x&lt;/custom-el&gt;", sanitize("<custom-el>x</custom-el>"));
    }

    @Test
    public void dropsHandlersAndUnknownAttributes() {
        assertEquals("<p>x</p>", sanitize("<p onclick=\"a()\" ONLOAD=b id=\"i\" data-x=1 hidden contenteditable>x</p>"));
        assertEquals("<a>x</a>", sanitize("<a target=\"_blank\" rel=\"opener\" download>x</a>"));
        assertEquals("<td>x</td>", sanitize("<td scope=\"row\">x"));
        assertEquals("<th scope=\"row\" colspan=\"2\">x</th>", sanitize("<th scope=row colspan=2>x"));
        assertEquals("<span title=\"t\" lang=\"cs\" dir=\"ltr\">x</span>", sanitize("<span title=t lang=cs dir=ltr dir=sideways>x</span>"));
        // A repeated attribute keeps its first place and its last good value.
        assertEquals("<p title=\"b\" class=\"m5h-a\">x</p>", sanitize("<p title=a class=m5h-a title=b class=bad>x</p>"));
    }

    @Test
    public void classKeepsOnlyReportClasses() {
        assertEquals("<div class=\"m5h-kv m5h-kv--mono\">x</div>", sanitize("<div class=\" m5h-kv  app-header m5h-kv--mono M5H-X m5h- \">x</div>"));
        assertEquals("<div>x</div>", sanitize("<div class=\"btn primary\">x</div>"));
        assertEquals("<div class=\"m5h-1 m5h-2 m5h-3 m5h-4 m5h-5 m5h-6 m5h-7 m5h-8\">x</div>", sanitize("<div class=\"m5h-1 m5h-2 m5h-3 m5h-4 m5h-5 m5h-6 m5h-7 m5h-8 m5h-9\">x</div>"));
    }

    @Test
    public void styleKeepsHarmlessPropertiesWithoutUrls() {
        assertEquals("<p style=\"color: red; font-weight: 600\">x</p>", sanitize("<p style=\"color:red;position:fixed;font-weight: 600\">x</p>"));
        assertEquals("<p>x</p>", sanitize("<p style=\"background-color: url(javascript:x)\">x</p>"));
        assertEquals("<p>x</p>", sanitize("<p style=\"width: expression(alert(1)); color: var(--x); border: attr(x); color: a\\62 c\">x</p>"));
        assertEquals("<p style=\"color: blue\">x</p>", sanitize("<p style=\"background-color: URL (x); color: blue; margin: {}\">x</p>"));
        assertEquals("<p style=\"display: flex\">x</p>", sanitize("<p style=\"display: flex; display: contents\">x</p>"));
        assertEquals("color: red", FnHtml.safeStyle(" COLOR : red ;;"));
    }

    @Test
    public void linksOnlyHttpAndMailto() {
        assertEquals("<a href=\"https://m5.example/x\">a</a>", sanitize("<a href=\"https://m5.example/x\">a</a>"));
        assertEquals("<a>a</a>", sanitize("<a href=\"javascript:alert(1)\">a</a>"));
        assertEquals("<a>a</a>", sanitize("<a href=\"java&#x73;cript:alert(1)\">a</a>"));
        assertEquals("<a>a</a>", sanitize("<a href=\"/relative\">a</a>"));
        assertEquals("<a>a</a>", sanitize("<a href=\"https://x y\">a</a>"));
        assertEquals("<a>a</a>", sanitize("<a href=\"ftp://x\">a</a>"));
        assertEquals("<a href=\"mailto:a@b.c\">a</a>", sanitize("<a href=\"  mailto:a@b.c\n\">a</a>"));
        assertNull(FnHtml.safeHref("https://"));
        assertEquals("HTTPS://X", FnHtml.safeHref("HTTPS://X"));
    }

    @Test
    public void picturesOnlyAsDataImages() {
        String png = "data:image/png;base64,iVBORw0KGgo=";
        assertEquals("<img src=\"" + png + "\" alt=\"a\">", sanitize("<img src=\"" + png + "\" alt=\"a\">"));
        // Any other source: no picture, no element.
        assertEquals("", sanitize("<img src=\"https://tracker.example/p.gif\" alt=\"a\">"));
        assertEquals("", sanitize("<img src=\"data:image/svg+xml;base64,PHN2Zz4=\">"));
        assertEquals("", sanitize("<img src=\"data:text/html;base64,PHA+\">"));
        assertEquals("", sanitize("<img src=\"data:image/png,raw\">"));
        assertEquals("", sanitize("<img src=\"data:image/png;base64,AA===\">"));
        assertEquals("", sanitize("<img alt=\"none\">"));
        // White space inside the data goes (a long base64 may be wrapped).
        assertEquals("<img src=\"data:image/jpeg;base64,/9j/4AAQ\">", sanitize("<img src=\"data:image/jpeg;base64,/9j/\n4AAQ\">"));
        assertTrue(FnHtml.imageSrc("data:image/webp;base64,UklGRg=="));
        assertFalse(FnHtml.imageSrc("data:image/webp;base64,"));
        // Sizes: integers in range only.
        assertEquals("<img src=\"" + png + "\" width=\"0\" height=\"4000\">", sanitize("<img src=\"" + png + "\" width=\"\" height=\"4e3\">"));
        assertEquals("<img src=\"" + png + "\">", sanitize("<img src=\"" + png + "\" width=\"4001\" height=\"1.5\">"));
    }

    @Test
    public void entitiesDecodedAndEscapedAgain() {
        assertEquals("<p>&lt;b&gt; &amp; &quot; ' \u00A0 \u2014 A \uD83D\uDE00</p>", sanitize("<p>&lt;b&gt; &amp; &quot; &apos; &nbsp; &MDASH; &#65; &#x1f600;</p>"));
        assertEquals("<p title=\"&quot;&lt;&gt;&amp;\">x</p>", sanitize("<p title='\"<>&amp;'>x</p>"));
        // Unknown, unterminated or out of range: as written (or nothing, for a bad number).
        assertEquals("&amp;bogus; &amp;amp &amp;#x1100000;", sanitize("&bogus; &amp &#x1100000;"));
        assertEquals("", sanitize("&#x110000;"));
        assertEquals("", sanitize("&#0;&#xD800;&#1114112;"));
        assertEquals("<b> & x", FnHtml.decodeEntities("&lt;b&gt; &amp; x"));
    }

    @Test
    public void brokenMarkupIsText() {
        assertEquals("a &lt; b", sanitize("a < b"));
        assertEquals("&lt;p", sanitize("<p"));
        assertEquals("&lt;a href=&quot;x&gt;", sanitize("<a href=\"x>"));
        assertEquals("&lt;/ p&gt;", sanitize("</ p>"));
        assertEquals("ok", sanitize("<!-- <script>x</script> -->ok"));
        assertEquals("", sanitize("<!-- never closed <b>x</b>"));
    }

    @Test
    public void depthAndSizeAreBounded() {
        StringBuilder deep = new StringBuilder();
        for (int i = 0; i < 200; i++) deep.append("<div>");
        String out = sanitize(deep + "x");
        assertEquals(200, count(out, "<div>"));
        assertTrue(out.endsWith("</div>"));
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 30_000; i++) many.append("<b>x</b>");
        assertEquals(10_000, count(sanitize(many.toString()), "<b>"));
        assertEquals("", sanitize(null));
    }

    private static int count(String s, String what) {
        int n = 0;
        for (int i = s.indexOf(what); i >= 0; i = s.indexOf(what, i + 1)) n++;
        return n;
    }

    @Test(timeout = 5000)
    public void pathologicalInputFinishesFast() {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 200_000; i++) sb.append("<a ");
        String in = sb.toString();
        long t = System.nanoTime();
        String out = sanitize(in);
        assertTrue("took " + (System.nanoTime() - t) / 1_000_000 + " ms", System.nanoTime() - t < 2_000_000_000L);
        assertEquals(in.replace("<", "&lt;"), out);
        // A tag with very many attributes, a never-ending quote, a huge hex size: no deep recursion, no big numbers.
        sb.setLength(0);
        sb.append("<div");
        for (int i = 0; i < 300_000; i++) sb.append(" a");
        assertEquals("<div>x</div>", sanitize(sb + ">x"));
        sb.setLength(0);
        sb.append("<p title=\"");
        for (int i = 0; i < 500_000; i++) sb.append("<p ");
        assertTrue(sanitize(sb.toString()).startsWith("&lt;p title=&quot;&lt;p &lt;p "));
        sb.setLength(0);
        sb.append("<img width=\"0x");
        for (int i = 0; i < 1_000_000; i++) sb.append('0');
        assertEquals("<img width=\"1\" src=\"data:image/png;base64,AAAA\">", sanitize(sb + "1\" src=\"data:image/png;base64,AAAA\">"));
    }

    @Test
    public void cardReportsSurviveIntact() throws Exception {
        JSONArray reports = resource("fn-html-reports.json").getJSONArray("reports");
        assertEquals(3, reports.length());
        for (int i = 0; i < reports.length(); i++) {
            JSONObject r = reports.getJSONObject(i);
            String in = r.getString("in");
            assertEquals(r.getString("name"), r.getString("html"), sanitize(in));
            assertEquals(r.getString("name"), in, sanitize(in)); // nothing of a report is dropped
            assertEquals(r.getString("name"), r.getString("text"), text(in));
            assertEquals(r.getString("name"), in, sanitize(sanitize(in)));
        }
        String emv = reports.getJSONObject(0).getString("in");
        assertTrue(emv.contains("<table class=\"m5h-kv\">"));
        assertTrue(emv.contains("<table class=\"m5h-grid\">"));
        assertTrue(emv.contains("<details class=\"m5h-sec\"><summary>"));
        assertTrue(emv.contains("BILLA &amp; CO"));
        assertTrue(emv.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        String eid = reports.getJSONObject(1).getString("in");
        assertTrue(eid.contains("<div class=\"m5h-id\"><figure class=\"m5h-photo\"><img src=\"data:image/jpeg;base64,/9j/4AECA//Z\""));
        assertTrue(eid.contains("m5h-badge m5h-badge--ok"));
        // The tree: the face is an img with its data URI.
        List<FnHtml.SafeNode> tree = FnHtml.parse(eid);
        assertEquals("div", tree.get(0).tag);
        assertEquals("m5h-report m5h-report--mrtd", tree.get(0).attrs.get("class"));
        assertTrue(text(eid).contains("ERIKSSON, ANNA MARIA"));
    }

    @Test
    public void textOfATree() {
        assertEquals("Head\n\nA\t1\n\nx\ny [pic]", text("<h4>Head</h4><table><tr><th>A</th><td>1</td></tr></table><p>x<br>y <img src=\"data:image/png;base64,AA==\" alt=\"pic\"></p>"));
        assertEquals("a\n\nb", text("<p>a</p>  \n\n\n\n<p>b</p>"));
        assertEquals("", text(""));
    }

    /* ------------------------------------------------ the WebView's page */

    @Test
    public void thePageAllowsNothingButItsStyleAndDataPictures() {
        String style = FnHtmlView.style(new FnHtmlView.Palette(0xFF111111, 0xFF777777, 0xFFEEEEEE, 0xFFDDDDDD, 0xFF0066CC, 0xFF118833, 0xFFCC2222, 0xFFDD9900));
        String page = FnHtmlView.page(FnHtml.sanitize("<p onclick=x>x</p><script>y</script>"), style);
        assertTrue(page.startsWith("<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" "
            + "content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline';"));
        assertTrue(page.endsWith("<body><div class=\"fn-html__body\"><p>x</p></div></body></html>"));
        assertTrue(style.contains("html,body{margin:0;padding:0;background:transparent}"));
        assertTrue(style.contains("body{color:rgba(17,17,17,1.000);"));
        assertTrue(style.contains("a{color:rgba(0,102,204,1.000);"));
        assertTrue(style.contains(".m5h-badge--ok{background:rgba(17,136,51,0.180);color:rgba(17,136,51,1.000)}"));
        assertTrue(style.contains(".m5h-grid tbody tr:nth-child(even) td{background:rgba(238,238,238,0.600)}"));
        assertFalse(style.contains("url("));
        assertFalse(style.contains("<"));
        assertEquals("rgba(255,0,0,0.251)", FnHtmlView.css(0x80FF0000, 0.5));
    }

    /* ------------------------------------------------- Outputs, type html */

    @Test
    public void outputCheckSanitizesAndKeepsTheTitle() throws Exception {
        StringBuilder title = new StringBuilder();
        for (int i = 0; i < 305; i++) title.append('T');
        Outputs.Check c = Outputs.check(new JSONObject().put("type", "html").put("html", "<p onclick=x>Hi &amp; bye</p><script>1</script>").put("title", title.toString()));
        assertTrue(c.ok());
        OutputsTest.same("{\"type\":\"html\",\"html\":\"<p>Hi &amp; bye</p>\",\"title\":\"" + title.substring(0, 300) + "\"}", c.output);
        OutputsTest.same("{\"type\":\"html\",\"html\":\"\"}", Outputs.check(new JSONObject().put("type", "html").put("html", "").put("title", "")).output);
    }

    @Test
    public void outputCheckRefusesOversizeAndNonStrings() throws Exception {
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < FnHtml.MAX + 1; i++) big.append('x');
        Outputs.Check c = Outputs.check(new JSONObject().put("type", "html").put("html", big.toString()));
        assertFalse(c.ok());
        assertEquals("html: html must be a string (up to 2000000 characters)", c.reason);
        assertEquals("html: html must be a string (up to 2000000 characters)", Outputs.check(new JSONObject().put("type", "html").put("html", 5)).reason);
        assertFalse(Outputs.check(new JSONObject().put("type", "html")).ok());
        // A peer's message: no output larger than the message may carry.
        StringBuilder many = new StringBuilder();
        for (int i = 0; i < 120_000; i++) many.append("<b>x</b>");
        JSONArray peer = new JSONArray().put(new JSONObject().put("type", "html").put("html", many.toString())).put(new JSONObject().put("type", "html").put("html", "<i>ok</i>"));
        OutputsTest.same("[{\"type\":\"html\",\"html\":\"<i>ok</i>\"}]", Outputs.sanitize(peer));
    }

    @Test
    public void markdownOfHtmlIsItsText() throws Exception {
        JSONArray outputs = new JSONArray("[{\"type\":\"html\",\"title\":\"Card\",\"html\":\"<h4>Head</h4><table><tr><th>A</th><td>1</td></tr></table><p>x<br>y <img src=\\\"data:image/png;base64,AA==\\\" alt=\\\"pic\\\"></p>\"},{\"type\":\"text\",\"text\":\"after\"}]");
        assertEquals("**Card**\n\nHead\n\nA\t1\n\nx\ny [pic]\n\nafter", Outputs.toMarkdown(outputs));
    }
}
