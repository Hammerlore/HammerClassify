/* ==========================================================================
   HammerClassify — Scan (P4)
   Verzeichnis-Scan über gepflegte Quellen (konzept.md §Integration):
     'lokal'  — rekursiver Datei-Lauf (z. B. Nextcloud-Datenverzeichnis)
     'rclone' — rclone lsjson --recursive (z. B. onedrive:16 Bank)
   Neue Dateien (SHA-256 nicht in der DB) werden nach DOK_DIR kopiert,
   der Text wird serverseitig extrahiert, das Dokument landet in
   „Eingang" mit Quellbezug. Unveränderte Dateien (Größe+ModTime) werden
   über den scan_seen-Cache nicht erneut heruntergeladen/gehasht.
   Die Dateien an der Quelle bleiben unangetastet (nur Lesen).
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as db from './db.js';
import * as text from './text.js';

export const SCAN_EXT = new Set(['pdf', 'docx', 'doc', 'txt', 'md']);
const MAX_DATEI = 25 * 1024 * 1024; // wie Upload
const MAX_TEXT = 200_000;

// Zustand des laufenden Scans (einer gleichzeitig) — wird per API abgefragt.
export const scanStatus = {
  laufend: false,
  quelle: null,       // Name der Quelle
  gesamt: 0,          // Dateien in der Quelle
  aktuell: 0,         // Fortschritt (0..gesamt)
  neu: 0,
  doppelungen: 0,
  uebersprungen: 0,   // falsche Endung / zu groß / defekt
  fehler: 0,
  datei: null,        // aktueller Dateiname (Anzeige)
  beendet_am: null,
};

/* ----------------------------- Dateilisten ------------------------------ */

