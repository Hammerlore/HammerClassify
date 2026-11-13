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

export const SCHEMA_STAND = 6;

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
  2: `
    CREATE TABLE IF NOT EXISTS documents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      ext          TEXT NOT NULL,
      mime         TEXT NOT NULL,
      size         INTEGER NOT NULL,
      sha256       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'eingang',
      text         TEXT,
      text_status  TEXT NOT NULL DEFAULT 'offen',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);
    CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
    CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);
  `,
   3: `
    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `,
   // Korrektur: Status-Tippfehler „imingang" → „eingang" (konzept.md: „Eingang").
   // Nur ein UPDATE — die Spalte bleibt, die Werte werden umgeschrieben.
   4: `
    UPDATE documents SET status = 'eingang' WHERE status = 'imingang';
  `,
   // P3: Regeln (Daten, kein Code) + Klassifizierungsergebnis am Dokument.
   5: `
    CREATE TABLE IF NOT EXISTS rules (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      name               TEXT NOT NULL,
      art                TEXT NOT NULL,
      beschreibung       TEXT NOT NULL,
      schluesselwoerter  TEXT,
      bedingung          TEXT,
      beispiel           TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rules_art ON rules(art);
    ALTER TABLE documents ADD COLUMN klassifizierung TEXT;
    ALTER TABLE documents ADD COLUMN klassifiziert_am TEXT;
  `,
   // P4: Scan-Quellen (lokal / rclone) + Dedup-Cache + Aufbewahrungs-Tag.
   // Die App liest nur Pfade, die hier gepflegt sind — nie freie Pfade (konzept.md).
   6: `
    CREATE TABLE IF NOT EXISTS sources (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      typ          TEXT NOT NULL CHECK (typ IN ('lokal', 'rclone')),
      pfad         TEXT NOT NULL,
      aktiv        INTEGER NOT NULL DEFAULT 1,
      letzte_scan  TEXT
    );
    CREATE TABLE IF NOT EXISTS scan_seen (
      source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      pfad       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      modtime    TEXT NOT NULL,
      sha256     TEXT NOT NULL,
      PRIMARY KEY (source_id, pfad)
    );
    ALTER TABLE documents ADD COLUMN source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL;
    ALTER TABLE documents ADD COLUMN quellpfad TEXT;
    ALTER TABLE documents ADD COLUMN halte_bis INTEGER;
    CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);
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

/* ------------------------------- Dokumente ----------------------------- */

export function addDocument(db, { name, ext, mime, size, sha256, text, textStatus, sourceId = null, quellpfad = null, halteBis = null }) {
  const jetzt = new Date().toISOString();
  const id = db.prepare(`INSERT INTO documents
    (name, ext, mime, size, sha256, status, text, text_status, created_at, updated_at, source_id, quellpfad, halte_bis)
    VALUES (?, ?, ?, ?, ?, 'eingang', ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, ext, mime, size, sha256, text, textStatus, jetzt, jetzt, sourceId, quellpfad, halteBis)
    .lastInsertRowid;
  return getDocument(db, id);
}

