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

The NFC tool's **Application template** button (next to *Select application* on
ISO-DEP and EMV cards) reads one array define, `apduTemplates`:

```jsonc
// a "constant" array of objects
[
  { "label": "PPSE",     "apdu": "00A404000E325041592E5359532E444446303100" },
  { "label": "Visa AID", "apdu": "00A4040007A000000003101000" }
]
```

Each item is `{ label, apdu }` — `apdu` a hex string (a `bytes` entry
materializes to lowercase hex). Picking one from the dropdown sends that APDU
over ISO-DEP and shows the response, on the phone and on the web. See
[`nfc.md`](nfc.md).
