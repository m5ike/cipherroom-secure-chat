package cz.m5cet.app.chat;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** What a message to send is made of (6.1): text, reply, attachment, kind, recipients, expiry, position, command output. */
public final class Outgoing {
    public String text = "";
    public ChatMessage replyTo;
    // An inline attachment (small files and pictures): a data URL with the safe type.
    public String fileName, fileMime, dataUrl;
    public long fileSize;
    public boolean fileImage;
    // The web's message kinds (flags); they combine.
    public boolean tap;
    public int vanishSeconds;
    /** Seal with this code (null = not sealed; "" = a new random code). */
    public String sealCode;
    /** Private: only these peers (ids) get it; their names go into "to". Empty = everyone. */
    public final Set<String> recipients = new LinkedHashSet<>();
    public final List<String> recipientNames = new ArrayList<>();
    /** Absolute expiry (the room's default), 0 = none. */
    public int ttlMinutes;
    /** The position in the header (loc). */
    public JSONObject loc;
    /** A command's result for the room (flags.fn) and "forwarded from /keyword". */
    public JSONObject fn;
    /** The command result kept on this device (every output); {@link #fn} is what goes on the wire. */
    public JSONObject fnLocal;
    public String forwardedFrom;
    /** A transcript's recording (audio ↔ text calls): kept locally for the "source" icon. */
    public String sourceAudio;
}
