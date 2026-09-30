package cz.m5cet.app.nfc;

import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

/**
 * Minimal PC/SC CCID (USB chip-card interface, class 0x0B) framing (6.3): power
 * a card on to get its ATR, and exchange APDUs with PC_to_RDR_XfrBlock. Enough
 * for an ACR122U / ACR1252 style reader over USB host; vendor escape commands
 * (for MIFARE Classic auth on those readers) are not implemented here.
 */
final class Ccid {
    private final UsbDeviceConnection conn;
    private final UsbEndpoint in;
    private final UsbEndpoint out;
    private byte seq = 0;
    private static final int TIMEOUT = 3000;

    Ccid(UsbDeviceConnection conn, UsbEndpoint in, UsbEndpoint out) {
        this.conn = conn; this.in = in; this.out = out;
    }

    /** PC_to_RDR_IccPowerOn → the card's ATR (its RDR_to_PC_DataBlock payload). */
    byte[] powerOn() throws IOException {
        byte s = seq++;
        byte[] msg = {0x62, 0, 0, 0, 0, 0, s, 0 /*bPowerSelect auto*/, 0, 0};
        send(msg);
        return dataBlock();
    }

    void powerOff() {
        try {
            byte s = seq++;
            send(new byte[]{0x63, 0, 0, 0, 0, 0, s, 0, 0, 0});
            read(); // consume the SlotStatus reply
        } catch (IOException ignored) { }
    }

    /** PC_to_RDR_XfrBlock with the APDU → the card's response (with SW). */
    byte[] transceive(byte[] apdu) throws IOException {
        byte s = seq++;
        int len = apdu.length;
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.write(0x6F);
        b.write(len & 0xff); b.write((len >>> 8) & 0xff); b.write((len >>> 16) & 0xff); b.write((len >>> 24) & 0xff);
        b.write(0); // slot
        b.write(s); // seq
        b.write(0); // bBWI
        b.write(0); b.write(0); // wLevelParameter
        b.write(apdu, 0, apdu.length);
        send(b.toByteArray());
        return dataBlock();
    }

    private void send(byte[] msg) throws IOException {
        int n = conn.bulkTransfer(out, msg, msg.length, TIMEOUT);
        if (n < 0) throw new IOException("CCID write failed");
    }

    /** Reads one CCID reply and returns the abData payload (after the 10-byte header). */
    private byte[] dataBlock() throws IOException {
        byte[] reply = read();
        if (reply.length < 10) throw new IOException("short CCID reply");
        int dw = (reply[1] & 0xff) | ((reply[2] & 0xff) << 8) | ((reply[3] & 0xff) << 16) | ((reply[4] & 0xff) << 24);
        int status = reply[7] & 0xff;
        if ((status & 0xC0) != 0) throw new IOException("CCID slot error 0x" + Integer.toHexString(reply[8] & 0xff));
        byte[] data = new byte[Math.max(0, Math.min(dw, reply.length - 10))];
        System.arraycopy(reply, 10, data, 0, data.length);
        return data;
    }

    private byte[] read() throws IOException {
        byte[] buf = new byte[512];
        int n = conn.bulkTransfer(in, buf, buf.length, TIMEOUT);
        if (n < 0) throw new IOException("CCID read timed out");
        byte[] out = new byte[n];
        System.arraycopy(buf, 0, out, 0, n);
        return out;
    }
}