function extVon(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

/** Lokaler Pfad rekursiv auflisten → [{ pfad, name, ext, size, modtime }] */
function listeLokal(wurzel) {
  const ergebnis = [];
  const laufe = (dir, tiefen = 0) => {
    if (tiefen > 12) return;
    let eintraege;
    try { eintraege = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      const voll = path.join(dir, e.name);
      if (e.isDirectory()) { laufe(voll, tiefen + 1); continue; }
      if (!e.isFile()) continue;
      const ext = extVon(e.name);
      if (!SCAN_EXT.has(ext)) continue;
      const st = fs.statSync(voll);
      ergebnis.push({
        pfad: path.relative(wurzel, voll), name: e.name, ext,
        size: st.size, modtime: st.mtime.toISOString(), abs: voll,
      });
    }
  };
  laufe(wurzel);
  return ergebnis;
}

/** rclone-Aufruf als JSON (außer --json) oder Text zurückgeben. */
function rcloneLiefere(args, { json = false, timeoutMs = 120_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('rclone', args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let tot = false;
    const timer = setTimeout(() => { tot = true; p.kill('SIGKILL'); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    if (input) p.stdin.end(input);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (tot) return reject(new Error('rclone-Timeout'));
      if (code !== 0) return reject(new Error(`rclone Exit ${code}: ${err.slice(0, 200)}`));
      resolve(json ? JSON.parse(out) : out);
    });
  });
}

/** rclone-Pfad rekursiv auflisten → [{ pfad, name, ext, size, modtime }] */
async function listeRclone(pfad) {
  const liste = await rcloneLiefere([
    'lsjson', pfad, '--recursive', '--json',
  ], { json: true, timeoutMs: 300_000 });
  const ergebnis = [];
  for (const e of liste) {
    if (e.IsDir) continue;
    const ext = extVon(e.Name);
    if (!SCAN_EXT.has(ext)) continue;
    ergebnis.push({
      pfad: e.Path, name: e.Name, ext,
      size: e.Size ?? 0, modtime: e.ModTime ?? new Date(0).toISOString(),
    });
  }
  return ergebnis;
}

/* ------------------------------ Datei holen ----------------------------- */

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Datei(pfad) {
  const h = crypto.createHash('sha256');
  const st = fs.statSync(pfad);
  const chunk = 1024 * 1024;
  let pos = 0;
  const fd = fs.openSync(pfad, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.min(chunk, st.size));
    while (pos < st.size) {
      const n = fs.readSync(fd, buf, 0, Math.min(chunk, st.size - pos), pos);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      pos += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

// rclone cat → Buffer (im Speichertmp, damit der RAM bei großen Scans bleibt)
async function rcloneLese(pfad, tmpDir) {
  const ziel = path.join(tmpDir, `dl-${crypto.randomBytes(6).toString('hex')}`);
  await new Promise((resolve, reject) => {
    const p = spawn('rclone', ['cat', pfad], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(ziel);
    const err = [];
    p.stdout.pipe(out);
    p.stderr.on('data', (d) => err.push(d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 300_000);
    out.on('finish', () => { clearTimeout(timer); resolve(); });
    out.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      if (code !== 0) { clearTimeout(timer); reject(new Error(`rclone cat Exit ${code}: ${err.join('').slice(0, 120)}`)); }
    });
  });
  return ziel;
}

/* ------------------------------ Text extrahieren ------------------------ */

async function gewinneText(ext, buffer, tmpDir) {
  try {
    if (ext === 'docx') return text.extractDocxText(buffer);
    if (ext === 'zip') return text.extractZipText(buffer);
    if (ext === 'pdf') return await text.extractPdfText(buffer);
    if (ext === 'doc') return await text.extractDocText(buffer, tmpDir);
    if (ext === 'txt' || ext === 'md') {
      // Null-Bytes = binärer Inhalt, keine Textdatei (wie beim Upload)
      if (buffer.includes(0)) return '';
      return buffer.toString('utf8');
    }
  } catch {
    return ''; // defekte Datei → „kein_text" → manuell
  }
  return '';
}

/* ------------------------------- Der Scan ------------------------------- */

/**
 * Eine Quelle scannen (synchron, im Hintergrund). Aktualisiert scanStatus.
 * @returns true, wenn die Quelle gescannt wurde (auch mit Einzel-Fehlern)
 */
export async function scanneQuelle(dbh, config, source) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-scan-'));
  let dateien = [];
  try {
    dateien = source.typ === 'rclone'
      ? await listeRclone(source.pfad)
      : listeLokal(source.pfad);
  } catch (e) {
    // Quelle nicht erreichbar (Remote offline, Pfad fehlt, Rechte) —
    // sauber melden, der Rest der App läuft weiter.
    scanStatus.fehler += 1;
    scanStatus.datei = `${source.pfad} — ${e.message}`;
    return false;
  } finally {
    // tmp-Dateien aufräumen, die nicht mehr gebraucht werden
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith('dl-')) fs.rmSync(path.join(tmpDir, f), { force: true });
    }
  }

  db.setzeLetzterScan(dbh, source.id, new Date().toISOString());
  scanStatus.gesamt = dateien.length;
  scanStatus.aktuell = 0;

  for (const f of dateien) {
    scanStatus.aktuell++;
    scanStatus.datei = f.pfad;

    // Dedup-Cache: unverändert (Größe + ModTime) → SHA aus dem Cache
    const gesehen = db.seenGet(dbh, source.id, f.pfad);
    let sha = null;
    if (gesehen && gesehen.size === f.size && gesehen.modtime === f.modtime) {
      sha = gesehen.sha256;
    }

    // Zu groß (aus der Liste bekannt) → überspringen, nicht laden
    if (f.size > MAX_DATEI) {
      scanStatus.uebersprungen++;
      continue;
    }

    let buffer = null;
    let tmpDatei = null;
    if (!sha) {
      try {
        if (source.typ === 'rclone') {
          tmpDatei = await rcloneLese(path.join(source.pfad, f.pfad), tmpDir);
          buffer = fs.readFileSync(tmpDatei);
        } else {
          buffer = fs.readFileSync(f.abs);
        }
        sha = sha256Buffer(buffer);
        db.seenUpsert(dbh, { sourceId: source.id, pfad: f.pfad, size: f.size, modtime: f.modtime, sha256: sha });
      } catch (e) {
        scanStatus.fehler++;
        console.error(`Scan: ${source.name} — ${f.pfad}: ${e.message}`);
        continue;
      }
    }

    if (db.findDocumentBySha(dbh, sha)) {
      scanStatus.doppelungen++;
      if (buffer) buffer = null;
      if (tmpDatei) fs.rmSync(tmpDatei, { force: true });
      continue;
    }

    // Neu: Datei übernehmen, Text gewinnen, Dokument anlegen.
    // Buffer aus dem Hashing-Durchlauf wiederverwenden; nur nachladen,
    // wenn das SHA aus dem Cache kam (Datei unverändert, nicht geladen).
    let inhalt = buffer;
    buffer = null;
    if (tmpDatei) { fs.rmSync(tmpDatei, { force: true }); tmpDatei = null; }
    try {
      if (!inhalt) {
        if (source.typ === 'rclone') {
          tmpDatei = await rcloneLese(path.join(source.pfad, f.pfad), tmpDir);
          inhalt = fs.readFileSync(tmpDatei);
        } else {
          inhalt = fs.readFileSync(f.abs);
        }
      }
      if (inhalt.length > MAX_DATEI) {
        scanStatus.uebersprungen++;
        inhalt = null;
        if (tmpDatei) fs.rmSync(tmpDatei, { force: true });
        continue;
      }
      const textInhalt = (await gewinneText(f.ext, inhalt, tmpDir)).slice(0, MAX_TEXT);
      const ziel = path.join(config.dokDir, `${sha.slice(0, 16)}.${f.ext}`);
      fs.mkdirSync(config.dokDir, { recursive: true });
      if (tmpDatei) { fs.renameSync(tmpDatei, ziel); fs.chmodSync(ziel, 0o600); }
      else { fs.copyFileSync(f.abs, ziel); fs.chmodSync(ziel, 0o600); }
      db.addDocument(dbh, {
        name: f.name, ext: f.ext, mime: MIME[f.ext] ?? 'application/octet-stream',
        size: inhalt.length, sha256: sha,
        text: textInhalt || null, textStatus: textInhalt ? 'ok' : 'kein_text',
        sourceId: source.id, quellpfad: f.pfad,
      });
      scanStatus.neu++;
    } catch (e) {
      scanStatus.fehler++;
      console.error(`Scan: ${source.name} — ${f.pfad}: ${e.message}`);
      if (tmpDatei) fs.rmSync(tmpDatei, { force: true });
    }
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return true;
}

// MIME-Tabelle (wie server.js)
const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  txt: 'text/plain',
  md: 'text/markdown',
};

