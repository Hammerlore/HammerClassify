/* ==========================================================================
   HammerClassify — P3-Tests (node:test)
   - ergebnis.js: Schema-Prüfung (FELDER, Regel-Set, Grounding, Plausibilität),
     Bedingungen (eigener_name_adresse), Inhaber-Profil, JSON-Parsing
   - prompt.js: Prompt-Renderer (Regeln, Dokument-Marker, Inhaber verallgemeinert,
     Prompt-Inject-Warnung, Kürzung)
   - DB: rules-Tabelle (Migration 5), Regeln-CRUD, Klassifizierungs-Workflow
   - Server: Regeln-CRUD, Inhaber-Profil, klassifizieren (409/503/422/200
     gegen Fake-OMLX), bestaetigen, ablehnen, Klartext-Upload (.txt/.md)
   ========================================================================== */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { encodeCBOR } from '@levischuck/tiny-cbor';

import {
  openDb, createNutzer, addDocument, getDocument, addRegel, getRegel,
  updateRegel, deleteRegel, listRegeln, saveKlassifizierung,
  bestaetigeKlassifizierung, ablehneKlassifizierung, setzeStatus,
  setSetting, getSetting, SCHEMA_STAND,
} from '../src/db.js';
import * as auth from '../src/auth.js';
import { createApp } from '../src/server.js';
import {
  pruefeErgebnis, parseErgebnisText, bedingungenPruefen, inhaberImText,
  SCHEMA_VERSION,
} from '../src/ergebnis.js';
import { bauePrompt, kuerzeText } from '../src/prompt.js';
import { OMLX_MODELL } from '../src/omlx.js';

/* ------------------- Fake-Authenticator (wie p1/p2) --------------------- */

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
/* Anders als in omlx.test.js: auch POST /v1/chat/completions, mit
   steuerbarem Verhalten (Status + Inhalt) für die Klassifizierungs-Tests. */

const OMLX_KEY = 'omlx-p3-key-1234';

function startFakeOmlx() {
  const state = { completions: 0, lastBody: null, status: 200, inhalt: null };
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
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        state.completions++;
        try { state.lastBody = JSON.parse(body); } catch { state.lastBody = null; }
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

const REGELN = [
  { id: 1, name: 'Strom', art: 'kategorie', beschreibung: 'Alles zu Strom', schluesselwoerter: ['strom', 'energie'], bedingung: null, beispiel: null },
  { id: 2, name: 'Wasser', art: 'kategorie', beschreibung: 'Alles zu Wasser', schluesselwoerter: ['wasser'], bedingung: null, beispiel: null },
  { id: 3, name: 'Rechnung', art: 'dokumenttyp', beschreibung: 'Eine Rechnung über eine Leistung', schluesselwoerter: ['rechnung'], bedingung: null, beispiel: null },
  { id: 4, name: 'Eigenes', art: 'kategorie', beschreibung: 'Nur eigene Dokumente des Inhabers', schluesselwoerter: [], bedingung: 'eigener_name_adresse', beispiel: null },
];

const VOLLTEXT = [
  'E.ON Energie Deutschland GmbH',
  'Rechnung Strom Q3 2026',
  'Gesamtbetrag: 84,12 €',
  'Fällig bis: 31.10.2026',
  'An: Micha Hammer, Hammerweg 1, 12345 Ort',
].join('\n');

const VOLLTEXT_2 = [
  'Stadtwerke Nord GmbH',
  'Wasserrechnung 2026',
  'Betrag: 12,50 €',
  'An: Micha Hammer, Hammerweg 1, 12345 Ort',
].join('\n');

const INHABER = { name: 'Micha Hammer', adresse: 'Hammerweg 1, 12345 Ort', kundennummer: 'K-123' };

/* Ein volles, gültiges KI-Ergebnis (konzept.md „Das erwartete Ergebnis") */
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

/* Wie GUELTIG, aber mit Müll: fremdes Tag + unbekanntes Feld → verworfen,
   Rest verwertbar (Vorschlag mit Verworfen-Gründen). */
const GUELTIG_MIT_MUELL = {
  ...GUELTIG,
  kategorien: [
    ...GUELTIG.kategorien,
    { name: 'Erfindung', konfidenz: 0.5, stellen: ['Rechnung Strom Q3 2026'] },
  ],
  geheim: true,
};

/* KI-Antwort für das zweite Dokument (Wasser) */
const GUELTIG_2 = {
  dokumenttyp: { name: 'Rechnung', konfidenz: 0.9 },
  kategorien: [
    { name: 'Wasser', konfidenz: 0.85, stellen: ['Wasserrechnung 2026'] },
    { name: 'Eigenes', konfidenz: 0.7, stellen: ['An: Micha Hammer'] },
  ],
  absender: 'Stadtwerke Nord GmbH',
  datum: '2026-06-15',
  betraege: [{ art: 'brutto', wert_cents: 1250 }],
  beleg_erforderlich: true,
  kern: 'Wasserrechnung 2026',
  vertrauen_gesamt: 0.8,
};

/* PDF-Magic-Bytes + unterschiedlicher Inhalt (sonst Dedup über SHA-256) */
const pdfMitText = (extra = '') => Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from(`2 0 obj\n<< /Type /Page${extra} >>\nendobj\n`),
  Buffer.from('trailer\n<< /Root 2 0 R >>\n%%EOF\n'),
]);

