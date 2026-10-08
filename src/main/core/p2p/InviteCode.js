import { randomBytes } from 'crypto'
import { deflateSync, inflateSync } from 'zlib'

import Identity, { base32Encode } from './Identity'

const B62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const B62_BASE = 62n
// v2: `eps[]` carries every candidate endpoint (public UPnP / STUN / LAN /
// manual) so joiners can race them all; v1 codes stay decodable.
const CODE_VERSION = 2
const SUPPORTED_VERSIONS = [1, 2]

function b62encode (buf) {
  // Sentinel + length prefix: a plain length header usually starts with a
  // 0x00 byte, which BigInt conversion would silently swallow.
  const len = Buffer.alloc(3)
  len[0] = 0x01
  len.writeUInt16BE(buf.length, 1)
  const withLen = Buffer.concat([len, buf])
  let n = BigInt(`0x${withLen.toString('hex')}`)
  let out = ''
  while (n > 0n) {
    out = B62_ALPHABET[Number(n % B62_BASE)] + out
    n /= B62_BASE
  }
  return out || '0'
}

function b62decode (str) {
  let n = 0n
  for (const ch of str) {
    const idx = B62_ALPHABET.indexOf(ch)
    if (idx < 0) {
      throw new Error(`invalid base62 char: ${ch}`)
    }
    n = n * B62_BASE + BigInt(idx)
  }
  let hex = n.toString(16)
  if (hex.length % 2 === 1) {
    hex = `0${hex}`
  }
  const withLen = Buffer.from(hex, 'hex')
  if (withLen.length < 3 || withLen[0] !== 0x01) {
    throw new Error('invite code truncated')
  }
  const payloadLen = withLen.readUInt16BE(1)
  if (withLen.length < 3 + payloadLen) {
    throw new Error('invite code payload truncated')
  }
  return withLen.subarray(3, 3 + payloadLen)
}

/** Human-friendly display form: groups of 4 separated by spaces. */
export function formatCode (code) {
  return (code || '').replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim()
}

/** Accepts pasted codes with spaces, dashes or newlines. */
export function sanitizeCode (raw) {
  return String(raw || '').replace(/[^0-9A-Za-z]/g, '')
}

export function generateGroupId () {
  return base32Encode(randomBytes(16))
}

/**
 * The invite code IS the bootstrap record: without a rendezvous server it has
 * to carry the owner's reachable endpoint, the group id, the owner's public
 * key and the group secret. It is self-signed by the owner key it carries, so
 * a tampered code fails verification instead of silently pointing at an
 * attacker.
 */
export default class InviteCode {
  static encode ({ gid, eps, ep, sec }, identity) {
    const list = (eps && eps.length ? eps : [ep]).filter((e) => e && e.h && e.p)
    if (!gid || !list.length || !identity || !sec) {
      throw new Error('invite payload incomplete')
    }
    const payload = JSON.stringify({
      v: CODE_VERSION,
      gid,
      eps: list.map((e) => ({ h: String(e.h), p: Number(e.p) })),
      pub: identity.pubB64,
      sec
    })
    const jsonBuf = Buffer.from(payload, 'utf8')
    const sig = Buffer.from(identity.sign(jsonBuf), 'base64')
    const lenBuf = Buffer.alloc(2)
    lenBuf.writeUInt16BE(jsonBuf.length)
    const packed = Buffer.concat([lenBuf, jsonBuf, sig])
    return b62encode(deflateSync(packed, { level: 9 }))
  }

  static decode (rawCode) {
    const code = sanitizeCode(rawCode)
    if (!code) {
      throw new Error('invite code is empty')
    }
    let packed
    try {
      packed = inflateSync(b62decode(code))
    } catch (err) {
      throw new Error('invite code is not valid')
    }
    if (packed.length < 2 + 64) {
      throw new Error('invite code is truncated')
    }
    const jsonLen = packed.readUInt16BE(0)
    const jsonBuf = packed.subarray(2, 2 + jsonLen)
    const sig = packed.subarray(2 + jsonLen)
    let payload
    try {
      payload = JSON.parse(jsonBuf.toString('utf8'))
    } catch (err) {
      throw new Error('invite code payload is corrupt')
    }
    if (!SUPPORTED_VERSIONS.includes(payload.v)) {
      throw new Error('invite code version not supported')
    }
    const ok = Identity.verify(payload.pub, jsonBuf, sig.toString('base64'))
    if (!ok) {
      throw new Error('invite code signature invalid')
    }
    let eps
    if (payload.v === 1) {
      if (!payload.h || !payload.p) {
        throw new Error('invite code missing fields')
      }
      eps = [{ h: payload.h, p: Number(payload.p) }]
    } else {
      eps = (payload.eps || []).map((e) => ({ h: e.h, p: Number(e.p) }))
    }
    if (!payload.gid || !eps.length || !payload.sec) {
      throw new Error('invite code missing fields')
    }
    return {
      v: payload.v,
      gid: payload.gid,
      eps,
      ep: eps[0],
      pub: payload.pub,
      sec: payload.sec
    }
  }
}
