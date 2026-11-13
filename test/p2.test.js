/* ==========================================================================
   HammerClassify — P2-Tests (node:test)
   - text.js: docx/zip-Textgewinnung, XML-Entities
   - DB: documents-Tabelle (Migration 2)
   - Server: Upload (Auth, Validierung, Magic-Bytes, Dedup, Speicherung 600),
     Liste, Detail, Download, Löschen, pdf.js-Vendor, KI-Status
   ========================================================================== */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import JSZip from 'jszip';

import { openDb, createNutzer, addPasskey, findDocumentBySha, getDocument, SCHEMA_STAND } from '../src/db.js';
import * as auth from '../src/auth.js';
import { createApp } from '../src/server.js';
import { extractDocxText, extractZipText, extractFromDocumentXml, decodeXmlEntities, validateZip } from '../src/text.js';

/* ------------------- Fake-Authenticator (wie p1.test.js) ---------------- */

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

/* ------------------------------- Fixtures ------------------------------ */

const para = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const felder = Array.from({ length: 15 }, (_, i) => para(`Position ${i + 1}: Grundgebühr 36,00 €`)).join('');
const docxXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${para('E.ON Energie Deutschland GmbH')}
    ${para('Rechnung &amp; Abrechnung: Strom Q3 2026')}
    <w:p><w:r><w:t>Gesamtbetrag: 84,12 €</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>Fällig bis: 31.10.2026</w:t></w:r></w:p>
    ${felder}
  </w:body>
