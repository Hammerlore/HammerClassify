/* ==========================================================================
   HammerClassify — Server (P1: Gerüst)
   Bind auf 127.0.0.1, erreichbar nur über den Cloudflare-Tunnel.
   CSP: default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'
   ========================================================================== */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { loadEnv, validateEnv, APP_ROOT } from './env.js';
import { openDb, deleteSession, deleteSessionsExceptPasskey } from './db.js';
import * as auth from './auth.js';

export function createApp(config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Sicherheit: CSP, HSTS, frame-ancestors (konzept.md §Security-First)
  app.use((req, res, next) => {
    res.set('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'");
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  // Schreibende Anfragen nur von eigener Origin
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (!auth.sameOrigin(req, config)) {
      return res.status(403).json({ fehler: 'Fremde Origin' });
    }
    next();
  });

  /* ------------------------------ API ---------------------------------- */

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, app: 'hammerclassify', version: '0.2.0' });
  });

  // Zustand: ist ein Passkey eingerichtet? Ist die Session gültig?
  app.get('/api/auth/state', (req, res) => {
    const eingerichtet = config.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n > 0;
    const session = auth.checkSession(config, req.cookies?.[auth.COOKIE_NAME] ?? cookieFromHeader(req));
    res.json({
      eingerichtet,
      angemeldet: session.ok,
      sessionTage: config.sessionDays,
    });
  });

  app.post('/api/auth/register/options', async (req, res) => {
    const { allowed, options, reason } = await auth.registrationOptions({
      config,
      setupToken: req.get('x-setup-token'),
    });
    if (!allowed) return res.status(403).json({ fehler: `Registrierung gesperrt: ${reason}` });
    res.json(options);
  });

  app.post('/api/auth/register/finish', async (req, res) => {
    const { expectedOptions, response } = req.body ?? {};
    if (!expectedOptions?.challenge || !response) {
      return res.status(400).json({ fehler: 'expectedOptions/response fehlen' });
    }
    const r = await auth.finishRegistration({ config, expectedOptions, response });
    if (!r.ok) return res.status(400).json({ fehler: r.fehler });
    res.json({ ok: true });
  });

  app.post('/api/auth/login/options', async (req, res) => {
    const { allowed, options, reason } = await auth.authenticationOptions({ config });
    if (!allowed) return res.status(403).json({ fehler: `Anmeldung gesperrt: ${reason}` });
    res.json(options);
  });

  app.post('/api/auth/login/finish', async (req, res) => {
    const { expectedOptions, response } = req.body ?? {};
    if (!expectedOptions?.challenge || !response) {
      return res.status(400).json({ fehler: 'expectedOptions/response fehlen' });
    }
    const r = await auth.finishAuthentication({ config, expectedOptions, response });
    if (!r.ok) return res.status(401).json({ fehler: r.fehler });
    res.cookie(auth.COOKIE_NAME, r.token, auth.sessionCookieOptions(config));
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.[auth.COOKIE_NAME] ?? cookieFromHeader(req);
    if (token) deleteSessionByToken(config.db, token);
    res.clearCookie(auth.COOKIE_NAME, { httpOnly: true, sameSite: 'strict', secure: true, path: '/' });
    res.json({ ok: true });
  });

  // „Auf allen anderen Geräten abmelden“ (Muster aus Management)
  app.post('/api/auth/logout-others', (req, res) => {
    const token = req.cookies?.[auth.COOKIE_NAME] ?? cookieFromHeader(req);
    const session = auth.checkSession(config, token);
    if (!session.ok) return res.status(401).json({ fehler: 'Keine Sitzung' });
    const n = deleteSessionsExceptPasskey(config.db, session.userId, session.passkeyId);
    res.json({ ok: true, abgemeldet: n });
  });

  /* --------------------------- Statische Seite -------------------------- */

  const pub = path.join(APP_ROOT, 'public');
  app.use(express.static(pub, { index: 'index.html' }));

  // JSON-Fehler statt Express-Standard-HTML
  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ fehler: status >= 500 ? 'Interner Fehler' : err.message });
  });

  return app;
}

// Cookie-Auswertung ohne cookie-Paket
function cookieFromHeader(req) {
  const h = req.get('cookie');
  if (!h) return undefined;
  for (const part of h.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === auth.COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}

/* ------------------------------ Start ---------------------------------- */

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const config = loadEnv();
  const { ok, fehler } = validateEnv(config);
  if (!ok) {
    console.error('HammerClassify: .env unvollständig:');
    for (const f of fehler) console.error('  -', f);
    process.exit(1);
  }
  const fs_ = fs;
  fs_.mkdirSync(config.dataDir, { recursive: true });
  config.db = openDb(config.dataDir);
  const app = createApp(config);
  app.listen(config.port, config.host, () => {
    console.log(`HammerClassify auf http://${config.host}:${config.port} (nur Heimnetz)`);
  });
}
