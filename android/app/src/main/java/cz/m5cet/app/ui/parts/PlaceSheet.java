package cz.m5cet.app.ui.parts;

import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.location.GeoLinks;
import cz.m5cet.app.ui.Icons;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;
import cz.m5cet.app.ui.bubble.Kinds;
import cz.m5cet.app.ui.bubble.MapPolicy;
import cz.m5cet.app.ui.look.Look;

/**
 * The place of a message (6.7): the map (when the operator has maps on),
 * the coordinates, and the same three actions as the web's place window,
 * in the same order — Navigate, Ride, Copy. Navigate offers the navigation
 * apps on this phone (the known ones with their own links, then every
 * other app that opens geo:), then the web; Ride the ride-hailing apps
 * (Uber with the destination; Bolt, Liftago, FREENOW open and get it from
 * the clipboard), then the web. The links are GeoLinks' table; nothing is
 * opened until a line is tapped.
 */
final class PlaceSheet {
    private PlaceSheet() {}

    static void show(MainActivity a, Parts parts, ChatMessage m) {
        JSONObject pos = Kinds.position(m);
        if (pos == null) return;
        M5 app = a.app();
        double lat = pos.optDouble("lat"), lon = pos.optDouble("lon");
        long acc = pos.optLong("acc");
        int fg = Ui.color(a, "@onSurface", Color.BLACK);
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(Ui.dp(a, 20), Ui.dp(a, 8), Ui.dp(a, 20), 0);
        AlertDialog[] shown = new AlertDialog[1];
        MapPolicy p = MapBubble.policyFor(app, m);
        if (p != null) {
            // A tap on the map: the full map (the phone's map app); no tile: the placeholder pin stays, the actions work.
            box.addView(MapBubble.build(a, parts, m, p, fg, a.getResources().getDisplayMetrics().widthPixels - Ui.dp(a, 88), () -> {
                if (shown[0] != null) shown[0].dismiss();
                parts.openMap(m);
            }, null));
        }
        if (p == null || !p.showCoords) {
            TextView coords = new TextView(a);
            coords.setText(String.format(Locale.ROOT, "%.5f, %.5f", lat, lon) + (acc > 0 ? " ± " + acc + " m" : ""));
            coords.setTextColor(Ui.alpha(fg, 0.8f));
            coords.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
            coords.setTextIsSelectable(true);
            coords.setPadding(0, Ui.dp(a, 4), 0, 0);
            box.addView(coords);
        }
        // The label goes along only with apps that show one (Uber's nickname, the geo: pin): the sender's name, never mine.
        String label = m.mine ? "" : m.senderName;
        LinearLayout acts = new LinearLayout(a);
        acts.setOrientation(LinearLayout.HORIZONTAL);
        acts.setPadding(0, Ui.dp(a, 12), 0, Ui.dp(a, 4));
        acts.addView(action(a, "navigation", app.t("loc.navigate"), fg, v -> pick(a, GeoLinks.NAV, lat, lon, label)));
        acts.addView(action(a, "hand", app.t("loc.ride"), fg, v -> pick(a, GeoLinks.RIDE, lat, lon, label)));
        acts.addView(action(a, "copy", app.t("loc.copy"), fg, v -> { a.copy(GeoLinks.destinationText(lat, lon)); a.flash("", "✓ " + app.t("loc.copy"), "success"); }));
        box.addView(acts);
        TextView note = new TextView(a);
        note.setText(app.t("loc.privacy"));
        note.setTextColor(Ui.alpha(fg, 0.6f));
        note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        note.setPadding(0, Ui.dp(a, 6), 0, 0);
        box.addView(note);
        String title = m.mine ? app.t("map.captionMine") : app.t("map.caption").replace("{name}", m.senderName);
        shown[0] = parts.secureDialog(new AlertDialog.Builder(a).setTitle(title).setView(box)
            .setPositiveButton(app.t("map.open"), (d, w) -> parts.openMap(m))
            .setNegativeButton(app.t("nav.close"), null));
    }

