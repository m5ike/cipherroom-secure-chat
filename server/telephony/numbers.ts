// Offline phone-number knowledge for m5.telephony.lookup (6.0): everything the
// server can tell about a number before it pays a provider for a lookup.
//
//   normalizeNumber(input, defaultCountry?)  human-typed number → E.164 (or null)
//   numberInfo(e164)                          country, line type, formats, zones, currency…
//   mergeLookups(offline, answers)            one summary over the offline guess + provider answers
//   mccmncCountry(mcc)                        E.212 mobile country code → ISO 3166 alpha-2
//   CALLING_CODES, NANP_AREA_CODES, CANADIAN_AREA_CODES, MCC_COUNTRIES   the tables
//
// All data lives in this file: no npm packages, no network. It was compiled from
//   - ITU-T E.164 "list of assigned country codes" (incl. the shared and non-geographic codes)
//   - ITU-T E.212 "list of mobile country codes"
//   - NANPA / CNAC area-code assignments (Caribbean and Pacific members, Canada)
//   - the national numbering plans (Ofcom, ČTÚ, BNetzA, RTR, UKE, NMHH, ARCEP, AGCOM, CNMC,
//     ACM, BIPT, BAKOM, PTS, Nkom, Traficom, ComReg, ANACOM, ACMA, Anatel, ICASA…) as also
//     reflected in Google libphonenumber's metadata (consulted, not imported)
//   - IANA tz zone names, ISO 4217 currency codes, ISO 639-1 language codes
// Where a plan does not tell line types apart by prefix (US/CA, MX, DK, most of IN) or the
// data was not certain, the type is "unknown" rather than a guess.
//
// Non-geographic codes (+800, +808, +870, +878, +881, +882, +883, +888, +979) use the
// UN M.49 "world" code "001" as their iso2, like libphonenumber does.

import type { HlrResult, LookupResult } from "./providers/types";

/* ------------------------------------------------------------------ types */

export type NumberType =
  | "mobile" | "landline" | "tollfree" | "premium" | "shared"
  | "voip" | "personal" | "pager" | "uan" | "unknown";

export type NumberInfo = {
  e164: string;
  /** Country calling code without "+", e.g. "420". */
  countryCode: string;
  /** National significant number (E.164 without the country code), e.g. "603123456". */
  national: string;
  /** ISO 3166 alpha-2 (best guess where a code is shared); "001" for non-geographic codes. */
  iso2: string;
  country: string;
  /** Continent / area: Europe, North America, Caribbean, Asia, Middle East, Africa, … */
  region: string;
  type: NumberType;
  formatted: { international: string; national: string };
  /** IANA zones of the country (the main ones). */
  timeZones: string[];
  /** ISO 4217 code of the country's currency. */
  currency?: string;
  /** Main language codes (ISO 639-1 where one exists). */
  languages?: string[];
  /** The national number's length fits the country's plan (where known), else true. */
  validLength: boolean;
};

export type CallingCode = {
  /** Country calling code without "+". */
  code: string;
  iso2: string;
  country: string;
  region: string;
  /** Leading digits of the national number that select this territory under a shared code. */
  leading?: readonly string[];
};

/* ------------------------------------------------------ the country table */

