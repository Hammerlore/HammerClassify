/* ==========================================================================
   HammerClassify — Server (P1: Gerüst, P2: Upload + Text)
   Bind auf 127.0.0.1, erreichbar nur über Apache im Heimnetz (classify.lan.hammerlore.de).
   CSP: default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'
   ========================================================================== */
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Busboy from 'busboy';
import { loadEnv, validateEnv, APP_ROOT } from './env.js';
import {
  openDb, deleteSession, deleteSessionByToken, deleteSessionsExceptPasskey,
  addDocument, getDocument, listDocuments, findDocumentBySha, deleteDocument,
  listRegeln, getRegel, addRegel, updateRegel, deleteRegel,
  REGEL_ARTEN, REGEL_BEDINGUNGEN, REGEL_ART_LABEL,
  saveKlassifizierung, bestaetigeKlassifizierung, ablehneKlassifizierung,
  getSetting, setSetting,
} from './db.js';
import * as auth from './auth.js';
import * as text from './text.js';
import { omlxKonfig, omlxPruefe, omlxKlassifiziere } from './omlx.js';
import { pruefeErgebnis, parseErgebnisText } from './ergebnis.js';
import { bauePrompt } from './prompt.js';

/* ------------------------------ Upload --------------------------------- */
const MAX_DATEI = 25 * 1024 * 1024; // konzept.md: Upload-Quoten 25 MB
const MAX_TEXT = 2_000_000; // Obergrenze für den gespeicherten Volltext
const ERLAUBTE_EXT = new Set(['pdf', 'docx', 'zip', 'txt', 'md']);
const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
};

