import { createHash } from 'crypto'
import { createReadStream, promises as fsp } from 'fs'
import { extname, join } from 'path'

/**
 * Peer-to-peer file transfer riding an established, encrypted data
 * connection (the same member-to-member path VIP forwarding uses).
 *
 * Frame vocabulary (all JSON headers; `file-data` carries a binary body):
 *
 *   file-offer    {tid, fid, name, size}          sender -> receiver
 *   file-reject   {tid, reason}                   receiver -> sender
 *   file-accept   {tid, offset, prefixHash}       receiver -> sender   (resume pitch)
 *   file-begin    {tid, offset, prefixHash}       sender -> receiver   (offset confirmed)
 *   file-data     {tid, off} + body               sender -> receiver
 *   file-ack      {tid, off}                      receiver -> sender   (window credit)
 *   file-end      {tid, off, size}                sender -> receiver
 *   file-complete {tid, ok, savedAs?, reason?}    receiver -> sender
 *   file-error    {tid, reason}                   either direction
 *   file-cancel   {tid, reason}                   either direction
 *
 * `fid` is the SHA-256 of the whole file, computed once up front (the UI
 * shows a `hashing` phase for it). Resume works both ways around a prefix
 * check: the receiver offers `offset` + SHA-256 of the first `offset` bytes
 * of its `.part`; the sender re-hashes its own prefix and confirms — a
 * mismatch (file changed, part corrupted, part longer than the file)
 * restarts from 0 and the receiver truncates. The completed file is hashed
 * one last time and must equal `fid` before it is renamed into place.
 *
 * Flow control is a byte-credit window: the sender never runs more than
 * FILE_WINDOW ahead of the last ack, so the receiver's frame backlog stays
 * memory-bounded even on a slow disk. The `.part` + sidecar survive any
 * interruption on purpose — the next attempt of the same file resumes.
 *
 * Both state machines talk to the socket through a narrow `link`
 * ({ send, waitForDrain, closed }) and to disk through an injectable `io`,
 * so the whole protocol can be driven by a fake connection in tests.
 */

export const FILE_CHUNK = 64 * 1024
export const FILE_WINDOW = 2 * 1024 * 1024
export const FILE_ACK_EVERY = 512 * 1024

// receiver: how long the user has to answer an offer before auto-reject
export const OFFER_TTL = 60000
// sender: offer + user dialog + accept, with grace over OFFER_TTL
export const ACCEPT_WAIT = 75000
// receiver: accept sent, begin expected
export const BEGIN_WAIT = 30000
// sender: blocked on a full window
export const ACK_WAIT = 30000
// receiver: idle between data frames
export const FRAME_WAIT = 30000
// sender: final hash + rename can take minutes on a 10 GB file
export const COMPLETE_WAIT = 300000

const FILE_FRAME_TYPES = new Set([
  'file-offer',
  'file-reject',
  'file-accept',
  'file-begin',
  'file-data',
  'file-ack',
  'file-complete',
  'file-end',
  'file-error',
  'file-cancel'
])

export function isFileFrame (t) {
  return FILE_FRAME_TYPES.has(t)
}

/** Machine-readable transfer failure: `.reason` is the code the UI maps. */
export function fileError (reason) {
  const err = new Error(`file transfer: ${reason}`)
  err.reason = reason
  return err
}

/* ------------------------------------------------------------------ names */

