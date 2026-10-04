// 6.8 design area: a passkey sign-in the server refused for its request limit
// (429) says so — not a passkey problem, try again in a few minutes — instead
// of the server's English "Too many requests" (account/AccountDialogs).
// One area of the 6.8 design (design-68.ts gathers them): what it adds and
// what it changes in the trees and menus that already exist.

import type { DesignArea } from "./design-67";

export const AREA: DesignArea = {
  strings: {
    cs: {
      "passkey.rateLimitedTitle": "Server teď nepřijímá další požadavky",
      "passkey.rateLimitedText": "Z vaší adresy přišlo na server {server} příliš mnoho požadavků (ochrana proti přetížení). Nejde o chybu passkey — zkuste to znovu za pár minut. Správce serveru může limit zvýšit (API_RATE_LIMIT).",
    },
    en: {
      "passkey.rateLimitedTitle": "The server is not accepting more requests right now",
      "passkey.rateLimitedText": "The server {server} got too many requests from your address (overload protection). This is not a passkey problem — try again in a few minutes. The server's operator can raise the limit (API_RATE_LIMIT).",
    },
    de: {
      "passkey.rateLimitedTitle": "Der Server nimmt gerade keine weiteren Anfragen an",
      "passkey.rateLimitedText": "Der Server {server} hat zu viele Anfragen von Ihrer Adresse erhalten (Überlastschutz). Das ist kein Passkey-Fehler — versuchen Sie es in ein paar Minuten erneut. Der Betreiber kann das Limit erhöhen (API_RATE_LIMIT).",
    },
  },
};
