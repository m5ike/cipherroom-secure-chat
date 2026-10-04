package cz.m5cet.app.account;

import android.app.Activity;
import android.os.CancellationSignal;

import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException;
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.Locale;

import cz.m5cet.app.core.Log;

/**
 * The Credential Manager ceremonies (androidx.credentials): create a passkey,
 * get an assertion. Both run on the main thread with the activity and answer
 * there; failures come with a short code the account flow acts on.
 */
final class Passkeys {
    private Passkeys() {}

    interface Result {
        void ok(JSONObject credential);
        void failed(String code, String message);
    }

    static void create(Activity activity, JSONObject options, Result r) {
        if (activity.isFinishing() || activity.isDestroyed()) { r.failed("cancelled", "the app was closed"); return; }
        CreatePublicKeyCredentialRequest req;
        try { req = new CreatePublicKeyCredentialRequest(options.toString()); }
        catch (IllegalArgumentException e) { r.failed("", String.valueOf(e.getMessage())); return; }
        CredentialManager.create(activity).createCredentialAsync(activity, req, new CancellationSignal(), activity.getMainExecutor(),
            new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                @Override public void onResult(CreateCredentialResponse response) {
                    if (!(response instanceof CreatePublicKeyCredentialResponse)) { r.failed("", "not a passkey"); return; }
                    try { r.ok(new JSONObject(((CreatePublicKeyCredentialResponse) response).getRegistrationResponseJson())); }
                    catch (JSONException e) { r.failed("", "the passkey's answer is not JSON"); }
                }
                @Override public void onError(CreateCredentialException e) {
                    // 6.7 (lint RestrictedApi): getType()/getErrorMessage() are internal to androidx.credentials —
                    // the class names say the same (DomError subclasses: SecurityError, NotAllowedError…).
                    String dom = e instanceof CreatePublicKeyCredentialDomException ? ((CreatePublicKeyCredentialDomException) e).getDomError().getClass().getSimpleName() : "";
                    String kind = e.getClass().getSimpleName();
                    Log.w("account", "passkey create: " + kind + " " + dom + " " + e.getMessage());
                    r.failed(codeOf(kind, "", dom, e.getMessage()), e.getMessage() == null ? kind : e.getMessage());
                }
            });
    }

    static void get(Activity activity, JSONObject request, Result r) {
        if (activity.isFinishing() || activity.isDestroyed()) { r.failed("cancelled", "the app was closed"); return; }
        GetCredentialRequest req;
        try { req = new GetCredentialRequest(Collections.singletonList(new GetPublicKeyCredentialOption(request.toString()))); }
        catch (IllegalArgumentException e) { r.failed("", String.valueOf(e.getMessage())); return; }
        CredentialManager.create(activity).getCredentialAsync(activity, req, new CancellationSignal(), activity.getMainExecutor(),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override public void onResult(GetCredentialResponse response) {
                    if (!(response.getCredential() instanceof PublicKeyCredential)) { r.failed("", "not a passkey"); return; }
                    try { r.ok(new JSONObject(((PublicKeyCredential) response.getCredential()).getAuthenticationResponseJson())); }
                    catch (JSONException e) { r.failed("", "the passkey's answer is not JSON"); }
                }
                @Override public void onError(GetCredentialException e) {
                    String dom = e instanceof GetPublicKeyCredentialDomException ? ((GetPublicKeyCredentialDomException) e).getDomError().getClass().getSimpleName() : "";
                    String kind = e.getClass().getSimpleName();
                    Log.w("account", "passkey get: " + kind + " " + dom + " " + e.getMessage());
                    r.failed(codeOf(kind, "", dom, e.getMessage()), e.getMessage() == null ? kind : e.getMessage());
                }
            });
    }

    static String codeOf(String exceptionClass, String type, String domError) { return codeOf(exceptionClass, type, domError, null); }

    /**
     * What a Credential Manager failure means for the flow: "rp-unverified"
     * (6.4: the server's domain does not vouch for this app — no
     * /.well-known/assetlinks.json listing its package and signing
     * certificate: WebAuthn's SecurityError, "The incoming request cannot be
     * validated"), "cancelled" (the person closed the sheet, or the provider
     * refused — WebAuthn's NotAllowedError), "no-passkey" (none for this
     * server on the phone), "unsupported" (no provider can do it), "exists"
     * (this passkey is already there), else "".
     */
    static String codeOf(String exceptionClass, String type, String domError, String message) {
        String c = exceptionClass == null ? "" : exceptionClass, t = type == null ? "" : type, d = domError == null ? "" : domError;
        String m = message == null ? "" : message.toLowerCase(Locale.ROOT);
        // A DOM error comes as its type ("…TYPE_SECURITY_ERROR") or, since 6.7, as its class name ("SecurityError").
        if (d.endsWith("TYPE_SECURITY_ERROR") || d.equals("SecurityError") || t.endsWith("TYPE_SECURITY_ERROR") || m.contains("cannot be validated")) return "rp-unverified";
        if (c.contains("Cancellation") || t.endsWith("TYPE_USER_CANCELED") || d.endsWith("TYPE_NOT_ALLOWED_ERROR") || d.equals("NotAllowedError")) return "cancelled";
        if (c.equals("NoCredentialException") || t.endsWith("TYPE_NO_CREDENTIAL")) return "no-passkey";
        if (c.contains("ProviderConfiguration") || c.contains("Unsupported") || c.contains("NoCreateOption")) return "unsupported";
        if (d.endsWith("TYPE_INVALID_STATE_ERROR") || d.equals("InvalidStateError")) return "exists";
        return "";
    }
}