// \p{Cc} keeps the control-character class out of a raw \x00 escape
const ILLEGAL_CHARS = /[\\/:*?"<>|\p{Cc}]/gu
const RESERVED_BASES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Make a peer-supplied display name safe as ONE file name in the receive
 * directory: strip any path it carries, illegal characters, leading dots,
 * trailing dots/spaces (Windows silently drops those anyway), and reserve
 * device names. Never returns the empty string.
 */
export function sanitizeFileName (raw) {
  let name = String(raw == null ? '' : raw)
    .replace(/\\/g, '/')
  name = name.slice(name.lastIndexOf('/') + 1)
  name = name.replace(ILLEGAL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  name = name.replace(/^\.+/, '').replace(/[ .]+$/, '')
  let stem = name
  let ext = ''
  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    stem = name.slice(0, dot)
    ext = name.slice(dot)
  }
  stem = stem.slice(0, 80).replace(/[ .]+$/, '')
  ext = ext.replace(/[ .]+$/, '').slice(0, 24)
  if (!stem) {
    stem = 'file'
  }
  if (RESERVED_BASES.test(stem)) {
    stem = `_${stem}`
  }
  return `${stem}${ext}` || 'file'
}

export function partPathFor (dir, name, fid) {
  return join(dir, `${name}.${String(fid).slice(0, 12)}.part`)
}

export function metaPathFor (partPath) {
  return `${partPath}.meta.json`
}

/**
 * Pure resume decision: reuse an interrupted part only when the sidecar
 * still describes this exact file; the usable offset is capped at the
 * announced total size.
 */
export function resumeOffsetOf (meta, fid, size, partSize) {
  if (!meta || !partSize || partSize <= 0) {
    return 0
  }
  if (meta.fid !== fid || Number(meta.size) !== Number(size)) {
    return 0
  }
  return Math.min(partSize, size)
}

/* --------------------------------------------------------------------- io */

/**
 * Disk access, injectable for tests. `hash` streams (never loads the file);
 * `claim` is the race-safe "first to create this name wins" primitive used
 * to pick a collision-free final file name.
 */
export const fsIo = {
  sizeOf (path) {
    return fsp.stat(path).then((st) => st.size, () => 0)
  },

  exists (path) {
    return fsp.stat(path).then(() => true, () => false)
  },

  readJson (path) {
    return fsp.readFile(path, 'utf8').then((s) => {
      try {
        return JSON.parse(s)
      } catch (err) {
        return null
      }
    }, () => null)
  },

  writeJson (path, value) {
    return fsp.writeFile(path, JSON.stringify(value), 'utf8')
  },

  mkdirp (dir) {
    return fsp.mkdir(dir, { recursive: true }).then(() => undefined, () => undefined)
  },

  unlink (path) {
    return fsp.unlink(path).then(() => undefined, () => undefined)
  },

  rename (from, to) {
    return fsp.rename(from, to)
  },

  /** Atomically take a final name; false means "already there, try next". */
  claim (path) {
    return fsp.open(path, 'wx')
      .then((h) => h.close().then(() => true, () => true), () => false)
  },

  openReader (path) {
    return fsp.open(path, 'r').then((handle) => ({
      readAt (pos, len) {
        const buf = Buffer.allocUnsafe(len)
        return handle.read(buf, 0, len, pos).then(({ bytesRead }) => (bytesRead === len ? buf : null))
      },
      close () {
        return handle.close().catch(() => undefined)
      }
    }))
  },

  openWriter (path, truncate) {
    return fsp.open(path, truncate ? 'w+' : 'r+').then((handle) => ({
      write (buf, pos) {
        return handle.write(buf, 0, buf.length, pos).then(({ bytesWritten }) => {
          if (bytesWritten !== buf.length) {
            throw fileError('disk-error')
          }
        })
      },
      truncateTo (len) {
        return handle.truncate(len)
      },
      sync () {
        return handle.sync().catch(() => undefined)
      },
      close () {
        return handle.close().catch(() => undefined)
      }
    }))
  },

  /** SHA-256 over [from, from+length) — `length` null means "to the end". */
  hash (path, from, length, onProgress, isAborted) {
    return new Promise((resolve, reject) => {
      const h = createHash('sha256')
      if (length === 0) {
        resolve(h.digest('hex'))
        return
      }
      const options = { start: from, highWaterMark: FILE_CHUNK }
      if (typeof length === 'number') {
        options.end = from + length - 1
      }
      const stream = createReadStream(path, options)
      let done = 0
      let settled = false
      const stopPoll = () => {
        if (poll) {
          clearInterval(poll)
        }
      }
      const settleReject = (err) => {
        if (!settled) {
          settled = true
          stopPoll()
          reject(err)
        }
      }
      let poll = null
      if (isAborted) {
        poll = setInterval(() => {
          if (isAborted()) {
            settleReject(fileError('cancelled'))
            stream.destroy()
          }
        }, 500)
      }
      stream.on('data', (chunk) => {
        h.update(chunk)
        done += chunk.length
        if (onProgress) {
          onProgress(done)
        }
      })
      stream.on('end', () => {
        if (!settled) {
          settled = true
          stopPoll()
          resolve(h.digest('hex'))
        }
      })
      stream.on('error', (err) => settleReject(err))
    })
  }
}

/* ---------------------------------------------------------------- session */

/**
 * Common machinery: frame intake, event-driven waits (never a busy poll),
 * single-settle completion, progress throttling. Subclasses define
 * `handleFrame` and `run`.
 */
class FileSession {
  constructor ({ tid, peer, name, size, fid, link, io, onUpdate, onDone }) {
    this.tid = tid
    this.peer = peer
    this.name = name
    this.size = size
    this.fid = fid
    this.link = link
    this.io = io || fsIo
    this.onUpdate = onUpdate || (() => {})
    this.onDone = onDone || (() => {})

    this.phase = 'starting'
    this.reason = null
    this.savedAs = null
    this.transferred = 0
    this.startedAt = Date.now()
    this.aborted = false
    this.abortReason = null
    this.finished = false

    this.waiters = []
    this.reader = null
    this.writer = null
    this.lastPushAt = 0
    this.lastPushPhase = ''
  }

  /** Sole frame entry point (manager dispatch calls this for our tid). */
  onFrame (header, body) {
    if (this.finished || !header || header.tid !== this.tid) {
      return
    }
    this.handleFrame(header, body)
    this.wake()
  }

  /** User/manager cancel or connection loss. Keeps `.part` for resume. */
  abort (reason) {
    if (this.finished || this.aborted) {
      return
    }
    this.aborted = true
    this.abortReason = reason || 'cancelled'
    this.wake()
  }

  get abortedNow () {
    return this.aborted || this.finished
  }

  send (header, body) {
    if (this.finished || this.link.closed) {
      return
    }
    try {
      this.link.send(header, body)
    } catch (err) {
      /* link died mid-frame — the run loop notices via abort('conn-lost') */
    }
  }

  _await (check, timeout, label) {
    if (this.aborted) {
      return Promise.reject(fileError(this.abortReason || 'cancelled'))
    }
    if (this.finished) {
      return Promise.reject(fileError(this.reason || 'cancelled'))
    }
    if (check()) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      const settle = (fn, arg) => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          clearTimeout(timer)
        }
        const i = this.waiters.indexOf(tick)
        if (i >= 0) {
          this.waiters.splice(i, 1)
        }
        fn(arg)
      }
      const tick = () => {
        if (this.aborted) {
          settle(reject, fileError(this.abortReason || 'cancelled'))
        } else if (this.finished) {
          settle(reject, fileError(this.reason || 'cancelled'))
        } else if (check()) {
          settle(resolve)
        }
      }
      timer = setTimeout(() => settle(reject, fileError('timeout')), timeout)
      this.waiters.push(tick)
    })
  }

  wake () {
    // do NOT drain the array: a waiter whose condition is not yet true must
    // stay registered for the next frame (draining it here dead-ends the
    // transfer until its timeout fires)
    this.waiters.slice().forEach((fn) => fn())
  }

  /** Progress push, phase changes always, plain byte ticks at 500ms. */
  status (phase, transferred) {
    if (transferred !== undefined) {
      this.transferred = transferred
    }
    this.phase = phase
    const now = Date.now()
    if (phase !== this.lastPushPhase || transferred === this.size || now - this.lastPushAt >= 500) {
      this.lastPushPhase = phase
      this.lastPushAt = now
      this.emitUpdate()
    }
  }

  emitUpdate () {
    safeCall(this.onUpdate, this.snapshot())
  }

  snapshot () {
    return {
      tid: this.tid,
      peer: this.peer,
      name: this.name,
      size: this.size,
      transferred: this.transferred,
      phase: this.finished && this.reason && !this.savedAs ? 'failed' : this.phase,
      reason: this.reason,
      savedAs: this.savedAs,
      startedAt: this.startedAt
    }
  }

  /** Terminal: exactly once, runs onDone, releases file handles. */
  settle (ok, { reason = null, savedAs = null, notifyPeer = false, dropPart = false } = {}) {
    if (this.finished) {
      return Promise.resolve()
    }
    this.finished = true
    if (ok) {
      this.phase = 'done'
      this.savedAs = savedAs || this.name
    } else {
      this.phase = 'failed'
      this.reason = reason || 'cancelled'
    }
    if (notifyPeer) {
      this.send({ t: 'file-cancel', tid: this.tid, reason: this.reason })
    }
    const handles = []
    if (this.reader) {
      handles.push(this.reader.close())
      this.reader = null
    }
    if (this.writer) {
      handles.push(this.writer.close())
      this.writer = null
    }
    if (dropPart && this.partPath) {
      handles.push(this.io.unlink(this.partPath), this.io.unlink(metaPathFor(this.partPath)))
    }
    return Promise.all(handles.map((p) => Promise.resolve(p).catch(() => undefined)))
      .then(() => {
        safeCall(this.onUpdate, this.snapshot())
        safeCall(this.onDone, {
          ok,
          tid: this.tid,
          peer: this.peer,
          name: this.name,
          reason: ok ? null : this.reason,
          savedAs: ok ? this.savedAs : null
        })
      })
  }

  /** Failure path shared by both loops: classify, announce, settle. */
  fail (err, { notifyPeer = false, dropPart = false } = {}) {
    const reason = (err && err.reason) || (err && err.message) || 'error'
    if (!this.finished) {
      safeCall(this.onUpdate, this.snapshot())
    }
    return this.settle(false, {
      reason: classifyReason(reason),
      notifyPeer: notifyPeer && !this.link.closed,
      dropPart
    })
  }
}

