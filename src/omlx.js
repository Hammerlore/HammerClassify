/* ==========================================================================
   HammerClassify — OMLX (KI-Backend, Qwen3.8-27B-MLX-4bit)
   Prüft die Verbindung und übersetzt jede Fehlerart in eine aussagekräftige
   Meldung (konzept.md: „KI-Abhängigkeit kontrolliert").
   Konfiguration: die DB (Einstellungen) überschreibt die .env-Werte.
   ========================================================================== */
import { getSetting } from './db.js';

export const OMLX_TIMEOUT = 10_000; // konzept.md: definiert den Zustand „KI nicht erreichbar"

/* Klassifizierung (konzept.md: „Max. 2 Versuche, 120 s"): 27B auf 128k-Kontext
   braucht Zeit — der Timeout ist großzügig, die Versuche begrenzt. */
export const OMLX_KLASSIFIZIERUNG_TIMEOUT = 120_000;
export const OMLX_MAX_VERSUCHE = 2;
export const OMLX_MODELL = 'Qwen3.8-27B-MLX-4bit';

/**
 * Effektive OMLX-Konfiguration: DB-Einstellungen schlagen die .env-Werte.
 * @returns {{url: string, key: string, quelle: 'einstellungen'|'env'|null}}
 */
export function omlxKonfig(config, db) {
  const dbUrl = db ? getSetting(db, 'omlx_url') : null;
  const dbKey = db ? getSetting(db, 'omlx_key') : null;
  const url = (dbUrl ?? config.omlxUrl ?? '').trim();
  const key = (dbKey ?? config.omlxKey ?? '').trim();
  const quelle = dbUrl || dbKey ? 'einstellungen' : url || key ? 'env' : null;
  return { url, key, quelle };
}

/**
 * Verbindung zu OMLX prüfen (GET /v1/models) und Ergebnis mit aussagekräftiger
 * Meldung zurückgeben.
 * @returns {Promise<{ok: boolean, grund: string, meldung: string, ms: number, modelle?: string[]}>}
 */
