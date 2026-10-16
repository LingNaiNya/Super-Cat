import { createServer } from 'net'
import { createSocket as createDgram } from 'dgram'

import logger from '../Logger'

const RECONCILE_DEBOUNCE = 400
// Hard ceilings on what a (possibly hostile) hub can make us listen for: the
// member list it sends decides how many local sockets we open.
const MAX_FORWARD_TARGETS = 64
const MAX_FORWARD_LISTENERS = 128

/**
 * Resume `target` once `socket` drains, dropping the listener if the socket
 * closes first — a paused pipe would otherwise keep a dead handler (and its
 * closure) on a socket that is being torn down.
 */
function resumeOnDrain (socket, target) {
  const done = () => {
    socket.removeListener('drain', done)
    socket.removeListener('close', done)
    target.resume()
  }
  socket.once('drain', done)
  socket.once('close', done)
}

/**
 * Loopback VIPs only. This forwarder binds `vip:port` on the local machine, so
 * a hub handing out anything else (0.0.0.0, a LAN address) would publish the
 * tunnel ports to the whole network — second gate behind the manager's own
 * check, because this is the code that actually calls listen().
 */
function validVip (vip) {
  const match = /^127\.87\.0\.(\d{1,3})$/.exec(String(vip || ''))
  if (!match) {
    return false
  }
  const last = Number(match[1])
  return last >= 2 && last <= 254
}

function isLoopbackAddress (address) {
  const addr = String(address || '')
  return addr === '::1' || addr.startsWith('127.')
}

/**
 * Loopback virtual-LAN forwarder: binds `<member-vip>:<port>` locally for
 * every (member × exposed port) pair and pipes bytes through the P2P data
 * plane, so any app can dial `127.87.0.x:25565` with zero configuration.
 *
 * TCP: per-port listener → openStream(fp, port) → bidirectional pump.
 * UDP: per-port dgram socket → udp session (manager owns the tunnel side).
 *
 * Bind conflicts (a local service already owns 0.0.0.0:port) are recorded,
 * never fought over — we only report them.
 */
export default class VipForwarder {
  constructor ({ getTargets, openStream, openUdp }) {
    this.getTargets = getTargets
    this.openStream = openStream
    this.openUdp = openUdp
    this.tcpListeners = new Map()
    this.udpSockets = new Map()
    this.conflictList = []
    this.reconcileTimer = null
    this.stopped = false
  }

  count () {
    return this.tcpListeners.size + this.udpSockets.size
  }

  conflicts () {
    return this.conflictList.slice()
  }

