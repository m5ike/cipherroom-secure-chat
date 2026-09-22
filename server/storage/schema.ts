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
];
