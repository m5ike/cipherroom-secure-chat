// EMV data elements (6.5) — A/nfc/EmvTags.java (emv-tags.ts): the tag
// dictionary, the AID → scheme map and a few country / currency codes. Public
// reference data (EMV Book 3, ISO 7816-4): names only.

import Foundation

public enum EmvTags {
    /// Value formats (emv-tags.ts EmvFormat).
    public enum Format: String, Sendable { case n, cn, an, ans, b, date, month, country, currency, hex }

    public struct Info: Sendable, Hashable { public let name: String; public let format: Format }

    static let tags: [String: Info] = {
        let rows: [(String, String, Format)] = [
            ("4F", "Application identifier (AID)", .hex), ("50", "Application label", .ans), ("57", "Track 2 equivalent data", .b),
            ("5A", "Application PAN", .cn), ("5F20", "Cardholder name", .ans), ("5F24", "Application expiry date", .date),
            ("5F25", "Application effective date", .date), ("5F28", "Issuer country code", .country), ("5F2A", "Transaction currency code", .currency),
            ("5F2D", "Language preference", .an), ("5F30", "Service code", .n), ("5F34", "PAN sequence number", .n),
            ("5F36", "Transaction currency exponent", .n), ("5F50", "Issuer URL", .ans), ("5F53", "IBAN", .ans),
            ("5F54", "Bank identifier code (BIC)", .ans), ("5F55", "Issuer country code (alpha-2)", .an), ("5F56", "Issuer country code (alpha-3)", .an),
            ("61", "Application template", .hex), ("6F", "File control information (FCI)", .hex), ("70", "Record template", .hex),
            ("77", "Response message template 2", .hex), ("80", "Response message template 1", .hex), ("82", "Application interchange profile (AIP)", .hex),
            ("84", "Dedicated file (DF) name", .hex), ("87", "Application priority indicator", .hex), ("88", "Short file identifier (SFI)", .n),
            ("8C", "CDOL1", .hex), ("8D", "CDOL2", .hex), ("8E", "Cardholder verification method (CVM) list", .hex),
            ("8F", "CA public key index", .hex), ("90", "Issuer public key certificate", .hex), ("92", "Issuer public key remainder", .hex),
            ("93", "Signed static application data", .hex), ("94", "Application file locator (AFL)", .hex), ("95", "Terminal verification results", .hex),
            ("9A", "Transaction date", .date), ("9C", "Transaction type", .n), ("A5", "FCI proprietary template", .hex),
            ("9F02", "Amount, authorised", .n), ("9F03", "Amount, other", .n), ("9F05", "Application discretionary data", .hex),
            ("9F07", "Application usage control", .hex), ("9F08", "Application version number", .hex), ("9F0D", "Issuer action code — default", .hex),
            ("9F0E", "Issuer action code — denial", .hex), ("9F0F", "Issuer action code — online", .hex), ("9F10", "Issuer application data", .hex),
            ("9F11", "Issuer code table index", .n), ("9F12", "Application preferred name", .ans), ("9F13", "Last online ATC register", .n),
            ("9F17", "PIN try counter", .n), ("9F1A", "Terminal country code", .country), ("9F1F", "Track 1 discretionary data", .ans),
            ("9F20", "Track 2 discretionary data", .cn), ("9F26", "Application cryptogram", .hex), ("9F27", "Cryptogram information data", .hex),
            ("9F32", "Issuer public key exponent", .hex), ("9F36", "Application transaction counter (ATC)", .n),
            ("9F38", "Processing options data object list (PDOL)", .hex), ("9F42", "Application currency code", .currency),
            ("9F44", "Application currency exponent", .n), ("9F4A", "Static data authentication tag list", .hex), ("9F4D", "Log entry", .hex),
            ("9F4F", "Log format", .hex), ("9F46", "ICC public key certificate", .hex), ("9F47", "ICC public key exponent", .hex),
            ("9F48", "ICC public key remainder", .hex), ("9F49", "DDOL", .hex), ("9F62", "PCVC3 (Track 1)", .hex), ("9F63", "PUNATC (Track 1)", .hex),
            ("9F64", "NATC (Track 1)", .n), ("9F65", "PCVC3 (Track 2)", .hex), ("9F66", "Terminal transaction qualifiers (TTQ)", .hex),
            ("9F6B", "Track 2 data (Mag-stripe)", .b), ("9F6C", "Card transaction qualifiers (CTQ)", .hex), ("BF0C", "FCI issuer discretionary data", .hex),
        ]
        var m = [String: Info]()
        for (t, n, f) in rows { m[t] = Info(name: n, format: f) }
        return m
    }()

    public static func info(_ tag: String) -> Info {
        let t = JSText.upperASCII(tag)
        return tags[t] ?? Info(name: "Tag \(t)", format: .hex)
    }

    /// Longest-prefix AID → scheme (the RID, first 5 bytes, identifies the scheme).
    static let schemes: [(String, String)] = [
        ("A000000003", "Visa"), ("A000000004", "Mastercard"), ("A000000005", "Mastercard"), ("A000000025", "American Express"),
        ("A000000065", "JCB"), ("A000000152", "Discover"), ("A000000324", "Discover"), ("A000000333", "UnionPay"), ("A000000277", "Interac"),
        ("A0000006581010", "Mir"), ("A0000000651010", "JCB"),
        ("325041592E5359532E4444463031", "PPSE (2PAY.SYS.DDF01)"), ("315041592E5359532E4444463031", "PSE (1PAY.SYS.DDF01)"),
    ]

    public static func scheme(forAid aid: String) -> String? {
        let a = JSText.upperASCII(aid).replacingRegex("[^0-9A-F]", with: "")
        var best: String? = nil, bestLen = -1
        for (p, s) in schemes where a.hasPrefix(p) && p.count > bestLen { best = s; bestLen = p.count }
        return best
    }

    /// The common candidate AIDs, for a card that offers no PPSE directory.
    public static let candidateAids: [(aid: String, scheme: String)] = [
        ("A0000000031010", "Visa credit/debit"), ("A0000000032010", "Visa Electron"), ("A0000000033010", "Visa Interlink"),
        ("A0000000041010", "Mastercard credit/debit"), ("A0000000043060", "Maestro"), ("A000000004306001", "Maestro UK"),
        ("A00000002501", "American Express"), ("A0000000651010", "JCB"), ("A0000001523010", "Discover"),
        ("A000000333010101", "UnionPay debit"), ("A000000333010102", "UnionPay credit"),
    ]

    public static let countryNum: [String: String] = [
        "0056": "Belgium", "0203": "Czechia", "0276": "Germany", "0250": "France", "0826": "United Kingdom", "0840": "United States",
        "0616": "Poland", "0703": "Slovakia", "0040": "Austria", "0380": "Italy", "0724": "Spain", "0528": "Netherlands",
        "0756": "Switzerland", "0208": "Denmark", "0752": "Sweden", "0578": "Norway",
    ]

    public static let currencyNum: [String: String] = [
        "0203": "CZK", "0978": "EUR", "0840": "USD", "0826": "GBP", "0985": "PLN", "0756": "CHF", "0208": "DKK", "0752": "SEK", "0578": "NOK", "0348": "HUF",
    ]
}
