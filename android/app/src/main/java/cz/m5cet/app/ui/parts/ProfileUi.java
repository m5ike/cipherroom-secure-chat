package cz.m5cet.app.ui.parts;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.text.InputType;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.profile.ProfileCard;
import cz.m5cet.app.profile.ProfileImages;
import cz.m5cet.app.profile.Profiles;
import cz.m5cet.app.profile.WhoSees;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Ui;

/**
 * 6.7: the profile on screen (server/android/design-67-profile.ts) — the
 * editor's actions and its $profile, the field dialog, the pictures picked
 * for it, and what the People widget and a person's detail show of the
 * profiles members share. The model and the rules are in cz.m5cet.app.profile.
 *
 * 6.10: who sees what — the editor's summary ($profile.whoSees) and each
 * field's audience chip (profile.audience, a menu of the three), the card
 * on top of Settings ($myProfile), and a sender's sheet ($form.sender: what
 * they share with the room, from a tap on their avatar).
 */
public final class ProfileUi {
    private ProfileUi() {}

    public static final int PICK_AVATAR = 7305, PICK_COVER = 7306;

    /** The editor's working copy (null until the card is open), and the card as last saved. */
    private static JSONObject draft;
    private static String saved = "";
    private static boolean busy;
    private static String msg = "";
    private static WeakReference<MainActivity> shown = new WeakReference<>(null);

    private static final String[] AUDIENCES = { "me", "room", "public" };

    /** profile.* actions (Actions.run). */
    public static void run(MainActivity a, String action, String arg) {
        M5 app = a.app();
        Profiles profiles = Profiles.of(app);
        listen(a, profiles);
        switch (action) {
            case "profile.open":
                // 6.10: also from a sheet (my own detail, my own avatar): the sheet goes first.
                a.parts.closeOverlay();
                draft = null;
                msg = "";
                edit(a, profiles.card());
                a.showScreen("settings.profile", true);
                break;
            case "profile.pick":
                a.startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*"), "cover".equals(arg) ? PICK_COVER : PICK_AVATAR);
                break;
            case "profile.clear":
                sync(a);
                image("cover".equals(arg) ? "cover" : "avatar", "");
                a.refresh();
                break;
            case "profile.field": sync(a); fieldDialog(a, arg); break;
            case "profile.sync": sync(a); a.refresh(); break;
            case "profile.save": save(a, profiles); break;
            case "profile.public": profiles.fetchPublic(arg, a::refresh); a.refresh(); break;
            default: Log.w("profile", "unknown action " + action);
        }
    }

    /** The card opened (or was dropped): an editor waiting for it starts, the screen draws again. */
    private static void listen(MainActivity a, Profiles profiles) {
        shown = new WeakReference<>(a);
        profiles.onChange(() -> {
            MainActivity m = shown.get();
            if (m == null) return;
            if ("settings.profile".equals(m.screen()) && draft == null && profiles.card() != null) {
                edit(m, profiles.card());
                m.showScreen("settings.profile", false); // the inputs take their first values when built
            } else {
                m.refresh();
            }
        });
    }

    /** Starts editing `card` (null: not open yet): the form's fields get its values. */
    private static void edit(MainActivity a, JSONObject card) {
        if (card == null) return;
        draft = ProfileCard.normalize(card);
        saved = draft.toString();
        Map<String, Object> form = a.form();
        JSONObject nick = draft.optJSONObject("nickname"), about = draft.optJSONObject("about");
        form.put("pfNick", nick.optString("value"));
        form.put("pfNickAud", nick.optString("audience"));
        form.put("pfAbout", about.optString("value"));
        form.put("pfAboutAud", about.optString("audience"));
        form.put("pfAvatarAud", draft.optJSONObject("avatar").optString("audience"));
        form.put("pfCoverAud", draft.optJSONObject("cover").optString("audience"));
        form.put("pfPreview", "room");
    }

    private static String formText(Map<String, Object> form, String key) { Object v = form.get(key); return v == null ? "" : String.valueOf(v); }

    /** The form's values (typed or switched) into the working copy. */
    private static void sync(MainActivity a) {
        if (draft == null) return;
        Map<String, Object> form = a.form();
        try {
            put("nickname", "value", formText(form, "pfNick"));
            put("about", "value", formText(form, "pfAbout"));
            for (String[] k : new String[][] { { "nickname", "pfNickAud" }, { "about", "pfAboutAud" }, { "avatar", "pfAvatarAud" }, { "cover", "pfCoverAud" } }) {
                String aud = formText(form, k[1]);
                if (ProfileCard.isAudience(aud)) put(k[0], "audience", aud);
            }
        } catch (JSONException ignored) { }
    }

