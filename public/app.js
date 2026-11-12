/* ==========================================================================
   HammerClassify — Client (P2: Upload + Text)
   Login: echte WebAuthn-Flüsse gegen /api/auth (P1).
   Dokumente: echte API — Upload (Finder-Dialog + Drag&Drop), Textgewinnung
   (pdf.js im Browser), Deduplication, Liste, Detail, Export.
   Regeln und Scan bleiben Mock-Darstellung bis P3/P4 (konzept.md Bauplan).
   ========================================================================== */
'use strict';

/* ------------------------------ Helpers -------------------------------- */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString('de-DE')} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
};

const MAX_MB = 25;
const ERLAUBTE_EXT = new Set(['pdf', 'docx', 'zip']);
const STATUS = { imingang: { label: 'Imingang', varName: '--kat-oliv', sub: '--kat-oliv-s' } };

/* ------------------------------- State --------------------------------- */

let docs = [];
let aktuellesDok = null;
let kiStatus = { ok: null, grund: null, ms: null, gecheckt: null }; // ok: null = noch nicht geprüft

/* -------------------------------- API ----------------------------------- */

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

// Multipart-Upload per XHR (liefert echte Upload-Fortschritts-Events)
function uploadFile(file, text, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('datei', file, file.name);
    if (text) fd.append('text', text);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/documents');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response ?? {});
      } else {
        let msg = `HTTP ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).fehler || msg; } catch { /* rohe Antwort */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Netzwerkfehler'));
    xhr.send(fd);
  });
}

async function refreshDocs() {
  try {
    docs = (await api('/api/documents')).dokumente;
  } catch {
    docs = [];
  }
  renderDashboard();
  renderDocs();
}

/* ------------------------------- Login --------------------------------- */

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
    await refreshDocs();
    checkKi();
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
      await refreshDocs();
      checkKi();
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

/* --------------------------- PDF-Textgewinnung -------------------------- */
/* .pdf: der Browser extrahiert mit pdf.js (lokal ausgeliefert) und schickt
   den Text als Feld „text" mit — der Server braucht keine PDF-Library. */

let pdfjsMod;

function pageText(items) {
  const lines = [];
  let cur = '';
  let lastY = null;
  const flush = () => {
    const l = cur.trim();
    if (l) lines.push(l);
    cur = '';
  };
  for (const it of items) {
    if (it.hasEOL) { flush(); lastY = null; continue; }
    if (!it.str) continue;
    const y = it.transform ? it.transform[5] : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) flush();
    cur += it.str; // pdf.js trägt Zeilenabstände bereits in str
    lastY = y ?? lastY;
  }
  flush();
  return lines.join('\n');
}

async function extractPdfText(file) {
  pdfjsMod ??= await import('/vendor/pdfjs/pdf.min.mjs');
  if (!pdfjsMod.GlobalWorkerOptions.workerSrc) {
    pdfjsMod.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsMod.getDocument({ data, isEvalSupported: false }).promise;
  const seiten = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    seiten.push(pageText((await page.getTextContent()).items));
  }
  await doc.destroy();
  return seiten.join('\n\n').trim();
}

/* ------------------------------- Upload -------------------------------- */

const uploadDialog = $('#upload-dialog');
const fileInput = $('#file-input');
let wahl = []; // [{ file, ext, status, detail }]

$$('[data-open-upload]').forEach((b) => b.addEventListener('click', () => {
  uploadDialog.showModal();
  resetUpload();
}));
$('#btn-upload-close').addEventListener('click', () => uploadDialog.close());
$('#btn-upload-cancel').addEventListener('click', () => uploadDialog.close());

function resetUpload() {
  wahl = [];
  renderWahl();
  $('#upload-progress').dataset.laeuft = 'false';
  $('#upload-bar').style.width = '0%';
  $('#upload-status').textContent = 'Wird hochgeladen …';
  $('#btn-upload-start').disabled = true;
}

function addFiles(fileList) {
  for (const f of fileList) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    let status = 'bereit';
    let detail = '';
    if (!ERLAUBTE_EXT.has(ext)) {
      status = 'fehler';
      detail = `Typ .${ext || '?'} nicht erlaubt (nur .pdf, .docx, .zip)`;
    } else if (f.size > MAX_MB * 1024 * 1024) {
      status = 'fehler';
      detail = `Zu groß: ${fmtSize(f.size)} (max. ${MAX_MB} MB)`;
    }
    wahl.push({ file: f, ext, status, detail });
  }
  renderWahl();
  fileInput.value = ''; // dieselbe Datei erneut wählbar machen
}

function renderWahl() {
  const host = $('#upload-files');
  host.hidden = wahl.length === 0;
  host.innerHTML = '';
  const icon = { bereit: '○', laeuft: '◌', fertig: '✓', doppelung: '≈', fehler: '✕' };
  const farbe = { bereit: 'var(--text-muted)', laeuft: 'var(--accent)', fertig: 'var(--success)', doppelung: 'var(--warning, var(--text-muted))', fehler: 'var(--danger)' };
  for (const w of wahl) {
    const row = document.createElement('div');
    row.className = 'upload-file';
    row.innerHTML = `
      <span class="uf-icon" style="color: ${farbe[w.status]}">${icon[w.status]}</span>
      <span class="uf-name">${esc(w.file.name)}</span>
      <span class="uf-size">${fmtSize(w.file.size)}</span>
      <span class="uf-detail">${esc(w.detail)}</span>`;
    host.appendChild(row);
  }
  $('#btn-upload-start').disabled = !wahl.some((w) => w.status === 'bereit' || w.status === 'laeuft');
}

// Klick → Finder-Dialog (nativer File-Picker)
$('#dropzone').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) addFiles(fileInput.files);
});

// Drag&Drop: preventDefault, sonst öffnet Safari die PDF im Viewer
const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  dropzone.dataset.drag = 'true';
});
dropzone.addEventListener('dragleave', () => { dropzone.dataset.drag = 'false'; });
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.dataset.drag = 'false';
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

$('#btn-upload-start').addEventListener('click', async () => {
  const files = wahl.filter((w) => w.status === 'bereit');
  if (!files.length) return;
  const bar = $('#upload-bar');
  const status = $('#upload-status');
  $('#upload-progress').dataset.laeuft = 'true';
  $('#btn-upload-start').disabled = true;

  let ok = 0, dopp = 0, fehler = 0;
  for (const w of files) {
    w.status = 'laeuft';
    w.detail = w.ext === 'pdf' ? 'Text wird extrahiert …' : 'Wird hochgeladen …';
    renderWahl();
    bar.style.width = '5%';
    status.textContent = `${w.file.name}`;
    try {
      let text = '';
      if (w.ext === 'pdf') {
        try {
          text = await extractPdfText(w.file);
        } catch (e) {
          w.status = 'fehler';
          w.detail = `PDF-Text fehlgeschlagen: ${e.message}`;
          renderWahl();
          fehler++;
          continue;
        }
      }
      const r = await uploadFile(w.file, text, (p) => { bar.style.width = `${Math.round(p * 100)}%`; });
      if (r.doppelung) {
        w.status = 'doppelung';
        w.detail = 'Bereits vorhanden (gleiche Datei)';
        dopp++;
      } else {
        w.status = 'fertig';
        w.detail = r.text_status === 'kein_text'
          ? 'Gespeichert — kein Text (Scan?)'
          : `Gespeichert · ${r.text_zeichen?.toLocaleString('de-DE') ?? 0} Zeichen Text`;
        ok++;
      }
    } catch (e) {
      w.status = 'fehler';
      w.detail = e.message;
      fehler++;
    }
    renderWahl();
  }

  bar.style.width = '100%';
  const teile = [
    ok ? `${ok} hochgeladen` : '',
    dopp ? `${dopp} als Duplikat erkannt` : '',
    fehler ? `${fehler} fehlgeschlagen` : '',
  ].filter(Boolean);
  status.textContent = teile.length ? `Fertig — ${teile.join(', ')}.` : 'Fertig.';
  await refreshDocs();
  setTimeout(() => {
    if (!uploadDialog.open) return;
    uploadDialog.close();
    resetUpload();
  }, 2500);
});

/* ------------------------------ Dashboard ------------------------------ */

function renderDashboard() {
  const total = docs.length;
  const imingang = docs.filter((d) => d.status === 'imingang').length;
  const woche = docs.filter((d) => Date.now() - Date.parse(d.created_at) < 7 * 86400_000).length;

  $$('[data-stat="total"]').forEach((el) => (el.textContent = String(total)));
  $$('[data-stat="rechnungen"]').forEach((el) => (el.textContent = '—'));
  $$('[data-stat="fristen"]').forEach((el) => (el.textContent = '—'));
  $$('[data-stat="unclassified"]').forEach((el) => (el.textContent = '—'));
  $$('[data-count="documents"]').forEach((el) => (el.textContent = String(total)));

  const sub = $('#view-dashboard .view-sub');
  if (sub) sub.textContent = `${total} Dokumente · ${imingang} imingang · Regeln ab P3`;

  // Stat-Notizen
  const notes = { total: woche ? `+${woche} diese Woche` : 'noch keine diese Woche', rechnungen: 'ab P3', fristen: 'ab P3', unclassified: 'ab P3' };
  for (const [key, note] of Object.entries(notes)) {
    const card = $(`[data-stat="${key}"]`)?.closest('.stat-card');
    const el = card?.querySelector('.stat-note');
    if (el) el.textContent = note;
  }

  // Kategorien-Verteilung: ab P3
  const dist = $('#dist-kat');
  dist.innerHTML = '<p class="dist-empty">Die Kategorien-Verteilung erscheint mit P3 (Regeln + KI-Klassifizierung).</p>';

  // Letzte Dokumente
  const tbody = $('#recent-tbody');
  tbody.innerHTML = '';
  if (!docs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Noch keine Dokumente — oben oder bei „Dokumente" hochladen.</td></tr>';
  } else {
    for (const d of docs.slice(0, 5)) tbody.appendChild(docRow(d, true));
  }

  // KI-Status-Karte
  renderKiCard();
}

function renderKiCard() {
  const row = $('.ki-row');
  if (!row) return;
  if (kiStatus.ok === null) {
    row.dataset.ki = 'offline';
    row.lastChild.textContent = 'KI-Status wird geprüft …';
  } else if (kiStatus.ok) {
    row.dataset.ki = 'ok';
    row.lastChild.textContent = `OMLX erreichbar (${kiStatus.ms} ms)`;
  } else {
    row.dataset.ki = 'offline';
    row.lastChild.textContent = `KI nicht erreichbar${kiStatus.grund ? ` — ${kiStatus.grund}` : ''}`;
  }
  const dd = $('.ki-meta dd:last-child');
  if (dd) dd.textContent = kiStatus.gecheckt ? `vor ${Math.max(1, Math.round((Date.now() - kiStatus.gecheckt) / 60000))} Min.` : 'noch nicht';
  const durchsatz = $$('.ki-meta dd')[3];
  if (durchsatz) durchsatz.textContent = 'ab P3';
}

async function checkKi() {
  try {
    const s = await api('/api/ki/status');
    kiStatus = { ...s, gecheckt: Date.now() };
  } catch {
    kiStatus = { ok: false, grund: 'Server', gecheckt: Date.now() };
  }
  const dot = (label, offline) => {
    $$('[data-ki]').forEach((el) => {
      el.dataset.ki = offline ? 'offline' : 'ok';
    });
    const t = $('#nav-ki-text');
    if (t) t.textContent = label;
  };
  if (kiStatus.ok) dot('KI bereit', false);
  else dot('KI nicht erreichbar', true);
  renderKiCard();
}

/* ------------------------------ Dokumente ------------------------------ */

let filterStatus = null;

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
  host.appendChild(chip('Alle', !filterStatus, () => { filterStatus = null; renderFilters(); renderDocs(); }));
  const sep = document.createElement('span');
  sep.className = 'filter-sep';
  host.appendChild(sep);
  host.appendChild(chip('Imingang', filterStatus === 'imingang', () => {
    filterStatus = filterStatus === 'imingang' ? null : 'imingang';
    renderFilters();
    renderDocs();
  }));
}

function docRow(d, compact) {
  const tr = document.createElement('tr');
  const s = STATUS[d.status] ?? { label: d.status, varName: '--kat-grau', sub: '--kat-grau-s' };
  const textChip = d.text_status === 'kein_text'
    ? '<span class="hlsw-badge" style="background: var(--kat-rot-s); color: var(--kat-rot)">Kein Text</span>'
    : d.text_status === 'ok'
      ? '<span class="hlsw-badge" style="background: var(--kat-gruen-s); color: var(--kat-gruen)">Text</span>'
      : '<span class="hlsw-badge" style="background: var(--bg-inset); color: var(--text-muted)">—</span>';
  tr.innerHTML = `
    <td><a href="#" data-doc="${d.id}"><span class="doc-name">${esc(d.name)}</span><br><span class="doc-sub">${fmtSize(d.size)}</span></a></td>
    <td>${d.ext.toUpperCase()}</td>
    <td class="betrag">${fmtSize(d.size)}</td>
    <td><span class="hlsw-badge" style="background: var(${s.sub}); color: var(${s.varName})">${esc(s.label)}</span></td>
    ${compact ? '' : `<td>${textChip}</td>`}
    <td>${fmtDate(d.created_at)}</td>`;
  tr.querySelector('[data-doc]').addEventListener('click', (e) => {
    e.preventDefault();
    openDoc(d.id);
  });
  return tr;
}

function renderDocs() {
  const tbody = $('#docs-tbody');
  tbody.innerHTML = '';
  const q = ($('#search').value || '').toLowerCase();
  const list = docs.filter((d) => {
    if (filterStatus && d.status !== filterStatus) return false;
    if (q) {
      const hay = `${d.name} ${d.text_vorschau ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  for (const d of list) tbody.appendChild(docRow(d, false));
  if (!list.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="empty-cell">${docs.length ? 'Keine Dokumente gefunden.' : 'Noch keine Dokumente — oben hochladen.'}</td>`;
    tbody.appendChild(tr);
  }
  const sub = $('#view-documents .view-sub');
  if (sub) sub.textContent = `${list.length} von ${docs.length} Dokumenten · Regeln ab P3`;
}

$('#search').addEventListener('input', renderDocs);

/* ------------------------------- Regeln -------------------------------- */
/* Mock bis P3: die Regeln-UI (CRUD gegen die DB) kommt mit der Phase
   „Regeln + KI". Die Karten spiegeln das geplante Regelschema. */

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

const KAT = {
  nebenn: { label: 'Nebenkosten', varName: '--kat-teal', sub: '--kat-teal-s' },
  miet: { label: 'Miete', varName: '--kat-blau', sub: '--kat-blau-s' },
  vers: { label: 'Versicherung', varName: '--kat-violett', sub: '--kat-violett-s' },
  telek: { label: 'Telekommunikation', varName: '--kat-pink', sub: '--kat-pink-s' },
  sonst: { label: 'Sonstiges', varName: '--kat-grau', sub: '--kat-grau-s' },
};
const ART = {
  rechnung: { label: 'Rechnung', varName: '--kat-gruen', sub: '--kat-gruen-s' },
  angebot: { label: 'Angebot', varName: '--kat-oliv', sub: '--kat-oliv-s' },
  kuend: { label: 'Kündigung', varName: '--kat-rot', sub: '--kat-rot-s' },
  brief: { label: 'Brief', varName: '--kat-grau', sub: '--kat-grau-s' },
};
const ABSENDER = {
  eon: { label: 'E.ON Energie', varName: '--kat-teal', sub: '--kat-teal-s' },
  vh: { label: 'VHV Versicherung', varName: '--kat-violett', sub: '--kat-violett-s' },
  t: { label: 'Telekom', varName: '--kat-pink', sub: '--kat-pink-s' },
  wg: { label: 'Wohnungsgesellschaft', varName: '--kat-blau', sub: '--kat-blau-s' },
  unk: { label: 'Unbekannt', varName: '--kat-grau', sub: '--kat-grau-s' },
};
const catVar = (ref, art) => (art === 'kategorie' ? KAT[ref] : art === 'typ' ? ART[ref] : ABSENDER[ref]);

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
        <span class="rule-mock">Beispiel</span>
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
    sub.textContent = `Beispiel-Regeln — die echte Regeln-UI kommt mit P3 · ${RULES.length} Regeln · ${c('kategorie')} Kategorien, ${c('typ')} Typen, ${c('absender')} Absender`;
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

$$('[data-count="rules"]').forEach((el) => (el.textContent = String(RULES.length)));

/* -------------------------------- Scan --------------------------------- */
/* Mock bis P4: Verzeichnis-Scan + Queue. */

const QUEUE = [
  { name: 'EON_Stromabrechnung_Q3_2026.pdf', state: 'Beispiel', prog: 100 },
  { name: 'Gasabrechnung_2026-03.pdf', state: 'Beispiel', prog: 100 },
  { name: 'Wasserabrechnung_Hammer.pdf', state: 'Beispiel', prog: 62 },
  { name: 'Miete_Okt_2026.docx', state: 'Beispiel', prog: 8 },
  { name: 'VHV_Versicherung_Jahresrechnung.pdf', state: 'Beispiel', prog: 0 },
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
        <div class="queue-state">${q.state} — der echte Scan kommt mit P4</div>
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

async function openDoc(id) {
  const inListe = docs.find((x) => x.id === id);
  let d = inListe;
  try {
    d = await api(`/api/documents/${id}`); // mit Volltext
  } catch (e) {
    if (!inListe) return;
    d = { ...inListe, text: null };
  }
  aktuellesDok = d;

  $('#doc-title').textContent = d.name;
  $('#doc-sub').textContent = `${d.ext.toUpperCase()} · ${fmtSize(d.size)} · ${fmtDateTime(d.created_at)}`;

  const alert = $('#doc-alert');
  if (d.text_status === 'kein_text') {
    alert.hidden = false;
    alert.querySelector('p').textContent = 'Kein Text extrahiert — vermutlich ein Scan. Manuell einordnen (OCR kommt mit V2).';
  } else {
    alert.hidden = true;
  }

  const tagsHost = $('#doc-tags');
  tagsHost.innerHTML = '<p class="dist-empty">Noch keine Tags — die KI-Klassifizierung kommt mit P3.</p>';

  const meta = $('#doc-meta');
  meta.innerHTML = `
    <dt>Datei</dt><dd class="hlsw-mono">${esc(d.name)}</dd>
    <dt>Typ</dt><dd>${d.ext.toUpperCase()} (${esc(d.mime)})</dd>
    <dt>Größe</dt><dd>${fmtSize(d.size)}</dd>
    <dt>SHA-256</dt><dd class="hlsw-mono">${d.sha256.slice(0, 16)}…</dd>
    <dt>Status</dt><dd>${esc(STATUS[d.status]?.label ?? d.status)}</dd>
    <dt>Text</dt><dd>${d.text ? `${d.text.length.toLocaleString('de-DE')} Zeichen` : 'kein Text (Scan?)'}</dd>
    <dt>Hochgeladen</dt><dd>${fmtDateTime(d.created_at)}</dd>`;

  const text = $('#doc-text');
  text.innerHTML = '';
  if (d.text) {
    const pre = document.createElement('pre');
    pre.className = 'doc-text-pre';
    pre.textContent = d.text;
    text.appendChild(pre);
  } else {
    const p = document.createElement('p');
    p.className = 'dist-empty';
    p.textContent = 'Kein Volltext — das Dokument wurde gespeichert, aber kein Textschicht gefunden.';
    text.appendChild(p);
  }

  showView('document');
}

function showView(name) {
  $$('.nav-link').forEach((l) => l.setAttribute('aria-current', l.dataset.view === name ? 'page' : 'false'));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-view]');
  if (nav && nav.dataset.view !== 'document') {
    showView(nav.dataset.view);
    if (nav.dataset.view === 'documents') renderDocs();
    if (nav.dataset.view === 'dashboard') renderDashboard();
  }
});

// Export als .md: Metadaten + Volltext, clientseitig als Download
$('#btn-export').addEventListener('click', () => {
  const d = aktuellesDok;
  if (!d) return;
  const md = [
    `# ${d.name}`,
    '',
    `| Feld | Wert |`,
    `|---|---|`,
    `| Typ | ${d.ext.toUpperCase()} |`,
    `| Größe | ${fmtSize(d.size)} |`,
    `| SHA-256 | \`${d.sha256}\` |`,
    `| Status | ${STATUS[d.status]?.label ?? d.status} |`,
    `| Hochgeladen | ${fmtDateTime(d.created_at)} |`,
    '',
    '## Volltext',
    '',
    d.text ? '```\n' + d.text + '\n```' : '_Kein Text (Scan?)_',
    '',
  ].join('\n');
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = d.name.replace(/[^\w.\-äöüßÄÖÜ]+/g, '_') + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
});

// Original-Download (Session-Cookie, Attachment)
$('#btn-download').addEventListener('click', () => {
  const d = aktuellesDok;
  if (!d) return;
  window.location.href = `/api/documents/${d.id}/download`;
});

/* -------------------------------- Init --------------------------------- */

renderDashboard();
renderFilters();
renderDocs();
renderRules();
renderQueue();
