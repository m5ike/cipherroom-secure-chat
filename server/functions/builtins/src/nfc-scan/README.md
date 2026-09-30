# Scan a card

Waits for a card at your device and reads its public identity (UID, technology, ATQA/SAK/ATR) and any NDEF records — nothing that needs a key.

Chat: `/nfc-scan` — runs on the device that tapped the card.

Built as a flow: open it in Functions › Builder (flow.m5flow.json); index.js is what it compiles to.

Needs the NFC module (Modules & groups) and a device with a reader — the phone's own NFC (Android Chrome / the Android app) or a USB/BLE reader. The op runs on the caller's device (m5.nfc); the model starts switched off.