    private static void put(String item, String key, String value) throws JSONException { draft.getJSONObject(item).put(key, value); }

    private static void image(String kind, String dataUrl) {
        if (draft == null) return;
        try { put(kind, "value", dataUrl); } catch (JSONException ignored) { }
    }

    /** A picked picture (MainActivity.onActivityResult): re-encoded without metadata, in the background. */
    public static void picked(MainActivity a, String kind, Uri uri) {
        M5 app = a.app();
        Io.bg(() -> {
            try {
                String url = ProfileImages.encode(a.getContentResolver(), uri, kind);
                Io.main(() -> { sync(a); image(kind, url); a.refresh(); });
            } catch (IOException | RuntimeException e) {
                Log.w("profile", "picture: " + e.getMessage());
                String key = "image-too-large".equals(e.getMessage()) ? "pf.err.imageLarge" : "pf.err.image";
                Io.main(() -> a.flash("", app.t(key), "error"));
            }
        });
    }

    private static void save(MainActivity a, Profiles profiles) {
        if (draft == null || busy) return;
        sync(a);
        busy = true;
        msg = "";
        a.refresh();
        JSONObject toSave = ProfileCard.normalize(draft);
        M5 app = a.app();
        Io.bg(() -> {
            try {
                Profiles.Saved s = profiles.save(toSave);
                Io.main(() -> {
                    busy = false;
                    draft = ProfileCard.normalize(s.card);
                    saved = draft.toString();
                    msg = !s.publicError.isEmpty() ? app.t("pf.saved.publicFailed") + " " + s.publicError
                        : app.t("published".equals(s.outcome) ? "pf.saved.published" : "withdrawn".equals(s.outcome) ? "pf.saved.withdrawn" : "pf.saved");
                    a.refresh();
                });
            } catch (IOException | RuntimeException e) {
                Io.main(() -> { busy = false; msg = e.getMessage() == null ? app.t("pf.loadFailed") : e.getMessage(); a.refresh(); });
            }
        });
    }

    /** $profile of settings.profile (MainActivity.scopeFor). */
    public static JSONObject scope(MainActivity a) {
        M5 app = a.app();
        Profiles profiles = Profiles.of(app);
        listen(a, profiles);
        JSONObject card = profiles.card();
        if (draft == null && card != null) edit(a, card);
        if (card == null && !app.account.signedIn()) draft = null;
        sync(a);
        JSONObject o = new JSONObject();
        try {
            o.put("signedIn", app.account.signedIn()).put("ready", draft != null).put("loading", profiles.loading()).put("error", profiles.error())
                .put("busy", busy).put("msg", msg);
            if (draft == null) return o;
            String avatar = draft.getJSONObject("avatar").optString("value"), cover = draft.getJSONObject("cover").optString("value");
            String nick = draft.getJSONObject("nickname").optString("value");
            String who = nick.isEmpty() ? app.accountName() : nick;
            o.put("dirty", !ProfileCard.normalize(draft).toString().equals(saved))
                .put("avatar", avatar).put("cover", cover).put("hasAvatar", !avatar.isEmpty()).put("hasCover", !cover.isEmpty())
                .put("initials", who.isEmpty() ? "?" : who);
            JSONArray fields = new JSONArray();
            JSONArray in = draft.getJSONArray("fields");
            for (int i = 0; i < in.length(); i++) {
                JSONObject f = in.getJSONObject(i);
                String type = f.optString("type"), value = f.optString("value");
                fields.put(new JSONObject().put("index", (double) i).put("type", type).put("typeLabel", app.t("pf.type." + type)).put("icon", Profiles.icon(type))
                    .put("label", f.optString("label")).put("value", value).put("audience", f.optString("audience")).put("audIcon", Profiles.audienceIcon(f.optString("audience")))
                    .put("audLabel", audienceLabel(app, f.optString("audience"))) // 6.10: the field's audience chip
                    .put("invalid", !value.trim().isEmpty() && ProfileCard.cleanValue(type, value).isEmpty()));
            }
            o.put("fields", fields).put("canAdd", in.length() < ProfileCard.FIELDS);
            // 6.10: who sees what, by name — as the draft stands now.
            JSONObject sees = WhoSees.summary(draft);
            o.put("whoSees", new JSONObject().put("public", named(app, draft, sees.optJSONArray("public")))
                .put("room", named(app, draft, sees.optJSONArray("room"))).put("me", named(app, draft, sees.optJSONArray("me"))));
            String aud = formText(a.form(), "pfPreview");
            JSONObject preview = labelled(app, Profiles.drawn(ProfileCard.viewFor(draft, ProfileCard.isAudience(aud) ? aud : "room")));
            if (preview == null) preview = new JSONObject();
            o.put("preview", preview.put("empty", ProfileCard.isEmptyView(preview)));
        } catch (JSONException ignored) { }
        return o;
    }

