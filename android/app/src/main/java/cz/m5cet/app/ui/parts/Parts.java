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
import cz.m5cet.app.ui.look.Sheets;

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
    NfcWorkbench nfcWork; // 6.3 nfc
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
            case "msgHold": return new HoldArea(a, this, bound); // 6.7: beside a hold-to-read bubble
            case "voicePad": return voicePad = new ToolPanels.VoicePad(a);
            case "nfcPanel": return nfcPanel = new ToolPanels.NfcPanel(a);
            // 6.3 nfc: the NFC workbench and the M5Cet card builder (parity with the web).
            case "nfcWork": return nfcWork = new NfcWorkbench(a);
            case "nfcBuilder": return new NfcCardBuilder(a);
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
        if (action.equals("msg.showHidden")) { if (messages != null) messages.toggleHidden(); return; }
        ChatMessage m = find(id);
        if (m == null) return;
        switch (action) {
            case "msg.map": openMap(m); break;
            case "msg.mapPreview": mapPreview(m); break;
            case "msg.source": playSource(m); break;
            case "msg.info": messageInfo(m); break;
            case "msg.save": if (m.fileName != null) saveFile(m); break;
            case "msg.share": if (m.fileName != null) shareFile(m); break;
            case "msg.forward": forward(m); break;
            default: openFile(m);
        }
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

    /**
     * Change the PIN: the current one, then the new one twice (the vault re-wraps the user key).
     * 6.7 (audit N18): the current PIN is asked for and counted like an unlock attempt — an
     * unlocked phone left on a table no longer lets anyone set their own PIN; the dialog is FLAG_SECURE.
     */
    public void changePin() {
        M5 app = app();
        android.widget.EditText p0 = new android.widget.EditText(a), p1 = new android.widget.EditText(a), p2 = new android.widget.EditText(a);
        for (android.widget.EditText e : new android.widget.EditText[]{p0, p1, p2}) e.setInputType(android.text.InputType.TYPE_CLASS_NUMBER | android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        p0.setHint(app.t("lock.enterPin"));
        p1.setHint(app.t("lock.setPin"));
        p2.setHint(app.t("lock.confirmPin"));
        android.widget.LinearLayout l = new android.widget.LinearLayout(a);
        l.setOrientation(android.widget.LinearLayout.VERTICAL);
        l.setPadding(Ui.dp(a, 20), Ui.dp(a, 8), Ui.dp(a, 20), 0);
        l.addView(p0);
        l.addView(p1);
        l.addView(p2);
        SecureDialog.show(a, new android.app.AlertDialog.Builder(a).setTitle(app.t("settings.changePin")).setView(l)
            .setPositiveButton("OK", (d, w) -> {
                String a1 = p1.getText().toString(), a2 = p2.getText().toString();
                if (a1.length() < app.lock.pinLength() || !a1.equals(a2)) { a.flash("", app.t("lock.pinMismatch"), "error"); return; }
                cz.m5cet.app.security.AppLock.Result r = app.lock.confirmPin(p0.getText().toString());
                if (r == cz.m5cet.app.security.AppLock.Result.WIPED) { a.flash("", app.t("lock.wiped"), "error"); cz.m5cet.app.core.Io.mainLater(app::restart, 2500); return; }
                if (r != cz.m5cet.app.security.AppLock.Result.OK) { a.flash("", app.t("lock.wrongPin"), "error"); return; }
                try { app.vault.changePin(a1); a.flash("", app.t("settings.changePin") + " ✓", "success"); }
                catch (Exception e) { a.flash("", e.getMessage(), "error"); }
            })
            .setNegativeButton(app.t("nav.close"), null));
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

    /**
     * Forward (App.tsx:3565): same text and attachment, "forwarded from", no
     * kinds; a sealed one only when opened. 6.2: to a room, then to everyone
     * there or one person (privately) — a file from the vault goes to the
     * whole room (a transfer has no private form).
     */
    void forward(ChatMessage m) {
        java.util.List<RoomSession> rooms = app().rooms.connectedSessions();
        if (rooms.isEmpty()) { a.flash("", app().t("room.offline"), "warn"); return; }
        String[] names = new String[rooms.size()];
        for (int i = 0; i < rooms.size(); i++) names[i] = rooms.get(i).label;
        secureDialog(new android.app.AlertDialog.Builder(a).setTitle(app().t("msg.forward")).setItems(names, (d, w) -> {
            RoomSession to = rooms.get(w);
            org.json.JSONArray peers = to.peersScope();
            boolean vaultFile = m.filePath != null && m.fileDataUrl == null;
            if (peers.length() == 0 || vaultFile) { forwardTo(m, to, null, null); return; }
            String[] who = new String[peers.length() + 1];
            who[0] = app().t("msg.everyone") + " · " + to.label;
            for (int i = 0; i < peers.length(); i++) who[i + 1] = peers.optJSONObject(i).optString("name");
            secureDialog(new android.app.AlertDialog.Builder(a).setTitle(app().t("msg.forwardTo")).setItems(who, (d2, w2) -> {
                org.json.JSONObject p = w2 == 0 ? null : peers.optJSONObject(w2 - 1);
                forwardTo(m, to, p == null ? null : p.optString("id"), p == null ? null : p.optString("name"));
            }));
        }));
    }

    private void forwardTo(ChatMessage m, RoomSession to, String peerId, String peerName) {
        cz.m5cet.app.chat.Outgoing o = new cz.m5cet.app.chat.Outgoing();
        o.text = m.visibleText();
        o.forwardedFrom = m.forwardedFrom != null ? m.forwardedFrom : m.senderName;
        if (m.fileDataUrl != null) { o.fileName = m.fileName; o.fileMime = m.fileMime; o.dataUrl = m.fileDataUrl; o.fileSize = m.fileSize; o.fileImage = m.fileImage; }
        if (peerId != null) { o.recipients.add(peerId); o.recipientNames.add(peerName); }
        if (m.filePath != null && m.fileDataUrl == null) to.sendFile(m.filePath, m.fileName, m.fileMime, m.fileSize, o);
        else to.send(o);
        a.flash("", "✓ " + (peerName != null ? peerName + " · " : "") + to.label, "success");
    }

    /** A dialog of the app keeps screenshots out like the app does (its own window). */
    android.app.AlertDialog secureDialog(android.app.AlertDialog.Builder b) {
        android.app.AlertDialog d = b.create();
        if ((a.getWindow().getAttributes().flags & android.view.WindowManager.LayoutParams.FLAG_SECURE) != 0 && d.getWindow() != null)
            d.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE);
        d.show();
        return d;
    }

    /** The Android share sheet with the file (a content:// URI read through the vault; plaintext only to the app the user picks). */
    void shareFile(ChatMessage m) {
        if (m.fileName == null) return;
        android.net.Uri uri = cz.m5cet.app.ui.media.VaultMedia.uriFor(app(), m);
        android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_SEND)
            .setType(m.fileMime == null || m.fileMime.isEmpty() ? "application/octet-stream" : m.fileMime)
            .putExtra(android.content.Intent.EXTRA_STREAM, uri)
            .addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
        i.setClipData(android.content.ClipData.newRawUri(m.fileName, uri));
        try { a.startActivity(android.content.Intent.createChooser(i, m.fileName)); }
        catch (RuntimeException e) { a.flash("", app().t("file.noApp"), "warn"); }
    }

    /** A step only this device keeps (displayed, revealed, opened): stored with the message. */
    void touched(ChatMessage m) {
        RoomSession r = app().rooms.session(m.roomKey);
        if (r != null) r.touched(m);
    }

    /** A deleted message's pictures and previews go from memory too. */
    void forget(ChatMessage m) {
        for (String k : new String[]{m.id, m.id + "#poster", m.id + "#pdf"}) imageCache.remove(k);
        MsgBody.forget(m.id);
        holding.remove(m.id);
    }

    /**
     * The pin of a header position (location.inHeader): the same map as a
     * position message, in a dialog. 6.7: the place sheet — the map (when
     * maps are on), the coordinates, Navigate / Ride / Copy (PlaceSheet).
     */
    void mapPreview(ChatMessage m) { PlaceSheet.show(a, this, m); }

    /** The pin on a map: the phone's map app (geo:), else OpenStreetMap. 6.2: also a position message from the web (the text only). */
    void openMap(ChatMessage m) {
        org.json.JSONObject pos = cz.m5cet.app.ui.bubble.Kinds.position(m);
        if (pos == null) return;
        double lat = pos.optDouble("lat"), lon = pos.optDouble("lon");
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

    /** What the app knows of a message (like the web's message info). 6.2: a details view with the timeline, hide and delete. */
    void messageInfo(ChatMessage m) {
        RoomSession r = app().rooms.session(m.roomKey);
        if (r == null || "sys".equals(m.kind)) return;
        MsgDetails.show(a, this, r, m);
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

    /**
     * A sheet over the screen (a design screen rendered in a card, e.g. "join"
     * or "update"). 6.2 (ui/look/Sheets): a "sheet" root may ask to float as a
     * dock just above the composer instead, and to fade away once one of its
     * elements runs an action (the Tools).
     */
    void showSheet(String screenId, Expr.Scope scope) {
        // The tap on the dock's own button that just closed the dock does not open it again.
        if (Sheets.justClosed(screenId)) return;
        closeOverlay();
        JSONObject tree = app().design().screen(screenId);
        if (tree == null) return;
        Renderer renderer = Sheets.dismissOnAction(tree, scope, a.tr()) ? new Renderer(a, Sheets.dismissing(a, this::closeOverlay)) : a.renderer();
        Renderer.Bound b = renderer.build(tree);
        b.bind(scope);
        sheetBound = b;
        sheetScreen = screenId;
        sheet = Sheets.show(a.overlay(), screenId, b.root(), Sheets.dock(tree, scope, a.tr()), composer, app().design().anim("dialog"), this::closeOverlay);
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
        Sheets.hide(a.overlay(), s);
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

    private People people;

    /** 6.2: the People widget's model and actions (selection, a person's detail, calls, contacts). */
    public People people() {
        if (people == null) people = new People(a, this);
        return people;
    }

    /** 6.2: the composer's text field gets the focus and the keyboard (a private message was chosen). */
    public void focusComposer() {
        android.widget.EditText field = composer == null ? null : findField(composer);
        if (field == null) return;
        field.requestFocus();
        android.view.inputmethod.InputMethodManager im = a.getSystemService(android.view.inputmethod.InputMethodManager.class);
        if (im != null) im.showSoftInput(field, 0);
    }

    private static android.widget.EditText findField(View v) {
        if (v instanceof android.widget.EditText) return (android.widget.EditText) v;
        if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) {
            android.widget.EditText e = findField(((ViewGroup) v).getChildAt(i));
            if (e != null) return e;
        }
        return null;
    }

    /** 6.2: the screen the open sheet shows ("" without one). */
    String sheetScreen() { return sheet == null || sheetScreen == null ? "" : sheetScreen; }

    /* --------------------------------------------------- 6.2 bubbles */

    /* ------------------------------------------------------ 6.2 look */
}
