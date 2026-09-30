package cz.m5cet.app.ui.parts;

import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONObject;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.ChatMessage;
import cz.m5cet.app.chat.RoomSession;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.ui.Expr;
import cz.m5cet.app.ui.MainActivity;
import cz.m5cet.app.ui.Renderer;
import cz.m5cet.app.ui.Ui;

/**
 * The app's native parts that screens place with slot elements, and the
 * overlay layer (flash messages, the join sheet, the update card, menus).
 */
public final class Parts {
    final MainActivity a;
    MessageList messages;
    Composer composer;
    UserPanel userPanel;
    RoomList roomList;
    RoomTabs roomTabs;
    LockPad lockPad;
    CallParts.Video callVideo;
    private View sheet;
    /** The sheet's tree and screen id: bound again when the state changes (a switch in the sheet). */
    private Renderer.Bound sheetBound;
    private String sheetScreen;
    /** 6.1: decoded pictures of messages (by message id), and "tap" messages being held now. */
    final android.util.LruCache<String, android.graphics.Bitmap> imageCache = new android.util.LruCache<String, android.graphics.Bitmap>(24 * 1024 * 1024) {
        @Override protected int sizeOf(String k, android.graphics.Bitmap b) { return b.getByteCount(); }
    };
    final java.util.Set<String> holding = new java.util.HashSet<>();
    ToolPanels.VoicePad voicePad;
    ToolPanels.NfcPanel nfcPanel;
    AiChat aiChat;
    final Fn fn;

    public Parts(MainActivity a) { this.a = a; this.fn = new Fn(a); }

    M5 app() { return a.app(); }

    public View create(String name, Renderer.Bound bound) {
        switch (name == null ? "" : name) {
            case "splashLogo": return new Logos.Splash(a);
            case "logo": return new Logos.Mark(a, 56);
            case "lockPad": return lockPad = new LockPad(a, this);
            case "enrollForm": return new Forms.Enroll(a, this);
            case "joinForm": return new Forms.Join(a, this);
            case "roomList": return roomList = new RoomList(a, this);
            case "roomTabs": return roomTabs = new RoomTabs(a, this);
            case "messages": return messages = new MessageList(a, this);
            case "composer": return composer = new Composer(a, this);
            case "userPanel": return userPanel = new UserPanel(a, this);
            case "userList": return new UserPanel.List(a, this);
            case "callControls": return new CallParts.Controls(a, this);
            case "callVideo": return callVideo = new CallParts.Video(a, this);
            case "settingsList": return new SettingsList(a, this);
            case "msgBody": return new MsgBody(a, this);
            case "voicePad": return voicePad = new ToolPanels.VoicePad(a);
            case "nfcPanel": return nfcPanel = new ToolPanels.NfcPanel(a);
            case "aiChat": return aiChat = new AiChat(a, this);
            case "updateProgress": return new CallParts.Progress(a, this);
            default: {
                TextView t = new TextView(a);
                t.setText("[" + name + "]");
                return t;
            }
        }
    }

    public void onRoomsChanged() {
        fn.load();
        if (roomList != null && roomList.isAttachedToWindow()) roomList.refresh();
        if (roomTabs != null && roomTabs.isAttachedToWindow()) roomTabs.refresh();
        if (userPanel != null && userPanel.isAttachedToWindow()) userPanel.refresh();
        if (messages != null && messages.isAttachedToWindow()) messages.refreshHeaderState();
    }

    public void onRoomMessage(String roomKey, ChatMessage m) {
        if (messages != null && messages.isAttachedToWindow() && roomKey.equals(app().rooms.active())) messages.add(m);
    }

    public void onRoomMessageChanged(String roomKey, ChatMessage m) {
        if (messages != null && messages.isAttachedToWindow() && roomKey.equals(app().rooms.active())) messages.changed(m);
    }

    /* ------------------------------------------------------ messages (6.1) */

    /* ------------------------------------------------ tools and settings (6.1) */

    public void onMessageAction(String action, String id) {
        ChatMessage m = find(id);
        if (m == null) return;
        if (action.equals("msg.map")) openMap(m);
        else if (action.equals("msg.source")) playSource(m);
        else openFile(m);
    }

    public String composerText() { return composer == null ? "" : composer.text(); }
    public void refreshComposer() { if (composer != null) composer.refreshKinds(); }