function classifyReason (reason) {
  const known = [
    'user-rejected', 'timeout', 'busy', 'receive-off', 'too-large',
    'checksum-mismatch', 'seq-error', 'size-mismatch', 'name-exhausted',
    'conn-lost', 'disk-error', 'cancelled'
  ]
  if (known.includes(reason)) {
    return reason
  }
  if (reason === 'refused' || String(reason).includes('reject')) {
    return 'user-rejected'
  }
  if (String(reason).includes('cancel')) {
    return 'cancelled'
  }
  return 'error'
}

function safeCall (fn, arg) {
  try {
    fn(arg)
  } catch (err) {
    /* never let a UI callback break a transfer */
  }
}

/* ------------------------------------------------------------- sender */

export class SendSession extends FileSession {
  constructor (opts) {
    super(opts)
    this.path = opts.path
    this.acked = 0
    this.terminal = null // accept/reject/complete/cancel/error, whichever came
    this.sentData = false
  }

  handleFrame (header) {
    const t = header.t
    if (t === 'file-ack') {
      this.acked = Math.max(this.acked, Number(header.off) || 0)
      return
    }
    if (t === 'file-accept' || t === 'file-reject' || t === 'file-complete' ||
        t === 'file-error' || t === 'file-cancel') {
      this.terminal = header
    }
  }