const fakePdf = Buffer.concat([
  Buffer.from('%PDF-1.7\n%âãÏÓ\n'),
  Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n'),
  Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n'),
]);

/* -------------------------------- Setup --------------------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hammerclassify-p3-'));
let db, config, app, server, base, token, fakeOmlx;
let dok1Id, dok2Id, dok3Id;

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

/* ------------------------------ ergebnis.js ----------------------------- */

test('ergebnis: gültiges volles Ergebnis → ok, alle Felder, Schema-Version', () => {
  const { ok, ergebnis, verworfen, fehler } = pruefeErgebnis(GUELTIG, { regeln: REGELN, volltext: VOLLTEXT, inhaber: INHABER });
  assert.equal(ok, true);
  assert.deepEqual(fehler, []);
  assert.deepEqual(verworfen, []);
  assert.equal(ergebnis.schema, SCHEMA_VERSION);
  assert.deepEqual(ergebnis.dokumenttyp, { name: 'Rechnung', konfidenz: 0.95 });
  assert.deepEqual(ergebnis.kategorien.map((k) => k.name), ['Strom', 'Eigenes']);
  assert.deepEqual(ergebnis.kategorien[0].stellen, ['Rechnung Strom Q3 2026']);
  assert.equal(ergebnis.absender, 'E.ON Energie Deutschland GmbH');
  assert.equal(ergebnis.datum, '2026-10-31');
  assert.deepEqual(ergebnis.betraege, [{ art: 'brutto', wert_cents: 8412 }]);
  assert.equal(ergebnis.beleg_erforderlich, true);
  assert.equal(ergebnis.kern, 'Stromrechnung Q3 2026');
  assert.equal(ergebnis.vertrauen_gesamt, 0.85);
});

test('ergebnis: unbekanntes Feld, fremdes Tag, fehlendes Zitat → verworfen', () => {
  const roh = {
    ...GUELTIG,
    kategorien: [
      { name: 'Strom', konfidenz: 0.9, stellen: ['Rechnung Strom Q3 2026'] },
      { name: 'Quatsch', konfidenz: 0.5, stellen: ['Rechnung Strom Q3 2026'] }, // nicht im Regel-Set
      { name: 'Wasser', konfidenz: 0.5, stellen: ['Zitat, das nirgends vorkommt'] }, // Grounding
    ],
    geheim: true, // unbekanntes Feld
  };
  const { ok, ergebnis, verworfen } = pruefeErgebnis(roh, { regeln: REGELN, volltext: VOLLTEXT, inhaber: INHABER });
  assert.equal(ok, true);
  assert.deepEqual(ergebnis.kategorien.map((k) => k.name), ['Strom']);
  assert.ok(verworfen.some((v) => v.includes('Quatsch') && v.includes('Regel-Set')), 'fremdes Tag gemeldet');
  assert.ok(verworfen.some((v) => v.includes('Wasser') && v.includes('Grounding')), 'fehlendes Zitat gemeldet');
  assert.ok(verworfen.some((v) => v.includes('geheim') && v.includes('unbekannt')), 'unbekanntes Feld gemeldet');
});

test('ergebnis: Beträge — Art, Plausibilität, Duplikate', () => {
  const roh = {
    betraege: [
      { art: 'brutto', wert_cents: 8412 },
      { art: 'brutto', wert_cents: 9999 },        // Duplikat → erster bleibt
      { art: 'quatsch', wert_cents: 100 },        // unklare Art
      { art: 'netto', wert_cents: 999_999_999 },  // > 1 Mio. €
      { art: 'ust', wert_cents: -5 },             // negativ
    ],
  };
  const { ok, ergebnis, verworfen } = pruefeErgebnis(roh, { regeln: REGELN, volltext: VOLLTEXT, inhaber: INHABER });
  assert.equal(ok, true);
  assert.deepEqual(ergebnis.betraege, [{ art: 'brutto', wert_cents: 8412 }]);
  assert.ok(verworfen.some((v) => v.includes('quatsch') && v.includes('unklare Art')));
  assert.ok(verworfen.some((v) => v.includes('netto') && v.includes('unplausibel')));
  assert.ok(verworfen.some((v) => v.includes('ust') && v.includes('unplausibel')));
});