    /* ------------------------------------------- 6.10 who sees what */

    /** An audience's name as a chip says it (room members short). */
    private static String audienceLabel(M5 app, String audience) {
        String a = ProfileCard.isAudience(audience) ? audience : "me";
        return app.t("pf.aud." + a + ("room".equals(a) ? ".short" : ""));
    }

    /** {count, text}: how many items, and their names ("nothing" for none). */
    private static JSONObject named(M5 app, JSONObject card, JSONArray keys) throws JSONException {
        List<String> names = new ArrayList<>();
        JSONArray fields = card.optJSONArray("fields");
        for (int i = 0; keys != null && i < keys.length(); i++) {
            String k = keys.optString(i);
            if (k.startsWith("field:")) {
                JSONObject f = fields == null ? null : fields.optJSONObject(Integer.parseInt(k.substring(6)));
                if (f != null) names.add(f.optString("label").isEmpty() ? app.t("pf.type." + f.optString("type")) : f.optString("label"));
            } else {
                names.add(app.t("pf." + k));
            }
        }
        return new JSONObject().put("count", (double) names.size()).put("text", names.isEmpty() ? app.t("pf.who.nothing") : android.text.TextUtils.join(", ", names));
    }

    /**
     * profile.audience: who sees one item (a field's index, or nickname /
     * about / avatar / cover) — a menu of the three audiences at the item's
     * chip, the current one checked.
     */
    public static void audienceMenu(MainActivity a, String which, View anchor) {
        if (draft == null || which == null) return;
        sync(a);
        M5 app = a.app();
        String formKey = baseAudienceKey(which);
        JSONObject item;
        if (formKey != null) item = draft.optJSONObject(which);
        else {
            int i;
            try { i = (int) Double.parseDouble(which); } catch (NumberFormatException e) { return; }
            JSONArray fields = draft.optJSONArray("fields");
            item = fields == null ? null : fields.optJSONObject(i);
        }
        if (item == null) return;
        JSONObject target = item;
        String current = item.optString("audience", "me");
        List<cz.m5cet.app.ui.look.Menus.Item> items = new ArrayList<>();
        for (String aud : AUDIENCES) {
            items.add(new cz.m5cet.app.ui.look.Menus.Item(Profiles.audienceIcon(aud), app.t("pf.aud." + aud), false, aud.equals(current), () -> {
                // The four base items are bound to the form (their switches): set it there, sync() takes it.
                if (formKey != null) a.form().put(formKey, aud);
                else try { target.put("audience", aud); } catch (JSONException ignored) { }
                sync(a);
                a.refresh();
            }));
        }
        cz.m5cet.app.ui.look.Menus.show(anchor, items);
    }

    private static String baseAudienceKey(String item) {
        switch (item) {
            case "nickname": return "pfNickAud";
            case "about": return "pfAboutAud";
            case "avatar": return "pfAvatarAud";
            case "cover": return "pfCoverAud";
            default: return null;
        }
    }

    /**
     * $myProfile of Settings (the card on top): my name (the public nickname,
     * else the username), my photo, and how many items each audience sees.
     * The card opens in the background the first time (ready then).
     */
    public static JSONObject summary(MainActivity a) {
        M5 app = a.app();
        Profiles profiles = Profiles.of(app);
        listen(a, profiles);
        boolean signedIn = app.account.signedIn();
        JSONObject card = signedIn ? profiles.card() : null;
        String user = app.accountName();
        JSONObject o = new JSONObject();
        try {
            String nick = card == null || card.optJSONObject("nickname") == null ? "" : card.optJSONObject("nickname").optString("value");
            String photo = card == null || card.optJSONObject("avatar") == null ? "" : card.optJSONObject("avatar").optString("value");
            o.put("signedIn", signedIn).put("ready", card != null).put("nickname", nick).put("photo", photo)
                .put("name", !nick.isEmpty() ? nick : !user.isEmpty() ? user : app.t("set.user.signedOut"));
            if (card != null) {
                JSONObject who = WhoSees.summary(card);
                o.put("counts", new JSONObject().put("public", (double) who.optJSONArray("public").length())
                    .put("room", (double) who.optJSONArray("room").length()).put("me", (double) who.optJSONArray("me").length()));
            }
        } catch (JSONException ignored) { }
        return o;
    }

