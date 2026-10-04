package cz.m5cet.app.telecom;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Log;
import cz.m5cet.app.security.IntentSeal;

/**
 * A direct reply from a message notification goes to its room — the room the
 * notification was posted for: its PendingIntent is mutable (the system fills
 * in the text), so the room travels with this process's tag and a changed or
 * foreign one is refused (6.10, G-23). Only into a room the app is in, never
 * while it is locked.
 */
public final class ReplyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        Bundle input = RemoteInput.getResultsFromIntent(intent);
        String room = intent.getStringExtra("room");
        if (input == null || room == null) return;
        if (!IntentSeal.valid(IntentSeal.REPLY, room, intent.getStringExtra(IntentSeal.EXTRA))) {
            Log.w("notify", "a reply without the notification's tag was refused");
            return;
        }
        CharSequence text = input.getCharSequence(Notify.KEY_REPLY);
        M5 app = M5.get();
        if (app == null) return;
        if (text != null && text.length() > 0 && !app.lock.isLocked()) app.rooms.send(room, text.toString(), null);
        app.notify.clearRoom(room);
    }
}