</w:document>`;

async function makeDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', docxXml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const fakePdf = Buffer.concat([
  Buffer.from('%PDF-1.7\n%âãÏÓ\n'),
  Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n'),
  Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n'),
]);

/* -------------------------------- Setup --------------------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hammerclassify-p2-'));
let db, config, app, server, base, token;

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
});

after(() => {
  // Keep-Alive-Sockets (undici) zerstören, sonst hält der Server die Datei offen
  server?.closeAllConnections?.();
  server?.close();
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Funktion: token wird erst in before() gesetzt, der String wäre zu früh fixiert
const headers = () => ({ cookie: `sid=${token}` });
const upload = (name, buf, type, extra = {}) => {
  const fd = new FormData();
  fd.append('datei', new Blob([buf], { type }), name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fetch(`${base}/api/documents`, { method: 'POST', headers: headers(), body: fd });
};

/* ------------------------------ text.js -------------------------------- */

test('text: docx → Volltext (Absätze, Entities, Umbrüche)', async () => {
  const text = await extractDocxText(await makeDocx());
  assert.match(text, /E\.ON Energie Deutschland GmbH/);
  assert.match(text, /Rechnung & Abrechnung: Strom Q3 2026/); // &amp; entschlüsselt
  assert.match(text, /84,12 €/);
  assert.match(text, /Fällig bis: 31\.10\.2026/);
  assert.ok(text.split('\n').length >= 3, 'drei Absätze → mindestens drei Zeilen');
});

test('text: XML-Entities (numerisch + benannt)', () => {
  assert.equal(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;„“&quot; &#8364; &#x20AC;'), 'a & b <c> "„“" € €');
});

test('text: <w:pPr> wird nicht als Absatz gezählt', () => {
  const xml = '<w:body><w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:t>Einzig</w:t></w:r></w:p></w:body>';
  assert.equal(extractFromDocumentXml(xml), 'Einzig');
});

test('text: zip mit docx → Text; zip ohne docx → leer', async () => {
  const innere = await makeDocx();
  const zip = new JSZip();
  zip.file('Dokumente/vertrag.docx', innere);
  zip.file('README.txt', 'kein Dokument');
  const mit = await extractZipText(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.match(mit, /E\.ON/);

  const leer = new JSZip();
  leer.file('README.txt', 'nur Text');
  assert.equal(await extractZipText(await leer.generateAsync({ type: 'nodebuffer' })), '');
});

test('text: defektes Zip → validateZip meldet Fehler', async () => {
  const fehler = await validateZip(Buffer.from('kein zip, nur text'));
  assert.match(fehler, /Zip-Archiv/);
});

/* --------------------------------- DB ----------------------------------- */

test('DB: Migration 2 legt documents-Tabelle an', () => {
  assert.equal(SCHEMA_STAND, 6);
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  assert.equal(v, 6);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'documents'").get());
});

/* ------------------------------- Server --------------------------------- */

test('Server: Dokumenten-Endpunkte ohne Session → 401', async () => {
  for (const [method, url] of [
    ['GET', `${base}/api/documents`],
    ['GET', `${base}/api/documents/1`],
    ['GET', `${base}/api/ki/status`],
  ]) {
    const r = await fetch(url, { method });
    assert.equal(r.status, 401, `${method} ${url}`);
  }
  const r = await fetch(`${base}/api/documents`, { method: 'POST', body: new FormData() });
  assert.equal(r.status, 401);
});

test('Server: docx-Upload → 201, Text, Datei 600, Duplikat erkannt', async () => {
  const buf = await makeDocx();

  const r1 = await upload('Stromabrechnung Q3 2026.docx', buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(r1.status, 201);
  const d1 = await r1.json();
  assert.equal(d1.name, 'Stromabrechnung Q3 2026.docx');
  assert.equal(d1.ext, 'docx');
  assert.equal(d1.status, 'eingang');
  assert.equal(d1.text_status, 'ok');
  assert.ok(d1.text_zeichen > 50);
  assert.equal(d1.text_vorschau.length, 500); // Vorschau gekappt
  assert.equal('text' in d1, false, 'Liste-Antwort ohne Volltext');

  // Datei auf Platte: 600
  const pfad = path.join(config.dokDir, `${d1.sha256.slice(0, 16)}.docx`);
  assert.ok(fs.existsSync(pfad));
  assert.equal(fs.statSync(pfad).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(pfad).length, buf.length);

  // Dedup: gleiche Datei erneut → 200 + doppelung, keine zweite Zeile
  const r2 = await upload('Stromabrechnung Q3 2026.docx', buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).doppelung, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 1);
});

test('Server: falscher Typ → 400, falsche Magic-Bytes → 400, zu groß → 413', async () => {
  const r1 = await upload('bild.jpg', Buffer.from('kein jpg, nur text'), 'image/jpeg');
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).fehler, /Dateityp nicht erlaubt/);

  const r2 = await upload('gefälscht.pdf', Buffer.from('kein pdf, nur text'), 'application/pdf');
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).fehler, /PDF/);

  const r3 = await upload('gefälscht.docx', Buffer.from('keins zip'), 'application/zip');
  assert.equal(r3.status, 400);
  assert.match((await r3.json()).fehler, /Archiv/);

  const riesig = crypto.randomBytes(25 * 1024 * 1024 + 1);
  const r4 = await upload('riesig.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), riesig]), 'application/pdf');
  assert.equal(r4.status, 413);
});

test('Server: PDF ohne Textfeld → kein_text (Scan)', async () => {
  const r = await upload('scan.pdf', fakePdf, 'application/pdf');
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.equal(d.text_status, 'kein_text');
  assert.equal(d.text_vorschau, null);
});

test('Server: PDF mit Browser-Text → ok', async () => {
  // anderer Inhalt als der Scan oben (sonst Dedup: gleiche SHA-256)
  const pdf2 = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('2 0 obj\n<< /Type /Page >>\nendobj\n'), Buffer.from('trailer\n<< /Root 2 0 R >>\n%%EOF\n')]);
  const r = await upload('rechnung.pdf', pdf2, 'application/pdf', { text: 'E.ON\nStrom 84,12 €\nFällig 31.10.2026' });
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.equal(d.text_status, 'ok');
  assert.match(d.text_vorschau, /E\.ON/);
});

test('Server: Liste, Detail, Download, Löschen', async () => {
  const liste = await (await fetch(`${base}/api/documents`, { headers: headers() })).json();
  assert.equal(liste.dokumente.length, 3); // docx + 2 PDFs
  assert.ok(liste.dokumente.every((d) => !('text' in d)), 'Liste ohne Volltext');

  const detail = await (await fetch(`${base}/api/documents/1`, { headers: headers() })).json();
  assert.equal(detail.id, 1);
  assert.match(detail.text, /E\.ON/);

  const dl = await fetch(`${base}/api/documents/1/download`, { headers: headers() });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.equal(bytes.length, detail.size);

  const del = await fetch(`${base}/api/documents/1`, { method: 'DELETE', headers: headers() });
  assert.equal(del.status, 200);
  assert.equal(getDocument(db, 1), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 2);
});

test('Server: pdf.js wird lokal unter /vendor/pdfjs ausgeliefert', async () => {
  const r = await fetch(`${base}/vendor/pdfjs/pdf.min.mjs`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /javascript|module/);
  const w = await fetch(`${base}/vendor/pdfjs/pdf.worker.min.mjs`);
  assert.equal(w.status, 200);
});

test('Server: KI-Status ohne OMLX-Konfiguration → ok:false', async () => {
  const s = await (await fetch(`${base}/api/ki/status`, { headers: headers() })).json();
  assert.equal(s.ok, false);
  assert.equal(s.grund, 'nicht_konfiguriert');
  assert.match(s.meldung, /OMLX/);
});
