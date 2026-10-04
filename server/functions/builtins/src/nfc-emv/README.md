# Read a payment card (EMV)

Waits for a payment card (Visa, Mastercard, Maestro, Amex…) at your device and reads everything a terminal may read: every application, every record (every file on the card), the counters and the transaction history. It shows it formatted in the chat — the card number masked — with the history as CSV and the raw records to download. Read-only: no PIN, no payment, no write.

Chat: `/emv` — runs on the device that tapped the card.

Built as a flow: open it in Functions › Builder (flow.m5flow.json); index.js is what it compiles to. Built from the Builder's NFC.EMV tools: “EMV: read everything” (format html, show in the chat) → Result (the one-line summary). Change the format (object, array, json, text, csv) or wire “EMV → format” / “EMV: transaction history” for other views.

Needs the NFC module (Modules & groups) and a device with a reader — the phone's own NFC (Android Chrome / the Android app) or a USB/BLE reader. The op runs on the caller's device (m5.nfc); the model starts switched off.
