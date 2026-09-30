package cz.m5cet.app.nfc;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * A PC/SC (CCID) reader over USB host (6.3) — e.g. ACR122U / ACR1252U. It
 * enumerates the connected readers, asks for USB permission, and speaks APDUs
 * through {@link Ccid}. ISO-DEP / EMV / DESFire flows in {@link CardOps} can run
 * over this {@link Reader.ApduChannel}; storage-card auth (MIFARE Classic) needs
 * a reader's vendor escape and is not implemented.
 *
 * On-device verification needs a real CCID reader and an OTG cable; the manifest
 * declares android.hardware.usb.host.
 */
public final class UsbReader implements Reader, Reader.ApduChannel {
    /** ACS is the common vendor id for hobbyist NFC readers; kept only for naming. */
    static final int VID_ACS = 0x072F;
    private static final String ACTION_PERMISSION = "cz.m5cet.app.nfc.USB_PERMISSION";

    private final Context context;
    private final UsbDevice device;
    private UsbDeviceConnection connection;
    private UsbInterface iface;
    private Ccid ccid;
    private byte[] atr;

    public UsbReader(Context context, UsbDevice device) { this.context = context.getApplicationContext(); this.device = device; }

    @Override public String kind() { return NfcCatalog.READER_USB; }
    @Override public String name() {
        String n = device.getProductName();
        return n != null && !n.isEmpty() ? n : (device.getVendorId() == VID_ACS ? "ACS reader" : "USB reader");
    }
    @Override public boolean available(Context c) { return manager(c) != null; }

    public UsbDevice device() { return device; }

    private static UsbManager manager(Context c) { return (UsbManager) c.getSystemService(Context.USB_SERVICE); }

    /** The CCID (chip-card interface, class 0x0B) readers currently attached. */
    public static List<UsbReader> attached(Context c) {
        List<UsbReader> out = new ArrayList<>();
        UsbManager m = manager(c);
        if (m == null) return out;
        for (UsbDevice d : m.getDeviceList().values()) {
            if (ccidInterface(d) != null) out.add(new UsbReader(c, d));
        }
        return out;
    }

    static UsbInterface ccidInterface(UsbDevice d) {
        for (int i = 0; i < d.getInterfaceCount(); i++) {
            UsbInterface u = d.getInterface(i);
            if (u.getInterfaceClass() == 0x0B) return u; // USB CCID / smart-card class
        }
        // Some readers (e.g. ACR122U) expose a vendor-specific class; accept them by vendor id.
        if (d.getVendorId() == VID_ACS && d.getInterfaceCount() > 0) return d.getInterface(0);
        return null;
    }

    public boolean hasPermission() {
        UsbManager m = manager(context);
        return m != null && m.hasPermission(device);
    }

    /** Ask the user for USB permission (the system dialog); the callback fires when they answer. */
    public interface Permission { void granted(boolean ok); }

    public void requestPermission(Permission cb) {
        UsbManager m = manager(context);
        if (m == null) { cb.granted(false); return; }
        if (m.hasPermission(device)) { cb.granted(true); return; }
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent intent) {
                context.unregisterReceiver(this);
                cb.granted(intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false));
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_PERMISSION);
        // The permission broadcast is explicit (our own package); Android 13+ still wants the flag.
        if (android.os.Build.VERSION.SDK_INT >= 33) context.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED);
        else context.registerReceiver(r, filter);
        // The PendingIntent must be mutable on Android 12+ so UsbManager can fill in the result extras.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (android.os.Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        PendingIntent pi = PendingIntent.getBroadcast(context, 0, new Intent(ACTION_PERMISSION).setPackage(context.getPackageName()), flags);
        m.requestPermission(device, pi);
    }

    /* -------------------------------------------------------- ApduChannel */

    @Override public boolean connect() throws IOException {
        UsbManager m = manager(context);
        if (m == null || !m.hasPermission(device)) throw new IOException("USB reader not permitted");
        iface = ccidInterface(device);
        if (iface == null) throw new IOException("no CCID interface");
        connection = m.openDevice(device);
        if (connection == null || !connection.claimInterface(iface, true)) throw new IOException("cannot open USB reader");
        UsbEndpoint in = null, out = null;
        for (int i = 0; i < iface.getEndpointCount(); i++) {
            UsbEndpoint e = iface.getEndpoint(i);
            if (e.getType() != UsbConstants.USB_ENDPOINT_XFER_BULK) continue;
            if (e.getDirection() == UsbConstants.USB_DIR_IN) in = e; else out = e;
        }
        if (in == null || out == null) throw new IOException("no bulk endpoints");
        ccid = new Ccid(connection, in, out);
        atr = ccid.powerOn();
        return atr != null;
    }

    @Override public byte[] atr() { return atr; }

    @Override public byte[] transceive(byte[] apdu) throws IOException {
        if (ccid == null) throw new IOException("not connected");
        return ccid.transceive(apdu);
    }

    @Override public void disconnect() {
        if (ccid != null) ccid.powerOff();
        if (connection != null && iface != null) try { connection.releaseInterface(iface); } catch (RuntimeException ignored) { }
        if (connection != null) connection.close();
        ccid = null; connection = null; iface = null; atr = null;
    }
}
