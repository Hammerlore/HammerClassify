/* ==========================================================================
   HammerClassify — Authentifizierung (Passkey-only, wie HLSW-Management)
   - Ein Nutzer, kein Passwort, kein E-Mail-Reset
   - Erster Passkey + Notfall: SETUP_TOKEN (≥ 20 Zeichen) aus der .env
   - Session: httpOnly sid-Cookie, SameSite=Strict, Secure, 30 Tage,
     SHA-256-Hash in der DB; jede Sitzung kennt ihren Passkey
   ========================================================================== */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import * as db from './db.js';

export const COOKIE_NAME = 'sid';

/**
 * WebAuthn-Optionen für die Registrierung.
 * Erlaubt nur, solange noch kein Passkey existiert (Erststart)
 * oder der SETUP_TOKEN übergeben wird (Notfall).
 */
export async function registrationOptions({ config, setupToken }) {
  const erststart = db.countPasskeys(config.db) === 0;
  const notfall = setupToken && setupToken === config.setupToken;
  if (!erststart && !notfall) {
    return { allowed: false, reason: 'bereits eingerichtet' };
  }
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: 'micha',
    userDisplayName: 'Micha',
    userVerification: 'required',
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });
  return { allowed: true, options };
}

/**
 * Registrierte Antwort verifizieren und Passkey speichern.
 */
export async function finishRegistration({ config, expectedOptions, response }) {
  const verification = await verifyRegistrationResponse({
    rpID: config.rpId,
    expectedChallenge: expectedOptions.challenge,
    expectedOrigin: config.origin,
    requireResidentKey: true,
    requireUserVerification: true,
    response,
  }).catch((e) => ({ verified: false, fehler: e.message }));
  if (!verification.verified) {
    return { ok: false, fehler: verification.fehler ?? 'Verifizierung fehlgeschlagen' };
  }
  const userId = userIdFor(config);
  const id = db.addPasskey(config.db, userId, {
    credentialId: verification.credential.credentialID,
    publicKey: verification.credential.publicKey,
    signCount: verification.credential.response?.authenticator?.signatureCount ?? 0,
    aaguid: verification.credential.response?.authenticator?.aaguid,
    transport: Array.isArray(verification.credential.response?.authenticator?.transports)
      ? verification.credential.response.authenticator.transports.join(',')
      : undefined,
  });
  return { ok: true, passkeyId: id };
}

/** Ein Nutzer, wie Management. */
function userIdFor(config) {
  const row = config.db.prepare('SELECT * FROM users LIMIT 1').get();
  if (!row) {
    const id = db.createNutzer(config.db, 'Micha');
    return id;
  }
  return row.id;
}

/**
 * WebAuthn-Optionen für die Anmeldung.
 */
export async function authenticationOptions({ config }) {
  const userId = userIdFor(config);
  const passkeys = db.getPasskeysForUser(config.db, userId);
  if (!passkeys.length) {
    return { allowed: false, reason: 'noch kein Passkey eingerichtet' };
  }
  const options = await generateAuthenticationOptions({
    challenge: undefined,
    userVerification: 'required',
    allowCredentials: passkeys.map((p) => ({ id: p.credential_id })),
    timeout: 60_000,
  });
  return { allowed: true, options };
}

/**
 * Anmelde-Antwort verifizieren, Session ausstellen.
 */
export async function finishAuthentication({ config, expectedOptions, response }) {
  const userId = userIdFor(config);
  const passkey = db.getPasskeyByCredential(config.db, response.id);
  if (!passkey || passkey.user_id !== userId) {
    return { ok: false, fehler: 'Unbekannter Passkey' };
  }
  const verification = await verifyAuthenticationResponse({
    rpID: config.rpId,
    expectedChallenge: expectedOptions.challenge,
    expectedOrigin: config.origin,
    requireUserVerification: true,
    credential: {
      id: passkey.credential_id,
      publicKey: passkey.public_key,
      counter: passkey.sign_count,
    },
    response,
  }).catch((e) => ({ verified: false, fehler: e.message }));
  if (!verification.verified) {
    return { ok: false, fehler: verification.fehler ?? 'Verifizierung fehlgeschlagen' };
  }
  if (verification.newSignatureCounter !== undefined) {
    db.bumpSignCount(config.db, passkey.id, verification.newSignatureCounter);
  }
  const token = db.createSession(config.db, {
    userId,
    passkeyId: passkey.id,
    days: config.sessionDays,
  });
  return { ok: true, token, userId };
}

/**
 * Session-Cookie setzen (httpOnly, SameSite=Strict, Secure).
 */
export function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: true, // hinter dem Cloudflare-Tunnel (HTTPS)
    path: '/',
    maxAge: config.sessionDays * 86400,
  };
}

/**
 * Sitzungs-Check für eine Anfrage.
 * @returns {{ok: boolean, userId?: string, passkeyId?: number|null}}
 */
export function checkSession(config, token) {
  const session = db.getSessionByToken(config.db, token);
  if (!session) return { ok: false };
  return { ok: true, userId: session.user_id, passkeyId: session.passkey_id };
}

/**
 * Schreibende Anfragen nur von eigener Origin (CSRF, wie Management).
 * @returns {boolean} true, wenn die Anfrage durchläuft
 */
export function sameOrigin(req, config) {
  const origin = req.get('origin');
  if (!origin) return true; // curl & Co. ohne Origin-Header
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const erwartet = config.origin
    ? new URL(config.origin).host
    : req.get('host');
  return host === erwartet;
}
