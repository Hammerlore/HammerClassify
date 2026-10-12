/* ==========================================================================
   HammerClassify — Einrichtung (läuft einmalig auf dem hammerpi)
   - legt .env an (Rechte 600), falls noch keine da ist
   - erzeugt SETUP_TOKEN (≥ 20 Zeichen) und zeigt ihn genau EINMAL
   - legt data/ an
   Danach: Passkey in der App registrieren (Einrichtungscode eingeben).
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ROOT } from './env.js';

const envPath = path.join(APP_ROOT, '.env');

if (fs.existsSync(envPath)) {
  console.log('.env existiert bereits — nichts geändert.');
  process.exit(0);
}

const token = crypto.randomBytes(32).toString('base64url');
const content = `# HammerClassify — .env (nur auf dem hammerpi, Rechte 600, nie im Repo)
PORT=3014
HOST=127.0.0.1
RP_ID=hamclassify.hammerlore.de
RP_NAME=HammerClassify
ORIGIN=https://hamclassify.hammerlore.de
SETUP_TOKEN=${token}
SESSION_DAYS=30
DATA_DIR=/mnt/nvme/hammerclassify
OMLX_URL=https://omlx.lan.hammerlore.de:8443
OMLX_KEY=
`;

fs.writeFileSync(envPath, content, { mode: 0o600 });
fs.mkdirSync(path.join(APP_ROOT, 'data'), { recursive: true });

console.log('.env angelegt (600). Einrichtungscode — NUR EINMAL angezeigt, danach nur in der .env:');
console.log(`\n  ${token}\n`);
console.log('Nächster Schritt: App öffnen → „Einrichten“ → Code eingeben → Passkey erstellen.');