/**
 * Scan starten: eine Quelle oder alle aktiven. Läuft asynchron im
 * Hintergrund; Fortschritt über scanStatus.
 * @returns {string|null} Fehlermeldung, wenn nicht gestartet werden kann
 */
export function starteScan(dbh, config, { sourceId = null } = {}) {
  if (scanStatus.laufend) return 'Ein Scan läuft bereits — bitte warten.';
  const quellen = sourceId
    ? [db.getSource(dbh, sourceId)].filter(Boolean)
    : db.listSources(dbh).filter((s) => s.aktiv);
  if (!quellen.length) return 'Keine Quelle gefunden.';

  Object.assign(scanStatus, {
    laufend: true, quelle: quellen.length === 1 ? quellen[0].name : 'Alle Quellen',
    gesamt: 0, aktuell: 0, neu: 0, doppelungen: 0, uebersprungen: 0, fehler: 0,
    datei: null, beendet_am: null,
  });

  (async () => {
    try {
      for (const q of quellen) {
        const vor = scanStatus.gesamt;
        await scanneQuelle(dbh, config, q);
        if (quellen.length > 1) scanStatus.quelle = q.name;
      }
    } finally {
      scanStatus.laufend = false;
      scanStatus.beendet_am = new Date().toISOString();
    }
  })();

  return null;
}
