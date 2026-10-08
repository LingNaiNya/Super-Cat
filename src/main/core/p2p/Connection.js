import { EventEmitter } from 'events'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

import Identity from './Identity'
import logger from '../Logger'

const MAX_FRAME = 1024 * 1024
const HANDSHAKE_TIMEOUT = 10000
const NONCE_PREFIX_LEN = 8
const COUNTER_LEN = 4
const GCM_TAG_LEN = 16

/**
 * One authenticated, encrypted peer link over a TCP socket.
 *
 * Wire format before `ready`:
 *   [4B len][json]                     – handshake messages in the clear
 * Wire format after `ready`:
 *   [4B len][12B nonce][16B tag][ct]   – AES-256-GCM, nonce = np(8) + ctr(4)
 * Decrypted payload:
 *   [2B headerLen][header json][binary body]
 *
 * Received messages are offered to `waitFor()` predicates first, then to
 * `message` listeners, then parked in an inbox — so no message can be lost in
 * the gap between finishing the handshake and attaching app listeners.
 */
export default class Connection extends EventEmitter {
  constructor (socket, identity) {
    super()
    this.socket = socket
    this.identity = identity
    this.state = 'handshaking'
    this.closed = false
    this.closeError = null
    this.sessionKey = null
    this.sendNp = null
    this.recvNp = null
    this.sendCounter = 1
    this.recvCounter = 1
    this.recvBuf = Buffer.alloc(0)
    this.inbox = []
    this.waiters = []
    this.meta = {}

    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (err) => this.destroy(err))
    socket.on('close', () => this.destroy(this.closeError || new Error('peer closed')))
  }

  onData (chunk) {
    if (this.closed) {
      return
    }
    this.recvBuf = this.recvBuf.length ? Buffer.concat([this.recvBuf, chunk]) : chunk
    while (this.recvBuf.length >= 4) {
      const len = this.recvBuf.readUInt32BE(0)
      if (len > MAX_FRAME) {
        this.destroy(new Error('frame too large'))
        return
      }
      if (this.recvBuf.length < 4 + len) {
        return
      }
      const payload = this.recvBuf.subarray(4, 4 + len)
      this.recvBuf = this.recvBuf.subarray(4 + len)
      let msg
      try {
        msg = this.decodePayload(payload)
      } catch (err) {
        this.destroy(err)
        return
      }
      this.deliver(msg)
    }
  }

  decodePayload (payload) {
    if (!this.sessionKey || !this.recvNp) {
      const json = payload.toString('utf8')
      const parsed = JSON.parse(json)
      return { header: parsed, body: null }
    }
    if (payload.length < 12 + GCM_TAG_LEN) {
      throw new Error('encrypted frame truncated')
    }
    const nonce = payload.subarray(0, 12)
    const expected = Buffer.concat([this.recvNp, counterBuf(this.recvCounter)])
    if (!nonce.equals(expected)) {
      throw new Error('frame nonce out of sequence')
    }
    const tag = payload.subarray(12, 12 + GCM_TAG_LEN)
    const ct = payload.subarray(12 + GCM_TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', this.sessionKey, nonce)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(ct), decipher.final()])
    this.recvCounter += 1
    const headerLen = plain.readUInt16BE(0)
    if (2 + headerLen > plain.length) {
      throw new Error('header length out of range')
    }
    const header = JSON.parse(plain.subarray(2, 2 + headerLen).toString('utf8'))
    const body = plain.subarray(2 + headerLen)
    return { header, body: body.length ? body : null }
  }

  encodePayload (header, body) {
    const json = Buffer.from(JSON.stringify(header), 'utf8')
    if (!this.sessionKey || !this.sendNp) {
      if (body && body.length) {
        throw new Error('binary body requires an established session')
      }
      return json
    }
    if (json.length > 65535) {
      throw new Error('header too long')
    }
    const lenBuf = Buffer.alloc(2)
    lenBuf.writeUInt16BE(json.length)
    const plain = Buffer.concat([lenBuf, json, body || Buffer.alloc(0)])
    const nonce = Buffer.concat([this.sendNp, counterBuf(this.sendCounter)])
    const cipher = createCipheriv('aes-256-gcm', this.sessionKey, nonce)
    const ct = Buffer.concat([cipher.update(plain), cipher.final()])
    const frame = Buffer.concat([nonce, cipher.getAuthTag(), ct])
    this.sendCounter += 1
    return frame
  }

  send (header, body = null) {
    if (this.closed) {
      return false
    }
    let payload
    try {
      payload = this.encodePayload(header, body)
    } catch (err) {
      this.destroy(err)
      return false
    }
    const len = Buffer.alloc(4)
    len.writeUInt32BE(payload.length)
    return this.socket.write(Buffer.concat([len, payload]))
  }

  deliver (msg) {
    const { header, body } = msg
    const waiterIdx = this.waiters.findIndex((w) => {
      try {
        return w.predicate(header, body)
      } catch (err) {
        return false
      }
    })
    if (waiterIdx >= 0) {
      const [waiter] = this.waiters.splice(waiterIdx, 1)
      clearTimeout(waiter.timer)
      waiter.resolve({ header, body })
      return
    }
    if (this.listenerCount('message') > 0) {
      this.emit('message', header, body)
      return
    }
    this.inbox.push({ header, body })
  }

  on (event, fn) {
    if (event === 'message' && this.inbox.length) {
      const pending = this.inbox.splice(0, this.inbox.length)
      queueMicrotask(() => {
        if (this.closed) {
          return
        }
        pending.forEach(({ header, body }) => fn(header, body))
      })
    }
    return super.on(event, fn)
  }

  waitFor (predicate, timeout = HANDSHAKE_TIMEOUT, label = 'message') {
    const inQueue = this.inbox.findIndex(({ header, body }) => {
      try {
        return predicate(header, body)
      } catch (err) {
        return false
      }
    })
    if (inQueue >= 0) {
      const [msg] = this.inbox.splice(inQueue, 1)
      return Promise.resolve(msg)
    }
    if (this.closed) {
      return Promise.reject(this.closeError || new Error('connection closed'))
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) {
          this.waiters.splice(idx, 1)
        }
        reject(new Error(`timeout waiting for ${label}`))
      }, timeout)
      this.waiters.push(waiter)
    })
  }

  setupCrypto ({ key, sendNp, recvNp }) {
    this.sessionKey = key
    this.sendNp = sendNp
    this.recvNp = recvNp
    this.sendCounter = 1
    this.recvCounter = 1
  }

  destroy (err) {
    if (this.closed) {
      return
    }
    this.closed = true
    this.closeError = err || null
    logger.info(`[Super Cat] p2p conn destroyed: ${err ? err.message : 'closed'}`)
    const pending = this.waiters.splice(0, this.waiters.length)
    pending.forEach((w) => {
      clearTimeout(w.timer)
      w.reject(err || new Error('connection closed'))
    })
    try {
      this.socket.destroy()
    } catch (e) {
      /* already gone */
    }
    this.emit('close', err || null)
  }

  /**
   * Graceful shutdown: flush pending writes (so a final `hand-error` or
   * `stream-close` actually reaches the peer) before FIN. Full teardown runs
   * off the socket's own `close` event.
   */
  close () {
    if (this.closed) {
      return
    }
    try {
      this.socket.end()
    } catch (err) {
      this.destroy(err)
      return
    }
    const timer = setTimeout(() => this.destroy(this.closeError), 1500)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }
}

