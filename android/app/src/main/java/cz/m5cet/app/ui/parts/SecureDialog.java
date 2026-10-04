package cz.m5cet.app.ui.parts;

import android.app.Activity;
import android.app.AlertDialog;
import android.view.WindowManager;

/**
 * 6.7 (audit N18): a dialog is its own window — without FLAG_SECURE it shows
 * up in screenshots, screen recordings and the recent-apps thumbnail even
 * though the app's window does not. A dialog with secrets (a PIN, a Wi-Fi
 * password, the MRZ/CAN of a document, a safety number) takes the app's flag.
 */
final class SecureDialog {
    private SecureDialog() {}

    static AlertDialog show(Activity a, AlertDialog.Builder b) {
        AlertDialog d = b.create();
        if ((a.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0 && d.getWindow() != null)
            d.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        d.show();
        return d;
    }
}