test('ergebnis: unplausible Zahlen und Formate → verworfen', () => {
  const roh = {
    dokumenttyp: { name: 'Rechnung', konfidenz: 1.5 },   // > 1
    datum: '31.10.2026',                                  // kein ISO
    beleg_erforderlich: 'ja',                             // kein Boolean
    vertrauen_gesamt: 2,                                  // > 1
  };
  const { ok, ergebnis, verworfen } = pruefeErgebnis(roh, { regeln: REGELN, volltext: VOLLTEXT, inhaber: INHABER });
  assert.equal(ok, true); // Dokumenttyp bleibt (Konfidenz wird null)
  assert.equal(ergebnis.dokumenttyp.konfidenz, null);
  assert.equal('datum' in ergebnis, false);
  assert.equal('beleg_erforderlich' in ergebnis, false);
  assert.equal('vertrauen_gesamt' in ergebnis, false);
  assert.equal(verworfen.length, 3);
});

test('ergebnis: alles verworfen → ok:false, nichts verwertbar', () => {
  const roh = {
    dokumenttyp: { name: 'Quatsch', konfidenz: 0.9 }, // nicht im Regel-Set
    kategorien: [],
    unbekannt: true,
  };
  const { ok, ergebnis, verworfen } = pruefeErgebnis(roh, { regeln: REGELN, volltext: VOLLTEXT, inhaber: INHABER });
  assert.equal(ok, false);
  assert.equal(ergebnis, null);
  assert.equal(verworfen.length, 2);
});

test('ergebnis: kein Objekt → struktureller Fehler', () => {
  for (const roh of [null, 'text', [1, 2]]) {
    const r = pruefeErgebnis(roh, { regeln: REGELN, volltext: VOLLTEXT, inhaber: INHABER });
    assert.equal(r.ok, false, JSON.stringify(roh));
    assert.ok(r.fehler.length > 0);
  }
});

test('ergebnis: Bedingung eigener_name_adresse — Inhaber im Text → bleibt', () => {
  const { ergebnis, verworfen } = bedingungenPruefen(
    { dokumenttyp: { name: 'Rechnung', konfidenz: 1 }, kategorien: [{ name: 'Eigenes', konfidenz: 0.8, stellen: ['x'] }] },
    { regeln: REGELN, inhaber: INHABER, volltext: VOLLTEXT },
  );
  assert.ok(ergebnis.kategorien.some((k) => k.name === 'Eigenes'));
  assert.deepEqual(verworfen, []);
});

test('ergebnis: Bedingung — Inhaber NICHT im Text → verworfen mit Grund', () => {
  const { ergebnis, verworfen } = bedingungenPruefen(
    { kategorien: [{ name: 'Eigenes', konfidenz: 0.8, stellen: ['x'] }] },
    { regeln: REGELN, inhaber: INHABER, volltext: 'Irgendwas ohne Inhaber' },
  );
  assert.equal(ergebnis.kategorien, undefined);
  assert.match(verworfen[0], /Eigenes.*Inhaber-Name oder -Adresse im Dokument/);
});

test('ergebnis: Bedingung — Inhaber-Profil fehlt → verworfen mit Hinweis', () => {
  const { ergebnis, verworfen } = bedingungenPruefen(
    { dokumenttyp: { name: 'Rechnung', konfidenz: 1 }, kategorien: [{ name: 'Eigenes', konfidenz: 0.8, stellen: ['x'] }] },
    { regeln: REGELN, inhaber: null, volltext: VOLLTEXT },
  );
  assert.ok(ergebnis.dokumenttyp); // „Rechnung" hat keine Bedingung → bleibt
  assert.equal(ergebnis.kategorien, undefined); // „Eigenes" hat die Bedingung → verworfen
  assert.match(verworfen[0], /Inhaber-Profil fehlt/);
});

test('ergebnis: inhaberImText — Name, Adresse, keiner', () => {
  assert.equal(inhaberImText(INHABER, VOLLTEXT), true);
  assert.equal(inhaberImText({ name: 'Fremd', adresse: 'Andere Straße 9' }, VOLLTEXT), false);
  assert.equal(inhaberImText(null, VOLLTEXT), false);
  // nur Adresse im Text reicht
  assert.equal(inhaberImText({ name: 'Fremd', adresse: 'Hammerweg 1' }, VOLLTEXT), true);
});

test('ergebnis: parseErgebnisText — direkt, gefenst, mit Prosa, ungültig', () => {
  assert.deepEqual(parseErgebnisText('{"a": 1}').objekt, { a: 1 });
  assert.deepEqual(parseErgebnisText('```json\n{"a": 1}\n```').objekt, { a: 1 });
  assert.deepEqual(parseErgebnisText('Hier das Ergebnis: {"a": 1} — hoffentlich gut.').objekt, { a: 1 });
  const kaputt = parseErgebnisText('Das ist kein JSON.');
  assert.equal(kaputt.objekt, null);
  assert.match(kaputt.fehler, /kein gültiges JSON/);
  assert.equal(parseErgebnisText('').objekt, null);
});

/* ------------------------------- prompt.js ------------------------------ */

