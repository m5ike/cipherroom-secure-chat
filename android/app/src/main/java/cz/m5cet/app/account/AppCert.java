package cz.m5cet.app.account;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.os.Build;

import java.util.Locale;

import cz.m5cet.app.security.Crypto;

/**
 * This app's signing certificate (6.4): what a server's
 * /.well-known/assetlinks.json has to list next to the package name before
 * the phone's Credential Manager uses the server's passkeys here. The check-in
 * reports it (the console can then trust it), and the "server hasn't
 * confirmed the app" dialog shows it to be passed on to the operator.
 */
public final class AppCert {
    private AppCert() {}

    private static volatile String cached;

    /** SHA-256 of the current signing certificate, 64 lowercase hex characters ("" when the system does not say). Computed once. */
    public static String sha256(Context c) {
        String s = cached;
        if (s != null) return s;
        try {
            PackageManager pm = c.getPackageManager();
            PackageInfo pi = Build.VERSION.SDK_INT >= 33
                ? pm.getPackageInfo(c.getPackageName(), PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES))
                : pm.getPackageInfo(c.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            SigningInfo si = pi.signingInfo;
            if (si == null) return "";
            // Several signers: the APK's own; one signer: its rotation history, the current one last.
            Signature[] sigs = si.hasMultipleSigners() ? si.getApkContentsSigners() : si.getSigningCertificateHistory();
            if (sigs == null || sigs.length == 0) return "";
            s = of(sigs[si.hasMultipleSigners() ? 0 : sigs.length - 1].toByteArray());
        } catch (PackageManager.NameNotFoundException | RuntimeException e) {
            return "";
        }
        cached = s;
        return s;
    }

    /** SHA-256 of a DER certificate as lowercase hex. */
    static String of(byte[] der) { return Crypto.hex(Crypto.sha256(der)); }

    /** "3cf2ab…" → "3C:F2:AB:…" (how assetlinks.json and the console write a fingerprint). */
    public static String colons(String hex) {
        String h = hex == null ? "" : hex.replaceAll("[^0-9A-Fa-f]", "").toUpperCase(Locale.ROOT);
        StringBuilder b = new StringBuilder(h.length() * 3 / 2);
        for (int i = 0; i + 1 < h.length(); i += 2) b.append(i > 0 ? ":" : "").append(h, i, i + 2);
        return b.toString();
    }
}
