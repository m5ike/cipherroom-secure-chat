# M5cet 6.12 — bezpečnostní shrnutí: podklady a zdroje

Příloha k [`security-summary-6.12.html`](security-summary-6.12.html) / `security-summary-6.12.pdf`
(shrnutí na 3 strany, stav k 2026-10-05).

## M5cet — revize kódu

Stav: verze 6.12.0, commit `2ec130fa`. Pět průchodů kódem (jen čtení), každé tvrzení doložené
`soubor:řádek` v pracovních poznámkách revize:

1. protokol a identita (web `client/src/lib/p4/*`, `p4-*.ts`, `envelope.ts`; Android `cz.m5cet.app.p4`);
2. Android platforma (zámek, trezor, Keystore, design, aktualizace, hovory, push);
3. web a serverová platforma a supply chain (doručení kódu, CSP, sandbox funkcí, konzole, audit,
   limity, webhooky, CI, buildy, vektory);
4. metadata a šifrování v klidu na serveru (hub, relay, účty, access log, push, telefonie, AI, KT, úložiště);
5. výčet funkcí.

Podrobná analýza: [`security-analysis.md`](security-analysis.md) (kap. 13 je o 6.12 optimističtější —
toto shrnutí ji opravuje v bodech uvedených na str. 1), specifikace [`protocol-v4.md`](protocol-v4.md),
revize [`review-612.md`](review-612.md).

## Konkurence — zdroje (stav k 10/2026; „2nd“ = sekundární zdroj, „>12mo“ = starší než rok)

