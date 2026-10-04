package cz.m5cet.app.ui.parts;

import android.app.AlertDialog;
import android.view.WindowManager;

import cz.m5cet.app.M5;
import cz.m5cet.app.chat.Rooms;
import cz.m5cet.app.ui.MainActivity;

/**
 * A saved room's actions from its row's swipe (6.7, the menus
 * room-swipe-right / room-swipe-left): Delete asks first, Clone saves a
 * copy under the next free name, Edit opens the join form filled with the
 * room (the "room.edit" sheet) and saves what changed.
 */
public final class RoomEdit {
    private RoomEdit() {}

    /** The form key that hands the room being edited to the join form (Forms.Join takes it once). */
    static final String EDIT = "roomEdit";

    public static void run(MainActivity a, String action, String key) {
        M5 app = a.app();
        Rooms.Saved s = app.rooms.savedRoom(key);
        if (s == null) return;
        String name = s.label == null || s.label.isEmpty() ? s.room : s.label;
        switch (action) {
            case "room.delete": ask(a, s.key, name); break;
            case "room.clone": {
                String k = app.rooms.copy(s.key);
                Rooms.Saved c = k == null ? null : app.rooms.savedRoom(k);
                if (c != null) a.flash("", app.t("room.cloned").replace("{name}", c.label), "success");
                a.refresh();
                break;
            }
            case "room.edit":
                a.form().put(EDIT, s.key);
                // A design from before 6.7 has no edit sheet: the join sheet holds the same form.
                a.parts.showSheet(app.design().screen("room.edit") != null ? "room.edit" : "join");
                break;
            default: break;
        }
    }

    private static void ask(MainActivity a, String key, String name) {
        M5 app = a.app();
        AlertDialog d = new AlertDialog.Builder(a).setTitle(app.t("room.delete.title"))
            .setMessage(app.t("room.delete.text").replace("{name}", name))
            .setPositiveButton(app.t("room.delete.yes"), (x, w) -> {
                app.rooms.forget(key);
                a.refresh();
                a.flash("", app.t("room.deleted").replace("{name}", name), "info");
            })
            .setNegativeButton(app.t("room.delete.no"), null)
            .create();
        // Screenshots stay out of the dialog like out of the app (its own window).
        if ((a.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0 && d.getWindow() != null) d.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        d.show();
    }

    /** The join form's Save in the edit sheet: the room changed, the sheet closed. */
    static void save(MainActivity a, String key, String room, String pass, String name) {
        M5 app = a.app();
        if (room.trim().isEmpty() || pass.isEmpty()) { a.flash("", app.t("room.edit.missing"), "warn"); return; }
        if (app.rooms.update(key, room, pass, name.trim()) == null) return;
        a.parts.closeOverlay();
        a.refresh();
        a.flash("", app.t("room.edit.saved"), "success");
    }
}
