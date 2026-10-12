/* ==========================================================================
   HammerClassify — P1-Tests (node:test)
   - DB: Migrations, Sessions, Passkeys
   - Auth: WebAuthn-Registrierung + Login mit kryptografisch gültigen,
     selbst erzeugten Authenticator-Antworten (ECDSA P-256, COSE Key)
   - Server: Security-Header, Health, Auth-State
   ========================================================================== */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCBOR } from '@levischuck/tiny-cbor';

import { openDb, createNutzer, addPasskey, createSession, getSessionByToken, deleteSessionByToken, deleteSessionsExceptPasskey, countPasskeys, getPasskeysForUser } from '../src/db.js';
import * as auth from '../src/auth.js';
import { createApp } from '../src/server.js';

/* ------------------- Fake-Authenticator (WebAuthn) --------------------- */
/* Erzeugt strukturell und kryptografisch gültige WebAuthn-Antworten:
   ECDSA P-256, COSE-Key, attestationFormat "none" — wie ein echter
   Platform-Authenticator, ohne Browser. */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function coseKeyFromJwk(jwk) {
  const key = new Map();
  key.set(1, 2); // kty: EC2
  key.set(3, 1); // alg: ES256
  key.set(-1, new Uint8Array(Buffer.from(jwk.x, 'base64url')));
  key.set(-2, new Uint8Array(Buffer.from(jwk.y, 'base64url')));
  return key;
}

function makeAuthPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { publicKey, privateKey, jwk };
}

function clientDataJSON(type, challengeB64url, origin) {
  return Buffer.from(JSON.stringify({ type, challenge: challengeB64url, origin, crossOrigin: false }));
}

