/* ==========================================================================
   HammerClassify — OMLX-Tests (node:test)
   - omlx.js: Verbindungsprüfung mit aussagekräftigen Meldungen (alle
     Fehlerarten: nicht konfiguriert, URL, DNS, abgelehnt, 401, 404, OK)
   - omlxKonfig: .env-Werte, DB-Override, Maskierung
   - Server: /api/omlx (GET/PUT), /api/omlx/test, /api/ki/status
   ========================================================================== */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { encodeCBOR } from '@levischuck/tiny-cbor';

import { openDb, createNutzer, getSetting, setSetting, SCHEMA_STAND } from '../src/db.js';
import * as auth from '../src/auth.js';
import { createApp } from '../src/server.js';
import { omlxKonfig, omlxPruefe } from '../src/omlx.js';

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

const OMLX_KEY = 'omlx-test-key-1234';

function startFakeOmlx() {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      if (req.headers.authorization !== `Bearer ${OMLX_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b-mlx-4bit' }] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/* -------------------------------- Setup --------------------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hammerclassify-omlx-'));
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

/* ------------------------------ omlxPruefe ------------------------------ */

test('omlxPruefe: leer → nicht_konfiguriert', async () => {
  const r = await omlxPruefe('', '');
  assert.equal(r.ok, false);
  assert.equal(r.grund, 'nicht_konfiguriert');
  assert.match(r.meldung, /nicht konfiguriert/i);
});

test('omlxPruefe: ungültige URL → ungueltige_url', async () => {
  assert.equal((await omlxPruefe('keine url', '')).grund, 'ungueltige_url');
  assert.equal((await omlxPruefe('ftp://omlx.lan:8443', '')).grund, 'ungueltige_url');
});

test('omlxPruefe: geschlossener Port → abgelehnt', async () => {
  // Dynamisch: Port belegen, schließen, dann verbinden → ECONNREFUSED
  // (Port 1 geht nicht — undici blockiert ihn als „bad port")
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  const r = await omlxPruefe(`http://127.0.0.1:${port}`, '');
  assert.equal(r.ok, false);
  assert.equal(r.grund, 'abgelehnt');
  assert.match(r.meldung, new RegExp(String(port)));
});

test('omlxPruefe: blockierter Port → ungueltige_url', async () => {
  const r = await omlxPruefe('http://127.0.0.1:1', '');
  assert.equal(r.ok, false);
  assert.equal(r.grund, 'ungueltige_url');
  assert.match(r.meldung, /blockiert/);
});

test('omlxPruefe: falscher Schlüssel → key_ungueltig (401)', async () => {
  const r = await omlxPruefe(fakeOmlx.url, 'falscher-key');
  assert.equal(r.ok, false);
  assert.equal(r.grund, 'key_ungueltig');
  assert.match(r.meldung, /401/);
});

test('omlxPruefe: falscher Pfad → pfad_falsch (404)', async () => {
  const r = await omlxPruefe(`${fakeOmlx.url}/falsch`, OMLX_KEY);
  assert.equal(r.ok, false);
  assert.equal(r.grund, 'pfad_falsch');
});

test('omlxPruefe: gültig → ok mit Modellliste', async () => {
  const r = await omlxPruefe(fakeOmlx.url, OMLX_KEY);
  assert.equal(r.ok, true);
  assert.equal(r.grund, 'ok');
  assert.ok(r.ms >= 0);
  assert.deepEqual(r.modelle, ['qwen3.8-27b-mlx-4bit']);
  assert.match(r.meldung, /erreichbar/);
});

/* ------------------------------ omlxKonfig ------------------------------ */

test('omlxKonfig: .env-Werte', () => {
  const c = { omlxUrl: 'https://omlx.lan:8443', omlxKey: 'env-key' };
  assert.deepEqual(omlxKonfig(c, null), { url: 'https://omlx.lan:8443', key: 'env-key', quelle: 'env' });
});

test('omlxKonfig: DB-Override schlägt .env', () => {
  setSetting(db, 'omlx_url', 'https://db.lan:9999');
  setSetting(db, 'omlx_key', 'db-key');
  const c = { omlxUrl: 'https://omlx.lan:8443', omlxKey: 'env-key' };
  assert.deepEqual(omlxKonfig(c, db), { url: 'https://db.lan:9999', key: 'db-key', quelle: 'einstellungen' });
  setSetting(db, 'omlx_url', null);
  setSetting(db, 'omlx_key', null);
});

