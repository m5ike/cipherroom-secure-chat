// The two schemas of the server-side storage.
//
//   global   one plain SQLite database for what the server itself must know:
//            who is registered, which passkeys belong to them, where every
//            encrypted database lives and how it is keyed, the log/debug
//            trail and the transfer records. Values that could describe a
//            conversation (log payloads, transfer details) are sealed with
//            the master key before they land here, so the file on disk
//            carries counts and timestamps rather than content.
//
//   user     one SQLCipher database per user (or per anonymous session),
//            holding everything that is theirs: settings, rooms, messages,
//            the away mailbox and their own audit trail. The whole file is
//            encrypted, indexes and all.
//
// Migrations are a plain list: each entry runs once, in order, and the
// schema version is the number of entries applied. Never edit an entry that
// has shipped — append a new one.
//
// Session ids never reach these tables in the clear: `databases.owner_id`,
// `logs.session_id` and `transfers.session_id` hold an HMAC of the id
// (keys.ts sessionRef). Rows written before that are rewritten by the global
// store when it opens (GlobalStore.rehashLegacySessionIds) — SQL alone
// cannot compute the HMAC.

export type Migration = { name: string; sql: string };

export const GLOBAL_MIGRATIONS: Migration[] = [
  {
    name: "001-core",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        user_name    TEXT NOT NULL DEFAULT '',
        created_at   INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL DEFAULT 0,
        login_count  INTEGER NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS passkeys (
        credential_id TEXT PRIMARY KEY,
        account_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key    TEXT NOT NULL,          -- JWK, public material only
        alg           INTEGER NOT NULL,
        sign_count    INTEGER NOT NULL DEFAULT 0,
        transports    TEXT NOT NULL DEFAULT '',
        label         TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS passkeys_by_account ON passkeys(account_id);

      -- Every encrypted database this server keeps, and how it is keyed.
      CREATE TABLE IF NOT EXISTS databases (
        id            TEXT PRIMARY KEY,
        owner_kind    TEXT NOT NULL,          -- 'account' | 'session'
        owner_id      TEXT NOT NULL,          -- account id, or session id
        key_mode      TEXT NOT NULL,          -- 'prf' | 'wrapped'
        wrapped_key   BLOB,                   -- only for key_mode='wrapped'
        file_name     TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL DEFAULT 0,
        expires_at    INTEGER NOT NULL DEFAULT 0,   -- 0 = keep until asked
        bytes         INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'active'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS databases_by_owner ON databases(owner_kind, owner_id);
      CREATE INDEX IF NOT EXISTS databases_by_expiry ON databases(expires_at);

      -- Log + debug trail. 'detail' is sealed with the master key.
      CREATE TABLE IF NOT EXISTS logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        at         INTEGER NOT NULL,
        level      TEXT NOT NULL,             -- debug | info | warn | error
        source     TEXT NOT NULL,             -- client | server | admin
        event      TEXT NOT NULL,
        account_id TEXT,
        session_id TEXT,
        detail     BLOB
      );
      CREATE INDEX IF NOT EXISTS logs_by_time ON logs(at);
      CREATE INDEX IF NOT EXISTS logs_by_account ON logs(account_id, at);

      -- One row per file transfer, with the detail sealed.
      CREATE TABLE IF NOT EXISTS transfers (
        id           TEXT PRIMARY KEY,
        at           INTEGER NOT NULL,
        finished_at  INTEGER NOT NULL DEFAULT 0,
        direction    TEXT NOT NULL,           -- in | out
        transport    TEXT NOT NULL,           -- p2p | proxy
        status       TEXT NOT NULL,           -- started | completed | cancelled | failed
        account_id   TEXT,
        session_id   TEXT,
        room_hash    TEXT NOT NULL DEFAULT '',
        bytes        INTEGER NOT NULL DEFAULT 0,
        chunks       INTEGER NOT NULL DEFAULT 0,
        resent_chunks INTEGER NOT NULL DEFAULT 0,
        detail       BLOB
      );
      CREATE INDEX IF NOT EXISTS transfers_by_time ON transfers(at);
      CREATE INDEX IF NOT EXISTS transfers_by_account ON transfers(account_id, at);
    `,
  },
  {
    // Key check values, the indexes the sweeps and quotas need, and transfer
    // rows that belong to one owner: (owner, id) is the key now, so nobody
    // can claim — or overwrite — someone else's transfer record.
    name: "002-hardening",
    sql: `
      ALTER TABLE databases ADD COLUMN key_check BLOB;
      CREATE INDEX IF NOT EXISTS databases_by_kind_expiry ON databases(owner_kind, expires_at);
      CREATE INDEX IF NOT EXISTS logs_by_session ON logs(session_id, at);

      CREATE TABLE transfers_v2 (
        id            TEXT NOT NULL,
        owner         TEXT NOT NULL DEFAULT '',  -- 'a:<account>' | 's:<session ref>' | '' (server)
        at            INTEGER NOT NULL,
        finished_at   INTEGER NOT NULL DEFAULT 0,
        direction     TEXT NOT NULL,
        transport     TEXT NOT NULL,
        status        TEXT NOT NULL,
        account_id    TEXT,
        session_id    TEXT,
        room_hash     TEXT NOT NULL DEFAULT '',
        bytes         INTEGER NOT NULL DEFAULT 0,
        chunks        INTEGER NOT NULL DEFAULT 0,
        resent_chunks INTEGER NOT NULL DEFAULT 0,
        detail        BLOB,
        PRIMARY KEY (owner, id)
      );
      INSERT OR IGNORE INTO transfers_v2 (id, owner, at, finished_at, direction, transport, status, account_id, session_id, room_hash, bytes, chunks, resent_chunks, detail)
        SELECT id, COALESCE('a:' || account_id, 's:' || session_id, ''), at, finished_at, direction, transport, status, account_id, session_id, room_hash, bytes, chunks, resent_chunks, detail
        FROM transfers;
      DROP TABLE transfers;
      ALTER TABLE transfers_v2 RENAME TO transfers;
      CREATE INDEX IF NOT EXISTS transfers_by_time ON transfers(at);
      CREATE INDEX IF NOT EXISTS transfers_by_account ON transfers(account_id, at);
      CREATE INDEX IF NOT EXISTS transfers_by_session ON transfers(session_id, at);
    `,
  },
  {
    // The operator's audit journal (server/monitor/audit.ts), persisted.
    // 'detail' is sealed with AAD bound to category + event + at.
    name: "003-audit",
    sql: `
      CREATE TABLE IF NOT EXISTS audit (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        at          INTEGER NOT NULL,
        category    TEXT NOT NULL,
        level       TEXT NOT NULL,             -- debug | info | notice | warn | error
        event       TEXT NOT NULL,
        actor       TEXT,
        target      TEXT,
        account_id  TEXT,
        session_ref TEXT,                      -- HMAC of the session id, never the id
        peer_id     TEXT,
        room_hash   TEXT,
        ip          TEXT,
        bytes       INTEGER,
        status      TEXT,
        detail      BLOB
      );
      CREATE INDEX IF NOT EXISTS audit_by_time ON audit(at);
      CREATE INDEX IF NOT EXISTS audit_by_category ON audit(category, at);
      CREATE INDEX IF NOT EXISTS audit_by_account ON audit(account_id, at);
    `,
  },
  {
    // 3.1 — tamper evidence: every audit row carries the hash of the row
    // before it; signed checkpoints pin the head of the chain (Ed25519, key
    // next to the master key). Rows written before this have no hash and
    // are reported as "before the chain".
    name: "004-audit-chain",
    sql: `
      ALTER TABLE audit ADD COLUMN prev_hash TEXT;
      ALTER TABLE audit ADD COLUMN hash TEXT;
      CREATE TABLE IF NOT EXISTS audit_checkpoints (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        at         INTEGER NOT NULL,
        last_id    INTEGER NOT NULL,
        head_hash  TEXT NOT NULL,
        reason     TEXT NOT NULL,
        signature  TEXT NOT NULL,
        public_key TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_checkpoints_by_last ON audit_checkpoints(last_id);
    `,
  },
];

export const USER_MIGRATIONS: Migration[] = [
  {
    name: "001-core",
    sql: `
      -- Settings, profile, anything the client stores by name.
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rooms (
        room         TEXT PRIMARY KEY,
        name         TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        room        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        stored_at   INTEGER NOT NULL,
        sender_id   TEXT NOT NULL DEFAULT '',
        sender_name TEXT NOT NULL DEFAULT '',
        mine        INTEGER NOT NULL DEFAULT 0,
        expires_at  INTEGER NOT NULL DEFAULT 0,
        bytes       INTEGER NOT NULL DEFAULT 0,
        payload     TEXT NOT NULL             -- the message as JSON
      );
      CREATE INDEX IF NOT EXISTS messages_by_room ON messages(room, created_at);
      CREATE INDEX IF NOT EXISTS messages_by_expiry ON messages(expires_at);

      -- Messages the server accepted while the user was away.
      CREATE TABLE IF NOT EXISTS mailbox (
        id          TEXT PRIMARY KEY,
        room        TEXT NOT NULL,
        kind        TEXT NOT NULL,            -- message | status
        message_id  TEXT NOT NULL,
        from_json   TEXT NOT NULL,
        envelope    TEXT,
        status_json TEXT,
        stored_at   INTEGER NOT NULL,
        bytes       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS mailbox_by_room ON mailbox(room, stored_at);

      -- What happened with this user's data, in their own database.
      CREATE TABLE IF NOT EXISTS events (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        at    INTEGER NOT NULL,
        kind  TEXT NOT NULL,
        meta  TEXT
      );
      CREATE INDEX IF NOT EXISTS events_by_time ON events(at);
    `,
  },
  {
    // Message ids are unique per room, not per database (two rooms may use
    // the same id), and every stored message gets a server-assigned,
    // monotonic `seq` — the cursor incremental reads use. `seq` comes from
    // the counters table, never from max(seq), so a deleted newest message
    // cannot hand its number to the next one.
    name: "002-messages-per-room",
    sql: `
      CREATE TABLE messages_v2 (
        seq         INTEGER PRIMARY KEY,
        id          TEXT NOT NULL,
        room        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        stored_at   INTEGER NOT NULL,
        sender_id   TEXT NOT NULL DEFAULT '',
        sender_name TEXT NOT NULL DEFAULT '',
        mine        INTEGER NOT NULL DEFAULT 0,
        expires_at  INTEGER NOT NULL DEFAULT 0,
        bytes       INTEGER NOT NULL DEFAULT 0,
        payload     TEXT NOT NULL,
        UNIQUE (room, id)
      );
      INSERT INTO messages_v2 (seq, id, room, created_at, stored_at, sender_id, sender_name, mine, expires_at, bytes, payload)
        SELECT row_number() OVER (ORDER BY created_at, rowid), id, room, created_at, stored_at, sender_id, sender_name, mine, expires_at, bytes, payload
        FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_v2 RENAME TO messages;
      CREATE INDEX IF NOT EXISTS messages_by_room ON messages(room, created_at, seq);
      CREATE INDEX IF NOT EXISTS messages_by_room_seq ON messages(room, seq);
      CREATE INDEX IF NOT EXISTS messages_by_created ON messages(created_at, seq);
      CREATE INDEX IF NOT EXISTS messages_by_expiry ON messages(expires_at);

      CREATE TABLE IF NOT EXISTS counters (
        name  TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      INSERT INTO counters (name, value) SELECT 'message_seq', COALESCE(max(seq), 0) FROM messages;

      INSERT OR IGNORE INTO rooms (room, first_seen_at, last_seen_at, message_count)
        SELECT room, min(created_at), max(stored_at), 0 FROM messages GROUP BY room;
      UPDATE rooms SET message_count = (SELECT count(*) FROM messages WHERE messages.room = rooms.room);
      DELETE FROM rooms WHERE message_count <= 0;
    `,
  },
  {
    // The sealed account vault (profile + chat) gets its own table: it is
    // written by the server only, may be larger than a settings value, and
    // an ordinary kv write can no longer overwrite it. A vault kept under
    // the old kv key moves across.
    name: "003-vault",
    sql: `
      CREATE TABLE IF NOT EXISTS vault (
        part       TEXT PRIMARY KEY,           -- 'profile' | 'chat'
        ct         TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT OR REPLACE INTO vault (part, ct, updated_at)
        SELECT 'profile', json_extract(value, '$.profile.ct'), COALESCE(json_extract(value, '$.profile.updatedAt'), updated_at)
        FROM kv WHERE key = 'vault' AND CASE WHEN json_valid(value) THEN json_type(value, '$.profile.ct') = 'text' ELSE 0 END;
      INSERT OR REPLACE INTO vault (part, ct, updated_at)
        SELECT 'chat', json_extract(value, '$.chat.ct'), COALESCE(json_extract(value, '$.chat.updatedAt'), updated_at)
        FROM kv WHERE key = 'vault' AND CASE WHEN json_valid(value) THEN json_type(value, '$.chat.ct') = 'text' ELSE 0 END;
      DELETE FROM kv WHERE key = 'vault';
    `,
  },
];
