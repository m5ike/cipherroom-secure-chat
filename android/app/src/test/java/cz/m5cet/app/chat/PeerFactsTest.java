package cz.m5cet.app.chat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

/** What a room learns of its people from the server's frames (hub.ts, relay.ts) and the hellos. */
public class PeerFactsTest {
    private static JSONObject j(String s) { try { return new JSONObject(s); } catch (Exception e) { throw new IllegalStateException(e); } }

    @Test
    public void signedInConnectionsAndAwayMembersFromJoined() {
        PeerFacts f = new PeerFacts();
        f.onFrame(j("{type:'joined', peerId:'me', peers:[{peerId:'p1', name:'Alice', account:'ref-a', accountId:'ref-a'}, {peerId:'p2', name:'Bob'}],"
            + " away:[{name:'Cyril', since:5, account:'ref-c'}]}"));
        assertEquals("ref-a", f.account("p1"));
        assertEquals("", f.account("p2"));
        assertEquals(1, f.away().size());
        assertEquals("Cyril", f.away().get(0).name);
        assertEquals(5, f.away().get(0).since);
        assertTrue(f.joinedAt > 0);
    }

    @Test
    public void theOldAliasAndNullAccounts() {
        PeerFacts f = new PeerFacts();
        f.onFrame(j("{type:'peer-joined', peerId:'p1', name:'A', accountId:'ref-1'}"));
        assertEquals("ref-1", f.account("p1"));
        f.onFrame(j("{type:'peer-updated', peerId:'p1', name:'A', account:null, accountId:null}"));
        assertEquals("", f.account("p1"));
    }

    @Test
    public void helloNamesTheUsernameAndAwayMembersKeepIt() {
        PeerFacts f = new PeerFacts();
        f.onFrame(j("{type:'peer-joined', peerId:'p1', name:'Alice', account:'ref-a'}"));
        f.onHello("p1", j("{kind:'hello', user:'bystry-sokol-7k3q'}"));
        assertEquals("bystry-sokol-7k3q", f.get("p1").username);
        assertTrue(f.get("p1").since > 0);
        f.onFrame(j("{type:'peer-left', peerId:'p1'}"));
        assertNull(f.get("p1"));
        f.onFrame(j("{type:'peer-away', account:'ref-a', name:'Alice', since:9}"));
        assertEquals("bystry-sokol-7k3q", f.userOf("ref-a"));
        f.onFrame(j("{type:'peer-back', account:'ref-a'}"));
        assertTrue(f.away().isEmpty());
    }

    @Test
    public void aClaimThatIsNotAUsernameIsIgnored() {
        PeerFacts f = new PeerFacts();
        f.onHello("p1", j("{kind:'hello', user:{name:'x'}}"));
        assertEquals("", f.get("p1").username);
        f.onHello("p2", j("{kind:'hello', user:'<script>'}"));
        assertEquals("", f.get("p2").username);
    }

    @Test
    public void signingInLaterStillLearnsTheUsername() {
        PeerFacts f = new PeerFacts();
        f.onHello("p1", j("{kind:'hello', user:'rys-lis-aaaa'}"));
        f.onFrame(j("{type:'peer-updated', peerId:'p1', name:'A', account:'ref-z'}"));
        assertEquals("rys-lis-aaaa", f.userOf("ref-z"));
        f.onFrame(j("{type:'peer-gone', account:'nobody'}"));
    }
}
