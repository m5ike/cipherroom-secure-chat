# Open an M5Cet card

Opens an M5Cet card and lists its records (type and a summary). Each record is opened on the device with its PIN or your account; a secret never reaches the model.

Chat: `/nfc-open` — runs on the device that tapped the card.

Built as a flow: open it in Functions › Builder (flow.m5flow.json); index.js is what it compiles to.

Needs the NFC module (Modules & groups) and a device with a reader — the phone's own NFC (Android Chrome / the Android app) or a USB/BLE reader. The op runs on the caller's device (m5.nfc); the model starts switched off.
