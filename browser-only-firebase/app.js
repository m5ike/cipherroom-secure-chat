(() => {
  'use strict';

  const firebaseRules = `{
  "rules": {
    ".read": false,
    ".write": false,
    "cipherroom_lite": {
      "$room": {
        ".read": "$room.matches(/^[A-Za-z0-9_-]{43}$/)",
        ".write": "$room.matches(/^[A-Za-z0-9_-]{43}$/)",
        "peers": {
          "$peer": {
            ".validate": "$peer.matches(/^[a-f0-9-]{36}$/) && newData.hasChildren(['name','ts']) && newData.childrenCount() <= 2",
            "name": { ".validate": "newData.isString() && newData.val().length > 0 && newData.val().length <= 32" },
            "ts": { ".validate": "newData.isNumber()" }
          }
        },
        "signals": {
          "$targetPeer": {
            "$signalId": {
              ".validate": "newData.hasChildren(['from','name','secret','type','ts']) && newData.child('from').isString() && newData.child('name').isString() && newData.child('name').val().length <= 32 && newData.child('secret').isString() && newData.child('secret').val().length == 43 && newData.child('type').isString() && newData.child('type').val().matches(/^(offer|answer|ice)$/) && newData.child('ts').isNumber()"
            }
          }
        }
      }
    }
  }
}`;

  const els = {
    html: document.documentElement,
    themeToggle: document.getElementById('themeToggle'),
    setupForm: document.getElementById('setupForm'),
    firebaseConfig: document.getElementById('firebaseConfig'),
    displayName: document.getElementById('displayName'),
    roomName: document.getElementById('roomName'),
    passphrase: document.getElementById('passphrase'),
    demoConfig: document.getElementById('demoConfig'),
    signalState: document.getElementById('signalState'),
    rulesSnippet: document.getElementById('rulesSnippet'),
    copyRules: document.getElementById('copyRules'),
    leaveButton: document.getElementById('leaveButton'),
    chatTitle: document.getElementById('chatTitle'),
    peerCount: document.getElementById('peerCount'),
    channelCount: document.getElementById('channelCount'),
    messageCount: document.getElementById('messageCount'),
    peerList: document.getElementById('peerList'),
    messages: document.getElementById('messages'),
    messageForm: document.getElementById('messageForm'),
    messageInput: document.getElementById('messageInput'),
    clearLog: document.getElementById('clearLog'),
    eventLog: document.getElementById('eventLog'),
  };

  const state = {
    firebaseApp: null,
    db: null,
    roomKey: '',
    roomLabel: '',
    name: '',
    peerId: crypto.randomUUID(),
    messageKey: null,
    peerSecret: null,
    unsubscribers: [],
    peers: new Map(),
    connections: new Map(),
    processedSignals: new Set(),
    connected: false,
    messages: 0,
  };

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  els.rulesSnippet.textContent = firebaseRules;

  const initialTheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  els.html.setAttribute('data-theme', initialTheme);

  els.themeToggle.addEventListener('click', () => {
    const next = els.html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    els.html.setAttribute('data-theme', next);
    els.themeToggle.setAttribute('aria-label', next === 'dark' ? 'Přepnout na světlý motiv' : 'Přepnout na tmavý motiv');
  });

  els.demoConfig.addEventListener('click', () => {
    els.firebaseConfig.value = JSON.stringify(
      {
        apiKey: 'AIza...',
        authDomain: 'tvuj-projekt.firebaseapp.com',
        databaseURL: 'https://tvuj-projekt-default-rtdb.europe-west1.firebasedatabase.app',
        projectId: 'tvuj-projekt',
        appId: '1:000000000000:web:0000000000000000000000',
      },
      null,
      2,
    );
    log('Vložena šablona. Nahraď hodnoty configem z Firebase Console.');
  });

  els.copyRules.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(firebaseRules);
      log('Rules zkopírovány do schránky.');
    } catch {
      log('Schránka není dostupná. Rules označ a zkopíruj ručně.');
    }
  });

  els.clearLog.addEventListener('click', () => {
    els.eventLog.textContent = '';
  });

  els.leaveButton.addEventListener('click', () => {
    leaveRoom();
  });

  els.setupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.connected) return;
    await connectRoom();
  });

  els.messageForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = els.messageInput.value.trim();
    if (!text) return;
    await sendMessage(text);
    els.messageInput.value = '';
  });

  window.addEventListener('beforeunload', () => {
    leaveRoom({ silent: true });
  });

  async function connectRoom() {
    try {
      assertBrowserSupport();
      const config = parseFirebaseConfig(els.firebaseConfig.value);
      const name = els.displayName.value.trim();
      const roomLabel = els.roomName.value.trim();
      const passphrase = els.passphrase.value;

      if (!name || !roomLabel || passphrase.length < 10) {
        throw new Error('Vyplň jméno, místnost a frázi alespoň 10 znaků.');
      }

      setBusy(true);
      setSignalState('connecting');
      log('Derivuji room klíče přes PBKDF2.');

      const roomKey = await deriveRoomKey(roomLabel, passphrase);
      const messageKey = await deriveAesKey(`cipherroom-message:${roomKey}`, passphrase);
      const peerSecret = await sha256Base64Url(`peer-auth:${roomLabel}:${passphrase}`);

      const appName = `cipherroom-lite-${crypto.randomUUID()}`;
      const app = firebase.initializeApp(config, appName);
      const db = firebase.database(app);

      Object.assign(state, {
        firebaseApp: app,
        db,
        roomKey,
        roomLabel,
        name,
        messageKey,
        peerSecret,
        connected: true,
      });

      await joinFirebaseRoom();
      renderConnectedUi();
      log(`Připojeno do místnosti ${roomLabel}. Signalizační cesta: cipherroom_lite/${roomKey}`);
    } catch (error) {
      setSignalState('error');
      log(`Chyba: ${error.message}`);
      await leaveRoom({ silent: true });
    } finally {
      setBusy(false);
    }
  }

  async function joinFirebaseRoom() {
    const peerRef = dbRef(`peers/${state.peerId}`);
    const signalRef = dbRef(`signals/${state.peerId}`);
    await peerRef.onDisconnect().remove();
    await signalRef.onDisconnect().remove();
    await peerRef.set({
      name: state.name,
      ts: firebase.database.ServerValue.TIMESTAMP,
    });

    const peersUnsub = dbRef('peers').on('value', (snapshot) => {
      const peers = snapshot.val() || {};
      reconcilePeers(peers);
    });

    const signalsUnsub = signalRef.on('child_added', async (snapshot) => {
      const signalId = snapshot.key;
      const signal = snapshot.val();
      if (!signal || state.processedSignals.has(signalId) || signal.from === state.peerId) return;
      state.processedSignals.add(signalId);
      try {
        await handleSignal(signal);
      } catch (error) {
        log(`Signal chyba od ${shortId(signal.from)}: ${error.message}`);
      } finally {
        snapshot.ref.remove().catch(() => undefined);
      }
    });

    state.unsubscribers.push(() => dbRef('peers').off('value', peersUnsub));
    state.unsubscribers.push(() => signalRef.off('child_added', signalsUnsub));
    setSignalState('online');
  }

  function reconcilePeers(rawPeers) {
    const previous = new Set(state.peers.keys());
    state.peers.clear();

    for (const [peerId, info] of Object.entries(rawPeers)) {
      if (peerId === state.peerId) continue;
      state.peers.set(peerId, {
        name: String(info?.name || 'peer').slice(0, 32),
        ts: Number(info?.ts || Date.now()),
      });
      previous.delete(peerId);
      ensurePeerConnection(peerId, info?.name || 'peer');
    }

    for (const peerId of previous) {
      closePeer(peerId);
      log(`Peer ${shortId(peerId)} odešel.`);
    }

    renderPeers();
    updateStats();
  }

  function ensurePeerConnection(peerId, peerName) {
    if (state.connections.has(peerId)) return state.connections.get(peerId);

    const pc = new RTCPeerConnection({ iceServers });
    const record = {
      peerId,
      peerName,
      pc,
      channel: null,
      ready: false,
      makingOffer: false,
    };
    state.connections.set(peerId, record);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        sendSignal(peerId, 'ice', { candidate }).catch((error) => log(`ICE send chyba: ${error.message}`));
      }
    };

    pc.onconnectionstatechange = () => {
      log(`P2P ${shortId(peerId)}: ${pc.connectionState}`);
      updateStats();
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        record.ready = false;
        updateStats();
      }
    };

    pc.ondatachannel = (event) => {
      attachDataChannel(record, event.channel);
    };

    const polite = state.peerId > peerId;
    if (!polite) {
      const channel = pc.createDataChannel('cipherroom', { ordered: true });
      attachDataChannel(record, channel);
      negotiate(record).catch((error) => log(`Offer chyba ${shortId(peerId)}: ${error.message}`));
    }

    return record;
  }

  async function negotiate(record) {
    record.makingOffer = true;
    try {
      await record.pc.setLocalDescription(await record.pc.createOffer());
      await sendSignal(record.peerId, 'offer', { description: record.pc.localDescription });
      log(`Offer poslán peeru ${shortId(record.peerId)}.`);
    } finally {
      record.makingOffer = false;
    }
  }

  async function handleSignal(signal) {
    if (signal.secret !== state.peerSecret) {
      log(`Ignoruji signal s nesprávným room secretem od ${shortId(signal.from)}.`);
      return;
    }

    const record = ensurePeerConnection(signal.from, signal.name || 'peer');
    const pc = record.pc;

    if (signal.type === 'offer') {
      const description = signal.description;
      const offerCollision = record.makingOffer || pc.signalingState !== 'stable';
      const polite = state.peerId > signal.from;
      if (offerCollision && !polite) {
        log(`Ignoruji kolizní offer od ${shortId(signal.from)}.`);
        return;
      }
      await pc.setRemoteDescription(description);
      await pc.setLocalDescription(await pc.createAnswer());
      await sendSignal(signal.from, 'answer', { description: pc.localDescription });
      log(`Answer poslán peeru ${shortId(signal.from)}.`);
      return;
    }

    if (signal.type === 'answer') {
      await pc.setRemoteDescription(signal.description);
      log(`Answer přijat od ${shortId(signal.from)}.`);
      return;
    }

    if (signal.type === 'ice' && signal.candidate) {
      await pc.addIceCandidate(signal.candidate);
      return;
    }
  }

  function attachDataChannel(record, channel) {
    record.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      record.ready = true;
      log(`DataChannel otevřen: ${record.peerName} (${shortId(record.peerId)}).`);
      sendControl(record, { kind: 'hello', name: state.name }).catch(() => undefined);
      updateStats();
    };
    channel.onclose = () => {
      record.ready = false;
      log(`DataChannel zavřen: ${shortId(record.peerId)}.`);
      updateStats();
    };
    channel.onerror = () => {
      record.ready = false;
      log(`DataChannel chyba: ${shortId(record.peerId)}.`);
      updateStats();
    };
    channel.onmessage = async (event) => {
      await receiveChannelMessage(record, event.data);
    };
  }

  async function receiveChannelMessage(record, raw) {
    try {
      const packet = JSON.parse(String(raw));
      if (packet.kind === 'hello') {
        record.peerName = String(packet.name || record.peerName).slice(0, 32);
        renderPeers();
        return;
      }
      if (packet.kind !== 'message') return;
      const plain = await decryptJson(packet.payload);
      addMessage({
        own: false,
        name: plain.name || record.peerName || 'peer',
        text: plain.text,
        ts: plain.ts || Date.now(),
      });
    } catch (error) {
      log(`Nepodařilo se dešifrovat zprávu od ${shortId(record.peerId)}: ${error.message}`);
    }
  }

  async function sendControl(record, packet) {
    if (record.channel?.readyState === 'open') {
      record.channel.send(JSON.stringify(packet));
    }
  }

  async function sendMessage(text) {
    const readyRecords = [...state.connections.values()].filter((record) => record.channel?.readyState === 'open');
    if (!readyRecords.length) {
      log('Zatím není otevřený žádný P2P DataChannel.');
      return;
    }

    const payload = await encryptJson({
      text,
      name: state.name,
      ts: Date.now(),
    });
    const packet = JSON.stringify({ kind: 'message', payload });

    for (const record of readyRecords) {
      record.channel.send(packet);
    }
    addMessage({ own: true, name: state.name, text, ts: Date.now() });
    log(`Odesláno ${readyRecords.length} peerům přes P2P.`);
  }

  async function sendSignal(targetPeer, type, payload = {}) {
    if (!state.connected) return;
    await dbRef(`signals/${targetPeer}`).push({
      from: state.peerId,
      name: state.name,
      secret: state.peerSecret,
      type,
      ts: firebase.database.ServerValue.TIMESTAMP,
      ...payload,
    });
  }

  async function leaveRoom(options = {}) {
    const { silent = false } = options;
    for (const unsubscribe of state.unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // noop
      }
    }
    for (const peerId of [...state.connections.keys()]) {
      closePeer(peerId);
    }
    if (state.db && state.roomKey) {
      try {
        await dbRef(`signals/${state.peerId}`).remove();
        await dbRef(`peers/${state.peerId}`).remove();
      } catch {
        // noop
      }
    }
    if (state.firebaseApp) {
      try {
        await state.firebaseApp.delete();
      } catch {
        // noop
      }
    }

    state.firebaseApp = null;
    state.db = null;
    state.roomKey = '';
    state.roomLabel = '';
    state.messageKey = null;
    state.peerSecret = null;
    state.peers.clear();
    state.processedSignals.clear();
    state.connected = false;
    renderDisconnectedUi();
    setSignalState('offline');
    if (!silent) log('Odpojeno a lokální WebRTC spojení zavřena.');
  }

  function closePeer(peerId) {
    const record = state.connections.get(peerId);
    if (!record) return;
    try {
      record.channel?.close();
    } catch {
      // noop
    }
    try {
      record.pc.close();
    } catch {
      // noop
    }
    state.connections.delete(peerId);
  }

  async function deriveRoomKey(roomName, passphrase) {
    const digest = await sha256Bytes(`cipherroom-room:${roomName}:${passphrase}`);
    return base64Url(digest).slice(0, 43);
  }

  async function deriveAesKey(saltText, passphrase) {
    const baseKey = await crypto.subtle.importKey('raw', enc(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: enc(saltText),
        iterations: 240000,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async function encryptJson(value) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = enc(JSON.stringify(value));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, state.messageKey, data);
    return {
      v: 1,
      alg: 'AES-GCM',
      iv: base64Url(iv),
      data: base64Url(new Uint8Array(ciphertext)),
    };
  }

  async function decryptJson(payload) {
    const iv = fromBase64Url(payload.iv);
    const data = fromBase64Url(payload.data);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, state.messageKey, data);
    return JSON.parse(dec(new Uint8Array(plain)));
  }

  async function sha256Bytes(text) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', enc(text)));
  }

  async function sha256Base64Url(text) {
    return base64Url(await sha256Bytes(text));
  }

  function enc(text) {
    return new TextEncoder().encode(text);
  }

  function dec(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function base64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function fromBase64Url(value) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  }

  function parseFirebaseConfig(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Firebase config není validní JSON.');
    }
    const required = ['apiKey', 'databaseURL', 'projectId', 'appId'];
    for (const key of required) {
      if (!parsed[key] || typeof parsed[key] !== 'string') {
        throw new Error(`Firebase config musí obsahovat "${key}".`);
      }
      if (parsed[key].includes('...') || parsed[key].includes('tvuj-projekt')) {
        throw new Error('Nejdřív nahraď šablonu skutečným Firebase web configem.');
      }
    }
    if (!/^https:\/\/.+/.test(parsed.databaseURL)) {
      throw new Error('databaseURL musí začínat https://');
    }
    return parsed;
  }

  function assertBrowserSupport() {
    if (!window.crypto?.subtle || !window.RTCPeerConnection || !window.firebase?.database) {
      throw new Error('Prohlížeč nepodporuje WebCrypto, WebRTC nebo se nenačetl Firebase SDK.');
    }
  }

  function dbRef(path = '') {
    return state.db.ref(`cipherroom_lite/${state.roomKey}${path ? `/${path}` : ''}`);
  }

  function renderConnectedUi() {
    els.setupForm.querySelectorAll('input, textarea, button').forEach((node) => {
      if (node.id !== 'demoConfig') node.disabled = true;
    });
    els.chatTitle.textContent = state.roomLabel;
    els.leaveButton.disabled = false;
    els.messageInput.disabled = false;
    els.messageForm.querySelector('button').disabled = false;
    updateStats();
    renderPeers();
  }

  function renderDisconnectedUi() {
    els.setupForm.querySelectorAll('input, textarea, button').forEach((node) => {
      node.disabled = false;
    });
    els.chatTitle.textContent = 'Nepřipojeno';
    els.leaveButton.disabled = true;
    els.messageInput.disabled = true;
    els.messageForm.querySelector('button').disabled = true;
    els.peerCount.textContent = '0';
    els.channelCount.textContent = '0';
    renderPeers();
    updateStats();
  }

  function renderPeers() {
    if (!state.peers.size) {
      els.peerList.innerHTML = `<div class="empty-state"><strong>Čekám na připojení</strong><span>Otevři stejný soubor v druhém prohlížeči, vlož stejný Firebase config, místnost a frázi.</span></div>`;
      return;
    }
    els.peerList.replaceChildren(
      ...[...state.peers.entries()].map(([peerId, info]) => {
        const record = state.connections.get(peerId);
        const chip = document.createElement('article');
        chip.className = 'peer-chip';
        const title = document.createElement('strong');
        title.textContent = record?.peerName || info.name || 'peer';
        const status = document.createElement('span');
        status.textContent = `${record?.channel?.readyState || 'connecting'} · ${shortId(peerId)}`;
        chip.append(title, status);
        return chip;
      }),
    );
  }

  function addMessage({ own, name, text, ts }) {
    state.messages += 1;
    const article = document.createElement('article');
    article.className = own ? 'message own' : 'message';
    const header = document.createElement('div');
    header.className = 'message-header';
    const author = document.createElement('strong');
    author.textContent = own ? `${name} · ty` : name;
    const time = document.createElement('time');
    time.dateTime = new Date(ts).toISOString();
    time.textContent = new Intl.DateTimeFormat('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(ts);
    const body = document.createElement('p');
    body.textContent = text;
    header.append(author, time);
    article.append(header, body);
    els.messages.append(article);
    els.messages.scrollTop = els.messages.scrollHeight;
    updateStats();
  }

  function updateStats() {
    els.peerCount.textContent = String(state.peers.size);
    els.channelCount.textContent = String([...state.connections.values()].filter((record) => record.channel?.readyState === 'open').length);
    els.messageCount.textContent = String(state.messages);
    renderPeers();
  }

  function setBusy(busy) {
    els.setupForm.querySelector('[type="submit"]').disabled = busy;
  }

  function setSignalState(value) {
    els.signalState.textContent = value;
    els.signalState.classList.toggle('online', value === 'online');
  }

  function log(message) {
    const stamp = new Intl.DateTimeFormat('cs-CZ', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(Date.now());
    els.eventLog.textContent = `[${stamp}] ${message}\n${els.eventLog.textContent}`.slice(0, 8000);
  }

  function shortId(peerId) {
    return String(peerId).slice(0, 8);
  }
})();
