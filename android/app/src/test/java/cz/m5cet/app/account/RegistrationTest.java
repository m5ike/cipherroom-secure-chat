package cz.m5cet.app.account;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** 6.4: the registration form without its views (Registration). */
public class RegistrationTest {
    static JSONObject answer() throws Exception {
        JSONArray list = new JSONArray()
            .put(new JSONObject().put("code", "AT").put("dial", "43"))
            .put(new JSONObject().put("code", "CZ").put("dial", "420"))
            .put(new JSONObject().put("code", "DE").put("dial", "49"))
            .put(new JSONObject().put("code", "SK").put("dial", "421"))
            .put(new JSONObject().put("code", "US").put("dial", "1"))
            .put(new JSONObject().put("code", "??").put("dial", "7"))     // not a country code: left out
            .put(new JSONObject().put("code", "FR").put("dial", ""));     // no dial code: left out
        return new JSONObject().put("ok", true).put("countries", list);
    }

    static List<String> codes(List<Registration.Country> list) {
        List<String> out = new ArrayList<>();
        for (Registration.Country c : list) out.add(c.code);
        return out;
    }

    @Test
    public void countriesNamedInTheAppsLanguage() throws Exception {
        List<Registration.Country> cs = Registration.countries(answer(), Locale.forLanguageTag("cs"));
        assertEquals(5, cs.size());
        Registration.Country cz = Registration.find(cs, "cz");
        assertEquals("Česko", cz.name);
        assertEquals("420", cz.dial);
        assertEquals("🇨🇿 Česko  +420", cz.label());
        // Sorted by the name in that language (Česko before Německo before Rakousko…).
        assertTrue(cs.indexOf(cz) < cs.indexOf(Registration.find(cs, "DE")));
        assertEquals("Germany", Registration.find(Registration.countries(answer(), Locale.ENGLISH), "DE").name);
        assertEquals("Deutschland", Registration.find(Registration.countries(answer(), Locale.GERMAN), "DE").name);
        assertTrue(Registration.countries(new JSONObject(), Locale.ENGLISH).isEmpty());
        assertTrue(Registration.countries(null, Locale.ENGLISH).isEmpty());
    }

    @Test
    public void flags() {
        assertEquals("🇨🇿", Registration.flag("CZ"));
        assertEquals(Registration.flag("DE"), Registration.flag("de"));
        assertEquals("", Registration.flag("CZE"));
        assertEquals("", Registration.flag("1A"));
        assertEquals("", Registration.flag(null));
    }

    @Test
    public void searchByNameCodeOrDial() throws Exception {
        List<Registration.Country> all = Registration.countries(answer(), Locale.forLanguageTag("cs"));
        assertEquals(List.of("CZ"), codes(Registration.filter(all, "cesk")));     // no accents needed
        assertEquals(List.of("CZ"), codes(Registration.filter(all, "ČESKO")));
        assertEquals(List.of("CZ"), codes(Registration.filter(all, "cz")));       // the ISO code
        assertEquals(List.of("CZ"), codes(Registration.filter(all, "+420")));
        assertEquals(List.of("CZ"), codes(Registration.filter(all, "420")));
        assertEquals(2, Registration.filter(all, "+42").size());                  // +420, +421
        assertTrue(codes(Registration.filter(all, "+4")).containsAll(List.of("AT", "CZ", "DE", "SK")));
        assertEquals(List.of("US"), codes(Registration.filter(all, "+1")));
        assertEquals(all.size(), Registration.filter(all, "").size());
        assertEquals(all.size(), Registration.filter(all, null).size());
        assertTrue(Registration.filter(all, "atlantis").isEmpty());
        // English names in an English app.
        assertEquals(List.of("CZ"), codes(Registration.filter(Registration.countries(answer(), Locale.ENGLISH), "czech")));
    }

    @Test
    public void theDefaultCountry() throws Exception {
        List<Registration.Country> all = Registration.countries(answer(), Locale.ENGLISH);
        assertEquals("SK", Registration.preferred(all, "SK").code);   // the phone's region
        assertEquals("CZ", Registration.preferred(all, "BR").code);   // not in the list → CZ
        assertEquals("CZ", Registration.preferred(all, "").code);
        List<Registration.Country> noCz = new ArrayList<>(all);
        noCz.remove(Registration.find(all, "CZ"));
        assertEquals(noCz.get(0).code, Registration.preferred(noCz, "BR").code);
        assertNull(Registration.preferred(new ArrayList<>(), "CZ"));
    }

    static JSONObject form(String first, String last, String country, String phone, String email) {
        return Registration.body(first, last, country, phone, email);
    }