// code|iso2|country|region|IANA zones|ISO 4217|languages — one row per territory.
// Every code assigned in ITU-T E.164 (379 Vatican and 388 are reserved/unused and left out;
// the Vatican is reached under +39 06 698). Under a shared code the first row is the default.
const ROWS = `
1|US|United States|North America|America/New_York,America/Chicago,America/Denver,America/Phoenix,America/Los_Angeles,America/Anchorage,Pacific/Honolulu|USD|en
1|CA|Canada|North America|America/Toronto,America/Vancouver,America/Edmonton,America/Winnipeg,America/Regina,America/Halifax,America/St_Johns,America/Whitehorse|CAD|en,fr
1|AG|Antigua and Barbuda|Caribbean|America/Antigua|XCD|en
1|AI|Anguilla|Caribbean|America/Anguilla|XCD|en
1|AS|American Samoa|Oceania|Pacific/Pago_Pago|USD|en,sm
1|BB|Barbados|Caribbean|America/Barbados|BBD|en
1|BM|Bermuda|North America|Atlantic/Bermuda|BMD|en
1|BS|Bahamas|Caribbean|America/Nassau|BSD|en
1|DM|Dominica|Caribbean|America/Dominica|XCD|en
1|DO|Dominican Republic|Caribbean|America/Santo_Domingo|DOP|es
1|GD|Grenada|Caribbean|America/Grenada|XCD|en
1|GU|Guam|Oceania|Pacific/Guam|USD|en,ch
1|JM|Jamaica|Caribbean|America/Jamaica|JMD|en
1|KN|Saint Kitts and Nevis|Caribbean|America/St_Kitts|XCD|en
1|KY|Cayman Islands|Caribbean|America/Cayman|KYD|en
1|LC|Saint Lucia|Caribbean|America/St_Lucia|XCD|en
1|MP|Northern Mariana Islands|Oceania|Pacific/Saipan|USD|en,ch
1|MS|Montserrat|Caribbean|America/Montserrat|XCD|en
1|PR|Puerto Rico|Caribbean|America/Puerto_Rico|USD|es,en
1|SX|Sint Maarten|Caribbean|America/Lower_Princes|XCG|nl,en
1|TC|Turks and Caicos Islands|Caribbean|America/Grand_Turk|USD|en
1|TT|Trinidad and Tobago|Caribbean|America/Port_of_Spain|TTD|en
1|VC|Saint Vincent and the Grenadines|Caribbean|America/St_Vincent|XCD|en
1|VG|British Virgin Islands|Caribbean|America/Tortola|USD|en
1|VI|U.S. Virgin Islands|Caribbean|America/St_Thomas|USD|en
20|EG|Egypt|Africa|Africa/Cairo|EGP|ar
211|SS|South Sudan|Africa|Africa/Juba|SSP|en
212|MA|Morocco|Africa|Africa/Casablanca|MAD|ar,zgh,fr
212|EH|Western Sahara|Africa|Africa/El_Aaiun|MAD|ar,es
213|DZ|Algeria|Africa|Africa/Algiers|DZD|ar,fr
216|TN|Tunisia|Africa|Africa/Tunis|TND|ar,fr
218|LY|Libya|Africa|Africa/Tripoli|LYD|ar
220|GM|Gambia|Africa|Africa/Banjul|GMD|en
221|SN|Senegal|Africa|Africa/Dakar|XOF|fr,wo
222|MR|Mauritania|Africa|Africa/Nouakchott|MRU|ar,fr
223|ML|Mali|Africa|Africa/Bamako|XOF|fr,bm
224|GN|Guinea|Africa|Africa/Conakry|GNF|fr
225|CI|Côte d'Ivoire|Africa|Africa/Abidjan|XOF|fr
226|BF|Burkina Faso|Africa|Africa/Ouagadougou|XOF|fr
227|NE|Niger|Africa|Africa/Niamey|XOF|fr,ha
228|TG|Togo|Africa|Africa/Lome|XOF|fr
229|BJ|Benin|Africa|Africa/Porto-Novo|XOF|fr
230|MU|Mauritius|Africa|Indian/Mauritius|MUR|en,fr
231|LR|Liberia|Africa|Africa/Monrovia|LRD|en
232|SL|Sierra Leone|Africa|Africa/Freetown|SLE|en
233|GH|Ghana|Africa|Africa/Accra|GHS|en
234|NG|Nigeria|Africa|Africa/Lagos|NGN|en
235|TD|Chad|Africa|Africa/Ndjamena|XAF|fr,ar
236|CF|Central African Republic|Africa|Africa/Bangui|XAF|fr,sg
237|CM|Cameroon|Africa|Africa/Douala|XAF|fr,en
238|CV|Cabo Verde|Africa|Atlantic/Cape_Verde|CVE|pt
239|ST|São Tomé and Príncipe|Africa|Africa/Sao_Tome|STN|pt
240|GQ|Equatorial Guinea|Africa|Africa/Malabo|XAF|es,fr,pt
241|GA|Gabon|Africa|Africa/Libreville|XAF|fr
242|CG|Republic of the Congo|Africa|Africa/Brazzaville|XAF|fr
243|CD|DR Congo|Africa|Africa/Kinshasa,Africa/Lubumbashi|CDF|fr
244|AO|Angola|Africa|Africa/Luanda|AOA|pt
245|GW|Guinea-Bissau|Africa|Africa/Bissau|XOF|pt
246|IO|British Indian Ocean Territory|Africa|Indian/Chagos|USD|en
247|AC|Ascension Island|Africa|Atlantic/St_Helena|SHP|en
248|SC|Seychelles|Africa|Indian/Mahe|SCR|en,fr
249|SD|Sudan|Africa|Africa/Khartoum|SDG|ar,en
250|RW|Rwanda|Africa|Africa/Kigali|RWF|rw,en,fr
251|ET|Ethiopia|Africa|Africa/Addis_Ababa|ETB|am
252|SO|Somalia|Africa|Africa/Mogadishu|SOS|so,ar
253|DJ|Djibouti|Africa|Africa/Djibouti|DJF|fr,ar
254|KE|Kenya|Africa|Africa/Nairobi|KES|sw,en
255|TZ|Tanzania|Africa|Africa/Dar_es_Salaam|TZS|sw,en
256|UG|Uganda|Africa|Africa/Kampala|UGX|en,sw
257|BI|Burundi|Africa|Africa/Bujumbura|BIF|rn,fr
258|MZ|Mozambique|Africa|Africa/Maputo|MZN|pt
260|ZM|Zambia|Africa|Africa/Lusaka|ZMW|en
261|MG|Madagascar|Africa|Indian/Antananarivo|MGA|mg,fr
262|RE|Réunion|Africa|Indian/Reunion|EUR|fr
262|YT|Mayotte|Africa|Indian/Mayotte|EUR|fr
263|ZW|Zimbabwe|Africa|Africa/Harare|ZWG|en,sn,nd
264|NA|Namibia|Africa|Africa/Windhoek|NAD|en
265|MW|Malawi|Africa|Africa/Blantyre|MWK|en,ny
266|LS|Lesotho|Africa|Africa/Maseru|LSL|st,en
267|BW|Botswana|Africa|Africa/Gaborone|BWP|en,tn
268|SZ|Eswatini|Africa|Africa/Mbabane|SZL|en,ss
269|KM|Comoros|Africa|Indian/Comoro|KMF|ar,fr
27|ZA|South Africa|Africa|Africa/Johannesburg|ZAR|en,zu,xh,af
290|SH|Saint Helena|Africa|Atlantic/St_Helena|SHP|en
290|TA|Tristan da Cunha|Africa|Atlantic/St_Helena|GBP|en
291|ER|Eritrea|Africa|Africa/Asmara|ERN|ti,ar,en
297|AW|Aruba|Caribbean|America/Aruba|AWG|nl,pap
298|FO|Faroe Islands|Europe|Atlantic/Faroe|DKK|fo,da
299|GL|Greenland|North America|America/Nuuk,America/Danmarkshavn,America/Scoresbysund,America/Thule|DKK|kl,da
30|GR|Greece|Europe|Europe/Athens|EUR|el
31|NL|Netherlands|Europe|Europe/Amsterdam|EUR|nl
32|BE|Belgium|Europe|Europe/Brussels|EUR|nl,fr,de
33|FR|France|Europe|Europe/Paris|EUR|fr
34|ES|Spain|Europe|Europe/Madrid,Atlantic/Canary,Africa/Ceuta|EUR|es,ca,gl,eu
350|GI|Gibraltar|Europe|Europe/Gibraltar|GIP|en
351|PT|Portugal|Europe|Europe/Lisbon,Atlantic/Azores,Atlantic/Madeira|EUR|pt
352|LU|Luxembourg|Europe|Europe/Luxembourg|EUR|lb,fr,de
353|IE|Ireland|Europe|Europe/Dublin|EUR|en,ga
354|IS|Iceland|Europe|Atlantic/Reykjavik|ISK|is
355|AL|Albania|Europe|Europe/Tirane|ALL|sq
356|MT|Malta|Europe|Europe/Malta|EUR|mt,en
357|CY|Cyprus|Europe|Asia/Nicosia,Asia/Famagusta|EUR|el,tr
358|FI|Finland|Europe|Europe/Helsinki|EUR|fi,sv
358|AX|Åland Islands|Europe|Europe/Mariehamn|EUR|sv
359|BG|Bulgaria|Europe|Europe/Sofia|EUR|bg
36|HU|Hungary|Europe|Europe/Budapest|HUF|hu
370|LT|Lithuania|Europe|Europe/Vilnius|EUR|lt
371|LV|Latvia|Europe|Europe/Riga|EUR|lv
372|EE|Estonia|Europe|Europe/Tallinn|EUR|et
373|MD|Moldova|Europe|Europe/Chisinau|MDL|ro
374|AM|Armenia|Asia|Asia/Yerevan|AMD|hy
375|BY|Belarus|Europe|Europe/Minsk|BYN|be,ru
376|AD|Andorra|Europe|Europe/Andorra|EUR|ca
377|MC|Monaco|Europe|Europe/Monaco|EUR|fr
378|SM|San Marino|Europe|Europe/San_Marino|EUR|it
380|UA|Ukraine|Europe|Europe/Kyiv|UAH|uk
381|RS|Serbia|Europe|Europe/Belgrade|RSD|sr
382|ME|Montenegro|Europe|Europe/Podgorica|EUR|sr
383|XK|Kosovo|Europe|Europe/Belgrade|EUR|sq,sr
385|HR|Croatia|Europe|Europe/Zagreb|EUR|hr
386|SI|Slovenia|Europe|Europe/Ljubljana|EUR|sl
387|BA|Bosnia and Herzegovina|Europe|Europe/Sarajevo|BAM|bs,hr,sr
389|MK|North Macedonia|Europe|Europe/Skopje|MKD|mk,sq
39|IT|Italy|Europe|Europe/Rome|EUR|it
39|VA|Vatican City|Europe|Europe/Vatican|EUR|it,la
40|RO|Romania|Europe|Europe/Bucharest|RON|ro
41|CH|Switzerland|Europe|Europe/Zurich|CHF|de,fr,it,rm
420|CZ|Czechia|Europe|Europe/Prague|CZK|cs
421|SK|Slovakia|Europe|Europe/Bratislava|EUR|sk
423|LI|Liechtenstein|Europe|Europe/Vaduz|CHF|de
43|AT|Austria|Europe|Europe/Vienna|EUR|de
44|GB|United Kingdom|Europe|Europe/London|GBP|en
44|GG|Guernsey|Europe|Europe/Guernsey|GBP|en
44|JE|Jersey|Europe|Europe/Jersey|GBP|en
44|IM|Isle of Man|Europe|Europe/Isle_of_Man|GBP|en,gv
45|DK|Denmark|Europe|Europe/Copenhagen|DKK|da
46|SE|Sweden|Europe|Europe/Stockholm|SEK|sv
47|NO|Norway|Europe|Europe/Oslo|NOK|nb,nn
47|SJ|Svalbard and Jan Mayen|Europe|Arctic/Longyearbyen|NOK|nb
48|PL|Poland|Europe|Europe/Warsaw|PLN|pl
49|DE|Germany|Europe|Europe/Berlin|EUR|de
500|FK|Falkland Islands|South America|Atlantic/Stanley|FKP|en
500|GS|South Georgia and the South Sandwich Islands|South America|Atlantic/South_Georgia|GBP|en
501|BZ|Belize|Central America|America/Belize|BZD|en,es
502|GT|Guatemala|Central America|America/Guatemala|GTQ|es
503|SV|El Salvador|Central America|America/El_Salvador|USD|es
504|HN|Honduras|Central America|America/Tegucigalpa|HNL|es
505|NI|Nicaragua|Central America|America/Managua|NIO|es
506|CR|Costa Rica|Central America|America/Costa_Rica|CRC|es
507|PA|Panama|Central America|America/Panama|PAB|es
508|PM|Saint Pierre and Miquelon|North America|America/Miquelon|EUR|fr
509|HT|Haiti|Caribbean|America/Port-au-Prince|HTG|fr,ht
51|PE|Peru|South America|America/Lima|PEN|es,qu
52|MX|Mexico|North America|America/Mexico_City,America/Cancun,America/Merida,America/Monterrey,America/Chihuahua,America/Hermosillo,America/Mazatlan,America/Tijuana|MXN|es
53|CU|Cuba|Caribbean|America/Havana|CUP|es
54|AR|Argentina|South America|America/Argentina/Buenos_Aires,America/Argentina/Cordoba|ARS|es
55|BR|Brazil|South America|America/Sao_Paulo,America/Bahia,America/Fortaleza,America/Recife,America/Belem,America/Manaus,America/Cuiaba,America/Campo_Grande,America/Porto_Velho,America/Boa_Vista,America/Rio_Branco,America/Noronha|BRL|pt
56|CL|Chile|South America|America/Santiago,America/Punta_Arenas,Pacific/Easter|CLP|es
57|CO|Colombia|South America|America/Bogota|COP|es
58|VE|Venezuela|South America|America/Caracas|VES|es
590|GP|Guadeloupe|Caribbean|America/Guadeloupe|EUR|fr
590|BL|Saint Barthélemy|Caribbean|America/St_Barthelemy|EUR|fr
590|MF|Saint Martin|Caribbean|America/Marigot|EUR|fr
591|BO|Bolivia|South America|America/La_Paz|BOB|es,qu,ay
592|GY|Guyana|South America|America/Guyana|GYD|en
593|EC|Ecuador|South America|America/Guayaquil,Pacific/Galapagos|USD|es
594|GF|French Guiana|South America|America/Cayenne|EUR|fr
595|PY|Paraguay|South America|America/Asuncion|PYG|es,gn
596|MQ|Martinique|Caribbean|America/Martinique|EUR|fr
597|SR|Suriname|South America|America/Paramaribo|SRD|nl
598|UY|Uruguay|South America|America/Montevideo|UYU|es
599|CW|Curaçao|Caribbean|America/Curacao|XCG|nl,pap
599|BQ|Caribbean Netherlands|Caribbean|America/Kralendijk|USD|nl,pap
60|MY|Malaysia|Asia|Asia/Kuala_Lumpur,Asia/Kuching|MYR|ms
61|AU|Australia|Oceania|Australia/Sydney,Australia/Melbourne,Australia/Brisbane,Australia/Adelaide,Australia/Darwin,Australia/Perth,Australia/Hobart|AUD|en
61|CX|Christmas Island|Oceania|Indian/Christmas|AUD|en
61|CC|Cocos (Keeling) Islands|Oceania|Indian/Cocos|AUD|en,ms
62|ID|Indonesia|Asia|Asia/Jakarta,Asia/Pontianak,Asia/Makassar,Asia/Jayapura|IDR|id
63|PH|Philippines|Asia|Asia/Manila|PHP|tl,en
64|NZ|New Zealand|Oceania|Pacific/Auckland,Pacific/Chatham|NZD|en,mi
64|PN|Pitcairn Islands|Oceania|Pacific/Pitcairn|NZD|en
65|SG|Singapore|Asia|Asia/Singapore|SGD|en,ms,zh,ta
66|TH|Thailand|Asia|Asia/Bangkok|THB|th
670|TL|Timor-Leste|Asia|Asia/Dili|USD|pt,tet
672|NF|Norfolk Island|Oceania|Pacific/Norfolk|AUD|en
672|AQ|Antarctica|Antarctica|Antarctica/Casey,Antarctica/Davis,Antarctica/Mawson||en
673|BN|Brunei|Asia|Asia/Brunei|BND|ms
674|NR|Nauru|Oceania|Pacific/Nauru|AUD|na,en
675|PG|Papua New Guinea|Oceania|Pacific/Port_Moresby,Pacific/Bougainville|PGK|en,tpi,ho
676|TO|Tonga|Oceania|Pacific/Tongatapu|TOP|to,en
677|SB|Solomon Islands|Oceania|Pacific/Guadalcanal|SBD|en
678|VU|Vanuatu|Oceania|Pacific/Efate|VUV|bi,en,fr
679|FJ|Fiji|Oceania|Pacific/Fiji|FJD|en,fj,hif
680|PW|Palau|Oceania|Pacific/Palau|USD|en
681|WF|Wallis and Futuna|Oceania|Pacific/Wallis|XPF|fr
682|CK|Cook Islands|Oceania|Pacific/Rarotonga|NZD|en
683|NU|Niue|Oceania|Pacific/Niue|NZD|en
685|WS|Samoa|Oceania|Pacific/Apia|WST|sm,en
686|KI|Kiribati|Oceania|Pacific/Tarawa,Pacific/Kanton,Pacific/Kiritimati|AUD|en
687|NC|New Caledonia|Oceania|Pacific/Noumea|XPF|fr
688|TV|Tuvalu|Oceania|Pacific/Funafuti|AUD|en
689|PF|French Polynesia|Oceania|Pacific/Tahiti,Pacific/Marquesas,Pacific/Gambier|XPF|fr
690|TK|Tokelau|Oceania|Pacific/Fakaofo|NZD|en
691|FM|Micronesia|Oceania|Pacific/Chuuk,Pacific/Pohnpei,Pacific/Kosrae|USD|en
692|MH|Marshall Islands|Oceania|Pacific/Majuro,Pacific/Kwajalein|USD|en,mh
7|RU|Russia|Europe|Europe/Moscow,Europe/Kaliningrad,Europe/Samara,Asia/Yekaterinburg,Asia/Omsk,Asia/Novosibirsk,Asia/Krasnoyarsk,Asia/Irkutsk,Asia/Yakutsk,Asia/Vladivostok,Asia/Magadan,Asia/Kamchatka|RUB|ru
7|KZ|Kazakhstan|Asia|Asia/Almaty,Asia/Aqtobe,Asia/Aqtau,Asia/Oral,Asia/Atyrau,Asia/Qostanay,Asia/Qyzylorda|KZT|kk,ru
800|001|International Freephone Service|International|||
808|001|International Shared Cost Service|International|||
81|JP|Japan|Asia|Asia/Tokyo|JPY|ja
82|KR|South Korea|Asia|Asia/Seoul|KRW|ko
84|VN|Vietnam|Asia|Asia/Ho_Chi_Minh|VND|vi
850|KP|North Korea|Asia|Asia/Pyongyang|KPW|ko
852|HK|Hong Kong|Asia|Asia/Hong_Kong|HKD|zh,en
853|MO|Macao|Asia|Asia/Macau|MOP|zh,pt
855|KH|Cambodia|Asia|Asia/Phnom_Penh|KHR|km
856|LA|Laos|Asia|Asia/Vientiane|LAK|lo
86|CN|China|Asia|Asia/Shanghai,Asia/Urumqi|CNY|zh
870|001|Inmarsat SNAC|International|||
878|001|Universal Personal Telecommunications|International|||
880|BD|Bangladesh|Asia|Asia/Dhaka|BDT|bn
881|001|Global Mobile Satellite System|International|||
882|001|International Networks|International|||
883|001|International Networks|International|||
886|TW|Taiwan|Asia|Asia/Taipei|TWD|zh
888|001|OCHA Telecommunications for Disaster Relief|International|||
90|TR|Türkiye|Middle East|Europe/Istanbul|TRY|tr
91|IN|India|Asia|Asia/Kolkata|INR|hi,en
92|PK|Pakistan|Asia|Asia/Karachi|PKR|ur,en
93|AF|Afghanistan|Asia|Asia/Kabul|AFN|ps,fa
94|LK|Sri Lanka|Asia|Asia/Colombo|LKR|si,ta
95|MM|Myanmar|Asia|Asia/Yangon|MMK|my
960|MV|Maldives|Asia|Indian/Maldives|MVR|dv
961|LB|Lebanon|Middle East|Asia/Beirut|LBP|ar
962|JO|Jordan|Middle East|Asia/Amman|JOD|ar
963|SY|Syria|Middle East|Asia/Damascus|SYP|ar
964|IQ|Iraq|Middle East|Asia/Baghdad|IQD|ar,ku
965|KW|Kuwait|Middle East|Asia/Kuwait|KWD|ar
966|SA|Saudi Arabia|Middle East|Asia/Riyadh|SAR|ar
967|YE|Yemen|Middle East|Asia/Aden|YER|ar
968|OM|Oman|Middle East|Asia/Muscat|OMR|ar
970|PS|Palestine|Middle East|Asia/Gaza,Asia/Hebron|ILS|ar
971|AE|United Arab Emirates|Middle East|Asia/Dubai|AED|ar
972|IL|Israel|Middle East|Asia/Jerusalem|ILS|he,ar
973|BH|Bahrain|Middle East|Asia/Bahrain|BHD|ar
974|QA|Qatar|Middle East|Asia/Qatar|QAR|ar
975|BT|Bhutan|Asia|Asia/Thimphu|BTN|dz
976|MN|Mongolia|Asia|Asia/Ulaanbaatar,Asia/Hovd|MNT|mn
977|NP|Nepal|Asia|Asia/Kathmandu|NPR|ne
979|001|International Premium Rate Service|International|||
98|IR|Iran|Middle East|Asia/Tehran|IRR|fa
992|TJ|Tajikistan|Asia|Asia/Dushanbe|TJS|tg
993|TM|Turkmenistan|Asia|Asia/Ashgabat|TMT|tk
994|AZ|Azerbaijan|Asia|Asia/Baku|AZN|az
995|GE|Georgia|Asia|Asia/Tbilisi|GEL|ka
996|KG|Kyrgyzstan|Asia|Asia/Bishkek|KGS|ky,ru
998|UZ|Uzbekistan|Asia|Asia/Tashkent,Asia/Samarkand|UZS|uz
`;