  killed () {
    return !!(this.terminal && ['file-reject', 'file-error', 'file-cancel'].includes(this.terminal.t))
  }

  async run () {
    try {
      if (this.aborted) {
        throw fileError(this.abortReason)
      }
      // pass 1: whole-file hash — becomes the resume key and the final check
      this.status('hashing', 0)
      this.fid = await this.io.hash(this.path, 0, this.size, (bytes) => {
        this.status('hashing', Math.min(bytes, this.size))
      }, () => this.abortedNow)

      this.status('waiting', 0)
      this.send({ t: 'file-offer', tid: this.tid, fid: this.fid, name: this.name, size: this.size })
      await this._await(() => this.terminal, ACCEPT_WAIT, 'accept')
      const acc = this.terminal
      this.terminal = null
      if (acc.t !== 'file-accept') {
        throw fileError(acc.reason || (acc.t === 'file-reject' ? 'user-rejected' : 'cancelled'))
      }

      // resume negotiation: both sides hash the shared prefix
      let offset = 0
      let prefix = null
      const pitch = Math.max(0, Math.min(Number(acc.offset) || 0, this.size))
      if (pitch > 0 && typeof acc.prefixHash === 'string' && acc.prefixHash.length === 64) {
        this.status('hashing', pitch)
        prefix = await this.io.hash(this.path, 0, pitch, null, () => this.abortedNow)
        if (prefix === acc.prefixHash) {
          offset = pitch
        }
      }
      this.transferred = offset
      this.acked = offset
      this.send({ t: 'file-begin', tid: this.tid, offset, prefixHash: prefix || '' })

      this.reader = await this.io.openReader(this.path)
      this.status('sending', offset)
      let pos = offset
      while (pos < this.size) {
        if (this.aborted) {
          throw fileError(this.abortReason || 'cancelled')
        }
        if (this.killed()) {
          throw fileError(this.terminal.reason || (this.terminal.t === 'file-reject' ? 'user-rejected' : 'cancelled'))
        }
        if (pos - this.acked >= FILE_WINDOW) {
          await this._await(() => pos - this.acked < FILE_WINDOW || this.killed(), ACK_WAIT, 'ack')
          continue
        }
        const n = Math.min(FILE_CHUNK, this.size - pos)
        // eslint-disable-next-line no-await-in-loop
        const buf = await this.reader.readAt(pos, n)
        if (!buf) {
          throw fileError('disk-error')
        }
        if (!this.link.send({ t: 'file-data', tid: this.tid, off: pos }, buf)) {
          // eslint-disable-next-line no-await-in-loop
          await this.link.waitForDrain()
          if (this.link.closed) {
            throw fileError('conn-lost')
          }
        }
        this.sentData = true
        pos += n
        this.status('sending', pos)
      }

      this.send({ t: 'file-end', tid: this.tid, off: this.size, size: this.size })
      this.status('verifying', this.size)
      await this._await(() => this.terminal, COMPLETE_WAIT, 'complete')
      const done = this.terminal
      if (done.t !== 'file-complete') {
        throw fileError(done.reason || 'cancelled')
      }
      if (!done.ok) {
        throw fileError(done.reason || 'checksum-mismatch')
      }
      this.reader = closeNow(this.reader)
      await this.settle(true, { savedAs: String(done.savedAs || this.name) })
    } catch (err) {
      this.reader = closeNow(this.reader)
      await this.fail(err, { notifyPeer: this.sentData })
    }
  }
}

