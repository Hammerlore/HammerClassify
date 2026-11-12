/* ==========================================================================
   HammerClassify — Klassifizierungsergebnis (Browser UND Server)
   Dieselbe Datei auf beiden Seiten (Muster aus steuer.js in HLSW-Management):
   der Server validiert, der Browser zeigt an — sie können nie auseinanderlaufen.

   Die KI liefert ein striktes JSON (konzept.md „Das erwartete Ergebnis").
   Security-First: Dokumentinhalt gilt als fremd, darum wird das Ergebnis
   strikt geprüft, bevor es gespeichert wird:
   - unbekannte Felder werden verworfen (die KI darf nur FELDER befüllen)
   - Tags müssen aus dem Regel-Set sein (die KI darf keine erfinden)
   - Zahlen müssen plausibel sein (Konfidenz 0..1, Beträge in Cent begrenzt)
   - `stellen` muss im Volltext vorkommen (Grounding: kein Tag ohne Zitat)
   - Bedingungen (z. B. eigener_name_adresse) prüft der Server deterministisch
   ========================================================================== */

/** Feste Schema-Version; wird im gespeicherten Ergebnis mitgeführt. */
export const SCHEMA_VERSION = 1;

/** Die einzigen Felder, die die KI befüllen darf (konzept.md, Erwartetes Ergebnis). */
export const FELDER = [
  'dokumenttyp', 'kategorien', 'absender', 'datum',
  'betraege', 'beleg_erforderlich', 'kern', 'vertrauen_gesamt',
];

/** Erlaubte Arten eines Betrags. */
export const BETRAG_ARTEN = ['brutto', 'netto', 'ust', 'rabatt', 'zins', 'sonstiges'];

/* Plausibilitäts-Grenzen */
export const MAX_BETRAG_CENTS = 100_000_000; // 1 Mio. € pro Betrag
export const MAX_ABSENDER = 200;
export const MAX_KERN = 500;
export const MAX_STELLEN = 10;
export const MAX_STELLE = 300; // ein Zitat ist ein Satz, kein Absatz

/** Normalisiert für Vergleiche: kleingeschrieben, Leerläufe zusammengezogen. */
export const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export const istKonfidenz = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/**
 * Inhaber-Profil: Name und/oder Adresse müssen im Volltext vorkommen,
 * damit die Bedingung `eigener_name_adresse` erfüllt ist.
 * (konzept.md: „Hat die Bedingung, dann muss der Inhaber-Name oder die
 * Adresse im Volltext vorkommen")
 */
export function inhaberImText(inhaber, volltext) {
  if (!inhaber) return false;
  const t = norm(volltext);
  const name = norm(inhaber.name);
  const adresse = norm(inhaber.adresse);
  return (name && t.includes(name)) || (adresse && t.includes(adresse));
}

/**
 * Deterministische Bedingungsprüfung (Security-First: läuft als Code auf dem
 * Server, nicht in der KI). Verwirft Tags, deren Bedingung `eigener_name_adresse`
 * nicht erfüllt ist, und liefert die Gründe für die Bestätigungs-Ansicht.
 *
 * @param {object} ergebnis - das (bereits schema-geprüfte) Ergebnis
 * @param {{ regeln: object[], inhaber: object|null, volltext: string }} ctx
 * @returns {{ ergebnis: object, verworfen: string[] }}
 */
export function bedingungenPruefen(ergebnis, { regeln = [], inhaber = null, volltext = '' } = {}) {
  const verworfen = [];
  const inhaberDa = !!(norm(inhaber?.name) || norm(inhaber?.adresse));
  const inhaberOk = inhaberImText(inhaber, volltext);

  const pruefeTag = (name) => {
    const regel = regeln.find((r) => norm(r.name) === norm(name));
    if (!regel || regel.bedingung !== 'eigener_name_adresse') return true;
    if (!inhaberDa) {
      verworfen.push(`Tag „${name}“ verworfen: Inhaber-Profil fehlt — in den Einstellungen pflegen`);
      return false;
    }
    if (!inhaberOk) {
      verworfen.push(`Tag „${name}“ verworfen: kein Inhaber-Name oder -Adresse im Dokument`);
      return false;
    }
    return true;
  };

  const ergebnis2 = { ...ergebnis };
  if (ergebnis2.dokumenttyp && !pruefeTag(ergebnis2.dokumenttyp.name)) {
    delete ergebnis2.dokumenttyp;
  }
  if (ergebnis2.kategorien) {
    ergebnis2.kategorien = ergebnis2.kategorien.filter((k) => pruefeTag(k.name));
    if (!ergebnis2.kategorien.length) delete ergebnis2.kategorien;
  }
  return { ergebnis: ergebnis2, verworfen };
}

