package cz.m5cet.app.account;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** What a Credential Manager failure means for the account flow (Passkeys.codeOf). */
public class PasskeysTest {
    @Test
    public void codes() {
        assertEquals("cancelled", Passkeys.codeOf("GetCredentialCancellationException", "android.credentials.GetCredentialException.TYPE_USER_CANCELED", ""));
        assertEquals("cancelled", Passkeys.codeOf("CreateCredentialCancellationException", "android.credentials.CreateCredentialException.TYPE_USER_CANCELED", ""));
        assertEquals("cancelled", Passkeys.codeOf("GetPublicKeyCredentialDomException", "androidx.credentials.TYPE_GET_PUBLIC_KEY_CREDENTIAL_DOM_EXCEPTION/androidx.credentials.TYPE_NOT_ALLOWED_ERROR", "androidx.credentials.TYPE_NOT_ALLOWED_ERROR"));
        assertEquals("no-passkey", Passkeys.codeOf("NoCredentialException", "android.credentials.GetCredentialException.TYPE_NO_CREDENTIAL", ""));
        assertEquals("unsupported", Passkeys.codeOf("GetCredentialProviderConfigurationException", "x", ""));
        assertEquals("unsupported", Passkeys.codeOf("CreateCredentialNoCreateOptionException", "x", ""));
        assertEquals("unsupported", Passkeys.codeOf("GetCredentialUnsupportedException", "x", ""));
        assertEquals("exists", Passkeys.codeOf("CreatePublicKeyCredentialDomException", "x", "androidx.credentials.TYPE_INVALID_STATE_ERROR"));
        assertEquals("", Passkeys.codeOf("GetCredentialUnknownException", "x", ""));
        assertEquals("", Passkeys.codeOf(null, null, null));
    }
}
