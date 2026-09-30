package cz.m5cet.app.contacts;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.provider.ContactsContract;

import cz.m5cet.app.M5;
import cz.m5cet.app.core.Io;
import cz.m5cet.app.core.Log;

/**
 * 6.2 Contacts: "Propojit s kontaktem" — a see-through activity that opens
 * the phone's contact picker, links the chosen contact with the person's
 * username (AddressBook, then Store) and hands the result back. It keeps the
 * picker's result away from MainActivity.
 */
public final class LinkActivity extends Activity {
    /** On the main thread: the link, or an error; both null = the user picked nobody. */
    public interface Done { void linked(AddressBook.Linked link, Exception error); }

    private static final String USER = "username", MESSAGE = "message", CALL = "call";
    private static final int PICK = 1;
    private static Done done;

    /** Links a username with a contact the user picks; the labels are the rows' texts in the Contacts app. */
    public static void start(Activity from, String username, String messageLabel, String callLabel, Done then) {
        done = then;
        from.startActivity(new Intent(from, LinkActivity.class).putExtra(USER, username).putExtra(MESSAGE, messageLabel).putExtra(CALL, callLabel));
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null) return; // the picker is already open (the activity was recreated)
        try { startActivityForResult(new Intent(Intent.ACTION_PICK, ContactsContract.Contacts.CONTENT_URI), PICK); }
        catch (ActivityNotFoundException e) { end(null, e); }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != PICK) return;
        Uri contact = data == null ? null : data.getData();
        if (result != RESULT_OK || contact == null) { end(null, null); return; }
        String user = getIntent().getStringExtra(USER), message = getIntent().getStringExtra(MESSAGE), call = getIntent().getStringExtra(CALL);
        android.content.Context ctx = getApplicationContext();
        Io.bg(() -> {
            try {
                AddressBook.Linked l = AddressBook.link(ctx, user, contact, message == null ? "M5cet" : message, call == null ? "M5cet" : call);
                Store.putLink(M5.get(), l);
                Log.i("people", "linked a contact");
                Io.main(() -> end(l, null));
            } catch (Exception e) {
                Log.e("people", "linking failed", e);
                Io.main(() -> end(null, e));
            }
        });
    }

    private void end(AddressBook.Linked l, Exception e) {
        Done d = done;
        done = null;
        finish();
        if (d != null) d.linked(l, e);
    }
}
