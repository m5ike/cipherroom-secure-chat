package cz.m5cet.app.net;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Locale;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

import cz.m5cet.app.BuildConfig;
import cz.m5cet.app.security.Crypto;

/**
 * A small RFC 6455 WebSocket client (text and binary messages, ping/pong,
 * fragmentation, close) — the signaling connection needs nothing more, and
 * it keeps the app free of a networking library. TLS uses the platform's
 * trust store, SNI and hostname verification. No Origin header is sent (the
 * server accepts native clients without one).
 */
public final class WebSocket {
    public interface Listener {
        void onOpen(WebSocket ws);
        void onText(WebSocket ws, String text);
        void onBinary(WebSocket ws, byte[] data);
        /** code 1006 = the connection dropped without a close frame. */
        void onClose(WebSocket ws, int code, String reason);
    }

    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int MAX_MESSAGE = 1 << 20;

    private final URI uri;
    private final Listener listener;
    private Socket socket;
    private OutputStream out;
    private volatile boolean closed;
    private volatile boolean closeSent;

    public WebSocket(String url, Listener listener) {
        this.uri = URI.create(url);
        this.listener = listener;
    }

    /** Connects and reads on its own thread; the listener hears everything. */
    public void connect() {
        Thread t = new Thread(this::run, "m5-ws");
        t.setDaemon(true);
        t.start();
    }

