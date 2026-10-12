/* ==========================================================================
   HammerClassify — Mock-Logik (Konzept-Prototyp, 10.10.2026)
   Nur für die Darstellung: Mock-Daten, keine echten API-Calls.
   Die Struktur spiegelt die spätere Client-App (konzept.md §6).
   ========================================================================== */
'use strict';

/* ----------------------------- Mock-Daten ------------------------------ */

const KAT = {
  nebenn: { label: 'Nebenkosten',    varName: '--kat-teal',    sub: '--kat-teal-s' },
  miet:   { label: 'Miete',          varName: '--kat-blau',    sub: '--kat-blau-s' },
  vers:   { label: 'Versicherung',   varName: '--kat-violett', sub: '--kat-violett-s' },
  telek:  { label: 'Telekommunikation', varName: '--kat-pink', sub: '--kat-pink-s' },
  sonst:  { label: 'Sonstiges',      varName: '--kat-grau',    sub: '--kat-grau-s' },
};
const ART = {
  rechnung: { label: 'Rechnung', varName: '--kat-gruen', sub: '--kat-gruen-s' },
  angebot:  { label: 'Angebot',  varName: '--kat-oliv',  sub: '--kat-oliv-s' },
  kuend:    { label: 'Kündigung', varName: '--kat-rot',  sub: '--kat-rot-s' },
  brief:    { label: 'Brief',    varName: '--kat-grau',  sub: '--kat-grau-s' },
};
const ABSENDER = {
  eon:  { label: 'E.ON Energie',   varName: '--kat-teal', sub: '--kat-teal-s' },
  vh:   { label: 'VHV Versicherung', varName: '--kat-violett', sub: '--kat-violett-s' },
  t:    { label: 'Telekom',        varName: '--kat-pink', sub: '--kat-pink-s' },
  wg:   { label: 'Wohnungsgesellschaft', varName: '--kat-blau', sub: '--kat-blau-s' },
  unk:  { label: 'Unbekannt',      varName: '--kat-grau', sub: '--kat-grau-s' },
};

