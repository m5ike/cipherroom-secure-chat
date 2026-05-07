# NFC / RFID / EMV

## Web NFC (built-in)

Web NFC is currently supported on **Android Chrome** only. Desktop
browsers, Firefox on Android, and iOS Safari do not expose
`NDEFReader`. The panel detects this and shows a clear unsupported
banner.

### What we do

- Read NDEF text records that start with `m5cet:nfc:v1:` and decrypt
  them with the user's PIN (4–16 digits, PBKDF2 200k / SHA-256 →
  AES-GCM 256 with a per-tag random salt + IV).
- Write the same encrypted payload back to a writable tag.
- Surface the tag UID via the plug-in registry (no key needed).

### Why a PIN

NFC tags can be read by anyone with a phone. The PIN guarantees that
only someone who knows it can decrypt the JSON contents. PIN is
**not** stored anywhere on the device — the user types it both when
writing and when reading.

## Hardware reader plug-ins

`registerCardReader(mod)` lets a third party expose a hardware reader
via a small interface:

```ts
type CardReaderModule = {
  id: string;            // unique
  label: string;
  capabilities: string[]; // e.g. ["nfc-uid", "rfid-uid", "atr-only"]
  isAvailable(): boolean | Promise<boolean>;
  read(): Promise<{ ok: boolean; uid?: string; meta?: object; reason?: string }>;
};
```

Built-in module: `web-nfc-uid` (browser-only).

### EMV: not implemented

EMV-card data (PAN, expiry, cardholder name) handling is **not**
implemented because that triggers PCI-DSS scope. If a deployment has
authorised PCI-compliant infrastructure and explicit cardholder
consent, supply a custom plug-in:

1. The plug-in talks to a PC/SC bridge or a vendor SDK on the
   admin/operator machine.
2. It returns only a **redacted, masked, or tokenised** profile —
   never the full PAN.
3. Logs are written to the admin audit trail.

The default behaviour is a hard refusal: the registry only exposes
`atr-only` / `*-uid` capabilities for built-in modules.

## Privacy

Tag reads/writes happen entirely on-device. The encrypted payload
never reaches the server unless the user explicitly forwards it
through the chat. Treat physical NFC tags as exposed media: anyone
with proximity can read them, so the PIN-based encryption is the
real boundary, not the air-gap.