  reconcile () {
    if (this.stopped) {
      return
    }
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer)
    }
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      this.doReconcile()
    }, RECONCILE_DEBOUNCE)
  }

  doReconcile () {
    let targets = []
    try {
      targets = this.getTargets() || []
    } catch (err) {
      logger.warn('[Super Cat] vip forwarder targets failed:', err.message)
      return
    }

    const conflicts = []
    const desired = new Map()
    let truncated = 0
    targets.slice(0, MAX_FORWARD_TARGETS).forEach((t) => {
      const ok = !t.vip || validVip(t.vip)
      if (!ok) {
        conflicts.push({ vip: String(t.vip), port: 0, reason: 'invalid-vip' })
      }
      const vip = ok ? (t.vip || null) : null
      ;(t.ports || []).forEach((port) => {
        if (desired.size >= MAX_FORWARD_LISTENERS) {
          truncated += 1
          return
        }
        const key = `${t.fp}:${port}`
        desired.set(key, { fp: t.fp, vip, port })
      })
    })
    if (targets.length > MAX_FORWARD_TARGETS || truncated) {
      logger.warn(`[Super Cat] vip forwarder truncated: targets=${targets.length} listeners=${desired.size}`)
    }

    // close listeners that are no longer desired
    this.tcpListeners.forEach((entry, key) => {
      if (!desired.has(key) || !desired.get(key).vip) {
        this.closeTcp(key, entry)
      }
    })
    this.udpSockets.forEach((entry, key) => {
      if (!desired.has(key) || !desired.get(key).vip) {
        this.closeUdp(key, entry)
      }
    })

    desired.forEach((spec, key) => {
      if (!spec.vip) {
        return
      }
      if (!this.tcpListeners.has(key)) {
        this.openTcp(key, spec, conflicts)
      }
      if (!this.udpSockets.has(key)) {
        this.openUdpSocket(key, spec, conflicts)
      }
    })
    this.conflictList = conflicts
  }

  openTcp (key, spec, conflicts) {
    if (!validVip(spec.vip)) {
      conflicts.push({ vip: String(spec.vip), port: spec.port, reason: 'invalid-vip' })
      return
    }
    const server = createServer((socket) => {
      socket.setNoDelay(true)
      Promise.resolve()
        .then(() => this.openStream(spec.fp, spec.port))
        .then((stream) => {
          this.pipe(socket, stream)
        })
        .catch((err) => {
          logger.info(`[Super Cat] vip tcp ${spec.vip}:${spec.port} -> ${spec.fp} failed: ${err.message}`)
          socket.destroy()
        })
    })
    server.once('error', (err) => {
      logger.info(`[Super Cat] vip tcp listen ${spec.vip}:${spec.port} failed: ${err.message}`)
      conflicts.push({ vip: spec.vip, port: spec.port, reason: err.code || err.message })
      try {
        server.close()
      } catch (e) { /* ignore */ }
      this.tcpListeners.delete(key)
    })
    server.listen(spec.port, spec.vip, () => {
      this.tcpListeners.set(key, { server })
      logger.info(`[Super Cat] vip tcp forward ${spec.vip}:${spec.port} -> ${spec.fp}`)
    })
  }

  openUdpSocket (key, spec, conflicts) {
    if (!validVip(spec.vip)) {
      conflicts.push({ vip: String(spec.vip), port: spec.port, reason: 'invalid-vip', udp: true })
      return
    }
    const sock = createDgram('udp4')
    let lastRinfo = null
    let session = null

    const ensureSession = () => {
      if (session && !session.dead) {
        return session
      }
      try {
        session = this.openUdp(spec.fp, spec.port)
        session.onData = (bytes) => {
          // Reply to the loopback caller only: this socket must never become a
          // relay that answers whoever happens to send it a datagram.
          if (lastRinfo && isLoopbackAddress(lastRinfo.address)) {
            sock.send(bytes, lastRinfo.port, lastRinfo.address)
          }
        }
      } catch (err) {
        session = null
      }
      return session
    }

    sock.on('message', (msg, rinfo) => {
      lastRinfo = rinfo
      const s = ensureSession()
      if (s) {
        s.push(msg).catch(() => {
          /* session died; next datagram recreates it */
        })
      }
    })
    sock.on('error', (err) => {
      logger.info(`[Super Cat] vip udp ${spec.vip}:${spec.port} error: ${err.message}`)
      conflicts.push({ vip: spec.vip, port: spec.port, reason: err.code || err.message, udp: true })
      this.closeUdp(key, { sock })
    })
    sock.bind(spec.port, spec.vip, () => {
      this.udpSockets.set(key, { sock })
      logger.info(`[Super Cat] vip udp forward ${spec.vip}:${spec.port} -> ${spec.fp}`)
    })
  }

  pipe (socket, stream) {
    let streamClosed = false

    stream.on('data', (chunk) => {
      if (!socket.write(chunk)) {
        stream.pause()
        resumeOnDrain(socket, stream)
      }
    })
    stream.on('close', () => {
      streamClosed = true
      socket.end()
    })
    socket.on('data', (chunk) => {
      if (!stream.write(chunk)) {
        socket.pause()
        resumeOnDrain(stream, socket)
      }
    })
    socket.on('end', () => {
      if (typeof stream.end === 'function') {
        stream.end()
      }
      if (streamClosed) {
        socket.end()
      }
    })
    socket.on('error', () => stream.destroy && stream.destroy())
    stream.on('error', () => socket.destroy())
  }

  closeTcp (key, entry) {
    try {
      entry.server.close()
    } catch (err) { /* already closed */ }
    this.tcpListeners.delete(key)
  }

  closeUdp (key, entry) {
    try {
      entry.sock.close()
    } catch (err) { /* already closed */ }
    this.udpSockets.delete(key)
  }

  stop () {
    this.stopped = true
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer)
      this.reconcileTimer = null
    }
    this.tcpListeners.forEach((entry, key) => this.closeTcp(key, entry))
    this.udpSockets.forEach((entry, key) => this.closeUdp(key, entry))
    this.conflictList = []
  }

  /** Allow reuse after a shutdown → start cycle. */
  resume () {
    this.stopped = false
    this.reconcile()
  }
}