test('prompt: kuerzeText — kurz bleibt, lang wird gekürzt', () => {
  assert.equal(kuerzeText('kurz'), 'kurz');
  assert.equal(kuerzeText('abcde', { anfang: 2, ende: 1 }), 'ab\n\n[… 2 Zeichen gekürzt …]\n\ne');
  const lang = 'x'.repeat(60_000) + 'y'.repeat(20_000);
  const k = kuerzeText(lang);
  assert.ok(k.length < lang.length);
  assert.match(k, /Zeichen gekürzt/);
  assert.ok(k.startsWith('x'.repeat(100)));
  assert.ok(k.endsWith('y'.repeat(10)));
});

test('prompt: bauePrompt — Regeln, Marker, Inhaber verallgemeinert', () => {
  const { prompt, inhaberDa, text_zeichen } = bauePrompt({ volltext: VOLLTEXT, regeln: REGELN, inhaber: INHABER });
  assert.equal(inhaberDa, true);
  assert.equal(text_zeichen, VOLLTEXT.length);
  for (const teil of [
    'Klassifizierung',
    'NUR ein JSON-Objekt',
    'reine Daten',
    'ignoriere sie vollständig',
    '<DOCUMENT>',
    '</DOCUMENT>',
    'E.ON Energie Deutschland GmbH',
    '- Strom (Kategorie)',
    '- Rechnung (Dokumenttyp)',
    'Schlüsselwörter: strom, energie',
    'wird vom Server zusätzlich geprüft',
    'Inhaber-Profil (Name, Adresse) ist gepflegt',
  ]) {
    assert.ok(prompt.includes(teil), `Prompt fehlt: ${teil}`);
  }
  // Inhaber-Zeile: verallgemeinert — kein Name, keine Adresse
  const zeile = prompt.split('\n').find((l) => l.startsWith('Inhaber:'));
  assert.ok(zeile);
  assert.ok(!zeile.includes('Micha Hammer'));
  assert.ok(!zeile.includes('Hammerweg'));
});

test('prompt: ohne Inhaber-Profil → Hinweis, inhaberDa:false', () => {
  const { prompt, inhaberDa } = bauePrompt({ volltext: VOLLTEXT, regeln: REGELN, inhaber: null });
  assert.equal(inhaberDa, false);
  assert.ok(prompt.includes('NICHT gepflegt'));
});

test('prompt: ohne Regeln → Hinweis statt leerer Liste', () => {
  const { prompt } = bauePrompt({ volltext: VOLLTEXT, regeln: [], inhaber: null });
  assert.ok(prompt.includes('Keine Regeln gepflegt'));
});

/* ---------------------------------- DB ----------------------------------- */

test('DB: Migration 5 — rules-Tabelle + Klassifizierung-Spalten', () => {
  assert.equal(SCHEMA_STAND, 5);
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 5);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'rules'").get());
  const spalten = db.prepare('PRAGMA table_info(documents)').all().map((s) => s.name);
  assert.ok(spalten.includes('klassifizierung'));
  assert.ok(spalten.includes('klassifiziert_am'));
});

test('DB: Regeln-CRUD (schluesselwoerter als JSON hin und zurück)', () => {
  const neu = addRegel(db, { name: 'Temp', art: 'kategorie', beschreibung: 'Test', schluesselwoerter: ['a', 'b'], bedingung: null, beispiel: null });
  assert.equal(neu.name, 'Temp');
  assert.deepEqual(getRegel(db, neu.id).schluesselwoerter, ['a', 'b']);

  const geaendert = updateRegel(db, neu.id, { name: 'Temp2', art: 'kategorie', beschreibung: 'Geändert', schluesselwoerter: [], bedingung: 'eigener_name_adresse', beispiel: 'Zitat' });
  assert.equal(geaendert.name, 'Temp2');
  assert.equal(geaendert.bedingung, 'eigener_name_adresse');

  assert.equal(deleteRegel(db, neu.id), 1);
  assert.equal(getRegel(db, neu.id), null);
  assert.equal(deleteRegel(db, neu.id), 0);
});

test('DB: Klassifizierungs-Workflow (save → bestaetigen → ablehnen → Status)', () => {
  const dok = addDocument(db, {
    name: 't.pdf', ext: 'pdf', mime: 'application/pdf', size: 10, sha256: crypto.randomBytes(32).toString('hex'),
    text: 'Volltext', textStatus: 'ok',
  });
  assert.equal(dok.status, 'eingang');

  saveKlassifizierung(db, dok.id, { schema: SCHEMA_VERSION, dokumenttyp: { name: 'Rechnung', konfidenz: 1 }, verworfen: [] });
  let d = getDocument(db, dok.id);
  assert.equal(d.status, 'einzukategorisieren');
  assert.equal(JSON.parse(d.klassifizierung).dokumenttyp.name, 'Rechnung');
  assert.equal(d.klassifiziert_am, null);

  bestaetigeKlassifizierung(db, dok.id);
  d = getDocument(db, dok.id);
  assert.equal(d.status, 'klassifiziert');
  assert.ok(d.klassifiziert_am);

  ablehneKlassifizierung(db, dok.id);
  d = getDocument(db, dok.id);
  assert.equal(d.status, 'eingang');
  assert.equal(d.klassifizierung, null);

  setzeStatus(db, dok.id, 'abgelegt');
  assert.equal(getDocument(db, dok.id).status, 'abgelegt');
  assert.throws(() => setzeStatus(db, dok.id, 'quatsch'), /Unbekannter Status/);
  deleteDocumentCleanup(dok.id);
});