/* -------------------------------------------------------------- NANP (+1) */

/** Caribbean and Pacific NANP members by area code (NANPA). */
const NANP_MEMBERS: Readonly<Record<string, string>> = {
  "242": "BS", "246": "BB", "264": "AI", "268": "AG", "284": "VG", "340": "VI", "345": "KY",
  "441": "BM", "473": "GD", "649": "TC", "658": "JM", "876": "JM", "664": "MS", "670": "MP",
  "671": "GU", "684": "AS", "721": "SX", "758": "LC", "767": "DM", "784": "VC", "787": "PR",
  "939": "PR", "809": "DO", "829": "DO", "849": "DO", "868": "TT", "869": "KN",
};

/**
 * Area codes assigned to Canada (CNAC / NANPA), including the overlays in service or
 * assigned for introduction through 2025–26 (257 BC, 942 Toronto) and 600 (Canadian
 * non-geographic services). Every other +1 area code that is not a Caribbean or Pacific
 * member is the United States.
 */
export const CANADIAN_AREA_CODES: readonly string[] = Object.freeze([
  "204", "226", "236", "249", "250", "257", "263", "289", "306", "343", "354", "365", "367", "368",
  "382", "387", "403", "416", "418", "428", "431", "437", "438", "450", "468", "474", "506", "514",
  "519", "548", "579", "581", "584", "587", "600", "604", "613", "639", "647", "672", "683", "705",
  "709", "742", "753", "778", "780", "782", "807", "819", "825", "867", "873", "879", "902", "905",
  "942",
]);

/** Every +1 area code that is not the United States → ISO2 (Canada and the Caribbean/Pacific members). */
export const NANP_AREA_CODES: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(CANADIAN_AREA_CODES.map((a) => [a, "CA"])),
  ...NANP_MEMBERS,
});

/* ------------------------------------------------ shared-code territories */

/** Leading national digits that pick a territory under a shared country code. */
const LEADING: Readonly<Record<string, readonly string[]>> = {
  // +7: 6xx and 7xx are Kazakhstan, the rest Russia.
  KZ: ["6", "7"],
  // +44: Crown Dependencies — landline area codes and their mobile ranges.
  GG: ["1481", "7781", "7839", "79111", "79117"],
  JE: ["1534", "7509", "77003", "77007", "77008", "7797", "7829", "7937"],
  IM: ["1624", "74576", "7524", "7624", "7924"],
  // +47 79 Svalbard, +358 18 Åland.
  SJ: ["79"],
  AX: ["18"],
  // +599: 9 Curaçao; 3 Sint Eustatius, 4 Saba, 7 Bonaire.
  CW: ["9"],
  BQ: ["3", "4", "7"],
  // +39 06 698 Vatican.
  VA: ["06698"],
  // +61 8 9164 Christmas Island, 8 9162 Cocos (Keeling).
  CX: ["89164"],
  CC: ["89162"],
  // +262 269 / 639 Mayotte, the rest Réunion.
  YT: ["269", "639"],
  // +290 8 Tristan da Cunha.
  TA: ["8"],
  // +212 528 8/9 Western Sahara.
  EH: ["5288", "5289"],
  // +672 1x Australian Antarctic bases, 3x Norfolk Island.
  AQ: ["1"],
  // +1: the area-code tables above.
  ...Object.fromEntries(
    Object.entries(NANP_AREA_CODES).reduce((acc, [area, iso]) => {
      acc.set(iso, [...(acc.get(iso) ?? []), area]);
      return acc;
    }, new Map<string, string[]>()),
  ),
};

