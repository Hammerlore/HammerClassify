/* ==========================================================================
   HammerClassify — P4-Tests (node:test)
   - DB: Migration 6 (sources, scan_seen, documents: source_id/quellpfad/
     halte_bis), Quellen-CRUD, Dedup-Cache, Aufbewahrung (Offener Punkt 6)
   - text: serverseitige PDF-Extraktion (pdfjs), .doc ohne LibreOffice
   - Server: Quellen-CRUD, lokaler Scan (neu/doppelung/zu groß, Rescan,
     Änderung), rclone-Scan (sauberer Fehler), CSV-Export, halte_bis beim
     Klassifizieren (Fake-OMLX)
   ========================================================================== */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import JSZip from 'jszip';

import {
  openDb, createNutzer, addRegel, setSetting, getSetting,
  listSources, addSource, updateSource, deleteSource, setzeLetzterScan,
  seenGet, seenUpsert, halteBisFuer, SCHEMA_STAND,
} from '../src/db.js';
import * as auth from '../src/auth.js';
import { createApp } from '../src/server.js';
import { extractPdfText, extractDocText, sofficePfad } from '../src/text.js';
import * as scan from '../src/scan.js';
import { OMLX_MODELL } from '../src/omlx.js';

/* ------------------- Fake-Authenticator (wie p1/p2/p3) ------------------ */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function coseKeyFromJwk(jwk) {
  const key = new Map();
  key.set(1, 2);
  key.set(3, -7);
  key.set(-1, 1);
  key.set(-2, new Uint8Array(Buffer.from(jwk.x, 'base64url')));
  key.set(-3, new Uint8Array(Buffer.from(jwk.y, 'base64url')));
  return key;
}

function makeAuthPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { publicKey, privateKey, jwk: publicKey.export({ format: 'jwk' }) };
}

function clientDataJSON(type, challengeB64url, origin) {
  return Buffer.from(JSON.stringify({ type, challenge: challengeB64url, origin, crossOrigin: false }));
}

function fakeRegistrationResponse({ rpId, origin, challengeB64url, credId, pair, aaguid }) {
  const rpIdHash = sha256(Buffer.from(rpId, 'ascii'));
  const credIdBuf = Buffer.from(credId);
  const authData = Buffer.concat([
    rpIdHash,
    Buffer.from([0x45]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from(aaguid, 'hex'),
    Buffer.from([(credIdBuf.length >> 8) & 0xff, credIdBuf.length & 0xff]),
    credIdBuf,
    Buffer.from(encodeCBOR(coseKeyFromJwk(pair.jwk))),
  ]);
  const attestationObject = Buffer.from(
    encodeCBOR(new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', new Uint8Array(authData)],
    ]))
  );
  return {
    id: b64url(credIdBuf),
    rawId: b64url(credIdBuf),
    type: 'public-key',
    response: {
      clientDataJSON: b64url(clientDataJSON('webauthn.create', challengeB64url, origin)),
      attestationObject: b64url(attestationObject),
    },
  };
}

function fakeAuthenticationResponse({ rpId, origin, challengeB64url, credId, pair, signCount }) {
  const rpIdHash = sha256(Buffer.from(rpId, 'ascii'));
  const authData = Buffer.concat([rpIdHash, Buffer.from([0x05]), Buffer.from([0, 0, 0, signCount])]);
  const cd = clientDataJSON('webauthn.get', challengeB64url, origin);
  const sig = crypto.createSign('sha256').update(Buffer.concat([authData, sha256(cd)])).sign(pair.privateKey);
  return {
    id: b64url(Buffer.from(credId)),
    rawId: b64url(Buffer.from(credId)),
    type: 'public-key',
    response: {
      clientDataJSON: b64url(cd),
      authenticatorData: b64url(authData),
      signature: b64url(sig),
      userHandle: null,
    },
  };
}

