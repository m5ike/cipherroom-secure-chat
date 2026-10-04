package cz.m5cet.app.fn;

import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.ByteArrayInputStream;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;

/**
 * A function's formatted HTML (6.6, m5.out.html; FnHtml.tsx on the web) in a
 * locked-down WebView: no JavaScript, no network, no files, no storage, no
 * windows. The HTML is sanitized again here (FnHtml — a room message may come
 * from any client) and shown in a page whose Content-Security-Policy allows
 * nothing but data: pictures and its own style; that style maps the report
 * classes (m5h-*) and plain document markup to the app's theme, on a
 * transparent background, so a report looks right in light and dark. Links
 * open outside the app (Host.openLink); a long press on a picture opens it
 * like an image output, anywhere else it is the message's own long press.
 *
 * Height: the WebView starts at a fixed height (the one it had before, or a
 * small placeholder) so it lays out and draws, and wraps its content once
 * the page is visible — as tall as the document, never scrolling inside the
 * bubble (a wide table scrolls sideways in its m5h-scroll box).
 *
 * Lifecycle: a WebView is heavy, so one exists only while the row is on
 * screen. Detached (scrolled away, the bubble rebuilt) it is destroyed a few
 * seconds later unless the row comes back first; attached again, a new one
 * loads the same page (kept as a string) at the height the last one had.
 */
final class FnHtmlView extends FrameLayout {
    /** Opens a picture of the document (a long press on it). */
    interface Picture { void open(String name, String mime, byte[] data); }

    /** How long a detached WebView is kept for its row to come back. */
    private static final long LINGER_MS = 3000;

    private final Theme theme;
    private final Consumer<String> openLink;
    private final Picture picture;
    private final Consumer<String> failed;
    private final Runnable destroy = this::destroyWeb;
    private String page;
    private String plain = "";
    private WebView web;
    private TextView fallback;
    private int height;
    private int restarts;
    private boolean released;

    FnHtmlView(Context c, Theme theme, String html, Consumer<String> openLink, Picture picture, Consumer<String> failed) {
        super(c);
        this.theme = theme;
        this.openLink = openLink;
        this.picture = picture;
        this.failed = failed;
        setMinimumHeight(theme.dp(40)); // while the page is made
        String style = style(new Palette(theme));
        // Up to 2 MB of markup: parsed off the main thread.
        Api.background(() -> {
            try {
                List<FnHtml.SafeNode> tree = FnHtml.parse(html);
                String doc = page(FnHtml.serialize(tree), style);
                String text = FnHtml.text(tree);
                main().post(() -> ready(doc, text));
            } catch (RuntimeException | OutOfMemoryError e) {
                main().post(() -> { if (!released) { failed.accept("the HTML could not be read (" + e.getClass().getSimpleName() + ")"); showFallback(); } });
            }
        });
    }

    /** The main thread's handler (made on first use, from any thread). */
    private static final class Main { static final Handler H = new Handler(Looper.getMainLooper()); }

    private static Handler main() { return Main.H; }

    private void ready(String doc, String text) {
        if (released) return;
        page = doc;
        plain = text;
        if (isAttachedToWindow()) ensureWeb();
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        // A WebView sized by its content would have no width to lay the page out in.
        if (MeasureSpec.getMode(widthSpec) == MeasureSpec.UNSPECIFIED) widthSpec = MeasureSpec.makeMeasureSpec(theme.dp(300), MeasureSpec.AT_MOST);
        super.onMeasure(widthSpec, heightSpec);
    }