export function getDocument(db, id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

export function findDocumentBySha(db, sha256) {
  return db.prepare('SELECT * FROM documents WHERE sha256 = ?').get(sha256);
}

export function listDocuments(db, { limit = 200 } = {}) {
  return db.prepare('SELECT * FROM documents ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
}

export function countDocuments(db, status = null) {
  if (status) {
    return db.prepare('SELECT COUNT(*) AS n FROM documents WHERE status = ?').get(status).n;
  }
  return db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
}

export function deleteDocument(db, id) {
  return db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes;
}

/* ------------------------------ Quellen (P4) ---------------------------- */
/* Scan-Quellen: die App liest nur Pfade, die hier gepflegt sind, nie freie
   Pfade (konzept.md §Offene Punkte 3). Zwei Typen:
     'lokal'  — Pfad auf dem Pi (z. B. Nextcloud-Datenverzeichnis)
     'rclone' — Remote-Pfad (z. B. onedrive:16 Bank) */

export const SOURCE_TYPEN = ['lokal', 'rclone'];

export function listSources(db) {
  return db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id AND d.status = 'eingang') AS neu,
      (SELECT COUNT(*) FROM documents d WHERE d.source_id = s.id) AS gesamt
    FROM sources s ORDER BY s.name`).all();
}

export function getSource(db, id) {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
}

export function addSource(db, { name, typ, pfad }) {
  const id = db.prepare(`INSERT INTO sources (name, typ, pfad, aktiv) VALUES (?, ?, ?, 1)`)
    .run(name, typ, pfad).lastInsertRowid;
  return getSource(db, id);
}

export function updateSource(db, id, { name, typ, pfad, aktiv }) {
  const s = getSource(db, id);
  if (!s) return false;
  db.prepare(`UPDATE sources SET name = ?, typ = ?, pfad = ?, aktiv = ? WHERE id = ?`)
    .run(name ?? s.name, typ ?? s.typ, pfad ?? s.pfad, aktiv === undefined ? s.aktiv : aktiv ? 1 : 0, id);
  return true;
}

export function deleteSource(db, id) {
  return db.prepare('DELETE FROM sources WHERE id = ?').run(id).changes;
}

export function setzeLetzterScan(db, id, iso) {
  db.prepare('UPDATE sources SET letzte_scan = ? WHERE id = ?').run(iso, id);
}

/* Dedup-Cache pro Quelle: (Pfad, Größe, ModTime) → SHA-256.
   Unveränderte Dateien werden beim Neuscan nicht erneut heruntergeladen/gehasht. */

export function seenGet(db, sourceId, pfad) {
  return db.prepare('SELECT * FROM scan_seen WHERE source_id = ? AND pfad = ?').get(sourceId, pfad);
}

export function seenUpsert(db, { sourceId, pfad, size, modtime, sha256 }) {
  db.prepare(`INSERT INTO scan_seen (source_id, pfad, size, modtime, sha256) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_id, pfad) DO UPDATE SET size = excluded.size, modtime = excluded.modtime, sha256 = excluded.sha256`)
    .run(sourceId, pfad, size, modtime, sha256);
}

/* --------------------------- Aufbewahrung (P4) --------------------------- */
/* Offener Punkt 6: Beleg-Charakter → 10-Jahre-Aufbewahrung. Die Liste der
   Dokumenttypen mit Haltepflicht ist eine Einstellung (z. B. „Rechnung,
   Vertrag"); beim Klassifizieren wird das Jahr + 10 am Dokument vermerkt. */

export const HALTE_JAHRE = 10;

export function halteTypen(db) {
  return (getSetting(db, 'halte_typen') ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export function halteBisFuer(db, dokumenttypName, jetzt = new Date()) {
  if (!dokumenttypName) return null;
  const typen = halteTypen(db);
  if (!typen.some((t) => t.toLowerCase() === dokumenttypName.toLowerCase())) return null;
  return jetzt.getFullYear() + HALTE_JAHRE;
}

export function setzeHalteBis(db, id, jahr) {
  db.prepare('UPDATE documents SET halte_bis = ? WHERE id = ?').run(jahr, id);
}

/* -------------------------------- Regeln -------------------------------- */
/* Regeln sind Daten, kein Code (konzept.md): sie leben in der DB und werden
   in der App bearbeitet. Drei Arten, ein Modell:
   art: 'kategorie' (Thema) | 'dokumenttyp' (Rechnung, Angebot, …)
        | 'feld' (zu extrahierendes Feld, z. B. Rechnungsdatum, Zahlungsmethode).
   bedingung: optional 'eigener_name_adresse' (deterministisch geprüft). */

export const REGEL_ARTEN = ['kategorie', 'dokumenttyp', 'feld'];
export const REGEL_BEDINGUNGEN = ['eigener_name_adresse'];
export const REGEL_ART_LABEL = { kategorie: 'Kategorie', dokumenttyp: 'Dokumenttyp', feld: 'Feld' };

function parseRegel(r) {
  if (!r) return null;
  let kw = [];
  try { kw = r.schluesselwoerter ? JSON.parse(r.schluesselwoerter) : []; } catch { /* defektes JSON → leer */ }
  return { ...r, schluesselwoerter: Array.isArray(kw) ? kw : [] };
}

export function listRegeln(db, art = null) {
  const sql = 'SELECT * FROM rules' + (art ? ' WHERE art = ?' : '') + ' ORDER BY art, name';
  const rows = art ? db.prepare(sql).all(art) : db.prepare(sql).all();
  return rows.map(parseRegel);
}

export function getRegel(db, id) {
  return parseRegel(db.prepare('SELECT * FROM rules WHERE id = ?').get(id));
}

export function addRegel(db, { name, art, beschreibung, schluesselwoerter, bedingung, beispiel }) {
  const jetzt = new Date().toISOString();
  const id = db.prepare(`INSERT INTO rules
    (name, art, beschreibung, schluesselwoerter, bedingung, beispiel, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, art, beschreibung, JSON.stringify(schluesselwoerter ?? []), bedingung ?? null, beispiel ?? null, jetzt, jetzt)
    .lastInsertRowid;
  return getRegel(db, id);
}