    /* --------------------------------------------------- 6.10 a sender */

    /**
     * $form.sender (message.sender): who wrote a message and what they share
     * with the room — only their room view, checked again (WhoSees.senderView);
     * for my own message what members see of me. Their name here, the
     * nickname they share, the username, whether they are still here and a
     * private message is possible.
     */
    public static JSONObject sender(M5 app, RoomSession r, cz.m5cet.app.chat.ChatMessage m) {
        boolean me = m.mine;
        boolean function = cz.m5cet.app.fn.ModelIdentity.reservedSender(m.senderId); // 6.11: system-messenger too
        JSONObject person = null;
        if (!me && !function) {
            JSONArray all = r.peopleScope();
            for (int i = 0; i < all.length(); i++) if (m.senderId.equals(all.optJSONObject(i).optString("id"))) person = all.optJSONObject(i);
        }
        String channel = person == null ? "" : person.optString("channel");
        JSONObject view = WhoSees.senderView(me || function ? null : r.profileOf(m.senderId), me ? Profiles.of(app).card() : null, me);
        String name = m.senderName == null || m.senderName.isEmpty() ? "?" : m.senderName;
        String nick = view == null ? "" : view.optString("nickname");
        JSONObject o = new JSONObject();
        try {
            o.put("id", m.senderId).put("name", name).put("me", me).put("function", function)
                .put("present", me || person != null && !"closed".equals(channel))
                .put("canMessage", !me && "open".equals(channel))
                .put("username", me ? app.accountName() : person == null ? "" : person.optString("username"))
                .put("title", nick.isEmpty() ? name : nick).put("nickDiffers", !nick.isEmpty() && !nick.equalsIgnoreCase(name))
                .put("photo", view == null ? "" : view.optString("avatar"))
                .put("has", view != null);
            JSONObject drawn = view == null ? null : labelled(app, Profiles.drawn(view));
            o.put("profile", drawn == null ? new JSONObject().put("fields", new JSONArray()) : drawn);
        } catch (JSONException ignored) { }
        return o;
    }

    /** Fields without a label get their kind's name. */
    private static JSONObject labelled(M5 app, JSONObject drawn) {
        if (drawn == null) return null;
        JSONArray f = drawn.optJSONArray("fields");
        for (int i = 0; f != null && i < f.length(); i++) {
            JSONObject x = f.optJSONObject(i);
            if (x != null && x.optString("label").isEmpty()) try { x.put("label", app.t("pf.type." + x.optString("type"))); } catch (JSONException ignored) { }
        }
        return drawn;
    }

    /* ------------------------------------------------------- field dialog */

    /** Edits a field (its index) or adds one ("new"): kind, label, value and who sees it. */
    private static void fieldDialog(MainActivity a, String arg) {
        if (draft == null) return;
        M5 app = a.app();
        JSONArray fields = draft.optJSONArray("fields");
        boolean isNew = "new".equals(arg);
        int index = -1;
        if (!isNew) {
            try { index = (int) Double.parseDouble(arg); } catch (NumberFormatException e) { return; }
            if (index < 0 || index >= fields.length()) return;
        } else if (fields.length() >= ProfileCard.FIELDS) return;
        JSONObject f = isNew ? new JSONObject() : fields.optJSONObject(index);
        int pad = Ui.dp(a, 20);
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, Ui.dp(a, 8), pad, 0);