type Meta = { timeZones: readonly string[]; currency?: string; languages?: readonly string[] };

const ENTRIES: CallingCode[] = [];
const META = new Map<string, Meta>();
for (const line of ROWS.trim().split("\n")) {
  const [code, iso2, country, region, zones, currency, langs] = line.trim().split("|");
  const leading = LEADING[iso2];
  ENTRIES.push(leading ? { code, iso2, country, region, leading: Object.freeze([...leading]) } : { code, iso2, country, region });
  if (iso2 !== "001") {
    META.set(iso2, {
      timeZones: zones ? zones.split(",") : [],
      currency: currency || undefined,
      languages: langs ? langs.split(",") : undefined,
    });
  }
}

/** Every assigned ITU-T E.164 country calling code, one row per territory. */
export const CALLING_CODES: readonly CallingCode[] = Object.freeze(ENTRIES.map((e) => Object.freeze(e)));

const BY_CODE = new Map<string, CallingCode[]>();
const BY_ISO = new Map<string, CallingCode>();
for (const e of CALLING_CODES) {
  BY_CODE.set(e.code, [...(BY_CODE.get(e.code) ?? []), e]);
  if (e.iso2 !== "001" && !BY_ISO.has(e.iso2)) BY_ISO.set(e.iso2, e);
}

/** The assigned country code at the start of international digits (E.164 codes are prefix-free). */
function codeOf(digits: string): string | undefined {
  for (let n = 1; n <= 3 && n <= digits.length; n++) {
    const c = digits.slice(0, n);
    if (BY_CODE.has(c)) return c;
  }
  return undefined;
}

/** The territory for a national number under its code: longest matching `leading`, else the default. */
function territory(code: string, nsn: string): CallingCode {
  const entries = BY_CODE.get(code) ?? [];
  let best: CallingCode | undefined;
  let bestLen = 0;
  for (const e of entries) {
    for (const p of e.leading ?? []) {
      if (p.length > bestLen && nsn.startsWith(p)) { best = e; bestLen = p.length; }
    }
  }
  return best ?? entries.find((e) => !e.leading) ?? entries[0];
}

/* ---------------------------------------------------------- trunk prefixes */

// The national (trunk) prefix dialled before the national number at home. Countries not
// listed have a closed plan (no prefix): CZ, PL, ES, PT, NO, DK, GR, LU, EE, LV, MT, CY,
// most of the Caribbean, Central America, West Africa… Italy (and San Marino, the
// Vatican) dial the leading 0 as part of the number itself.
const TRUNK: Record<string, string> = {};
for (const iso of (
  "AE AF AL AM AR AT AU AX AZ BA BD BE BG BL BO BR CC CD CH CN CU CX DE DZ EC EG EH ER ET FI FR GB GE GF " +
  "GG GH GP HR ID IE IL IM IN IQ IR JE JO JP KE KG KH KR LA LB LK LR LT LY MA MD ME MF MG MK MM MN MQ " +
  "MW MY NA NG NL NP NZ PE PH PK PM PS PY RE RO RS RW SA SD SE SI SK SL SO SS SY TH TR TW TZ UA UG UY " +
  "VE VN XK YE YT ZA ZM ZW"
).split(" ")) TRUNK[iso] = "0";
TRUNK.RU = "8";
TRUNK.KZ = "8";
TRUNK.BY = "8 0";
TRUNK.HU = "06";
for (const e of BY_CODE.get("1") ?? []) TRUNK[e.iso2] = "1";

/** Other prefixes accepted when parsing a national number (Lithuania moved 8 → 0). */
const TRUNK_PARSE_EXTRA: Record<string, readonly string[]> = { LT: ["8"] };

const trunkOf = (iso2: string): string => TRUNK[iso2] ?? "";

/* ------------------------------------------------------ numbering plans */

type Rule = { re: RegExp; type: NumberType; len?: readonly number[]; strict?: boolean };
type Rendered = { intl: string; national: string };
type Plan = {
  /** First matching rule wins; `strict` rules only match at one of their lengths. */
  rules?: readonly Rule[];
  /** Every valid national-number length (for validLength and parsing). */
  lengths?: readonly number[];
  /** Digit-group sizes for formatting; the last group takes the rest. */
  groups?: (nsn: string) => readonly number[] | undefined;
  /** A complete custom rendering (NANP, Brazil, Russia…). */
  render?: (nsn: string) => Rendered | undefined;
};

const rule = (prefix: string, type: NumberType, len?: readonly number[], strict = false): Rule =>
  ({ re: new RegExp(`^(?:${prefix})`), type, len, strict });
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

function split(nsn: string, sizes: readonly number[]): string[] {
  const out: string[] = [];
  let i = 0;
  sizes.forEach((size, k) => {
    if (i >= nsn.length) return;
    const take = k === sizes.length - 1 ? nsn.length - i : size;
    if (take > 0) out.push(nsn.slice(i, i + take));
    i += Math.max(0, take);
  });
  if (i < nsn.length) out.push(nsn.slice(i));
  return out;
}

/** Groups of three; a lone trailing digit joins the group before it. */
function threes(nsn: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < nsn.length; i += 3) out.push(nsn.slice(i, i + 3));
  const last = out[out.length - 1];
  if (out.length > 1 && last.length === 1) {
    out.pop();
    out[out.length - 1] += last;
  }
  return out;
}

function nanpRender(n: string): Rendered | undefined {
  if (n.length !== 10) return undefined;
  const [a, b, c] = [n.slice(0, 3), n.slice(3, 6), n.slice(6)];
  return { intl: `${a}-${b}-${c}`, national: `(${a}) ${b}-${c}` };
}

function ruRender(n: string): Rendered | undefined {
  if (n.length !== 10) return undefined;
  const tail = `${n.slice(3, 6)}-${n.slice(6, 8)}-${n.slice(8)}`;
  return { intl: `${n.slice(0, 3)} ${tail}`, national: `8 (${n.slice(0, 3)}) ${tail}` };
}

function brRender(n: string): Rendered | undefined {
  if (/^[1-9]{2}9\d{8}$/.test(n)) {
    const b = `${n.slice(2, 7)}-${n.slice(7)}`;
    return { intl: `${n.slice(0, 2)} ${b}`, national: `(${n.slice(0, 2)}) ${b}` };
  }
  if (/^[1-9]{2}[2-5]\d{7}$/.test(n)) {
    const b = `${n.slice(2, 6)}-${n.slice(6)}`;
    return { intl: `${n.slice(0, 2)} ${b}`, national: `(${n.slice(0, 2)}) ${b}` };
  }
  if (/^[34]0\d{6}$/.test(n)) {
    const b = `${n.slice(0, 4)}-${n.slice(4)}`;
    return { intl: b, national: b };
  }
  if (/^[3589]00\d{6,7}$/.test(n)) {
    const b = split(n, [3, 3, 4]).join(" ");
    return { intl: b, national: `0${b}` };
  }
  return undefined;
}

function gbGroups(n: string): number[] {
  if (/^2/.test(n)) return [2, 4, 4];
  if (/^1(?:1\d|\d1)/.test(n)) return [3, 3, 4];
  if (/^1(?:3873|5242|539[4-6]|697[347]|768[347]|9467)/.test(n)) return [5, 5];
  if (/^1/.test(n)) return [4, 6];
  if (/^7[1-57-9]|^7624/.test(n)) return [4, 6];
  if (/^800\d{6}$/.test(n)) return [3, 6];
  if (/^800\d{4}$/.test(n)) return [3, 4];
  if (/^(?:5[56]|7[06])/.test(n)) return [2, 4, 4];
  return [3, 3, 4];
}

function deGroups(n: string): number[] {
  if (/^15[0-25-9]/.test(n)) return [4, 9];
  if (/^1[67]/.test(n)) return [3, 9];
  if (/^(?:[79]00|800|180|137|118)/.test(n)) return [3, 9];
  if (/^(?:30|32|40|69|89)/.test(n)) return [2, 9];
  if (/^[2-9]\d1/.test(n)) return [3, 9];
  return [4, 9];
}

