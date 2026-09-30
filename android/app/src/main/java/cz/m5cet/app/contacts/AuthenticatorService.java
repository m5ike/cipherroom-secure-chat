package cz.m5cet.app.contacts;

import android.accounts.AbstractAccountAuthenticator;
import android.accounts.Account;
import android.accounts.AccountAuthenticatorResponse;
import android.accounts.AccountManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.IBinder;

/**
 * 6.2 Contacts: the authenticator of the app's account type. The account
 * only carries the rows that link M5cet people to the phone's contacts
 * (AddressBook adds it itself); it has no password, no tokens, and cannot be
 * added from the phone's settings.
 */
public final class AuthenticatorService extends Service {
    private Authenticator authenticator;

    @Override public void onCreate() { authenticator = new Authenticator(this); }

    @Override public IBinder onBind(Intent intent) { return authenticator.getIBinder(); }

    static final class Authenticator extends AbstractAccountAuthenticator {
        Authenticator(Context c) { super(c); }

        private static Bundle unsupported() {
            Bundle b = new Bundle();
            b.putInt(AccountManager.KEY_ERROR_CODE, AccountManager.ERROR_CODE_UNSUPPORTED_OPERATION);
            b.putString(AccountManager.KEY_ERROR_MESSAGE, "M5cet links contacts from inside the app");
            return b;
        }

        @Override public Bundle editProperties(AccountAuthenticatorResponse r, String type) { return unsupported(); }
        @Override public Bundle addAccount(AccountAuthenticatorResponse r, String type, String tokenType, String[] features, Bundle options) { return unsupported(); }
        @Override public Bundle confirmCredentials(AccountAuthenticatorResponse r, Account a, Bundle options) { return unsupported(); }
        @Override public Bundle getAuthToken(AccountAuthenticatorResponse r, Account a, String tokenType, Bundle options) { return unsupported(); }
        @Override public String getAuthTokenLabel(String tokenType) { return null; }
        @Override public Bundle updateCredentials(AccountAuthenticatorResponse r, Account a, String tokenType, Bundle options) { return unsupported(); }

        @Override public Bundle hasFeatures(AccountAuthenticatorResponse r, Account a, String[] features) {
            Bundle b = new Bundle();
            b.putBoolean(AccountManager.KEY_BOOLEAN_RESULT, false);
            return b;
        }
    }
}