function deleteDocumentCleanup(id) {
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
}

/* -------------------------------- Server --------------------------------- */

test('Server: P3-Endpunkte ohne Session → 401', async () => {
  for (const [method, url] of [
    ['GET', `${base}/api/rules`],
    ['POST', `${base}/api/rules`],
    ['PUT', `${base}/api/rules/1`],
    ['DELETE', `${base}/api/rules/1`],
    ['GET', `${base}/api/inhaber`],
    ['PUT', `${base}/api/inhaber`],
    ['POST', `${base}/api/documents/1/klassifizieren`],
    ['POST', `${base}/api/documents/1/bestaetigen`],
    ['POST', `${base}/api/documents/1/ablehnen`],
  ]) {
    const r = await fetch(url, { method, headers: { ...json } });
    assert.equal(r.status, 401, `${method} ${url}`);
  }
});

test('Server: GET /api/rules — leer am Anfang', async () => {
  const r = await (await fetch(`${base}/api/rules`, { headers: headers() })).json();
  assert.deepEqual(r, { regeln: [] });
});

test('Server: POST /api/rules — gültig (Schlüsselwörter als Komma-String)', async () => {
  const r = await fetch(`${base}/api/rules`, {
    method: 'POST',
    headers: { ...headers(), ...json },
    body: JSON.stringify({ name: 'Strom', art: 'kategorie', beschreibung: 'Alles zu Strom', schluesselwoerter: 'strom, energie' }),
  });
  assert.equal(r.status, 201);
  const regel = (await r.json()).regel;
  assert.equal(regel.name, 'Strom');
  assert.deepEqual(regel.schluesselwoerter, ['strom', 'energie']); // Komma-String → Array
  assert.equal(regel.bedingung, null);
});

test('Server: POST /api/rules — ungültig → 400', async () => {
  const faelle = [
    { name: '', art: 'kategorie', beschreibung: 'x' },                    // kein Name
    { name: 'x'.repeat(101), art: 'kategorie', beschreibung: 'x' },       // Name zu lang
    { name: 'Strom', art: 'quatsch', beschreibung: 'x' },                  // falsche Art
    { name: 'Strom', art: 'kategorie', beschreibung: '' },                 // keine Beschreibung
    { name: 'Strom', art: 'kategorie', beschreibung: 'x', bedingung: 'quatsch' }, // falsche Bedingung
  ];
  for (const body of faelle) {
    const r = await fetch(`${base}/api/rules`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify(body) });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('Server: POST /api/rules — doppelter Name (gleiche Art) → 409', async () => {
  const r = await fetch(`${base}/api/rules`, {
    method: 'POST',
    headers: { ...headers(), ...json },
    body: JSON.stringify({ name: 'Strom', art: 'kategorie', beschreibung: 'Nochmal Strom' }),
  });
  assert.equal(r.status, 409);
  assert.match((await r.json()).fehler, /bereits eine kategorie/);
});

test('Server: restliche Regeln anlegen (Wasser, Rechnung, Eigenes, Temp)', async () => {
  for (const body of [
    { name: 'Wasser', art: 'kategorie', beschreibung: 'Alles zu Wasser', schluesselwoerter: 'wasser' },
    { name: 'Rechnung', art: 'dokumenttyp', beschreibung: 'Eine Rechnung über eine Leistung', schluesselwoerter: 'rechnung' },
    { name: 'Eigenes', art: 'kategorie', beschreibung: 'Nur eigene Dokumente des Inhabers', bedingung: 'eigener_name_adresse' },
    { name: 'Temp', art: 'kategorie', beschreibung: 'Testregel' },
  ]) {
    const r = await fetch(`${base}/api/rules`, { method: 'POST', headers: { ...headers(), ...json }, body: JSON.stringify(body) });
    assert.equal(r.status, 201, JSON.stringify(body));
  }
  const liste = await (await fetch(`${base}/api/rules`, { headers: headers() })).json();
  assert.equal(liste.regeln.length, 5);
});

test('Server: PUT /api/rules/:id — ändern, 404, Duplikat 409', async () => {
  const liste = await (await fetch(`${base}/api/rules`, { headers: headers() })).json();
  const strom = liste.regeln.find((r) => r.name === 'Strom');
  const temp = liste.regeln.find((r) => r.name === 'Temp');

  const ok = await fetch(`${base}/api/rules/${strom.id}`, {
    method: 'PUT',
    headers: { ...headers(), ...json },
    body: JSON.stringify({ name: 'Strom', art: 'kategorie', beschreibung: 'Alles zu Strom (geändert)' }),
  });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).regel.beschreibung, 'Alles zu Strom (geändert)');

  const fehlt = await fetch(`${base}/api/rules/999`, {
    method: 'PUT',
    headers: { ...headers(), ...json },
    body: JSON.stringify({ name: 'Strom', art: 'kategorie', beschreibung: 'x' }),
  });
  assert.equal(fehlt.status, 404);

  const doppelt = await fetch(`${base}/api/rules/${temp.id}`, {
    method: 'PUT',
    headers: { ...headers(), ...json },
    body: JSON.stringify({ name: 'Strom', art: 'kategorie', beschreibung: 'x' }),
  });
  assert.equal(doppelt.status, 409);
});