const PLANS: Partial<Record<string, Plan>> = {
  // Czechia — ČTÚ plan: 9 digits, no trunk prefix.
  CZ: {
    lengths: [9],
    rules: [
      rule("60[1-8]|7[2-9]", "mobile"),
      rule("70[01]", "personal"),
      rule("800", "tollfree"),
      rule("84", "shared"),
      rule("90", "premium"),
      rule("910", "voip"),
      rule("[2-5]", "landline"),
    ],
    groups: () => [3, 3, 3],
  },
  SK: {
    lengths: [9],
    rules: [
      rule("9(?:0[1-8]|09|1[0-24-9]|4[03-57-9]|5)", "mobile"),
      rule("900|9[78]", "premium"),
      rule("800", "tollfree"),
      rule("8[5-9]", "shared"),
      rule("[2-5]", "landline"),
    ],
    groups: (n) => (n.startsWith("2") ? [1, 4, 4] : /^[89]/.test(n) ? [3, 3, 3] : [2, 3, 4]),
  },
  DE: {
    lengths: range(5, 13),
    rules: [
      rule("15[0-25-9]", "mobile", [11]),
      rule("1(?:6[023]|7)", "mobile", [10, 11]),
      rule("16[4689]", "pager"),
      rule("800", "tollfree", [10]),
      rule("900", "premium", [10]),
      rule("180", "shared", [10, 11]),
      rule("700", "personal", [11]),
      rule("32", "voip", [11, 12, 13]),
      rule("[2-9]", "landline", range(5, 11)),
    ],
    groups: deGroups,
  },
  AT: {
    lengths: range(4, 13),
    rules: [
      rule("6(?:5[0-3579]|6[013-9]|[7-9])", "mobile", range(7, 13)),
      rule("800", "tollfree"),
      rule("9(?:0[01]|3[019])", "premium"),
      rule("8(?:10|2[018])", "shared"),
      rule("720|780", "voip"),
      rule("5[09]", "unknown"),
      rule("[1-7]", "landline"),
    ],
    groups: (n) =>
      n.startsWith("1") ? [1, 12]
        : /^(?:6(?:5[0-3579]|6[013-9]|[7-9])|316|463|512|662|732|720|780|800|8[12]\d|9[03]\d)/.test(n) ? [3, 10]
          : [4, 9],
  },
  PL: {
    lengths: [9],
    rules: [
      rule("45|5[0137]|6[069]|7[2389]|88", "mobile"),
      rule("800", "tollfree"),
      rule("801", "shared"),
      rule("70", "premium"),
      rule("39", "voip"),
      rule("1[2-8]|2[2-69]|3[2-4]|4[1-468]|5[24-689]|6[1-3578]|7[14-7]|8[1-79]|9[145]", "landline"),
    ],
    groups: (n) => (/^(?:45|5[0137]|6[069]|7[02389]|8[08]|39)/.test(n) ? [3, 3, 3] : [2, 3, 2, 2]),
  },
  HU: {
    lengths: [8, 9],
    rules: [
      rule("20|30|31|50|70", "mobile", [9]),
      rule("80", "tollfree", [8]),
      rule("90", "premium", [8]),
      rule("40", "shared", [8]),
      rule("21", "voip", [9]),
      rule("1|2[2-9]|3[2-7]|4[24-9]|5[2-79]|6[23689]|7[2-9]|8[2-57-9]|9[2-69]", "landline", [8]),
    ],
    render: (n) => {
      const g = split(n, n.startsWith("1") ? [1, 3, 4] : n.length === 9 ? [2, 3, 4] : [2, 3, 3]).join(" ");
      return { intl: g, national: `06 ${g}` };
    },
  },
  // United Kingdom — Ofcom National Telephone Numbering Plan.
  GB: {
    lengths: [7, 9, 10],
    rules: [
      rule("7624", "mobile", [10]),
      rule("7[1-57-9]", "mobile", [10]),
      rule("76", "pager", [10]),
      rule("70", "personal", [10]),
      rule("80[08]", "tollfree", [7, 9, 10]),
      rule("9", "premium", [10]),
      rule("8(?:4[2-5]|7[0-3])", "shared", [10]),
      rule("3[0347]|55", "uan", [10]),
      rule("56", "voip", [10]),
      rule("[12]", "landline", [9, 10]),
    ],
    groups: gbGroups,
  },
  FR: {
    lengths: [9],
    rules: [
      rule("[1-5]", "landline"),
      rule("6|7[3-9]", "mobile"),
      rule("80[0-5]", "tollfree"),
      rule("89", "premium"),
      rule("9", "voip"),
    ],
    groups: (n) => (n.length === 9 ? [1, 2, 2, 2, 2] : undefined),
  },
  IT: {
    lengths: range(6, 11),
    rules: [
      rule("0", "landline", range(6, 11)),
      rule("3", "mobile", [9, 10]),
      rule("80[03]", "tollfree", [6, 9]),
      rule("89", "premium"),
      rule("84", "shared"),
      rule("55", "voip", [10]),
    ],
    groups: (n) => (/^0[26]/.test(n) ? [2, 4, 4] : n.startsWith("0") ? [3, 8] : /^55/.test(n) ? [2, 4, 4] : [3, 3, 4]),
  },
  ES: {
    lengths: [9],
    rules: [
      rule("70", "personal"),
      rule("6|7[1-9]", "mobile"),
      rule("[89]00", "tollfree"),
      rule("[89]0[367]", "premium"),
      rule("90[12]", "shared"),
      rule("[89][1-8]", "landline"),
    ],
    groups: (n) => (/^[89]00/.test(n) ? [3, 3, 3] : [3, 2, 2, 2]),
  },
  NL: {
    lengths: [7, 8, 9, 10],
    rules: [
      rule("6[1-58]", "mobile", [9]),
      rule("66", "pager", [9]),
      rule("800", "tollfree", [7, 8, 9, 10]),
      rule("90[069]", "premium", [7, 8, 9, 10]),
      rule("85|91", "voip", [9]),
      rule("88", "uan", [9]),
      rule("[1-57]", "landline", [9]),
    ],
    groups: (n) =>
      n.startsWith("6") ? [1, 8]
        : /^[89]0/.test(n) ? [3, 7]
          : /^(?:1[035]|2[0346]|3[03568]|4[0356]|5[0358]|7\d|8[58]|91)/.test(n) ? [2, 3, 4]
            : [3, 6],
  },
  BE: {
    lengths: [8, 9],
    rules: [
      rule("4[5-9]", "mobile", [9], true),
      rule("800", "tollfree", [8]),
      rule("90", "premium", [8]),
      rule("70", "premium", [8]),
      rule("78", "uan", [8]),
      rule("[1-9]", "landline", [8]),
    ],
    groups: (n) =>
      /^4[5-9]\d{7}$/.test(n) ? [3, 2, 2, 2]
        : /^(?:800|90|70|78)/.test(n) ? [3, 2, 3]
          : /^[2349]/.test(n) ? [1, 3, 2, 2]
            : [2, 2, 2, 2],
  },
  CH: {
    lengths: [9],
    rules: [
      rule("7[5-9]", "mobile"),
      rule("74", "pager"),
      rule("800", "tollfree"),
      rule("90[016]", "premium"),
      rule("84[0248]", "shared"),
      rule("878", "personal"),
      rule("58", "uan"),
      rule("2[12467]|3[1-4]|4[134]|5[256]|6[12]|[7-9]1", "landline"),
    ],
    groups: (n) => (/^[89]/.test(n) ? [3, 3, 3] : [2, 3, 2, 2]),
  },
  SE: {
    lengths: range(7, 9),
    rules: [
      rule("7[02369]", "mobile", [9]),
      rule("74", "pager"),
      rule("20", "tollfree"),
      rule("9(?:00|39|44)", "premium"),
      rule("77", "shared"),
      rule("75", "personal"),
      rule("10", "voip"),
      rule("[1-689]", "landline"),
    ],
    groups: (n) =>
      n.startsWith("8") ? (n.length === 9 ? [1, 3, 3, 2] : [1, 3, 2, 2])
        : /^(?:7|1[013689]|2[0136]|3[1356]|4[0246]|54|6[03]|90)/.test(n) ? [2, 3, 2, 2]
          : [3, 3, 3],
  },
  NO: {
    lengths: [8],
    rules: [
      rule("4[015-8]|9", "mobile"),
      rule("80[01]", "tollfree"),
      rule("82[09]", "premium"),
      rule("810", "shared"),
      rule("880", "personal"),
      rule("85[0-5]", "voip"),
      rule("2[1-4]|3[1-3578]|5[1-35-7]|6[1-4679]|7[0-9]", "landline"),
    ],
    groups: (n) => (/^[489]/.test(n) ? [3, 2, 3] : [2, 2, 2, 2]),
  },
  // Denmark: fixed and mobile share the same ranges; only the service ranges are told apart.
  DK: {
    lengths: [8],
    rules: [rule("80", "tollfree"), rule("90", "premium")],
    groups: () => [2, 2, 2, 2],
  },
  FI: {
    lengths: range(5, 12),
    rules: [
      rule("4[0-8]|50", "mobile"),
      rule("800", "tollfree"),
      rule("[67]00", "premium"),
      rule("10|[23][09]", "uan"),
      rule("1[3-9]|[235689]", "landline"),
    ],
    groups: (n) =>
      /^(?:4|50)/.test(n) ? [2, 3, 7]
        : /^(?:[1-3]0|[67]00|800)/.test(n) ? [3, 3, 6]
          : n.startsWith("1") ? [2, 3, 7]
            : [1, 3, 8],
  },
  IE: {
    lengths: range(7, 10),
    rules: [
      rule("8[3-9]", "mobile", [9]),
      rule("1800", "tollfree", [10], true),
      rule("15", "premium", [10], true),
      rule("818", "uan", [9]),
      rule("76", "voip", [9]),
      rule("[124-79]", "landline", [7, 8, 9]),
    ],
    groups: (n) =>
      /^1(?:800|5)\d{6}$/.test(n) ? [4, 3, 3]
        : n.startsWith("1") ? [1, 3, 4]
          : n.startsWith("818") ? [3, 3, 3]
            : [2, 3, 4],
  },
  PT: {
    lengths: [9],
    rules: [
      rule("9[1236]", "mobile"),
      rule("2", "landline"),
      rule("80[02]", "tollfree"),
      rule("808", "shared"),
      rule("6(?:0[178]|4[68])|76", "premium"),
      rule("30", "voip"),
      rule("70[78]", "uan"),
    ],
    groups: (n) => (/^2[12]/.test(n) ? [2, 3, 4] : [3, 3, 3]),
  },
  // NANP: fixed and mobile numbers share area codes, so only the service codes are typed.
  US: {
    lengths: [10],
    rules: [
      rule("8(?:00|33|44|55|66|77|88)", "tollfree"),
      rule("900", "premium"),
      rule("5(?:00|2[125-9]|33|44|66|77|88)", "personal"),
    ],
    render: nanpRender,
  },
  RU: {
    lengths: [10],
    rules: [
      rule("9", "mobile"),
      rule("80[04]", "tollfree"),
      rule("80[39]", "premium"),
      rule("3|4|8[1-9]", "landline"),
    ],
    render: ruRender,
  },
  KZ: {
    lengths: [10],
    rules: [
      rule("7(?:0[0-8]|47|6[0-4]|7[015-8]|85)", "mobile"),
      rule("7[12]", "landline"),
    ],
    render: ruRender,
  },
  BY: {
    lengths: [9],
    rules: [rule("25|29|33|44", "mobile"), rule("1[5-7]|2[1-3]", "landline")],
    groups: () => [2, 3, 2, 2],
  },
  UA: {
    lengths: [9],
    rules: [
      rule("39|50|6[36-8]|7[1-3]|9[1-9]", "mobile"),
      rule("800", "tollfree"),
      rule("900", "premium"),
      rule("89", "voip"),
      rule("3[1-8]|4[13-8]|5[1-7]|6[12459]", "landline"),
    ],
    groups: (n) => (/^[89]00/.test(n) ? [3, 3, 3] : [2, 3, 2, 2]),
  },
  TR: {
    lengths: [7, 10],
    rules: [
      rule("444", "uan", [7], true),
      rule("512", "pager"),
      rule("5(?:0[15-7]|1[06]|24|[34]|5[1-59]|9[46])", "mobile", [10]),
      rule("800", "tollfree"),
      rule("900|8[89]8", "premium"),
      rule("850", "voip"),
      rule("[234]", "landline", [10]),
    ],
    groups: (n) => (/^444/.test(n) ? [3, 4] : [3, 3, 2, 2]),
  },
  IL: {
    lengths: [8, 9, 10],
    rules: [
      rule("180[019]", "tollfree"),
      rule("19(?:0|19)", "premium"),
      rule("1700", "shared"),
      rule("5", "mobile", [9]),
      rule("7", "voip", [9]),
      rule("[2-489]", "landline", [8]),
    ],
    groups: (n) => (n.startsWith("1") ? [4, 3, 3] : /^[57]/.test(n) ? [2, 3, 4] : [1, 3, 4]),
  },
  // India: 9 is only mobile, 1–5 only fixed; 6–8 hold both mobile series and fixed trunk
  // codes (e.g. 80 Bengaluru, 79 Ahmedabad), so they stay "unknown".
  IN: {
    lengths: range(10, 13),
    rules: [
      rule("1800", "tollfree"),
      rule("1860|1900|140", "unknown"),
      rule("9", "mobile", [10]),
      rule("[1-5]", "landline", [10]),
    ],
    groups: (n) =>
      n.startsWith("1800") ? [4, 3, 4]
        : /^[6-9]/.test(n) ? [5, 5]
          : /^(?:11|2[02]|33|4[04])/.test(n) ? [2, 4, 4]
            : [3, 3, 4],
  },
  CN: {
    lengths: [9, 10, 11],
    rules: [
      rule("1[3-9]", "mobile", [11]),
      rule("800", "tollfree", [10]),
      rule("400", "shared", [10]),
      rule("10|2|[3-9]", "landline", [9, 10, 11]),
    ],
    groups: (n) =>
      /^1[3-9]/.test(n) ? [3, 4, 4]
        : /^(?:10|2)/.test(n) ? [2, 4, 4]
          : /^[48]00/.test(n) ? [3, 3, 4]
            : [3, Math.max(1, n.length - 7), 4],
  },
  JP: {
    lengths: [9, 10],
    rules: [
      rule("[789]0", "mobile", [10]),
      rule("20", "unknown"),
      rule("50", "voip", [10]),
      rule("60", "personal", [10]),
      rule("120", "tollfree", [9]),
      rule("800", "tollfree", [10]),
      rule("570", "uan", [9]),
      rule("990", "premium", [9]),
      rule("1[78]0", "unknown"),
      rule("[1-9]", "landline", [9]),
    ],
    groups: (n) =>
      /^[2-9]0\d{8}$/.test(n) && !n.startsWith("800") ? [2, 4, 4]
        : /^(?:120|570|990)/.test(n) ? [3, 3, 3]
          : n.startsWith("800") ? [3, 3, 4]
            : /^[36]/.test(n) ? [1, 4, 4]
              : [2, 3, 4],
  },
  KR: {
    lengths: range(8, 10),
    rules: [
      rule("1[5-9]", "uan", [8], true),
      rule("1[016-9]", "mobile", [9, 10]),
      rule("80", "tollfree"),
      rule("60", "premium"),
      rule("70", "voip"),
      rule("50", "personal"),
      rule("2|3[1-3]|4[1-4]|5[1-5]|6[1-4]", "landline"),
    ],
    groups: (n) => {
      const first = n.startsWith("2") ? 1 : /^1[5-9]\d{6}$/.test(n) ? 4 : 2;
      return [first, n.length - first - 4, 4];
    },
  },
  AU: {
    lengths: [6, 7, 9, 10],
    rules: [
      rule("4", "mobile", [9]),
      rule("180", "tollfree", [7, 10]),
      rule("190", "premium", [10]),
      rule("13", "shared", [6, 10]),
      rule("500", "personal", [9]),
      rule("550", "voip", [9]),
      rule("[2378]", "landline", [9]),
    ],
    groups: (n) =>
      n.startsWith("4") ? [3, 3, 3]
        : /^1[389]00/.test(n) ? [4, 3, 3]
          : /^13\d{4}$/.test(n) ? [2, 2, 2]
            : /^[2378]/.test(n) ? [1, 4, 4]
              : [3, 3, 3],
  },
  NZ: {
    lengths: range(8, 10),
    rules: [
      rule("2[0-27-9]", "mobile", range(8, 10)),
      rule("508|80", "tollfree"),
      rule("90", "premium"),
      rule("[34679]", "landline", [8]),
    ],
    groups: (n) => (n.startsWith("2") ? [2, 3, 5] : /^(?:508|80|90)/.test(n) ? [3, 3, 4] : [1, 3, 4]),
  },
  BR: {
    lengths: [8, 10, 11],
    rules: [
      rule("800", "tollfree", [10, 11]),
      rule("900", "premium"),
      rule("30[03]", "shared"),
      rule("40(?:0[0-9]|20)", "shared", [8], true),
      rule("[1-9][1-9]9", "mobile", [11], true),
      rule("[1-9][1-9][2-5]", "landline", [10], true),
    ],
    render: brRender,
  },
  // Mexico: since the 2019 plan mobile and fixed numbers share the 10-digit ranges.
  MX: {
    lengths: [10],
    rules: [rule("800", "tollfree"), rule("900", "premium")],
    groups: (n) => (/^(?:33|55|81)/.test(n) ? [2, 4, 4] : [3, 3, 4]),
  },
  ZA: {
    lengths: [9],
    rules: [
      rule("6|7[0-46-9]|8[1-4]", "mobile"),
      rule("80", "tollfree"),
      rule("860", "shared"),
      rule("861", "uan"),
      rule("86[2-9]|9[0-2]", "premium"),
      rule("87", "voip"),
      rule("[1-5]", "landline"),
    ],
    groups: () => [2, 3, 4],
  },
};