        List<String> labels = new ArrayList<>();
        for (String t : ProfileCard.FIELD_TYPES) labels.add(app.t("pf.type." + t));
        Spinner type = new Spinner(a);
        type.setAdapter(new ArrayAdapter<>(a, android.R.layout.simple_spinner_dropdown_item, labels));
        int at = ProfileCard.FIELD_TYPES.indexOf(f.optString("type", "phone"));
        type.setSelection(at < 0 ? 1 : at);
        EditText label = new EditText(a);
        label.setHint(app.t("pf.field.label"));
        label.setText(f.optString("label"));
        label.setSingleLine(true);
        EditText value = new EditText(a);
        value.setHint(app.t("pf.field.value"));
        value.setText(f.optString("value"));
        type.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> p, View v, int pos, long id) { value.setInputType(inputType(ProfileCard.FIELD_TYPES.get(pos))); }
            @Override public void onNothingSelected(AdapterView<?> p) { }
        });
        TextView who = new TextView(a);
        who.setText(app.t("pf.field.audience"));
        who.setPadding(0, Ui.dp(a, 12), 0, 0);
        RadioGroup audience = new RadioGroup(a);
        String current = isNew ? "me" : f.optString("audience", "me");
        for (int i = 0; i < AUDIENCES.length; i++) {
            RadioButton rb = new RadioButton(a);
            rb.setId(View.generateViewId());
            rb.setText(app.t("pf.aud." + AUDIENCES[i]) + " — " + app.t("pf.aud." + AUDIENCES[i] + ".hint"));
            rb.setTag(AUDIENCES[i]);
            audience.addView(rb);
            if (AUDIENCES[i].equals(current)) audience.check(rb.getId());
        }
        box.addView(type);
        box.addView(label);
        box.addView(value);
        box.addView(who);
        box.addView(audience);
        ScrollView scroll = new ScrollView(a);
        scroll.addView(box);

        final int idx = index;
        AlertDialog.Builder b = new AlertDialog.Builder(a).setTitle(app.t("pf.field.title")).setView(scroll)
            .setNegativeButton(app.t("pf.field.cancel"), null)
            .setPositiveButton(app.t("pf.field.save"), (d, w) -> {
                try {
                    View checked = audience.findViewById(audience.getCheckedRadioButtonId());
                    String aud = checked == null ? "me" : String.valueOf(checked.getTag());
                    JSONObject next = new JSONObject().put("id", isNew ? ProfileCard.newFieldId() : f.optString("id"))
                        .put("type", ProfileCard.FIELD_TYPES.get(type.getSelectedItemPosition()))
                        .put("label", label.getText().toString()).put("value", value.getText().toString()).put("audience", aud);
                    JSONArray list = draft.getJSONArray("fields");
                    if (isNew) list.put(next); else list.put(idx, next);
                    draft = ProfileCard.normalize(draft);
                } catch (JSONException ignored) { }
                a.refresh();
            });
        if (!isNew) b.setNeutralButton(app.t("pf.field.remove"), (d, w) -> {
            JSONArray list = draft.optJSONArray("fields");
            if (list != null && idx < list.length()) list.remove(idx);
            a.refresh();
        });
        b.show();
    }

    private static int inputType(String type) {
        switch (type) {
            case "phone": return InputType.TYPE_CLASS_PHONE;
            case "email": return InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS;
            case "url": case "social": return InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI;
            case "address": case "other": return InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES;
            case "name": return InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS;
            default: return InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES;
        }
    }

    /* ------------------------------------------------------------ people */

    /** The People widget: a member without a contact photo shows the photo they share with the room. */
    public static JSONObject decorate(M5 app, RoomSession r, JSONObject u) {
        if (u == null || r == null || !u.optString("photo").isEmpty()) return u;
        String photo;
        if (u.optBoolean("me")) photo = Profiles.of(app).myPhoto();
        else {
            JSONObject p = r.profileOf(u.optString("id"));
            photo = p == null ? "" : p.optString("avatar");
        }
        try { if (!photo.isEmpty()) u.put("photo", photo); } catch (JSONException ignored) { }
        return u;
    }

    /** A person's detail ($form.person.profile): what they share with the room, and their public profile when asked for. */
    public static JSONObject detail(M5 app, RoomSession r, JSONObject u) {
        if (u == null || r == null) return u;
        Profiles profiles = Profiles.of(app);
        boolean me = u.optBoolean("me");
        String id = u.optString("id");
        JSONObject room = me ? profiles.roomView() : r.profileOf(id);
        JSONObject p = new JSONObject();
        try {
            p.put("has", room != null && !ProfileCard.isEmptyView(room));
            if (room != null) p.put("room", labelled(app, Profiles.drawn(room)));
            JSONObject look = me ? null : profiles.lookup(u.optString("username"));
            if (look != null) {
                p.put("publicState", look.optString("state"));
                JSONObject pub = look.optJSONObject("profile");
                if (pub != null) p.put("public", labelled(app, Profiles.drawn(pub)));
                String key = look.optString("accountKey");
                p.put("publicVerified", !key.isEmpty() && key.equals(r.accountKeyOf(id)));
            } else {
                p.put("publicState", "").put("publicVerified", false);
            }
            u.put("profile", p);
        } catch (JSONException ignored) { }
        return u;
    }
}