export function createApp(config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Request-Log: Method, Pfad, Status, Dauer — damit sich nachvollziehen lässt,
  // was im Browser ausgelöst wurde (z. B. „Neu klassifizieren" ohne sichtbares
  // Ergebnis). Bewusst ohne PII: keine Body-Inhalte, keine Cookies.
  app.use('/api', (req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - t0} ms)`);
    });
    next();
  });

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

  // Dokumenten-Endpunkte verlangen eine gültige Session
  const requireSession = (req, res, next) => {
    const s = auth.checkSession(config, req.cookies?.[auth.COOKIE_NAME] ?? cookieFromHeader(req));
    if (!s.ok) return res.status(401).json({ fehler: 'Nicht angemeldet' });
    req.session = s;
    next();
  };

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

  /* --------------------------- Dokumente (P2) --------------------------- */

  // Listendarstellung: ohne Volltext, dafür kurze Vorschau (Suche/Preview).
  // Das Klassifizierungs-Ergebnis (JSON-String) wird geparst mitgeliefert —
  // die Liste zeigt Kategorien, Absender, Datum, Betrag, Konfidenz.
  const ohneText = (d) => {
    const { text: _text, klassifizierung, ...rest } = d;
    let ergebnis = null;
    if (klassifizierung) {
      try { ergebnis = JSON.parse(klassifizierung); } catch { ergebnis = null; }
    }
    return { ...rest, text_vorschau: d.text ? d.text.slice(0, 500) : null, klassifizierung: ergebnis };
  };

  const idFromParams = (req) => {
    const id = Number(req.params.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  // Upload: multipart (Feld „datei" + optional „text" für PDFs aus pdf.js)
  app.post('/api/documents', requireSession, (req, res, next) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_DATEI, fieldSize: 5 * 1024 * 1024, files: 1 },
    });
    let datei = null;
    let limitTreff = false;
    let textFeld;
    bb.on('file', (name, stream, info) => {
      if (name !== 'datei') {
        stream.resume();
        return;
      }
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => { limitTreff = true; });
      stream.on('end', () => {
        datei = { buffer: Buffer.concat(chunks), filename: info.filename };
      });
      stream.on('error', next);
    });
    bb.on('field', (name, value) => {
      if (name === 'text') textFeld = value;
    });
    bb.on('error', next);
    bb.on('close', async () => {
      try {
        if (!datei) return res.status(400).json({ fehler: 'Keine Datei (Feld „datei")' });
        if (limitTreff || datei.buffer.length > MAX_DATEI) {
          return res.status(413).json({ fehler: 'Datei zu groß (max. 25 MB)' });
        }
        const name = sanitizeName(datei.filename);
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (!ERLAUBTE_EXT.has(ext)) {
          return res.status(400).json({ fehler: `Dateityp nicht erlaubt: .${ext} (nur .pdf, .docx, .zip, .txt, .md)` });
        }
        // Deterministische Plausibilitätsprüfung, bevor etwas gespeichert wird
        if (ext === 'pdf' && !/^%PDF/.test(datei.buffer.subarray(0, 1024).toString('latin1').trimStart())) {
          return res.status(400).json({ fehler: 'Keine gültige PDF-Datei' });
        }
        if ((ext === 'docx' || ext === 'zip') && datei.buffer.subarray(0, 2).toString('latin1') !== 'PK') {
          return res.status(400).json({ fehler: `Kein gültiges ${ext.toUpperCase()}-Archiv` });
        }
        // Klartext-Typen: Null-Bytes = binärer Inhalt, keine Textdatei
        if ((ext === 'txt' || ext === 'md') && datei.buffer.includes(0)) {
          return res.status(400).json({ fehler: 'Keine Textdatei — binärer Inhalt (.txt/.md sind Klartext)' });
        }
        const sha = crypto.createHash('sha256').update(datei.buffer).digest('hex');
        const doppel = findDocumentBySha(config.db, sha);
        if (doppel) {
          return res.json({ ...ohneText(doppel), doppelung: true });
        }
        fs.mkdirSync(config.dokDir, { recursive: true });
        fs.writeFileSync(path.join(config.dokDir, `${sha.slice(0, 16)}.${ext}`), datei.buffer, { mode: 0o600 });
        let textInhalt = '';
        try {
          if (ext === 'docx') textInhalt = await text.extractDocxText(datei.buffer);
          else if (ext === 'zip') textInhalt = await text.extractZipText(datei.buffer);
          else if (ext === 'pdf') textInhalt = (textFeld ?? '').trim();
          else textInhalt = datei.buffer.toString('utf8').trim(); // txt, md: Klartext direkt
        } catch {
          textInhalt = ''; // defektes/unvollständiges Archiv → manuell
        }
        if (textInhalt.length > MAX_TEXT) textInhalt = textInhalt.slice(0, MAX_TEXT);
        const textStatus = textInhalt ? 'ok' : 'kein_text';
        const dok = addDocument(config.db, {
          name, ext, mime: MIME[ext], size: datei.buffer.length, sha256: sha,
          text: textInhalt || null, textStatus,
        });
        res.status(201).json({ ...ohneText(dok), text_zeichen: textInhalt.length });
      } catch (e) {
        next(e);
      }
    });
    req.pipe(bb);
  });

  app.get('/api/documents', requireSession, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    res.json({ dokumente: listDocuments(config.db, { limit }).map(ohneText) });
  });

  app.get('/api/documents/:id', requireSession, (req, res) => {
    const id = idFromParams(req);
    const dok = id && getDocument(config.db, id);
    if (!dok) return res.status(404).json({ fehler: 'Dokument nicht gefunden' });
    res.json(dok); // mit Volltext
  });

  // Download: immer als Attachment, nie gerendert (konzept.md §Security-First 4)
  app.get('/api/documents/:id/download', requireSession, (req, res) => {
    const id = idFromParams(req);
    const dok = id && getDocument(config.db, id);
    if (!dok) return res.status(404).json({ fehler: 'Dokument nicht gefunden' });
    const pfad = path.join(config.dokDir, `${dok.sha256.slice(0, 16)}.${dok.ext}`);
    if (!fs.existsSync(pfad)) return res.status(404).json({ fehler: 'Datei fehlt auf dem Server' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${dok.name.replace(/"/g, '')}"`);
    fs.createReadStream(pfad).pipe(res);
  });

  app.delete('/api/documents/:id', requireSession, async (req, res, next) => {
    try {
      const id = idFromParams(req);
      const dok = id && getDocument(config.db, id);
      if (!dok) return res.status(404).json({ fehler: 'Dokument nicht gefunden' });
      deleteDocument(config.db, dok.id);
      // fs.promises.rm: fs.rm() ohne Callback crasht den Prozess (Node-Interner
      // rimraf ruft den undefined-Callback auf) — hier deterministisch warten.
      await fs.promises.rm(
        path.join(config.dokDir, `${dok.sha256.slice(0, 16)}.${dok.ext}`),
        { force: true },
      ).catch(() => {}); // Datei fehlt → egal
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  /* ------------------------------ OMLX (KI) ------------------------------ */
  // Konfiguration: DB-Einstellungen (UI) überschreiben die .env-Werte.
  // Der Schlüssel wird nie im Klartext zurückgegeben, nur maskiert.

  app.get('/api/omlx', requireSession, (req, res) => {
    const { url, key, quelle } = omlxKonfig(config, config.db);
    res.json({
      url: url || null,
      key_gegeben: !!key,
      key_maskiert: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null,
      quelle, // 'einstellungen' | 'env' | null
    });
  });

  app.put('/api/omlx', requireSession, (req, res) => {
    const { url, key } = req.body ?? {};
    if (typeof url !== 'string' || typeof key !== 'string') {
      return res.status(400).json({ fehler: '„url“ und „key“ (String) werden erwartet' });
    }
    const u = url.trim();
    if (u) {
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return res.status(400).json({ fehler: 'URL muss mit http:// oder https:// beginnen' });
        }
      } catch {
        return res.status(400).json({ fehler: 'URL ungültig — z. B. https://omlx.lan.hammerlore.de:8443' });
      }
    }
    setSetting(config.db, 'omlx_url', u || null);
    // Leerer Schlüssel = gespeicherter Wert bleibt (konsistent mit dem Test)
    if (key.trim()) setSetting(config.db, 'omlx_key', key.trim());
    res.json({ ok: true });
  });

  // Verbindungstest: eingegebene Werte testen (leeres Feld = gespeicherter/.env-Wert bleibt).
  app.post('/api/omlx/test', requireSession, async (req, res) => {
    const { url, key } = req.body ?? {};
    const eff = omlxKonfig(config, config.db);
    const zuTesten = {
      url: (typeof url === 'string' && url.trim()) ? url.trim() : eff.url,
      key: (typeof key === 'string' && key.trim()) ? key.trim() : eff.key,
    };
    res.json(await omlxPruefe(zuTesten.url, zuTesten.key));
  });

  /* ------------------------------ KI-Status ----------------------------- */
  // OMLX-Ping mit Timeout-Strategie aus konzept.md (definiert „KI nicht erreichbar")

  app.get('/api/ki/status', requireSession, async (req, res) => {
    const { url, key } = omlxKonfig(config, config.db);
    res.json(await omlxPruefe(url, key));
  });

  /* ------------------------------ Regeln (P3) ---------------------------- */
  // Regeln sind Daten, kein Code (konzept.md): CRUD gegen die DB.
  // Die Validierung ist strikt: die Regeln fließen in den KI-Prompt und in
  // die Schema-Prüfung — Schmutz hier vergiftet die Klassifizierung.

  const regelFelder = (body) => {
    const fehler = [];
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const art = typeof body?.art === 'string' ? body.art.trim() : '';
    const beschreibung = typeof body?.beschreibung === 'string' ? body.beschreibung.trim() : '';
    let schluesselwoerter = [];
    if (Array.isArray(body?.schluesselwoerter)) {
      schluesselwoerter = body.schluesselwoerter.map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
    } else if (typeof body?.schluesselwoerter === 'string') {
      schluesselwoerter = body.schluesselwoerter.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    }
    const bedingung = body?.bedingung == null || body.bedingung === '' ? null : String(body.bedingung).trim();
    const beispiel = body?.beispiel == null || body.beispiel === '' ? null : String(body.beispiel).trim().slice(0, 1000);

    if (!name || name.length > 100) fehler.push('„name“: 1–100 Zeichen');
    if (!REGEL_ARTEN.includes(art)) fehler.push(`„art“: ${REGEL_ARTEN.join(' | ')}`);
    if (!beschreibung || beschreibung.length > 2000) fehler.push('„beschreibung“: 1–2000 Zeichen');
    if (bedingung && !REGEL_BEDINGUNGEN.includes(bedingung)) fehler.push(`„bedingung“: ${REGEL_BEDINGUNGEN.join(' | ')} oder leer`);
    if (bedingung && art === 'feld') fehler.push('„bedingung“: gilt nur für Kategorien und Dokumenttypen, nicht für Felder');
    return { fehler, werte: { name, art, beschreibung, schluesselwoerter, bedingung, beispiel } };
  };

  app.get('/api/rules', requireSession, (req, res) => {
    res.json({ regeln: listRegeln(config.db) });
  });

  app.post('/api/rules', requireSession, (req, res) => {
    const { fehler, werte } = regelFelder(req.body);
    if (fehler.length) return res.status(400).json({ fehler: fehler.join('; ') });
    // Doppelter Name (gleiche Art) → verwirrt die KI und die Schema-Prüfung
    const doppelt = listRegeln(config.db).some((r) => r.art === werte.art && r.name.toLowerCase() === werte.name.toLowerCase());
    if (doppelt) return res.status(409).json({ fehler: `Es gibt bereits eine Regel mit dem Namen „${werte.name}“ (${REGEL_ART_LABEL[werte.art] ?? werte.art})` });
    res.status(201).json({ regel: addRegel(config.db, werte) });
  });

  app.put('/api/rules/:id', requireSession, (req, res) => {
    const id = idFromParams(req);
    const vorher = id && getRegel(config.db, id);
    if (!vorher) return res.status(404).json({ fehler: 'Regel nicht gefunden' });
    const { fehler, werte } = regelFelder(req.body);
    if (fehler.length) return res.status(400).json({ fehler: fehler.join('; ') });
    const doppelt = listRegeln(config.db).some((r) => r.id !== id && r.art === werte.art && r.name.toLowerCase() === werte.name.toLowerCase());
    if (doppelt) return res.status(409).json({ fehler: `Es gibt bereits eine Regel mit dem Namen „${werte.name}“ (${REGEL_ART_LABEL[werte.art] ?? werte.art})` });
    res.json({ regel: updateRegel(config.db, id, werte) });
  });

  app.delete('/api/rules/:id', requireSession, (req, res) => {
    const id = idFromParams(req);
    if (!id || !deleteRegel(config.db, id)) return res.status(404).json({ fehler: 'Regel nicht gefunden' });
    res.json({ ok: true });
  });

  // Export: das Regel-Set als JSON-Datei. Als Attachment vom Server, nicht als
  // blob: im Browser — die CSP erlaubt blob: nur in img-src.
  app.get('/api/rules/export', requireSession, (req, res) => {
    const alle = listRegeln(config.db);
    const payload = { app: 'hammerclassify', art: 'regeln', version: 1, exportiert: new Date().toISOString(), regeln: alle };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hammerclassify-regeln-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(payload, null, 2));
  });

  // Import: Upsert pro (art, name) — Start-Set oder Backup in einem Rutsch.
  // Ungültige Einträge werden mit Grund verworfen, nie schlägt der ganze Import fehl.
  app.post('/api/rules/import', requireSession, (req, res) => {
    const liste = Array.isArray(req.body?.regeln) ? req.body.regeln : null;
    if (!liste || !liste.length) return res.status(400).json({ fehler: '„regeln“: nicht leere Liste erwartet' });
    if (liste.length > 200) return res.status(400).json({ fehler: 'Maximal 200 Regeln pro Import' });
    const aktuell = listRegeln(config.db);
    let importiert = 0;
    let aktualisiert = 0;
    const verworfen = [];
    for (const roh of liste) {
      const { fehler, werte } = regelFelder(roh);
      if (fehler.length) {
        const name = typeof roh?.name === 'string' && roh.name.trim() ? roh.name.trim().slice(0, 100) : '(ohne Namen)';
        verworfen.push({ name, fehler: fehler.join('; ') });
        continue;
      }
      const idx = aktuell.findIndex((r) => r.art === werte.art && r.name.toLowerCase() === werte.name.toLowerCase());
      if (idx >= 0) {
        aktuell[idx] = updateRegel(config.db, aktuell[idx].id, werte);
        aktualisiert++;
      } else {
        aktuell.push(addRegel(config.db, werte));
        importiert++;
      }
    }
    res.json({ importiert, aktualisiert, verworfen });
  });

  /* --------------------------- Inhaber-Profil (P3) ------------------------ */
  // Dient der Bedingung `eigener_name_adresse` (deterministisch geprüft) und
  // erscheint im Prompt verallgemeinert. Nie im Repo: DB auf dem hammerpi.

  const INHABER_LEER = { name: '', adresse: '', kundennummer: '' };

  const inhaberLesen = () => {
    try {
      const p = JSON.parse(getSetting(config.db, 'inhauber_profil') ?? '');
      return {
        name: typeof p?.name === 'string' ? p.name : '',
        adresse: typeof p?.adresse === 'string' ? p.adresse : '',
        kundennummer: typeof p?.kundennummer === 'string' ? p.kundennummer : '',
      };
    } catch {
      return { ...INHABER_LEER };
    }
  };

  app.get('/api/inhaber', requireSession, (req, res) => {
    res.json({ inhaber: inhaberLesen() });
  });

  app.put('/api/inhaber', requireSession, (req, res) => {
    const b = req.body ?? {};
    const str = (x, max) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
    const inhaber = {
      name: str(b.name, 150),
      adresse: str(b.adresse, 300),
      kundennummer: str(b.kundennummer, 60),
    };
    const leer = !inhaber.name && !inhaber.adresse && !inhaber.kundennummer;
    setSetting(config.db, 'inhauber_profil', leer ? null : JSON.stringify(inhaber));
    res.json({ ok: true, inhaber });
  });

  /* ------------------- Klassifizierung (P3): KI + Freigabe ---------------- */
  // Die KI schlägt vor, der Mensch entscheidet (konzept.md):
  //   klassifizieren → Vorschlag speichern (Status einzukategorisieren)
  //   bestaetigen    → finale Tags (Status klassifiziert)
  //   ablehnen       → Vorschlag verwerfen (Status eingang)

  app.post('/api/documents/:id/klassifizieren', requireSession, async (req, res, next) => {
    try {
      const id = idFromParams(req);
      const dok = id && getDocument(config.db, id);
      if (!dok) return res.status(404).json({ fehler: 'Dokument nicht gefunden' });
      if (!dok.text) {
        return res.status(409).json({ fehler: 'Kein Text im Dokument — Klassifizierung nur mit Volltext möglich (Scan? OCR kommt mit V2)' });
      }

      const regeln = listRegeln(config.db);
      if (!regeln.length) {
        // Ohne Regel-Set kann die KI keine gültigen Tags ausgeben — der KI-Aufruf
        // (bis zu 120 s) wäre vergeblich, das Ergebnis würde komplett verworfen.
        return res.status(409).json({ fehler: 'Keine Regeln gepflegt — zuerst im Reiter „Regeln" anlegen oder per Import laden' });
      }

      const { url, key } = omlxKonfig(config, config.db);
      if (!url || !key) {
        return res.status(409).json({ fehler: 'KI nicht konfiguriert — OMLX-URL und Schlüssel in den Einstellungen hinterlegen' });
      }

      const inhaber = inhaberLesen();
      const { prompt } = bauePrompt({ volltext: dok.text, regeln, inhaber });

      const ki = await omlxKlassifiziere(url, key, prompt);
      if (!ki.ok) {
        // Definierter Zustand „KI nicht erreichbar“ — Dokument bleibt, wo es ist.
        // Die Meldung soll klarmachen, dass der Versuch stattgefunden hat.
        return res.status(503).json({ fehler: `KI gerade nicht erreichbar: ${ki.meldung} — das Dokument bleibt, wie es ist. Bitte später erneut versuchen.`, ki });
      }

      const { objekt, fehler: parseFehler } = parseErgebnisText(ki.inhalt);
      if (!objekt) {
        return res.status(422).json({ fehler: `KI-Antwort unbrauchbar: ${parseFehler}`, ki });
      }

      const { ok, ergebnis, verworfen, fehler: strukturell } = pruefeErgebnis(objekt, {
        regeln, volltext: dok.text, inhaber,
      });
      if (!ok) {
        // Achtung: „fehler" doppelt im Objekt-Literal würde die Meldung
        // überschreiben (Shorthand gewinnt) — der Client wirft data.fehler.
        return res.status(422).json({
          fehler: 'KI-Ergebnis nach Prüfung leer — nichts verwertbar',
          verworfen, strukturell, ki,
        });
      }

      saveKlassifizierung(config.db, dok.id, { ...ergebnis, verworfen });
      res.json({ dokument: ohneText(getDocument(config.db, dok.id)), verworfen, ki });
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/documents/:id/bestaetigen', requireSession, (req, res) => {
    const id = idFromParams(req);
    const dok = id && getDocument(config.db, id);
    if (!dok) return res.status(404).json({ fehler: 'Dokument nicht gefunden' });
    if (!dok.klassifizierung) {
      return res.status(409).json({ fehler: 'Kein Vorschlag vorhanden — zuerst klassifizieren' });
    }
    bestaetigeKlassifizierung(config.db, dok.id);
    res.json({ dokument: ohneText(getDocument(config.db, dok.id)) });
  });

  app.post('/api/documents/:id/ablehnen', requireSession, (req, res) => {
    const id = idFromParams(req);
    const dok = id && getDocument(config.db, id);
    if (!dok) return res.status(404).json({ fehler: 'Dokument nicht gefunden' });
    ablehneKlassifizierung(config.db, dok.id);
    res.json({ dokument: ohneText(getDocument(config.db, dok.id)) });
  });

  /* --------------------------- Statische Seite -------------------------- */

  const pub = path.join(APP_ROOT, 'public');
  app.use(express.static(pub, { index: 'index.html' }));

  // pdf.js für die Browser-Textextraktion (konzept.md: lokal ausgeliefert)
  app.use('/vendor/pdfjs', express.static(path.join(APP_ROOT, 'node_modules/pdfjs-dist/build')));

  // JSON-Fehler statt Express-Standard-HTML
  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ fehler: status >= 500 ? 'Interner Fehler' : err.message });
  });

  return app;
}

