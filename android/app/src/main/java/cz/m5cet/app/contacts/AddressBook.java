package cz.m5cet.app.contacts;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.content.ContentProviderOperation;
import android.content.ContentProviderResult;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import android.provider.ContactsContract.AggregationExceptions;
import android.provider.ContactsContract.CommonDataKinds.StructuredName;
import android.provider.ContactsContract.Contacts;
import android.provider.ContactsContract.Data;
import android.provider.ContactsContract.RawContacts;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 6.2 Contacts: M5cet people linked with contacts of the phone's address
 * book, the standard way to put actions into the Contacts app — an account
 * of the app's own type (AuthenticatorService), a contacts sync adapter that
 * only declares the data kinds (res/xml/contacts.xml) and never syncs, and
 * per linked person a raw contact of that account with two data rows,
 * "Zpráva přes M5cet" and "Volat přes M5cet" (data1 = the account username),
 * kept together with the chosen contact (AggregationExceptions). The
 * Contacts app opens such a row with ACTION_VIEW on its MIME type; that
 * lands in MainActivity (ContactIntents).
 *
 * Only the username goes into the address book, and nothing of the contacts
 * leaves the phone. Every call here blocks: run it off the main thread.
 */
public final class AddressBook {
    private AddressBook() {}

    /** The app's account type = its application id (res/xml/authenticator.xml, syncadapter.xml). */
    public static final String ACCOUNT_TYPE = "cz.m5cet.app";
    public static final String ACCOUNT_NAME = "M5cet";
    public static final String MIME_MESSAGE = "vnd.android.cursor.item/vnd.cz.m5cet.message";
    public static final String MIME_CALL = "vnd.android.cursor.item/vnd.cz.m5cet.call";

    /** A link just made. */
    public static final class Linked {
        public final String username, contactName, lookup;
        public final long contactId, rawId;
        Linked(String username, String contactName, String lookup, long contactId, long rawId) {
            this.username = username; this.contactName = contactName; this.lookup = lookup; this.contactId = contactId; this.rawId = rawId;
        }
    }

    /** A row the Contacts app opened: whose it is and what it asks for ("message" or "call"). */
    public static final class Row {
        public final String username, kind;
        public final long rawId;
        Row(String username, String kind, long rawId) { this.username = username; this.kind = kind; this.rawId = rawId; }
    }

    public static Account account() { return new Account(ACCOUNT_NAME, ACCOUNT_TYPE); }

