/* ==========================================================================
   HammerClassify — Client (P2: Upload + Text, MoneyMe-Design)
   Login: echte WebAuthn-Flüsse gegen /api/auth (P1).
   Dokumente: echte API — Upload (Finder-Dialog + Drag&Drop), Textgewinnung
   (pdf.js im Browser), Deduplication, Liste, Detail, Export.
   Regeln und Scan bleiben Mock-Darstellung bis P3/P4 (konzept.md Bauplan).

   Navigation wie MoneyMe: Hash-Adressen (#uebersicht, #dokumente, …),
   Reiter mit Pille, Seitenleiste ab 1100 px, Bottom-Navigation auf dem Handy.
   Die CSP verbietet style-Attribute: Farben sind Klassen, Breiten setzt das
   Skript über element.style.
   ========================================================================== */
'use strict';

/* ------------------------------ Helpers -------------------------------- */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const fmtDate = (iso) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024).toLocaleString('de-DE')} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
};

const MAX_MB = 25;
const ERLAUBTE_EXT = new Set(['pdf', 'docx', 'zip']);

/* ------------------------------- State --------------------------------- */

let docs = [];
let aktuellesDok = null;
let kiStatus = { ok: null, grund: null, ms: null, gecheckt: null }; // ok: null = noch nicht geprüft

/* ------------------------------- API ----------------------------------- */

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
  zaeleNav();
}

/* ------------------------------- Toast --------------------------------- */

let toastTimer;
function toast(text, fehler) {
  const t = $('#toast');
  t.hidden = false;
  t.classList.toggle('err', !!fehler);
  t.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}
const fehlerToast = (e) => { console.error(e); toast(e.message || String(e), true); };

/* ------------------------------- Theme --------------------------------- */

const themaGespeichert = () => { try { return localStorage.getItem('hlsw-theme'); } catch { return null; } };
function setzeThema(t) {
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  try {
    t === 'light' || t === 'dark' ? localStorage.setItem('hlsw-theme', t) : localStorage.removeItem('hlsw-theme');
  } catch { /* nur diese Sitzung */ }
  navPille(); // die Pille nutzt hero-Farben — nach dem Themenwechsel neu ausmessen
}
setzeThema(themaGespeichert());

$('#btn-thema').addEventListener('click', () => {
  const r = document.documentElement.getAttribute('data-theme');
  setzeThema((r ? r === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches) ? 'light' : 'dark');
});

/* --------------------------- Navigation unten --------------------------- */

$('#unten-mehr').addEventListener('click', () => {
  $('#unten-mehr').classList.toggle('an', !$('#unten-mehr').classList.contains('an'));
});

/* ------------------------------ Login ---------------------------------- */

function zeigeLogin(modus) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  modus ||= 'anmelden';
  $('#login-text').textContent = modus === 'anmelden'
    ? 'Nur für registrierte Geräte.'
    : modus === 'einrichten'
      ? 'Noch kein Passkey hinterlegt. Leg den ersten an.'
      : 'Neuen Passkey mit dem Einrichtungscode anlegen.';
  $('#login-body').innerHTML = modus === 'anmelden'
    ? `<button class="hlsw-btn hlsw-btn--accent" type="button" data-act="login">${icon('key')}<span>Mit Passkey anmelden</span></button>
       <p class="hint">Neues Gerät oder alle Passkeys verloren? <a href="#" data-act="zur-einrichtung">Mit Einrichtungscode anlegen</a></p>`
    : `<form class="stack" data-form="setup" novalidate>
        <div class="hlsw-field"><label for="su-token">Einrichtungscode</label><input id="su-token" type="password" autocomplete="off" required><span class="hlsw-hint">Steht als SETUP_TOKEN in der .env auf dem hammerpi.</span></div>
        <button class="hlsw-btn hlsw-btn--accent" type="submit">${icon('lock')}<span>Passkey anlegen</span></button>
      </form>
      ${modus === 'einrichten' ? '' : '<p class="hint"><a href="#" data-act="zur-anmeldung">Zurück zur Anmeldung</a></p>'}`;
}