/** Territories that dial under another country's plan. */
const PLAN_ALIAS: Readonly<Record<string, string>> = {
  GG: "GB", JE: "GB", IM: "GB", AX: "FI", SJ: "NO", VA: "IT", CX: "AU", CC: "AU",
};

/** Non-geographic codes, by code. */
const NONGEO_PLANS: Partial<Record<string, Plan>> = {
  "800": { lengths: [8], rules: [rule("", "tollfree")], groups: () => [4, 4] },
  "808": { lengths: [8], rules: [rule("", "shared")], groups: () => [4, 4] },
  "870": { lengths: [9], rules: [rule("", "mobile")] },
  "878": { rules: [rule("", "personal")] },
  "881": { rules: [rule("", "mobile")] },
  "979": { lengths: [9], rules: [rule("", "premium")] },
};

function planFor(iso2: string, code: string): Plan | undefined {
  if (iso2 === "001") return NONGEO_PLANS[code];
  if (code === "1") return PLANS.US;
  return PLANS[iso2] ?? PLANS[PLAN_ALIAS[iso2] ?? ""];
}

function matchRule(plan: Plan | undefined, nsn: string): Rule | undefined {
  return plan?.rules?.find((r) => r.re.test(nsn) && (!r.strict || !r.len || r.len.includes(nsn.length)));
}

/* --------------------------------------------------------- normalization */

