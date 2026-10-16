/**
 * At-rest protection for the two things worth stealing from p2p.json: the
 * device identity (a private key that *is* this device's group membership) and
 * the group secret.
 *
 * Electron's safeStorage wraps the value for the current OS user (DPAPI on
 * Windows, Keychain on macOS). There is deliberately no "encrypt with a key we
 * store next to it" scheme — that would only obfuscate. Every failure path
 * falls back to the plaintext slot instead: losing an identity is worse than
 * leaving it in the clear, and the caller verifies each write by reading it
 * back before dropping the plaintext copy.
 */
import electron from 'electron'

let testSeal = null
let testOpen = null

/** Test seam: the Node regression harness runs outside Electron. */
export function setTestCodec (sealFn, openFn) {
  testSeal = sealFn || null
  testOpen = openFn || null
}

function backend () {
  try {
    const ss = electron && electron.safeStorage
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) {
      return ss
    }
  } catch (err) {
    /* not available in this environment (or before app-ready) */
  }
  return null
}

export function sealingAvailable () {
  return !!(testSeal || backend())
}

export function seal (text) {
  if (!text) {
    return null
  }
  if (testSeal) {
    try {
      return testSeal(text)
    } catch (err) {
      return null
    }
  }
  const ss = backend()
  if (!ss) {
    return null
  }
  try {
    return ss.encryptString(text).toString('base64')
  } catch (err) {
    return null
  }
}

export function unseal (blob) {
  if (!blob) {
    return null
  }
  if (testOpen) {
    try {
      return testOpen(blob)
    } catch (err) {
      return null
    }
  }
  const ss = backend()
  if (!ss) {
    return null
  }
  try {
    return ss.decryptString(Buffer.from(String(blob), 'base64'))
  } catch (err) {
    return null
  }
}
