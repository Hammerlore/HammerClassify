/* ==========================================================================
   HammerClassify — WebAuthn-Client (selbstgebaut, keine Abhängigkeit)
   Wrappert navigator.credentials für die simplewebauthn-Server-API:
   - Challenge als Base64URL (Server) ↔ Uint8Array (Browser)
   - AuthenticatorResponse als JSON (ArrayBuffer → Base64URL)
   ========================================================================== */
'use strict';

const WebAuthnClient = (() => {
  function b64urlToBytes(b64url) {
    let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToB64url(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return b64urlEncode(bin);
  }

  function b64urlEncode(bin) {
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function bufferToB64url(buf) {
    return bytesToB64url(new Uint8Array(buf));
  }

  /**
   * Registrierung: erzeugt den Passkey und liefert die Antwort für den Server.
   * @param {Object} options RegistrationOptionsJSON vom Server
   * @param {string} [setupToken] nur beim Erststart/Notfall
   */
  async function register(options, setupToken) {
    const publicKey = {
      ...options,
      challenge: b64urlToBytes(options.challenge),
      user: { ...options.user, id: new TextEncoder().encode(options.user.id) },
    };
    const cred = await navigator.credentials.create({ publicKey });
    if (!cred) throw new Error('Kein Passkey erstellt');
    return {
      id: cred.id,
      rawId: bufferToB64url(cred.rawId),
      response: {
        clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
        attestationObject: bufferToB64url(cred.response.attestationObject),
      },
      type: 'public-key',
    };
  }

  /**
   * Anmeldung: holt die Assertion und liefert sie für den Server.
   */
  async function authenticate(options) {
    const publicKey = {
      ...options,
      challenge: b64urlToBytes(options.challenge),
      allowCredentials: options.allowCredentials.map((c) => ({ ...c, id: b64urlToBytes(c.id) })),
    };
    const assert = await navigator.credentials.get({ publicKey });
    if (!assert) throw new Error('Kein Passkey bestätigt');
    return {
      id: assert.id,
      rawId: bufferToB64url(assert.rawId),
      response: {
        clientDataJSON: bufferToB64url(assert.response.clientDataJSON),
        authenticatorData: bufferToB64url(assert.response.authenticatorData),
        signature: bufferToB64url(assert.response.signature),
        userHandle: assert.response.userHandle
          ? bufferToB64url(assert.response.userHandle)
          : null,
      },
      type: 'public-key',
    };
  }

  return { register, authenticate, b64urlToBytes, bytesToB64url };
})();
