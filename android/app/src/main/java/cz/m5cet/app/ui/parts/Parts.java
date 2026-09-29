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

    public Parts(MainActivity a) { this.a = a; }

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
            case "updateProgress": return new CallParts.Progress(a, this);
            default: {
                TextView t = new TextView(a);
                t.setText("[" + name + "]");
                return t;
            }
        }
    }

    public void onRoomsChanged() {
        if (roomList != null && roomList.isAttachedToWindow()) roomList.refresh();
        if (roomTabs != null && roomTabs.isAttachedToWindow()) roomTabs.refresh();
        if (userPanel != null && userPanel.isAttachedToWindow()) userPanel.refresh();
        if (messages != null && messages.isAttachedToWindow()) messages.refreshHeaderState();
    }

    public void onRoomMessage(String roomKey, ChatMessage m) {
        if (messages != null && messages.isAttachedToWindow() && roomKey.equals(app().rooms.active())) messages.add(m);
    }

    /* ----------------------------------------------------------- composer */

    public void sendComposer() { if (composer != null) composer.send(); }

    public void pickedImage(android.net.Uri uri) { if (composer != null) composer.sendImage(uri); }

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

    public boolean closeOverlay() {
        if (sheet == null) return false;
        View s = sheet;
        sheet = null;
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
}
