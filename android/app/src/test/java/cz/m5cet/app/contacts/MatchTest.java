package cz.m5cet.app.contacts;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** Who a contact's "message / call via M5cet" reaches, across the connected rooms. */
public class MatchTest {
    private static Match.Candidate c(String room, String peer, String user, boolean signedIn, boolean open, boolean active, long activity) {
        return new Match.Candidate(room, peer, user, signedIn, open, active, activity);
    }

    @Test
    public void usernamesAsTheWebCleansThem() {
        assertEquals("bystry-sokol-7k3q", Match.cleanUsername(" bystry-sokol-7k3q "));
        assertEquals("", Match.cleanUsername("ab"));
        assertEquals("", Match.cleanUsername("with space"));
        assertEquals("", Match.cleanUsername("tomáš"));
        assertEquals("", Match.cleanUsername(42));
        assertEquals("", Match.cleanUsername(null));
        assertEquals("Old_Account_Id-1234567", Match.cleanUsername("Old_Account_Id-1234567"));
    }

    @Test
    public void onlySignedInPeopleCanBeLinked() {
        assertTrue(Match.canLink("bystry-sokol-7k3q", true));
        assertFalse(Match.canLink("bystry-sokol-7k3q", false)); // a guest's session username is not an account
        assertFalse(Match.canLink("", true));
        assertEquals("bystry-sokol-7k3q", Match.key("Bystry-Sokol-7K3Q"));
    }

    @Test
    public void theSignedInOpenPersonWithThatUsername() {
        List<Match.Candidate> cs = Arrays.asList(
            c("a", "p1", "bystry-sokol-7k3q", false, true, true, 5),   // claims the name without an account
            c("a", "p2", "bystry-sokol-7k3q", true, false, true, 5),   // not connected
            c("b", "p3", "Bystry-Sokol-7K3Q", true, true, false, 1),
            c("b", "p4", "jiny-rys-2222", true, true, false, 1));
        Match.Candidate hit = Match.pick(cs, "bystry-sokol-7k3q");
        assertEquals("p3", hit.peerId);
        assertNull(Match.pick(cs, "nikdo-tu-9999"));
        assertNull(Match.pick(cs, ""));
        assertNull(Match.pick(Collections.emptyList(), "bystry-sokol-7k3q"));
    }

    @Test
    public void theActiveRoomFirstThenTheMostRecentlyActive() {
        List<Match.Candidate> cs = Arrays.asList(
            c("old", "p1", "rys-lis-aaaa", true, true, false, 100),
            c("recent", "p2", "rys-lis-aaaa", true, true, false, 900),
            c("active", "p3", "rys-lis-aaaa", true, true, true, 10));
        assertEquals("active", Match.pick(cs, "rys-lis-aaaa").roomKey);
        assertEquals("recent", Match.pick(cs.subList(0, 2), "rys-lis-aaaa").roomKey);
    }

    @Test
    public void waitsWhileRoomsSettleThenSaysNotOnline() {
        assertEquals(Match.FOUND, Match.decide(true, true, 0, 1));
        assertEquals(Match.WAIT, Match.decide(false, true, 1000, 1000 + Match.WAIT_MS - 1));
        assertEquals(Match.MISSING, Match.decide(false, true, 1000, 1000 + Match.WAIT_MS));
        assertEquals(Match.MISSING, Match.decide(false, false, 1000, 1001));
    }
}