const DOCS = [
  { id: 'd1',  titel: 'Stromabrechnung Q3', abs: 'eon',  betrag: '84,12 €', datum: '2026-10-08', konf: 0.97,
    tags: [ { t: 'Nebenkosten', art: 'kategorie', ref: 'nebenn', k: 0.97 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.99 }, { t: 'E.ON Energie', art: 'absender', ref: 'eon', k: 0.95 } ],
    text: 'E.ON Energie Deutschland GmbH\nMaximilianstraße 12, 80333 München\n\nSehr geehrte Frau Hammer,\n\nhiermit rechnen wir den Stromverbrauch des 3. Quartals 2026 für die Zählerstelle an der Hammerstraße 7, 18055 Rostock ab.\n\nGrundgebühr: 36,00 €\nEnergie 214 kWh: 48,12 €\n\nGesamtbetrag: 84,12 €\n\nFällig bis: 31.10.2026\n\nMit freundlichen Grüßen\nE.ON Energie Deutschland GmbH' },
  { id: 'd2',  titel: 'Gasabrechnung Q3', abs: 'eon',  betrag: '61,40 €', datum: '2026-10-08', konf: 0.94,
    tags: [ { t: 'Nebenkosten', art: 'kategorie', ref: 'nebenn', k: 0.94 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.98 }, { t: 'E.ON Energie', art: 'absender', ref: 'eon', k: 0.93 } ],
    text: 'E.ON Energie Deutschland GmbH\n\nSehr geehrte Frau Hammer,\n\nAbrechnung Erdgas 3. Quartal 2026, Zähler Hammerstraße 7, 18055 Rostock.\n\nEnergie 188 kWh: 52,90 €\nGrundgebühr: 8,50 €\n\nGesamtbetrag: 61,40 €\n\nFällig bis: 31.10.2026' },
  { id: 'd3',  titel: 'Wasser- und Abwassergebühr', abs: 'wg', betrag: '96,00 €', datum: '2026-10-05', konf: 0.91,
    tags: [ { t: 'Nebenkosten', art: 'kategorie', ref: 'nebenn', k: 0.91 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.96 }, { t: 'Wohnungsgesellschaft', art: 'absender', ref: 'wg', k: 0.88 } ],
    text: 'Wohnungsgesellschaft Rostock-Nord GmbH\n\nSehr geehrte Frau Hammer,\n\nhiermit teilen wir Ihnen die Wasser- und Abwassergebühr für Ihr Wohneigentum Hammerstraße 7 mit.\n\nWasser 42 m³: 37,80 €\nAbwasser 42 m³: 58,20 €\n\nGesamtbetrag: 96,00 €\n\nFällig bis: 15.11.2026' },
  { id: 'd4',  titel: 'Schornsteinfeger — Kehrung', abs: 'unk', betrag: '120,00 €', datum: '2026-10-02', konf: 0.88,
    tags: [ { t: 'Nebenkosten', art: 'kategorie', ref: 'nebenn', k: 0.88 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.95 } ],
    text: 'Schornsteinfegeramt Rostock\n\nSehr geehrte Frau Hammer,\n\nfür die Kehrung und den Schornsteinfegerbesuch im 3. Quartal 2026 an der Hammerstraße 7 berechnen wir:\n\nKehrung 4-fach: 96,00 €\nPrüfung: 24,00 €\n\nGesamtbetrag: 120,00 €\n\nFällig bis: 30.11.2026' },
  { id: 'd5',  titel: 'Miete Oktober', abs: 'wg', betrag: '1.150,00 €', datum: '2026-09-30', konf: 0.96,
    tags: [ { t: 'Miete', art: 'kategorie', ref: 'miet', k: 0.96 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.97 }, { t: 'Wohnungsgesellschaft', art: 'absender', ref: 'wg', k: 0.92 } ],
    text: 'Wohnungsgesellschaft Rostock-Nord GmbH\n\nSehr geehrte Frau Hammer,\n\nMiete für Oktober 2026, Wohnung Hammerstraße 7, 18055 Rostock.\n\nKaltmiete: 1.150,00 €\n\nFällig bis: 03.10.2026' },
  { id: 'd6',  titel: 'Hausratversicherung — Jahresrechnung', abs: 'vh', betrag: '288,00 €', datum: '2026-09-28', konf: 0.93,
    tags: [ { t: 'Versicherung', art: 'kategorie', ref: 'vers', k: 0.93 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.98 }, { t: 'VHV Versicherung', art: 'absender', ref: 'vh', k: 0.94 } ],
    text: 'VHV Versicherung AG\n\nSehr geehrte Frau Hammer,\n\nJahresrechnung Hausratversicherung, Police 88-4412, Versicherungsort Hammerstraße 7, 18055 Rostock.\n\nJahresbeitrag: 288,00 €\n\nFällig bis: 30.10.2026' },
  { id: 'd7',  titel: 'Telekom — Mobilfunkvertrag', abs: 't', betrag: '49,99 €', datum: '2026-09-25', konf: 0.95,
    tags: [ { t: 'Telekommunikation', art: 'kategorie', ref: 'telek', k: 0.95 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.97 }, { t: 'Telekom', art: 'absender', ref: 't', k: 0.96 } ],
    text: 'Deutsche Telekom AG\n\nSehr geehrte Frau Hammer,\n\nIhre monatliche Rechnung für Mobilfunk, Anschluss Hammerstraße 7, 18055 Rostock.\n\nMonatspreis: 49,99 €\n\nFällig bis: 10.10.2026' },
  { id: 'd8',  titel: 'Angebot: Fensteraustausch', abs: 'unk', betrag: '4.820,00 €', datum: '2026-09-20', konf: 0.86,
    tags: [ { t: 'Sonstiges', art: 'kategorie', ref: 'sonst', k: 0.86 }, { t: 'Angebot', art: 'typ', ref: 'angebot', k: 0.97 } ],
    text: 'Fensterbau Nord GmbH\n\nSehr geehrte Frau Hammer,\n\nvielen Dank für Ihre Anfrage. Hiermit unterbreiten wir Ihnen unser Angebot für den Austausch von 6 Fenstern in der Hammerstraße 7.\n\nGesamtpreis netto: 4.820,00 €\n\nGültig bis: 20.12.2026' },
  { id: 'd9',  titel: 'Kündigung: Tagesgeldkonto', abs: 'unk', betrag: '—', datum: '2026-09-18', konf: 0.92,
    tags: [ { t: 'Sonstiges', art: 'kategorie', ref: 'sonst', k: 0.79 }, { t: 'Kündigung', art: 'typ', ref: 'kuend', k: 0.94 } ],
    text: 'Nordbank AG\n\nSehr geehrte Frau Hammer,\n\nwir bestätigen hiermit den Erhalt Ihrer Kündigung des Tagesgeldkontos 18055-4471, Hammerstraße 7. Das Konto wird zum 31.12.2026 aufgelöst.' },
  { id: 'd10', titel: 'Grundsteuerbescheid 2026', abs: 'unk', betrag: '612,00 €', datum: '2026-09-12', konf: 0.84,
    tags: [ { t: 'Nebenkosten', art: 'kategorie', ref: 'nebenn', k: 0.84 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.91 } ],
    text: 'Finanzamt Rostock\n\nSehr geehrte Frau Hammer,\n\nhiermit erheben wir für das Grundbesitzobjekt Hammerstraße 7, 18055 Rostock die Grundsteuer.\n\nGrundsteuer: 612,00 €\n\nFällig bis: 15.12.2026' },
  { id: 'd11', titel: 'Brief: Nachzahlung Nebenkosten 2025', abs: 'wg', betrag: '143,60 €', datum: '2026-09-05', konf: 0.89,
    tags: [ { t: 'Nebenkosten', art: 'kategorie', ref: 'nebenn', k: 0.89 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.93 }, { t: 'Wohnungsgesellschaft', art: 'absender', ref: 'wg', k: 0.90 } ],
    text: 'Wohnungsgesellschaft Rostock-Nord GmbH\n\nSehr geehrte Frau Hammer,\n\naus der Nebenkostenabrechnung 2025 für die Hammerstraße 7 ergibt sich eine Nachzahlung:\n\nWasser/Abwasser: 21,40 €\nMüllabfuhr: 18,20 €\nSchornsteinfeger: 104,00 €\n\nNachzahlung: 143,60 €\n\nFällig bis: 31.10.2026' },
  { id: 'd12', titel: 'Angebot: WLAN-Router', abs: 't', betrag: '89,00 €', datum: '2026-08-28', konf: 0.82,
    tags: [ { t: 'Telekommunikation', art: 'kategorie', ref: 'telek', k: 0.82 }, { t: 'Angebot', art: 'typ', ref: 'angebot', k: 0.96 } ],
    text: 'Deutsche Telekom AG\n\nSehr geehrte Frau Hammer,\n\nwir bieten Ihnen den Wechsel auf unseren neuen WLAN-Router an.\n\nGerätekosten: 89,00 €\n\nGültig bis: 28.09.2026' },
  { id: 'd13', titel: 'Kündigung: Fitnessstudio', abs: 'unk', betrag: '—', datum: '2026-08-20', konf: 0.90,
    tags: [ { t: 'Sonstiges', art: 'kategorie', ref: 'sonst', k: 0.88 }, { t: 'Kündigung', art: 'typ', ref: 'kuend', k: 0.93 } ],
    text: 'Fitnessstudio Ostsee GmbH\n\nSehr geehrte Frau Hammer,\n\nwir bestätigen die Kündigung Ihres Mitgliedschaftsvertrags zum 31.10.2026. Anschrift: Hammerstraße 7, 18055 Rostock.' },
  { id: 'd14', titel: 'Haftplichtversicherung — Rechnung', abs: 'vh', betrag: '196,00 €', datum: '2026-08-14', konf: 0.91,
    tags: [ { t: 'Versicherung', art: 'kategorie', ref: 'vers', k: 0.91 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.97 }, { t: 'VHV Versicherung', art: 'absender', ref: 'vh', k: 0.92 } ],
    text: 'VHV Versicherung AG\n\nSehr geehrte Frau Hammer,\n\nHalbjahresrechnung Haftpflichtversicherung, Police 88-1020, Hammerstraße 7, 18055 Rostock.\n\nBeitrag: 196,00 €\n\nFällig bis: 14.09.2026' },
  { id: 'd15', titel: 'Miete September', abs: 'wg', betrag: '1.150,00 €', datum: '2026-08-30', konf: 0.96,
    tags: [ { t: 'Miete', art: 'kategorie', ref: 'miet', k: 0.96 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.97 }, { t: 'Wohnungsgesellschaft', art: 'absender', ref: 'wg', k: 0.92 } ],
    text: 'Wohnungsgesellschaft Rostock-Nord GmbH\n\nSehr geehrte Frau Hammer,\n\nMiete für September 2026, Wohnung Hammerstraße 7, 18055 Rostock.\n\nKaltmiete: 1.150,00 €\n\nFällig bis: 03.09.2026' },
  { id: 'd16', titel: 'Gewerbesteuer — Nachzahlung', abs: 'unk', betrag: '210,00 €', datum: '2026-08-22', konf: 0.81,
    tags: [ { t: 'Nebenkosten', art: 'kategorie', ref: 'nebenn', k: 0.81 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.90 } ],
    text: 'Finanzamt Rostock\n\nSehr geehrte Frau Hammer,\n\nNachzahlung Gewerbesteuer für den Grundbesitz Hammerstraße 7.\n\nGesamtbetrag: 210,00 €\n\nFällig bis: 31.08.2026' },
  { id: 'd17', titel: 'Kfz-Versicherung — Rechnung', abs: 'vh', betrag: '342,00 €', datum: '2026-08-15', konf: 0.92,
    tags: [ { t: 'Versicherung', art: 'kategorie', ref: 'vers', k: 0.92 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.97 }, { t: 'VHV Versicherung', art: 'absender', ref: 'vh', k: 0.93 } ],
    text: 'VHV Versicherung AG\n\nSehr geehrte Frau Hammer,\n\nJahresrechnung Kfz-Versicherung, Police 88-2031, Hammerstraße 7, 18055 Rostock.\n\nBeitrag: 342,00 €\n\nFällig bis: 15.09.2026' },
  { id: 'd18', titel: 'Telekom — Festnetz & Internet', abs: 't', betrag: '59,99 €', datum: '2026-08-08', konf: 0.94,
    tags: [ { t: 'Telekommunikation', art: 'kategorie', ref: 'telek', k: 0.94 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.97 }, { t: 'Telekom', art: 'absender', ref: 't', k: 0.95 } ],
    text: 'Deutsche Telekom AG\n\nSehr geehrte Frau Hammer,\n\nMonatsrechnung Festnetz und Internet, Anschluss Hammerstraße 7, 18055 Rostock.\n\nMonatspreis: 59,99 €\n\nFällig bis: 23.08.2026' },
  { id: 'd19', titel: 'Brief: Mieterhöhung', abs: 'wg', betrag: '—', datum: '2026-08-02', konf: 0.74,
    tags: [ { t: 'Miete', art: 'kategorie', ref: 'miet', k: 0.74 }, { t: 'Brief', art: 'typ', ref: 'brief', k: 0.88 }, { t: 'Wohnungsgesellschaft', art: 'absender', ref: 'wg', k: 0.91 } ],
    text: 'Wohnungsgesellschaft Rostock-Nord GmbH\n\nSehr geehrte Frau Hammer,\n\nhiermit teilen wir Ihnen mit, dass die Miete für Ihre Wohnung Hammerstraße 7 zum 01.11.2026 angepasst wird.\n\nNeue Kaltmiete: 1.210,00 €' },
  { id: 'd20', titel: 'Angebot: Dachsanierung', abs: 'unk', betrag: '12.400,00 €', datum: '2026-07-28', konf: 0.83,
    tags: [ { t: 'Sonstiges', art: 'kategorie', ref: 'sonst', k: 0.83 }, { t: 'Angebot', art: 'typ', ref: 'angebot', k: 0.96 } ],
    text: 'Dachdeckerei Ost GmbH\n\nSehr geehrte Frau Hammer,\n\nAngebot zur Sanierung des Daches, Hammerstraße 7.\n\nGesamtpreis netto: 12.400,00 €\n\nGültig bis: 28.10.2026' },
  { id: 'd21', titel: 'Wasserabrechnung Q2', abs: 'wg', betrag: '88,00 €', datum: '2026-07-19', konf: 0.90,
    tags: [ { t: 'Nebenkosten', art: 'kategorie', ref: 'nebenn', k: 0.90 }, { t: 'Rechnung', art: 'typ', ref: 'rechnung', k: 0.95 }, { t: 'Wohnungsgesellschaft', art: 'absender', ref: 'wg', k: 0.89 } ],
    text: 'Wohnungsgesellschaft Rostock-Nord GmbH\n\nSehr geehrte Frau Hammer,\n\nWasserabrechnung 2. Quartal 2026, Hammerstraße 7.\n\nGesamtbetrag: 88,00 €\n\nFällig bis: 31.08.2026' },
  { id: 'd22', titel: 'Unbekanntes Schreiben', abs: 'unk', betrag: '—', datum: '2026-07-11', konf: 0.42,
    tags: [ { t: 'Unklassifiziert', art: 'kategorie', ref: 'sonst', k: 0.42 } ],
    text: 'Sehr geehrte Frau Hammer,\n\nwir möchten Sie auf eine Änderung der Bedingungen hinweisen.\n\nMit freundlichen Grüßen' },
  { id: 'd23', titel: 'Scan: Postkarte', abs: 'unk', betrag: '—', datum: '2026-07-03', konf: 0.38,
    tags: [ { t: 'Unklassifiziert', art: 'kategorie', ref: 'sonst', k: 0.38 } ],
    text: 'Liebe Familie,\n\ngrüße aus dem Urlaub!\n\nAlles Liebe' },
];