    /** One of the three: its icon over its label, the whole a pressable tile. */
    private static View action(MainActivity a, String icon, String label, int fg, View.OnClickListener click) {
        LinearLayout b = new LinearLayout(a);
        b.setOrientation(LinearLayout.VERTICAL);
        b.setGravity(Gravity.CENTER);
        b.setPadding(Ui.dp(a, 6), Ui.dp(a, 10), Ui.dp(a, 6), Ui.dp(a, 10));
        int accent = Ui.color(a, "@primary", Color.BLUE);
        b.setBackground(Ui.ripple(Ui.shape(Color.TRANSPARENT, Ui.dp(a, 14), Ui.dp(a, 1), Ui.alpha(fg, 0.18f)), Ui.alpha(fg, 0.14f)));
        ImageView ic = new ImageView(a);
        ic.setImageDrawable(Icons.drawable(a, icon, Ui.dp(a, 22), accent));
        b.addView(ic);
        TextView t = new TextView(a);
        t.setText(label);
        t.setTextColor(fg);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, Ui.dp(a, 4), 0, 0);
        b.addView(t);
        b.setContentDescription(label);
        b.setOnClickListener(v -> { Look.haptic(v, false); click.onClick(v); });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        lp.setMargins(Ui.dp(a, 3), 0, Ui.dp(a, 3), 0);
        b.setLayoutParams(lp);
        return b;
    }

    /* ---------------------------------------------------------- pickers */

    /** The known apps' packages that are here (the manifest's <queries> makes them visible). */
    private static Set<String> installed(PackageManager pm) {
        Set<String> here = new HashSet<>();
        for (String p : GeoLinks.packages()) {
            try { pm.getPackageInfo(p, 0); here.add(p); } catch (PackageManager.NameNotFoundException ignored) { }
        }
        return here;
    }

    /** Every other app that opens geo: (package → its name), this app left out. */
    @SuppressWarnings("deprecation")
    private static Map<String, String> geoApps(MainActivity a, PackageManager pm, String geo) {
        Map<String, String> out = new LinkedHashMap<>();
        List<ResolveInfo> found = pm.queryIntentActivities(new Intent(Intent.ACTION_VIEW, Uri.parse(geo)), PackageManager.MATCH_DEFAULT_ONLY);
        for (ResolveInfo r : found) {
            String pkg = r.activityInfo == null ? null : r.activityInfo.packageName;
            if (pkg == null || pkg.equals(a.getPackageName()) || out.containsKey(pkg)) continue;
            out.put(pkg, String.valueOf(r.loadLabel(pm)));
        }
        return out;
    }

    private static void pick(MainActivity a, String kind, double lat, double lon, String label) {
        M5 app = a.app();
        PackageManager pm = a.getPackageManager();
        List<GeoLinks.Choice> list = GeoLinks.choices(kind, lat, lon, label, installed(pm),
            GeoLinks.NAV.equals(kind) ? geoApps(a, pm, GeoLinks.geoUri(lat, lon, label)) : null);
        if (list.isEmpty()) { a.flash("", app.t("file.noApp"), "warn"); return; }
        int fg = Ui.color(a, "@onSurface", Color.BLACK);
        BaseAdapter adapter = new BaseAdapter() {
            @Override public int getCount() { return list.size(); }
            @Override public Object getItem(int i) { return list.get(i); }
            @Override public long getItemId(int i) { return i; }
            @Override public View getView(int i, View reuse, ViewGroup parent) { return line(a, pm, list.get(i), fg); }
        };
        String title = app.t(GeoLinks.NAV.equals(kind) ? "loc.navigateWith" : "loc.rideWith");
        AlertDialog.Builder b = new AlertDialog.Builder(a).setTitle(title).setAdapter(adapter, (d, w) -> open(a, list.get(w), lat, lon))
            .setNegativeButton(app.t("nav.close"), null);
        AlertDialog d = b.create();
        if ((a.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE) != 0 && d.getWindow() != null)
            d.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
        d.show();
    }

    /** A picker line: the app's own icon (or a globe for the web), its name, and what happens. */
    private static View line(MainActivity a, PackageManager pm, GeoLinks.Choice c, int fg) {
        M5 app = a.app();
        LinearLayout row = new LinearLayout(a);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(Ui.dp(a, 22), Ui.dp(a, 10), Ui.dp(a, 22), Ui.dp(a, 10));
        ImageView ic = new ImageView(a);
        Drawable d = null;
        if (c.pkg != null) try { d = pm.getApplicationIcon(c.pkg); } catch (PackageManager.NameNotFoundException ignored) { }
        ic.setImageDrawable(d != null ? d : Icons.drawable(a, c.web ? "globe" : "map", Ui.dp(a, 24), Ui.alpha(fg, 0.7f)));
        row.addView(ic, new LinearLayout.LayoutParams(Ui.dp(a, 32), Ui.dp(a, 32)));
        LinearLayout col = new LinearLayout(a);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(Ui.dp(a, 14), 0, 0, 0);
        TextView name = new TextView(a);
        name.setText(c.name);
        name.setTextColor(fg);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f);
        col.addView(name);
        String sub = c.web ? app.t("loc.inBrowser") : "";
        if (!c.prefill) sub = (sub.isEmpty() ? "" : sub + " · ") + app.t("loc.ride.paste");
        if (!sub.isEmpty()) {
            TextView s = new TextView(a);
            s.setText(sub);
            s.setTextColor(Ui.alpha(fg, 0.65f));
            s.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
            col.addView(s);
        }
        row.addView(col, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    /** Opens a choice: in its app (its link, else geo:, else just the app), or in the browser. */
    private static void open(MainActivity a, GeoLinks.Choice c, double lat, double lon) {
        M5 app = a.app();
        if (!c.prefill) { a.copy(GeoLinks.destinationText(lat, lon)); a.flash("", app.t("loc.copied"), "info"); }
        if (c.web) { a.openUrl(c.uri); return; }
        PackageManager pm = a.getPackageManager();
        String[] tries = { c.uri, c.fallback };
        for (String uri : tries) {
            if (uri == null) continue;
            try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(uri)).setPackage(c.pkg)); return; }
            catch (ActivityNotFoundException | SecurityException ignored) { /* the next way in */ }
        }
        Intent launch = c.pkg == null ? null : pm.getLaunchIntentForPackage(c.pkg);
        if (launch != null) { a.startActivity(launch); return; }
        a.flash("", app.t("file.noApp"), "warn");
    }
}