export function updateRegel(db, id, { name, art, beschreibung, schluesselwoerter, bedingung, beispiel }) {
  db.prepare(`UPDATE rules SET
    name = ?, art = ?, beschreibung = ?, schluesselwoerter = ?, bedingung = ?, beispiel = ?, updated_at = ?
    WHERE id = ?`)
    .run(name, art, beschreibung, JSON.stringify(schluesselwoerter ?? []), bedingung ?? null, beispiel ?? null, new Date().toISOString(), id);
  return getRegel(db, id);
}

export function deleteRegel(db, id) {
  return db.prepare('DELETE FROM rules WHERE id = ?').run(id).changes;
}

/* --------------------------- Klassifizierung --------------------------- */
/* Das (validierte) KI-Ergebnis wird als JSON in documents.klassifizierung
   gespeichert. Der Status spiegelt den Freigabe-Workflow (konzept.md):
     eingang → einzukategorisieren (Vorschlag) → klassifiziert (bestätigt)
     oder → eingang (abgelehnt) / abgelegt. */

export const DOK_STATUS = ['eingang', 'einzukategorisieren', 'klassifiziert', 'abgelegt'];

export function saveKlassifizierung(db, id, ergebnis) {
  db.prepare(`UPDATE documents SET
    status = 'einzukategorisieren', klassifizierung = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(ergebnis), new Date().toISOString(), id);
}

export function bestaetigeKlassifizierung(db, id) {
  db.prepare(`UPDATE documents SET
    status = 'klassifiziert', klassifiziert_am = ?, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), new Date().toISOString(), id);
}

export function ablehneKlassifizierung(db, id) {
  // Zurück in den Eingang, Vorschlag verwerfen (Tags tragen erst nach Bestätigung).
  db.prepare(`UPDATE documents SET
    status = 'eingang', klassifizierung = NULL, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function setzeStatus(db, id, status) {
  if (!DOK_STATUS.includes(status)) throw new Error(`Unbekannter Status: ${status}`);
  db.prepare('UPDATE documents SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
}

/* ------------------------------- Einstellungen -------------------------- */
// Schlüssel/Werte für die App-Konfiguration (z. B. OMLX-URL, OMLX-Schlüssel).
// Leerer Wert löscht den Eintrag — die .env-Werte gelten dann wieder.

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  if (value === null || value === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, value, new Date().toISOString());
}
