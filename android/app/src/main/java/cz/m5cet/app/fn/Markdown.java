package cz.m5cet.app.fn;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.text.Layout;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextPaint;
import android.text.method.LinkMovementMethod;
import android.text.style.BackgroundColorSpan;
import android.text.style.ClickableSpan;
import android.text.style.LeadingMarginSpan;
import android.text.style.LineBackgroundSpan;
import android.text.style.QuoteSpan;
import android.text.style.RelativeSizeSpan;
import android.text.style.StrikethroughSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.view.View;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * Markdown drawn as styled text (components/Markdown.tsx): the tree of
 * MarkdownTree as spans — headings, bold, italic, strike-through, inline
 * code and code blocks, links (only https / http / mailto, opened by the
 * app), lists with their markers in the margin, quotes, rules, and tables as
 * monospace columns. For the chat, the assistant and function outputs.
 */
public final class Markdown {
    /** Opens a link someone tapped. */
    public interface Links { void open(String url); }

    private final Theme theme;
    private final Links links;
    private final SpannableStringBuilder sb = new SpannableStringBuilder();

    private Markdown(Theme theme, Links links) { this.theme = theme; this.links = links; }

    public static CharSequence render(String text, Theme theme, Links links) {
        Markdown md = new Markdown(theme, links);
        md.blocks(MarkdownTree.parse(text == null ? "" : text), false);
        return md.sb;
    }

    /** Shows Markdown in a TextView with its links tappable. */
    public static void show(TextView view, String text, Theme theme, Links links) {
        view.setText(render(text, theme, links));
        view.setMovementMethod(LinkMovementMethod.getInstance());
        view.setHighlightColor(Color.TRANSPARENT);
    }