const SEPARATORS = /[\s.\-\u2010-\u2015\u2212()[\]/]/g; // incl. Unicode hyphens, dashes, minus
const EXTENSION = /\s*(?:extension|extn?\.?|x|#|,)\s*[:=]?\s*\d{1,8}\s*$/i;
const E164 = /^\+[1-9]\d{2,14}$/;

/** Strip a national (trunk) prefix, or a country code typed without "+", from national digits. */
function nationalDigits(digits: string, iso2: string, code: string): string {
  const lens = planFor(iso2, code)?.lengths;
  const fits = (n: number) => !lens || lens.includes(n);
  const trunks = [trunkOf(iso2).replace(/\D/g, ""), ...(TRUNK_PARSE_EXTRA[iso2] ?? [])].filter(Boolean);
  for (const t of trunks) {
    if (digits.length > t.length && digits.startsWith(t) && (fits(digits.length - t.length) || !fits(digits.length))) {
      return digits.slice(t.length);
    }
  }
  if (lens && !lens.includes(digits.length) && digits.startsWith(code) && lens.includes(digits.length - code.length)) {
    return digits.slice(code.length);
  }
  return digits;
}

/** International digits (country code + national number) → E.164, or null. */
function fromInternational(digits: string): string | null {
  const code = codeOf(digits);
  if (!code) return null;
  let nsn = digits.slice(code.length);
  // A trunk 0 typed after the country code ("+44 020 …", "+49 030 …"): never part of the number there.
  const main = territory(code, nsn);
  if (trunkOf(main.iso2) === "0" && nsn.startsWith("0")) nsn = nsn.slice(1);
  // Mexico's retired mobile marker: +52 1 + 10 digits.
  if (code === "52" && nsn.length === 11 && nsn.startsWith("1")) nsn = nsn.slice(1);
  // 2–15 digits after the code, and E.164's 15-digit ceiling overall.
  if (nsn.length < 2 || nsn.length > 15 || code.length + nsn.length > 15) return null;
  if (/^0+$/.test(nsn)) return null;
  return `+${code}${nsn}`;
}

/**
 * A human-typed phone number → E.164 ("+420603123456"), or null.
 *
 * Accepts spaces, dashes, dots, brackets and slashes; "+" or "00" (and "011" with a NANP
 * default) before the country code; "tel:" URIs; a "(0)" after the country code; and a
 * trailing extension (";ext=12", " ext 12", " ext. 12", "x12", "#12"), which is dropped.
 * Without an international prefix the number is read as national in `defaultCountry`
 * (ISO2), dropping that country's trunk prefix ("0", "8" in Russia, "06" in Hungary, "1" in
 * NANP). Returns null for letters, for fewer than 2 or more than 15 digits after the
 * country code (or more than 15 in all), and for unassigned country codes.
 */
export function normalizeNumber(input: string, defaultCountry?: string): string | null {
  if (typeof input !== "string") return null;
  let s = input.normalize("NFKC").trim();
  if (!s || s.length > 80) return null;
  s = s.replace(/^tel:/i, "");
  const semi = s.indexOf(";");
  if (semi >= 0) s = s.slice(0, semi); // RFC 3966 parameters (;ext=, ;phone-context=)
  s = s.replace(EXTENSION, "");
  const international = /^[\s(]*(?:\+|00)/.test(s);
  if (international) s = s.replace(/\(\s*0\s*\)/, "");
  const compact = s.replace(SEPARATORS, "");
  if (!/^\+?\d+$/.test(compact)) return null;

  if (compact.startsWith("+")) return fromInternational(compact.slice(1));
  if (compact.startsWith("00")) return fromInternational(compact.slice(2));

  const iso = typeof defaultCountry === "string" ? defaultCountry.trim().toUpperCase() : "";
  const home = BY_ISO.get(iso);
  if (!home) return null;
  if (home.code === "1" && compact.startsWith("011")) return fromInternational(compact.slice(3));
  const nsn = nationalDigits(compact, home.iso2, home.code);
  return fromInternational(home.code + nsn);
}

/* ------------------------------------------------------------ numberInfo */

/**
 * Everything knowable offline about a number: country (by shared-code rules where the
 * code is shared), line type by prefix, national and international formats, the
 * country's time zones, currency and languages, and whether the length fits the plan.
 * Takes E.164, or anything normalizeNumber accepts with an international prefix.
 */
export function numberInfo(e164: string): NumberInfo | null {
  if (typeof e164 !== "string") return null;
  const e = E164.test(e164) ? e164 : normalizeNumber(e164);
  if (!e) return null;
  const digits = e.slice(1);
  const code = codeOf(digits);
  if (!code) return null;
  const nsn = digits.slice(code.length);
  if (!nsn) return null;
  const entry = territory(code, nsn);
  const plan = planFor(entry.iso2, code);
  const matched = matchRule(plan, nsn);
  const lens = matched?.len ?? plan?.lengths;
  const trunk = trunkOf(entry.iso2);

  const rendered = plan?.render?.(nsn);
  let intl: string;
  let national: string;
  if (rendered) {
    intl = rendered.intl;
    national = rendered.national;
  } else {
    const sizes = plan?.groups?.(nsn);
    const groups = sizes ? split(nsn, sizes) : threes(nsn);
    intl = groups.join(" ");
    national = `${trunk}${intl}`;
  }

  const meta = META.get(entry.iso2);
  const info: NumberInfo = {
    e164: e,
    countryCode: code,
    national: nsn,
    iso2: entry.iso2,
    country: entry.country,
    region: entry.region,
    type: matched?.type ?? "unknown",
    formatted: { international: `+${code} ${intl}`, national },
    timeZones: [...(meta?.timeZones ?? [])],
    validLength: lens ? lens.includes(nsn.length) : true,
  };
  if (meta?.currency) info.currency = meta.currency;
  if (meta?.languages?.length) info.languages = [...meta.languages];
  return info;
}

/* ------------------------------------------------------------ MCC → ISO2 */

// ITU-T E.212 mobile country codes. Where one MCC serves several territories the main one
// is given (340 French Antilles → GP, 362 former Netherlands Antilles → CW, 425 → IL,
// 647 → RE, 310–316 → US); 901 is the shared international code ("001").
const MCC_DATA = `
202 GR 204 NL 206 BE 208 FR 212 MC 213 AD 214 ES 216 HU 218 BA 219 HR 220 RS 221 XK 222 IT 225 VA
226 RO 228 CH 230 CZ 231 SK 232 AT 234 GB 235 GB 238 DK 240 SE 242 NO 244 FI 246 LT 247 LV 248 EE
250 RU 255 UA 257 BY 259 MD 260 PL 262 DE 266 GI 268 PT 270 LU 272 IE 274 IS 276 AL 278 MT 280 CY
282 GE 283 AM 284 BG 286 TR 288 FO 290 GL 292 SM 293 SI 294 MK 295 LI 297 ME
302 CA 308 PM 310 US 311 US 312 US 313 US 314 US 315 US 316 US 330 PR 332 VI 334 MX 338 JM 340 GP
342 BB 344 AG 346 KY 348 VG 350 BM 352 GD 354 MS 356 KN 358 LC 360 VC 362 CW 363 AW 364 BS 365 AI
366 DM 368 CU 370 DO 372 HT 374 TT 376 TC
400 AZ 401 KZ 402 BT 404 IN 405 IN 406 IN 410 PK 412 AF 413 LK 414 MM 415 LB 416 JO 417 SY 418 IQ
419 KW 420 SA 421 YE 422 OM 424 AE 425 IL 426 BH 427 QA 428 MN 429 NP 430 AE 431 AE 432 IR 434 UZ
436 TJ 437 KG 438 TM 440 JP 441 JP 450 KR 452 VN 454 HK 455 MO 456 KH 457 LA 460 CN 461 CN 466 TW
467 KP 470 BD 472 MV
502 MY 505 AU 510 ID 514 TL 515 PH 520 TH 525 SG 528 BN 530 NZ 536 NR 537 PG 539 TO 540 SB 541 VU
542 FJ 543 WF 544 AS 545 KI 546 NC 547 PF 548 CK 549 WS 550 FM 551 MH 552 PW 553 TV 554 TK 555 NU
602 EG 603 DZ 604 MA 605 TN 606 LY 607 GM 608 SN 609 MR 610 ML 611 GN 612 CI 613 BF 614 NE 615 TG
616 BJ 617 MU 618 LR 619 SL 620 GH 621 NG 622 TD 623 CF 624 CM 625 CV 626 ST 627 GQ 628 GA 629 CG
630 CD 631 AO 632 GW 633 SC 634 SD 635 RW 636 ET 637 SO 638 DJ 639 KE 640 TZ 641 UG 642 BI 643 MZ
645 ZM 646 MG 647 RE 648 ZW 649 NA 650 MW 651 LS 652 BW 653 SZ 654 KM 655 ZA 657 ER 658 SH 659 SS
702 BZ 704 GT 706 SV 708 HN 710 NI 712 CR 714 PA 716 PE 722 AR 724 BR 730 CL 732 CO 734 VE 736 BO
738 GY 740 EC 742 GF 744 PY 746 SR 748 UY 750 FK
901 001 995 IO
`;

/** E.212 MCC → ISO 3166 alpha-2 ("001" for the international MCC 901). */
export const MCC_COUNTRIES: Readonly<Record<string, string>> = (() => {
  const words = MCC_DATA.trim().split(/\s+/);
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < words.length; i += 2) out[words[i]] = words[i + 1];
  return Object.freeze(out);
})();

/**
 * The country of a mobile network from its MCC (or an MCC+MNC string such as "23001"):
 * ISO 3166 alpha-2, "001" for the international MCC 901, or null when unknown.
 */
export function mccmncCountry(mcc: string | number | null | undefined): string | null {
  if (mcc === null || mcc === undefined) return null;
  const digits = String(mcc).trim().replace(/[\s-]/g, "");
  if (!/^\d{3,6}$/.test(digits)) return null;
  return MCC_COUNTRIES[digits.slice(0, 3)] ?? null;
}

/* ------------------------------------------------------------ mergeLookups */

/** One provider answer, as the adapters return it (lookup or HLR). */
export type ProviderAnswer = Partial<LookupResult> | Partial<HlrResult>;

type Carrier = { name?: string; mcc?: string; mnc?: string };
type Roaming = { status: string; country?: string; network?: string };
type Region = { area?: string; state?: string; city?: string };

/** What one source (offline or a provider answer) says, in neutral words. */
export type SourceFields = {
  kind: "offline" | "lookup" | "hlr";
  valid?: boolean;
  type?: NumberType;
  carrier?: Carrier;
  callerName?: string;
  ported?: boolean;
  roaming?: Roaming;
  reachable?: string;
  region?: Region;
  /** ISO2 of the number's country (a lookup), or of the serving network (an HLR). */
  country?: string;
  /** The national format as the source writes it. */
  national?: string;
};

export type LookupSummary = {
  e164: string | null;
  valid: boolean | null;
  type: NumberType;
  carrier: Carrier | null;
  callerName: string | null;
  ported: boolean | null;
  roaming: Roaming | null;
  reachable: string | null;
  /** area: the continent / area; state and city from a provider. */
  region: Region | null;
  country: { iso2: string; name?: string; callingCode?: string } | null;
  formatted: { international: string; national: string } | null;
  timeZones: string[];
  /** Every source's values: "offline" and one key per provider answer. */
  sources: Record<string, SourceFields>;
  /** Fields on which provider answers disagree (the headline value follows the precedence). */
  conflicts: string[];
};

type Field = Exclude<keyof SourceFields, "kind">;
const FIELDS: readonly Field[] = ["valid", "type", "carrier", "callerName", "ported", "roaming", "reachable", "region", "country", "national"];
/** Live network state: an HLR query is fresher than a database lookup. */
const NETWORK_FIELDS: ReadonlySet<Field> = new Set<Field>(["valid", "carrier", "ported", "roaming", "reachable"]);

const PROVIDER_TYPES: Readonly<Record<string, NumberType>> = {
  mobile: "mobile", wireless: "mobile", cellular: "mobile",
  landline: "landline", fixed: "landline", "fixed-line": "landline", fixedline: "landline",
  voip: "voip", "fixed-voip": "voip", fixedvoip: "voip", "non-fixed-voip": "voip", nonfixedvoip: "voip", virtual: "voip",
  "toll-free": "tollfree", tollfree: "tollfree", "landline-tollfree": "tollfree",
  premium: "premium", "premium-rate": "premium", "landline-premium": "premium",
  "shared-cost": "shared", sharedcost: "shared", shared: "shared",
  personal: "personal", pager: "pager", uan: "uan",
};

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const low = (v: string) => v.trim().toLowerCase();
const isoOf = (v: unknown): string | undefined => {
  const t = text(v)?.toUpperCase();
  return t && /^[A-Z]{2}$/.test(t) ? t : undefined;
};
const NO_INFO = new Set(["unknown", "undetermined", "n/a", "none", ""]);

function providerType(v: unknown): NumberType | undefined {
  const t = text(v);
  if (!t) return undefined;
  return PROVIDER_TYPES[t.toLowerCase().replace(/[\s_]+/g, "-")];
}

function carrierOf(c: { name?: string; mcc?: string; mnc?: string } | null | undefined): Carrier | undefined {
  if (!c) return undefined;
  const out: Carrier = {};
  const name = text(c.name), mcc = text(c.mcc), mnc = text(c.mnc);
  if (name) out.name = name;
  if (mcc) out.mcc = mcc;
  if (mnc) out.mnc = mnc;
  return Object.keys(out).length ? out : undefined;
}

function roamingOf(r: { status?: string; country?: string; network?: string } | null | undefined): Roaming | undefined {
  const status = text(r?.status);
  if (!r || !status || NO_INFO.has(low(status))) return undefined;
  const out: Roaming = { status };
  const country = text(r.country), network = text(r.network);
  if (country) out.country = country;
  if (network) out.network = network;
  return out;
}

const isHlr = (r: ProviderAnswer): r is Partial<HlrResult> =>
  "status" in r || "network" in r || "imsi" in r || "original" in r;

function hlrFields(h: Partial<HlrResult>): SourceFields {
  const s: SourceFields = { kind: "hlr" };
  const status = h.status;
  if (typeof h.valid === "boolean") s.valid = h.valid;
  else if (status === "invalid") s.valid = false;
  else if (status === "connected" || status === "absent") s.valid = true;
  // Only mobile subscribers answer an HLR query.
  if (status === "connected" || status === "absent") s.type = "mobile";
  const carrier = carrierOf(h.network);
  if (carrier) s.carrier = carrier;
  if (typeof h.ported === "boolean") s.ported = h.ported;
  const roaming = roamingOf(h.roaming);
  if (roaming) s.roaming = roaming;
  if (status && status !== "undetermined") s.reachable = status;
  else if (text(h.reachable) && !NO_INFO.has(low(h.reachable as string))) s.reachable = low(h.reachable as string);
  const country = isoOf(h.network?.country) ?? mccmncCountry(h.network?.mcc) ?? undefined;
  if (country && country !== "001") s.country = country;
  return s;
}

function lookupFields(l: Partial<LookupResult>): SourceFields {
  const s: SourceFields = { kind: "lookup" };
  if (typeof l.valid === "boolean") s.valid = l.valid;
  const type = providerType(l.type);
  if (type) s.type = type;
  const carrier = carrierOf(l.carrier);
  if (carrier) s.carrier = carrier;
  const callerName = text(l.callerName);
  if (callerName) s.callerName = callerName;
  if (typeof l.ported === "boolean") s.ported = l.ported;
  const roaming = roamingOf(l.roaming);
  if (roaming) s.roaming = roaming;
  const reachable = text(l.reachable);
  if (reachable && !NO_INFO.has(low(reachable))) s.reachable = reachable;
  const state = text(l.region?.state), city = text(l.region?.city);
  if (state || city) s.region = { ...(state ? { state } : {}), ...(city ? { city } : {}) };
  const country = isoOf(l.country?.code) ?? mccmncCountry(l.carrier?.mcc) ?? undefined;
  if (country && country !== "001") s.country = country;
  const national = text(l.national);
  if (national) s.national = national;
  return s;
}

function offlineFields(o: NumberInfo): SourceFields {
  return {
    kind: "offline",
    valid: o.validLength,
    type: o.type,
    country: o.iso2,
    national: o.formatted.national,
    region: { area: o.region },
  };
}

/** Whether two sources' values for a field say the same thing. */
function agree(field: Field, a: unknown, b: unknown): boolean {
  if (field === "carrier") {
    const x = a as Carrier, y = b as Carrier;
    if (x.mcc && x.mnc && y.mcc && y.mnc) return x.mcc === y.mcc && Number(x.mnc) === Number(y.mnc);
    if (x.name && y.name) {
      const [p, q] = [x.name, y.name].map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, ""));
      return p === q || p.startsWith(q) || q.startsWith(p);
    }
    return true;
  }
  if (field === "roaming") {
    const x = a as Roaming, y = b as Roaming;
    if (low(x.status) !== low(y.status)) return false;
    return !x.country || !y.country || low(x.country) === low(y.country);
  }
  if (field === "region") {
    const x = a as Region, y = b as Region;
    return (!x.state || !y.state || low(x.state) === low(y.state)) && (!x.city || !y.city || low(x.city) === low(y.city));
  }
  if (field === "national") return String(a).replace(/\D/g, "") === String(b).replace(/\D/g, "");
  if (typeof a === "string" && typeof b === "string") return low(a) === low(b);
  return a === b;
}

