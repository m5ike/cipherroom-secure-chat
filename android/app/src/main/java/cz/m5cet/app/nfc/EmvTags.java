package cz.m5cet.app.nfc;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * EMV data elements (6.5) — the Java port of client/src/lib/nfc/emv-tags.ts: the
 * tag dictionary, the AID → scheme map and a few country/currency codes, used by
 * {@link EmvReader}. Public reference data (EMV Book 3, ISO 7816-4): names only,
 * so a parsed element can be labelled and formatted. Read-only reference.
 */
public final class EmvTags {
    private EmvTags() {}

    // Value formats (emv-tags.ts EmvFormat).
    public static final String N = "n", CN = "cn", AN = "an", ANS = "ans", B = "b",
        DATE = "date", MONTH = "month", COUNTRY = "country", CURRENCY = "currency", HEX = "hex";

    public static final class Info {
        public final String name, format;
        Info(String name, String format) { this.name = name; this.format = format; }
    }

    private static final Map<String, Info> TAGS = new LinkedHashMap<>();
    private static void t(String tag, String name, String format) { TAGS.put(tag, new Info(name, format)); }
    static {
        t("4F", "Application identifier (AID)", HEX);
        t("50", "Application label", ANS);
        t("57", "Track 2 equivalent data", B);
        t("5A", "Application PAN", CN);
        t("5F20", "Cardholder name", ANS);
        t("5F24", "Application expiry date", DATE);
        t("5F25", "Application effective date", DATE);
        t("5F28", "Issuer country code", COUNTRY);
        t("5F2A", "Transaction currency code", CURRENCY);
        t("5F2D", "Language preference", AN);
        t("5F30", "Service code", N);
        t("5F34", "PAN sequence number", N);
        t("5F36", "Transaction currency exponent", N);
        t("5F50", "Issuer URL", ANS);
        t("5F53", "IBAN", ANS);
        t("5F54", "Bank identifier code (BIC)", ANS);
        t("5F55", "Issuer country code (alpha-2)", AN);
        t("5F56", "Issuer country code (alpha-3)", AN);
        t("61", "Application template", HEX);
        t("6F", "File control information (FCI)", HEX);
        t("70", "Record template", HEX);
        t("77", "Response message template 2", HEX);
        t("80", "Response message template 1", HEX);
        t("82", "Application interchange profile (AIP)", HEX);
        t("84", "Dedicated file (DF) name", HEX);
        t("87", "Application priority indicator", HEX);
        t("88", "Short file identifier (SFI)", N);
        t("8C", "CDOL1", HEX);
        t("8D", "CDOL2", HEX);
        t("8E", "Cardholder verification method (CVM) list", HEX);
        t("8F", "CA public key index", HEX);
        t("90", "Issuer public key certificate", HEX);
        t("92", "Issuer public key remainder", HEX);
        t("93", "Signed static application data", HEX);
        t("94", "Application file locator (AFL)", HEX);
        t("95", "Terminal verification results", HEX);
        t("9A", "Transaction date", DATE);
        t("9C", "Transaction type", N);
        t("A5", "FCI proprietary template", HEX);
        t("9F02", "Amount, authorised", N);
        t("9F03", "Amount, other", N);
        t("9F05", "Application discretionary data", HEX);
        t("9F07", "Application usage control", HEX);
        t("9F08", "Application version number", HEX);
        t("9F0D", "Issuer action code — default", HEX);
        t("9F0E", "Issuer action code — denial", HEX);
        t("9F0F", "Issuer action code — online", HEX);
        t("9F10", "Issuer application data", HEX);
        t("9F11", "Issuer code table index", N);
        t("9F12", "Application preferred name", ANS);
        t("9F13", "Last online ATC register", N);
        t("9F17", "PIN try counter", N);
        t("9F1A", "Terminal country code", COUNTRY);
        t("9F1F", "Track 1 discretionary data", ANS);
        t("9F20", "Track 2 discretionary data", CN);
        t("9F26", "Application cryptogram", HEX);
        t("9F27", "Cryptogram information data", HEX);
        t("9F32", "Issuer public key exponent", HEX);
        t("9F36", "Application transaction counter (ATC)", N);
        t("9F38", "Processing options data object list (PDOL)", HEX);
        t("9F42", "Application currency code", CURRENCY);
        t("9F44", "Application currency exponent", N);
        t("9F4A", "Static data authentication tag list", HEX);
        t("9F4D", "Log entry", HEX);
        t("9F4F", "Log format", HEX);
        t("9F46", "ICC public key certificate", HEX);
        t("9F47", "ICC public key exponent", HEX);
        t("9F48", "ICC public key remainder", HEX);
        t("9F49", "DDOL", HEX);
        t("9F62", "PCVC3 (Track 1)", HEX);
        t("9F63", "PUNATC (Track 1)", HEX);
        t("9F64", "NATC (Track 1)", N);
        t("9F65", "PCVC3 (Track 2)", HEX);
        t("9F66", "Terminal transaction qualifiers (TTQ)", HEX);
        t("9F6B", "Track 2 data (Mag-stripe)", B);
        t("9F6C", "Card transaction qualifiers (CTQ)", HEX);
        t("BF0C", "FCI issuer discretionary data", HEX);
    }

