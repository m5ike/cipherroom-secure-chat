package cz.m5cet.app.account;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.Collator;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The registration form (6.4) without its views: the light checks made here
 * before the server's (the server decides — these only spare a round trip),
 * the server's field codes → the keys of their texts, the countries (flag,
 * name in the app's language, search), the request body, and the record the
 * account vault keeps afterwards (its own sealed "registration" part, the
 * same JSON as the web's). Pure Java: the JVM tests check it.
 *
 * Nothing here logs: the values are the person's name, phone and e-mail.
 */
public final class Registration {
    private Registration() {}

    /** The form's fields, in the order they are shown — the server's names too. */
    public static final String[] FIELDS = {"firstName", "lastName", "country", "phone", "email"};

    /** A country the server takes: ISO 3166-1 code, dial code (digits, no +), its name in the app's language. */
    public static final class Country {
        public final String code;
        public final String dial;
        public final String name;

        public Country(String code, String dial, String name) { this.code = code; this.dial = dial; this.name = name; }

        /** "🇨🇿 Česko  +420" — how the list and the form show it. */
        public String label() { String f = flag(code); return (f.isEmpty() ? "" : f + " ") + name + "  +" + dial; }
    }

    /* ---------------------------------------------------------- countries */

    /**
     * GET /api/account/countries → the countries, named in locale and sorted
     * by that name; entries without a two-letter code or a dial code are left out.
     */
    @SuppressWarnings("deprecation")
    public static List<Country> countries(JSONObject answer, Locale locale) {
        List<Country> out = new ArrayList<>();
        JSONArray list = answer == null ? null : answer.optJSONArray("countries");
        if (list == null) return out;
        for (int i = 0; i < list.length(); i++) {
            JSONObject c = list.optJSONObject(i);
            String code = c == null ? "" : c.optString("code").trim().toUpperCase(Locale.ROOT);
            String dial = c == null ? "" : c.optString("dial").replaceAll("[^0-9]", "");
            if (!code.matches("[A-Z]{2}") || dial.isEmpty()) continue;
            String name = new Locale("", code).getDisplayCountry(locale);
            out.add(new Country(code, dial, name == null || name.isEmpty() ? code : name));
        }
        Collator by = Collator.getInstance(locale);
        by.setStrength(Collator.PRIMARY);
        Collections.sort(out, (a, b) -> by.compare(a.name, b.name));
        return out;
    }

    /** The flag of a country code: its two regional indicator symbols ("" for anything but two letters). */
    public static String flag(String code) {
        String c = code == null ? "" : code.trim().toUpperCase(Locale.ROOT);
        if (!c.matches("[A-Z]{2}")) return "";
        return new String(Character.toChars(0x1F1E6 + c.charAt(0) - 'A')) + new String(Character.toChars(0x1F1E6 + c.charAt(1) - 'A'));
    }

    /** Lowercase, without accents: "Česko" → "cesko". */
    static String fold(String s) {
        return Normalizer.normalize(s == null ? "" : s, Normalizer.Form.NFD).replaceAll("\\p{M}+", "").toLowerCase(Locale.ROOT);
    }

    /**
     * The countries matching a search: the name contains it (accents and case
     * do not matter: "cesk" finds Česko), the code starts with it ("cz"), or the
     * dial code does ("+42", "420"). An empty search keeps them all.
     */
    public static List<Country> filter(List<Country> all, String query) {
        String q = fold(query).trim();
        if (q.isEmpty()) return new ArrayList<>(all);
        String digits = q.startsWith("+") || q.matches("[0-9 ]+") ? q.replaceAll("[^0-9]", "") : "";
        List<Country> out = new ArrayList<>();
        for (Country c : all) {
            if (fold(c.name).contains(q) || c.code.toLowerCase(Locale.ROOT).startsWith(q) || (!digits.isEmpty() && c.dial.startsWith(digits))) out.add(c);
        }
        return out;
    }

    public static Country find(List<Country> all, String code) {
        for (Country c : all) if (c.code.equalsIgnoreCase(code == null ? "" : code.trim())) return c;
        return null;
    }

    /** The phone's region when the list has it, else CZ, else the first one; null for an empty list. */
    public static Country preferred(List<Country> all, String region) {
        Country c = find(all, region);
        if (c == null) c = find(all, "CZ");
        return c != null ? c : all.isEmpty() ? null : all.get(0);
    }

    /* ------------------------------------------------------------ checks */

    public static final int NAME_MAX = 64;

    /**
     * The light checks before the server is asked: field → code, the same
     * codes as the server's (required, too-long, invalid). Empty = send it.
     */
    public static Map<String, String> check(JSONObject form) {
        Map<String, String> errors = new LinkedHashMap<>();
        put(errors, "firstName", checkName(form.optString("firstName")));
        put(errors, "lastName", checkName(form.optString("lastName")));
        put(errors, "country", form.optString("country").trim().matches("[A-Za-z]{2}") ? "" : form.optString("country").trim().isEmpty() ? "required" : "invalid");
        put(errors, "phone", checkPhone(form.optString("phone")));
        put(errors, "email", checkEmail(form.optString("email")));
        return errors;
    }

    private static void put(Map<String, String> errors, String field, String code) { if (!code.isEmpty()) errors.put(field, code); }

    /** Letters (any script), their marks, spaces, . ' ’ - — at least one letter, 64 characters at most. */
    static String checkName(String value) {
        String v = value == null ? "" : value.trim();
        if (v.isEmpty()) return "required";
        if (v.codePointCount(0, v.length()) > NAME_MAX) return "too-long";
        if (!v.matches("[\\p{L}\\p{M} .'’-]+") || !v.matches(".*\\p{L}.*")) return "invalid";
        return "";
    }

    /** Digits and the usual separators (+ space - ( ) . /), 6–15 digits. */
    static String checkPhone(String value) {
        String v = value == null ? "" : value.trim();
        if (v.isEmpty()) return "required";
        if (!v.matches("[0-9+ ()./-]+")) return "invalid";
        int digits = v.replaceAll("[^0-9]", "").length();
        return digits >= 6 && digits <= 15 ? "" : "invalid";
    }

    /** someone@domain.tld, no spaces, 254 characters at most. */
    static String checkEmail(String value) {
        String v = value == null ? "" : value.trim();
        if (v.isEmpty()) return "required";
        if (v.length() > 254 || !v.matches("[^\\s@]+@[^\\s@]+\\.[^\\s@.]{2,}")) return "invalid";
        return "";
    }

    /** The server's "errors" → field → code, only the form's own fields. */
    public static Map<String, String> fieldErrors(JSONObject errors) {
        Map<String, String> out = new LinkedHashMap<>();
        if (errors == null) return out;
        for (String f : FIELDS) {
            String code = errors.optString(f, "").trim();
            if (!code.isEmpty()) out.put(f, code);
        }
        return out;
    }

    /** The key of the text for a field's error code (reg.err.*); an unknown code gets the general one. */
    public static String errorKey(String field, String code) {
        String f = field == null ? "" : field, c = code == null ? "" : code;
        if (c.equals("required")) return "reg.err.required";
        if (c.equals("too-long")) return "reg.err.tooLong";
        switch (f) {
            case "firstName": case "lastName": return c.equals("invalid") ? "reg.err.name" : "reg.err.invalid";
            case "country": return c.equals("invalid") ? "reg.err.country" : "reg.err.invalid";
            case "phone":
                switch (c) {
                    case "invalid": return "reg.err.phone";
                    case "not-mobile": return "reg.err.notMobile";
                    case "taken": return "reg.err.phoneTaken";
                    default: return "reg.err.invalid";
                }
            case "email":
                switch (c) {
                    case "invalid": return "reg.err.email";
                    case "no-domain": return "reg.err.noDomain";
                    case "no-mx": return "reg.err.noMx";
                    case "dns-unavailable": return "reg.err.dns";
                    case "taken": return "reg.err.emailTaken";
                    default: return "reg.err.invalid";
                }
            default: return "reg.err.invalid";
        }
    }

    /* ------------------------------------------------------ request, vault */

    /** The body of /register/check and /register/start: the fields as typed (trimmed), the country's code. */
    public static JSONObject body(String firstName, String lastName, String country, String phone, String email) {
        JSONObject b = new JSONObject();
        try {
            b.put("firstName", trim(firstName)).put("lastName", trim(lastName)).put("country", trim(country).toUpperCase(Locale.ROOT))
                .put("phone", trim(phone)).put("email", trim(email));
        } catch (JSONException e) { throw new IllegalStateException(e); }
        return b;
    }

    private static String trim(String s) { return s == null ? "" : s.trim(); }

    /**
     * What the account vault's own "registration" part holds (sealed like the
     * profile, next to it — the web rewrites the whole profile from its
     * preferences, so the registration does not live in there): version 1,
     * the server's normalized values, and when (ms).
     */
    public static JSONObject record(JSONObject normalized, long at) {
        try {
            JSONObject r = new JSONObject().put("v", 1);
            for (String f : FIELDS) r.put(f, normalized == null ? "" : normalized.optString(f, ""));
            return r.put("registeredAt", at);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }
}