    @Override protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        ensureWeb();
    }

    @Override protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        // A list keeps a row it scrolled away for a while; if it comes back soon, so does this WebView.
        main().removeCallbacks(destroy);
        if (web != null) main().postDelayed(destroy, LINGER_MS);
    }

    /** Lets go of the WebView for good (the outputs were replaced). */
    void release() {
        released = true;
        destroyWeb();
    }

    private void ensureWeb() {
        main().removeCallbacks(destroy);
        if (web != null || page == null || released || fallback != null) return;
        WebView w;
        try {
            w = makeWeb();
        } catch (RuntimeException e) {
            // No WebView on this device right now (missing, being updated): the text instead.
            showFallback();
            return;
        }
        web = w;
        setMinimumHeight(0);
        addView(w, new LayoutParams(LayoutParams.MATCH_PARENT, height > 0 ? height : theme.dp(48)));
        w.loadDataWithBaseURL(null, page, "text/html", "utf-8", null);
    }

    private void destroyWeb() {
        main().removeCallbacks(destroy);
        WebView w = web;
        if (w == null) return;
        web = null;
        if (w.getHeight() > 0) height = w.getHeight();
        if (!released) setMinimumHeight(height); // keeps its place in the list until a new one draws
        removeView(w);
        w.stopLoading();
        w.destroy();
    }

    private void showFallback() {
        if (fallback != null || released) return;
        destroyWeb();
        setMinimumHeight(0);
        TextView t = new TextView(getContext());
        t.setText(plain);
        t.setTextColor(theme.color("@onSurface"));
        t.setTypeface(theme.typeface(false));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        fallback = t;
        addView(t, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));
    }

    private WebView makeWeb() {
        WebView w = new WebView(getContext());
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setBlockNetworkLoads(true);
        s.setBlockNetworkImage(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setGeolocationEnabled(false);
        s.setDomStorageEnabled(false);
        s.setDatabaseEnabled(false);
        s.setSaveFormData(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setUseWideViewPort(false);
        s.setLoadWithOverviewMode(false);
        // CSS pixels are dp; the text follows the system font size like the app's sp.
        s.setTextZoom(Math.round(getResources().getConfiguration().fontScale * 100));
        // The page has its own colours for light and dark.
        if (Build.VERSION.SDK_INT >= 33) s.setAlgorithmicDarkeningAllowed(false);
        else s.setForceDark(WebSettings.FORCE_DARK_OFF);
        w.setBackgroundColor(Color.TRANSPARENT);
        w.setVerticalScrollBarEnabled(false);
        w.setOverScrollMode(OVER_SCROLL_NEVER);
        // Taking focus on load would make the list jump to it.
        w.setFocusableInTouchMode(false);
        w.setWebViewClient(new Client());
        w.setOnLongClickListener(this::longPress);
        w.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            ViewGroup.LayoutParams lp = v.getLayoutParams();
            if (v == web && lp != null && lp.height == LayoutParams.WRAP_CONTENT && b - t > 0) height = b - t;
        });
        return w;
    }

    /** The page is drawn: from now on the WebView is as tall as the document. */
    private void wrap(WebView w) {
        if (w != web) return;
        ViewGroup.LayoutParams lp = w.getLayoutParams();
        if (lp == null || lp.height == LayoutParams.WRAP_CONTENT) return;
        lp.height = LayoutParams.WRAP_CONTENT;
        w.setLayoutParams(lp);
        // Should a WebView not measure its content, the document's height in dp is set instead.
        w.postDelayed(() -> {
            if (w != web || w.getHeight() > 0 || w.getContentHeight() <= 0) return;
            ViewGroup.LayoutParams p = w.getLayoutParams();
            p.height = Math.round(w.getContentHeight() * getResources().getDisplayMetrics().density);
            w.setLayoutParams(p);
        }, 400);
    }

    /** A picture opens like an image output; anywhere else it is the message's long press (its menu). */
    private boolean longPress(View v) {
        WebView.HitTestResult hit = v instanceof WebView ? ((WebView) v).getHitTestResult() : null;
        if (hit != null && hit.getType() == WebView.HitTestResult.IMAGE_TYPE && hit.getExtra() != null) {
            String src = hit.getExtra();
            int comma = src.indexOf(',');
            if (FnHtml.imageSrc(src) && comma > 0) {
                String mime = src.substring(5, src.indexOf(';'));
                try {
                    picture.open("image." + mime.substring(6).replace("jpeg", "jpg"), mime, FnView.decode(src.substring(comma + 1)));
                    return true;
                } catch (IllegalArgumentException ignored) { }
            }
        }
        for (ViewParent p = getParent(); p instanceof View; p = p.getParent()) {
            if (((View) p).isLongClickable()) return ((View) p).performLongClick();
        }
        return true; // no text selection either way
    }

    private final class Client extends WebViewClient {
        /** Nothing navigates in place: a tapped http(s) / mailto link opens outside the app. */
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String scheme = u == null || u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            if (request.hasGesture() && (scheme.equals("https") || scheme.equals("http") || scheme.equals("mailto"))) openLink.accept(u.toString());
            return true;
        }

        /** Only the page's own data: pictures load; anything else gets an empty answer. */
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            String scheme = u == null || u.getScheme() == null ? "" : u.getScheme().toLowerCase(Locale.ROOT);
            if (scheme.equals("data") || scheme.equals("about")) return null;
            return new WebResourceResponse("text/plain", "utf-8", 204, "No Content", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }

        @Override public void onPageCommitVisible(WebView view, String url) { wrap(view); }

        @Override public void onPageFinished(WebView view, String url) { wrap(view); }

        /** The renderer crashed or was stopped for memory: this WebView is gone (the app goes on). */
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (view != web) return true; // one let go of already
            destroyWeb();
            if (detail.didCrash() || ++restarts > 2) {
                if (detail.didCrash()) failed.accept("the HTML could not be shown (the page crashed)");
                showFallback();
            } else if (isAttachedToWindow()) {
                main().post(FnHtmlView.this::ensureWeb);
            }
            return true;
        }
    }

    /* -------------------------------------------------------------- page */

    /** The theme's colours the page uses (ARGB). */
    static final class Palette {
        final int ink, muted, panel, border, link, ok, err, warn;

        Palette(int ink, int muted, int panel, int border, int link, int ok, int err, int warn) {
            this.ink = ink; this.muted = muted; this.panel = panel; this.border = border; this.link = link; this.ok = ok; this.err = err; this.warn = warn;
        }

        Palette(Theme t) {
            this(t.color("@onSurface"), t.color("@muted"), t.color("@surfaceVariant"), t.color("@border"), t.color("@primary"),
                t.color("@success"), t.color("@danger"), t.color("@warning"));
        }
    }

    /** A colour as CSS: rgba(r,g,b,a), with its alpha times a. */
    static String css(int argb, double a) {
        double alpha = ((argb >>> 24) & 0xFF) / 255.0 * a;
        return String.format(Locale.ROOT, "rgba(%d,%d,%d,%.3f)", (argb >> 16) & 0xFF, (argb >> 8) & 0xFF, argb & 0xFF, alpha);
    }

    static String css(int argb) { return css(argb, 1); }

    /** The page's style: fn.css (.fn-html__body and the m5h-* classes) in the theme's colours; 1rem = 16px, sizes in CSS px (dp). */
    static String style(Palette p) {
        String ink = css(p.ink), muted = css(p.muted), panel = css(p.panel), border = css(p.border), link = css(p.link);
        return "html,body{margin:0;padding:0;background:transparent}"
            + "body{color:" + ink + ";font:14px/1.45 sans-serif;overflow-wrap:anywhere;-webkit-text-size-adjust:none;-webkit-tap-highlight-color:transparent}"
            + ".fn-html__body{display:flow-root}"
            + "h1,h2,h3,h4,h5,h6{margin:9.6px 0 4.8px;line-height:1.25}"
            + "h1{font-size:20px}h2{font-size:17.9px}h3,h4{font-size:15.7px}h5,h6{font-size:14.4px}"
            + "p{margin:4.8px 0}ul,ol{margin:4.8px 0;padding-left:20.8px}"
            + "table{border-collapse:collapse;font-size:13.4px}th,td{padding:3.2px 8px;vertical-align:top;text-align:left}"
            + "pre,code,kbd,samp{font-family:monospace;font-size:12.8px}"
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
            + ".m5h-kv--mono td,.m5h-mono,.m5h-pre{font-family:monospace;font-size:12.5px}"
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
            + ".m5h-files{margin:0;padding-left:17.6px}";
    }

    /** The document the WebView loads: safe markup (FnHtml.serialize) under a CSP that allows only data: pictures and this style. */
    static String page(String safeHtml, String style) {
        return "<!doctype html><html><head><meta charset=\"utf-8\">"
            + "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">"
            + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            + "<style>" + style + "</style></head><body><div class=\"fn-html__body\">" + safeHtml + "</div></body></html>";
    }
}