1. Signal — Signal Protocol and Post-Quantum Ratchets (2025-10-02) https://signal.org/blog/spqr/
2. Signal — Introducing Automatic Key Verification (2026-08-11) https://signal.org/blog/automatic-key-verification/
3. FPF — Signal introduces registration without a phone number (2026-09-23, 2nd) https://freedom.press/digisec/blog/signal-introduces-registration-without-a-phone-number/
4. Signal — Back to Backups (2026-09-28) https://signal.org/blog/backup-improvements/
5. Signal — More linked devices, Android tablet (2026-08-04) https://signal.org/blog/linked-devices-and-android-tablets/
6. Signal — Signal usernames (2024-02-20, >12mo) https://signal.org/blog/phone-number-privacy-usernames/
7. Signal — Big Brother responses (poslední 2026-03-06) https://signal.org/bigbrother/
8. Google TAG — Russia targeting Signal (2025-02-19, >12mo) https://cloud.google.com/blog/topics/threat-intelligence/russia-targeting-signal-messenger
9. WhatsApp Encryption Overview v9 (2026-02-25) https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf
10. WhatsApp — reserve your username (2026-06-29) https://blog.whatsapp.com/its-time-to-reserve-your-whatsapp-username
11. Meta — PQC migration at Meta (2026-04-16) https://engineering.fb.com/2026/04/16/security/post-quantum-cryptography-migration-at-meta-framework-lessons-and-takeaways/
12. Meta — Private Processing (2025-04-29) https://engineering.fb.com/2025/04/29/security/whatsapp-private-processing-ai-tools/ ; Incognito Chat (2026-05-13) https://about.fb.com/news/2026/05/incognito-chat-whatsapp-meta-ai/
13. Meta — passkey-encrypted backups (2025-10) https://about.fb.com/news/2025/10/making-it-easier-to-encrypt-whatsapp-chat-backups/
14. Meta — third-party chats in Europe (2025-11) https://about.fb.com/news/2025/11/messaging-interoperability-whatsapp-enables-third-party-chats-for-users-in-europe/
15. Cloudflare — auditing WhatsApp key transparency (2024-09-24, >12mo) https://blog.cloudflare.com/key-transparency/
16. The Hacker News — CVE-2025-55177 (2025-08, 2nd) https://thehackernews.com/2025/08/whatsapp-issues-emergency-update-for.html
17. The Register — WhatsApp enumeration 3,5 mld. účtů (2025-11-19, 2nd) https://www.theregister.com/2025/11/19/whatsapp_enumeration_flaw/
18. WhatsApp FAQ — propojená zařízení https://faq.whatsapp.com/1317564962315842 ; skupiny https://faq.whatsapp.com/841426356990637
19. Threema — Quantum-secure future (2026-02-24) https://threema.com/en/blog/quantum-secure-future
20. Threema — Cryptography Whitepaper (2026-06-26) https://threema.com/assets/documents/threema-cryptography-whitepaper.pdf
21. Threema — roadmap (2026-07-08) https://threema.com/en/blog/roadmap-for-threema-work-2026
22. Threema — vlastníci, transparentnost, audity, open source, skupinové hovory: https://threema.com/en/faq/owners , https://threema.com/en/transparency-report , https://threema.com/en/faq/code-audit , https://threema.com/en/why-threema/open-source , https://threema.com/en/faq/groupcalls
23. Telegram FAQ https://telegram.org/faq ; skupinové hovory E2EE (2025-04-30) https://telegram.org/blog/group-calls-made-easy
24. Albrecht, Mareková, Paterson, Ronen, Stepanovs — Analysis of the Telegram Key Exchange, Eurocrypt 2025 https://eprint.iacr.org/2025/451
25. BleepingComputer — Telegram předávání dat 2024 (2025-01, 2nd) https://www.bleepingcomputer.com/news/legal/telegram-hands-over-data-on-thousands-of-users-to-us-law-enforcement/
26. Telegram — Passkeys (2025-12-12) https://telegram.org/blog/passkeys-and-gift-offers
27. Apple — iMessage PQ3 (2024-02-21, >12mo) https://security.apple.com/blog/imessage-pq3/
28. Apple Newsroom — E2EE RCS beta (2026-05-11) https://www.apple.com/newsroom/2026/05/end-to-end-encrypted-rcs-messaging-begins-rolling-out-today-in-beta/
29. Apple — iCloud data security overview https://support.apple.com/en-us/102651
30. Citizen Lab — Graphite (2025-06) https://citizenlab.ca/research/first-forensic-confirmation-of-paragons-ios-mercenary-spyware-finds-journalists-targeted/
31. Apple Platform Security — FaceTime https://support.apple.com/guide/security/facetime-security-seca331c55cd/web
32. Wire — MLS GA (2025-04-24) https://wire.com/en/blog/wire-mls-is-now-generally-available ; Security Whitepaper (05/2025) https://wire.com/hubfs/Whitepapers/-wire-security-whitepaper.pdf
33. Wire — openmls PR #110 (2026-07-15, otevřený) https://github.com/wireapp/openmls/pull/110
34. Wire — transparency report 2025 https://wire.com/en/transparency-report
35. Matrix — Holiday Special (2025-12-24) https://matrix.org/blog/2025/12/24/matrix-holiday-special/
36. Matrix — Project Hydra / CVE-2025-49090 (2025-08) https://matrix.org/blog/2025/08/project-hydra-improving-state-res/
37. Element — Element Call (2025) https://element.io/blog/element-call-redefining-conferencing-for-privacy-scale-and-sovereignty/
38. Session — Protocol V2 (2025-12-01) https://getsession.org/blog/session-protocol-v2 ; The Future of Session (2026-06-15) https://getsession.org/blog/the-future-of-session
39. Session — hovory https://getsession.org/calls-on-session
40. Soatok — Don't Use Session (2025-01-14) https://soatok.blog/2025/01/14/dont-use-session-signal-fork/
41. SimpleX — security https://simplex.chat/security/ ; transparency https://simplex.chat/transparency/
42. SimpleX — v5.7 PQ (2024-04-26, >12mo) https://simplex.chat/blog/20240426-simplex-legally-binding-transparency-v5-7-better-user-experience.html ; channels (2026-04-30) https://simplex.chat/blog/20260430-simplex-channels-v6-5-consortium-crowdfunding-freedom-of-speech.html
43. Gegenhuber et al. — Send and Pretend, USENIX Security 2026 https://arxiv.org/abs/2607.27510
44. Said, Naska, Morio, Künnemann — From Specs to Apps, ACM CCS 2026 https://arxiv.org/abs/2609.11882

Neověřeno: velikosti skupin, hovorů a limit souborů u Signalu a iMessage (ve shrnutí „?“); hodnocení
konkurence v tabulce 5 je orientační odhad pro kontext, ne výsledek revize jejich kódu.