    /** Writes as the account's own sync adapter: rows really go when deleted, nothing is marked dirty. */
    private static Uri asAdapter(Uri uri) {
        return uri.buildUpon().appendQueryParameter(ContactsContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(RawContacts.ACCOUNT_NAME, ACCOUNT_NAME).appendQueryParameter(RawContacts.ACCOUNT_TYPE, ACCOUNT_TYPE).build();
    }

    /** The account exists (added once, without a password) and its contacts are visible. */
    static void ensureAccount(Context c) {
        AccountManager.get(c).addAccountExplicitly(account(), null, null);
        try {
            ContentValues v = new ContentValues();
            v.put(ContactsContract.Settings.ACCOUNT_NAME, ACCOUNT_NAME);
            v.put(ContactsContract.Settings.ACCOUNT_TYPE, ACCOUNT_TYPE);
            v.put(ContactsContract.Settings.UNGROUPED_VISIBLE, 1);
            c.getContentResolver().insert(asAdapter(ContactsContract.Settings.CONTENT_URI), v);
        } catch (RuntimeException ignored) { /* already there */ }
    }

    /**
     * Links a username with the contact the user picked: the contact's own raw
     * contacts and a new one of ours with the M5cet rows are kept together.
     * An earlier link of the username is replaced.
     */
    public static Linked link(Context c, String username, Uri contactUri, String messageLabel, String callLabel) throws Exception {
        ContentResolver cr = c.getContentResolver();
        long contactId;
        String lookup, name;
        try (Cursor q = cr.query(contactUri, new String[]{Contacts._ID, Contacts.LOOKUP_KEY, Contacts.DISPLAY_NAME}, null, null, null)) {
            if (q == null || !q.moveToFirst()) throw new IllegalStateException("no such contact");
            contactId = q.getLong(0);
            lookup = q.getString(1);
            name = q.getString(2) == null ? "" : q.getString(2);
        }
        List<Long> theirs = new ArrayList<>();
        try (Cursor q = cr.query(RawContacts.CONTENT_URI, new String[]{RawContacts._ID, RawContacts.ACCOUNT_TYPE},
            RawContacts.CONTACT_ID + "=? AND " + RawContacts.DELETED + "=0", new String[]{Long.toString(contactId)}, null)) {
            while (q != null && q.moveToNext()) if (!ACCOUNT_TYPE.equals(q.getString(1))) theirs.add(q.getLong(0));
        }
        if (theirs.isEmpty()) throw new IllegalStateException("the contact has no entries");
        ensureAccount(c);
        remove(c, username);
        String key = Match.key(username);
        ArrayList<ContentProviderOperation> ops = new ArrayList<>();
        ops.add(ContentProviderOperation.newInsert(asAdapter(RawContacts.CONTENT_URI))
            .withValue(RawContacts.ACCOUNT_NAME, ACCOUNT_NAME).withValue(RawContacts.ACCOUNT_TYPE, ACCOUNT_TYPE)
            .withValue(RawContacts.SYNC1, key).withValue(RawContacts.SOURCE_ID, key).build());
        ops.add(ContentProviderOperation.newInsert(asAdapter(Data.CONTENT_URI)).withValueBackReference(Data.RAW_CONTACT_ID, 0)
            .withValue(Data.MIMETYPE, StructuredName.CONTENT_ITEM_TYPE).withValue(StructuredName.DISPLAY_NAME, name).build());
        ops.add(row(MIME_MESSAGE, username, messageLabel));
        ops.add(row(MIME_CALL, username, callLabel));
        for (long raw : theirs) {
            ops.add(ContentProviderOperation.newUpdate(AggregationExceptions.CONTENT_URI)
                .withValue(AggregationExceptions.TYPE, AggregationExceptions.TYPE_KEEP_TOGETHER)
                .withValue(AggregationExceptions.RAW_CONTACT_ID1, raw)
                .withValueBackReference(AggregationExceptions.RAW_CONTACT_ID2, 0).build());
        }
        ContentProviderResult[] done = cr.applyBatch(ContactsContract.AUTHORITY, ops);
        return new Linked(username, name, lookup == null ? "" : lookup, contactId, ContentUris.parseId(done[0].uri));
    }

    private static ContentProviderOperation row(String mime, String username, String label) {
        return ContentProviderOperation.newInsert(asAdapter(Data.CONTENT_URI)).withValueBackReference(Data.RAW_CONTACT_ID, 0)
            .withValue(Data.MIMETYPE, mime).withValue(Data.DATA1, username).withValue(Data.DATA2, "M5cet").withValue(Data.DATA3, label).build();
    }

    /** The contact a link pointed at, found again by its lookup key (contact ids change when contacts are joined); null when gone. */
    public static Uri contactOf(Context c, String lookup, long contactId) {
        if (lookup == null || lookup.isEmpty()) return null;
        try { return Contacts.lookupContact(c.getContentResolver(), Contacts.getLookupUri(contactId, lookup)); }
        catch (RuntimeException e) { return null; }
    }

    /** Removes the M5cet rows of a username (the contact itself stays as it was). */
    public static void remove(Context c, String username) {
        c.getContentResolver().delete(asAdapter(RawContacts.CONTENT_URI), RawContacts.ACCOUNT_TYPE + "=? AND " + RawContacts.SYNC1 + "=?",
            new String[]{ACCOUNT_TYPE, Match.key(username)});
    }

    /** Removes every M5cet row and the account (the integration switched off, the app wiped). */
    public static void removeAll(Context c) {
        try { c.getContentResolver().delete(asAdapter(RawContacts.CONTENT_URI), RawContacts.ACCOUNT_TYPE + "=?", new String[]{ACCOUNT_TYPE}); }
        catch (RuntimeException ignored) { /* no permission: the account's removal takes its rows */ }
        try { AccountManager.get(c).removeAccountExplicitly(account()); } catch (RuntimeException ignored) { }
    }

    /** The row the Contacts app opened; null when it is not one of ours. */
    public static Row rowOf(Context c, Uri dataUri) {
        ContentResolver cr = c.getContentResolver();
        String mime, username;
        long raw;
        try (Cursor q = cr.query(dataUri, new String[]{Data.MIMETYPE, Data.DATA1, Data.RAW_CONTACT_ID}, null, null, null)) {
            if (q == null || !q.moveToFirst()) return null;
            mime = q.getString(0);
            username = q.getString(1);
            raw = q.getLong(2);
        }
        if (!MIME_MESSAGE.equals(mime) && !MIME_CALL.equals(mime)) return null;
        try (Cursor q = cr.query(ContentUris.withAppendedId(RawContacts.CONTENT_URI, raw), new String[]{RawContacts.ACCOUNT_TYPE}, null, null, null)) {
            if (q == null || !q.moveToFirst() || !ACCOUNT_TYPE.equals(q.getString(0))) return null;
        }
        String user = Match.cleanUsername(username);
        return user.isEmpty() ? null : new Row(user, MIME_CALL.equals(mime) ? "call" : "message", raw);
    }

    /** The linked contact's photo (the thumbnail) for a username; null without one. */
    public static byte[] photo(Context c, String username) {
        ContentResolver cr = c.getContentResolver();
        long contactId = -1;
        try (Cursor q = cr.query(RawContacts.CONTENT_URI, new String[]{RawContacts.CONTACT_ID},
            RawContacts.ACCOUNT_TYPE + "=? AND " + RawContacts.SYNC1 + "=? AND " + RawContacts.DELETED + "=0", new String[]{ACCOUNT_TYPE, Match.key(username)}, null)) {
            if (q != null && q.moveToFirst()) contactId = q.getLong(0);
        }
        if (contactId < 0) return null;
        try (InputStream in = Contacts.openContactPhotoInputStream(cr, ContentUris.withAppendedId(Contacts.CONTENT_URI, contactId), false)) {
            if (in == null) return null;
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }
}