function fakeRegistrationResponse({ rpId, origin, challengeB64url, credId, pair, aaguid }) {
  const rpIdHash = sha256(Buffer.from(rpId, 'ascii'));
  const credIdBuf = Buffer.from(credId);
  const authData = Buffer.concat([
    rpIdHash,
    Buffer.from([0x41]), // UP | AT
    Buffer.from(aaguid),
    credIdBuf.length.toString(16).padStart(8, '0').match(/../g).reverse().map((h) => parseInt(h, 16)),
    credIdBuf,
    Buffer.from(encodeCBOR(coseKeyFromJwk(pair.jwk))),
  ]);
  const attestationObject = Buffer.from(
    encodeCBOR({ fmt: 'none', authData: new Uint8Array(authData), sig: null, x509c: null })
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
  const authData = Buffer.concat([
    rpIdHash,
    Buffer.from([0x01]), // UP
    Buffer.from([0, 0, 0, signCount]),
  ]);
  const cd = clientDataJSON('webauthn.get', challengeB64url, origin);
  const sig = crypto.sign('sha256', Buffer.concat([authData, sha256(cd)]), pair.privateKey, {
    dsaEncoding: 'ieee-p1363',
  });
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

/* ------------------------------- Tests --------------------------------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hammerclassify-test-'));
let db, config;

before(() => {
  db = openDb(tmp);
  config = {
    port: 0,
    host: '127.0.0.1',
    rpId: 'localhost',
    rpName: 'HammerClassify',
    setupToken: 'test-token-1234567890-xyz',
    sessionDays: 30,
    dataDir: tmp,
    origin: 'http://localhost:3014',
    db,
  };
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('DB: Schema-Migration legt Tabellen an', () => {
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  assert.equal(v, 1);
  for (const t of ['users', 'passkeys', 'sessions']) {
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE name = '${t}'`).get(), t);
  }
});

test('DB: Session-Lebenszyklus', () => {
  const uid = createNutzer(db, 'Test');
  const token = createSession(db, { userId: uid, passkeyId: null, days: 30 });
  assert.ok(getSessionByToken(db, token));
  assert.equal(getSessionByToken(db, 'falsch'), null);
  deleteSessionByToken(db, token);
  assert.equal(getSessionByToken(db, token), null);
});

test('Auth: Registrierung nur im Erststart oder mit SETUP_TOKEN', async () => {
  const erst = await auth.registrationOptions({ config, setupToken: undefined });
  assert.ok(erst.allowed, 'Erststart darf registrieren');
  // einen Passkey anlegen
  const uid = db.prepare('SELECT * FROM users LIMIT 1').get()?.id ?? createNutzer(db, 'Micha');
  addPasskey(db, uid, { credentialId: 'x'.repeat(32), publicKey: Buffer.from('02000'), signCount: 0 });
  const zweiter = await auth.registrationOptions({ config, setupToken: undefined });
  assert.equal(zweiter.allowed, false, 'ohne Token gesperrt');
  const notfall = await auth.registrationOptions({ config, setupToken: config.setupToken });
  assert.ok(notfall.allowed, 'mit SETUP_TOKEN (Notfall) erlaubt');
});

test('Auth: vollständige Registrierung + Login + Session', async () => {
  const fresh = openDb(tmp); // eigener Handle, gleicher Stand
  const cfg = { ...config, db: fresh };
  const uid = createNutzer(fresh, 'Micha');

  // Registrierung
  const pair = makeAuthPair();
  const credId = crypto.randomBytes(16).toString('base64url');
  const regOpts = await auth.registrationOptions({ config: cfg, setupToken: cfg.setupToken });
  const regResp = fakeRegistrationResponse({
    rpId: cfg.rpId, origin: cfg.origin,
    challengeB64url: regOpts.options.challenge,
    credId, pair, aaguid: crypto.randomBytes(32).toString('hex'),
  });
  const reg = await auth.finishRegistration({ config: cfg, expectedOptions: regOpts.options, response: regResp });
  assert.ok(reg.ok, 'Registrierung verifiziert');
  assert.equal(countPasskeys(fresh), 1);

  // Login
  const authOpts = await auth.authenticationOptions({ config: cfg });
  assert.ok(authOpts.allowed);
  const authResp = fakeAuthenticationResponse({
    rpId: cfg.rpId, origin: cfg.origin,
    challengeB64url: authOpts.options.challenge,
    credId, pair, signCount: 1,
  });
  const login = await auth.finishAuthentication({ config: cfg, expectedOptions: authOpts.options, response: authResp });
  assert.ok(login.ok, `Login verifiziert (${login.fehler ?? ''})`);
  assert.ok(login.token);

  // Session
  const s = auth.checkSession(cfg, login.token);
  assert.ok(s.ok);
  assert.equal(s.userId, uid);
  assert.ok(s.passkeyId);

  // Falsche Signatur wird abgewiesen
  const badPair = makeAuthPair();
  const badResp = fakeAuthenticationResponse({
    rpId: cfg.rpId, origin: cfg.origin,
    challengeB64url: authOpts.options.challenge,
    credId, pair: badPair, signCount: 2,
  });
  const bad = await auth.finishAuthentication({ config: cfg, expectedOptions: authOpts.options, response: badResp });
  assert.equal(bad.ok, false, 'falscher Schlüssel muss scheitern');

  fresh.close();
});

test('Auth: logout-others entfernt nur fremde Sitzungen', () => {
  const uid = createNutzer(db, 'Test2');
  const pk = addPasskey(db, uid, { credentialId: 'y'.repeat(32), publicKey: Buffer.from('02'), signCount: 0 });
  const t1 = createSession(db, { userId: uid, passkeyId: pk, days: 30 });
  const t2 = createSession(db, { userId: uid, passkeyId: null, days: 30 });
  const s1 = getSessionByToken(db, t1);
  const n = deleteSessionsExceptPasskey(db, uid, s1.passkey_id);
  assert.equal(n, 1);
  assert.ok(getSessionByToken(db, t1));
  assert.equal(getSessionByToken(db, t2), null);
});

test('Server: Security-Header, Health, Auth-State', async () => {
  const app = createApp(config);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), true);
  assert.ok(health.headers.get('strict-transport-security'));
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

  const state = await (await fetch(`${base}/api/auth/state`)).json();
  assert.equal(typeof state.eingerichtet, 'boolean');
  assert.equal(state.angemeldet, false);

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /HammerClassify/);

  // CSRF: fremde Origin bei POST
  const csrf = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { origin: 'https://fremd.example' },
  });
  assert.equal(csrf.status, 403);

  server.close();
});