const RULES = [
  { id: 'r1', name: 'Nebenkosten', tag: 'Nebenkosten', art: 'kategorie', ref: 'nebenn', treffer: 18,
    desc: 'Alles rund um Strom, Gas, Wasser, Schornsteinfeger, Müllabfuhr, Grundsteuer — sofern mein Name und meine Adresse darauf zu finden sind.',
    kw: ['Strom', 'Gas', 'Wasser', 'Abwasser', 'Schornsteinfeger', 'Müll', 'Grundsteuer', 'Nebenkosten'] },
  { id: 'r2', name: 'Miete', tag: 'Miete', art: 'kategorie', ref: 'miet', treffer: 12,
    desc: 'Mietrechnungen und Mietverträge meiner Wohnung.',
    kw: ['Miete', 'Kaltmiete', 'Warmmiete', 'Mietvertrag', 'Mieter'] },
  { id: 'r3', name: 'Versicherung', tag: 'Versicherung', art: 'kategorie', ref: 'vers', treffer: 9,
    desc: 'Versicherungsbeiträge, Policen, Versicherungsbilder aller meiner Versicherungen.',
    kw: ['Versicherung', 'Beitrag', 'Police', 'Haftpflicht', 'Hausrat'] },
  { id: 'r4', name: 'Telekommunikation', tag: 'Telekommunikation', art: 'kategorie', ref: 'telek', treffer: 8,
    desc: 'Mobilfunk, Festnetz, Internet, Router — Rechnungen und Angebote.',
    kw: ['Mobilfunk', 'Festnetz', 'Internet', 'Router', 'Telekom'] },
  { id: 'r5', name: 'Rechnung', tag: 'Rechnung', art: 'typ', ref: 'rechnung', treffer: 31,
    desc: 'Dokumente, die eine Zahlung verlangen: Rechnung, Abrechnung, Mahnung, Fälligkeit, Betrag.',
    kw: ['Rechnung', 'Abrechnung', 'fällig', 'Mahnung', 'Gesamtbetrag'] },
  { id: 'r6', name: 'Angebot', tag: 'Angebot', art: 'typ', ref: 'angebot', treffer: 6,
    desc: 'Angebote und Preislisten, die noch keine Zahlung verlangen.',
    kw: ['Angebot', 'Preisliste', 'Gültig bis', 'netto'] },
  { id: 'r7', name: 'Kündigung', tag: 'Kündigung', art: 'typ', ref: 'kuend', treffer: 4,
    desc: 'Kündigungen: eigene oder empfangene, inkl. Fristen.',
    kw: ['Kündigung', 'kündige', 'kündigen', 'auflösen', 'Frist'] },
  { id: 'r8', name: 'E.ON', tag: 'E.ON', art: 'absender', ref: 'eon', treffer: 11,
    desc: 'Alles von E.ON Energie Deutschland GmbH.',
    kw: ['E.ON', 'E ON'] },
  { id: 'r9', name: 'VHV', tag: 'VHV', art: 'absender', ref: 'vh', treffer: 7,
    desc: 'Alles von VHV Versicherung AG.',
    kw: ['VHV'] },
  { id: 'r10', name: 'Brief', tag: 'Brief', art: 'typ', ref: 'brief', treffer: 5,
    desc: 'Eher formlose Schreiben ohne Zahlungsaufforderung: Brief, Info, Hinweis, Postkarte.',
    kw: ['Sehr geehrte', 'hiermit teilen wir', 'Hinweis', 'Postkarte'] },
];

