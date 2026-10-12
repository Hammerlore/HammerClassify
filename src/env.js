/* ==========================================================================
   HammerClassify — Umgebung
   Lädt .env aus dem App-Ordner und prüft, was der Server braucht.
   Secrets leben nur auf dem hammerpi (.env, Rechte 600) — nie im Repo.
   ========================================================================== */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(hier, '..');

function env(name, fallback = undefined) {
  const v = process.env[name] ?? fallback;
  return v === '' ? undefined : v;
}

export function loadEnv(overrides = {}) {
  const e = { ...process.env, ...overrides };
  const config = {
    port: Number(e.PORT ?? 3014),
    host: e.HOST ?? '127.0.0.1',
    rpId: e.RP_ID,
    rpName: e.RP_NAME ?? 'HammerClassify',
    setupToken: e.SETUP_TOKEN,
    sessionDays: Number(e.SESSION_DAYS ?? 30),
    dataDir: path.resolve(e.DATA_DIR ?? path.join(APP_ROOT, 'data')),
    omlxUrl: e.OMLX_URL,
    omlxKey: e.OMLX_KEY,
    origin: e.ORIGIN, // z. B. https://hamclassify.hammerlore.de
  };
  return config;
}

/**
 * Strikte Prüfung für den Produktivstart.
 * @returns {{ok: boolean, fehler: string[]}}
 */
export function validateEnv(config) {
  const fehler = [];
  if (!config.rpId) fehler.push('RP_ID fehlt (WebAuthn-Relying-Party, z. B. hamclassify.hammerlore.de)');
  if (!config.setupToken) {
    // Nur beim allerersten Start erlaubt: dann legt setup.js sie an.
    fehler.push('SETUP_TOKEN fehlt (≥ 20 Zeichen, nur für Erststart/Notfall)');
  } else if (config.setupToken.length < 20) {
    fehler.push('SETUP_TOKEN zu kurz (mind. 20 Zeichen)');
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    fehler.push(`PORT ungültig: ${config.port}`);
  }
  return { ok: fehler.length === 0, fehler };
}