function closeNow (handle) {
  if (handle) {
    Promise.resolve(handle.close()).catch(() => undefined)
  }
  return null
}

/* ----------------------------------------------------------- receiver */

export class ReceiveSession extends FileSession {
  constructor (opts) {
    super(opts)
    this.dir = opts.dir
    this.offsetOffered = 0
    this.prefixOffered = null
    this.begin = null
    this.fileEnd = null
    this.kill = null
    this.queue = [] // [header, body] frames awaiting the pump, window-bounded
    this.written = 0
    this.lastAck = 0
    this.partPath = partPathFor(opts.dir, opts.name, opts.fid)
  }

  handleFrame (header, body) {
    const t = header.t
    if (t === 'file-data') {
      this.queue.push([header, body])
    } else if (t === 'file-end') {
      this.queue.push([header, body])
      this.fileEnd = header
    } else if (t === 'file-begin') {
      this.begin = header
    } else if (t === 'file-error' || t === 'file-cancel') {
      this.kill = header
    }
    // file-ack/file-complete/file-offer/file-reject are not ours to receive
  }

  /**
   * Announce ourselves with the resume pitch (hashing an existing part can
   * take a while — that shows as the `hashing` phase).
   */
  async start () {
    try {
      // the chosen directory may have been deleted since it was saved
      await this.io.mkdirp(this.dir)
      this.status('hashing', 0)
      let offset = 0
      let prefix = null
      const partSize = await this.io.sizeOf(this.partPath)
      if (partSize > 0) {
        // eslint-disable-next-line no-await-in-loop
        const meta = await this.io.readJson(metaPathFor(this.partPath))
        offset = resumeOffsetOf(meta, this.fid, this.size, partSize)
        if (offset > 0) {
          prefix = await this.io.hash(this.partPath, 0, offset, null, () => this.abortedNow)
        }
      }
      this.offsetOffered = offset
      this.prefixOffered = prefix
      this.transferred = offset
      this.send({ t: 'file-accept', tid: this.tid, offset, prefixHash: prefix || '' })
      await this.run()
    } catch (err) {
      await this.fail(err)
    }
  }