test('Server: DELETE /api/rules/:id — einmal 200, erneut 404', async () => {
  const liste = await (await fetch(`${base}/api/rules`, { headers: headers() })).json();
  const temp = liste.regeln.find((r) => r.name === 'Temp');
  const r1 = await fetch(`${base}/api/rules/${temp.id}`, { method: 'DELETE', headers: headers() });
  assert.equal(r1.status, 200);
  const r2 = await fetch(`${base}/api/rules/${temp.id}`, { method: 'DELETE', headers: headers() });
  assert.equal(r2.status, 404);
});

test('Server: Inhaber-Profil — leer, speichern, lesen, leeren, neu', async () => {
  const leer = await (await fetch(`${base}/api/inhaber`, { headers: headers() })).json();
  assert.deepEqual(leer.inhaber, { name: '', adresse: '', kundennummer: '' });

  const put = await fetch(`${base}/api/inhaber`, {
    method: 'PUT',
    headers: { ...headers(), ...json },
    body: JSON.stringify({ name: 'Micha Hammer', adresse: 'Hammerweg 1, 12345 Ort', kundennummer: 'K-123' }),
  });
  assert.equal(put.status, 200);
  assert.equal(getSetting(db, 'inhauber_profil') !== null, true);

  const get = await (await fetch(`${base}/api/inhaber`, { headers: headers() })).json();
  assert.deepEqual(get.inhaber, INHABER);

  // alles leer → Eintrag gelöscht
  const loeschen = await fetch(`${base}/api/inhaber`, {
    method: 'PUT',
    headers: { ...headers(), ...json },
    body: JSON.stringify({ name: ' ', adresse: '', kundennummer: '' }),
  });
  assert.equal(loeschen.status, 200);
  assert.equal(getSetting(db, 'inhauber_profil'), null);

  // wiederherstellen (die Klassifizierungs-Tests brauchen das Profil)
  await fetch(`${base}/api/inhaber`, {
    method: 'PUT',
    headers: { ...headers(), ...json },
    body: JSON.stringify(INHABER),
  });
});

test('Server: drei Dokumente hochladen (2 mit Text, 1 Scan)', async () => {
  const r1 = await upload('Stromabrechnung Q3 2026.pdf', pdfMitText(), 'application/pdf', { text: VOLLTEXT });
  assert.equal(r1.status, 201);
  const d1 = await r1.json();
  assert.equal(d1.text_status, 'ok');
  dok1Id = d1.id;

  const r2 = await upload('Wasserabrechnung 2026.pdf', pdfMitText(' /Count 2'), 'application/pdf', { text: VOLLTEXT_2 });
  assert.equal(r2.status, 201);
  dok2Id = (await r2.json()).id;

  const r3 = await upload('scan.pdf', fakePdf, 'application/pdf');
  assert.equal(r3.status, 201);
  const d3 = await r3.json();
  assert.equal(d3.text_status, 'kein_text');
  dok3Id = d3.id;
});

test('Server: klassifizieren ohne Text → 409', async () => {
  const r = await fetch(`${base}/api/documents/${dok3Id}/klassifizieren`, { method: 'POST', headers: headers() });
  assert.equal(r.status, 409);
  assert.match((await r.json()).fehler, /Kein Text/);
});

test('Server: klassifizieren ohne OMLX-Konfiguration → 409', async () => {
  const r = await fetch(`${base}/api/documents/${dok1Id}/klassifizieren`, { method: 'POST', headers: headers() });
  assert.equal(r.status, 409);
  assert.match((await r.json()).fehler, /KI nicht konfiguriert/);
});

test('Server: klassifizieren, OMLX nicht erreichbar → 503 (2 Versuche)', async () => {
  // Geschlossener Port (dynamisch belegt + geschlossen)
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));

  setSetting(db, 'omlx_url', `http://127.0.0.1:${port}`);
  setSetting(db, 'omlx_key', OMLX_KEY);

  const r = await fetch(`${base}/api/documents/${dok1Id}/klassifizieren`, { method: 'POST', headers: headers() });
  assert.equal(r.status, 503);
  const body = await r.json();
  assert.equal(body.ki.grund, 'abgelehnt');
  assert.match(body.fehler, /nach 2 Versuchen/);
  // Dokument bleibt, wo es ist
  assert.equal(getDocument(db, dok1Id).status, 'eingang');
});

