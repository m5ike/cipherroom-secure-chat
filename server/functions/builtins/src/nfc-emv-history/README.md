# Card transaction history

Reads the transaction log of a payment card at your device — the last transactions the card itself remembers: date, time, amount and currency, merchant, type, country — and shows them as a table. Not every card keeps a readable log. Read-only.

Chat: `/emv-history` — runs on the device that tapped the card.

Built as a flow: open it in Functions › Builder (flow.m5flow.json); index.js is what it compiles to. Built from the Builder's NFC.EMV tools: “EMV: read everything” (no deep read, nothing shown) → If (read ok) → “EMV: transaction history” → Send table; otherwise a notice says why.

Needs the NFC module (Modules & groups) and a device with a reader — the phone's own NFC (Android Chrome / the Android app) or a USB/BLE reader. The op runs on the caller's device (m5.nfc); the model starts switched off.