test('omlxKonfig: nichts konfiguriert → null', () => {
  assert.deepEqual(omlxKonfig({ omlxUrl: undefined, omlxKey: undefined }, db), { url: '', key: '', quelle: null });
});

test('setSetting: leerer Wert löscht den Eintrag', () => {
  setSetting(db, 'omlx_url', 'https://x.lan');
  assert.equal(getSetting(db, 'omlx_url'), 'https://x.lan');
  setSetting(db, 'omlx_url', '');
  assert.equal(getSetting(db, 'omlx_url'), null);
});

/* -------------------------------- Server -------------------------------- */

test('DB: Migration 3 legt settings-Tabelle an', () => {
  assert.equal(SCHEMA_STAND, 6);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'settings'").get());
});

test('Server: /api/omlx ohne Session → 401', async () => {
  for (const [method, url] of [
    ['GET', `${base}/api/omlx`],
    ['PUT', `${base}/api/omlx`],
    ['POST', `${base}/api/omlx/test`],
    ['GET', `${base}/api/ki/status`],
  ]) {
    const r = await fetch(url, { method });
    assert.equal(r.status, 401, `${method} ${url}`);
  }
});

test('Server: GET /api/omlx ohne Konfiguration', async () => {
  const r = await fetch(`${base}/api/omlx`, { headers: headers() });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { url: null, key_gegeben: false, key_maskiert: null, quelle: null });
});

test('Server: PUT /api/omlx speichert, GET maskiert den Schlüssel', async () => {
  const put = await fetch(`${base}/api/omlx`, {
    method: 'PUT',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ url: fakeOmlx.url, key: OMLX_KEY }),
  });
  assert.equal(put.status, 200);

  const get = await (await fetch(`${base}/api/omlx`, { headers: headers() })).json();
  assert.equal(get.url, fakeOmlx.url);
  assert.equal(get.key_gegeben, true);
  assert.equal(get.key_maskiert, 'omlx-t…1234'); // slice(0,6) + '…' + slice(-4)
  assert.equal(get.quelle, 'einstellungen');
  assert.ok(!JSON.stringify(get).includes(OMLX_KEY.slice(6, -4)), 'Schlüssel nie im Klartext');
});

test('Server: PUT mit ungültiger URL → 400', async () => {
  const r = await fetch(`${base}/api/omlx`, {
    method: 'PUT',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'kein-url-text', key: '' }),
  });
  assert.equal(r.status, 400);
});

test('Server: PUT mit leerem Schlüssel behält den gespeicherten', async () => {
  await fetch(`${base}/api/omlx`, {
    method: 'PUT',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ url: fakeOmlx.url, key: 'neuer-key' }),
  });
  await fetch(`${base}/api/omlx`, {
    method: 'PUT',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ url: fakeOmlx.url, key: '' }),
  });
  const get = await (await fetch(`${base}/api/omlx`, { headers: headers() })).json();
  assert.equal(get.key_gegeben, true);
  assert.equal(get.key_maskiert, 'neuer-…-key'); // slice(0,6) + '…' + slice(-4)
  // zurück auf den Test-Key
  await fetch(`${base}/api/omlx`, {
    method: 'PUT',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({ url: fakeOmlx.url, key: OMLX_KEY }),
  });
});

test('Server: POST /api/omlx/test gegen Fake-OMLX → ok', async () => {
  const r = await fetch(`${base}/api/omlx/test`, {
    method: 'POST',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({}), // leere Felder → gespeicherte Konfiguration testen
  });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.ok, true);
  assert.deepEqual(s.modelle, ['qwen3.8-27b-mlx-4bit']);
});

test('Server: GET /api/ki/status nutzt die gespeicherte Konfiguration', async () => {
  const s = await (await fetch(`${base}/api/ki/status`, { headers: headers() })).json();
  assert.equal(s.ok, true);
  assert.match(s.meldung, /erreichbar/);
});

test('Server: KI-Status ohne Konfiguration → aussagekräftige Meldung', async () => {
  setSetting(db, 'omlx_url', null);
  setSetting(db, 'omlx_key', null);
  const s = await (await fetch(`${base}/api/ki/status`, { headers: headers() })).json();
  assert.equal(s.ok, false);
  assert.equal(s.grund, 'nicht_konfiguriert');
  assert.match(s.meldung, /Einstellungen/);
});
