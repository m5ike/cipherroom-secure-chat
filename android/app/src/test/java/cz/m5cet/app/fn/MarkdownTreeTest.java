package cz.m5cet.app.fn;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Markdown parsing (client/src/lib/markdown.ts) — the cases of test/markdown.test.tsx. */
public class MarkdownTreeTest {
    @Test
    public void blocks() {
        String md = String.join("\n",
            "# Nadpis", "", "Odstavec s **tučným**, *kurzívou* a `kódem`.", "Druhý řádek.", "",
            "- jedna", "- dvě", "  - vnořená", "", "3. tři", "4. čtyři", "", "```ts", "const x = 1;", "```", "", "> citace", "", "---", "",
            "| a | b |", "|---|:-:|", "| 1 | 2 |");
        List<MarkdownTree.Block> blocks = MarkdownTree.parse(md);
        List<String> types = new ArrayList<>();
        for (MarkdownTree.Block b : blocks) types.add(b.t);
        assertEquals(Arrays.asList("h", "p", "list", "list", "code", "quote", "hr", "table"), types);
        assertEquals("h1[text(Nadpis)]", blocks.get(0).toString());
        assertEquals("p[text(Odstavec s ), strong[text(tučným)], text(, ), em[text(kurzívou)], text( a ), code(kódem), text(.), br, text(Druhý řádek.)]", blocks.get(1).toString());
        assertEquals("ul[[p[text(jedna)]], [p[text(dvě)], ul[[p[text(vnořená)]]]]]", blocks.get(2).toString());
        assertEquals("ol3[[p[text(tři)]], [p[text(čtyři)]]]", blocks.get(3).toString());
        assertEquals("code(ts)(const x = 1;)", blocks.get(4).toString());
        assertEquals("quote[p[text(citace)]]", blocks.get(5).toString());
        assertEquals("table[[text(a)], [text(b)]][[[text(1)], [text(2)]]]", blocks.get(7).toString());
    }

    private static void inline(String src, String expected) {
        assertEquals(src, expected, MarkdownTree.parseInline(src).toString());
    }

    @Test
    public void inlineMarks() {
        inline("a `**not bold**` b", "[text(a ), code(**not bold**), text( b)]");
        inline("~~staré~~ __nové__ _jemně_", "[del[text(staré)], text( ), strong[text(nové)], text( ), em[text(jemně)]]");
        inline("some_snake_case_name", "[text(some_snake_case_name)]");
        inline("viz https://example.org/a_(b). Konec", "[text(viz ), link(https://example.org/a_(b))[text(https://example.org/a_(b))], text(. Konec)]");
        inline("\\*ne\\*", "[text(*ne*)]");
        inline("[M5cet](https://chat.fir.ma \"titulek\")", "[link(https://chat.fir.ma)[text(M5cet)]]");
        inline("`` a`b ``", "[code(a`b)]");
        inline("<https://x.cz/a> a <b>", "[link(https://x.cz/a)[text(https://x.cz/a)], text( a <b>)]");
        inline("ahttps://x.cz", "[text(ahttps://x.cz)]");
    }

    @Test
    public void halfWrittenAnswers() {
        assertEquals("[p[text(Tady:)], code(py)(print(1)\nprint(2)]", MarkdownTree.parse("Tady:\n```py\nprint(1)\nprint(2").toString());
        assertEquals("[p[text(**nedokonč)]]", MarkdownTree.parse("**nedokonč").toString());
        assertEquals("[p[text(a), br, text(b)]]", MarkdownTree.parse("a\r\nb").toString());
    }

    @Test
    public void linksOnlyToWebAndMail() {
        assertNull(MarkdownTree.safeHref("javascript:alert(1)"));
        assertNull(MarkdownTree.safeHref(" JAVASCRIPT:alert(1)"));
        assertNull(MarkdownTree.safeHref("data:text/html,<b>x</b>"));
        assertNull(MarkdownTree.safeHref("vbscript:x"));
        assertNull(MarkdownTree.safeHref("//evil.example"));
        assertEquals("https://ok.example/a?b=1", MarkdownTree.safeHref("https://ok.example/a?b=1"));
        assertEquals("mailto:a@b.cz", MarkdownTree.safeHref("mailto:a@b.cz"));
        inline("[klikni](javascript:alert(1))", "[text(klikni), text())]");
    }

    @Test
    public void rulesAndTableRowsWrittenOut() {
        assertTrue(MarkdownTree.isRule("---"));
        assertTrue(MarkdownTree.isRule("   * * *  "));
        assertTrue(!MarkdownTree.isRule("    ---") && !MarkdownTree.isRule("--") && !MarkdownTree.isRule("-*-"));
        assertTrue(MarkdownTree.isTableSeparator("|---|:-:|"));
        assertTrue(MarkdownTree.isTableSeparator(" :--- | ---: "));
        assertTrue(MarkdownTree.isTableSeparator("|-|"));
        assertTrue(!MarkdownTree.isTableSeparator("|a|") && !MarkdownTree.isTableSeparator("| : - |") && !MarkdownTree.isTableSeparator("||"));
        StringBuilder huge = new StringBuilder();
        for (int i = 0; i < 100_000; i++) huge.append("|-");
        assertTrue(MarkdownTree.isTableSeparator(huge.toString()));
    }

    @Test
    public void deepNestingAndHugeInputEnd() {
        MarkdownTree.parse("> ".repeat(200) + "x");
        String stars = "*".repeat(20_000);
        long started = System.currentTimeMillis();
        MarkdownTree.parse(stars + " x " + stars);
        assertTrue(System.currentTimeMillis() - started < 5000);
    }

    @Test
    public void tablesAsMonospaceColumns() {
        List<List<String>> rows = Arrays.asList(Arrays.asList("a", "bb"), Arrays.asList("ccc", "d"), Arrays.asList("e"));
        assertEquals(Arrays.asList("a   │ bb", "────┼───", "ccc │ d", "e   │ "), Grid.lines(rows));
        assertEquals("text(a b)", MarkdownTree.Inline.text("a b").toString());
        assertEquals("a b", Markdown.plain(MarkdownTree.parseInline("a\nb")));
    }
}