    @Test
    public void lightChecks() {
        assertTrue(Registration.check(form("Jan", "Novák", "CZ", "777 123 456", "jan@example.cz")).isEmpty());
        assertTrue(Registration.check(form("Anne-Marie", "O’Neil d'Arc", "ie", "+353 (85) 123-4567", "a.b+c@mail.example.ie")).isEmpty());
        assertTrue(Registration.check(form("Zoë", "Ångström Jr.", "SE", "0701234567", "z@x.se")).isEmpty());
        assertTrue(Registration.check(form("Иван", "Петров", "RU", "9161234567", "ivan@example.ru")).isEmpty());

        Map<String, String> empty = Registration.check(form(" ", "", "", "", "  "));
        assertEquals("required", empty.get("firstName"));
        assertEquals("required", empty.get("lastName"));
        assertEquals("required", empty.get("country"));
        assertEquals("required", empty.get("phone"));
        assertEquals("required", empty.get("email"));

        String long65 = "A".repeat(65);
        Map<String, String> bad = Registration.check(form("J4n", long65, "CZE", "12345", "jan@example"));
        assertEquals("invalid", bad.get("firstName"));
        assertEquals("too-long", bad.get("lastName"));
        assertEquals("invalid", bad.get("country"));
        assertEquals("invalid", bad.get("phone"));        // 5 digits
        assertEquals("invalid", bad.get("email"));        // no TLD
        assertFalse(Registration.check(form("A".repeat(64), "B", "CZ", "777123456", "a@b.cz")).containsKey("firstName"));

        assertEquals("invalid", Registration.checkName("--"));                // no letter at all
        assertEquals("invalid", Registration.checkName("Jan <script>"));
        assertEquals("invalid", Registration.checkPhone("1234567890123456"));  // 16 digits
        assertEquals("", Registration.checkPhone("123456789012345"));         // 15
        assertEquals("invalid", Registration.checkPhone("777 123 456 ext"));
        assertEquals("invalid", Registration.checkEmail("jan @example.cz"));
        assertEquals("invalid", Registration.checkEmail("jan@@example.cz"));
        assertEquals("invalid", Registration.checkEmail("jan@example.c"));
    }

    @Test
    public void theBodyIsTrimmed() {
        JSONObject b = Registration.body("  Jan ", "Novák ", "cz", " +420 777 123 456 ", " jan@example.cz ");
        assertEquals("Jan", b.optString("firstName"));
        assertEquals("Novák", b.optString("lastName"));
        assertEquals("CZ", b.optString("country"));
        assertEquals("+420 777 123 456", b.optString("phone"));   // as typed: the server normalizes
        assertEquals("jan@example.cz", b.optString("email"));
        assertEquals(5, b.length());
    }

    @Test
    public void theServersFieldErrors() throws Exception {
        JSONObject errors = new JSONObject().put("email", "no-mx").put("phone", "taken").put("nickname", "invalid");
        Map<String, String> codes = Registration.fieldErrors(errors);
        assertEquals(2, codes.size());                           // only the form's fields
        assertEquals("no-mx", codes.get("email"));
        assertEquals("taken", codes.get("phone"));
        assertEquals(List.of("phone", "email"), new ArrayList<>(codes.keySet()));   // in the form's order
        assertTrue(Registration.fieldErrors(null).isEmpty());
        assertTrue(Registration.fieldErrors(new JSONObject()).isEmpty());
    }

    @Test
    public void errorTexts() {
        assertEquals("reg.err.required", Registration.errorKey("firstName", "required"));
        assertEquals("reg.err.required", Registration.errorKey("email", "required"));
        assertEquals("reg.err.tooLong", Registration.errorKey("lastName", "too-long"));
        assertEquals("reg.err.name", Registration.errorKey("firstName", "invalid"));
        assertEquals("reg.err.name", Registration.errorKey("lastName", "invalid"));
        assertEquals("reg.err.country", Registration.errorKey("country", "invalid"));
        assertEquals("reg.err.phone", Registration.errorKey("phone", "invalid"));
        assertEquals("reg.err.notMobile", Registration.errorKey("phone", "not-mobile"));
        assertEquals("reg.err.phoneTaken", Registration.errorKey("phone", "taken"));
        assertEquals("reg.err.email", Registration.errorKey("email", "invalid"));
        assertEquals("reg.err.noDomain", Registration.errorKey("email", "no-domain"));
        assertEquals("reg.err.noMx", Registration.errorKey("email", "no-mx"));
        assertEquals("reg.err.dns", Registration.errorKey("email", "dns-unavailable"));
        assertEquals("reg.err.emailTaken", Registration.errorKey("email", "taken"));
        // Codes this app does not know yet still say something.
        assertEquals("reg.err.invalid", Registration.errorKey("email", "whatever"));
        assertEquals("reg.err.invalid", Registration.errorKey("nickname", "invalid"));
        assertEquals("reg.err.invalid", Registration.errorKey(null, null));
    }

    @Test
    public void theVaultRecord() throws Exception {
        JSONObject normalized = new JSONObject().put("firstName", "Jan").put("lastName", "Novák").put("country", "CZ")
            .put("phone", "+420777123456").put("email", "jan@example.cz").put("extra", "not kept");
        JSONObject r = Registration.record(normalized, 1760000000000L);
        assertEquals(1, r.getInt("v"));
        assertEquals("Jan", r.getString("firstName"));
        assertEquals("Novák", r.getString("lastName"));
        assertEquals("CZ", r.getString("country"));
        assertEquals("+420777123456", r.getString("phone"));
        assertEquals("jan@example.cz", r.getString("email"));
        assertEquals(1760000000000L, r.getLong("registeredAt"));
        assertEquals(7, r.length());
    }
}