    public static Info emvTagInfo(String tag) {
        Info i = TAGS.get(tag.toUpperCase());
        return i != null ? i : new Info("Tag " + tag.toUpperCase(), HEX);
    }

    /** Longest-prefix AID → scheme (the RID, first 5 bytes / 10 hex, identifies the scheme). */
    private static final String[][] SCHEMES = {
        {"A000000003", "Visa"},
        {"A000000004", "Mastercard"},
        {"A000000005", "Mastercard"},
        {"A000000025", "American Express"},
        {"A000000065", "JCB"},
        {"A000000152", "Discover"},
        {"A000000324", "Discover"},
        {"A000000333", "UnionPay"},
        {"A000000277", "Interac"},
        {"A0000006581010", "Mir"},
        {"A0000000651010", "JCB"},
        {"325041592E5359532E4444463031", "PPSE (2PAY.SYS.DDF01)"},
        {"315041592E5359532E4444463031", "PSE (1PAY.SYS.DDF01)"},
    };

    public static String schemeForAid(String aid) {
        String a = aid.toUpperCase().replaceAll("[^0-9A-F]", "");
        String best = null; int bestLen = -1;
        for (String[] s : SCHEMES) if (a.startsWith(s[0]) && s[0].length() > bestLen) { best = s[1]; bestLen = s[0].length(); }
        return best;
    }

    public static final class Candidate {
        public final String aid, scheme;
        Candidate(String aid, String scheme) { this.aid = aid; this.scheme = scheme; }
    }

    /** The common candidate AIDs, for a card that offers no PPSE directory. */
    public static final Candidate[] CANDIDATE_AIDS = {
        new Candidate("A0000000031010", "Visa credit/debit"),
        new Candidate("A0000000032010", "Visa Electron"),
        new Candidate("A0000000033010", "Visa Interlink"),
        new Candidate("A0000000041010", "Mastercard credit/debit"),
        new Candidate("A0000000043060", "Maestro"),
        new Candidate("A000000004306001", "Maestro UK"),
        new Candidate("A00000002501", "American Express"),
        new Candidate("A0000000651010", "JCB"),
        new Candidate("A0000001523010", "Discover"),
        new Candidate("A000000333010101", "UnionPay debit"),
        new Candidate("A000000333010102", "UnionPay credit"),
    };

    public static final Map<String, String> COUNTRY_NUM = new LinkedHashMap<>();
    static {
        COUNTRY_NUM.put("0056", "Belgium"); COUNTRY_NUM.put("0203", "Czechia"); COUNTRY_NUM.put("0276", "Germany"); COUNTRY_NUM.put("0250", "France");
        COUNTRY_NUM.put("0826", "United Kingdom"); COUNTRY_NUM.put("0840", "United States"); COUNTRY_NUM.put("0616", "Poland"); COUNTRY_NUM.put("0703", "Slovakia");
        COUNTRY_NUM.put("0040", "Austria"); COUNTRY_NUM.put("0380", "Italy"); COUNTRY_NUM.put("0724", "Spain"); COUNTRY_NUM.put("0528", "Netherlands");
        COUNTRY_NUM.put("0756", "Switzerland"); COUNTRY_NUM.put("0208", "Denmark"); COUNTRY_NUM.put("0752", "Sweden"); COUNTRY_NUM.put("0578", "Norway");
    }

    public static final Map<String, String> CURRENCY_NUM = new LinkedHashMap<>();
    static {
        CURRENCY_NUM.put("0203", "CZK"); CURRENCY_NUM.put("0978", "EUR"); CURRENCY_NUM.put("0840", "USD"); CURRENCY_NUM.put("0826", "GBP"); CURRENCY_NUM.put("0985", "PLN");
        CURRENCY_NUM.put("0756", "CHF"); CURRENCY_NUM.put("0208", "DKK"); CURRENCY_NUM.put("0752", "SEK"); CURRENCY_NUM.put("0578", "NOK"); CURRENCY_NUM.put("0348", "HUF");
    }
}