function counterBuf (n) {
  const buf = Buffer.alloc(COUNTER_LEN)
  buf.writeUInt32BE(n >>> 0)
  return buf
}

function transcript (prefix, fields) {
  return `${prefix}|${fields.join('|')}`
}

/**
 * Initiator side. `expectPub` is the exact public key we believe the remote
 * has (owner key from the invite code, or a directory member key) — the
 * challenge signature must match it or we walk away.
 */
export async function clientHandshake (conn, { gid, mode, sec, expectPub }) {
  const identity = conn.identity
  const eph = Identity.generateEphemeral()
  const npC = randomBytes(NONCE_PREFIX_LEN)
  const hello = {
    t: 'hello',
    v: 1,
    gid,
    mode,
    cpub: identity.pubB64,
    cx: eph.pub,
    np: npC.toString('base64')
  }
  if (mode === 'join') {
    if (!sec) {
      throw new Error('join requires group secret')
    }
    hello.proof = Identity.hmac(sec, `sc-join|${gid}|${mode}|${identity.pubB64}|${eph.pub}`)
  }
  conn.send(hello)

  const { header: challenge } = await conn.waitFor(
    (h) => h.t === 'challenge' || h.t === 'hand-error',
    HANDSHAKE_TIMEOUT,
    'challenge'
  )
  if (challenge.t === 'hand-error') {
    throw new Error(challenge.reason || 'handshake rejected')
  }
  if (challenge.spub !== expectPub) {
    throw new Error('peer identity does not match expected key')
  }
  const fields = ['v1', gid, mode, identity.pubB64, eph.pub, challenge.spub, challenge.sx]
  const t1 = transcript('sc-t1', fields)
  if (!Identity.verify(challenge.spub, t1, challenge.sig)) {
    throw new Error('peer signature invalid')
  }

  const shared = Identity.deriveSharedSecret(eph.priv, challenge.sx)
  const key = Identity.deriveSessionKey(shared, t1, identity.pubB64, challenge.spub)
  const recvNp = Buffer.from(challenge.np, 'base64')
  if (recvNp.length !== NONCE_PREFIX_LEN) {
    throw new Error('bad nonce prefix')
  }
  conn.setupCrypto({ key, sendNp: npC, recvNp })

  const t2 = transcript('sc-t2', fields)
  conn.send({ t: 'proof', sig: identity.sign(t2) })

  const { header: ready } = await conn.waitFor(
    (h) => h.t === 'ready' || h.t === 'hand-error',
    HANDSHAKE_TIMEOUT,
    'ready'
  )
  if (ready.t === 'hand-error') {
    throw new Error(ready.reason || 'handshake rejected')
  }
  return { fp: ready.fp, mode: ready.mode || mode }
}

