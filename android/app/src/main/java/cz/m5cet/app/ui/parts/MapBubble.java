package cz.m5cet.app.ui.parts;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.util.TypedValue;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;
import cz.m5cet.app.ui.bubble.Kinds;
import cz.m5cet.app.ui.bubble.MapPolicy;
import cz.m5cet.app.ui.bubble.MapPreview;

/**
 * The map of a position (6.2): in the bubble of a position message, and in
 * the dialog behind a header position's pin. The operator's size, centred
 * on the point with the pin and "<sender>'s current position", the
 * coordinates under it when the policy says so; a tap opens the full map.
 * 6.7: in the bubble a tap opens the place sheet (PlaceSheet) first.
 */
final class MapBubble {
    private MapBubble() {}

    /** Messages whose map did not come lately (id → when): the text and the pin for a minute. */
    private static final Map<String, Long> failed = new ConcurrentHashMap<>();

    static boolean failedLately(ChatMessage m) {
        Long at = failed.get(m.id);
        return at != null && System.currentTimeMillis() - at < 60_000;
    }

    /** The policy when this message gets a map now, else null (the pin as before). */
    static MapPolicy policyFor(M5 app, ChatMessage m) {
        if (Kinds.position(m) == null || failedLately(m)) return null;
        return MapPolicy.usable(app);
    }

    /**
     * The map, at most maxWidth px wide (the operator's aspect kept);
     * onFail runs on the UI thread when no tile came. 6.7: a tap opens the
     * place sheet (its map, navigation and ride apps).
     */
    static View build(MainActivity a, Parts parts, ChatMessage m, MapPolicy p, int fg, int maxWidth, Runnable onFail) {
        return build(a, parts, m, p, fg, maxWidth, () -> parts.mapPreview(m), onFail);
    }

    /** The map with its own tap (onClick); the place sheet's map opens the full map. */
    static View build(MainActivity a, Parts parts, ChatMessage m, MapPolicy p, int fg, int maxWidth, Runnable onClick, Runnable onFail) {
        M5 app = a.app();
        JSONObject pos = Kinds.position(m);
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        if (pos == null) return col;
        double lat = pos.optDouble("lat"), lon = pos.optDouble("lon");
        long acc = pos.optLong("acc");
        int w = Math.min(Ui.dp(a, p.width), maxWidth);
        int h = Math.round(w * p.height / (float) p.width);
        ImageView iv = new ImageView(a);
        iv.setClipToOutline(true);
        iv.setBackground(Ui.shape(Ui.alpha(fg, 0.08f), Ui.dp(a, 12), 0, 0));
        iv.setScaleType(ImageView.ScaleType.CENTER);
        iv.setImageDrawable(Icons.drawable(a, "map-pin", Ui.dp(a, 26), Ui.alpha(fg, 0.45f)));
        String caption = !p.label ? "" : m.mine ? app.t("map.captionMine") : app.t("map.caption").replace("{name}", m.senderName);
        iv.setContentDescription(caption.isEmpty() ? app.t("msg.map") : caption);
        int captionBg = p.accent != 0 ? p.accent : Ui.color(a, "@primary", Color.BLUE);
        float scale = MapPreview.scale(p, a.getResources().getDisplayMetrics().density);
        MapPreview.Spec spec = new MapPreview.Spec(lat, lon, acc, caption, captionBg);
        Bitmap hit = MapPreview.cached(p, spec, scale);
        if (hit != null) show(iv, hit);
        else MapPreview.render(app, p, spec, scale, b -> {
            if (b != null) { show(iv, b); return; }
            failed.put(m.id, System.currentTimeMillis());
            if (onFail != null) onFail.run();
        });
        iv.setOnClickListener(v -> { if (onClick != null) onClick.run(); else parts.openMap(m); });
        col.addView(iv, new LinearLayout.LayoutParams(w, h));
        if (p.showCoords) {
            TextView t = new TextView(a);
            t.setText(String.format(Locale.ROOT, "%.5f, %.5f", lat, lon) + (acc > 0 ? " ± " + acc + " m" : ""));
            t.setTextColor(Ui.alpha(fg, 0.75f));
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
            t.setPadding(0, Ui.dp(a, 3), 0, 0);
            t.setTextIsSelectable(true);
            col.addView(t);
        }
        return col;
    }

    private static void show(ImageView iv, Bitmap b) {
        iv.setScaleType(ImageView.ScaleType.FIT_XY);
        iv.setImageBitmap(b);
    }
}
