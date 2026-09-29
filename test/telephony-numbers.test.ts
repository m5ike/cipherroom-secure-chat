// @vitest-environment node
//
// m5.telephony offline number knowledge (server/telephony/numbers.ts): parsing human
// input into E.164, country detection under shared codes, line types and formats by
// national plan, time zones, merging provider answers, and MCC → country.
//
// Numbers are fictional or reserved for drama where the plan has such ranges:
// NANP 555-01xx, Ofcom 07700 900xxx / 020 7946 0xxx / 0113 496 0xxx / 01632 960xxx.

import { describe, it, expect } from "vitest";
import {
  normalizeNumber, numberInfo, mergeLookups, mccmncCountry,
  CALLING_CODES, NANP_AREA_CODES, CANADIAN_AREA_CODES, MCC_COUNTRIES,
  type NumberInfo,
} from "../server/telephony/numbers";
import type { HlrResult, LookupResult } from "../server/telephony/providers/types";

const info = (e164: string): NumberInfo => {
  const i = numberInfo(e164);
  if (!i) throw new Error(`numberInfo(${e164}) returned null`);
  return i;
};

/* ------------------------------------------------------------ the tables */

describe("CALLING_CODES", () => {
  it("has the example row and one row per territory", () => {
    expect(CALLING_CODES.find((c) => c.iso2 === "CZ")).toEqual({ code: "420", iso2: "CZ", country: "Czechia", region: "Europe" });
    expect(CALLING_CODES.length).toBeGreaterThan(240);
    const seen = new Set<string>();
    for (const c of CALLING_CODES) {
      expect(c.code).toMatch(/^[1-9]\d{0,2}$/);
      expect(c.iso2).toMatch(/^(?:[A-Z]{2}|001)$/);
      expect(c.country).not.toBe("");
      expect(c.region).not.toBe("");
      const key = `${c.code}/${c.iso2}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("is prefix-free, as E.164 codes are", () => {
    const codes = [...new Set(CALLING_CODES.map((c) => c.code))];
    for (const a of codes) for (const b of codes) if (a !== b) expect(b.startsWith(a)).toBe(false);
  });

  it("lists the multi-country codes with every territory", () => {
    const isos = (code: string) => CALLING_CODES.filter((c) => c.code === code).map((c) => c.iso2).sort();
    expect(isos("1")).toEqual(expect.arrayContaining(["US", "CA", "BS", "BB", "AI", "AG", "VG", "VI", "KY", "BM", "GD", "TC", "JM", "MS", "MP", "GU", "AS", "SX", "LC", "DM", "VC", "PR", "DO", "TT", "KN"]));
    expect(isos("1")).toHaveLength(25);
    expect(isos("7")).toEqual(["KZ", "RU"]);
    expect(isos("44")).toEqual(["GB", "GG", "IM", "JE"]);
    expect(isos("47")).toEqual(["NO", "SJ"]);
    expect(isos("61")).toEqual(["AU", "CC", "CX"]);
    expect(isos("262")).toEqual(["RE", "YT"]);
    expect(isos("290")).toEqual(["SH", "TA"]);
    expect(isos("358")).toEqual(["AX", "FI"]);
    expect(isos("590")).toEqual(["BL", "GP", "MF"]);
    expect(isos("599")).toEqual(["BQ", "CW"]);
  });

  it("lists the non-geographic codes", () => {
    for (const code of ["800", "808", "870", "881", "882", "883", "888", "979"]) {
      const row = CALLING_CODES.find((c) => c.code === code);
      expect(row, code).toBeDefined();
      expect(row?.iso2).toBe("001");
      expect(row?.region).toBe("International");
    }
  });

  it("does not list spare or withdrawn codes", () => {
    const codes = new Set(CALLING_CODES.map((c) => c.code));
    for (const spare of ["259", "28", "384", "422", "671", "684", "693", "801", "969", "999"]) expect(codes.has(spare), spare).toBe(false);
  });
});

describe("NANP area codes", () => {
  it("names the Caribbean and Pacific members", () => {
    expect(NANP_AREA_CODES).toMatchObject({
      "242": "BS", "246": "BB", "264": "AI", "268": "AG", "284": "VG", "340": "VI", "345": "KY", "441": "BM",
      "473": "GD", "649": "TC", "658": "JM", "876": "JM", "664": "MS", "670": "MP", "671": "GU", "684": "AS",
      "721": "SX", "758": "LC", "767": "DM", "784": "VC", "787": "PR", "939": "PR", "809": "DO", "829": "DO",
      "849": "DO", "868": "TT", "869": "KN",
    });
  });

  it("maps every Canadian area code to CA and leaves the US out", () => {
    const listed = ["204", "226", "236", "249", "250", "263", "289", "306", "343", "354", "365", "367", "368", "382", "387",
      "403", "416", "418", "428", "431", "437", "438", "450", "468", "474", "506", "514", "519", "548", "579", "581", "584",
      "587", "604", "613", "639", "647", "672", "683", "705", "709", "742", "753", "778", "780", "782", "807", "819", "825",
      "867", "873", "879", "902", "905"];
    for (const a of listed) {
      expect(CANADIAN_AREA_CODES, a).toContain(a);
      expect(NANP_AREA_CODES[a], a).toBe("CA");
    }
    for (const us of ["212", "415", "800", "900", "555", "202"]) expect(NANP_AREA_CODES[us], us).toBeUndefined();
  });
});

/* -------------------------------------------------------- normalization */

describe("normalizeNumber", () => {
  it.each([
    ["+420 603 123 456", undefined, "+420603123456"],
    ["+420603123456", undefined, "+420603123456"],
    ["00420 603-123-456", undefined, "+420603123456"],
    ["(+420) 603.123.456", undefined, "+420603123456"],
    ["+420 603/123/456", undefined, "+420603123456"],
    ["  +44 20 7946 0958  ", undefined, "+442079460958"],
    ["+44 (0)20 7946 0958", undefined, "+442079460958"],
    ["+44 020 7946 0958", undefined, "+442079460958"],
    ["+1 (212) 555-0123", undefined, "+12125550123"],
    ["+1 212‑555‑0123", undefined, "+12125550123"],
    ["tel:+1-212-555-0123", undefined, "+12125550123"],
    ["＋４２０ ６０３ １２３ ４５６", undefined, "+420603123456"],
    ["+52 1 55 1234 5678", undefined, "+525512345678"],
  ])("international %j → %s", (input, dflt, want) => {
    expect(normalizeNumber(input, dflt)).toBe(want);
  });

  it.each([
    ["603 123 456", "CZ", "+420603123456"],
    ["420 603 123 456", "CZ", "+420603123456"],
    ["0601 234 567", "GB", "+44601234567"],
    ["07700 900123", "GB", "+447700900123"],
    ["07700 900123", "gb", "+447700900123"],
    ["020 7946 0958", "GB", "+442079460958"],
    ["(0113) 496 0000", "GB", "+441134960000"],
    ["07797 123456", "JE", "+447797123456"],
    ["(212) 555-0123", "US", "+12125550123"],
    ["212-555-0123", "US", "+12125550123"],
    ["1-212-555-0123", "US", "+12125550123"],
    ["1 (416) 555-0123", "CA", "+14165550123"],
    ["876 555 0123", "JM", "+18765550123"],
    ["011 44 20 7946 0958", "US", "+442079460958"],
    ["00 44 20 7946 0958", "CZ", "+442079460958"],
    ["030 12345678", "DE", "+493012345678"],
    ["0151 23456789", "DE", "+4915123456789"],
    ["01 23 45 67 89", "FR", "+33123456789"],
    ["06 1234 5678", "IT", "+390612345678"],
    ["312 345 6789", "IT", "+393123456789"],
    ["8 (495) 123-45-67", "RU", "+74951234567"],
    ["06 1 234 5678", "HU", "+3612345678"],
    ["06-20-123-4567", "HU", "+36201234567"],
    ["0905 123 456", "SK", "+421905123456"],
    ["512 345 678", "PL", "+48512345678"],
    ["090-1234-5678", "JP", "+819012345678"],
    ["0412 345 678", "AU", "+61412345678"],
    ["(11) 91234-5678", "BR", "+5511912345678"],
  ])("national %j in %s → %s", (input, dflt, want) => {
    expect(normalizeNumber(input, dflt)).toBe(want);
  });

  it.each([
    "+1 212 555 0123;ext=45",
    "+1 212 555 0123 ext 45",
    "+1 212 555 0123 ext. 45",
    "+1 212 555 0123 extension 45",
    "+1 212-555-0123 x45",
    "+1 212-555-0123x45",
    "+1 212-555-0123 #45",
    "tel:+1-212-555-0123;ext=45;phone-context=example.com",
  ])("strips the extension of %j", (input) => {
    expect(normalizeNumber(input)).toBe("+12125550123");
  });

  it("drops the extension of a national number too", () => {
    expect(normalizeNumber("212.555.0123 x123", "US")).toBe("+12125550123");
    expect(normalizeNumber("020 7946 0958 ext 12", "GB")).toBe("+442079460958");
  });

  it.each([
    ["", undefined],
    ["   ", undefined],
    ["hello", undefined],
    ["+", undefined],
    ["+4", undefined],
    ["+420 6", undefined],
    ["+420", undefined],
    ["+999 123 456", undefined],
    ["+259 123 4567", undefined],
    ["+28 123 4567", undefined],
    ["+801 1234 5678", undefined],
    ["+0 123 456", undefined],
    ["+44 1234 5678 9012 3456", undefined],
    ["+1 212 555 0123 4567 89", undefined],
    ["++420 603 123 456", undefined],
    ["+420 603 123 456 +1", undefined],
    ["+420 603 abc 456", undefined],
    ["1-800-FLOWERS", "US"],
    ["603 123 456", undefined],
    ["603 123 456", "XX"],
    ["603 123 456", "001"],
    ["0", "GB"],
    ["+44 000 000", undefined],
    ["123456789012345678901234567890", "US"],
  ])("rejects %j (default %s)", (input, dflt) => {
    expect(normalizeNumber(input, dflt)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(normalizeNumber(undefined as unknown as string)).toBeNull();
    expect(normalizeNumber(420603123456 as unknown as string)).toBeNull();
  });

  it("ignores the default country once the number is international", () => {
    expect(normalizeNumber("+420 603 123 456", "GB")).toBe("+420603123456");
  });
});

/* ------------------------------------------------------ country detection */

describe("country detection", () => {
  it("tells the US, Canada and the Caribbean/Pacific NANP members apart", () => {
    expect(info("+12125550123").iso2).toBe("US");
    expect(info("+13105550123").iso2).toBe("US");
    expect(info("+18005550123").iso2).toBe("US");
    expect(info("+14165550123").iso2).toBe("CA");
    expect(info("+16045550123").iso2).toBe("CA");
    expect(info("+15145550123").iso2).toBe("CA");
    expect(info("+19025550123").iso2).toBe("CA");
    for (const [area, iso] of Object.entries(NANP_AREA_CODES)) {
      expect(info(`+1${area}5550123`).iso2, area).toBe(iso);
    }
    expect(info("+18765550123")).toMatchObject({ iso2: "JM", country: "Jamaica", region: "Caribbean", currency: "JMD" });
    expect(info("+16715550123")).toMatchObject({ iso2: "GU", region: "Oceania", timeZones: ["Pacific/Guam"] });
  });

  it("+7: 6 and 7 are Kazakhstan, the rest Russia", () => {
    expect(info("+77012345678")).toMatchObject({ iso2: "KZ", country: "Kazakhstan", currency: "KZT" });
    expect(info("+76123456789").iso2).toBe("KZ");
    expect(info("+74951234567")).toMatchObject({ iso2: "RU", currency: "RUB" });
    expect(info("+79123456789").iso2).toBe("RU");
  });

  it("+44: Jersey, Guernsey and the Isle of Man by area code and mobile range", () => {
    expect(info("+441534123456").iso2).toBe("JE");
    expect(info("+447797123456").iso2).toBe("JE");
    expect(info("+441481123456").iso2).toBe("GG");
    expect(info("+447781123456").iso2).toBe("GG");
    expect(info("+441624123456").iso2).toBe("IM");
    expect(info("+447624123456").iso2).toBe("IM");
    expect(info("+447700900123").iso2).toBe("GB");
    expect(info("+442079460958").iso2).toBe("GB");
  });

  it("+358 18 is Åland, +47 79 Svalbard", () => {
    expect(info("+358181234567")).toMatchObject({ iso2: "AX", country: "Åland Islands", timeZones: ["Europe/Mariehamn"] });
    expect(info("+358912345678").iso2).toBe("FI");
    expect(info("+4779021234").iso2).toBe("SJ");
    expect(info("+4722123456").iso2).toBe("NO");
  });

  it("+599: 9 is Curaçao, 3/4/7 the Caribbean Netherlands", () => {
    expect(info("+59994612345").iso2).toBe("CW");
    expect(info("+5993181234").iso2).toBe("BQ");
    expect(info("+5994161234").iso2).toBe("BQ");
    expect(info("+5997171234")).toMatchObject({ iso2: "BQ", currency: "USD" });
  });

  it("other shared codes", () => {
    expect(info("+390669812345").iso2).toBe("VA");
    expect(info("+390612345678").iso2).toBe("IT");
    expect(info("+262269123456").iso2).toBe("YT");
    expect(info("+262262123456").iso2).toBe("RE");
    expect(info("+61891641234").iso2).toBe("CX");
    expect(info("+61212345678").iso2).toBe("AU");
  });

  it("non-geographic codes", () => {
    expect(info("+80012345678")).toMatchObject({ iso2: "001", country: "International Freephone Service", type: "tollfree", timeZones: [] });
    expect(info("+97912345678").type).toBe("premium");
    expect(info("+80812345678").type).toBe("shared");
  });

  it("numberInfo takes loosely written input and rejects junk", () => {
    expect(info("+420 603 123 456").e164).toBe("+420603123456");
    expect(numberInfo("")).toBeNull();
    expect(numberInfo("+999123456")).toBeNull();
    expect(numberInfo("603 123 456")).toBeNull();
  });
});

/* ------------------------------------------------------------- line types */

describe("line types", () => {
  it.each([
    ["+420603123456", "mobile"],
    ["+420608123456", "mobile"],
    ["+420723456789", "mobile"],
    ["+420792123456", "mobile"],
    ["+420800123456", "tollfree"],
    ["+420900123456", "premium"],
    ["+420906123456", "premium"],
    ["+420840123456", "shared"],
    ["+420844123456", "shared"],
    ["+420212345678", "landline"],
    ["+420312345678", "landline"],
    ["+420545123456", "landline"],
    ["+420910123456", "voip"],
    ["+420609123456", "unknown"],
  ])("CZ %s is %s", (e164, type) => {
    expect(info(e164).type).toBe(type);
  });

  it.each([
    ["+447700900123", "mobile"],
    ["+447400123456", "mobile"],
    ["+447624123456", "mobile"],
    ["+447612345678", "pager"],
    ["+447012345678", "personal"],
    ["+442079460958", "landline"],
    ["+441134960000", "landline"],
    ["+441632960000", "landline"],
    ["+448001234567", "tollfree"],
    ["+44800123456", "tollfree"],
    ["+448081570000", "tollfree"],
    ["+449098790123", "premium"],
    ["+448453334444", "shared"],
    ["+448701234567", "shared"],
    ["+443001234567", "uan"],
    ["+445512345678", "uan"],
    ["+445612345678", "voip"],
  ])("GB %s is %s", (e164, type) => {
    expect(info(e164).type).toBe(type);
  });

  it.each([
    ["+18005550123", "tollfree"],
    ["+18335550123", "tollfree"],
    ["+18445550123", "tollfree"],
    ["+18555550123", "tollfree"],
    ["+18665550123", "tollfree"],
    ["+18775550123", "tollfree"],
    ["+18885550123", "tollfree"],
    ["+19005550123", "premium"],
    ["+15005550123", "personal"],
    ["+12125550123", "unknown"],
    ["+14165550123", "unknown"],
  ])("NANP %s is %s", (e164, type) => {
    expect(info(e164).type).toBe(type);
  });

  it.each([
    ["+4915112345678", "mobile"],
    ["+4916012345678", "mobile"],
    ["+491701234567", "mobile"],
    ["+4917612345678", "mobile"],
    ["+493012345678", "landline"],
    ["+4922112345678", "landline"],
    ["+49891234567", "landline"],
    ["+498001234567", "tollfree"],
    ["+499001234567", "premium"],
    ["+491801234567", "shared"],
    ["+4970012345678", "personal"],
    ["+4932123456789", "voip"],
    ["+491181234", "unknown"],
  ])("DE %s is %s", (e164, type) => {
    expect(info(e164).type).toBe(type);
  });

  it("a few more plans", () => {
    expect(info("+33612345678").type).toBe("mobile");
    expect(info("+33123456789").type).toBe("landline");
    expect(info("+33912345678").type).toBe("voip");
    expect(info("+393123456789").type).toBe("mobile");
    expect(info("+390612345678").type).toBe("landline");
    expect(info("+34612345678").type).toBe("mobile");
    expect(info("+34912345678").type).toBe("landline");
    expect(info("+31612345678").type).toBe("mobile");
    expect(info("+32470123456").type).toBe("mobile");
    expect(info("+3242123456").type).toBe("landline");
    expect(info("+41791234567").type).toBe("mobile");
    expect(info("+46701234567").type).toBe("mobile");
    expect(info("+4741234567").type).toBe("mobile");
    expect(info("+4580123456").type).toBe("tollfree");
    expect(info("+4520123456").type).toBe("unknown");
    expect(info("+358401234567").type).toBe("mobile");
    expect(info("+353851234567").type).toBe("mobile");
    expect(info("+351912345678").type).toBe("mobile");
    expect(info("+421905123456").type).toBe("mobile");
    expect(info("+436641234567").type).toBe("mobile");
    expect(info("+48512345678").type).toBe("mobile");
    expect(info("+36201234567").type).toBe("mobile");
    expect(info("+79123456789").type).toBe("mobile");
    expect(info("+380671234567").type).toBe("mobile");
    expect(info("+905321234567").type).toBe("mobile");
    expect(info("+972501234567").type).toBe("mobile");
    expect(info("+919812345678").type).toBe("mobile");
    expect(info("+918012345678").type).toBe("unknown");
    expect(info("+8613812345678").type).toBe("mobile");
    expect(info("+819012345678").type).toBe("mobile");
    expect(info("+821012345678").type).toBe("mobile");
    expect(info("+61412345678").type).toBe("mobile");
    expect(info("+64211234567").type).toBe("mobile");
    expect(info("+5511912345678").type).toBe("mobile");
    expect(info("+551123456789").type).toBe("landline");
    expect(info("+528001234567").type).toBe("tollfree");
    expect(info("+525512345678").type).toBe("unknown");
    expect(info("+27821234567").type).toBe("mobile");
  });

  it("validLength follows the plan where it is known", () => {
    expect(info("+420603123456").validLength).toBe(true);
    expect(info("+42060312345").validLength).toBe(false);
    expect(info("+4206031234567").validLength).toBe(false);
    expect(info("+447700900123").validLength).toBe(true);
    expect(info("+44770090012").validLength).toBe(false);
    expect(info("+1212555012").validLength).toBe(false);
    expect(info("+491511234567").validLength).toBe(false);
    // No plan on file: anything the parser accepted counts.
    expect(info("+37251234567").validLength).toBe(true);
  });
});

/* ------------------------------------------------------------- formatting */

describe("formatting", () => {
  it.each([
    ["+420603123456", "+420 603 123 456", "603 123 456"],
    ["+442079460958", "+44 20 7946 0958", "020 7946 0958"],
    ["+447700900123", "+44 7700 900123", "07700 900123"],
    ["+441134960000", "+44 113 496 0000", "0113 496 0000"],
    ["+441632960000", "+44 1632 960000", "01632 960000"],
    ["+448001234567", "+44 800 123 4567", "0800 123 4567"],
    ["+12125550123", "+1 212-555-0123", "(212) 555-0123"],
    ["+14165550123", "+1 416-555-0123", "(416) 555-0123"],
    ["+493012345678", "+49 30 12345678", "030 12345678"],
    ["+4915112345678", "+49 1511 2345678", "01511 2345678"],
    ["+491701234567", "+49 170 1234567", "0170 1234567"],
    ["+4922112345678", "+49 221 12345678", "0221 12345678"],
    ["+498001234567", "+49 800 1234567", "0800 1234567"],
    ["+33123456789", "+33 1 23 45 67 89", "01 23 45 67 89"],
    ["+390612345678", "+39 06 1234 5678", "06 1234 5678"],
    ["+393123456789", "+39 312 345 6789", "312 345 6789"],
    ["+34612345678", "+34 612 34 56 78", "612 34 56 78"],
    ["+31612345678", "+31 6 12345678", "06 12345678"],
    ["+31201234567", "+31 20 123 4567", "020 123 4567"],
    ["+32470123456", "+32 470 12 34 56", "0470 12 34 56"],
    ["+3221234567", "+32 2 123 45 67", "02 123 45 67"],
    ["+41446681800", "+41 44 668 18 00", "044 668 18 00"],
    ["+46812345678", "+46 8 123 456 78", "08 123 456 78"],
    ["+4741234567", "+47 412 34 567", "412 34 567"],
    ["+4532123456", "+45 32 12 34 56", "32 12 34 56"],
    ["+3612345678", "+36 1 234 5678", "06 1 234 5678"],
    ["+36201234567", "+36 20 123 4567", "06 20 123 4567"],
    ["+421905123456", "+421 905 123 456", "0905 123 456"],
    ["+48512345678", "+48 512 345 678", "512 345 678"],
    ["+74951234567", "+7 495 123-45-67", "8 (495) 123-45-67"],
    ["+5511912345678", "+55 11 91234-5678", "(11) 91234-5678"],
    ["+551123456789", "+55 11 2345-6789", "(11) 2345-6789"],
    ["+819012345678", "+81 90 1234 5678", "090 1234 5678"],
    ["+81312345678", "+81 3 1234 5678", "03 1234 5678"],
    ["+821012345678", "+82 10 1234 5678", "010 1234 5678"],
    ["+61412345678", "+61 412 345 678", "0412 345 678"],
    ["+61212345678", "+61 2 1234 5678", "02 1234 5678"],
    ["+8613812345678", "+86 138 1234 5678", "0138 1234 5678"],
    ["+919812345678", "+91 98123 45678", "098123 45678"],
    ["+525512345678", "+52 55 1234 5678", "55 1234 5678"],
    ["+27821234567", "+27 82 123 4567", "082 123 4567"],
  ])("%s → %s / %s", (e164, international, national) => {
    expect(info(e164).formatted).toEqual({ international, national });
  });

  it("other countries: groups of three, with the trunk prefix where the country dials one", () => {
    // Serbia dials a trunk 0; Estonia has a closed plan.
    expect(info("+381111234567").formatted).toEqual({ international: "+381 111 234 567", national: "0111 234 567" });
    expect(info("+37251234567").formatted).toEqual({ international: "+372 512 345 67", national: "512 345 67" });
    // A lone trailing digit joins the group before it.
    expect(info("+3811112345678").formatted.international).toBe("+381 111 234 5678");
  });

  it("national keeps the national significant number, E.164 without the code", () => {
    expect(info("+420603123456")).toMatchObject({ countryCode: "420", national: "603123456" });
    expect(info("+390612345678")).toMatchObject({ countryCode: "39", national: "0612345678" });
  });
});

/* ------------------------------------------------ zones, currency, languages */

describe("time zones, currency and languages", () => {
  it("single-zone countries", () => {
    expect(info("+420603123456")).toMatchObject({ timeZones: ["Europe/Prague"], currency: "CZK", languages: ["cs"] });
    expect(info("+441534123456")).toMatchObject({ timeZones: ["Europe/Jersey"], currency: "GBP" });
    expect(info("+380671234567").timeZones).toEqual(["Europe/Kyiv"]);
    expect(info("+359888123456")).toMatchObject({ currency: "EUR", timeZones: ["Europe/Sofia"] });
  });

  it("several zones for the big countries", () => {
    expect(info("+12125550123").timeZones).toEqual(expect.arrayContaining(["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"]));
    expect(info("+14165550123").timeZones).toEqual(expect.arrayContaining(["America/Toronto", "America/Vancouver", "America/Halifax", "America/St_Johns"]));
    expect(info("+74951234567").timeZones).toEqual(expect.arrayContaining(["Europe/Moscow", "Europe/Kaliningrad", "Asia/Novosibirsk", "Asia/Vladivostok", "Asia/Kamchatka"]));
    expect(info("+61412345678").timeZones).toEqual(expect.arrayContaining(["Australia/Sydney", "Australia/Perth", "Australia/Adelaide"]));
    expect(info("+5511912345678").timeZones).toEqual(expect.arrayContaining(["America/Sao_Paulo", "America/Manaus", "America/Noronha"]));
    expect(info("+525512345678").timeZones).toContain("America/Mexico_City");
  });

  it("every geographic zone name looks like an IANA zone", () => {
    for (const c of CALLING_CODES.filter((r) => r.iso2 !== "001")) {
      const nsn = c.leading?.[0] ?? "";
      const probe = numberInfo(`+${c.code}${nsn}${"2345678".slice(0, Math.max(2, 9 - c.code.length - nsn.length))}`);
      if (!probe || probe.iso2 !== c.iso2) continue;
      expect(probe.timeZones.length, c.iso2).toBeGreaterThan(0);
      for (const z of probe.timeZones) expect(z, c.iso2).toMatch(/^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_\-/]+$/);
    }
  });

  it("zones are resolvable by the runtime's Intl data", () => {
    for (const z of [...info("+12125550123").timeZones, ...info("+74951234567").timeZones, "Europe/Kyiv", "Pacific/Kanton", "America/Nuuk"]) {
      expect(() => new Intl.DateTimeFormat("en", { timeZone: z }), z).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------ mergeLookups */

describe("mergeLookups", () => {
  const twilio: Partial<LookupResult> = {
    number: "+12125550123",
    provider: "twilio",
    valid: true,
    national: "(212) 555-0123",
    country: { code: "US", prefix: "+1" },
    type: "mobile",
    carrier: { name: "Verizon Wireless", mcc: "311", mnc: "480", type: "mobile" },
    callerName: "JANE DOE",
    raw: {},
  };

  it("provider data wins over the offline guess", () => {
    const s = mergeLookups(info("+12125550123"), [twilio]);
    expect(s).toMatchObject({
      e164: "+12125550123",
      valid: true,
      type: "mobile",
      carrier: { name: "Verizon Wireless", mcc: "311", mnc: "480" },
      callerName: "JANE DOE",
      ported: null,
      roaming: null,
      reachable: null,
      country: { iso2: "US", name: "United States", callingCode: "1" },
      formatted: { international: "+1 212-555-0123", national: "(212) 555-0123" },
      region: { area: "North America" },
      conflicts: [],
    });
    expect(s.timeZones).toContain("America/New_York");
    expect(s.sources.offline).toMatchObject({ kind: "offline", type: "unknown", country: "US" });
    expect(s.sources.twilio).toMatchObject({ kind: "lookup", type: "mobile", callerName: "JANE DOE" });
  });

  it("without providers the offline guess is the answer", () => {
    const s = mergeLookups(info("+420603123456"), []);
    expect(s).toMatchObject({
      e164: "+420603123456", valid: true, type: "mobile", carrier: null, callerName: null,
      country: { iso2: "CZ", name: "Czechia", callingCode: "420" },
      formatted: { international: "+420 603 123 456", national: "603 123 456" },
      timeZones: ["Europe/Prague"], conflicts: [],
    });
    expect(Object.keys(s.sources)).toEqual(["offline"]);
    expect(mergeLookups(info("+42060312345"), []).valid).toBe(false);
  });

  it("keeps every source's values when providers disagree; the first answer wins the headline", () => {
    const telnyx: Partial<LookupResult> = {
      number: "+12125550123",
      provider: "telnyx",
      type: "voip",
      carrier: { name: "Bandwidth.com CLEC", mcc: "313", mnc: "100" },
      ported: true,
      region: { city: "NEW YORK", state: "NY" },
    };
    const s = mergeLookups(info("+12125550123"), [twilio, telnyx]);
    expect(s.type).toBe("mobile");
    expect(s.carrier).toEqual({ name: "Verizon Wireless", mcc: "311", mnc: "480" });
    expect(s.ported).toBe(true);
    expect(s.region).toEqual({ area: "North America", city: "NEW YORK", state: "NY" });
    expect(s.conflicts).toEqual(["type", "carrier"]);
    expect(s.sources.twilio.type).toBe("mobile");
    expect(s.sources.telnyx.type).toBe("voip");
    expect(s.sources.telnyx.carrier).toEqual({ name: "Bandwidth.com CLEC", mcc: "313", mnc: "100" });

    const reversed = mergeLookups(info("+12125550123"), [telnyx, twilio]);
    expect(reversed.type).toBe("voip");
    expect(reversed.conflicts).toEqual(["type", "carrier"]);
  });

  it("an HLR answer wins the live network fields, a lookup the rest", () => {
    const vonage: Partial<LookupResult> = {
      number: "+447700900123",
      provider: "vonage",
      type: "mobile",
      national: "07700 900123",
      country: { code: "GB", name: "United Kingdom", prefix: "+44" },
      carrier: { name: "EE", mcc: "234", mnc: "30" },
      ported: false,
      reachable: "unknown",
      roaming: { status: "not_roaming" },
    };
    const hlr: Partial<HlrResult> = {
      number: "+447700900123",
      provider: "hlrlookups",
      status: "connected",
      valid: true,
      reachable: "CONNECTED",
      network: { name: "Vodafone UK", mcc: "234", mnc: "15", country: "GB" },
      original: { name: "EE", country: "GB" },
      ported: true,
      roaming: { status: "roaming", country: "FR", network: "Orange F" },
    };
    const s = mergeLookups(info("+447700900123"), [vonage, hlr]);
    expect(s.ported).toBe(true);
    expect(s.carrier).toEqual({ name: "Vodafone UK", mcc: "234", mnc: "15" });
    expect(s.reachable).toBe("connected");
    expect(s.roaming).toEqual({ status: "roaming", country: "FR", network: "Orange F" });
    expect(s.valid).toBe(true);
    expect(s.type).toBe("mobile");
    expect(s.country?.iso2).toBe("GB");
    expect(s.formatted).toEqual({ international: "+44 7700 900123", national: "07700 900123" });
    expect(s.conflicts).toEqual(["carrier", "ported", "roaming"]);
    expect(s.sources.vonage).toMatchObject({ kind: "lookup", ported: false, roaming: { status: "not_roaming" } });
    expect(s.sources.vonage.reachable).toBeUndefined(); // "unknown" is no answer
    expect(s.sources.hlrlookups).toMatchObject({ kind: "hlr", ported: true, reachable: "connected", country: "GB" });
  });

  it("the same provider twice gets distinct source keys", () => {
    const lookup: Partial<LookupResult> = { number: "+447700900123", provider: "vonage", type: "mobile" };
    const hlr: Partial<HlrResult> = { number: "+447700900123", provider: "vonage", status: "absent" };
    const s = mergeLookups(info("+447700900123"), [lookup, hlr]);
    expect(Object.keys(s.sources).sort()).toEqual(["offline", "vonage", "vonage:hlr"]);
    expect(s.reachable).toBe("absent");
  });

  it("a provider's 'unknown' type does not override the offline guess", () => {
    const s = mergeLookups(info("+420603123456"), [{ number: "+420603123456", provider: "twilio", type: "unknown" }]);
    expect(s.type).toBe("mobile");
    expect(s.sources.twilio.type).toBeUndefined();
  });

  it("provider type words are mapped to the neutral types", () => {
    const one = (type: string) => mergeLookups(info("+12125550123"), [{ provider: "twilio", type }]).type;
    expect(one("toll-free")).toBe("tollfree");
    expect(one("shared-cost")).toBe("shared");
    expect(one("landline")).toBe("landline");
    expect(one("fixedVoip")).toBe("voip");
    expect(one("pager")).toBe("pager");
  });

  it("the provider's country wins, and brings its time zones", () => {
    const s = mergeLookups(info("+12125550123"), [{ provider: "telnyx", number: "+12125550123", country: { code: "CA" } }]);
    expect(s.country).toEqual({ iso2: "CA", name: "Canada", callingCode: "1" });
    expect(s.timeZones).toContain("America/Toronto");
    expect(s.timeZones).not.toContain("America/Chicago");
    expect(s.region?.area).toBe("North America");
  });

  it("an HLR's network country (or MCC) backs up a missing lookup country", () => {
    const s = mergeLookups(null, [{ number: "+420603123456", provider: "hlrlookups", status: "connected", network: { mcc: "230", mnc: "03" } }]);
    expect(s.country?.iso2).toBe("CZ");
    expect(s.sources.hlrlookups.country).toBe("CZ");
  });

  it("works without an offline guess by reading the provider's number", () => {
    const s = mergeLookups(null, [twilio]);
    expect(s.e164).toBe("+12125550123");
    expect(s.formatted).toEqual({ international: "+1 212-555-0123", national: "(212) 555-0123" });
    expect(s.country?.iso2).toBe("US");
    expect(s.type).toBe("mobile");
  });

  it("an HLR 'invalid' makes the number invalid; 'undetermined' says nothing", () => {
    const invalid = mergeLookups(info("+447700900123"), [{ provider: "hlrlookups", status: "invalid" }]);
    expect(invalid.valid).toBe(false);
    expect(invalid.reachable).toBe("invalid");
    const unsure = mergeLookups(info("+447700900123"), [{ provider: "hlrlookups", status: "undetermined", valid: null }]);
    expect(unsure.valid).toBe(true); // the offline length check
    expect(unsure.reachable).toBeNull();
    expect(unsure.type).toBe("mobile"); // the offline guess
  });

  it("nothing at all", () => {
    expect(mergeLookups(null, [])).toEqual({
      e164: null, valid: null, type: "unknown", carrier: null, callerName: null, ported: null, roaming: null,
      reachable: null, region: null, country: null, formatted: null, timeZones: [], sources: {}, conflicts: [],
    });
  });
});

/* ------------------------------------------------------------ MCC → ISO2 */

describe("mccmncCountry", () => {
  it.each([
    ["230", "CZ"], ["231", "SK"], ["262", "DE"], ["234", "GB"], ["235", "GB"], ["208", "FR"], ["222", "IT"],
    ["214", "ES"], ["250", "RU"], ["255", "UA"], ["286", "TR"], ["302", "CA"], ["310", "US"], ["311", "US"],
    ["316", "US"], ["334", "MX"], ["338", "JM"], ["404", "IN"], ["405", "IN"], ["425", "IL"], ["440", "JP"],
    ["450", "KR"], ["460", "CN"], ["505", "AU"], ["530", "NZ"], ["655", "ZA"], ["724", "BR"], ["722", "AR"],
    ["221", "XK"], ["297", "ME"], ["659", "SS"], ["901", "001"],
  ])("%s → %s", (mcc, iso) => {
    expect(mccmncCountry(mcc)).toBe(iso);
  });

  it("accepts MCC+MNC strings and numbers, rejects the rest", () => {
    expect(mccmncCountry("23001")).toBe("CZ");
    expect(mccmncCountry("310260")).toBe("US");
    expect(mccmncCountry("230-03")).toBe("CZ");
    expect(mccmncCountry(262)).toBe("DE");
    expect(mccmncCountry("999")).toBeNull();
    expect(mccmncCountry("000")).toBeNull();
    expect(mccmncCountry("23")).toBeNull();
    expect(mccmncCountry("abc")).toBeNull();
    expect(mccmncCountry("")).toBeNull();
    expect(mccmncCountry(null)).toBeNull();
    expect(mccmncCountry(undefined)).toBeNull();
  });

  it("every MCC maps to a territory of the calling-code table (or 001)", () => {
    const known = new Set(CALLING_CODES.map((c) => c.iso2));
    for (const [mcc, iso] of Object.entries(MCC_COUNTRIES)) {
      expect(mcc).toMatch(/^[2-7]\d\d$|^9\d\d$/);
      expect(known.has(iso), `${mcc} → ${iso}`).toBe(true);
    }
    expect(Object.keys(MCC_COUNTRIES).length).toBeGreaterThan(230);
  });
});