/** Registrierung (falls nötig) + Login → Session-Token */
async function login(config) {
  const uid = config.db.prepare('SELECT * FROM users LIMIT 1').get()?.id ?? createNutzer(config.db, 'Micha');
  if (!config.db.prepare('SELECT * FROM passkeys LIMIT 1').get()) {
    const pair = makeAuthPair();
    const credId = crypto.randomBytes(16);
    const regOpts = await auth.registrationOptions({ config, setupToken: config.setupToken });
    const reg = await auth.finishRegistration({
      config,
      expectedOptions: regOpts.options,
      response: fakeRegistrationResponse({ rpId: config.rpId, origin: config.origin, challengeB64url: regOpts.options.challenge, credId, pair, aaguid: crypto.randomBytes(16).toString('hex') }),
    });
    assert.ok(reg.ok, 'Registrierung muss funktionieren');
    config.__credId = credId;
    config.__pair = pair;
  }
  config.__count = (config.__count ?? 0) + 1;
  const authOpts = await auth.authenticationOptions({ config });
  assert.ok(authOpts.allowed);
  const login = await auth.finishAuthentication({
    config,
    expectedOptions: authOpts.options,
    response: fakeAuthenticationResponse({ rpId: config.rpId, origin: config.origin, challengeB64url: authOpts.options.challenge, credId: config.__credId, pair: config.__pair, signCount: config.__count }),
  });
  assert.ok(login.ok, `Login muss funktionieren (${login.fehler ?? ''})`);
  return login.token;
}

/* ---------------------------- Fake-OMLX --------------------------------- */

const OMLX_KEY = 'omlx-p4-key-1234';

function startFakeOmlx() {
  const state = { completions: 0, status: 200, inhalt: null };
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== `Bearer ${OMLX_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: OMLX_MODELL }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      req.on('data', () => {});
      req.on('end', () => {
        state.completions++;
        if (req.headers.authorization !== `Bearer ${OMLX_KEY}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        res.writeHead(state.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: state.inhalt ?? '{}' } }] }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, state }));
  });
}

/* ------------------------------- Fixtures ------------------------------ */

const VOLLTEXT = [
  'E.ON Energie Deutschland GmbH',
  'Rechnung Strom Q3 2026',
  'Gesamtbetrag: 84,12 €',
  'Fällig bis: 31.10.2026',
  'An: Micha Hammer, Hammerweg 1, 12345 Ort',
].join('\n');

const GUELTIG = {
  dokumenttyp: { name: 'Rechnung', konfidenz: 0.95 },
  kategorien: [
    { name: 'Strom', konfidenz: 0.9, stellen: ['Rechnung Strom Q3 2026'] },
    { name: 'Eigenes', konfidenz: 0.8, stellen: ['An: Micha Hammer'] },
  ],
  absender: 'E.ON Energie Deutschland GmbH',
  datum: '2026-10-31',
  betraege: [{ art: 'brutto', wert_cents: 8412 }],
  beleg_erforderlich: true,
  kern: 'Stromrechnung Q3 2026',
  vertrauen_gesamt: 0.85,
};

const fakePdf = Buffer.concat([
  Buffer.from('%PDF-1.7\n%âãÏÓ\n'),
  Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n'),
  Buffer.from('trailer\n<< /Root 1 0 R >>\nendobj\n%%EOF\n'),
]);

async function makeDocx() {
  const docxXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:t>E.ON Energie Deutschland GmbH</w:t></w:r></w:p>
    <w:p><w:r><w:t>Rechnung Strom Q3 2026</w:t></w:r></w:p>
    <w:p><w:r><w:t>Gesamtbetrag: 84,12 €</w:t></w:r></w:p>
  </w:body></w:document>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', docxXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/* -------------------------------- Setup --------------------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hammerclassify-p4-'));
let db, config, app, server, base, token, fakeOmlx;