    private void span(int start, Object... spans) {
        for (Object s : spans) sb.setSpan(s, start, sb.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
    }

    /** Between blocks: a new line, and half an empty one unless the blocks are an item's. */
    private void gap(boolean tight) {
        sb.append('\n');
        if (tight) return;
        int s = sb.length();
        sb.append('\n');
        span(s, new RelativeSizeSpan(0.5f));
    }

    private void blocks(List<MarkdownTree.Block> list, boolean tight) {
        for (int k = 0; k < list.size(); k++) {
            if (k > 0) gap(tight);
            block(list.get(k));
        }
    }

    private void block(MarkdownTree.Block b) {
        int s = sb.length();
        switch (b.t) {
            case "p": inline(b.inline); break;
            case "h":
                inline(b.inline);
                span(s, new TypefaceSpan(theme.typeface(true)), new RelativeSizeSpan(b.level <= 2 ? 1.2f : b.level == 3 ? 1.1f : 1f));
                break;
            case "code":
                sb.append(b.v.isEmpty() ? " " : b.v);
                span(s, new TypefaceSpan("monospace"), new RelativeSizeSpan(0.9f), new LineBackgroundSpan.Standard(theme.color("@surfaceVariant")), new LeadingMarginSpan.Standard(theme.dp(6)));
                break;
            case "quote":
                blocks(b.blocks, false);
                span(s, new QuoteSpan(theme.color("@border"), theme.dp(3), theme.dp(8)));
                break;
            case "hr":
                sb.append(' ');
                span(s, new Rule(theme.color("@border"), theme.dp(1)));
                break;
            case "list":
                for (int k = 0; k < b.items.size(); k++) {
                    if (k > 0) sb.append('\n');
                    int is = sb.length();
                    blocks(b.items.get(k), true);
                    if (sb.length() == is) sb.append(' ');
                    span(is, new Marker(b.ordered ? (b.start + k) + "." : "•", theme.dp(20), theme.color("@muted")));
                }
                break;
            case "table": table(b); break;
            default: break;
        }
    }

    private void inline(List<MarkdownTree.Inline> nodes) {
        for (MarkdownTree.Inline n : nodes) {
            int s = sb.length();
            switch (n.t) {
                case "text": sb.append(n.v); break;
                case "br": sb.append('\n'); break;
                case "code":
                    sb.append(n.v);
                    span(s, new TypefaceSpan("monospace"), new BackgroundColorSpan(theme.color("@surfaceVariant")));
                    break;
                case "strong": inline(n.c); span(s, new TypefaceSpan(theme.typeface(true))); break;
                case "em": inline(n.c); span(s, new StyleSpan(Typeface.ITALIC)); break;
                case "del": inline(n.c); span(s, new StrikethroughSpan()); break;
                case "link": inline(n.c); span(s, new Link(n.href, theme.color("@primary"), links)); break;
                default: break;
            }
        }
    }

    static String plain(List<MarkdownTree.Inline> nodes) {
        StringBuilder out = new StringBuilder();
        for (MarkdownTree.Inline n : nodes) {
            if (n.t.equals("text") || n.t.equals("code")) out.append(n.v);
            else if (n.t.equals("br")) out.append(' ');
            else out.append(plain(n.c));
        }
        return out.toString();
    }

    /** A table as monospace columns: the head in bold, a rule under it. */
    private void table(MarkdownTree.Block b) {
        List<List<String>> rows = new ArrayList<>();
        List<String> head = new ArrayList<>();
        for (List<MarkdownTree.Inline> c : b.head) head.add(plain(c));
        rows.add(head);
        for (List<List<MarkdownTree.Inline>> r : b.rows) {
            List<String> row = new ArrayList<>();
            for (List<MarkdownTree.Inline> c : r) row.add(plain(c));
            rows.add(row);
        }
        int s = sb.length();
        List<String> lines = Grid.lines(rows);
        for (int i = 0; i < lines.size(); i++) {
            if (i > 0) sb.append('\n');
            int ls = sb.length();
            sb.append(lines.get(i));
            if (i == 0) span(ls, new StyleSpan(Typeface.BOLD));
        }
        span(s, new TypefaceSpan("monospace"), new RelativeSizeSpan(0.9f));
    }

    /** A link the app opens (never a web view of its own). */
    private static final class Link extends ClickableSpan {
        private final String href;
        private final int color;
        private final Links links;

        Link(String href, int color, Links links) { this.href = href; this.color = color; this.links = links; }

        @Override public void onClick(View widget) { if (links != null) links.open(href); }

        @Override public void updateDrawState(TextPaint ds) {
            ds.setColor(color);
            ds.setUnderlineText(true);
        }
    }

    /** A list item's marker ("•", "3.") drawn in its margin, on its first line. */
    private static final class Marker implements LeadingMarginSpan {
        private final String mark;
        private final int width;
        private final int color;

        Marker(String mark, int width, int color) { this.mark = mark; this.width = width; this.color = color; }

        @Override public int getLeadingMargin(boolean first) { return width; }

        @Override public void drawLeadingMargin(Canvas c, Paint p, int x, int dir, int top, int baseline, int bottom, CharSequence text, int start, int end, boolean first, Layout layout) {
            if (!(text instanceof Spanned) || ((Spanned) text).getSpanStart(this) != start) return;
            int old = p.getColor();
            p.setColor(color);
            c.drawText(mark, x + (dir > 0 ? 0 : -width), baseline, p);
            p.setColor(old);
        }
    }

    /** A horizontal rule across the line. */
    private static final class Rule implements LineBackgroundSpan {
        private final int color;
        private final int height;

        Rule(int color, int height) { this.color = color; this.height = Math.max(1, height); }

        @Override public void drawBackground(Canvas c, Paint p, int left, int right, int top, int baseline, int bottom, CharSequence text, int start, int end, int line) {
            int old = p.getColor();
            p.setColor(color);
            float y = (top + bottom) / 2f;
            c.drawRect(left, y - height / 2f, right, y + height / 2f, p);
            p.setColor(old);
        }
    }
}
