package cz.m5cet.app.contacts;

import android.accounts.Account;
import android.app.Service;
import android.content.AbstractThreadedSyncAdapter;
import android.content.ContentProviderClient;
import android.content.Context;
import android.content.Intent;
import android.content.SyncResult;
import android.os.Bundle;
import android.os.IBinder;

/**
 * 6.2 Contacts: the contacts sync adapter of the app's account type. It never
 * syncs — the links are made in the app and nothing of the contacts leaves
 * the phone; it exists because the Contacts app learns the M5cet rows (their
 * MIME types, icons, labels: res/xml/contacts.xml) from a sync adapter's
 * meta-data.
 */
public final class SyncService extends Service {
    private static final Object LOCK = new Object();
    private static Adapter adapter;

    @Override
    public void onCreate() {
        synchronized (LOCK) { if (adapter == null) adapter = new Adapter(getApplicationContext()); }
    }

    @Override public IBinder onBind(Intent intent) { return adapter.getSyncAdapterBinder(); }

    static final class Adapter extends AbstractThreadedSyncAdapter {
        Adapter(Context c) { super(c, true); }

        @Override public void onPerformSync(Account account, Bundle extras, String authority, ContentProviderClient provider, SyncResult result) { /* nothing to sync */ }
    }
}
