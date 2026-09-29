package cz.m5cet.app.telecom;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

import cz.m5cet.app.M5;

/** A direct reply from a message notification goes to its room. */
public final class ReplyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        Bundle input = RemoteInput.getResultsFromIntent(intent);
        String room = intent.getStringExtra("room");
        if (input == null || room == null) return;
        CharSequence text = input.getCharSequence(Notify.KEY_REPLY);
        M5 app = M5.get();
        if (text != null && text.length() > 0 && !app.lock.isLocked()) app.rooms.send(room, text.toString(), null);
        app.notify.clearRoom(room);
    }
}