/**
 * Acceptor side. Policy is injected: `getSec()` for join proofs and
 * `lookupMember(cpub)` to decide whether an established member/data peer is
 * allowed in.
 */
export async function serverHandshake (conn, { gid, getSec, lookupMember }) {
  const identity = conn.identity
  const { header: hello } = await conn.waitFor(
    (h) => h.t === 'hello',
    HANDSHAKE_TIMEOUT,
    'hello'
  )
  if (hello.v !== 1 || hello.gid !== gid) {
    conn.send({ t: 'hand-error', reason: 'group mismatch' })
    throw new Error('peer is not in this group')
  }
  if (!hello.cpub || !hello.cx || !hello.np) {
    conn.send({ t: 'hand-error', reason: 'malformed hello' })
    throw new Error('malformed hello')
  }
  const mode = hello.mode
  const recvNpC = Buffer.from(hello.np, 'base64')
  if (recvNpC.length !== NONCE_PREFIX_LEN) {
    conn.send({ t: 'hand-error', reason: 'bad nonce prefix' })
    throw new Error('bad nonce prefix')
  }

  const eph = Identity.generateEphemeral()
  const npS = randomBytes(NONCE_PREFIX_LEN)
  const fields = ['v1', gid, mode, hello.cpub, hello.cx, identity.pubB64, eph.pub]
  const t1 = transcript('sc-t1', fields)
  conn.send({
    t: 'challenge',
    spub: identity.pubB64,
    sx: eph.pub,
    np: npS.toString('base64'),
    sig: identity.sign(t1)
  })

  const shared = Identity.deriveSharedSecret(eph.priv, hello.cx)
  const key = Identity.deriveSessionKey(shared, t1, hello.cpub, identity.pubB64)
  conn.setupCrypto({ key, sendNp: npS, recvNp: recvNpC })

  const { header: proof } = await conn.waitFor(
    (h) => h.t === 'proof' || h.t === 'hand-error',
    HANDSHAKE_TIMEOUT,
    'proof'
  )
  if (proof.t === 'hand-error') {
    throw new Error(proof.reason || 'handshake aborted')
  }
  const t2 = transcript('sc-t2', fields)
  if (!Identity.verify(hello.cpub, t2, proof.sig)) {
    conn.send({ t: 'hand-error', reason: 'initiator signature invalid' })
    throw new Error('initiator signature invalid')
  }

  const fp = Identity.fingerprintOf(hello.cpub)
  if (mode === 'join') {
    const sec = getSec ? getSec() : null
    const expect = sec
      ? Identity.hmac(sec, `sc-join|${gid}|${mode}|${hello.cpub}|${hello.cx}`)
      : null
    if (!expect || hello.proof !== expect) {
      conn.send({ t: 'hand-error', reason: 'invite proof rejected' })
      throw new Error('invite proof rejected')
    }
  } else {
    const member = lookupMember ? lookupMember(hello.cpub, fp) : null
    if (!member) {
      conn.send({ t: 'hand-error', reason: 'not a group member' })
      throw new Error('not a group member')
    }
  }

  conn.send({ t: 'ready', fp, mode })
  return { fp, mode, cpub: hello.cpub }
}
