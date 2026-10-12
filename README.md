# HammerClassify

KI-gestützte Dokumenten-Klassifizierung (Word/PDF) auf dem hammerpi — intern erreichbar,
Single-User, Security-First.

## Status

**Konzept-Phase (10.10.2026)** — noch kein lauffähiger Server.

| Inhalt | Stand |
|---|---|
| [`konzept.md`](konzept.md) | Vollständiges Konzept: Architektur, Regelschema, KI-Workflow, Security-First, Betrieb |
| [`mockup/`](mockup/) | Klickbares Design-Mockup (PWA-Template + HLSW-Design-System, echte Tokens, Mock-Daten) |

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

## Weiterarbeiten

`Next-steps.md` ist die Übergabe-Datei für die nächste Session: aktueller
P1-Stand, offene Punkte, Deploy-Anleitung, offene Entscheidungen.