    public void voicePadDictate() { if (voicePad != null) voicePad.toggle(); }
    public void nfc(String what) { if (nfcPanel != null) nfcPanel.action(what); }
    public JSONObject nfcScope() { return nfcPanel == null ? new JSONObject() : nfcPanel.scope(); }
    public void aiSend() { if (aiChat != null) aiChat.send(); }
    public void aiStop() { if (aiChat != null) aiChat.stop(); }
    public void aiClear() { if (aiChat != null) aiChat.clear(); }
    public JSONObject aiScope() { return aiChat == null ? new JSONObject() : aiChat.scope(); }

    /** Change the PIN: two fields in a dialog (the vault re-wraps the user key). */
    public void changePin() {
        M5 app = app();
        android.widget.EditText p1 = new android.widget.EditText(a), p2 = new android.widget.EditText(a);
        for (android.widget.EditText e : new android.widget.EditText[]{p1, p2}) e.setInputType(android.text.InputType.TYPE_CLASS_NUMBER | android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        p1.setHint(app.t("lock.setPin"));
        p2.setHint(app.t("lock.confirmPin"));
        android.widget.LinearLayout l = new android.widget.LinearLayout(a);
        l.setOrientation(android.widget.LinearLayout.VERTICAL);
        l.setPadding(Ui.dp(a, 20), Ui.dp(a, 8), Ui.dp(a, 20), 0);
        l.addView(p1);
        l.addView(p2);
        new android.app.AlertDialog.Builder(a).setTitle(app.t("settings.changePin")).setView(l)
            .setPositiveButton("OK", (d, w) -> {
                String a1 = p1.getText().toString(), a2 = p2.getText().toString();
                if (a1.length() < app.lock.pinLength() || !a1.equals(a2)) { a.flash("", app.t("lock.pinMismatch"), "error"); return; }
                try { app.vault.changePin(a1); a.flash("", app.t("settings.changePin") + " ✓", "success"); }
                catch (Exception e) { a.flash("", e.getMessage(), "error"); }
            })
            .setNegativeButton(app.t("nav.close"), null).show();
    }

    /** Erase everything — asked first. */
    public void askWipe() {
        M5 app = app();
        new android.app.AlertDialog.Builder(a).setMessage(app.t("settings.wipe") + "?")
            .setPositiveButton(app.t("settings.wipe"), (d, w) -> { cz.m5cet.app.security.Wiper.wipe(app, "user", false, 0); app.restart(); })
            .setNegativeButton(app.t("nav.close"), null).show();
    }

    /** A command's outputs in a bubble (FnView): buttons, forms, media, Markdown. */
    void fnOutputs(ViewGroup into, ChatMessage m, int fg) {
        JSONObject meta = m.fnDraw();
        org.json.JSONArray outputs = meta == null ? null : meta.optJSONArray("outputs");
        if (outputs == null || outputs.length() == 0) {
            android.widget.TextView t = new android.widget.TextView(a);
            t.setText(m.visibleText());
            t.setTextColor(fg);
            t.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15);
            into.addView(t);
            return;
        }
        cz.m5cet.app.fn.FnView v = fn.view();
        v.show(m.id, outputs, meta, m.createdAt);
        into.addView(v);
    }

    void filterTag(String tag) { if (messages != null) messages.filter(tag); }

    private ChatMessage find(String id) {
        RoomSession r = app().rooms.activeSession();
        if (r == null) return null;
        for (ChatMessage m : r.messagesCopy()) if (m.id.equals(id)) return m;
        return null;
    }