/* ------------------------------ Helpers -------------------------------- */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const catVar = (ref, art) => (art === 'kategorie' ? KAT[ref] : art === 'typ' ? ART[ref] : ABSENDER[ref]);
const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function badge(tag, conf) {
  const c = catVar(tag.ref, tag.art);
  const el = document.createElement('span');
  el.className = 'hlsw-badge';
  el.style.background = `var(${c.sub})`;
  el.style.color = `var(${c.varName})`;
  el.textContent = tag.t;
  return el;
}

/* ------------------------------ Navigation ----------------------------- */

function showView(name) {
  $$('.nav-link').forEach((l) => l.toggleAttribute('aria-current', l.dataset.view === name) || l.setAttribute('aria-current', l.dataset.view === name ? 'page' : 'false'));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name !== 'document') {
    $('#view-document').classList.remove('active');
  }
  window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-view]');
  if (nav && nav.dataset.view !== 'document') { showView(nav.dataset.view); return; }
});

/* ------------------------------- Login --------------------------------- */
/* Echte WebAuthn-Flüsse gegen /api/auth (P1). Die übrigen Ansichten
   zeigen bis P2/P3 weiterhin Mock-Daten. */

async function api(path, opts = {}) {
  const r = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.setupToken ? { 'x-setup-token': opts.setupToken } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.fehler || `HTTP ${r.status}`);
  return data;
}

