# HLR

An HLR query: whether the phone is connected, roaming (where), ported, and its network.

Chat: `/hlr +420603123456` — the HLR of that number at once (spaces, dashes and a leading 00 are fine); `/hlr` alone — a form, sending it runs the `form` function; a number that is not in the international form — an error and the form, prefilled with what was typed.

Built as a flow: open it in Functions › Builder (flow.m5flow.json); index.js is what it compiles to.

Needs the Telephony & SIP module (a provider configured, and your rights: Modules & groups). Its model starts switched off: it costs money.