    /** The picture full screen (tap to close, long press to save). */
    void viewImage(ChatMessage m) {
        android.graphics.Bitmap b = imageCache.get(m.id);
        if (b == null) return;
        FrameLayout box = new FrameLayout(a);
        box.setBackgroundColor(0xF0000000);
        android.widget.ImageView iv = new android.widget.ImageView(a);
        iv.setImageBitmap(b);
        iv.setScaleType(android.widget.ImageView.ScaleType.FIT_CENTER);
        box.addView(iv, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        box.setOnClickListener(v -> a.overlay().removeView(box));
        box.setOnLongClickListener(v -> { saveFile(m); return true; });
        a.overlay().addView(box, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        box.setAlpha(0f);
        box.animate().alpha(1f).setDuration(160).start();
    }

    /** Another app opens the file: a content:// URI decrypted as it is read. */
    void openFile(ChatMessage m) {
        try {
            android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW)
                .setDataAndType(cz.m5cet.app.ui.media.VaultMedia.uriFor(app(), m), m.fileMime == null ? "application/octet-stream" : m.fileMime)
                .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
            a.startActivity(android.content.Intent.createChooser(i, m.fileName));
        } catch (RuntimeException e) {
            a.flash("", app().t("file.noApp"), "warn");
        }
    }

    private ChatMessage saving;

    /** Save as… (the system's file picker); the plaintext goes only where the user chose. */
    void saveFile(ChatMessage m) {
        saving = m;
        a.startActivityForResult(new android.content.Intent(android.content.Intent.ACTION_CREATE_DOCUMENT).addCategory(android.content.Intent.CATEGORY_OPENABLE)
            .setType(m.fileMime == null ? "application/octet-stream" : m.fileMime).putExtra(android.content.Intent.EXTRA_TITLE, m.fileName), 7302);
    }

    public void savedTo(android.net.Uri uri) {
        ChatMessage m = saving;
        saving = null;
        if (m == null || uri == null) return;
        Io.bg(() -> {
            try (java.io.OutputStream out = a.getContentResolver().openOutputStream(uri)) {
                cz.m5cet.app.ui.media.VaultMedia.copyTo(app(), m, out);
                Io.main(() -> a.flash("", app().t("file.saved"), "success"));
            } catch (Exception e) {
                Io.main(() -> a.flash("", e.getMessage(), "error"));
            }
        });
    }

    /** Forward (App.tsx:3565): same text and attachment, "forwarded from", no kinds; a sealed one only when opened. */
    void forward(ChatMessage m) {
        RoomSession r = app().rooms.activeSession();
        if (r == null) return;
        java.util.List<RoomSession> rooms = app().rooms.connectedSessions();
        String[] names = new String[rooms.size()];
        for (int i = 0; i < rooms.size(); i++) names[i] = rooms.get(i).label;
        new android.app.AlertDialog.Builder(a).setTitle(app().t("msg.forward")).setItems(names, (d, w) -> {
            cz.m5cet.app.chat.Outgoing o = new cz.m5cet.app.chat.Outgoing();
            o.text = m.visibleText();
            o.forwardedFrom = m.forwardedFrom != null ? m.forwardedFrom : m.senderName;
            if (m.fileDataUrl != null) { o.fileName = m.fileName; o.fileMime = m.fileMime; o.dataUrl = m.fileDataUrl; o.fileSize = m.fileSize; o.fileImage = m.fileImage; }
            RoomSession to = rooms.get(w);
            if (m.filePath != null && m.fileDataUrl == null) to.sendFile(m.filePath, m.fileName, m.fileMime, m.fileSize, o);
            else to.send(o);
            a.flash("", "✓ " + to.label, "success");
        }).show();
    }

    /** The pin on a map: the phone's map app (geo:), else OpenStreetMap. */
    void openMap(ChatMessage m) {
        if (m.loc == null) return;
        double lat = m.loc.optDouble("lat"), lon = m.loc.optDouble("lon");
        try {
            a.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(cz.m5cet.app.location.Where.geoUri(lat, lon, m.senderName))));
        } catch (RuntimeException e) {
            a.openUrl(cz.m5cet.app.location.Where.mapUrl(lat, lon));
        }
    }

    /** The recording a call transcript came from. */
    void playSource(ChatMessage m) {
        if (m.sourceAudio == null) return;
        ChatMessage clip = new ChatMessage();
        clip.id = m.id + "-src";
        clip.filePath = m.sourceAudio;
        clip.fileMime = "audio/mp4";
        cz.m5cet.app.ui.media.AudioBar bar = new cz.m5cet.app.ui.media.AudioBar(a, Ui.color(a, "@onSurface", Color.BLACK), Ui.color(a, "@primary", Color.BLUE));
        bar.set(() -> cz.m5cet.app.ui.media.VaultMedia.source(app(), clip), 0);
        new android.app.AlertDialog.Builder(a).setTitle(app().t("msg.source")).setView(bar).setOnDismissListener(d -> bar.release()).show();
        bar.toggle();
    }

    /** What the app knows of a message (like the web's message info). */
    void messageInfo(ChatMessage m) {
        StringBuilder b = new StringBuilder();
        java.text.DateFormat df = java.text.DateFormat.getDateTimeInstance();
        b.append(app().t("msg.info.sent")).append(": ").append(df.format(new java.util.Date(m.createdAt))).append('\n');
        b.append(app().t("msg.info.from")).append(": ").append(m.mine ? app().t("users.me") : m.senderName).append('\n');
        if (m.mine) b.append(app().t("msg.info.state")).append(": ").append(app().t("msg.state." + m.status)).append('\n');
        if (m.receipts.length() > 0) for (java.util.Iterator<String> it = m.receipts.keys(); it.hasNext(); ) { String k = it.next(); b.append("  · ").append(peerName(k)).append(": ").append(app().t("msg.state." + m.receipts.optString(k))).append('\n'); }
        if (!m.to.isEmpty()) b.append(app().t("msg.info.to")).append(": ").append(String.join(", ", m.to)).append('\n');
        if (m.expiresAt > 0) b.append(app().t("msg.info.expires")).append(": ").append(df.format(new java.util.Date(m.expiresAt))).append('\n');
        if (m.vanishSeconds > 0) b.append(app().t("msgkind.vanish")).append(": ").append(m.vanishSeconds).append(" s\n");
        if (m.sealed != null) b.append(app().t("msgkind.sealed")).append('\n');
        if (m.tap) b.append(app().t("msgkind.tap")).append('\n');
        if (m.loc != null) b.append(app().t("msg.map")).append(": ").append(m.loc.optDouble("lat")).append(", ").append(m.loc.optDouble("lon")).append(" (±").append(m.loc.optLong("acc")).append(" m)\n");
        b.append(app().t("msg.info.verified")).append(": ").append(m.verified ? "✓" : m.changed ? "⚠" : "—");
        new android.app.AlertDialog.Builder(a).setTitle(app().t("msg.info")).setMessage(b.toString()).setPositiveButton("OK", null).show();
    }

    private String peerName(String peerId) {
        RoomSession r = app().rooms.activeSession();
        if (r == null) return peerId;
        String n = r.peerName(peerId);
        return n == null ? peerId : n;
    }

    /* ----------------------------------------------------------- composer */

    public void sendComposer() { if (composer != null) composer.send(); }

    public void pickedImage(android.net.Uri uri) { if (composer != null) composer.sendImage(uri); }
    public void pickedFile(android.net.Uri uri) { if (composer != null) composer.sendFileUri(uri); }
    public void captured() { if (composer != null) composer.captured(); }

    /* ------------------------------------------- composer actions (6.1) */

    public void composerAction(String what, String arg) {
        if (composer == null) return;
        closeOverlay();
        switch (what) {
            case "photo": composer.pickImage(); break;
            case "camera": composer.capture(); break;
            case "file": composer.pickFile(); break;
            case "location": composer.sharePosition(); break;
            case "voice": composer.record("voice"); break;
            case "voiceText": composer.record("text"); break;
            case "asVoice": composer.sendAsVoice(); break;
            case "dictate": composer.toggleDictation(); break;
            default: break;
        }
    }

    /** message.kind: tap | vanish:<s> | seal[:<code>] | normal — for the next message. */
    public void messageKind(String arg) {
        java.util.Map<String, Object> f = a.form();
        String k = arg == null ? "" : arg.trim();
        if (k.equals("normal")) { f.remove("msgTap"); f.remove("msgVanish"); f.remove("msgSeal"); }
        else if (k.equals("tap")) { if (Boolean.TRUE.equals(f.get("msgTap"))) f.remove("msgTap"); else f.put("msgTap", true); }
        else if (k.startsWith("vanish")) { int s = k.indexOf(':') > 0 ? (int) Expr.num(k.substring(k.indexOf(':') + 1)) : (int) app().settings.num("messages.vanishSeconds"); if (s > 0) f.put("msgVanish", (double) s); else f.remove("msgVanish"); }
        else if (k.startsWith("seal")) { if (f.containsKey("msgSeal") && k.indexOf(':') < 0) f.remove("msgSeal"); else f.put("msgSeal", k.indexOf(':') > 0 ? k.substring(k.indexOf(':') + 1) : cz.m5cet.app.chat.Sealed.newCode()); }
        if (composer != null) composer.refreshKinds();
        a.refresh();
    }

    /** message.recipients: pick who gets the next message (none = everyone). */
    public void pickRecipients() {
        RoomSession r = app().rooms.activeSession();
        if (r == null) return;
        org.json.JSONArray users = r.peersScope();
        String[] names = new String[users.length()];
        String[] ids = new String[users.length()];
        boolean[] checked = new boolean[users.length()];
        Object cur = a.form().get("msgTo");
        java.util.List<?> chosen = cur instanceof java.util.List ? (java.util.List<?>) cur : java.util.Collections.emptyList();
        for (int i = 0; i < users.length(); i++) {
            org.json.JSONObject u = users.optJSONObject(i);
            names[i] = u.optString("name");
            ids[i] = u.optString("id");
            checked[i] = chosen.contains(ids[i]);
        }
        if (names.length == 0) { a.flash("", app().t("msg.nobody"), "info"); return; }
        new android.app.AlertDialog.Builder(a).setTitle(app().t("msg.recipients"))
            .setMultiChoiceItems(names, checked, (d, w, on) -> checked[w] = on)
            .setPositiveButton("OK", (d, w) -> {
                java.util.List<String> to = new java.util.ArrayList<>();
                for (int i = 0; i < ids.length; i++) if (checked[i]) to.add(ids[i]);
                if (to.isEmpty()) a.form().remove("msgTo"); else a.form().put("msgTo", to);
                if (composer != null) composer.refreshKinds();
            })
            .setNeutralButton(app().t("msg.everyone"), (d, w) -> { a.form().remove("msgTo"); if (composer != null) composer.refreshKinds(); })
            .show();
    }

    /**
     * Suggestions for the composer: [label, detail, the text after picking].
     * The fn package matches the operator's triggers — "/" commands (from the
     * server), "@" the people in the room and away, "#" tags.
     */
    java.util.List<String[]> suggest(String text, int caret) {
        java.util.List<String[]> out = new java.util.ArrayList<>();
        if (text == null) return out;
        RoomSession r = app().rooms.activeSession();
        java.util.List<String> names = new java.util.ArrayList<>();
        java.util.List<String> recent = new java.util.ArrayList<>();
        if (r != null) {
            org.json.JSONArray peers = r.peersScope();
            for (int i = 0; i < peers.length(); i++) names.add(peers.optJSONObject(i).optString("name"));
            for (ChatMessage m : r.messagesCopy()) recent.add(m.visibleText());
        }
        cz.m5cet.app.fn.Suggestions.Result res = fn.suggest(text, caret < 0 ? text.length() : caret, names, recent);
        if (res == null) return out;
        for (cz.m5cet.app.fn.Suggestions.Item it : res.items) {
            if (it.disabled) {
                String note = "off".equals(it.key) ? app().t("functions.off") : "";
                if (!note.isEmpty()) out.add(new String[]{note, "", text}); // clicking a notice leaves the text as it is
                continue;
            }
            String detail = it.extra != null && !it.extra.isEmpty() ? it.detail + "  " + it.extra : it.detail;
            out.add(new String[]{it.label, detail == null ? "" : detail, it.text});
        }
        return out;
    }

    /** A typed command (/keyword args) runs on the server instead of being sent; false = send it as text. */
    boolean runCommand(RoomSession r, String text) { return fn.run(r, text); }

    public void replyTo(String messageId) {
        RoomSession r = app().rooms.activeSession();
        if (r == null || composer == null) return;
        for (ChatMessage m : r.messagesCopy()) if (m.id.equals(messageId)) { composer.setReply(m); return; }
    }

    public void copyMessage(String messageId) {
        RoomSession r = app().rooms.activeSession();
        if (r == null) return;
        for (ChatMessage m : r.messagesCopy()) if (m.id.equals(messageId)) { a.copy(m.text); a.flash("", "✓", "success"); return; }
    }

    /* --------------------------------------------------------- user panel */

    public void toggleUsers() { if (userPanel != null) userPanel.toggle(); }
    public void dockUsers(String edge) { if (userPanel != null) userPanel.dock(edge); }
    public void autoHideUsers(Boolean on) { if (userPanel != null) userPanel.autoHide(on); }

    /* -------------------------------------------------------------- lock */

    public void retryBiometric() { a.promptBiometric(); }

    /* ------------------------------------------------------------ overlay */

    /** A sheet over the screen (a design screen rendered in a card, e.g. "join" or "update"). */
    void showSheet(String screenId, Expr.Scope scope) {
        closeOverlay();
        JSONObject tree = app().design().screen(screenId);
        if (tree == null) return;
        Renderer.Bound b = a.renderer().build(tree);
        b.bind(scope);
        sheetBound = b;
        sheetScreen = screenId;
        FrameLayout scrim = new FrameLayout(a);
        scrim.setBackgroundColor(Ui.color(a, "@scrim", 0x99000000));
        scrim.setOnClickListener(v -> closeOverlay());
        View content = b.root();
        content.setClickable(true);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        if (content.getBackground() == null) content.setBackground(Ui.shape(Ui.color(a, "@surface", Color.WHITE), Ui.dp(a, 24), 0, 0));
        content.setElevation(Ui.dp(a, 12));
        scrim.addView(content, lp);
        a.overlay().addView(scrim, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        sheet = scrim;
        JSONObject dialog = app().design().anim("dialog");
        content.setTranslationY(Ui.dp(a, 40));
        content.setAlpha(0f);
        content.animate().translationY(0).alpha(1f).setDuration(dialog.optLong("ms", 220)).setInterpolator(Ui.easing(dialog.optString("easing", "decelerate"))).start();
    }

    /** Binds the open sheet again (a setting it shows changed). */
    public void refreshSheet() {
        if (sheetBound != null && sheetScreen != null) try { sheetBound.bind(a.scopeFor(sheetScreen)); } catch (RuntimeException ignored) { }
    }

    public boolean sheetOpen() { return sheet != null; }

    public void showSheet(String screenId) { showSheet(screenId, a.scopeFor(screenId)); }

    public boolean closeOverlay() {
        if (sheet == null) return false;
        View s = sheet;
        sheet = null;
        sheetBound = null;
        sheetScreen = null;
        s.animate().alpha(0f).setDuration(160).withEndAction(() -> a.overlay().removeView(s)).start();
        return true;
    }

    public void showJoin() { showSheet("join", a.scopeFor("join")); }

    public void showUpdateCard() { Io.main(() -> showSheet("update", a.scopeFor("update"))); }

    public JSONObject updateScope() {
        JSONObject release = app().releases.available();
        String kind = String.valueOf(a.form().getOrDefault("updateKind", release != null ? "release" : "bundle"));
        if (kind.equals("release") && release != null) {
            return MainActivity.jo("kind", "release", "version", release.optString("versionName"), "size", (double) release.optLong("size"), "notes", release.optString("notes"),
                "progress", 0.0, "state", app().releases.isReady() ? "ready" : "available");
        }
        JSONObject st = app().bundles.state();
        String staged = st.optString("staged");
        JSONObject item = st.optJSONObject("items") == null ? null : st.optJSONObject("items").optJSONObject(staged);
        return MainActivity.jo("kind", "bundle", "version", item == null ? "" : item.optString("version"), "size", 0.0, "notes", "",
            "progress", 1.0, "state", staged.isEmpty() ? "none" : "ready");
    }

    public void installUpdate() {
        JSONObject release = app().releases.available();
        if (release != null && "release".equals(a.form().get("updateKind"))) {
            if (app().releases.isReady()) app().releases.install(a);
            else app().releases.download();
            return;
        }
        closeOverlay();
        app().bundles.installNow();
    }

    /* -------------------------------------------------------------- flash */

    public boolean flash(String title, String text, String level) {
        JSONObject tree = app().design().screen("flash");
        if (tree == null || text == null || text.isEmpty()) return false;
        Renderer.Bound b = a.renderer().build(tree);
        java.util.Map<String, Object> s = new java.util.HashMap<>();
        s.put("flash", MainActivity.jo("title", title == null ? "" : title, "text", text, "level", level == null ? "info" : level));
        b.bind(s::get);
        View v = b.root();
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP);
        a.overlay().addView(v, lp);
        Renderer.animate(v, app().design().anim("flash"), a);
        long stay = app().design().anim("flash").optLong("stay", 3500);
        v.setOnClickListener(x -> a.overlay().removeView(v));
        Io.mainLater(() -> v.animate().alpha(0f).translationY(-Ui.dp(a, 16)).setDuration(200).withEndAction(() -> a.overlay().removeView(v)).start(), stay);
        return true;
    }

    /* ---------------------------------------------------- 6.2 people */

    /* --------------------------------------------------- 6.2 bubbles */

    /* ------------------------------------------------------ 6.2 look */
}