function setLoginStatus(text, isError = false) {
  const el = $('#login-status');
  el.textContent = text;
  el.style.color = isError ? 'var(--danger, #d66)' : '';
}

async function doLogin() {
  setLoginStatus('Passkey wird abgefragt …');
  try {
    const options = await api('/api/auth/login/options', { method: 'POST' });
    const response = await WebAuthnClient.authenticate(options);
    await api('/api/auth/login/finish', { method: 'POST', body: { expectedOptions: options, response } });
    setLoginStatus('Angemeldet ✓');
    showApp();
  } catch (e) {
    setLoginStatus(`Anmeldung fehlgeschlagen: ${e.message}`, true);
  }
}

async function doRegister() {
  const token = $('#setup-token').value.trim();
  if (!token) {
    setLoginStatus('Einrichtungscode eingeben.', true);
    return;
  }
  setLoginStatus('Passkey wird erstellt …');
  try {
    const options = await api('/api/auth/register/options', { method: 'POST', setupToken: token });
    const response = await WebAuthnClient.register(options, token);
    await api('/api/auth/register/finish', { method: 'POST', body: { expectedOptions: options, response } });
    setLoginStatus('Passkey eingerichtet ✓ — jetzt anmelden');
    $('#btn-register').hidden = true;
    $('#setup-row').hidden = true;
  } catch (e) {
    setLoginStatus(`Einrichtung fehlgeschlagen: ${e.message}`, true);
  }
}

function showApp() {
  $('#view-login').hidden = true;
  $('#app-shell').hidden = false;
}

function showLogin() {
  $('#app-shell').hidden = true;
  $('#view-login').hidden = false;
}

$('#btn-login').addEventListener('click', doLogin);
$('#btn-register').addEventListener('click', doRegister);
$('#btn-setup').addEventListener('click', doRegister);
$('#setup-token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doRegister();
});
$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* egal */ }
  showLogin();
});

// Zustand beim Laden: Session prüfen, Setup-UI bei Leerlauf zeigen
(async () => {
  try {
    const state = await api('/api/auth/state');
    if (state.angemeldet) {
      showApp();
    } else if (!state.eingerichtet) {
      $('#btn-register').hidden = false;
      $('#setup-row').hidden = false;
      setLoginStatus('Erster Start: Einrichtungscode aus der .env auf dem hammerpi.');
    }
  } catch {
    setLoginStatus('Server nicht erreichbar.', true);
  }
})();

