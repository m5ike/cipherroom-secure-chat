// macOS privacy prompts (Info.plist usage strings) in the nine languages,
// written as <lang>.lproj/InfoPlist.strings into the app's Resources at build
// time (electron-builder.config.cjs). The English ones are also the
// Info.plist defaults. test/desktop-build-config.test.ts checks completeness.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const USAGE = {
  NSCameraUsageDescription: {
    en: "M5cet uses the camera for video calls.",
    cs: "M5cet používá kameru pro videohovory.",
    de: "M5cet verwendet die Kamera für Videoanrufe.",
    es: "M5cet usa la cámara para las videollamadas.",
    it: "M5cet usa la videocamera per le videochiamate.",
    fr: "M5cet utilise la caméra pour les appels vidéo.",
    sk: "M5cet používa kameru na videohovory.",
    sl: "M5cet uporablja kamero za videoklice.",
    fi: "M5cet käyttää kameraa videopuheluihin.",
  },
  NSMicrophoneUsageDescription: {
    en: "M5cet uses the microphone for calls and dictation.",
    cs: "M5cet používá mikrofon pro hovory a diktování.",
    de: "M5cet verwendet das Mikrofon für Anrufe und Diktat.",
    es: "M5cet usa el micrófono para llamadas y dictado.",
    it: "M5cet usa il microfono per chiamate e dettatura.",
    fr: "M5cet utilise le micro pour les appels et la dictée.",
    sk: "M5cet používa mikrofón na hovory a diktovanie.",
    sl: "M5cet uporablja mikrofon za klice in nareko.",
    fi: "M5cet käyttää mikrofonia puheluihin ja sanelemiseen.",
  },
  NSLocationWhenInUseUsageDescription: {
    en: "M5cet shares your location in a room only when you choose to.",
    cs: "M5cet sdílí vaši polohu v místnosti, jen když to sami zvolíte.",
    de: "M5cet teilt Ihren Standort in einem Raum nur, wenn Sie es wählen.",
    es: "M5cet comparte tu ubicación en una sala solo cuando tú lo eliges.",
    it: "M5cet condivide la tua posizione in una stanza solo quando lo scegli tu.",
    fr: "M5cet partage votre position dans une salle uniquement si vous le choisissez.",
    sk: "M5cet zdieľa vašu polohu v miestnosti, len keď to sami zvolíte.",
    sl: "M5cet deli vašo lokacijo v sobi le, ko to izberete.",
    fi: "M5cet jakaa sijaintisi huoneessa vain, kun itse valitset niin.",
  },
  NSAudioCaptureUsageDescription: {
    en: "M5cet records the computer’s sound only when you share your screen with audio.",
    cs: "M5cet nahrává zvuk počítače, jen když sdílíte obrazovku se zvukem.",
    de: "M5cet nimmt den Ton des Computers nur auf, wenn Sie Ihren Bildschirm mit Ton teilen.",
    es: "M5cet graba el sonido del ordenador solo cuando compartes la pantalla con audio.",
    it: "M5cet registra l’audio del computer solo quando condividi lo schermo con l’audio.",
    fr: "M5cet enregistre le son de l’ordinateur uniquement lorsque vous partagez votre écran avec le son.",
    sk: "M5cet nahráva zvuk počítača, len keď zdieľate obrazovku so zvukom.",
    sl: "M5cet snema zvok računalnika le, ko delite zaslon z zvokom.",
    fi: "M5cet tallentaa tietokoneen äänen vain, kun jaat näytön äänen kanssa.",
  },
  NSBluetoothAlwaysUsageDescription: {
    en: "M5cet connects to a Bluetooth NFC reader when you choose one.",
    cs: "M5cet se připojí k bluetoothové čtečce NFC, když ji vyberete.",
    de: "M5cet verbindet sich mit einem Bluetooth-NFC-Leser, wenn Sie einen auswählen.",
    es: "M5cet se conecta a un lector NFC Bluetooth cuando eliges uno.",
    it: "M5cet si collega a un lettore NFC Bluetooth quando ne scegli uno.",
    fr: "M5cet se connecte à un lecteur NFC Bluetooth lorsque vous en choisissez un.",
    sk: "M5cet sa pripojí k bluetoothovej čítačke NFC, keď ju vyberiete.",
    sl: "M5cet se poveže z bralnikom NFC prek Bluetootha, ko ga izberete.",
    fi: "M5cet yhdistää Bluetooth-NFC-lukijaan, kun valitset sellaisen.",
  },
};

export const LANGS = ["en", "cs", "de", "es", "it", "fr", "sk", "sl", "fi"];

/** The Info.plist defaults (English). Location also under the older key. */
export function usageInfo() {
  const out = {};
  for (const [key, row] of Object.entries(USAGE)) out[key] = row.en;
  out.NSLocationUsageDescription = USAGE.NSLocationWhenInUseUsageDescription.en;
  out.NSBluetoothPeripheralUsageDescription = USAGE.NSBluetoothAlwaysUsageDescription.en;
  return out;
}

/** Writes build/lproj/<lang>.lproj/InfoPlist.strings; returns the directory. */
export function writeInfoPlistStrings(dir) {
  for (const lang of LANGS) {
    const lines = Object.entries(USAGE).map(([key, row]) => `"${key}" = "${row[lang].replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";`);
    lines.push(`"NSLocationUsageDescription" = "${USAGE.NSLocationWhenInUseUsageDescription[lang]}";`);
    lines.push(`"NSBluetoothPeripheralUsageDescription" = "${USAGE.NSBluetoothAlwaysUsageDescription[lang]}";`);
    mkdirSync(join(dir, `${lang}.lproj`), { recursive: true });
    writeFileSync(join(dir, `${lang}.lproj`, "InfoPlist.strings"), `${lines.join("\n")}\n`);
  }
  return dir;
}
