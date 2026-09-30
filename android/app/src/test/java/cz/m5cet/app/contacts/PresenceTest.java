package cz.m5cet.app.contacts;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** The People widget's status and signal (RecipientsWidget.tsx latency(), UserInfoModal dur() / bytes()). */
public class PresenceTest {
    @Test
    public void statusFromWhatTheRoomKnows() {
        assertEquals(Presence.ONLINE, Presence.status("open", true, "off"));
        assertEquals(Presence.LIGHT, Presence.status("open", false, "off"));
        assertEquals(Presence.DND, Presence.status("open", true, "live"));
        assertEquals(Presence.DND, Presence.status("open", false, "muted"));
        assertEquals(Presence.AWAY, Presence.status("away", true, "off"));
        assertEquals(Presence.CONNECTING, Presence.status("connecting", true, "live"));
        assertEquals(Presence.OFFLINE, Presence.status("closed", true, "off"));
        assertEquals(Presence.OFFLINE, Presence.status(null, false, null));
    }

    @Test
    public void connectedFirstAwayNextTheRestLast() {
        assertEquals(0, Presence.rank(Presence.ONLINE));
        assertEquals(0, Presence.rank(Presence.LIGHT));
        assertEquals(0, Presence.rank(Presence.DND));
        assertEquals(1, Presence.rank(Presence.AWAY));
        assertEquals(2, Presence.rank(Presence.CONNECTING));
        assertEquals(3, Presence.rank(Presence.OFFLINE));
    }

    @Test
    public void iconsAndColours() {
        assertEquals("circle-check", Presence.icon(Presence.ONLINE));
        assertEquals("moon", Presence.icon(Presence.AWAY));
        assertEquals("circle-minus", Presence.icon(Presence.DND));
        assertEquals("circle-off", Presence.icon(Presence.OFFLINE));
        assertEquals("@success", Presence.color(Presence.ONLINE));
        assertEquals("@warning", Presence.color(Presence.AWAY));
        assertEquals("@danger", Presence.color(Presence.DND));
        assertEquals("@muted", Presence.color(Presence.CONNECTING));
    }

    @Test
    public void theWebsLatencyMeter() {
        assertEquals(0, Presence.bars(false, 20));
        assertEquals(2, Presence.bars(true, -1));
        assertEquals(4, Presence.bars(true, 0));
        assertEquals(4, Presence.bars(true, 59));
        assertEquals(3, Presence.bars(true, 60));
        assertEquals(3, Presence.bars(true, 119));
        assertEquals(2, Presence.bars(true, 120));
        assertEquals(2, Presence.bars(true, 249));
        assertEquals(1, Presence.bars(true, 250));
        assertEquals(1, Presence.bars(true, 5000));
    }

    @Test
    public void signalIconsAndTones() {
        assertEquals("signal-zero", Presence.signalIcon(0));
        assertEquals("signal-low", Presence.signalIcon(1));
        assertEquals("signal-medium", Presence.signalIcon(2));
        assertEquals("signal-high", Presence.signalIcon(3));
        assertEquals("signal", Presence.signalIcon(4));
        assertEquals("off", Presence.tone(0));
        assertEquals("bad", Presence.tone(1));
        assertEquals("ok", Presence.tone(2));
        assertEquals("ok", Presence.tone(3));
        assertEquals("good", Presence.tone(4));
        assertEquals("@muted", Presence.signalColor(0));
        assertEquals("@danger", Presence.signalColor(1));
        assertEquals("@warning", Presence.signalColor(3));
        assertEquals("@success", Presence.signalColor(4));
    }

    @Test
    public void transport() {
        assertEquals("", Presence.transport("", ""));
        assertEquals("direct", Presence.transport("host", "srflx"));
        assertEquals("direct", Presence.transport("prflx", "host"));
        assertEquals("relay", Presence.transport("relay", "srflx"));
        assertEquals("relay", Presence.transport("host", "relay"));
    }

    @Test
    public void durationsAndBytesAsTheWebWritesThem() {
        assertEquals("—", Presence.duration(-1, "h", "min", "s"));
        assertEquals("0 s", Presence.duration(999, "h", "min", "s"));
        assertEquals("40 s", Presence.duration(40_000, "h", "min", "s"));
        assertEquals("3 min 12 s", Presence.duration(192_000, "h", "min", "s"));
        assertEquals("2 h 5 min", Presence.duration(7_500_000, "h", "min", "s"));
        assertEquals("512 B", Presence.bytes(512));
        assertEquals("1.5 kB", Presence.bytes(1536));
        assertEquals("2.25 MB", Presence.bytes(2_359_296));
    }
}