/**
 * Merges provider answers (LookupResult / HlrResult, in the caller's order of trust)
 * with the offline guess into one summary.
 *
 * Precedence: provider data beats the offline guess. Among providers, for live network
 * state (valid, carrier, ported, roaming, reachable) HLR answers come before lookups; for
 * everything else lookups come first; within a kind the earlier answer wins. A provider's
 * "unknown" is no answer. Every source's values stay under `sources` (provider → fields,
 * plus "offline"), and `conflicts` names the fields on which providers disagree.
 */
export function mergeLookups(
  offline: NumberInfo | null,
  results: ReadonlyArray<ProviderAnswer | null | undefined>,
): LookupSummary {
  const answers = (results ?? []).filter((r): r is ProviderAnswer => !!r && typeof r === "object");

  // Without an offline guess, derive one from the first number a provider returns.
  let base = offline;
  if (!base) {
    for (const r of answers) {
      const n = text(r.number);
      if (n && (base = numberInfo(n))) break;
    }
  }

  const sources: Record<string, SourceFields> = {};
  if (base) sources.offline = offlineFields(base);
  const lookups: SourceFields[] = [];
  const hlrs: SourceFields[] = [];
  for (const r of answers) {
    const hlr = isHlr(r);
    const fields = hlr ? hlrFields(r) : lookupFields(r as Partial<LookupResult>);
    const provider = text(r.provider) ?? "unknown";
    let key = provider;
    if (key in sources) key = `${provider}:${hlr ? "hlr" : "lookup"}`;
    for (let n = 2; key in sources; n++) key = `${provider}:${hlr ? "hlr" : "lookup"}#${n}`;
    sources[key] = fields;
    (hlr ? hlrs : lookups).push(fields);
  }

  const pick = <K extends Field>(field: K): SourceFields[K] | undefined => {
    const order = NETWORK_FIELDS.has(field) ? [...hlrs, ...lookups] : [...lookups, ...hlrs];
    for (const s of order) if (s[field] !== undefined) return s[field];
    return undefined;
  };

  const all = [...lookups, ...hlrs];
  const conflicts = FIELDS.filter((field) => {
    const values = all.map((s) => s[field]).filter((v) => v !== undefined);
    return values.some((v, i) => values.slice(i + 1).some((w) => !agree(field, v, w)));
  });

  const iso = pick("country") ?? base?.iso2;
  const same = !!base && iso === base.iso2;
  const entry = iso ? BY_ISO.get(iso) : undefined;
  const name = same ? base?.country : entry?.country;
  const callingCode = same ? base?.countryCode : entry?.code;
  const country = iso ? { iso2: iso, ...(name ? { name } : {}), ...(callingCode ? { callingCode } : {}) } : null;

  const area = same ? base?.region : entry?.region ?? base?.region;
  const place = pick("region");
  const region = area || place ? { ...(area ? { area } : {}), ...(place ?? {}) } : null;

  const e164 = base?.e164 ?? answers.map((r) => normalizeNumber(text(r.number) ?? "")).find((n): n is string => !!n) ?? null;
  const national = pick("national");
  const formatted = base
    ? { international: base.formatted.international, national: national ?? base.formatted.national }
    : national ? { international: e164 ?? national, national } : null;

  const timeZones = same || !iso ? [...(base?.timeZones ?? [])] : [...(META.get(iso)?.timeZones ?? base?.timeZones ?? [])];

  return {
    e164,
    valid: pick("valid") ?? base?.validLength ?? null,
    type: pick("type") ?? base?.type ?? "unknown",
    carrier: pick("carrier") ?? null,
    callerName: pick("callerName") ?? null,
    ported: pick("ported") ?? null,
    roaming: pick("roaming") ?? null,
    reachable: pick("reachable") ?? null,
    region,
    country,
    formatted,
    timeZones,
    sources,
    conflicts,
  };
}
