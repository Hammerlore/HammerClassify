/* ==========================================================================
   HammerClassify — Datenbank (better-sqlite3, data/classify.db)
   Migrations laufen beim Start; die Version steht in schema_version.
   better-sqlite3 bleibt bewusst gewählt: kompatibel zu sqlite_snap in
   backup-all.sh (Muster aus HLSW-Management).
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

export const SCHEMA_STAND = 1;

const MIGRATIONEN = {
  1: `
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id  TEXT NOT NULL UNIQUE,
      public_key     BLOB NOT NULL,
      sign_count     INTEGER NOT NULL DEFAULT 0,
      aaguid         TEXT,
      transport      TEXT,
      label          TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash    TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      passkey_id    INTEGER REFERENCES passkeys(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL,
      expires_at    TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(user_id);
  `,
};

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'classify.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrieren(db);
  return db;
}

function migrieren(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version      INTEGER PRIMARY KEY,
    applied_at   TEXT NOT NULL
  )`);
  const aktuell = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()?.v ?? 0;
  const anwenden = db.transaction(() => {
    for (let v = aktuell + 1; v <= SCHEMA_STAND; v++) {
      db.exec(MIGRATIONEN[v]);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
        .run(v, new Date().toISOString());
    }
  });
  anwenden();
}

/* ------------------------------- Nutzer -------------------------------- */

export function createNutzer(db, name) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)')
    .run(id, name, new Date().toISOString());
  return id;
}

export function getNutzer(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function countNutzer(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/* ------------------------------- Passkeys ------------------------------ */

export function addPasskey(db, userId, { credentialId, publicKey, signCount, aaguid, transport, label }) {
  return db.prepare(`INSERT INTO passkeys
    (user_id, credential_id, public_key, sign_count, aaguid, transport, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, credentialId, publicKey, signCount, aaguid ?? null, transport ?? null, label ?? null, new Date().toISOString())
    .lastInsertRowid;
}

export function getPasskeyByCredential(db, credentialId) {
  return db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credentialId);
}

export function getPasskeysForUser(db, userId) {
  return db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId);
}

export function countPasskeys(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n;
}

export function bumpSignCount(db, passkeyId, signCount) {
  db.prepare('UPDATE passkeys SET sign_count = ? WHERE id = ? AND sign_count < ?')
    .run(signCount, passkeyId, signCount);
}

/* ------------------------------- Sessions ------------------------------ */

const tokenHash = (token) =>
  crypto.createHash('sha256').update(token).digest('base64url');

export function createSession(db, { userId, passkeyId, days }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const jetzt = Date.now();
  const expires = new Date(jetzt + days * 86400_000).toISOString();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, passkey_id, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tokenHash(token), userId, passkeyId ?? null, new Date(jetzt).toISOString(), expires, new Date(jetzt).toISOString());
  return token;
}

export function getSessionByToken(db, token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash(token));
  if (!s) return null;
  if (Date.parse(s.expires_at) < Date.now()) {
    deleteSession(db, s.token_hash);
    return null;
  }
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
    .run(new Date().toISOString(), s.token_hash);
  return s;
}

export function deleteSession(db, tokenHashValue) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHashValue);
}

export function deleteSessionByToken(db, token) {
  if (!token) return;
  const h = crypto.createHash('sha256').update(token).digest('base64url');
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
}

export function deleteSessionsExceptPasskey(db, userId, keepPasskeyId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ? AND (passkey_id IS NULL OR passkey_id != ?)')
    .run(userId, keepPasskeyId).changes;
}