/**
 * Prüft das rohe KI-Ergebnis gegen Schema und Regeln.
 *
 * @param {object|null} raw - das geparste JSON der KI
 * @param {{ regeln: object[], volltext: string, inhaber: object|null }} ctx
 *   regeln: die Regeln aus der DB (name, art, beschreibung, schluesselwoerter, bedingung, beispiel)
 * @returns {{ ok: boolean, ergebnis: object|null, verworfen: string[], fehler: string[] }}
 *   ok: true, wenn das Ergebnis verworfen wurde und verwertbar ist
 *       (mind. ein Feld übrig) — der Server speichert es dann als Vorschlag.
 *   verworfen: menschenlesbare Gründe (erscheinen in der Bestätigungs-Ansicht).
 *   fehler: strukturelle Probleme, die das ganze Ergebnis unbrauchbar machen.
 */
export function pruefeErgebnis(raw, { regeln = [], volltext = '', inhaber = null } = {}) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, ergebnis: null, verworfen: [], fehler: ['Ergebnis ist kein JSON-Objekt'] };
  }
  // Kleine Modelle geben gelegentlich nur die Kategori-Liste statt des Objekts
  // aus (beobachtet mit Qwen3.8-27B-4bit bei englischen Rechnungen). Rettung:
  // die Liste als „kategorien" übernehmen — jeder Eintrag wird weiterhin
  // strikt geprüft (Name aus dem Regel-Set, Zitate müssen im Volltext sein).
  const listRettung = Array.isArray(raw)
    && raw.length > 0
    && raw.every((x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.name === 'string');
  if (Array.isArray(raw) && !listRettung) {
    return { ok: false, ergebnis: null, verworfen: [], fehler: ['Ergebnis ist ein JSON-Array, aber keine Kategori-Liste'] };
  }
  if (listRettung) raw = { kategorien: raw };

  const fehler = [];
  const verworfen = [];
  const ergebnis = { schema: SCHEMA_VERSION };

  const namen = (art) => new Set(regeln.filter((r) => r.art === art).map((r) => norm(r.name)));
  const katNamen = namen('kategorie');
  const typNamen = namen('dokumenttyp');
  const textN = norm(volltext);

  /* dokumenttyp: { name, konfidenz } — Name muss im Regel-Set sein */
  if ('dokumenttyp' in raw) {
    const dt = raw.dokumenttyp;
    const name = dt && typeof dt === 'object' && typeof dt.name === 'string' ? dt.name.trim() : '';
    if (name && typNamen.has(norm(name))) {
      ergebnis.dokumenttyp = { name, konfidenz: istKonfidenz(dt.konfidenz) ? dt.konfidenz : null };
    } else if (name) {
      verworfen.push(`Dokumenttyp „${name}“ verworfen: nicht im Regel-Set`);
    } else {
      verworfen.push('Dokumenttyp verworfen: unvollständig');
    }
  }

  /* kategorien: [{ name, konfidenz, stellen }] — Regel-Set + Grounding */
  if ('kategorien' in raw) {
    const liste = Array.isArray(raw.kategorien) ? raw.kategorien : [];
    const kat = [];
    const gesehen = new Set();
    for (const k of liste) {
      const name = k && typeof k === 'object' && typeof k.name === 'string' ? k.name.trim() : '';
      if (!name) {
        if (k != null) verworfen.push('Kategorie verworfen: unvollständig');
        continue;
      }
      if (!katNamen.has(norm(name))) {
        verworfen.push(`Kategorie „${name}“ verworfen: nicht im Regel-Set`);
        continue;
      }
      if (gesehen.has(norm(name))) continue; // doppelte Nennung
      // Grounding: jedes Zitat muss im Volltext vorkommen, sonst kein Tag
      const stellen = (Array.isArray(k.stellen) ? k.stellen : [])
        .filter((s) => typeof s === 'string' && s.trim().length >= 3)
        .map((s) => s.trim().slice(0, MAX_STELLE))
        .filter((s) => textN.includes(norm(s)))
        .slice(0, MAX_STELLEN);
      if (!stellen.length) {
        verworfen.push(`Kategorie „${name}“ verworfen: kein Zitat im Volltext (Grounding)`);
        continue;
      }
      gesehen.add(norm(name));
      kat.push({ name, konfidenz: istKonfidenz(k.konfidenz) ? k.konfidenz : null, stellen });
    }
    if (kat.length) ergebnis.kategorien = kat;
  }

  /* absender: freier Text, begrenzt */
  if ('absender' in raw) {
    if (typeof raw.absender === 'string' && raw.absender.trim()) {
      ergebnis.absender = raw.absender.trim().slice(0, MAX_ABSENDER);
    } else if (raw.absender != null) {
      verworfen.push('Absender verworfen: kein Text');
    }
  }

  /* datum: ISO YYYY-MM-DD */
  if ('datum' in raw) {
    if (typeof raw.datum === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.datum)) {
      ergebnis.datum = raw.datum;
    } else if (raw.datum != null) {
      verworfen.push('Datum verworfen: erwartet YYYY-MM-DD');
    }
  }

  /* betraege: [{ art, wert_cents }] — plausibel, in Cent */
  if ('betraege' in raw) {
    const liste = Array.isArray(raw.betraege) ? raw.betraege : [];
    const betraege = [];
    for (const b of liste) {
      if (!b || typeof b !== 'object') continue;
      const art = typeof b.art === 'string' ? b.art.trim().toLowerCase() : '';
      const wert = Number(b.wert_cents);
      if (!BETRAG_ARTEN.includes(art)) {
        if (b.art != null) verworfen.push(`Betrag „${String(b.art).slice(0, 40)}“ verworfen: unklare Art`);
        continue;
      }
      if (!Number.isInteger(wert) || wert < 0 || wert > MAX_BETRAG_CENTS) {
        verworfen.push(`Betrag „${art}“ verworfen: unplausibel`);
        continue;
      }
      if (!betraege.some((x) => x.art === art)) betraege.push({ art, wert_cents: wert });
    }
    if (betraege.length) ergebnis.betraege = betraege;
  }

  /* beleg_erforderlich: boolean */
  if ('beleg_erforderlich' in raw) {
    if (typeof raw.beleg_erforderlich === 'boolean') {
      ergebnis.beleg_erforderlich = raw.beleg_erforderlich;
    } else if (raw.beleg_erforderlich != null) {
      verworfen.push('Beleg-Charakter verworfen: erwartet wahr/falsch');
    }
  }

  /* kern: kurze Zusammenfassung */
  if ('kern' in raw) {
    if (typeof raw.kern === 'string' && raw.kern.trim()) {
      ergebnis.kern = raw.kern.trim().slice(0, MAX_KERN);
    } else if (raw.kern != null) {
      verworfen.push('Kern verworfen: kein Text');
    }
  }

  /* vertrauen_gesamt: 0..1 */
  if ('vertrauen_gesamt' in raw) {
    if (istKonfidenz(raw.vertrauen_gesamt)) {
      ergebnis.vertrauen_gesamt = raw.vertrauen_gesamt;
    } else if (raw.vertrauen_gesamt != null) {
      verworfen.push('Gesamtvertrauen verworfen: Zahl zwischen 0 und 1 erwartet');
    }
  }

  /* Unbekannte Felder: still verwerfen (die KI darf nur FELDER befüllen) */
  for (const f of Object.keys(raw)) {
    if (!FELDER.includes(f)) verworfen.push(`Feld „${f}“ verworfen: unbekannt`);
  }

  /* Bedingungen: deterministisch (eigener_name_adresse) */
  const { ergebnis: geprueft, verworfen: bedingungsGründe } = bedingungenPruefen(ergebnis, { regeln, inhaber, volltext });
  verworfen.push(...bedingungsGründe);

  if (listRettung) {
    // Transparenz: der Vorschlag ist unvollständig — das soll der Nutzer sehen.
    verworfen.push('KI-Antwort war nur eine Liste — als Kategorien übernommen; übrige Felder (Dokumenttyp, Absender, Datum, Beträge) fehlen.');
  }

  const ok = Object.keys(geprueft).some((f) => f !== 'schema' && geprueft[f] != null);
  return { ok, ergebnis: ok ? geprueft : null, verworfen, fehler };
}

/**
 * Parst die rohe KI-Antwort zu einem Objekt: JSON direkt oder in Markdown-
 * Zäunen (```json … ```). @returns {{ objekt: object|null, fehler: string|null }}
 */
export function parseErgebnisText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { objekt: null, fehler: 'leere Antwort' };
  }
  let t = text.trim();
  const zaun = t.match(/^```[a-zA-Z]*\s*([\s\S]*?)```$/);
  if (zaun) t = zaun[1].trim();
  try {
    return { objekt: JSON.parse(t), fehler: null };
  } catch {
    // letzte Rettung: das erste { bis das letzte } — Modell hat um das JSON geredet
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return { objekt: JSON.parse(t.slice(a, b + 1)), fehler: null };
      } catch { /* fällt durch */ }
    }
    return { objekt: null, fehler: 'Antwort ist kein gültiges JSON' };
  }
}