$('#login-body').addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.act === 'login') doLogin();
  else if (a.dataset.act === 'zur-einrichtung') zeigeLogin('einrichtung');
  else if (a.dataset.act === 'zur-anmeldung') zeigeLogin('anmelden');
});
$('#login-body').addEventListener('submit', (e) => {
  if (e.target.closest('[data-form="setup"]')) {
    e.preventDefault();
    doRegister();
  }
});

async function doLogin() {
  $('#login-text').textContent = 'Passkey wird abgefragt …';
  try {
    const options = await api('/api/auth/login/options', { method: 'POST' });
    const response = await WebAuthnClient.authenticate(options);
    await api('/api/auth/login/finish', { method: 'POST', body: { expectedOptions: options, response } });
    start();
  } catch (e) {
    $('#login-text').textContent = `Anmeldung fehlgeschlagen: ${e.message}`;
  }
}

async function doRegister() {
  const token = $('#su-token')?.value.trim();
  if (!token) {
    $('#login-text').textContent = 'Einrichtungscode eingeben.';
    return;
  }
  $('#login-text').textContent = 'Passkey wird erstellt …';
  try {
    const options = await api('/api/auth/register/options', { method: 'POST', setupToken: token });
    const response = await WebAuthnClient.register(options, token);
    await api('/api/auth/register/finish', { method: 'POST', body: { expectedOptions: options, response } });
    zeigeLogin('anmelden');
    $('#login-text').textContent = 'Passkey eingerichtet ✓ — jetzt anmelden.';
  } catch (e) {
    $('#login-text').textContent = `Einrichtung fehlgeschlagen: ${e.message}`;
  }
}

async function start() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  render();
  await refreshDocs();
  checkKi();
  ladeOmlx();
}

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* egal */ }
  zeigeLogin();
});

// Zustand beim Laden: Session prüfen, Setup-UI bei Leerlauf zeigen
(async () => {
  try {
    const state = await api('/api/auth/state');
    if (state.angemeldet) {
      start();
    } else if (!state.eingerichtet) {
      zeigeLogin('einrichtung');
    } else {
      zeigeLogin('anmelden');
    }
  } catch {
    zeigeLogin();
    $('#login-text').textContent = 'Server nicht erreichbar.';
  }
})();

/* --------------------------- Navigation (Hash) -------------------------- */

const TITEL = { uebersicht: 'Übersicht', dokumente: 'Dokumente', regeln: 'Regeln', scan: 'Scan', einstellungen: 'Einstellungen', dokument: 'Dokument' };
const NAV = { dokument: 'dokumente' };

/* Seitenleiste: die Amber-Pille liegt hinter dem aktiven Punkt und gleitet beim Seitenwechsel dorthin.
   Unter 1100 px ist sie per CSS aus, dort zeigt der Strich unter dem Reiter die Seite. */
let pilleBei = null;
function navPille(wechsel) {
  const p = $('.nav-pille'), a = $('.tabs a[aria-current="page"]');
  if (!p) return;
  p.hidden = !a;
  if (!a) return;
  p.style.transform = `translateY(${a.offsetTop}px)`;
  p.style.height = `${a.offsetHeight}px`;
  if (wechsel && pilleBei && pilleBei !== a) { p.classList.remove('glanz'); void p.offsetWidth; p.classList.add('glanz'); }
  if (wechsel) pilleBei = a;
  requestAnimationFrame(() => p.classList.add('bereit'));
}
new ResizeObserver(() => navPille()).observe($('.tabs'));
function setzeNavEng(eng) {
  eng ? document.documentElement.setAttribute('data-nav', 'eng') : document.documentElement.removeAttribute('data-nav');
  const b = $('#btn-nav');
  b.setAttribute('aria-pressed', String(eng));
  b.title = eng ? 'Navigation ausklappen' : 'Navigation einklappen';
  try { eng ? localStorage.setItem('hlsw-nav', 'eng') : localStorage.removeItem('hlsw-nav'); } catch { /* nur diese Sitzung */ }
  navPille();
}
try { setzeNavEng(localStorage.getItem('hlsw-nav') === 'eng'); } catch { /* bleibt weit */ }
$('#btn-nav').addEventListener('click', () => setzeNavEng(document.documentElement.getAttribute('data-nav') !== 'eng'));