// Dateiname bereinigen: nur Basisname (kein Pfad), sichere Zeichen, Länge begrenzt.
// Das Display-Name — die Datei auf Platte heißt immer <sha256-16>.<ext>.
function sanitizeName(name) {
  const basis = (name || 'datei').replace(/\\/g, '/').split('/').pop()
    .replace(/[^\w.\- äöüßÄÖÜ]/g, '_').trim();
  return (basis || 'datei').slice(0, 150);
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

// Nur starten, wenn direkt aufgerufen (npm start) oder unter pm2 — nicht bei Import in Tests.
// argv[1] ist relativ („src/server.js“): gegen CWD auflösen, sonst passt der Vergleich nie.
// Unter pm2 (fork) lädt der Agent das Skript per import() — argv[1] zeigt dann auf den
// pm2-Agenten, darum PM2_HOME als zweiter Marker.
const direkt = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (direkt || process.env.PM2_HOME) {
  const config = loadEnv();
  const { ok, fehler } = validateEnv(config);
  if (!ok) {
    console.error('HammerClassify: .env unvollständig:');
    for (const f of fehler) console.error('  -', f);
    process.exit(1);
  }
  const fs_ = fs;
  fs_.mkdirSync(config.dataDir, { recursive: true });
  fs_.mkdirSync(config.dokDir, { recursive: true });
  config.db = openDb(config.dataDir);
  const app = createApp(config);
  app.listen(config.port, config.host, () => {
    console.log(`HammerClassify auf http://${config.host}:${config.port} (nur Heimnetz)`);
  });
}
