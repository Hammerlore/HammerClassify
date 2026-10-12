# HammerClassify — Next Steps

Stand: 12.10.2026 · Branch: `p1-geruest` (Commit `bb1d3d7`) · gepusht, PR noch offen

Diese Datei ist die Übergabe an die nächste Session. Erst hier lesen, dann weiterbauen.

## 1. Was schon steht (P1: Gerüst)

| Teil | Status |
|---|---|
| `src/server.js` | Express 5, Bind 127.0.0.1:3014, CSP `frame-ancestors 'none'`, HSTS, `X-Content-Type-Options`, Origin-Check für POST, JSON-Fehler |
| `src/auth.js` | simplewebauthn 13: Registrierung (nur Erststart oder mit `SETUP_TOKEN`), Login, Session 30 Tage (httpOnly, SameSite=Strict, Secure, SHA-256-Hash in DB), jede Sitzung kennt ihren Passkey, `logout-others` |
| `src/db.js` | better-sqlite3, `data/classify.db`, WAL, Migration Stand 1: `users`, `passkeys`, `sessions` |
| `src/env.js` | `.env`-Ladung + strikte Validierung (RP_ID, SETUP_TOKEN ≥ 20 Zeichen, PORT) |
| `src/setup.js` | CLI: legt `.env` (600) mit frischem SETUP_TOKEN an, zeigt Code einmalig |
| `public/` | Mockup zur echten App: WebAuthn-Login/-Registrierung gegen `/api/auth` (selbstgeschriebener `webauthn.js`, keine Vendor-Datei), manifest + Service Worker; die fünf Ansichten zeigen **bis P2/P3 Mock-Daten** |
| `test/p1.test.js` | node:test: DB, Auth (mit kryptografisch gültigen Fake-WebAuthn-Antworten: ECDSA P-256, COSE-Key, attestationFormat `none`), Server-Header, CSRF |
| Betrieb | `.env.example`, `ecosystem.config.cjs` (pm2 `hammerclassify`), `.gitignore` (data/, keys/, logs/, .env) |

## 2. Was noch nicht verifiziert ist

1. **better-sqlite3-Binding fehlt** — das `npm install` in dieser Umgebung blockiert Postinstall-Skripte (npm-Warnung `install-scripts`), das native Modul wurde nicht gebaut. Deshalb lief `npm test` hier **noch nie grün**.
   - Fix: `npm rebuild better-sqlite3` (oder `npm install-scripts approve better-sqlite3` + neu installieren), dann `npm test`
2. **Kein Browser-E2E** — Playwright-Chromium war noch am Download; ein Playwright-Test mit Virtual Authenticator (Register → Login → App-Shell) wäre der stärkste Beleg. Optional.
3. **Kein Deploy** — der Server lief hier nie; Abnahmekriterium P1 („Passkey-Login auf `hamclassify.hammerlore.de`“) ist offen.

## 3. Nächste Schritte (in dieser Reihenfolge)

1. **Tests grün bekommen:** `npm rebuild better-sqlite3 && npm test` — alles muss durch; bei CBOR-/WebAuthn-Fehlungen erst `@levischuck/tiny-cbor`-Verhalten prüfen (COSE-Key als `Map` mit Integer-Labels).
2. **PR mergen:** https://github.com/Hammerlore/HammerClassify/pull/new/p1-geruest — der Token in dieser Umgebung hat nur Contents-Recht, kein PR-Recht; PR also von Michas Account anlegen/mergen.
3. **Vault auffüllen** (fehlt komplett): App-Notiz `HLSW/Apps/HammerClassify.md` (Vorbild: `HLSW/Apps/Physika.md`), Zeitleiste-Eintrag 10.10.2026 (Konzept) und 12.10.2026 (P1), Link in `Hammerlore Softworks.md`. Konzept-Status in `konzept.md` von „unabgesegnet“ auf den realen Stand bringen.
4. **Entscheidungen von Micha einholen** (s. §5) und in `konzept.md` + Vault festhalten.
5. **Deploy vom hammerpi-Host** (nicht vom Hermes-Container!):
   - Repo nach `~/git/HLSW/HammerClassify` klonen
   - `./src/setup.js` → `.env` 600 mit SETUP_TOKEN
   - `npm ci --omit=dev` (baut das Binding), `pm2 start ecosystem.config.cjs`
   - `curl 127.0.0.1:3014/api/health` → 200
   - Tunnel: `cloudflared tunnel route dns nextcloud hamclassify.hammerlore.de` (Name erst nach Entscheidung §5.1)
   - App öffnen → „Einrichten“ → SETUP_TOKEN → Passkey → Login = **P1 abgenommen**
   - `backup-all.sh` um `hammerclassify` (DB + `data/dokumente/`) ergänzen

