package cz.m5cet.app.security;

import android.app.Activity;
import android.content.Context;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;

import javax.crypto.Cipher;

/**
 * The platform's BiometricPrompt, always with a CryptoObject: a success
 * hands back a cipher the Keystore unlocked for exactly one operation — the
 * data key is decrypted by the hardware, not merely "allowed".
 */
public final class Biometric {
    private Biometric() {}

    public interface Callback {
        void success(Cipher cipher);
        /** A finger / face that did not match (the prompt stays open). */
        void rejected();
        /** Cancelled, the PIN button, or the system's own lock-out. */
        void error(int code, CharSequence message);
    }

    public static boolean available(Context ctx) {
        BiometricManager bm = ctx.getSystemService(BiometricManager.class);
        if (bm == null) return false;
        if (Build.VERSION.SDK_INT >= 30) return bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS;
        //noinspection deprecation
        return bm.canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS;
    }

    public static CancellationSignal prompt(Activity activity, Cipher cipher, String title, String subtitle, String negative, Callback cb) {
        BiometricPrompt.Builder b = new BiometricPrompt.Builder(activity)
            .setTitle(title)
            .setNegativeButton(negative, activity.getMainExecutor(), (d, w) -> cb.error(BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED, negative));
        if (subtitle != null && !subtitle.isEmpty()) b.setSubtitle(subtitle);
        if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        b.setConfirmationRequired(false);
        CancellationSignal cancel = new CancellationSignal();
        b.build().authenticate(new BiometricPrompt.CryptoObject(cipher), cancel, activity.getMainExecutor(), new BiometricPrompt.AuthenticationCallback() {
            @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                BiometricPrompt.CryptoObject co = result.getCryptoObject();
                if (co != null && co.getCipher() != null) cb.success(co.getCipher());
                else cb.error(-1, "no cipher");
            }
            @Override public void onAuthenticationFailed() { cb.rejected(); }
            @Override public void onAuthenticationError(int code, CharSequence message) { cb.error(code, message); }
        });
        return cancel;
    }
}