  async run () {
    try {
      if (this.aborted) {
        throw fileError(this.abortReason)
      }
      await this._await(() => this.begin || this.kill, BEGIN_WAIT, 'begin')
      if (!this.begin) {
        throw fileError(this.kill.reason || 'cancelled')
      }
      const beginOffset = Math.max(0, Math.min(Number(this.begin.offset) || 0, this.size))
      // beginOffset < offered offset means the sender's copy no longer matches
      // our prefix (or the part was longer than the file) — truncateTo below
      // drops whatever the sender will not resend.
      this.writer = await this.io.openWriter(this.partPath, beginOffset === 0)
      // eslint-disable-next-line no-await-in-loop
      await this.writer.truncateTo(beginOffset)
      // sidecar always rewritten: a crash mid-transfer (including a brand-new
      // zero-byte part) must still be recognisable as this file next time
      // eslint-disable-next-line no-await-in-loop
      await this.io.writeJson(metaPathFor(this.partPath), { fid: this.fid, name: this.name, size: this.size })
      this.written = beginOffset
      this.lastAck = beginOffset
      this.transferred = beginOffset
      this.status('receiving', beginOffset)

      for (;;) {
        if (this.aborted) {
          throw fileError(this.abortReason || 'cancelled')
        }
        if (this.kill) {
          throw fileError(this.kill.reason || 'cancelled')
        }
        // eslint-disable-next-line no-await-in-loop
        await this._await(() => this.queue.length > 0 || this.kill, FRAME_WAIT, 'frame')
        if (this.kill) {
          throw fileError(this.kill.reason || 'cancelled')
        }
        while (this.queue.length) {
          const [header, body] = this.queue.shift()
          if (header.t === 'file-end') {
            break
          }
          // eslint-disable-next-line no-await-in-loop
          await this.consume(header, body)
        }
        if (this.fileEnd) {
          break
        }
      }

      if (this.fileEnd.off !== this.written) {
        throw fileError('seq-error')
      }
      if (Number(this.fileEnd.size) !== this.size) {
        throw fileError('size-mismatch')
      }
      const finalSize = await this.writer.sync().then(() => this.io.sizeOf(this.partPath))
      this.writer = closeNow(this.writer)
      if (finalSize !== this.size) {
        throw fileError('size-mismatch')
      }

      this.status('hashing', this.size)
      const digest = await this.io.hash(this.partPath, 0, this.size, null, () => this.abortedNow)
      if (digest !== this.fid) {
        throw fileError('checksum-mismatch')
      }

      const savedAs = await this.finalize()
      await this.io.unlink(metaPathFor(this.partPath))
      this.send({ t: 'file-complete', tid: this.tid, ok: true, savedAs })
      await this.settle(true, { savedAs })
    } catch (err) {
      const drop = err && err.reason === 'checksum-mismatch'
      this.writer = closeNow(this.writer)
      if (drop) {
        // a corrupt part can never be resumed — the prefix check would only
        // reject it again, so clear it and say so
        await this.io.unlink(this.partPath)
        await this.io.unlink(metaPathFor(this.partPath))
        this.send({ t: 'file-complete', tid: this.tid, ok: false, reason: 'checksum-mismatch' })
      }
      await this.fail(err, { notifyPeer: !drop, dropPart: false })
    }
  }

  async consume (header, body) {
    if (!body || !body.length) {
      throw fileError('seq-error')
    }
    if (Number(header.off) !== this.written) {
      throw fileError('seq-error')
    }
    if (this.written + body.length > this.size) {
      throw fileError('size-mismatch')
    }
    await this.writer.write(body, this.written)
    this.written += body.length
    this.transferred = this.written
    if (this.written - this.lastAck >= FILE_ACK_EVERY) {
      this.send({ t: 'file-ack', tid: this.tid, off: this.written })
      this.lastAck = this.written
    }
    this.status('receiving', this.written)
  }

  /** Race-safe naming: 'wx'-claim the first free candidate, then rename. */
  async finalize () {
    const ext = extname(this.name)
    const stem = this.name.slice(0, this.name.length - ext.length)
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? this.name : `${stem} (${i})${ext}`
      // eslint-disable-next-line no-await-in-loop
      const got = await this.io.claim(join(this.dir, candidate))
      if (got) {
        // the placeholder we just created is ours; rename replaces it on both
        // Windows and POSIX, so no peer receive can lose data to a race here
        // eslint-disable-next-line no-await-in-loop
        await this.io.rename(this.partPath, join(this.dir, candidate))
        return candidate
      }
    }
    throw fileError('name-exhausted')
  }
}