## 4. Umwelt-Fakten (wichtig für die nächste Session)

- Hermes läuft in einem **Docker-Container auf dem hammerpi**; sichtbar ist nur `/opt/data` (Workspace, Vault). Host-Pfade wie `/mnt/nvme`, pm2, `~/git` sind **nicht** erreichbar — Deployment und Host-Checks laufen vom Host/Mac aus.
- **Kein `gh`-CLI**; GitHub-API via `GITHUB_TOKEN_HAMMERLORE` (env) — nur Contents-Recht auf `Hammerlore/HammerClassify`, kein PR-Recht.
- **OMLX erreichbar** (geprüft 12.10.2026): `https://omlx.lan.hammerlore.de:8443/v1/models` → 401 (lebt, will Key). Offener Punkt 1 aus `konzept.md` damit erledigt.
- **Node 26.7.0** auf dem hammerpi (≥ 20.15, OK). Offener Punkt 8 erledigt.
- Port **3014** ist der nächste freie im 30xx-Block (Konzept).
- Vault-Pfad: `/opt/data/home/Documents/Obsidian Vault` (Git-Repo, Änderungen commiten).

## 5. Offene Entscheidungen (brauchen Micha)

1. **Domain:** `hamclassify.hammerlore.de` — OK? (Alternativen: `classify.` / `dokumente.`)
2. **Scan-Verzeichnisse:** welche Pfade auf dem hammerpi sind die Quellen? (z. B. `~/Dokumente/Posteingang`, Nextcloud-Sync?)
3. **`.doc`-Dateien** (binäres Word): zu erwarten? Wenn selten → „manuell“, wartet auf OCR/V2.
4. **Inhaber-Profile:** welche Namen/Adressen/Kundennummern vorgepflegt? (→ DB auf dem hammerpi, nie ins Repo)
5. **Aufbewahrung:** sollen Belege automatisch das 10-Jahre-Halte-Tag bekommen?

## 6. Danach: Phasenplan (aus `konzept.md`)

| Phase | Umfang | Abnahme |
|---|---|---|
| **P2** | Upload PDF/DOCX, Textgewinnung (jszip / pdf.js im Browser), Eintrag „eingang“, Vorschau, Dedup (SHA-256) | 3 echte Dokumente, Volltext lesbar |
| **P3** | Regeln-UI, Prompt-Renderer, OMLX-Client (Qwen3.8-27B), Schema-Prüfung `src/ergebnis.js`, Bestätigung/Ablehnung, „neu einordnen“ | 20 echte Dokumente ≥ 80 % treffend, 0 unbekannte Tags |
| **P4** | Verzeichnis-Scan, Queue, CSV-Export | 50-Datei-Verzeichnis vollständig durchlaufen |

**V2 (nicht verbindlich):** OCR (Tesseract), Sync nach HLSW-Management, Halte-Tag, Vorselektion mit `hermes-3-3b`.

## 7. Sicherheitsregeln (unverändert aus Konzept/Management)

- Passkey-only, kein Passwort, kein E-Mail-Reset; SETUP_TOKEN nur Erststart/Notfall, danach in `.env` geleert
- Secrets nur auf dem hammerpi (`.env` 600), nie im Repo, nie im Vault
- Dokumentinhalt ist fremd: KI-Ausgabe strikt gegen Schema + Regeln prüfen; Bedingungen deterministisch serverseitig; keine HTML-Renderung von Dokumenten
- `data/` wird nie als statischer Ordner geservt