before(async () => {
  db = openDb(tmp);
  config = {
    port: 0,
    host: '127.0.0.1',
    rpId: 'localhost',
    rpName: 'HammerClassify',
    setupToken: 'test-token-1234567890-xyz',
    sessionDays: 30,
    dataDir: tmp,
    dokDir: path.join(tmp, 'dokumente'),
    omlxUrl: undefined,
    omlxKey: undefined,
    origin: 'http://localhost:3018',
    db,
  };
  app = createApp(config);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = await login(config);
  fakeOmlx = await startFakeOmlx();
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
  fakeOmlx?.server?.closeAllConnections?.();
  fakeOmlx?.server?.close();
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const headers = () => ({ cookie: `sid=${token}` });
const json = { 'content-type': 'application/json' };

const upload = (name, buf, type, extra = {}) => {
  const fd = new FormData();
  fd.append('datei', new Blob([buf], { type }), name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fetch(`${base}/api/documents`, { method: 'POST', headers: headers(), body: fd });
};

/** Auf den Scan-Ende-Zustand warten (laufend → false). */
async function warteScan(timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    const s = (await (await fetch(`${base}/api/scan/status`, { headers: headers() })).json()).status;
    if (!s.laufend) return s;
    if (Date.now() - start > timeoutMs) throw new Error('Scan-Timeout');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* ---------------------------------- DB ----------------------------------- */

test('DB: Migration 6 — sources + scan_seen + documents-Spalten', () => {
  assert.equal(SCHEMA_STAND, 6);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 6);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sources'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'scan_seen'").get());
  const spalten = db.prepare('PRAGMA table_info(documents)').all().map((s) => s.name);
  assert.ok(spalten.includes('source_id'));
  assert.ok(spalten.includes('quellpfad'));
  assert.ok(spalten.includes('halte_bis'));
});

test('DB: Quellen-CRUD + Zähler', () => {
  const q = addSource(db, { name: 'Post', typ: 'lokal', pfad: '/tmp/post' });
  assert.ok(q.id);
  assert.equal(q.aktiv, 1);
  // Zähler kommen aus listSources (Subqueries), nicht aus getSource
  const inListe = listSources(db).find((s) => s.id === q.id);
  assert.equal(inListe.neu, 0);
  assert.equal(inListe.gesamt, 0);

  updateSource(db, q.id, { name: 'Post 2', aktiv: 0 });
  const q2 = db.prepare('SELECT * FROM sources WHERE id = ?').get(q.id);
  assert.equal(q2.name, 'Post 2');
  assert.equal(q2.aktiv, 0);

  setzeLetzterScan(db, q.id, '2026-11-13T10:00:00.000Z');
  assert.equal(db.prepare('SELECT * FROM sources WHERE id = ?').get(q.id).letzte_scan, '2026-11-13T10:00:00.000Z');

  assert.ok(listSources(db).some((s) => s.id === q.id));
  assert.equal(deleteSource(db, q.id), 1);
  assert.ok(!listSources(db).some((s) => s.id === q.id));
});

test('DB: scan_seen — Dedup-Cache (upsert)', () => {
  const q = addSource(db, { name: 'seen-test', typ: 'lokal', pfad: '/tmp/seen' });
  assert.equal(seenGet(db, q.id, 'a.txt'), undefined);
  seenUpsert(db, { sourceId: q.id, pfad: 'a.txt', size: 10, modtime: 't1', sha256: 's1' });
  assert.equal(seenGet(db, q.id, 'a.txt').sha256, 's1');
  // Gleiches Pfad, neue Größe/ModTime → aktualisiert
  seenUpsert(db, { sourceId: q.id, pfad: 'a.txt', size: 11, modtime: 't2', sha256: 's2' });
  const e = seenGet(db, q.id, 'a.txt');
  assert.equal(e.size, 11);
  assert.equal(e.modtime, 't2');
  assert.equal(e.sha256, 's2');
  deleteSource(db, q.id); // scan_seen-Zeilen via ON DELETE CASCADE weg
  assert.equal(seenGet(db, q.id, 'a.txt'), undefined);
});

test('DB: halteBisFuer — Offener Punkt 6 (10 Jahre)', () => {
  assert.equal(halteBisFuer(db, 'Rechnung'), null, 'ohne Einstellung → keine Haltepflicht');
  setSetting(db, 'halte_typen', 'Rechnung, Vertrag');
  const jahr = new Date().getFullYear() + 10;
  assert.equal(halteBisFuer(db, 'Rechnung'), jahr);
  assert.equal(halteBisFuer(db, 'rechnung'), jahr, 'Groß-/Kleinschreibung egal');
  assert.equal(halteBisFuer(db, 'Angebot'), null);
  assert.equal(halteBisFuer(db, null), null);
  setSetting(db, 'halte_typen', null);
  assert.equal(halteBisFuer(db, 'Rechnung'), null);
});

/* ------------------------------- text.js -------------------------------- */

test('text: extractPdfText — PDF ohne Seiten → leer, wirft nicht', async () => {
  assert.equal(await extractPdfText(fakePdf), '');
});

test('text: extractDocText — ohne LibreOffice → leer', async () => {
  if (sofficePfad() === null) {
    assert.equal(await extractDocText(Buffer.from('doc'), tmp), '');
  } else {
    // mit LibreOffice: defekte .doc → ebenfalls leer (kein Crash)
    assert.equal(typeof await extractDocText(Buffer.from('doc'), tmp), 'string');
  }
});

/* ------------------------------- Server --------------------------------- */

test('Server: /api/sources ohne Session → 401', async () => {
  const r = await fetch(`${base}/api/sources`);
  assert.equal(r.status, 401);
});

test('Server: /api/scan ohne Quellen → 409', async () => {
  const r = await fetch(`${base}/api/scan`, { method: 'POST', headers: { ...headers(), ...json }, body: '{}' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).fehler, /Keine Quelle/);
});

test('Server: Quellen-CRUD (Validierung, Duplikat, Update, Delete)', async () => {
  // ungültige Eingaben
  let r = await fetch(`${base}/api/sources`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ name: 'X', typ: 'ftp', pfad: '/x' }) });
  assert.equal(r.status, 400);
  r = await fetch(`${base}/api/sources`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ name: 'X', typ: 'lokal', pfad: 'relativ/pfad' }) });
  assert.equal(r.status, 400, 'lokaler Pfad muss absolut sein');
  r = await fetch(`${base}/api/sources`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ name: 'X', typ: 'lokal', pfad: '/a/../b' }) });
  assert.equal(r.status, 400, 'keine ..');
  r = await fetch(`${base}/api/sources`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ name: 'X', typ: 'rclone', pfad: '/lokal/ohne-remote' }) });
  assert.equal(r.status, 400, 'rclone braucht remote:pfad');

  // gültig
  r = await fetch(`${base}/api/sources`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ name: 'Test-Quelle', typ: 'lokal', pfad: '/tmp/test-quelle' }) });
  assert.equal(r.status, 201);
  const id = (await r.json()).quelle.id;

  // Duplikat (Name UNIQUE)
  r = await fetch(`${base}/api/sources`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ name: 'Test-Quelle', typ: 'lokal', pfad: '/tmp/andere' }) });
  assert.equal(r.status, 409);

  // Update
  r = await fetch(`${base}/api/sources/${id}`, { method: 'PUT', headers: { ...headers(), ...json }, body: JSON.stringify({ name: 'Test-Quelle 2', aktiv: false }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).quelle.aktiv, 0);

  // Delete
  r = await fetch(`${base}/api/sources/${id}`, { method: 'DELETE', headers: headers() });
  assert.equal(r.status, 200);
  r = await fetch(`${base}/api/sources/${id}`, { method: 'DELETE', headers: headers() });
  assert.equal(r.status, 404);
});

