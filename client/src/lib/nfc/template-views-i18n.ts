// 6.13: the generic NFC report's labels (template-views.ts › gLabels) in the
// languages added in 6.13; English, Czech and German stay in template-views.ts.
// A missing label falls back along the language's chain (sk → cs → en).

type Labels = Partial<Record<string, string>>;

const es: Labels = {
  steps: "Comandos y respuestas", command: "Comando", status: "Estado", data: "Datos", text: "Texto", problems: "Problemas", ok: "Leída por completo",
  vendor: "Fabricante", type: "Tipo", hwVersion: "Versión de hardware", swVersion: "Versión de software", storage: "Almacenamiento", protocol: "Protocolo",
  batch: "Número de lote", produced: "Fabricada", week: "semana", applications: "Aplicaciones", noApplications: "ninguna (solo el nivel de la tarjeta)",
  freeMemory: "Memoria libre", keySettings: "Clave maestra de la tarjeta", masterKeyChangeable: "se puede cambiar", freeDirectoryList: "aplicaciones listadas sin la clave",
  freeCreateDelete: "aplicaciones creadas / eliminadas sin la clave", configurationChangeable: "la configuración se puede cambiar", maxKeys: "claves", crypto: "cifrado",
  yes: "sí", no: "no", cancelled: "Cancelado", step: "Paso", template: "Plantilla", masked: "Los números de tarjeta y los datos de pista están enmascarados.",
};

const it: Labels = {
  steps: "Comandi e risposte", command: "Comando", status: "Stato", data: "Dati", text: "Testo", problems: "Problemi", ok: "Letta completamente",
  vendor: "Produttore", type: "Tipo", hwVersion: "Versione hardware", swVersion: "Versione software", storage: "Memoria", protocol: "Protocollo",
  batch: "Numero di lotto", produced: "Prodotta", week: "settimana", applications: "Applicazioni", noApplications: "nessuna (solo il livello della carta)",
  freeMemory: "Memoria libera", keySettings: "Chiave master della carta", masterKeyChangeable: "modificabile", freeDirectoryList: "applicazioni elencate senza la chiave",
  freeCreateDelete: "applicazioni create / eliminate senza la chiave", configurationChangeable: "impostazioni modificabili", maxKeys: "chiavi", crypto: "cifratura",
  yes: "sì", no: "no", cancelled: "Annullato", step: "Passo", template: "Modello", masked: "I numeri di carta e i dati delle tracce sono mascherati.",
};

const fr: Labels = {
  steps: "Commandes et réponses", command: "Commande", status: "État", data: "Données", text: "Texte", problems: "Problèmes", ok: "Lecture complète",
  vendor: "Fabricant", type: "Type", hwVersion: "Version matérielle", swVersion: "Version logicielle", storage: "Mémoire", protocol: "Protocole",
  batch: "Numéro de lot", produced: "Fabriquée", week: "semaine", applications: "Applications", noApplications: "aucune (seulement le niveau carte)",
  freeMemory: "Mémoire libre", keySettings: "Clé maître de la carte", masterKeyChangeable: "modifiable", freeDirectoryList: "applications listées sans la clé",
  freeCreateDelete: "applications créées / supprimées sans la clé", configurationChangeable: "paramètres modifiables", maxKeys: "clés", crypto: "chiffrement",
  yes: "oui", no: "non", cancelled: "Annulé", step: "Étape", template: "Modèle", masked: "Les numéros de carte et les données de piste sont masqués.",
};

const sk: Labels = {
  steps: "Príkazy a odpovede", command: "Príkaz", status: "Stav", data: "Dáta", text: "Text", problems: "Problémy", ok: "Prečítané celé",
  vendor: "Výrobca", type: "Typ", hwVersion: "Verzia hardvéru", swVersion: "Verzia softvéru", storage: "Pamäť", protocol: "Protokol",
  batch: "Číslo šarže", produced: "Vyrobené", week: "týždeň", applications: "Aplikácie", noApplications: "žiadne (len úroveň karty)",
  freeMemory: "Voľná pamäť", keySettings: "Hlavný kľúč karty", masterKeyChangeable: "dá sa zmeniť", freeDirectoryList: "aplikácie sa vypíšu bez kľúča",
  freeCreateDelete: "aplikácie sa vytvoria / vymažú bez kľúča", configurationChangeable: "nastavenia sa dajú zmeniť", maxKeys: "kľúčov", crypto: "šifra",
  yes: "áno", no: "nie", cancelled: "Zrušené", step: "Krok", template: "Šablóna", masked: "Čísla kariet a dáta stôp sú zamaskované.",
};

const sl: Labels = {
  steps: "Ukazi in odgovori", command: "Ukaz", status: "Stanje", data: "Podatki", text: "Besedilo", problems: "Težave", ok: "Prebrano v celoti",
  vendor: "Proizvajalec", type: "Vrsta", hwVersion: "Različica strojne opreme", swVersion: "Različica programske opreme", storage: "Pomnilnik", protocol: "Protokol",
  batch: "Številka serije", produced: "Izdelano", week: "teden", applications: "Aplikacije", noApplications: "nobena (samo raven kartice)",
  freeMemory: "Prosti pomnilnik", keySettings: "Glavni ključ kartice", masterKeyChangeable: "ga je mogoče spremeniti", freeDirectoryList: "aplikacije se izpišejo brez ključa",
  freeCreateDelete: "aplikacije se ustvarijo / izbrišejo brez ključa", configurationChangeable: "nastavitve je mogoče spremeniti", maxKeys: "ključev", crypto: "šifra",
  yes: "da", no: "ne", cancelled: "Preklicano", step: "Korak", template: "Predloga", masked: "Številke kartic in podatki stez so zakriti.",
};

const fi: Labels = {
  steps: "Komennot ja vastaukset", command: "Komento", status: "Tila", data: "Data", text: "Teksti", problems: "Ongelmat", ok: "Luettu kokonaan",
  vendor: "Valmistaja", type: "Tyyppi", hwVersion: "Laitteistoversio", swVersion: "Ohjelmistoversio", storage: "Muisti", protocol: "Protokolla",
  batch: "Eränumero", produced: "Valmistettu", week: "viikko", applications: "Sovellukset", noApplications: "ei yhtään (vain kortin taso)",
  freeMemory: "Vapaa muisti", keySettings: "Kortin pääavain", masterKeyChangeable: "voidaan vaihtaa", freeDirectoryList: "sovellukset listataan ilman avainta",
  freeCreateDelete: "sovellukset luodaan / poistetaan ilman avainta", configurationChangeable: "asetuksia voi muuttaa", maxKeys: "avainta", crypto: "salaus",
  yes: "kyllä", no: "ei", cancelled: "Peruttu", step: "Vaihe", template: "Malli", masked: "Korttinumerot ja raitatiedot on peitetty.",
};

export const G_MORE = { es, it, fr, sk, sl, fi } as const;
