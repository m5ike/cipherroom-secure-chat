# Define — `m5mobile.define` (6.3)

Typed **variables and constants** the operator defines once and the framework
hands to every runtime as real, typed values. Build them in the console
(**Android › Define**) with a GUI builder; they are stored as one JSON set and
delivered to the Android app, the web app and the Functions sandbox, where each
becomes a live value under `m5mobile.define.<name>`. So a Package, a Model, a
Function and both apps all read the same constant — an APDU template list, a
colour set, a config object — without hard-coding it in several places.

One source of truth, validated by the same shared module
([`client/src/lib/define/schema.ts`](../client/src/lib/define/schema.ts))
everywhere, so a value never differs between a Package, a Model and an app. The
Java port ([`core/Define.java`](../android/app/src/main/java/cz/m5cet/app/core/Define.java))
reads the same JSON and materializes the same values.

## The console builder

**Console › Android › Define** (operator right; auditors read-only).

- **Left — navigator.** Each definition by name, with an icon for its type and
  a tag for **variable** or **constant**. Add and remove definitions here.
- **Right — content.** Rename the definition, change its type, set its scope
  (`android` / `web` / `both`) and an optional max size.
  - A **scalar** type shows an input, or a **textarea** when the value is long
    (over 512 characters, or the `text` / `script` types).
  - A **dynamic** type (`object`, `array`, `class`) opens a recursive
    **builder**: add an entry with a **key** (text), pick its **value type**
    from the type list, and give it a **max size** (`0` = unlimited). Entries
    nest to any depth.
- **Controls** to add, remove and **save**. Saving `PUT`s the whole set to
  `/api/admin/define`; the server validates and bounds it and writes
  `define.json`.

## Types

Scalars: `string`, `text` (long / multi-line), `integer`, `float`, `boolean`,
`bytes` (entered as hex), `script` (source code — **data**, never run by the
builder), `enum` (a fixed option list).

Containers: `object` and `class` (keyed entries) and `array` (ordered items).

`materialize()` turns a definition into the plain value a runtime sees:

| Type | Materialized value |
|---|---|
| `string` / `text` | the string |
| `integer` / `float` | the number |
| `boolean` | the boolean |
| `bytes` | a lowercase hex string |
| `enum` | the chosen option (first option if the value isn't in the list) |
| `script` | `{ __m5script: true, code, lang }` — data, not evaluated |
| `object` / `class` | `{ key: value, … }` |
| `array` | `[ value, … ]` |

## Where the values appear

The server materializes the set per scope and every runtime reads the same
values:

- **Web app** — fetched once from `GET /api/define?scope=web`, published as
  `window.m5mobile.define` and via the `useDefine()` hook
  ([`client/src/lib/define/client.ts`](../client/src/lib/define/client.ts)).
- **Android app** — carried in the app scope and cached in the vault's system
  tier; read through `app().define` (`get` / `str` / `num` / `bool` / `obj` /
  `arr`) and referenced from screens as `define.<name>`. Refreshed at check-in
  (`GET /api/define?scope=android`).
- **Functions** (Models, Packages, Tools) — injected into the sandbox as
  `m5mobile.define.<name>`, JS and Python alike.

Absence (offline, no definitions, an error) is always handled as an empty
object, so a reader never crashes on a missing define.

## Limits

Bounded as small config, not storage
([`DEFINE_LIMITS`](../client/src/lib/define/schema.ts)): 200 definitions,
depth 12, 500 entries per container, 65 536 characters per scalar (hard cap
262 144), names `^[A-Za-z_][A-Za-z0-9_]{0,63}$`. A definition (or the whole
set) over its max size is refused at save with the offending names.

## Example: NFC application templates

The NFC tool's **Application template** menu (next to *Select application*, and
**Templates** on *Card data*) reads one array define, `apduTemplates`. Since
6.10 each entry is the **complete read of one card type**: a list of `steps` the
tool runs one after another, recording every command and response. A step is a
fixed command (`{ apdu }`) or a reader operation (`{ op }`) whose command depends
on what the card answered before:

```jsonc
// a "constant" array of objects
[
  { "label": "Mastercard (credit / debit)", "card": "emv", "aid": "A0000000041010",
    "note": "Mastercard: SELECT, counters, history, GPO, records.",
    "steps": [
      { "op": "select-ppse", "optional": true },          // the directory, if the card has one
      { "op": "select-aid", "aid": "A0000000041010" },     // the application (its PDOL, its log entry)
      { "op": "get-data", "tags": ["9F36", "9F13", "9F17", "9F4D", "9F4F", "9F6E"] },
      { "op": "read-log" },                                // the transaction history
      { "op": "gpo" },                                     // GET PROCESSING OPTIONS, PDOL filled, no transaction
      { "op": "read-afl" },                                // the records the AFL lists
      { "op": "read-files", "sfi": [1, 10], "records": [1, 16] }
    ] },
  { "label": "MIFARE DESFire — version", "card": "desfire",
    "steps": [
      { "apdu": "9060000000", "label": "GetVersion — hardware", "expect": ["91AF"] },
      { "apdu": "90AF000000", "label": "GetVersion — software", "expect": ["91AF"] },
      { "apdu": "90AF000000", "label": "GetVersion — UID, batch, date", "expect": ["9100"] }
    ] },
  { "label": "e-ID — MRZ data only", "card": "emrtd",
    "steps": [{ "op": "eid-read", "args": { "readPhoto": false, "all": false } }] }
]
```

A template has a `label`, `steps`, and optionally `card` (`emv`, `emrtd`,
`desfire`, `iso7816` — it groups the menu and picks the readable report),
`note` and `aid`. A fixed command may say `expect` (the status words that count
as success, `xx` a wildcard byte; `9000` by default — 61xx / 6Cxx are followed
up automatically) and `optional` (a failure is a warning, the run goes on). The
reader operations (`select-ppse`, `select-pse`, `select-aid`, `get-data`,
`read-log`, `gpo`, `read-afl`, `read-files`, `for-each-aid`, `eid-read`) are
described in [`nfc.md`](nfc.md#apdu-templates). Templates are **read-only**: a
command that is not a read (VERIFY, GENERATE AC, UPDATE / WRITE, PUT DATA …) is
refused, and the builder says so under the value.

Older entries (≤ 6.9) still run, as a one-step template: `{ label, op:
"emv-read" | "eid-read", args?, aid? }` (the `aid` is now read first) or `{
label, apdu }` (one command per line).

You do not have to type the set in by hand: the Define builder has a **Load
standard APDU templates** button (operator right) that builds this
`apduTemplates` constant from the standard set
(`client/src/lib/nfc/apdu-templates.ts`, `STANDARD_APDU_TEMPLATES` — every
payment scheme, every application of a payment card over PPSE or PSE, e-ID /
e-passport, DESFire, ISO 7816) and saves it — replacing an existing
`apduTemplates` after a confirm, keeping every other definition. Under an
`apduTemplates` value the builder lists each template's problems (or says each
can run). See [`nfc.md`](nfc.md#apdu-templates).
