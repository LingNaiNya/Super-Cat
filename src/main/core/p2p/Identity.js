import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as edSign,
  verify as edVerify
} from 'crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode (buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

export function base32Decode (str) {
  const clean = str.toUpperCase().replace(/=+$/, '')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch)
    if (idx < 0) {
      throw new Error(`invalid base32 char: ${ch}`)
    }
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/**
 * Long-term device identity: an Ed25519 keypair used both to fingerprint the
 * device and to sign handshake transcripts (so a peer never has to trust an
 * unauthenticated channel). Session encryption uses an ephemeral X25519
 * exchange on top, so compromising the identity key never decrypts past
 * recorded traffic.
 */
export default class Identity {
  constructor ({ pub, priv }) {
    if (!pub || !priv) {
      throw new Error('identity requires pub and priv')
    }
    this.pubB64 = pub
    this.privB64 = priv
    this.publicKey = createPublicKey({
      key: Buffer.from(pub, 'base64'),
      format: 'der',
      type: 'spki'
    })
    this.privateKey = createPrivateKey({
      key: Buffer.from(priv, 'base64'),
      format: 'der',
      type: 'pkcs8'
    })
    this.fingerprint = base32Encode(
      createHash('sha256').update(this.publicKey.export({ format: 'der', type: 'spki' })).digest().subarray(0, 5)
    )
  }

  static generate () {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    return new Identity({
      pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    })
  }

  sign (data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
    return edSign(null, buf, this.privateKey).toString('base64')
  }

  static verify (pubB64, data, sigB64) {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(pubB64, 'base64'),
        format: 'der',
        type: 'spki'
      })
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
      return edVerify(null, buf, publicKey, Buffer.from(sigB64, 'base64'))
    } catch (err) {
      return false
    }
  }

  static fingerprintOf (pubB64) {
    const publicKey = createPublicKey({
      key: Buffer.from(pubB64, 'base64'),
      format: 'der',
      type: 'spki'
    })
    return base32Encode(
      createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest().subarray(0, 5)
    )
  }

  static hmac (secretB64, data) {
    return createHmac('sha256', Buffer.from(secretB64, 'base64'))
      .update(String(data))
      .digest('base64')
  }

  static randomSecret () {
    return randomBytes(16).toString('base64')
  }

  static generateEphemeral () {
    const { publicKey, privateKey } = generateKeyPairSync('x25519')
    return {
      pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      priv: privateKey
    }
  }

  static deriveSharedSecret (myPriv, peerPubB64) {
    const publicKey = createPublicKey({
      key: Buffer.from(peerPubB64, 'base64'),
      format: 'der',
      type: 'spki'
    })
    return diffieHellman({ privateKey: myPriv, publicKey })
  }

  /**
   * Both sides compute the same key from the ephemeral shared secret, with the
   * handshake transcript bound in as `info` so a MITM cannot splice two
   * handshakes together.
   */
  static deriveSessionKey (shared, transcript, cpub, spub) {
    const [a, b] = [cpub, spub].sort()
    const salt = createHash('sha256').update(`sc-p2p-session-v1|${a}|${b}`).digest()
    const info = createHash('sha256').update(transcript).digest()
    return Buffer.from(hkdfSync('sha256', shared, salt, info, 32))
  }
}