test('Server: klassifizieren, falscher Schlüssel → 503 (key_ungueltig)', async () => {
  setSetting(db, 'omlx_url', fakeOmlx.url);
  setSetting(db, 'omlx_key', 'falscher-key');
  const r = await fetch(`${base}/api/documents/${dok1Id}/klassifizieren`, { method: 'POST', headers: headers() });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).ki.grund, 'key_ungueltig');
});

test('Server: KI-Antwort kein JSON → 422 unbrauchbar', async () => {
  setSetting(db, 'omlx_key', OMLX_KEY);
  fakeOmlx.state.inhalt = 'Das ist keine JSON-Antwort.';
  const r = await fetch(`${base}/api/documents/${dok1Id}/klassifizieren`, { method: 'POST', headers: headers() });
  assert.equal(r.status, 422);
  assert.match((await r.json()).fehler, /unbrauchbar/);
});

test('Server: KI-Ergebnis nach Prüfung leer → 422 mit Gründen', async () => {
  fakeOmlx.state.inhalt = JSON.stringify({
    dokumenttyp: { name: 'Quatsch', konfidenz: 2 },
    kategorien: [],
    unbekannt: true,
  });
  const r = await fetch(`${base}/api/documents/${dok1Id}/klassifizieren`, { method: 'POST', headers: headers() });
  assert.equal(r.status, 422);
  const body = await r.json();
  assert.match(body.fehler, /nichts verwertbar/);
  assert.ok(body.verworfen.some((v) => v.includes('Quatsch')));
  assert.ok(body.verworfen.some((v) => v.includes('unbekannt')));
});

test('Server: KI-Ergebnis gültig → 200, Vorschlag gespeichert', async () => {
  fakeOmlx.state.inhalt = JSON.stringify(GUELTIG_MIT_MUELL);
  const r = await fetch(`${base}/api/documents/${dok1Id}/klassifizieren`, { method: 'POST', headers: headers() });
  assert.equal(r.status, 200);
  const body = await r.json();

  // Prompt-Prüfung: die Anfrage an OMLX war korrekt gebaut
  const anfrage = fakeOmlx.state.lastBody;
  assert.equal(anfrage.model, OMLX_MODELL);
  assert.equal(anfrage.temperature, 0);
  assert.deepEqual(anfrage.response_format, { type: 'json_object' });
  const promptText = anfrage.messages[1].content;
  assert.ok(promptText.includes('<DOCUMENT>'));
  assert.ok(promptText.includes('E.ON Energie Deutschland GmbH'));
  assert.ok(promptText.includes('- Strom (Kategorie)'));
  assert.ok(!promptText.split('\n').find((l) => l.startsWith('Inhaber:')).includes('Micha Hammer'), 'Inhaber verallgemeinert');

  // Ergebnis: Vorschlag mit Status + geprüftem Inhalt
  assert.equal(body.dokument.status, 'einzukategorisieren');
  const k = body.dokument.klassifizierung;
  assert.equal(k.dokumenttyp.name, 'Rechnung');
  assert.deepEqual(k.kategorien.map((x) => x.name), ['Strom', 'Eigenes']); // „Erfindung" verworfen (nicht im Regel-Set)
  assert.equal(k.absender, 'E.ON Energie Deutschland GmbH');
  assert.equal(k.datum, '2026-10-31');
  assert.deepEqual(k.betraege, [{ art: 'brutto', wert_cents: 8412 }]);
  assert.equal(k.beleg_erforderlich, true);
  assert.equal(k.vertrauen_gesamt, 0.85);
  // Verworfen-Gründe mitgespeichert (erscheinen in der Bestätigungs-Ansicht)
  assert.ok(k.verworfen.some((v) => v.includes('Erfindung') && v.includes('Regel-Set')));
  assert.ok(k.verworfen.some((v) => v.includes('geheim') && v.includes('unbekannt')));
  assert.deepEqual(body.verworfen, k.verworfen);

  // In der DB persistiert
  const inDb = getDocument(db, dok1Id);
  assert.equal(inDb.status, 'einzukategorisieren');
  assert.equal(JSON.parse(inDb.klassifizierung).dokumenttyp.name, 'Rechnung');
});

test('Server: bestaetigen → Status klassifiziert; ohne Vorschlag → 409', async () => {
  const r = await fetch(`${base}/api/documents/${dok1Id}/bestaetigen`, { method: 'POST', headers: headers() });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.dokument.status, 'klassifiziert');
  assert.ok(body.dokument.klassifiziert_am);
  assert.equal(body.dokument.klassifizierung.dokumenttyp.name, 'Rechnung');

  const ohne = await fetch(`${base}/api/documents/${dok3Id}/bestaetigen`, { method: 'POST', headers: headers() });
  assert.equal(ohne.status, 409);
  assert.match((await ohne.json()).fehler, /Kein Vorschlag/);

  // Liste liefert das geparste Ergebnis (ohne Volltext)
  const liste = await (await fetch(`${base}/api/documents`, { headers: headers() })).json();
  const d1 = liste.dokumente.find((d) => d.id === dok1Id);
  assert.equal(d1.status, 'klassifiziert');
  assert.equal(d1.klassifizierung.dokumenttyp.name, 'Rechnung');
  assert.equal('text' in d1, false);
});