    private void run() {
        int code = 1006;
        String reason = "";
        try {
            boolean tls = uri.getScheme().toLowerCase(Locale.ROOT).equals("wss");
            String host = uri.getHost();
            int port = uri.getPort() > 0 ? uri.getPort() : tls ? 443 : 80;
            Socket s = new Socket();
            s.connect(new InetSocketAddress(host, port), 15_000);
            s.setTcpNoDelay(true);
            s.setKeepAlive(true);
            if (tls) {
                SSLSocket ssl = (SSLSocket) ((SSLSocketFactory) SSLSocketFactory.getDefault()).createSocket(s, host, port, true);
                SSLParameters params = ssl.getSSLParameters();
                params.setServerNames(java.util.Collections.singletonList(new SNIHostName(host)));
                ssl.setSSLParameters(params);
                ssl.startHandshake();
                if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ssl.getSession())) throw new IOException("the certificate is not for " + host);
                s = ssl;
            }
            socket = s;
            out = s.getOutputStream();
            InputStream in = new BufferedInputStream(s.getInputStream());
            handshake(in, host, port, tls);
            s.setSoTimeout(0);
            listener.onOpen(this);
            int[] closeInfo = readLoop(in);
            code = closeInfo[0];
            reason = closeReason;
        } catch (IOException | RuntimeException e) {
            reason = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        } finally {
            closed = true;
            try { if (socket != null) socket.close(); } catch (IOException ignored) { }
            listener.onClose(this, code, reason);
        }
    }

    private void handshake(InputStream in, String host, int port, boolean tls) throws IOException {
        byte[] nonce = Crypto.random(16);
        String key = Base64.getEncoder().encodeToString(nonce);
        String path = (uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath()) + (uri.getRawQuery() != null ? "?" + uri.getRawQuery() : "");
        boolean defaultPort = (tls && port == 443) || (!tls && port == 80);
        String req = "GET " + path + " HTTP/1.1\r\n"
            + "Host: " + host + (defaultPort ? "" : ":" + port) + "\r\n"
            + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n"
            + "User-Agent: M5cet-Android/" + BuildConfig.VERSION_NAME + "\r\n\r\n";
        synchronized (this) { out.write(req.getBytes(StandardCharsets.US_ASCII)); out.flush(); }
        String status = readLine(in);
        if (!status.startsWith("HTTP/1.1 101")) throw new IOException("the server refused the WebSocket: " + status);
        String accept = null;
        for (String line; !(line = readLine(in)).isEmpty(); ) {
            int colon = line.indexOf(':');
            if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase("Sec-WebSocket-Accept")) accept = line.substring(colon + 1).trim();
        }
        try {
            String expected = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest((key + GUID).getBytes(StandardCharsets.US_ASCII)));
            if (!expected.equals(accept)) throw new IOException("bad Sec-WebSocket-Accept");
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 8192) throw new IOException("header line too long");
        }
        if (c == -1 && sb.length() == 0) throw new IOException("the connection closed during the handshake");
        return sb.toString();
    }

    private String closeReason = "";

    private int[] readLoop(InputStream in) throws IOException {
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        int messageOp = -1;
        while (true) {
            int b0 = in.read();
            if (b0 < 0) return new int[]{1006};
            int b1 = in.read();
            if (b1 < 0) return new int[]{1006};
            boolean fin = (b0 & 0x80) != 0;
            int op = b0 & 0x0f;
            boolean masked = (b1 & 0x80) != 0;
            long len = b1 & 0x7f;
            if (len == 126) len = ((long) readByte(in) << 8) | readByte(in);
            else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in); }
            if (len > MAX_MESSAGE) throw new IOException("frame too large");
            byte[] mask = masked ? readFully(in, 4) : null;
            byte[] payload = readFully(in, (int) len);
            if (mask != null) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            switch (op) {
                case 0x9: sendFrame(0xA, payload); break; // ping → pong
                case 0xA: break; // pong
                case 0x8: {
                    int code = payload.length >= 2 ? ((payload[0] & 0xff) << 8) | (payload[1] & 0xff) : 1005;
                    closeReason = payload.length > 2 ? new String(payload, 2, payload.length - 2, StandardCharsets.UTF_8) : "";
                    if (!closeSent) { try { sendFrame(0x8, payload.length >= 2 ? java.util.Arrays.copyOf(payload, 2) : new byte[0]); } catch (IOException ignored) { } }
                    return new int[]{code};
                }
                case 0x0: case 0x1: case 0x2: {
                    if (op != 0) { messageOp = op; message.reset(); }
                    message.write(payload);
                    if (message.size() > MAX_MESSAGE) throw new IOException("message too large");
                    if (fin) {
                        byte[] data = message.toByteArray();
                        message.reset();
                        if (messageOp == 0x1) listener.onText(this, new String(data, StandardCharsets.UTF_8));
                        else if (messageOp == 0x2) listener.onBinary(this, data);
                    }
                    break;
                }
                default: throw new IOException("unknown opcode " + op);
            }
        }
    }

    private static int readByte(InputStream in) throws IOException {
        int b = in.read();
        if (b < 0) throw new IOException("unexpected end of stream");
        return b;
    }

    private static byte[] readFully(InputStream in, int n) throws IOException {
        byte[] b = new byte[n];
        int at = 0;
        while (at < n) {
            int r = in.read(b, at, n - at);
            if (r < 0) throw new IOException("unexpected end of stream");
            at += r;
        }
        return b;
    }

    private synchronized void sendFrame(int op, byte[] payload) throws IOException {
        if (out == null) throw new IOException("not connected");
        ByteArrayOutputStream f = new ByteArrayOutputStream(payload.length + 14);
        f.write(0x80 | op);
        if (payload.length < 126) f.write(0x80 | payload.length);
        else if (payload.length < 65536) { f.write(0x80 | 126); f.write(payload.length >>> 8); f.write(payload.length & 0xff); }
        else { f.write(0x80 | 127); for (int i = 7; i >= 0; i--) f.write((int) (((long) payload.length >>> (8 * i)) & 0xff)); }
        byte[] mask = Crypto.random(4);
        f.write(mask);
        for (int i = 0; i < payload.length; i++) f.write(payload[i] ^ mask[i & 3]);
        out.write(f.toByteArray());
        out.flush();
    }

    /** False when the connection is gone. */
    public boolean send(String text) {
        if (closed) return false;
        try { sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8)); return true; }
        catch (IOException e) { abort(); return false; }
    }

    public boolean sendBinary(byte[] data) {
        if (closed) return false;
        try { sendFrame(0x2, data); return true; }
        catch (IOException e) { abort(); return false; }
    }

    public void close(int code, String reason) {
        if (closed || closeSent) return;
        closeSent = true;
        byte[] r = reason.getBytes(StandardCharsets.UTF_8);
        byte[] p = new byte[2 + Math.min(r.length, 120)];
        p[0] = (byte) (code >>> 8);
        p[1] = (byte) code;
        System.arraycopy(r, 0, p, 2, p.length - 2);
        try { sendFrame(0x8, p); } catch (IOException e) { abort(); }
        // The read loop ends when the server answers; a stuck server is cut after 3 s.
        cz.m5cet.app.core.Io.later(this::abort, 3000);
    }

    public void abort() {
        closed = true;
        try { if (socket != null) socket.close(); } catch (IOException ignored) { }
    }

    public boolean isOpen() { return !closed && out != null; }
}