test('Server: /api/halte — GET/PUT', async () => {
  let r = await fetch(`${base}/api/halte`, { headers: headers() });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).typen, []);

  r = await fetch(`${base}/api/halte`, { method: 'PUT', headers: { ...headers(), ...json }, body: JSON.stringify({ typen: ' Rechnung , Vertrag ' }) });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).typen, ['Rechnung', 'Vertrag']);

  r = await fetch(`${base}/api/halte`, { method: 'PUT', headers: { ...headers(), ...json }, body: JSON.stringify({ typen: '' }) });
  assert.deepEqual((await r.json()).typen, []);

  r = await fetch(`${base}/api/halte`, { method: 'PUT', headers: { ...headers(), ...json }, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
});

/* ------------------------------ Scan: lokal ----------------------------- */

let scanSrc, scanQuelleId, docxBuffer;

before(async () => {
  scanSrc = path.join(tmp, 'scan-src');
  fs.mkdirSync(path.join(scanSrc, 'Unterordner'), { recursive: true });
  fs.writeFileSync(path.join(scanSrc, 'a.txt'), VOLLTEXT, { mode: 0o600 });
  docxBuffer = await makeDocx();
  fs.writeFileSync(path.join(scanSrc, 'b.docx'), docxBuffer, { mode: 0o600 });
  fs.writeFileSync(path.join(scanSrc, 'c.pdf'), fakePdf, { mode: 0o600 });
  fs.writeFileSync(path.join(scanSrc, 'Unterordner', 'd.jpg'), Buffer.from('jpg'), { mode: 0o600 });
  // Sparse-Datei > 25 MB (nur Metadaten auf der Platte)
  const fd = fs.openSync(path.join(scanSrc, 'big.txt'), 'w');
  fs.ftruncateSync(fd, 26 * 1024 * 1024);
  fs.closeSync(fd);
});