/* ------------------------------- Theme --------------------------------- */

(function initTheme() {
  const saved = localStorage.getItem('hlsw-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  // Ohne data-theme folgt das Designsystem der Systemeinstellung (prefers-color-scheme).
})();

$('#btn-theme').addEventListener('click', () => {
  const root = document.documentElement;
  const next = root.dataset.theme === 'light' ? 'dark' : 'light';
  root.dataset.theme = next;
  localStorage.setItem('hlsw-theme', next);
});

/* ------------------------------ Dashboard ------------------------------ */

function renderDashboard() {
  // Statistik
  const rechnungen = DOCS.filter((d) => d.tags.some((t) => t.t === 'Rechnung')).length;
  const unclassified = DOCS.filter((d) => d.konf < 0.5).length;
  $$('[data-stat="total"]').forEach((el) => (el.textContent = String(DOCS.length)));
  $$('[data-stat="rechnungen"]').forEach((el) => (el.textContent = String(rechnungen)));
  $$('[data-stat="unclassified"]').forEach((el) => (el.textContent = String(unclassified)));
  $$('[data-stat="rules"]').forEach((el) => (el.textContent = String(RULES.length)));
  $$('[data-count="documents"]').forEach((el) => (el.textContent = String(DOCS.length)));
  $$('[data-count="rules"]').forEach((el) => (el.textContent = String(RULES.length)));
  const sub = $('#view-dashboard .view-sub');
  if (sub) sub.innerHTML = `${DOCS.length} Dokumente · ${RULES.length} Regeln aktiv · letzte Analyse heute 14:32`;

  // Kategorien-Verteilung
  const counts = {};
  for (const d of DOCS) for (const t of d.tags) if (t.art === 'kategorie') counts[t.t] = (counts[t.t] || 0) + 1;
  const total = DOCS.length;
  const host = $('#dist-kat');
  host.innerHTML = '';
  for (const [label, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const ref = Object.keys(KAT).find((k) => KAT[k].label === label) || 'sonst';
    const c = KAT[ref];
    const row = document.createElement('div');
    row.className = 'dist-row';
    row.innerHTML = `<span class="dist-name">${label}</span>
      <div class="dist-bar"><span style="width: ${(n / total) * 100}%; background: var(${c.varName})"></span></div>
      <span class="dist-count">${n}</span>`;
    host.appendChild(row);
  }

  // Letzte Dokumente
  const tbody = $('#recent-tbody');
  tbody.innerHTML = '';
  for (const d of [...DOCS].sort((a, b) => b.datum.localeCompare(a.datum)).slice(0, 5)) {
    tbody.appendChild(docRow(d, true));
  }
}

function docRow(d, compact) {
  const tr = document.createElement('tr');
  const tags = d.tags.slice(0, compact ? 3 : 4);
  const tagsHtml = tags.map((t) => `<span class="hlsw-badge" style="background: var(${catVar(t.ref, t.art).sub}); color: var(${catVar(t.ref, t.art).varName})">${t.t}</span>`).join('');
  tr.innerHTML = `
    <td><a href="#" data-doc="${d.id}"><span class="doc-name">${d.titel}</span><br><span class="doc-sub">${d.id === 'd1' || d.id === 'd2' ? 'PDF' : 'DOCX'} · ${d.abs === 'eon' ? 'E.ON' : d.abs === 'vh' ? 'VHV' : d.abs === 't' ? 'Telekom' : d.abs === 'wg' ? 'WG' : '—'}</span></a></td>
    <td>${tagsHtml}</td>
    <td>${ABSENDER[d.abs].label}</td>
    <td class="betrag">${d.betrag}</td>
    <td>${fmtDate(d.datum)}</td>
    ${compact ? '' : `<td class="konf">${d.konf.toFixed(2)}</td>`}`;
  tr.querySelector('[data-doc]').addEventListener('click', (e) => { e.preventDefault(); openDoc(d.id); });
  return tr;
}

/* ------------------------------ Dokumente ------------------------------ */

let filterKategorie = null;
let filterTyp = null;

function renderFilters() {
  const host = $('#filters');
  host.innerHTML = '';
  const chip = (label, pressed, onclick) => {
    const b = document.createElement('button');
    b.className = 'filter-chip';
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', onclick);
    return b;
  };
  host.appendChild(chip('Alle', !filterKategorie && !filterTyp, () => { filterKategorie = null; filterTyp = null; renderFilters(); renderDocs(); }));
  const sep = document.createElement('span'); sep.className = 'filter-sep'; host.appendChild(sep);
  for (const k of Object.values(KAT)) host.appendChild(chip(k.label, filterKategorie === k.label, () => { filterKategorie = filterKategorie === k.label ? null : k.label; filterTyp = null; renderFilters(); renderDocs(); }));
  host.appendChild(sep);
  for (const a of Object.values(ART)) host.appendChild(chip(a.label, filterTyp === a.label, () => { filterTyp = filterTyp === a.label ? null : a.label; filterKategorie = null; renderFilters(); renderDocs(); }));
}

function renderDocs() {
  const tbody = $('#docs-tbody');
  tbody.innerHTML = '';
  const q = ($('#search').value || '').toLowerCase();
  const list = DOCS.filter((d) => {
    if (filterKategorie && !d.tags.some((t) => t.art === 'kategorie' && t.t === filterKategorie)) return false;
    if (filterTyp && !d.tags.some((t) => t.art === 'typ' && t.t === filterTyp)) return false;
    if (q) {
      const hay = (d.titel + ' ' + d.text + ' ' + d.tags.map((t) => t.t).join(' ') + ' ' + ABSENDER[d.abs].label).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  for (const d of list) tbody.appendChild(docRow(d, false));
  if (!list.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" style="padding: var(--space-8); text-align: center; color: var(--text-muted)">Keine Dokumente gefunden.</td>`;
    tbody.appendChild(tr);
  }
  const sub = $('#view-documents .view-sub');
  if (sub) sub.innerHTML = `${list.length} von ${DOCS.length} Dokumenten · ${RULES.length} Regeln`;
}

$('#search').addEventListener('input', renderDocs);

/* ------------------------------- Regeln -------------------------------- */

function renderRules() {
  const host = $('#rules-list');
  host.innerHTML = '';
  for (const r of RULES) {
    const c = catVar(r.ref, r.art);
    const card = document.createElement('div');
    card.className = 'rule-card';
    card.innerHTML = `
      <div class="rule-head">
        <span class="hlsw-badge" style="background: var(${c.sub}); color: var(${c.varName})">${r.art === 'kategorie' ? 'Kategorie' : r.art === 'typ' ? 'Typ' : 'Absender'}</span>
        <h3 class="">${r.name}</h3>
        <button class="hlsw-btn hlsw-btn--ghost hlsw-btn--sm" data-edit-rule="${r.id}" type="button">Bearbeiten</button>
      </div>
      <p class="rule-desc">${r.desc}</p>
      <div class="kw-row">${r.kw.map((k) => `<span class="kw-chip">${k}</span>`).join('')}</div>
      <div class="rule-foot">
        <span class="hlsw-badge" style="background: var(--bg-inset); color: var(--text-muted)">→ Tag: ${r.tag}</span>
        <span class="treffer">${r.treffer} Treffer</span>
      </div>`;
    card.querySelector('[data-edit-rule]').addEventListener('click', () => openRuleForm(r));
    host.appendChild(card);
  }
  const sub = $('#view-rules .view-sub');
  if (sub) {
    const c = (art) => RULES.filter((r) => r.art === art).length;
    sub.textContent = `Zentrale Definition der Klassifizierung · ${RULES.length} Regeln · ${c('kategorie')} Kategorien, ${c('typ')} Typen, ${c('absender')} Absender`;
  }
}

function openRuleForm(rule) {
  const card = $('#regel-form-card');
  card.hidden = false;
  $('#regel-form-title').textContent = rule ? `Regel bearbeiten: ${rule.name}` : 'Neue Regel';
  const f = $('#regel-form');
  f.name.value = rule ? rule.name : '';
  f.tag.value = rule ? rule.tag : '';
  f.art.value = rule ? rule.art : 'kategorie';
  f.desc.value = rule ? rule.desc : '';
  f.keywords.value = rule ? rule.kw.join(', ') : '';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  f.name.focus();
}

$('#btn-new-rule').addEventListener('click', () => openRuleForm(null));
$('#btn-rule-cancel').addEventListener('click', () => { $('#regel-form-card').hidden = true; });

$('#regel-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  RULES.push({
    id: 'r' + (RULES.length + 1),
    name: f.name.value, tag: f.tag.value, art: f.art.value,
    ref: f.art.value === 'kategorie' ? 'sonst' : f.art.value === 'typ' ? 'brief' : 'unk',
    treffer: 0, desc: f.desc.value, kw: f.keywords.value.split(',').map((s) => s.trim()).filter(Boolean),
  });
  renderRules();
  $('#regel-form-card').hidden = true;
  $$('[data-count="rules"]').forEach((el) => (el.textContent = String(RULES.length)));
});

/* -------------------------------- Scan --------------------------------- */

const QUEUE = [
  { name: 'EON_Stromabrechnung_Q3_2026.pdf', state: 'klassifiziert', prog: 100 },
  { name: 'Gasabrechnung_2026-03.pdf', state: 'klassifiziert', prog: 100 },
  { name: 'Wasserabrechnung_Hammer.pdf', state: 'KI-Analyse …', prog: 62 },
  { name: 'Miete_Okt_2026.docx', state: 'in Warteschlange', prog: 8 },
  { name: 'VHV_Versicherung_Jahresrechnung.pdf', state: 'in Warteschlange', prog: 0 },
];

function renderQueue() {
  const host = $('#queue-list');
  host.innerHTML = '';
  for (const q of QUEUE) {
    const item = document.createElement('div');
    item.className = 'queue-item';
    item.innerHTML = `
      <div>
        <div class="queue-name">${q.name}</div>
        <div class="queue-state">${q.state}</div>
      </div>
      <div class="progress"><span style="width: ${q.prog}%"></span></div>`;
    host.appendChild(item);
  }
}

$$('[data-scan-pfad]').forEach((b) => b.addEventListener('click', () => {
  b.disabled = true;
  b.textContent = 'Scanne …';
  setTimeout(() => { b.disabled = false; b.textContent = 'Gescannt ✓'; }, 1400);
}));

/* ------------------------------ Dokument ------------------------------- */

function openDoc(id) {
  const d = DOCS.find((x) => x.id === id);
  if (!d) return;
  $('#doc-title').textContent = d.titel;
  $('#doc-sub').textContent = `${d.id === 'd1' || d.id === 'd2' ? 'PDF' : 'DOCX'} · ${ABSENDER[d.abs].label} · ${fmtDate(d.datum)}`;
  const low = d.tags.filter((t) => t.k < 0.6);
  $('#doc-alert').hidden = low.length === 0;
  if (low.length) $('#doc-alert').querySelector('p').textContent = `${low.length} Tag${low.length > 1 ? 's' : ''} mit niedriger Konfidenz (< 0.6) — bitte prüfen.`;

  const tagsHost = $('#doc-tags');
  tagsHost.innerHTML = '';
  for (const t of d.tags) {
    const c = catVar(t.ref, t.art);
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.dataset.art = t.art;
    chip.innerHTML = `<span class="dot" style="background: var(${c.varName})"></span>${t.t} <span class="konf">Konf. ${t.k.toFixed(2)}</span>`;
    tagsHost.appendChild(chip);
  }

  const meta = $('#doc-meta');
  meta.innerHTML = `
    <dt>Datei</dt><dd class="hlsw-mono">${d.titel.toLowerCase().replace(/[^a-z0-9]+/g, '_')}.${d.id === 'd1' || d.id === 'd2' ? 'pdf' : 'docx'}</dd>
    <dt>Quelle</dt><dd class="hlsw-mono">Posteingang/${d.datum.slice(0, 7)}/</dd>
    <dt>Erkannt</dt><dd>${fmtDate(d.datum)} · ${d.id === 'd1' || d.id === 'd2' ? 'PDF (Textlayer)' : 'DOCX (XML)'}</dd>
    <dt>Betrag</dt><dd>${d.betrag}</dd>
    <dt>KI-Modell</dt><dd>Qwen3.8-27B via OMLX</dd>`;

  const text = $('#doc-text');
  text.innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = d.titel;
  text.appendChild(h);
  const p = document.createElement('p');
  const lines = d.text.split('\n');
  lines.forEach((line, i) => {
    const span = document.createElement('span');
    span.textContent = line;
    if (/Hammerstraße 7|Hammer/.test(line) && /Frau Hammer|Hammerstraße/.test(line)) span.className = 'hl';
    p.appendChild(span);
    if (i < lines.length - 1) p.appendChild(document.createElement('br'));
  });
  text.appendChild(p);

  showView('document');
}

$('#btn-reclassify').addEventListener('click', (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = 'Klassifiziere …';
  setTimeout(() => { b.disabled = false; b.textContent = 'Neu klassifizieren'; }, 1600);
});

/* ------------------------------ Upload --------------------------------- */

const uploadDialog = $('#upload-dialog');
$$('[data-open-upload]').forEach((b) => b.addEventListener('click', () => { uploadDialog.showModal(); resetUpload(); }));
$('#btn-upload-close').addEventListener('click', () => uploadDialog.close());
$('#btn-upload-cancel').addEventListener('click', () => uploadDialog.close());

function resetUpload() {
  $('#upload-progress').dataset.laeuft = 'false';
  $('#upload-bar').style.width = '0%';
  $('#btn-upload-start').disabled = true;
}

$('#dropzone').addEventListener('click', () => {
  $('#upload-bar').style.width = '100%';
  $('#upload-status').textContent = '2 Dateien bereit: EON_Stromabrechnung_Q3_2026.pdf, VHV_Jahresrechnung.pdf';
  $('#btn-upload-start').disabled = false;
});

$('#btn-upload-start').addEventListener('click', () => {
  const bar = $('#upload-bar');
  const status = $('#upload-status');
  let p = 0;
  status.textContent = 'Wird hochgeladen …';
  const iv = setInterval(() => {
    p = Math.min(100, p + 18 + Math.random() * 14);
    bar.style.width = p + '%';
    if (p >= 100) {
      clearInterval(iv);
      status.textContent = 'Fertig — 2 Dokumente werden klassifiziert. Du kannst hier weiterarbeiten.';
      setTimeout(() => uploadDialog.close(), 1200);
    }
  }, 220);
});

/* -------------------------------- Init --------------------------------- */

renderDashboard();
renderFilters();
renderDocs();
renderRules();
renderQueue();