export async function omlxPruefe(url, key) {
  const t0 = Date.now();
  const fertig = (ok, grund, meldung, extra = {}) => ({
    ok, grund, meldung, ms: Date.now() - t0, ...extra,
  });

  if (!url) {
    return fertig(false, 'nicht_konfiguriert',
      'OMLX ist nicht konfiguriert. Bitte in den Einstellungen die URL (und bei Bedarf den Schlüssel) hinterlegen.');
  }

  let u;
  try {
    u = new URL(url);
  } catch {
    return fertig(false, 'ungueltige_url',
      `„${url}“ ist keine gültige URL — erwartet wird z. B. https://omlx.lan.hammerlore.de:8443`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return fertig(false, 'ungueltige_url',
      `Protokoll „${u.protocol}“ wird nicht unterstützt — http:// oder https:// verwenden.`);
  }

  const ziel = `${u.origin}${u.pathname === '/' ? '' : u.pathname}/v1/models`;
  try {
    const r = await fetch(ziel, {
      headers: { authorization: `Bearer ${key ?? ''}` },
      signal: AbortSignal.timeout(OMLX_TIMEOUT),
    });
    const ms = Date.now() - t0;
    if (r.status === 401) {
      return fertig(false, 'key_ungueltig',
        `Verbindung steht, aber der Schlüssel wurde abgelehnt (HTTP 401). Schlüssel in den Einstellungen prüfen.`);
    }
    if (r.status === 404) {
      return fertig(false, 'pfad_falsch',
        `OMLX antwortet, aber ${u.pathname || '/'}v1/models existiert nicht (HTTP 404) — URL ohne zusätzlichen Pfad angeben.`);
    }
    if (!r.ok) {
      return fertig(false, `http_${r.status}`, `OMLX antwortet mit HTTP ${r.status}.`);
    }
    let modelle = [];
    try {
      const data = await r.json();
      modelle = (data.data ?? []).map((m) => m.id).filter(Boolean);
    } catch { /* Antwort ohne JSON — die Verbindung steht, das genügt */ }
    return fertig(true, 'ok',
      modelle.length ? `OMLX erreichbar (${ms} ms) — Modelle: ${modelle.join(', ')}`
        : `OMLX erreichbar (${ms} ms) — aktuell sind keine Modelle geladen.`,
      { modelle });
  } catch (e) {
    return fertig(false, grundVonFehler(e, u), meldungVonFehler(e, u));
  }
}

/**
 * Klassifizierungs-Aufruf: POST /v1/chat/completions (OpenAI-kompatibel),
 * JSON-Modus, Temperatur 0. Max. 2 Versuche bei Timeout/Verbindungsfehler
 * (konzept.md: „Timeout- und Retry-Strategie, Max. 2 Versuche, 120 s").
 * @returns {Promise<{ok: boolean, grund: string, meldung: string, inhalt?: string, ms: number}>}
 */
export async function omlxKlassifiziere(url, key, prompt, model = OMLX_MODELL) {
  const t0 = Date.now();
  const fertig = (ok, grund, meldung, extra = {}) => ({
    ok, grund, meldung, ms: Date.now() - t0, ...extra,
  });

  let u;
  try {
    u = new URL(url);
  } catch {
    return fertig(false, 'ungueltige_url', `„${url}“ ist keine gültige URL — OMLX in den Einstellungen prüfen.`);
  }

  const ziel = `${u.origin}${u.pathname === '/' ? '' : u.pathname}/v1/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system', content: 'Du bist ein Dokumenten-Klassifizierer. Antworte ausschließlich mit einem JSON-Objekt.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 4096,
  };

  let letzter = { grund: 'verbindung', meldung: 'Keine Verbindung' };
  for (let versuch = 1; versuch <= OMLX_MAX_VERSUCHE; versuch++) {
    try {
      const r = await fetch(ziel, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key ?? ''}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OMLX_KLASSIFIZIERUNG_TIMEOUT),
      });
      if (r.status === 401) {
        return fertig(false, 'key_ungueltig', 'OMLX hat den Schlüssel abgelehnt (HTTP 401) — in den Einstellungen prüfen.');
      }
      if (r.status === 400) {
        let detail = '';
        try { detail = (await r.json())?.error?.message ?? ''; } catch { /* rohe Antwort */ }
        return fertig(false, 'anfrage_abgelehnt', `OMLX hat die Anfrage abgelehnt (HTTP 400): ${detail || 'Details unbekannt'}`);
      }
      if (!r.ok) {
        // 5xx: Modell lädt neu / Server überlastet → nächster Versuch
        letzter = { grund: `http_${r.status}`, meldung: `OMLX antwortet mit HTTP ${r.status}.` };
        if (r.status < 500) return fertig(false, letzter.grund, letzter.meldung);
        continue;
      }
      const data = await r.json();
      const inhalt = data?.choices?.[0]?.message?.content ?? '';
      if (!inhalt.trim()) {
        return fertig(false, 'leere_antwort', 'OMLX hat geantwortet, aber ohne Inhalt.');
      }
      return fertig(true, 'ok', `Klassifizierung fertig (${Date.now() - t0} ms).`, { inhalt });
    } catch (e) {
      // Timeout / Netzwerk: letzter Versuch, dann „KI nicht erreichbar"
      letzter = { grund: grundVonFehler(e, u), meldung: meldungVonFehler(e, u) };
      if (versuch < OMLX_MAX_VERSUCHE) {
        await new Promise((r) => setTimeout(r, 2_000)); // kurze Pause vor dem Retry
      }
    }
  }
  return fertig(false, letzter.grund, `${letzter.meldung} (nach ${OMLX_MAX_VERSUCHE} Versuchen)`);
}

function grundVonFehler(e, u) {
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout';
  const code = e.cause?.code ?? e.code ?? '';
  const text = `${code} ${e.cause?.message ?? ''} ${e.message}`;
  if (/bad port/i.test(text)) return 'ungueltige_url'; // undici blockiert bestimmte Ports (1, 25, 80, …)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED') return 'abgelehnt';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'verbindung';
  if (String(code).startsWith('ERR_TLS') || /certificate|ssl|tls/i.test(e.message)) return 'tls';
  return 'verbindung';
}

function meldungVonFehler(e, u) {
  const ziel = `${u.host}${u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : ''}`;
  const code = e.cause?.code ?? e.code ?? '';
  if (grundVonFehler(e, u) === 'ungueltige_url') {
    return `Port ${u.port} wird vom HTTP-Client blockiert — einen anderen Port verwenden.`;
  }
  switch (grundVonFehler(e, u)) {
    case 'timeout':
      return `Keine Antwort von ${u.host} innerhalb von ${OMLX_TIMEOUT / 1000} s — OMLX hängt, ist überlastet oder der Port ist blockiert.`;
    case 'dns':
      return `Host „${u.hostname}“ konnte nicht aufgelöst werden (DNS${code ? `: ${code}` : ''}) — läuft der Pi mit OMLX im selben Netz?`;
    case 'abgelehnt':
      return `Keine Verbindung zu ${ziel} (abgelehnt) — läuft OMLX dort?`;
    case 'tls':
      return `TLS-Fehler bei der Verbindung zu ${u.host} (${code || e.message}) — Zertifikat oder Port prüfen.`;
    default:
      return `Keine Verbindung zu ${u.host} (${code || e.message}).`;
  }
}