function zaeleNav() {
  const total = docs.length;
  const cnt = $('#cnt-dokumente');
  if (cnt) cnt.textContent = total ? String(total) : '';
  const cntR = $('#cnt-regeln');
  if (cntR) cntR.textContent = String(RULES.length);
}

function render() {
  const [name, arg] = decodeURIComponent(location.hash.slice(1)).split('/');
  const v = TITEL[name] ? name : 'uebersicht';
  document.title = v === 'uebersicht' ? 'HammerClassify' : `${TITEL[v]} · HammerClassify`;

  $$('.view-seite').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  const nav = NAV[v] || v;
  $$('.tabs a, .unten > a, .mehr-menu a').forEach((a) => a.dataset.nav === nav ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  $('#unten-mehr')?.classList.toggle('an', ['regeln', 'scan', 'einstellungen'].includes(nav));
  navPille(true);

  if (v === 'uebersicht') renderDashboard();
  if (v === 'dokumente') renderDocs();
  if (v === 'regeln') renderRules();
  if (v === 'scan') renderQueue();
  if (v === 'einstellungen') renderEinstellungen();
  if (v === 'dokument') {
    if (arg) openDoc(arg);
    else location.hash = '#dokumente';
  }
  $('#main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => render());

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

$$('[data-open-upload]').forEach((b) => b.addEventListener('click', (e) => {
  e.preventDefault();
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
  const ico = { bereit: 'doc', laeuft: 'scan', fertig: 'check', doppelung: 'dopp', fehler: 'x' };
  for (const w of wahl) {
    const row = document.createElement('div');
    row.className = `upload-file uf-${w.status}`;
    row.innerHTML = `
      <span class="uf-icon" aria-hidden="true">${icon(ico[w.status])}</span>
      <span class="uf-name">${esc(w.file.name)}</span>
      <span class="uf-size">${fmtSize(w.file.size)}</span>
      <span class="uf-detail">${esc(w.detail)}</span>`;
    host.appendChild(row);
  }
  $('#btn-upload-start').disabled = !wahl.some((w) => w.status === 'bereit' || w.status === 'laeuft');
}

// Klick → Finder-Dialog (nativer File-Picker)
$('#dropzone').addEventListener('click', () => fileInput.click());
$('#dropzone').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
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
    status.textContent = w.file.name;
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
  const keintext = docs.filter((d) => d.text_status === 'kein_text').length;
  const woche = docs.filter((d) => Date.now() - Date.parse(d.created_at) < 7 * 86400_000).length;

  $$('[data-stat="total"]').forEach((el) => (el.textContent = String(total)));
  $$('[data-stat="imingang"]').forEach((el) => (el.textContent = String(imingang)));
  $$('[data-stat="keintext"]').forEach((el) => (el.textContent = String(keintext)));
  $$('[data-stat="regeln"]').forEach((el) => (el.textContent = String(RULES.length)));

  const notes = {
    total: woche ? `+${woche} diese Woche` : 'noch keine diese Woche',
    imingang: imingang ? 'warten auf die Einordnung (ab P3)' : 'alle eingeordnet',
    keintext: keintext ? 'Scans — OCR kommt mit V2' : 'alle mit Textschicht',
    regeln: 'Beispiele — echte Regeln ab P3',
  };
  for (const [key, note] of Object.entries(notes)) {
    const el = $(`[data-note="${key}"]`);
    if (el) el.textContent = note;
  }

  const sub = $('#dash-sub');
  if (sub) sub.textContent = `${total} Dokumente · ${imingang} imingang · Regeln ab P3`;

  // Kategorien-Verteilung: ab P3
  const dist = $('#dist-kat');
  if (dist) dist.innerHTML = '<p class="dist-empty">Die Kategorien-Verteilung erscheint mit P3 (Regeln + KI-Klassifizierung).</p>';

  // Letzte Dokumente
  const tbody = $('#recent-tbody');
  tbody.innerHTML = '';
  if (!docs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="leer"><p>Noch keine Dokumente — oben oder bei „Dokumente" hochladen.</p></td></tr>';
  } else {
    for (const d of docs.slice(0, 5)) tbody.appendChild(docRow(d, true));
  }

  renderKiCard();
}

function renderKiCard() {
  const row = $('#ki-row');
  if (!row) return;
  if (kiStatus.ok === null) {
    row.dataset.ki = 'ok';
    $('#ki-row-text').textContent = 'KI-Status wird geprüft …';
  } else if (kiStatus.ok) {
    row.dataset.ki = 'ok';
    $('#ki-row-text').textContent = kiStatus.meldung || `OMLX erreichbar (${kiStatus.ms} ms)`;
  } else {
    row.dataset.ki = 'offline';
    $('#ki-row-text').textContent = kiStatus.meldung || `KI nicht erreichbar${kiStatus.grund ? ` — ${kiStatus.grund}` : ''}`;
  }
  const ep = $('#ki-endpoint');
  if (ep) ep.textContent = omlxCfg.url || 'nicht konfiguriert';
  const g = $('#ki-gecheckt');
  if (g) g.textContent = kiStatus.gecheckt ? `vor ${Math.max(1, Math.round((Date.now() - kiStatus.gecheckt) / 60000))} Min.` : 'noch nicht';
}

async function checkKi() {
  try {
    const s = await api('/api/ki/status');
    kiStatus = { ...s, gecheckt: Date.now() };
  } catch {
    kiStatus = { ok: false, grund: 'Server', gecheckt: Date.now() };
  }
  $$('[data-ki]').forEach((el) => {
    el.dataset.ki = kiStatus.ok ? 'ok' : 'offline';
  });
  const t = $('#nav-ki-text');
  if (t) t.textContent = kiStatus.ok ? 'KI bereit' : 'KI offline';
  renderKiCard();
}

/* ----------------------------- Einstellungen ---------------------------- */
/* OMLX-Verbindung hinterlegen und testen. Der Schlüssel kommt nie im
   Klartext zurück (nur maskiert); leeres Feld = gespeicherter Wert bleibt. */

let omlxCfg = { url: null, key_gegeben: false, key_maskiert: null, quelle: null };
let omlxStatus = null; // Ergebnis des letzten Verbindungstests

async function ladeOmlx() {
  try {
    omlxCfg = await api('/api/omlx');
  } catch {
    omlxCfg = { url: null, key_gegeben: false, key_maskiert: null, quelle: null };
  }
  api('/api/health').then((h) => {
    const v = $('#sys-version');
    if (v) v.textContent = `${h.app} v${h.version}`;
  }).catch(() => { /* egal */ });
  renderKiCard(); // Endpoint im Dashboard-Card aktualisieren
  renderEinstellungen();
}

function renderEinstellungen() {
  const url = $('#omlx-url');
  if (!url) return;
  if (document.activeElement !== url) url.value = omlxCfg.url ?? '';
  $('#omlx-key-hint').textContent = omlxCfg.key_gegeben
    ? `Gespeichert: ${omlxCfg.key_maskiert} — leer lassen, um ihn beizubehalten.`
    : 'Leer lassen, um OMLX_KEY aus der .env zu verwenden (falls dort gesetzt).';
  $('#sys-omlx-quelle').textContent = omlxCfg.quelle === 'einstellungen' ? 'Einstellungen (in der Datenbank gespeichert)'
    : omlxCfg.quelle === 'env' ? '.env auf dem Server'
    : 'nicht konfiguriert';
  $('#sys-origin').textContent = location.origin;
  zeigeOmlxStatus();
  if (!omlxStatus) testOmlx(); // beim ersten Betreten: aktuellen Zustand zeigen
}

function zeigeOmlxStatus() {
  const box = $('#omlx-status');
  if (!box) return;
  if (!omlxStatus) { box.hidden = true; return; }
  box.hidden = false;
  box.classList.remove('hlsw-alert--success', 'hlsw-alert--danger', 'hlsw-alert--info');
  box.classList.add(omlxStatus.ok ? 'hlsw-alert--success'
    : omlxStatus.grund === 'nicht_konfiguriert' ? 'hlsw-alert--info'
    : 'hlsw-alert--danger');
  $('#omlx-status-text').textContent = omlxStatus.meldung;
}

function testOmlx() {
  const btn = $('#btn-omlx-test');
  const label = btn?.querySelector('span');
  if (label) label.textContent = 'Prüfe …';
  if (btn) btn.disabled = true;
  return api('/api/omlx/test', { method: 'POST', body: { url: $('#omlx-url').value, key: $('#omlx-key').value } })
    .then((s) => { omlxStatus = s; })
    .catch((e) => { omlxStatus = { ok: false, grund: 'server', meldung: `Test fehlgeschlagen: ${e.message}` }; })
    .finally(() => {
      if (label) label.textContent = 'Verbindung testen';
      if (btn) btn.disabled = false;
      zeigeOmlxStatus();
    });
}

$('#btn-omlx-test').addEventListener('click', () => testOmlx());

$('#omlx-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/omlx', { method: 'PUT', body: { url: $('#omlx-url').value, key: $('#omlx-key').value } });
    toast('Einstellungen gespeichert.');
    await ladeOmlx();
    omlxStatus = null;
    testOmlx(); // neue Werte sofort gegen OMLX prüfen
    checkKi();
  } catch (err) {
    fehlerToast(err);
  }
});

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

function statusBadge(d) {
  const k = d.status === 'imingang' ? 'imingang' : d.status === 'abgelegt' ? 'abgelegt' : 'klasse';
  const label = d.status === 'imingang' ? 'Imingang' : d.status === 'abgelegt' ? 'Abgelegt' : 'Klassifiziert';
  return `<span class="hlsw-badge st-${k}">${label}</span>`;
}

function textBadge(d) {
  if (d.text_status === 'kein_text') return '<span class="hlsw-badge hlsw-badge--danger">Kein Text</span>';
  if (d.text_status === 'ok') return '<span class="hlsw-badge hlsw-badge--success">Text</span>';
  return '<span class="hlsw-badge hlsw-badge--neutral">—</span>';
}

function docRow(d, compact) {
  const tr = document.createElement('tr');
  tr.className = 'klick';
  tr.innerHTML = `
    <td class="titel"><a class="t-link" href="#dokument/${d.id}"><span class="t-main">${esc(d.name)}</span><span class="t-sub">${fmtSize(d.size)}</span></a></td>
    <td>${d.ext.toUpperCase()}</td>
    <td class="num">${fmtSize(d.size)}</td>
    <td>${statusBadge(d)}</td>
    ${compact ? '' : `<td>${textBadge(d)}</td>`}
    <td class="num">${fmtDate(d.created_at)}</td>`;
  tr.addEventListener('click', (e) => {
    if (e.target.closest('button, input, select, a')) return;
    location.hash = `#dokument/${d.id}`;
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
    tr.innerHTML = `<td colspan="6" class="leer"><p>${docs.length ? 'Keine Dokumente gefunden.' : 'Noch keine Dokumente — oben hochladen.'}</p></td>`;
    tbody.appendChild(tr);
  }
  const sub = $('#docs-sub');
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
  nebenn: { label: 'Nebenkosten', klasse: 'kat-teal' },
  miet: { label: 'Miete', klasse: 'kat-blau' },
  vers: { label: 'Versicherung', klasse: 'kat-violett' },
  telek: { label: 'Telekommunikation', klasse: 'kat-pink' },
  sonst: { label: 'Sonstiges', klasse: 'kat-grau' },
};
const ART = {
  rechnung: { label: 'Rechnung', klasse: 'kat-gruen' },
  angebot: { label: 'Angebot', klasse: 'kat-oliv' },
  kuend: { label: 'Kündigung', klasse: 'kat-rot' },
  brief: { label: 'Brief', klasse: 'kat-grau' },
};
const ABSENDER = {
  eon: { label: 'E.ON Energie', klasse: 'kat-teal' },
  vh: { label: 'VHV Versicherung', klasse: 'kat-violett' },
  t: { label: 'Telekom', klasse: 'kat-pink' },
  wg: { label: 'Wohnungsgesellschaft', klasse: 'kat-blau' },
  unk: { label: 'Unbekannt', klasse: 'kat-grau' },
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
        <span class="hlsw-badge ${c.klasse}">${r.art === 'kategorie' ? 'Kategorie' : r.art === 'typ' ? 'Typ' : 'Absender'}</span>
        <h3>${esc(r.name)}</h3>
        <span class="rule-mock">Beispiel</span>
        <button class="hlsw-btn hlsw-btn--ghost btn-sm" data-edit-rule="${r.id}" type="button">Bearbeiten</button>
      </div>
      <p class="rule-desc">${esc(r.desc)}</p>
      <div class="kw-row">${r.kw.map((k) => `<span class="kw-chip">${esc(k)}</span>`).join('')}</div>
      <div class="rule-foot">
        <span class="hlsw-badge hlsw-badge--neutral">→ Tag: ${esc(r.tag)}</span>
        <span class="treffer">${r.treffer} Treffer</span>
      </div>`;
    card.querySelector('[data-edit-rule]').addEventListener('click', () => openRuleForm(r));
    host.appendChild(card);
  }
  const sub = $('#rules-sub');
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
  zaeleNav();
  toast('Regel gespeichert (Beispiel — die echte Regeln-UI kommt mit P3)');
});

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
        <div class="queue-name">${esc(q.name)}</div>
        <div class="queue-state">${esc(q.state)} — der echte Scan kommt mit P4</div>
      </div>
      <div class="progress"><span data-prog="${q.prog}"></span></div>`;
    host.appendChild(item);
  }
  // Breite per element.style: die CSP verbietet style-Attribute im Markup
  requestAnimationFrame(() => { $$('#queue-list [data-prog]').forEach((s) => { s.style.width = `${s.dataset.prog}%`; }); });
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
    $('#doc-alert-text').textContent = 'Kein Text extrahiert — vermutlich ein Scan. Manuell einordnen (OCR kommt mit V2).';
  } else {
    alert.hidden = true;
  }

  const tagsHost = $('#doc-tags');
  tagsHost.innerHTML = '<p class="dist-empty">Noch keine Tags — die KI-Klassifizierung kommt mit P3.</p>';

  $('#doc-meta').innerHTML = `
    <dt>Datei</dt><dd class="mono">${esc(d.name)}</dd>
    <dt>Typ</dt><dd>${d.ext.toUpperCase()} (${esc(d.mime)})</dd>
    <dt>Größe</dt><dd>${fmtSize(d.size)}</dd>
    <dt>SHA-256</dt><dd class="mono">${d.sha256.slice(0, 16)}…</dd>
    <dt>Status</dt><dd>${d.status === 'imingang' ? 'Imingang' : esc(d.status)}</dd>
    <dt>Text</dt><dd>${d.text ? `${d.text.length.toLocaleString('de-DE')} Zeichen` : 'kein Text (Scan?)'}</dd>
    <dt>Hochgeladen</dt><dd>${fmtDateTime(d.created_at)}</dd>`;

  const text = $('#doc-text');
  text.innerHTML = '';
  if (d.text) {
    const pre = document.createElement('pre');
    pre.className = 'doc-text';
    pre.textContent = d.text;
    text.appendChild(pre);
  } else {
    const p = document.createElement('p');
    p.className = 'dist-empty';
    p.textContent = 'Kein Volltext — das Dokument wurde gespeichert, aber keine Textschicht gefunden.';
    text.appendChild(p);
  }
}

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
    `| Status | ${d.status === 'imingang' ? 'Imingang' : d.status} |`,
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
zaeleNav();
if (!location.hash) location.hash = '#uebersicht';
else render();