test('Server: ablehnen → zurück in eingang, Vorschlag verworfen', async () => {
  fakeOmlx.state.inhalt = JSON.stringify(GUELTIG_2);
  const k = await fetch(`${base}/api/documents/${dok2Id}/klassifizieren`, { method: 'POST', headers: headers() });
  assert.equal(k.status, 200);
  assert.equal((await k.json()).dokument.status, 'einzukategorisieren');

  const a = await fetch(`${base}/api/documents/${dok2Id}/ablehnen`, { method: 'POST', headers: headers() });
  assert.equal(a.status, 200);
  const body = await a.json();
  assert.equal(body.dokument.status, 'eingang');
  assert.equal(body.dokument.klassifizierung, null);
  assert.equal(getDocument(db, dok2Id).klassifizierung, null);
});

test('Server: Klartext-Dokumente (.txt/.md) — Upload, Text, Klassifizierung', async () => {
  const txtText = [
    'Miete Oktober 2026',
    'Wohnung: Hammerweg 1, 12345 Ort',
    'Netto: 850,00 €',
    'An: Micha Hammer, Hammerweg 1, 12345 Ort',
  ].join('\n');
  const r1 = await upload('miete_okt.txt', Buffer.from(txtText), 'text/plain');
  assert.equal(r1.status, 201);
  const d1 = await r1.json();
  assert.equal(d1.ext, 'txt');
  assert.equal(d1.text_status, 'ok');
  assert.equal(d1.text_vorschau, txtText); // unter 500 Zeichen → vollständig
  assert.equal('text' in d1, false);

  const mdText = [
    '# Angebot: Dachsanierung',
    'Gesamtpreis: 12.500,00 €',
    'Gültig bis: 31.12.2026',
    'An: Micha Hammer, Hammerweg 1, 12345 Ort',
  ].join('\n');
  const r2 = await upload('angebot.md', Buffer.from(mdText), 'text/markdown');
  assert.equal(r2.status, 201);
  const d2 = await r2.json();
  assert.equal(d2.ext, 'md');
  assert.equal(d2.text_status, 'ok');
  assert.match(d2.text_vorschau, /^# Angebot/);

  // Binärer Inhalt mit Text-Erweiterung → 400
  const r3 = await upload('defekt.txt', Buffer.from([0x00, 0x01, 0x02, 0x03]), 'text/plain');
  assert.equal(r3.status, 400);
  assert.match((await r3.json()).fehler, /binär/);

  // Klassifizierung ist format-agnostisch: .txt mit Volltext → Vorschlag
  fakeOmlx.state.inhalt = JSON.stringify({
    dokumenttyp: { name: 'Rechnung', konfidenz: 0.8 },
    kategorien: [{ name: 'Eigenes', konfidenz: 0.7, stellen: ['An: Micha Hammer'] }],
    absender: 'Hausverwaltung Nord',
    datum: '2026-10-01',
    betraege: [{ art: 'netto', wert_cents: 85000 }],
    beleg_erforderlich: true,
    kern: 'Miete Oktober 2026',
    vertrauen_gesamt: 0.75,
  });
  const k1 = await fetch(`${base}/api/documents/${d1.id}/klassifizieren`, { method: 'POST', headers: headers() });
  assert.equal(k1.status, 200);
  const b1 = await k1.json();
  assert.equal(b1.dokument.status, 'einzukategorisieren');
  assert.equal(b1.dokument.klassifizierung.dokumenttyp.name, 'Rechnung');
  assert.equal(b1.dokument.klassifizierung.kategorien[0].name, 'Eigenes');

  // .md: gleicher Weg
  fakeOmlx.state.inhalt = JSON.stringify({
    dokumenttyp: { name: 'Rechnung', konfidenz: 0.6 },
    kategorien: [{ name: 'Eigenes', konfidenz: 0.6, stellen: ['An: Micha Hammer'] }],
    absender: 'Dachfirma Süd GmbH',
    datum: '2026-12-31',
    betraege: [{ art: 'brutto', wert_cents: 1250000 }],
    beleg_erforderlich: false,
    kern: 'Angebot Dachsanierung',
    vertrauen_gesamt: 0.6,
  });
  const k2 = await fetch(`${base}/api/documents/${d2.id}/klassifizieren`, { method: 'POST', headers: headers() });
  assert.equal(k2.status, 200);
  const b2 = await k2.json();
  assert.equal(b2.dokument.klassifizierung.dokumenttyp.name, 'Rechnung');
  assert.deepEqual(b2.dokument.klassifizierung.betraege, [{ art: 'brutto', wert_cents: 1250000 }]);
});