test('Server: Scan lokaler Quelle — neue Dateien', async () => {
  const r = await fetch(`${base}/api/sources`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ name: 'Scan-Ordner', typ: 'lokal', pfad: scanSrc }) });
  assert.equal(r.status, 201);
  scanQuelleId = (await r.json()).quelle.id;

  const s = await (await fetch(`${base}/api/scan`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ sourceId: scanQuelleId }) })).json();
  assert.ok(s.gestartet);

  const status = await warteScan();
  assert.equal(status.gesamt, 4, 'jpg wird ignoriert, big.txt gezählt');
  assert.equal(status.neu, 3);
  assert.equal(status.doppelungen, 0);
  assert.equal(status.uebersprungen, 1, 'big.txt > 25 MB');
  assert.equal(status.fehler, 0);
  assert.equal(status.laufend, false);

  // Quelle: letzter Scan + Zähler
  const q = (await (await fetch(`${base}/api/sources`, { headers: headers() })).json()).quellen.find((x) => x.id === scanQuelleId);
  assert.ok(q.letzte_scan);
  assert.equal(q.neu, 3);
  assert.equal(q.gesamt, 3);

  // Dokumente: Quellbezug + Text
  const liste = (await (await fetch(`${base}/api/documents`, { headers: headers() })).json()).dokumente;
  assert.equal(liste.length, 3);
  assert.ok(liste.every((d) => d.source_id === scanQuelleId));
  const a = liste.find((d) => d.name === 'a.txt');
  assert.equal(a.quellpfad, 'a.txt');
  assert.equal(a.text_status, 'ok');
  assert.match(a.text_vorschau, /E\.ON/);
  const b = liste.find((d) => d.name === 'b.docx');
  assert.equal(b.quellpfad, 'b.docx');
  assert.equal(b.text_status, 'ok');
  assert.match(b.text_vorschau, /Rechnung Strom Q3 2026/);
  const c = liste.find((d) => d.name === 'c.pdf');
  assert.equal(c.quellpfad, 'c.pdf');
  assert.equal(c.text_status, 'kein_text', 'PDF ohne Seiten → kein Text');

  // Datei wurde nach DOK_DIR kopiert, Original bleibt an Ort und Stelle
  assert.ok(fs.existsSync(path.join(config.dokDir, `${a.sha256.slice(0, 16)}.txt`)));
  assert.ok(fs.existsSync(path.join(scanSrc, 'a.txt')));
});

test('Server: Scan erneut — alles bekannt, kein Duplikat', async () => {
  await fetch(`${base}/api/scan`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ sourceId: scanQuelleId }) });
  const status = await warteScan();
  assert.equal(status.neu, 0);
  assert.equal(status.doppelungen, 3);
  assert.equal(status.uebersprungen, 1);
  assert.equal(status.fehler, 0);
  const liste = (await (await fetch(`${base}/api/documents`, { headers: headers() })).json()).dokumente;
  assert.equal(liste.length, 3, 'keine neuen Dokumente');
});

test('Server: geänderte Datei → neues Dokument', async () => {
  fs.writeFileSync(path.join(scanSrc, 'a.txt'), VOLLTEXT + '\nNachtrag: Zins 2,50 €\n');
  await fetch(`${base}/api/scan`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ sourceId: scanQuelleId }) });
  const status = await warteScan();
  assert.equal(status.neu, 1);
  assert.equal(status.doppelungen, 2);
  const liste = (await (await fetch(`${base}/api/documents`, { headers: headers() })).json()).dokumente;
  assert.equal(liste.length, 4);
  const a2 = liste.find((d) => d.name === 'a.txt' && d.text_vorschau.includes('Nachtrag'));
  assert.ok(a2, 'geänderte Version als neues Dokument');
  assert.notEqual(a2.sha256, liste.find((d) => d.name === 'a.txt' && !d.text_vorschau.includes('Nachtrag')).sha256);
});

/* ----------------------------- Scan: rclone ----------------------------- */

