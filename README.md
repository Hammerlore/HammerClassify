# HammerClassify

KI-gestützte Dokumenten-Klassifizierung (Word/PDF) auf dem hammerpi —
`https://classify.lan.hammerlore.de`, **nur im Heimnetz** (Apache + Pi-hole,
kein Internet), Single-User, Security-First.

## Status

**P2 abgeschlossen (12.11.2026)** — läuft auf dem Pi: Passkey-Login, Upload
(Finder-Dialog + Drag&Drop, 25 MB, Magic-Bytes), SHA-256-Dedup, Volltext
(docx/zip per jszip, PDF per pdf.js im Browser), Dokumente-Liste/Detail/Download,
Einstellungen (OMLX-Verbindung mit Verbindungstest).
Design auf MoneyMe-Synchron: Hero/Glas-Dunkelmodus, Amber-Akzent,
MoneyMe-Shell (Top-Bar, Reiter, Seitenleiste, Bottom-Navigation).
Noch nicht da: Regeln + KI (P3), Scan + CSV (P4).

| Inhalt | Stand |
|---|---|
| [`konzept.md`](konzept.md) | Vollständiges Konzept: Architektur, Regelschema, KI-Workflow, Security-First, Betrieb |
| [`src/`](src/) | Node-Server (Express, better-sqlite3, WebAuthn, OMLX-Client), Port 3018 |
| [`public/`](public/) | PWA mit MoneyMe-Design: Login, Übersicht, Dokumente, Einstellungen echt; Regeln/Scan noch Mock bis P3/P4 |
| [`mockup/`](mockup/) | Klickbares Design-Mockup (PWA-Template + HLSW-Design-System, echte Tokens, Mock-Daten) |
| [`.env.example`](.env.example) | Vorlage für die Umgebungsvariablen (die echte `.env` legt `npm run setup` auf dem Pi an) |

## Mockup ansehen

```bash
npm install            # playwright (nur für Screenshots)
npm run mockup:build-css   # erzeugt mockup/design-*.css aus dem hlsw-design-system-Repo
# danach: mockup/index.html im Browser öffnen (oder: npm run mockup:shots)
```

Das Mockup ist eine statische HTML/JS-Seite mit Mock-Daten — keine echten
API-Calls. Es zeigt die fünf Ansichten: Login (Passkey), Übersicht, Dokumente,
Regeln, Scan sowie Dokument-Detail und Upload-Dialog, in Dark/Light und mobil.

## Geplante Umsetzung

Siehe `konzept.md` — Repo-Struktur, API, Datenbank-Schema, OMLX-Anbindung,
systemd-Betrieb auf dem hammerpi.
