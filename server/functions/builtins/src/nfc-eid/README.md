# Read an e-ID / e-passport

Your device asks for the CAN printed on your ID card (6 digits) — or the MRZ / document number, date of birth and expiry of a passport — then reads the chip: PACE with the CAN, or BAC with the MRZ (the document's own access control). It shows everything the chip gives a reader: the MRZ data, the photo and signature, more personal and document details, and the security check (every group against EF.SOD); the security objects and JPEG 2000 pictures come as files to download. Your own document, read-only.

Chat: `/eid` — runs on the device that tapped the card.

Built as a flow: open it in Functions › Builder (flow.m5flow.json); index.js is what it compiles to. Built from the Builder's NFC.e-ID tools: “e-ID: read everything” (format html, show in the chat) → Result (the one-line summary); the error function flashes what went wrong. The CAN or MRZ is typed on your device and used there for this read only — it is not sent to the server. What the chip gives (the report, the photo) is the command's result, kept in the run history like any result.

Needs the NFC module (Modules & groups) and a device with a reader — the phone's own NFC (Android Chrome / the Android app) or a USB/BLE reader. The op runs on the caller's device (m5.nfc); the model starts switched off.