test('Server: Scan rclone-Quelle (Remote nicht erreichbar) → sauberer Fehler', async () => {
  const r = await fetch(`${base}/api/sources`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ name: 'Rclone-Test', typ: 'rclone', pfad: 'noremote:xyz' }) });
  assert.equal(r.status, 201);
  const id = (await r.json()).quelle.id;

  await fetch(`${base}/api/scan`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ sourceId: id }) });
  const status = await warteScan();
  assert.equal(status.laufend, false);
  assert.equal(status.gesamt, 0);
  assert.equal(status.fehler, 1, 'Remote fehlt → ein Fehler, kein Crash');
  assert.equal(status.neu, 0);

  // während eines Scans: zweiter Scan → 409 (Guard deterministisch prüfen)
  scan.scanStatus.laufend = true;
  const conflict = await fetch(`${base}/api/scan`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify({ sourceId: id }) });
  assert.equal(conflict.status, 409, 'kein zweiter Scan neben einem laufenden');
  scan.scanStatus.laufend = false;
});

/* ------------------------------ CSV-Export ------------------------------ */

test('Server: CSV-Export — BOM, Header, Quellbezug, Umlaute', async () => {
  const r = await fetch(`${base}/api/documents/export.csv`, { headers: headers() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8-BOM für Excel');
  const csv = bytes.toString('utf8').replace(/^\uFEFF/, '');
  assert.match(csv, /Datei;Typ;Größe;Status;Dokumenttyp;Kategorien;Absender;Datum;Betrag;Quelle;Quellpfad;Aufbewahren bis;SHA-256;Erstellt/);
  assert.match(csv, /a\.txt;txt;/);
  assert.match(csv, /Scan-Ordner;/, 'Quellen-Name');
  assert.match(csv, /Unterordner|a\.txt/, 'Quellpfad');
  assert.match(csv, /Größe/, 'Umlaute im Header intakt');
});

test('Server: CSV-Export ohne Session → 401', async () => {
  const r = await fetch(`${base}/api/documents/export.csv`);
  assert.equal(r.status, 401);
});

/* ------------------- halte_bis beim Klassifizieren ---------------------- */

test('Server: halte_bis wird beim Klassifizieren gesetzt (Offener Punkt 6)', async () => {
  // Regeln + Inhaber + OMLX + Haltepflicht einrichten
  addRegel(db, { name: 'Strom', art: 'kategorie', beschreibung: 'Alles zu Strom', schluesselwoerter: ['strom'], bedingung: null, beispiel: null });
  addRegel(db, { name: 'Eigenes', art: 'kategorie', beschreibung: 'Nur eigene Dokumente', schluesselwoerter: [], bedingung: 'eigener_name_adresse', beispiel: null });
  addRegel(db, { name: 'Rechnung', art: 'dokumenttyp', beschreibung: 'Eine Rechnung', schluesselwoerter: ['rechnung'], bedingung: null, beispiel: null });
  setSetting(db, 'inhauber_profil', JSON.stringify({ name: 'Micha Hammer', adresse: 'Hammerweg 1, 12345 Ort', kundennummer: 'K-123' }));
  setSetting(db, 'omlx_url', fakeOmlx.url);
  setSetting(db, 'omlx_key', OMLX_KEY);
  setSetting(db, 'halte_typen', 'Rechnung');
  fakeOmlx.state.inhalt = JSON.stringify(GUELTIG);

  const u = await upload('rechnung.txt', Buffer.from(VOLLTEXT + '\nKundennummer: K-123'), 'text/plain');
  assert.equal(u.status, 201);
  const dok = (await u.json());
  assert.equal(dok.halte_bis, null, 'vor der Klassifizierung: keine Haltepflicht');

  const r = await (await fetch(`${base}/api/documents/${dok.id}/klassifizieren`, { method: 'POST', headers: headers() })).json();
  assert.equal(r.dokument.status, 'einzukategorisieren', 'Vorschlag gespeichert');
  assert.equal(r.dokument.halte_bis, new Date().getFullYear() + 10, 'Beleg-Charakter → 10 Jahre');

  // aufräumen, damit andere Tests sauber bleiben
  setSetting(db, 'omlx_url', null);
  setSetting(db, 'omlx_key', null);
  setSetting(db, 'halte_typen', null);
});
