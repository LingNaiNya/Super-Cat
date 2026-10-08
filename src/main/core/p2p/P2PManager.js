import { EventEmitter } from 'events'
import { connect as netConnect, createServer } from 'net'
import { createSocket as createDgram } from 'dgram'
import { hostname, networkInterfaces } from 'os'

import logger from '../Logger'
import Connection, { clientHandshake, serverHandshake } from './Connection'
import Identity from './Identity'
import InviteCode, { formatCode, generateGroupId, sanitizeCode } from './InviteCode'
import Endpoint from './Endpoint'
import VipForwarder from './VipForwarder'
import {
  P2P_DEFAULT_LISTEN_PORT,
  P2P_ROLE,
  P2P_STATUS
} from '@shared/constants'

const HEARTBEAT_INTERVAL = 15000
const HEARTBEAT_TIMEOUT = 45000
const MEMBER_RETRY_MIN = 5000
const MEMBER_RETRY_MAX = 60000
const REACHABILITY_INTERVAL = 60000
const JOIN_WAIT_TIMEOUT = 180000
const PORT_TRY_RANGE = 10
const STATE_PUSH_DEBOUNCE = 150

// Probe (RTT / loss between members; owner legs are direct, member-to-member
// legs relay through the owner and are labelled as such in the UI).
const PROBE_INTERVAL = 5000
const PROBE_WINDOW = 12
const PROBE_LOSS_TIMEOUT = 3000

// Speed test over a pooled data connection (the same path VIP forwarding uses).
const SPEED_TOTAL = 24 * 1024 * 1024
const SPEED_CHUNK = 64 * 1024
const SPEED_PHASE_MS = 8000
const SPEED_STEP_TIMEOUT = 14000
// Frames the initiator still needs after the waiter that was expecting them has
// already resolved — they are parked on the connection instead of dropped.
const SPEED_FRAME_TYPES = new Set(['speed-data', 'speed-done', 'speed-error', 'speed-result'])

// Punch (classic TCP simultaneous-open; empirical limit on Windows: only one
// outbound socket may hold the listen port at a time → bursts are serial).
const PUNCH_DIAL_TIMEOUT = 1400
const PUNCH_WAIT_TIMEOUT = 3500
const DIRECT_DIAL_TIMEOUT = 2600

// Reusable data-plane connections between two members (one per punch/dial).
const DATA_POOL_CAP = 3
const DATA_POOL_IDLE = 60000

// Loopback "virtual LAN": owner hands every member a stable 127.87.0.x so any
// app can dial `<vip>:port` locally and ride the tunnel (TCP + UDP).
const VIP_PREFIX = '127.87.0.'
const UDP_IDLE_TIMEOUT = 60000

// Display names are assigned by the owner in join order — HL-1, HL-2, … — so
// nobody has to invent one and nobody can rename themselves out of order.
const memberName = (seq) => `HL-${seq}`

/**
 * Orchestrates the whole no-server mesh:
 *
 *  - control plane is hub-and-spoke: every member keeps one authenticated
 *    link to the owner; approvals, directory, status and task-push travel on
 *    it (a member only needs the owner reachable to stay in the group)
 *  - data plane is direct member-to-member: SOCKS CONNECT dials the target's
 *    advertised endpoint, handshake, whitelist check on the target side
 *  - the invite code is the bootstrap record (owner anchor + group secret),
 *    regenerated whenever the network changes
 */
export default class P2PManager extends EventEmitter {
  constructor ({ configManager, engineClient, upnpManager }) {
    super()
    this.configManager = configManager
    this.cfg = configManager.p2pConfig
    this.engineClient = engineClient
    this.upnpManager = upnpManager

    this.identity = null
    this.endpointTool = new Endpoint({ upnpManager })
    this.server = null
    this.controls = new Map()
    this.ownerConn = null
    this.pending = []
    this.timers = new Set()
    this.statePushTimer = null
    this.lastState = null
    this.stopping = false
    this.dialing = new Set()
    this.loopsStarted = false
    this.ownerRetryPending = false

    // probe (rtt/loss) + speed test
    this.probeSeq = 0
    this.probePending = new Map()
    this.probeSamples = new Map()
    this.speedActive = false
    this.speedResults = new Map()

    // punch + data plane
    this.dataPool = new Map()
    this.poolWaiters = new Map()
    this.punching = new Set()
    this.punch = { last: null, target: null, ts: 0 }

    // vip forwarder + udp sessions
    this.vipForwarder = new VipForwarder({
      getTargets: () => this.forwardTargets(),
      openStream: (fp, port) => this.openMemberStreamByFp(fp, port),
      openUdp: (fp, port) => this.udpSessionOut(fp, port)
    })
    this.udpSessions = new Map()

    this.endpoint = this.cfg.get('last-endpoint') || { h: null, p: null, source: 'none', mapped: false }
    this.lastError = null
    this.status = P2P_STATUS.IDLE
    this.retryDelay = MEMBER_RETRY_MIN
    this.discoveryRunning = false
  }

  get members () {
    return this.cfg.get('members') || []
  }

  set members (value) {
    this.cfg.set('members', value || [])
  }

  /* ------------------------------------------------------------------ setup */

  init () {
    this.ensureIdentity()
    this.ensureMemberSeqs()
    if (this.cfg.get('enabled')) {
      this.start().catch((err) => {
        logger.warn('[Super Cat] p2p auto start failed:', err.message)
        this.lastError = { message: err.message }
        this.status = P2P_STATUS.ERROR
        this.pushState()
      })
    }
  }

  ensureIdentity () {
    if (this.identity) {
      return this.identity
    }
    const saved = this.cfg.get('identity')
    if (saved && saved.pub && saved.priv) {
      this.identity = new Identity(saved)
    } else {
      this.identity = Identity.generate()
      this.cfg.set('identity', { pub: this.identity.pubB64, priv: this.identity.privB64 })
    }
    return this.identity
  }

  get role () {
    return this.cfg.get('role')
  }

  get gid () {
    return this.cfg.get('gid')
  }

  get sec () {
    return this.cfg.get('sec')
  }

  get isOwner () {
    return this.role === P2P_ROLE.OWNER && !!this.gid
  }

  get inGroup () {
    return !!this.gid && (this.role === P2P_ROLE.OWNER || this.role === P2P_ROLE.MEMBER)
  }

  /* 显示名不再由用户填写：群里叫 HL-1/HL-2 …，这里只兜底给群组默认名用 */
  get selfName () {
    return hostname()
  }

  /** 本机在群里的显示名（群主分配），尚未入群时退回主机名 */
  myName () {
    const selfFp = this.identity ? this.identity.fingerprint : ''
    const row = this.members.find((m) => m.fp === selfFp)
    return (row && row.name) || this.selfName
  }

  async start () {
    if (this.server) {
      return
    }
    this.stopping = false
    this.vipForwarder.resume()
    this.cfg.set('enabled', true)
    this.status = P2P_STATUS.STARTING
    this.pushState()

    this.ensureIdentity()

    await this.startServer()

    if (this.inGroup) {
      if (this.isOwner) {
        this.status = P2P_STATUS.JOINED
        this.refreshEndpointBackground()
        this.dialAllMembers()
      } else {
        this.status = P2P_STATUS.JOINED
        this.connectToOwnerLoop()
        this.refreshEndpointBackground()
      }
    } else {
      this.status = P2P_STATUS.IDLE
    }

    this.ensureBackgroundLoops()
    this.pushState()
  }

  ensureBackgroundLoops () {
    if (this.loopsStarted || this.stopping) {
      return
    }
    this.loopsStarted = true
    this.schedule(HEARTBEAT_INTERVAL, () => this.heartbeatTick(), true)
    this.schedule(PROBE_INTERVAL, () => this.probeTick(), true)
    this.schedule(REACHABILITY_INTERVAL, () => this.reachabilityTick(), true)
    this.schedule(30000, () => {
      if (this.isOwner) {
        this.dialAllMembers()
      }
    }, true)
  }

  /**
   * App-quit teardown: drop every socket/timer but KEEP membership and the
   * enabled flag, so the next launch rejoins the mesh automatically.
   */
  async shutdown () {
    this.stopping = true
    this.clearTimers()
    this.loopsStarted = false
    this.ownerRetryPending = false
    this.vipForwarder.stop()
    this.teardownDataPlane()
    if (this.server) {
      try {
        this.server.close()
      } catch (err) {
        /* already closed */
      }
      this.server = null
    }
    this.controls.forEach((entry) => entry.conn.close())
    this.controls.clear()
    if (this.ownerConn) {
      this.ownerConn.conn.close()
      this.ownerConn = null
    }
    this.pending = []
  }

  teardownDataPlane () {
    this.dataPool.forEach((list) => list.forEach((e) => e.conn.close()))
    this.dataPool.clear()
    this.poolWaiters.forEach((list) => list.forEach((w) => clearTimeout(w.timer) || w.reject(new Error('stopping'))))
    this.poolWaiters.clear()
    this.udpSessions.forEach((s) => {
      s.dead = true
      try {
        s.conn && s.conn.close()
      } catch (err) { /* already gone */ }
    })
    this.udpSessions.clear()
  }

  /**
   * Leave/stop: teardown plus forgetting the group (enabled=false so boot
   * does not come back up in a group the user walked away from).
   */
  async stop () {
    await this.shutdown()
    if (this.cfg.get('enabled')) {
      this.cfg.set('enabled', false)
    }
    this.status = P2P_STATUS.IDLE
    this.pushState()
  }

  async startServer () {
    const preferred = Number(this.cfg.get('listen-port')) || P2P_DEFAULT_LISTEN_PORT
    let bound = null
    let lastErr = null
    for (let i = 0; i < PORT_TRY_RANGE; i++) {
      const port = preferred + i
      try {
        bound = await this.listenOn(port)
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (!bound) {
      throw new Error(`无法监听 P2P 端口: ${lastErr ? lastErr.message : 'unknown'}`)
    }
    if (bound.port !== preferred) {
      logger.info(`[Super Cat] p2p listen port moved ${preferred} -> ${bound.port}`)
    }
    this.cfg.set('listen-port', bound.port)
  }

  listenOn (port) {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onInbound(socket))
      const onError = (err) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        server.on('error', (err) => {
          logger.warn('[Super Cat] p2p server error:', err.message)
        })
        this.server = server
        resolve({ server, port: server.address().port })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '0.0.0.0')
    })
  }

  schedule (delay, fn, repeat = false) {
    const tick = async () => {
      if (this.stopping) {
        return
      }
      try {
        await fn()
      } catch (err) {
        logger.warn('[Super Cat] p2p scheduled task failed:', err.message)
      }
      if (repeat && !this.stopping) {
        const t = setTimeout(tick, delay)
        this.timers.add(t)
      }
    }
    const t = setTimeout(tick, delay)
    this.timers.add(t)
    return t
  }

  clearTimers () {
    this.timers.forEach((t) => clearTimeout(t))
    this.timers.clear()
  }

  /* ------------------------------------------------------------ group flows */

  async createGroup ({ name = '' } = {}) {
    if (this.inGroup) {
      throw new Error('已经在一个群组中，请先退出')
    }
    this.stopping = false
    this.vipForwarder.resume()
    this.ensureIdentity()

    this.cfg.set('role', P2P_ROLE.OWNER)
    this.cfg.set('gid', generateGroupId())
    this.cfg.set('sec', Identity.randomSecret())
    this.cfg.set('group-name', name || `${this.selfName} 的群组`)
    this.cfg.set('members', [])
    this.cfg.set('banned', [])
    this.cfg.set('vip-map', {})
    // 群主是第一个入群的，编号从 HL-1 起
    this.cfg.set('member-seq', 1)
    this.assignVip(this.identity.fingerprint)
    this.status = P2P_STATUS.STARTING
    this.pushState()

    if (!this.server) {
      await this.startServer()
    }
    await this.discoverEndpoint(true)
    if (!this.endpoint.h) {
      this.cfg.set('role', '')
      this.cfg.set('gid', '')
      this.cfg.set('sec', '')
      throw new Error('无法获取本机网络地址（UPnP/STUN 均失败），无法生成邀请码')
    }

    this.members = [this.selfMember()]
    this.status = P2P_STATUS.JOINED
    this.cfg.set('enabled', true)

    this.ensureBackgroundLoops()
    this.pushState()
    return { code: this.currentCode() }
  }

  currentCode () {
    if (!this.isOwner || !this.endpoint.h) {
      return null
    }
    const listenPort = this.cfg.get('listen-port')
    const eps = []
    const push = (ep) => {
      if (ep && ep.h && ep.p && !eps.some((e) => e.h === ep.h && e.p === ep.p)) {
        eps.push({ h: ep.h, p: ep.p })
      }
    }
    // best candidates first: manual/UPnP public, then STUN, then LAN
    push({ h: this.endpoint.h, p: this.endpoint.p || listenPort })
    const lan = this.lanAddress
    if (lan) {
      push({ h: lan, p: listenPort })
    }
    return InviteCode.encode({
      gid: this.gid,
      eps,
      sec: this.sec
    }, this.identity)
  }

  get lanAddress () {
    try {
      const nets = networkInterfaces()
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal) {
            return net.address
          }
        }
      }
    } catch (err) {
      /* ignore */
    }
    return null
  }

  async joinGroup ({ code } = {}) {
    if (this.inGroup) {
      throw new Error('已经在一个群组中，请先退出')
    }
    this.stopping = false
    this.vipForwarder.resume()
    const invite = InviteCode.decode(sanitizeCode(code))
    this.ensureIdentity()

    this.status = P2P_STATUS.JOINING
    this.lastError = null
    this.pushState()

    if (!this.server) {
      await this.startServer()
    }
    this.refreshEndpointBackground()

    // v2 codes carry every candidate endpoint; v1 falls back to eps[0].
    const conn = await this.dialAnyControl(invite.eps, {
      gid: invite.gid,
      mode: 'join',
      expectPub: invite.pub,
      sec: invite.sec
    }, 2500)

    let result
    try {
      // register the waiter BEFORE asking, so a fast approval cannot slip
      // past the handler and get dropped
      const approval = conn.waitFor(
        (h) => h.t === 'join-result',
        JOIN_WAIT_TIMEOUT,
        '群主审批'
      )
      conn.send({
        t: 'join-request',
        fp: this.identity.fingerprint,
        endpoint: this.endpoint.h
          ? { h: this.endpoint.h, p: this.cfg.get('listen-port'), openPorts: this.cfg.get('open-ports') }
          : null
      })
      const message = await approval
      result = message.header
    } catch (err) {
      conn.close()
      this.status = P2P_STATUS.REJECTED
      this.lastError = { message: err.message }
      this.pushState()
      throw err
    }

    logger.info(`[Super Cat] p2p join result: ${JSON.stringify(result)}`)
    if (!result.ok) {
      conn.close()
      this.status = P2P_STATUS.REJECTED
      this.lastError = { message: result.reason || '群主拒绝了申请' }
      this.pushState()
      return { ok: false, reason: this.lastError.message }
    }

    // Adopt the group and keep this authenticated link as the control plane.
    this.cfg.set('role', P2P_ROLE.MEMBER)
    this.cfg.set('gid', invite.gid)
    this.cfg.set('sec', invite.sec)
    this.cfg.set('owner-pub', invite.pub)
    this.cfg.set('owner-ep', invite.eps[0])
    this.cfg.set('owner-eps', invite.eps)
    this.cfg.set('enabled', true)
    this.members = []
    this.status = P2P_STATUS.JOINED
    this.attachMemberControl(conn, { initiator: true, peerFp: Identity.fingerprintOf(invite.pub) })
    this.ensureBackgroundLoops()
    this.connectToOwnerLoop()
    this.pushState()
    return { ok: true }
  }

  async leaveGroup () {
    if (!this.inGroup) {
      return
    }
    if (this.isOwner) {
      // owner leaving dissolves the group for everyone
      this.broadcastToMembers({ t: 'group-dissolved' })
    } else if (this.ownerConn) {
      this.ownerConn.conn.send({ t: 'leave' })
    }
    await this.stop()
    this.cfg.set('role', '')
    this.cfg.set('gid', '')
    this.cfg.set('sec', '')
    this.cfg.set('owner-pub', '')
    this.cfg.set('owner-ep', null)
    this.cfg.set('owner-eps', [])
    this.cfg.set('owner-observed', null)
    this.cfg.set('members', [])
    this.cfg.set('banned', [])
    this.cfg.set('vip-map', {})
    this.members = []
    this.pending = []
    this.status = P2P_STATUS.IDLE
    this.lastError = null
    this.clearLinkStats()
    this.pushState()
  }

  approveJoin (fp) {
    logger.info(`[Super Cat] p2p approveJoin called: ${fp}`)
    const entry = this.pending.find((p) => p.fp === fp)
    if (!entry || !this.isOwner) {
      throw new Error('待审批项不存在')
    }
    this.pending = this.pending.filter((p) => p.fp !== fp)
    const seq = this.nextMemberSeq()
    const member = {
      fp: entry.fp,
      seq,
      name: memberName(seq),
      pub: entry.cpub,
      h: entry.endpoint ? entry.endpoint.h : null,
      p: entry.endpoint ? entry.endpoint.p : null,
      vip: this.assignVip(entry.fp),
      openPorts: (entry.endpoint && entry.endpoint.openPorts) || [],
      online: true,
      reachable: null,
      lastSeen: Date.now()
    }
    this.members = [...this.members.filter((m) => m.fp !== fp), member]
    this.cfg.set('members', this.members)

    entry.conn.send({ t: 'join-result', ok: true })
    // joins are always member-dialed, so on this side the initiator is the member
    this.attachOwnerControl(entry.conn, fp, { initiator: false })
    this.sendDirectory(entry.conn)
    this.broadcastToMembers({ t: 'member-update', op: 'add', member: this.publicMember(member) }, fp)
    this.pushState()
    return { ok: true }
  }

  rejectJoin (fp) {
    logger.info(`[Super Cat] p2p rejectJoin called: ${fp}`)
    const entry = this.pending.find((p) => p.fp === fp)
    if (!entry) {
      throw new Error('待审批项不存在')
    }
    this.pending = this.pending.filter((p) => p.fp !== fp)
    entry.conn.send({ t: 'join-result', ok: false, reason: '群主拒绝了申请' })
    entry.conn.close()
    this.pushState()
    return { ok: true }
  }

  kickMember (fp) {
    if (!this.isOwner) {
      throw new Error('只有群主可以移除成员')
    }
    const member = this.members.find((m) => m.fp === fp && m.fp !== this.identity.fingerprint)
    if (!member) {
      throw new Error('成员不存在')
    }
    const banned = new Set([...(this.cfg.get('banned') || []), fp])
    this.cfg.set('banned', [...banned])
    this.members = this.members.filter((m) => m.fp !== fp)
    this.cfg.set('members', this.members)
    const entry = this.controls.get(fp)
    if (entry) {
      entry.conn.send({ t: 'kick', reason: '已被群主移除' })
      entry.conn.close()
    }
    this.broadcastToMembers({ t: 'member-update', op: 'remove', member: { fp } }, fp)
    this.pushState()
    return { ok: true }
  }

  async resetInviteCode () {
    if (!this.isOwner) {
      throw new Error('只有群主可以重置邀请码')
    }
    this.cfg.set('sec', Identity.randomSecret())
    await this.discoverEndpoint(true)
    if (!this.endpoint.h) {
      throw new Error('无法获取网络地址，邀请码未更新')
    }
    const code = this.currentCode()
    this.broadcastToMembers({
      t: 'code-rotated',
      sec: this.sec,
      ep: { h: this.endpoint.h, p: this.endpoint.p || this.cfg.get('listen-port') }
    })
    this.pushState()
    return { ok: true, code }
  }

  /* ---------------------------------------------------------- inbound mesh */

  onInbound (socket) {
    socket.setNoDelay(true)
    logger.info(`[Super Cat] p2p accept from ${socket.remoteAddress}:${socket.remotePort}`)
    const conn = new Connection(socket, this.identity)
    serverHandshake(conn, {
      gid: this.gid,
      getSec: () => this.sec,
      lookupMember: (pub, fp) => this.lookupMember(pub, fp)
    })
      .then((info) => {
        logger.info(`[Super Cat] p2p inbound mode=${info.mode} from=${info.fp}`)
        if (!this.inGroup) {
          conn.close()
          return
        }
        if (info.mode === 'join') {
          this.handleJoinRequest(conn, info)
        } else if (info.mode === 'member') {
          if (this.isOwner) {
            this.attachOwnerControl(conn, info.fp, { initiator: false })
          } else if (info.fp === Identity.fingerprintOf(this.cfg.get('owner-pub'))) {
            this.attachMemberControl(conn, { initiator: false, peerFp: info.fp })
          } else {
            conn.close()
          }
        } else if (info.mode === 'data') {
          this.attachDataConn(info.fp, conn)
        }
      })
      .catch((err) => {
        logger.info('[Super Cat] p2p inbound handshake failed:', err.message)
        conn.close()
      })
  }

  lookupMember (pub, fp) {
    if (!this.inGroup) {
      return null
    }
    const banned = this.cfg.get('banned') || []
    if (banned.includes(fp)) {
      return null
    }
    return this.members.find((m) => m.fp === fp && m.pub === pub) || null
  }

  async handleJoinRequest (conn, info) {
    try {
      const { header } = await conn.waitFor((h) => h.t === 'join-request', 15000, 'join-request')
      const banned = this.cfg.get('banned') || []
      logger.info(`[Super Cat] p2p join-request from ${info.fp} owner=${this.isOwner} banned=${banned.includes(info.fp)}`)
      if (!this.isOwner || banned.includes(info.fp)) {
        conn.send({ t: 'join-result', ok: false, reason: '无法加入该群组' })
        conn.close()
        return
      }

      const existing = this.members.find((m) => m.fp === info.fp && m.pub === info.cpub)
      if (existing) {
        // already-remembered member re-joining (fresh install / rebind):
        // restore without a second approval round. 名字由群主分配，不接受自报。
        this.members = this.members.map((m) => (
          m.fp === info.fp
            ? { ...m, online: true, lastSeen: Date.now() }
            : m
        ))
        this.cfg.set('members', this.members)
        conn.send({ t: 'join-result', ok: true })
        this.attachOwnerControl(conn, info.fp, { initiator: false })
        this.sendDirectory(conn)
        this.pushState()
        return
      }

      this.pending = [
        ...this.pending.filter((p) => p.fp !== info.fp),
        {
          fp: info.fp,
          name: header.name || info.fp,
          cpub: info.cpub,
          endpoint: header.endpoint || null,
          since: Date.now(),
          conn
        }
      ]
      conn.on('close', () => {
        this.pending = this.pending.filter((p) => p.conn !== conn)
        this.pushState()
      })
      this.emit('notify', { type: 'info', key: 'join-request' })
      this.pushState()
    } catch (err) {
      logger.info('[Super Cat] join-request failed:', err.message)
      conn.close()
    }
  }

  attachOwnerControl (conn, fp, { initiator }) {
    const initiatorFp = initiator ? this.identity.fingerprint : fp
    const existing = this.controls.get(fp)
    if (existing) {
      // Deterministic tie-break: both sides keep the link initiated by the
      // smaller fingerprint, so a simultaneous cross-dial collapses to one.
      if (existing.initiatorFp <= initiatorFp) {
        conn.close()
        return existing.conn
      }
      existing.conn.close()
    }
    const entry = { conn, initiatorFp, lastSeen: Date.now() }
    this.controls.set(fp, entry)
    this.recordObserved(fp, conn)

    conn.on('message', (header, body) => {
      entry.lastSeen = Date.now()
      this.handleOwnerSideMessage(fp, header, body)
    })
    conn.on('close', () => {
      if (this.controls.get(fp) === entry) {
        this.controls.delete(fp)
        this.setMemberOnline(fp, false)
      }
    })

    this.setMemberOnline(fp, true)
    this.pushState()
    return conn
  }

  /**
   * The address a peer's packets ACTUALLY arrive from (what the NAT put on
   * the wire) — the only dial target guaranteed to match a live mapping.
   * Directory distributes it; every callback prefers it over the peer's
   * self-reported STUN address, which can differ under symmetric NATs.
   */
  recordObserved (fp, conn) {
    const h = normalizeAddr(conn.socket.remoteAddress)
    const p = conn.socket.remotePort
    if (!h || !p) {
      return
    }
    const current = this.members.find((m) => m.fp === fp)
    if (current && current.observed && current.observed.h === h && current.observed.p === p) {
      return
    }
    this.members = this.members.map((m) => (
      m.fp === fp ? { ...m, observed: { h, p } } : m
    ))
    this.cfg.set('members', this.members)
    if (this.isOwner) {
      const updated = this.members.find((m) => m.fp === fp)
      if (updated) {
        this.broadcastToMembers({ t: 'member-update', op: 'add', member: this.publicMember(updated) }, fp)
      }
      this.pushState()
    }
    logger.info(`[Super Cat] observed ${fp} @ ${h}:${p}`)
  }

  handleOwnerSideMessage (fp, header) {
    switch (header.t) {
    case 'ping':
      this.controls.get(fp) && this.controls.get(fp).conn.send({ t: 'pong', ts: Date.now() })
      break
    case 'pong':
      break
    case 'probe': {
      const entry = this.controls.get(fp)
      if (!entry) {
        break
      }
      const via = header.via
      if (!via || via === this.identity.fingerprint) {
        entry.conn.send({ t: 'probe-reply', seq: header.seq, ts: header.ts })
      } else {
        const target = this.controls.get(via)
        if (target) {
          target.conn.send({ t: 'probe', seq: header.seq, ts: header.ts, origin: fp })
        }
        // target offline: stay silent — the initiator records a loss on timeout
      }
      break
    }
    case 'probe-reply': {
      if (header.origin) {
        // relayed reply from the probed member → hand it back to the asker
        const dest = this.controls.get(header.origin)
        if (dest) {
          dest.conn.send({ t: 'probe-reply', seq: header.seq, ts: header.ts, relay: true })
        }
      } else {
        // answer to the owner's own probe
        this.finishProbe(header.seq)
      }
      break
    }
    case 'endpoint-update': {
      this.members = this.members.map((m) => (
        m.fp === fp
          ? {
            ...m,
            h: header.h,
            p: header.p,
            openPorts: header.openPorts || m.openPorts
          }
          : m
      ))
      this.cfg.set('members', this.members)
      const member = this.members.find((m) => m.fp === fp)
      if (member) {
        this.broadcastToMembers({ t: 'member-update', op: 'add', member: this.publicMember(member) }, fp)
      }
      this.pushState()
      break
    }
    case 'task-push':
      this.handleIncomingTaskPush(fp, header)
      break
    case 'leave':
      this.removeMember(fp, '主动退出')
      break
    case 'punch-request': {
      const targetFp = header.target
      if (!targetFp || targetFp === fp) {
        break
      }
      const requester = this.members.find((m) => m.fp === fp)
      const target = this.members.find((m) => m.fp === targetFp)
      if (!requester) {
        break
      }
      const peerInfo = (m) => ({ fp: m.fp, eps: this.memberCandidates(m) })
      if (targetFp === this.identity.fingerprint) {
        // owner is the target: tell the requester how to reach US, and dial
        // the requester ourselves (mutual poke opens both NATs)
        const entry = this.controls.get(fp)
        if (entry) {
          entry.conn.send({ t: 'punch-signal', peer: this.selfPeerInfo() })
        }
        this.runPunchBurst(peerInfo(requester))
        break
      }
      if (!target) {
        const entry = this.controls.get(fp)
        if (entry) {
          entry.conn.send({ t: 'punch-unavailable', target: targetFp })
        }
        break
      }
      const requesterEntry = this.controls.get(fp)
      if (requesterEntry) {
        requesterEntry.conn.send({ t: 'punch-signal', peer: peerInfo(target) })
      }
      const targetEntry = this.controls.get(targetFp)
      if (targetEntry) {
        targetEntry.conn.send({ t: 'punch-signal', peer: peerInfo(requester) })
      }
      break
    }
    default:
      break
    }
  }

  attachMemberControl (conn, { initiator, peerFp }) {
    const initiatorFp = initiator ? this.identity.fingerprint : peerFp
    const existing = this.ownerConn
    if (existing) {
      if (existing.initiatorFp <= initiatorFp) {
        conn.close()
        return existing.conn
      }
      existing.conn.close()
    }
    const entry = { conn, initiatorFp, lastSeen: Date.now() }
    this.ownerConn = entry
    this.retryDelay = MEMBER_RETRY_MIN
    // The remote end of this link is the owner; remember how we reach it.
    const ownerH = normalizeAddr(conn.socket.remoteAddress)
    const ownerP = conn.socket.remotePort
    if (ownerH && ownerP) {
      this.cfg.set('owner-observed', { h: ownerH, p: ownerP })
    }

    conn.on('message', (header) => {
      entry.lastSeen = Date.now()
      this.handleMemberSideMessage(header)
    })
    conn.on('close', () => {
      if (this.ownerConn === entry) {
        this.ownerConn = null
        this.scheduleOwnerRetry()
      }
    })

    this.pushState()
    return conn
  }

  handleMemberSideMessage (header) {
    switch (header.t) {
    case 'ping':
      this.ownerConn && this.ownerConn.conn.send({ t: 'pong', ts: Date.now() })
      break
    case 'pong':
      break
    case 'probe':
      if (this.ownerConn) {
        const reply = { t: 'probe-reply', seq: header.seq, ts: header.ts }
        if (header.origin) {
          reply.origin = header.origin
        }
        this.ownerConn.conn.send(reply)
      }
      break
    case 'probe-reply':
      this.finishProbe(header.seq)
      break
    case 'directory':
      this.members = header.members || []
      this.cfg.set('members', this.members)
      this.pushState()
      break
    case 'member-update':
      if (header.op === 'add' && header.member) {
        this.members = [...this.members.filter((m) => m.fp !== header.member.fp), header.member]
      } else if (header.op === 'remove' && header.member) {
        this.members = this.members.filter((m) => m.fp !== header.member.fp)
      }
      this.cfg.set('members', this.members)
      this.pushState()
      break
    case 'member-status':
      this.members = this.members.map((m) => (
        m.fp === header.fp ? { ...m, online: header.online } : m
      ))
      this.cfg.set('members', this.members)
      this.pushState()
      break
    case 'task-push':
      this.deliverTask({ from: header.from, urls: header.urls, options: header.options })
      break
    case 'task-push-error':
      this.emit('notify', { type: 'error', message: header.reason || '推送失败' })
      break
    case 'kick':
      this.bye('kicked', header.reason || '你已被群主移除')
      break
    case 'group-dissolved':
      this.bye('kicked', '群主已解散群组')
      break
    case 'code-rotated':
      this.cfg.set('sec', header.sec)
      if (header.ep) {
        this.cfg.set('owner-ep', header.ep)
      }
      break
    case 'punch-signal':
      this.runPunchBurst(header.peer || {})
      break
    case 'punch-unavailable':
      this.punch = { last: 'fail', target: header.target, ts: Date.now() }
      this.rejectPoolWaiters(header.target, new Error('对方不在线，无法打洞'))
      this.pushState()
      break
    default:
      break
    }
  }

  async bye (status, message) {
    this.lastError = { message }
    await this.stop()
    this.cfg.set('role', '')
    this.cfg.set('gid', '')
    this.cfg.set('sec', '')
    this.cfg.set('owner-pub', '')
    this.cfg.set('owner-ep', null)
    this.cfg.set('owner-eps', [])
    this.cfg.set('owner-observed', null)
    this.cfg.set('members', [])
    this.cfg.set('vip-map', {})
    this.members = []
    this.status = status
    this.clearLinkStats()
    this.pushState()
  }

  /* ------------------------------------------------------- outbound mesh */

  async dialControl (ep, { gid, mode, expectPub, sec, timeout = 8000, localPort = null, localAddress = null }) {
    const socket = await tcpConnect(ep.h, ep.p, timeout, localPort, localAddress)
    socket.setNoDelay(true)
    const conn = new Connection(socket, this.identity)
    try {
      await clientHandshake(conn, { gid, mode, sec, expectPub })
    } catch (err) {
      conn.destroy(err)
      throw err
    }
    return conn
  }

  /**
   * Windows will only let an outbound socket reuse the tunnel listen port
   * when a concrete localAddress is given (wildcard → EADDRINUSE, verified
   * by experiment). Loopback targets bind loopback; real targets bind the LAN
   * IP so the NAT mapping matches what the peer will dial back to.
   */
  bindOptionsFor (ep) {
    const listenPort = Number(this.cfg.get('listen-port'))
    if (!listenPort) {
      return null
    }
    if (isLoopbackHost(ep.h)) {
      return { localPort: listenPort, localAddress: '127.0.0.1' }
    }
    const lan = this.lanAddress
    if (lan) {
      return { localPort: listenPort, localAddress: lan }
    }
    return null
  }

  /** Sequential short-timeout race over candidate endpoints; first handshake wins. */
  async dialAnyControl (eps, opts, perTimeout = 2500) {
    const list = (eps || []).filter((e) => e && e.h && e.p)
    if (!list.length) {
      throw new Error('没有可用的连接地址')
    }
    let lastErr = null
    for (const ep of list) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await this.dialControl(ep, { ...opts, timeout: perTimeout })
      } catch (err) {
        lastErr = err
        logger.info(`[Super Cat] dial candidate ${ep.h}:${ep.p} failed: ${err.message}`)
      }
    }
    throw lastErr || new Error('所有候选地址均连接失败')
  }

  /** Every way we know how to reach a member: observed (NAT-accurate) first. */
  memberCandidates (member) {
    const list = []
    const push = (ep) => {
      if (ep && ep.h && ep.p && !list.some((e) => e.h === ep.h && e.p === ep.p)) {
        list.push({ h: ep.h, p: Number(ep.p) })
      }
    }
    push(member.observed)
    push({ h: member.h, p: member.p })
    // when the member IS the owner, add everything we've learned about the
    // anchor (invite eps + last observed) so direct dials don't need a punch
    if (!this.isOwner && member.pub && member.pub === this.cfg.get('owner-pub')) {
      push(this.cfg.get('owner-observed'))
      ;(this.cfg.get('owner-eps') || []).forEach(push)
    }
    return list
  }

  /** This instance's own reachable endpoints (for punch-signals we send). */
  selfPeerInfo () {
    const listenPort = this.cfg.get('listen-port')
    const eps = []
    const push = (h, p) => {
      if (h && p && !eps.some((e) => e.h === h && e.p === p)) {
        eps.push({ h, p: Number(p) })
      }
    }
    push(this.endpoint.h, this.endpoint.p || listenPort)
    push(this.lanAddress, listenPort)
    return { fp: this.identity.fingerprint, eps }
  }

  async dialMemberOnce (member) {
    if (this.stopping || this.controls.has(member.fp) || this.dialing.has(member.fp)) {
      return
    }
    const eps = this.memberCandidates(member)
    if (!eps.length) {
      return
    }
    this.dialing.add(member.fp)
    try {
      const conn = await this.dialAnyControl(eps, {
        gid: this.gid,
        mode: 'member',
        expectPub: member.pub
      }, DIRECT_DIAL_TIMEOUT)
      this.attachOwnerControl(conn, member.fp, { initiator: true })
    } catch (err) {
      logger.info(`[Super Cat] owner dial member ${member.fp} failed: ${err.message}`)
    } finally {
      this.dialing.delete(member.fp)
    }
  }

  dialAllMembers () {
    this.members
      .filter((m) => !m.isSelf && !this.controls.has(m.fp))
      .forEach((m) => this.dialMemberOnce(m))
  }

  scheduleOwnerRetry () {
    if (this.stopping || !this.inGroup || this.isOwner || this.ownerRetryPending) {
      return
    }
    this.ownerRetryPending = true
    const delay = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, MEMBER_RETRY_MAX)
    const t = setTimeout(() => {
      this.timers.delete(t)
      this.ownerRetryPending = false
      this.tryOwnerConnect()
    }, delay)
    this.timers.add(t)
  }

  connectToOwnerLoop () {
    if (this.stopping || this.isOwner || this.ownerConn) {
      return
    }
    this.tryOwnerConnect()
  }

  async tryOwnerConnect () {
    if (this.stopping || this.ownerConn || !this.inGroup || this.isOwner) {
      return
    }
    const ownerPub = this.cfg.get('owner-pub')
    if (!ownerPub) {
      return
    }
    const eps = []
    const push = (ep) => {
      if (ep && ep.h && ep.p && !eps.some((e) => e.h === ep.h && e.p === ep.p)) {
        eps.push(ep)
      }
    }
    push(this.cfg.get('owner-ep'))
    ;(this.cfg.get('owner-eps') || []).forEach(push)
    push(this.cfg.get('owner-observed'))
    if (!eps.length) {
      return
    }
    try {
      const conn = await this.dialAnyControl(eps, {
        gid: this.gid,
        mode: 'member',
        expectPub: ownerPub
      }, DIRECT_DIAL_TIMEOUT)
      if (this.ownerConn) {
        // someone beat us to it (owner dialed in meanwhile)
        conn.close()
        return
      }
      this.attachMemberControl(conn, { initiator: true, peerFp: Identity.fingerprintOf(ownerPub) })
    } catch (err) {
      logger.info(`[Super Cat] dial owner failed: ${err.message}`)
      this.scheduleOwnerRetry()
    }
  }

  /* ----------------------------------------------------------- heartbeats */

  heartbeatTick () {
    const now = Date.now()
    this.controls.forEach((entry, fp) => {
      if (now - entry.lastSeen > HEARTBEAT_TIMEOUT) {
        entry.conn.destroy(new Error('heartbeat timeout'))
        return
      }
      entry.conn.send({ t: 'ping', ts: now })
    })
    if (this.ownerConn) {
      if (now - this.ownerConn.lastSeen > HEARTBEAT_TIMEOUT) {
        this.ownerConn.conn.destroy(new Error('heartbeat timeout'))
      } else {
        this.ownerConn.conn.send({ t: 'ping', ts: now })
      }
    }
  }

  /* ------------------------------------------------- probe (rtt / loss) */

  probeTick () {
    if (!this.inGroup || this.status !== P2P_STATUS.JOINED) {
      return
    }
    const now = Date.now()
    this.probePending.forEach((p, seq) => {
      if (now - p.ts > PROBE_LOSS_TIMEOUT) {
        this.probePending.delete(seq)
        this.recordProbe(p.target, null)
      }
    })
    if (this.isOwner) {
      this.controls.forEach((entry, fp) => this.sendProbe(fp))
    } else if (this.ownerConn) {
      const ownerFp = Identity.fingerprintOf(this.cfg.get('owner-pub'))
      if (ownerFp) {
        this.sendProbe(ownerFp)
      }
      this.members.forEach((m) => {
        // members persisted in cfg carry no `isSelf` — compare fingerprints
        if (m.fp !== this.identity.fingerprint && m.fp !== ownerFp && m.online) {
          this.sendProbe(m.fp)
        }
      })
    }
  }

  sendProbe (target) {
    const pending = [...this.probePending.values()].filter((p) => p.target === target)
    if (pending.length >= 2) {
      return
    }
    const seq = ++this.probeSeq
    const ts = Date.now()
    this.probePending.set(seq, { target, ts })
    if (this.isOwner) {
      const entry = this.controls.get(target)
      if (entry) {
        entry.conn.send({ t: 'probe', seq, ts })
      } else {
        this.probePending.delete(seq)
      }
      return
    }
    if (!this.ownerConn) {
      this.probePending.delete(seq)
      return
    }
    const ownerFp = Identity.fingerprintOf(this.cfg.get('owner-pub'))
    if (target === ownerFp) {
      this.ownerConn.conn.send({ t: 'probe', seq, ts })
    } else {
      this.ownerConn.conn.send({ t: 'probe', seq, ts, via: target })
    }
  }

  finishProbe (seq) {
    const p = this.probePending.get(seq)
    if (!p) {
      return
    }
    this.probePending.delete(seq)
    this.recordProbe(p.target, Date.now() - p.ts)
  }

  recordProbe (target, rtt) {
    const prev = this.probeSamples.get(target) || []
    const next = prev.slice(-(PROBE_WINDOW - 1)).concat([{ rtt }])
    this.probeSamples.set(target, next)
    this.pushState()
  }

  clearLinkStats () {
    this.probePending.clear()
    this.probeSamples.clear()
    this.speedResults.clear()
  }

  /* ------------------------------------------------------ speed testing */

  /**
   * Next frame a speed phase is waiting for.
   *
   * `Connection.deliver()` hands a frame to a `waitFor` predicate, and only
   * falls through to the `message` listener when no predicate matches. The
   * predicates are re-registered from a microtask, so a frame that completes
   * in the same synchronous `onData` pass as the one before it finds no
   * waiter — exactly what happens once a fast sender has some slack in the
   * socket buffer: the final `speed-data` (65560B on the wire) and the tiny
   * `speed-done` that follows it are finished by one 64KB read, and the
   * closer would be dropped, leaving the loop to burn its full 14s timeout.
   * Anything parked by `dispatchDataMessage` is therefore consumed first.
   */
  nextSpeedFrame (conn, predicate, timeout, label) {
    const ctx = conn.ctx || {}
    const inbox = ctx.speedInbox
    if (inbox && inbox.length) {
      const idx = inbox.findIndex(({ header, body }) => {
        try {
          return predicate(header, body)
        } catch (err) {
          return false
        }
      })
      if (idx >= 0) {
        return Promise.resolve(inbox.splice(idx, 1)[0])
      }
    }
    return conn.waitFor(predicate, timeout, label)
  }

  /** Measure throughput with `target` over a pooled data connection — the
   *  same direct path VIP forwarding rides. Phases are time-boxed so a slow
   *  link still finishes within ~16s. */
  async speedTest (targetFp) {
    if (!this.inGroup || this.status !== P2P_STATUS.JOINED) {
      throw new Error('未加入群组')
    }
    if (!targetFp || targetFp === this.identity.fingerprint) {
      throw new Error('不能与自己测速')
    }
    if (this.speedActive) {
      throw new Error('已有测速正在进行')
    }
    this.speedActive = true
    let conn = null
    try {
      conn = await this.acquireDataConn(targetFp)
      const ctx = conn.ctx || { fp: targetFp }
      conn.ctx = ctx
      ctx.speeding = true
      ctx.speedInbox = []
      logger.info(`[Super Cat] speed-test start target=${targetFp} via ${conn.socket.remoteAddress}:${conn.socket.remotePort} kind=${ctx.kind || 'none'}`)

      // downlink: peer floods fixed-size frames until quota or time-box
      const t0 = Date.now()
      conn.send({ t: 'speed-req', bytes: SPEED_TOTAL })
      let downBytes = 0
      let gotFirst = false
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const msg = await this.nextSpeedFrame(
          conn,
          (h) => h.t === 'speed-data' || h.t === 'speed-done' || h.t === 'speed-error',
          SPEED_STEP_TIMEOUT,
          'speed'
        )
        if (!gotFirst) {
          gotFirst = true
          logger.info(`[Super Cat] speed recv first frame t=${msg.header.t} body=${msg.body ? msg.body.length : 0}`)
        }
        if (msg.header.t === 'speed-data') {
          downBytes += msg.body ? msg.body.length : 0
        } else if (msg.header.t === 'speed-error') {
          throw new Error(msg.header.reason || '对方拒绝测速')
        } else {
          logger.info(`[Super Cat] speed down complete bytes=${downBytes}`)
          break
        }
      }
      const downMs = Math.max(1, Date.now() - t0)

      // uplink: flood until quota or time-box, peer acks with real timing
      ctx.speedInbox = []
      const chunk = Buffer.alloc(SPEED_CHUNK)
      let sent = 0
      while (sent < SPEED_TOTAL && Date.now() - t0 < SPEED_PHASE_MS * 2) {
        const n = Math.min(SPEED_CHUNK, SPEED_TOTAL - sent)
        if (!conn.send({ t: 'speed-up' }, chunk.subarray(0, n))) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => conn.socket.once('drain', resolve))
        }
        sent += n
      }
      conn.send({ t: 'speed-up-done' })
      const res = await this.nextSpeedFrame(
        conn,
        (h) => h.t === 'speed-result' || h.t === 'speed-error',
        SPEED_STEP_TIMEOUT,
        'speed-result'
      )
      if (res.header.t === 'speed-error') {
        throw new Error(res.header.reason || '测速失败')
      }
      const upMs = Math.max(1, Number(res.header.ms) || 1)
      const upBytes = Number(res.header.bytes) || sent
      const result = {
        down: +(downBytes * 8 / downMs / 1000).toFixed(1),
        up: +(upBytes * 8 / upMs / 1000).toFixed(1),
        ts: Date.now()
      }
      this.speedResults.set(targetFp, result)
      this.pushState()
      return result
    } finally {
      if (conn) {
        if (conn.ctx) {
          conn.ctx.speeding = false
        }
        try {
          conn.close()
        } catch (err) {
          /* already gone */
        }
      }
      this.speedActive = false
    }
  }

  /** Passive side of a speed test: flood downlink, then account uplink. */
  async serveSpeed (conn, header) {
    const ctx = conn.ctx || {}
    conn.ctx = ctx
    ctx.speeding = 'down'
    logger.info(`[Super Cat] serve-speed begin bytes=${header.bytes} from=${conn.socket.remoteAddress}:${conn.socket.remotePort}`)
    try {
      const quota = Math.min(Number(header.bytes) || SPEED_TOTAL, SPEED_TOTAL)
      const chunk = Buffer.alloc(SPEED_CHUNK)
      const t0 = Date.now()
      let sent = 0
      while (sent < quota && Date.now() - t0 < SPEED_PHASE_MS) {
        const n = Math.min(SPEED_CHUNK, quota - sent)
        if (!conn.send({ t: 'speed-data' }, chunk.subarray(0, n))) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => conn.socket.once('drain', resolve))
        }
        sent += n
      }
      const doneOk = conn.send({ t: 'speed-done', bytes: sent })
      logger.info(`[Super Cat] serve-speed down done sent=${sent} writeOk=${doneOk}`)
      // redundant done frames: the first one ending the peer's loop is
      // required, copies are harmless (peer has already left its waiter)
      for (let i = 0; i < 3; i++) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(300)
        if (conn.closed) {
          break
        }
        conn.send({ t: 'speed-done', bytes: sent })
      }

      ctx.speeding = 'up'
      ctx.speedUpState = null
      const finish = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), SPEED_STEP_TIMEOUT)
        const onClose = () => resolve(null)
        conn.once('close', onClose)
        ctx.speedUpResolve = (value) => {
          clearTimeout(timer)
          conn.removeListener('close', onClose)
          resolve(value)
        }
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
      })
      if (finish) {
        conn.send({ t: 'speed-result', ms: finish.ms, bytes: finish.bytes })
      }
    } catch (err) {
      logger.info(`[Super Cat] serve-speed error: ${err.message}`)
      if (!conn.closed) {
        conn.send({ t: 'speed-error', reason: err.message })
      }
    } finally {
      ctx.speeding = false
      ctx.speedUpResolve = null
      ctx.speedUpState = null
    }
  }

  /** Frames arriving while a speed test owns the connection (server side). */
  handleSpeedServerFrame (conn, header, body) {
    const ctx = conn.ctx || {}
    if (ctx.speeding !== 'up') {
      return
    }
    if (header.t === 'speed-up') {
      if (!ctx.speedUpState) {
        ctx.speedUpState = { t0: Date.now(), bytes: 0 }
      }
      ctx.speedUpState.bytes += body ? body.length : 0
    } else if (header.t === 'speed-up-done') {
      const st = ctx.speedUpState || { t0: Date.now(), bytes: 0 }
      st.ms = Math.max(1, Date.now() - st.t0)
      ctx.speeding = false
      if (ctx.speedUpResolve) {
        ctx.speedUpResolve(st)
      }
    } else if (header.t === 'speed-cancel') {
      ctx.speeding = false
      if (ctx.speedUpResolve) {
        ctx.speedUpResolve(null)
      }
    }
  }

  setMemberOnline (fp, online) {
    let changed = false
    this.members = this.members.map((m) => {
      if (m.fp !== fp || m.online === online) {
        return m
      }
      changed = true
      return { ...m, online, lastSeen: Date.now() }
    })
    if (changed) {
      this.cfg.set('members', this.members)
      this.broadcastToMembers({ t: 'member-status', fp, online }, fp)
      this.pushState()
    }
  }

  removeMember (fp, reason) {
    const member = this.members.find((m) => m.fp === fp)
    if (!member || member.isSelf) {
      return
    }
    this.members = this.members.filter((m) => m.fp !== fp)
    this.cfg.set('members', this.members)
    const entry = this.controls.get(fp)
    if (entry) {
      entry.conn.close()
    }
    this.broadcastToMembers({ t: 'member-update', op: 'remove', member: { fp } }, fp)
    logger.info(`[Super Cat] member ${fp} removed: ${reason}`)
    this.pushState()
  }

  /* ------------------------------------------------------- reachability */

  async reachabilityTick () {
    if (!this.isOwner) {
      return
    }
    for (const member of this.members.filter((m) => !m.isSelf && m.h)) {
      if (this.stopping) {
        return
      }
      // eslint-disable-next-line no-await-in-loop
      const reachable = await tcpProbe(member.h, member.p, 3000)
      if (member.reachable !== reachable) {
        this.members = this.members.map((m) => (
          m.fp === member.fp ? { ...m, reachable } : m
        ))
        this.cfg.set('members', this.members)
        this.pushState()
      }
    }
  }

  /* --------------------------------------------------------- task push */

  handleIncomingTaskPush (fromFp, header) {
    const fromMember = this.members.find((m) => m.fp === fromFp)
    const fromName = fromMember ? fromMember.name : fromFp
    const urls = Array.isArray(header.urls) ? header.urls.filter(Boolean) : []
    if (!urls.length) {
      return
    }
    const targets = header.target === 'all'
      ? this.members.filter((m) => !m.isSelf).map((m) => m.fp)
      : [header.target]

    targets.forEach((fp) => {
      if (fp === this.identity.fingerprint) {
        this.deliverTask({ from: fromName, urls, options: header.options })
        return
      }
      const entry = this.controls.get(fp)
      if (entry) {
        entry.conn.send({
          t: 'task-push',
          from: fromName,
          urls,
          options: header.options || {}
        })
      } else {
        const sender = this.controls.get(fromFp)
        const target = this.members.find((m) => m.fp === fp)
        if (sender) {
          sender.conn.send({
            t: 'task-push-error',
            reason: `${target ? target.name : fp} 不在线`
          })
        }
      }
    })
  }

  async deliverTask ({ from, urls, options = {} }) {
    if (!this.cfg.get('receive-task-push')) {
      return false
    }
    try {
      await this.engineClient.call('addUri', urls, options)
      this.emit('task-received', { from, count: urls.length })
      return true
    } catch (err) {
      logger.warn('[Super Cat] p2p deliver task failed:', err.message)
      return false
    }
  }

  async pushTask ({ target, urls, options = {} }) {
    const list = (Array.isArray(urls) ? urls : [urls])
      .map((u) => String(u || '').trim())
      .filter(Boolean)
    if (!list.length) {
      throw new Error('请填写下载链接')
    }
    if (!this.inGroup) {
      throw new Error('尚未加入群组')
    }
    const from = this.myName()
    const targets = target === 'all'
      ? this.members.filter((m) => !m.isSelf).map((m) => m.fp)
      : [target]

    if (this.isOwner) {
      const results = []
      for (const fp of targets) {
        if (fp === this.identity.fingerprint) {
          // eslint-disable-next-line no-await-in-loop
          await this.deliverTask({ from, urls: list, options })
          results.push({ fp, ok: true })
          continue
        }
        const entry = this.controls.get(fp)
        if (entry) {
          entry.conn.send({ t: 'task-push', from, urls: list, options })
          results.push({ fp, ok: true })
        } else {
          const m = this.members.find((x) => x.fp === fp)
          results.push({ fp, ok: false, reason: `${m ? m.name : fp} 不在线` })
        }
      }
      return { ok: true, results }
    }

    if (!this.ownerConn) {
      throw new Error('群主不在线')
    }
    this.ownerConn.conn.send({ t: 'task-push', target, urls: list, options })
    return { ok: true, results: [{ fp: target, ok: true, queued: true }] }
  }

  /* --------------------------------------------------------- data plane */

  async openMemberStreamByFp (fp, targetPort) {
    const member = this.members.find((m) => m.fp === fp)
    if (!member) {
      throw new Error('群内没有这个成员')
    }
    return this.openMemberStream(member, targetPort)
  }

  /**
   * Pool → direct dial (listen-port source first, the classic simultaneous-
   * open recipe) → hub-signaled punch. Returns a live stream for `port`.
   */
  async openMemberStream (member, targetPort) {
    const openPorts = member.openPorts || []
    if (!openPorts.includes(targetPort)) {
      throw new Error('对方未开放该端口')
    }
    if (member.fp === this.identity.fingerprint) {
      return netSocketAsStream(await tcpConnect('127.0.0.1', targetPort, 3000))
    }

    let lastErr = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const conn = await this.acquireDataConn(member.fp)
        // eslint-disable-next-line no-await-in-loop
        return await this.claimTcpStream(conn, targetPort)
      } catch (err) {
        lastErr = err
        if (err && err.rejected) {
          throw err
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(200)
      }
    }
    throw lastErr || new Error('连接失败')
  }

  /** Acquire a raw authenticated data connection to `fp` (pool → dial → punch). */
  async acquireDataConn (fp) {
    const member = this.members.find((m) => m.fp === fp)
    if (!member || member.fp === this.identity.fingerprint) {
      throw new Error('不能与自己建立数据连接')
    }
    const eps = this.memberCandidates(member)
    if (!eps.length) {
      throw new Error('对方地址不可达')
    }

    const pooled = this.dataPoolTake(fp)
    if (pooled) {
      return pooled
    }

    // fire the punch immediately — it races the direct dials below instead of
    // only starting after every candidate has timed out
    this.requestPunch(fp)

    let lastErr = null
    let poolFilled = false
    for (const ep of eps) {
      if (poolFilled) {
        break
      }
      const bind = this.bindOptionsFor(ep)
      const variants = bind ? [bind, null] : [null]
      for (const variant of variants) {
        if (this.dataPoolHas(fp)) {
          poolFilled = true
          break
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          const conn = await this.dialControl(ep, {
            gid: this.gid,
            mode: 'data',
            expectPub: member.pub,
            timeout: DIRECT_DIAL_TIMEOUT,
            localPort: variant ? variant.localPort : null,
            localAddress: variant ? variant.localAddress : null
          })
          logger.info(`[Super Cat] acquire data ${fp} via ${ep.h}:${ep.p} bind=${variant ? variant.localAddress + ':' + variant.localPort : 'any'}`)
          this.attachDataConn(fp, conn)
          return conn
        } catch (err) {
          lastErr = err
          logger.info(`[Super Cat] acquire dial ${ep.h}:${ep.p} bind=${variant ? variant.localAddress : 'any'} failed: ${err.message}`)
        }
      }
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      return await this.waitForPoolConn(fp, PUNCH_WAIT_TIMEOUT)
    } catch (err) {
      throw lastErr || err
    }
  }

  /** Claim a pooled/dialed conn for one TCP stream to `port` on the peer. */
  async claimTcpStream (conn, port) {
    if (!conn || conn.closed) {
      throw new Error('连接已断开')
    }
    if (conn.ctx && conn.ctx.kind) {
      throw new Error('连接已被占用')
    }
    const ctx = conn.ctx || {}
    ctx.kind = null
    ctx.claiming = true
    conn.ctx = ctx
    logger.info(`[Super Cat] claim dial port=${port}`)
    conn.send({ t: 'dial', port })
    let header
    try {
      const msg = await conn.waitFor((h) => h.t === 'dial-result', 8000, 'dial-result')
      header = msg.header
    } catch (err) {
      logger.info(`[Super Cat] claim dial port=${port} failed: ${err.message}`)
      ctx.claiming = false
      conn.close()
      throw err
    }
    ctx.claiming = false
    logger.info(`[Super Cat] claim dial port=${port} ok=${header.ok}`)
    if (!header.ok) {
      conn.close()
      const reason = header.reason || '对方拒绝连接'
      const rejected = new Error(reason)
      rejected.rejected = true
      throw rejected
    }
    return this.claimWrap(conn)
  }

  claimWrap (conn) {
    const stream = new EventEmitter()
    let closed = false
    const emitClose = () => {
      if (closed) {
        return
      }
      closed = true
      stream.emit('close')
    }
    stream.write = (buf) => {
      const ok = conn.send({ t: 'data' }, buf)
      if (!ok) {
        conn.socket.once('drain', () => stream.emit('drain'))
      }
      return ok
    }
    stream.end = () => {
      conn.send({ t: 'stream-end' })
      conn.close()
    }
    stream.destroy = () => conn.close()
    stream.pause = () => conn.socket.pause()
    stream.resume = () => conn.socket.resume()
    conn.ctx.kind = 'tcp'
    conn.ctx.claiming = false
    conn.ctx.onData = (b) => stream.emit('data', b)
    conn.ctx.onEnd = () => {
      emitClose()
      conn.close()
    }
    conn.ctx.onClose = emitClose
    return stream
  }

  /* ---- data connection pool ---- */

  attachDataConn (fp, conn) {
    if (conn.ctx) {
      return
    }
    conn.ctx = { kind: null, fp }
    logger.info(`[Super Cat] data-conn attach fp=${fp} via ${conn.socket.remoteAddress}:${conn.socket.remotePort}`)
    conn.on('message', (header, body) => this.dispatchDataMessage(conn, header, body))
    this.dataPoolAdd(fp, conn)
  }

  dataPoolAdd (fp, conn) {
    const now = Date.now()
    const list = (this.dataPool.get(fp) || [])
      .filter((e) => !e.conn.closed && now - e.ts < DATA_POOL_IDLE)
    while (list.length >= DATA_POOL_CAP) {
      const old = list.shift()
      old.conn.close()
    }
    list.push({ conn, ts: now })
    this.dataPool.set(fp, list)

    conn.on('close', () => {
      this.dataPoolRemove(fp, conn)
      const ctx = conn.ctx || {}
      if (ctx.idleTimer) {
        clearTimeout(ctx.idleTimer)
      }
      if (ctx.onClose) {
        ctx.onClose()
      }
    })

    const waiters = this.poolWaiters.get(fp)
    if (waiters && waiters.length) {
      const pending = waiters.splice(0, waiters.length)
      pending.forEach((w) => {
        clearTimeout(w.timer)
        w.resolve(conn)
      })
    }
  }

  dataPoolRemove (fp, conn) {
    const list = this.dataPool.get(fp)
    if (!list) {
      return
    }
    const next = list.filter((e) => e.conn !== conn)
    if (next.length) {
      this.dataPool.set(fp, next)
    } else {
      this.dataPool.delete(fp)
    }
  }

  dataPoolTake (fp) {
    const list = this.dataPool.get(fp)
    if (!list || !list.length) {
      return null
    }
    const now = Date.now()
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      if (e.conn.closed || now - e.ts >= DATA_POOL_IDLE) {
        // A conn left over from a peer that has since restarted still looks
        // open on this side (no FIN ever reached us) while the far end has no
        // such socket: every write vanishes and the caller burns its whole
        // timeout. The idle cap was only applied when adding to the pool, so
        // enforce it here, where conns are actually handed out.
        list.splice(i, 1)
        if (!e.conn.closed) {
          logger.info(`[Super Cat] data-pool retire stale conn fp=${fp} idle=${now - e.ts}ms`)
          e.conn.close()
        }
        continue
      }
      if (e.conn.ctx && !e.conn.ctx.kind && !e.conn.ctx.claiming && !e.conn.ctx.speeding) {
        list.splice(i, 1)
        return e.conn
      }
    }
    if (!list.length) {
      this.dataPool.delete(fp)
    }
    return null
  }

  dataPoolHas (fp) {
    const list = this.dataPool.get(fp)
    const now = Date.now()
    return !!(list && list.some((e) => !e.conn.closed && now - e.ts < DATA_POOL_IDLE))
  }

  waitForPoolConn (fp, timeout) {
    // punch may have finished while the direct dials were still burning —
    // claim a pool entry right away instead of waiting for a new arrival
    const existing = this.dataPoolTake(fp)
    if (existing) {
      return Promise.resolve(existing)
    }
    return new Promise((resolve, reject) => {
      const list = this.poolWaiters.get(fp) || []
      const waiter = { resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        const arr = this.poolWaiters.get(fp) || []
        const i = arr.indexOf(waiter)
        if (i >= 0) {
          arr.splice(i, 1)
        }
        reject(new Error('打洞未成功'))
      }, timeout)
      list.push(waiter)
      this.poolWaiters.set(fp, list)
    })
  }

  rejectPoolWaiters (fp, err) {
    const list = this.poolWaiters.get(fp)
    if (!list) {
      return
    }
    const pending = list.splice(0, list.length)
    pending.forEach((w) => {
      clearTimeout(w.timer)
      w.reject(err)
    })
  }

  /* ---- punch ---- */

  requestPunch (fp) {
    if (this.punching.has(fp)) {
      return
    }
    this.punching.add(fp)
    // safety: never leave the in-flight flag stuck if no signal comes back
    const guard = setTimeout(() => this.punching.delete(fp), 10000)
    if (typeof guard.unref === 'function') {
      guard.unref()
    }
    if (this.isOwner) {
      const m = this.members.find((x) => x.fp === fp)
      if (m) {
        // tell the member to burst toward us too (their L-bound dial is what
        // opens THEIR NAT for our return traffic), then burst ourselves
        const entry = this.controls.get(fp)
        if (entry) {
          entry.conn.send({ t: 'punch-signal', peer: this.selfPeerInfo() })
        }
        this.runPunchBurst({ fp, eps: this.memberCandidates(m) })
      } else {
        this.punching.delete(fp)
      }
      return
    }
    if (this.ownerConn) {
      this.ownerConn.conn.send({ t: 'punch-request', target: fp })
    } else {
      this.punching.delete(fp)
    }
  }

  async runPunchBurst (peer) {
    const fp = peer && peer.fp
    if (!fp || this.stopping || !this.inGroup || fp === this.identity.fingerprint) {
      return
    }
    try {
      if (this.dataPoolHas(fp)) {
        return
      }
      const eps = (peer.eps || []).filter((e) => e && e.h && e.p)
      if (!eps.length) {
        return
      }
      logger.info(`[Super Cat] punch burst -> ${fp} (${eps.length} eps)`)

      // phase 1: reuse our listen port as the dial source (classic simultaneous
      // open — both NATs must see the exact 4-tuple they filtered on)
      for (const ep of eps) {
        if (this.stopping || this.dataPoolHas(fp)) {
          break
        }
        const bind = this.bindOptionsFor(ep)
        if (!bind) {
          continue
        }
        // eslint-disable-next-line no-await-in-loop
        const ok = await this.punchDial(fp, ep, bind)
        if (ok) {
          break
        }
      }
      // phase 2: plain dial (enough for full-cone / directly reachable targets)
      for (const ep of eps) {
        if (this.stopping || this.dataPoolHas(fp)) {
          break
        }
        // eslint-disable-next-line no-await-in-loop
        const ok = await this.punchDial(fp, ep, null)
        if (ok) {
          break
        }
      }

      if (this.dataPoolHas(fp)) {
        this.punch = { last: 'ok', target: fp, ts: Date.now() }
      } else {
        this.punch = { last: 'fail', target: fp, ts: Date.now() }
        this.rejectPoolWaiters(fp, new Error('打洞失败，对方可能不可入站'))
      }
      this.pushState()
    } finally {
      this.punching.delete(fp)
    }
  }

  async punchDial (fp, ep, bind) {
    const member = this.members.find((m) => m.fp === fp)
    if (!member || !member.pub) {
      return false
    }
    try {
      const conn = await this.dialControl(ep, {
        gid: this.gid,
        mode: 'data',
        expectPub: member.pub,
        timeout: PUNCH_DIAL_TIMEOUT,
        localPort: bind ? bind.localPort : null,
        localAddress: bind ? bind.localAddress : null
      })
      this.attachDataConn(fp, conn)
      logger.info(`[Super Cat] punch dial ok ${ep.h}:${ep.p} bind=${bind ? bind.localAddress + ':' + bind.localPort : 'any'}`)
      return true
    } catch (err) {
      logger.info(`[Super Cat] punch dial ${ep.h}:${ep.p} bind=${bind ? bind.localAddress : 'any'} failed: ${err.message}`)
      return false
    }
  }

  /* ---- inbound data messages (single dispatcher per connection) ---- */

  dispatchDataMessage (conn, header, body) {
    const ctx = conn.ctx || {}
    if (ctx.speeding) {
      if (header.t === 'speed-req') {
        // a test is already running on this conn (possibly our own) — fail
        // the caller fast instead of letting it sit out the full timeout
        logger.info(`[Super Cat] speed-req busy (speeding=${ctx.speeding})`)
        conn.send({ t: 'speed-error', reason: '对方正在测速中' })
      }
      if (typeof ctx.speeding === 'string') {
        this.handleSpeedServerFrame(conn, header, body)
        return
      }
      // Initiator side: no waiter matched, which means this frame landed in
      // the microtask gap between one `waitFor` resolving and the next being
      // registered. Park it for the test loop (see `nextSpeedFrame`) instead
      // of dropping it — that gap is where `speed-done` used to disappear.
      if (SPEED_FRAME_TYPES.has(header.t)) {
        if (!ctx.speedInbox) {
          ctx.speedInbox = []
        }
        ctx.speedInbox.push({ header, body })
      }
      return
    }
    if (!ctx.kind && !ctx.claiming) {
      if (header.t === 'speed-req') {
        this.serveSpeed(conn, header)
        return
      }
      if (header.t === 'dial') {
        this.serveTcpDial(conn, header)
        return
      }
      if (header.t === 'udp-open') {
        this.serveUdpOpen(conn, header)
        return
      }
      return
    }
    if (header.t === 'speed-req') {
      logger.info(`[Super Cat] speed-req dropped: kind=${ctx.kind || 'none'} claiming=${!!ctx.claiming}`)
      conn.send({ t: 'speed-error', reason: `连接正忙（${ctx.kind || '占用'}）` })
    }
    if (ctx.kind === 'tcp') {
      if (header.t === 'data' && body) {
        if (ctx.local) {
          if (!ctx.local.write(body)) {
            conn.socket.pause()
            ctx.local.once('drain', () => conn.socket.resume())
          }
        } else if (ctx.onData) {
          ctx.onData(body)
        }
      } else if (header.t === 'stream-end') {
        if (ctx.local) {
          ctx.local.end()
        } else if (ctx.onEnd) {
          ctx.onEnd()
        }
      }
      return
    }
    if (ctx.kind === 'udp') {
      if (header.t === 'udp-data' && body) {
        this.touchUdpConn(conn)
        if (ctx.sock && ctx.udpPort) {
          ctx.sock.send(body, ctx.udpPort, '127.0.0.1')
        } else if (ctx.onData) {
          ctx.onData(body)
        }
      } else if (header.t === 'udp-ok' && ctx.onReady) {
        ctx.onReady()
      } else if (header.t === 'udp-error' && ctx.onError) {
        ctx.onError(new Error(header.reason || 'UDP 端口未开放'))
      } else if (header.t === 'udp-close') {
        conn.close()
      }
    }
  }

  async serveTcpDial (conn, header) {
    try {
      const port = Number(header.port)
      const openPorts = this.cfg.get('open-ports') || []
      if (!openPorts.includes(port)) {
        conn.send({ t: 'dial-result', ok: false, reason: '端口未开放' })
        return
      }
      const local = await tcpConnect('127.0.0.1', port, 3000)
      local.setNoDelay(true)
      conn.ctx.kind = 'tcp'
      conn.ctx.local = local
      conn.send({ t: 'dial-result', ok: true })
      logger.info(`[Super Cat] serve dial ok port=${port}`)

      local.on('data', (chunk) => {
        if (!conn.send({ t: 'data' }, chunk)) {
          local.pause()
        }
      })
      conn.socket.on('drain', () => local.resume())
      local.on('close', () => {
        conn.send({ t: 'stream-end' })
        conn.close()
      })
      local.on('error', () => {
        conn.send({ t: 'stream-end', reason: 'local error' })
        conn.close()
      })
    } catch (err) {
      logger.info('[Super Cat] serve dial failed:', err.message)
      conn.send({ t: 'dial-result', ok: false, reason: '本地服务未启动' })
    }
  }

  touchUdpConn (conn) {
    const ctx = conn.ctx || {}
    if (ctx.idleTimer) {
      clearTimeout(ctx.idleTimer)
    }
    ctx.idleTimer = setTimeout(() => conn.close(), UDP_IDLE_TIMEOUT)
    if (typeof ctx.idleTimer.unref === 'function') {
      ctx.idleTimer.unref()
    }
  }

  async serveUdpOpen (conn, header) {
    const port = Number(header.port)
    const openPorts = this.cfg.get('open-ports') || []
    if (!openPorts.includes(port)) {
      conn.send({ t: 'udp-error', reason: '端口未开放' })
      return
    }
    try {
      const sock = createDgram('udp4')
      sock.on('message', (msg) => {
        this.touchUdpConn(conn)
        conn.send({ t: 'udp-data' }, msg)
      })
      sock.on('error', () => conn.close())
      conn.ctx.kind = 'udp'
      conn.ctx.sock = sock
      conn.ctx.udpPort = port
      conn.ctx.onClose = () => {
        try {
          sock.close()
        } catch (err) { /* already closed */ }
      }
      conn.send({ t: 'udp-ok' })
      this.touchUdpConn(conn)
    } catch (err) {
      conn.send({ t: 'udp-error', reason: err.message })
    }
  }

  /* ---- outbound UDP sessions (ride a data connection) ---- */

  udpSessionOut (fp, port) {
    const key = `${fp}:${port}`
    const existing = this.udpSessions.get(key)
    if (existing && !existing.dead) {
      return existing
    }

    const session = {
      key,
      fp,
      port,
      dead: false,
      conn: null,
      ready: null,
      drain: Promise.resolve(),
      queue: [],
      onData: null,
      idleTimer: null,
      touch: null
    }
    session.touch = () => {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer)
      }
      session.idleTimer = setTimeout(() => session.close(), UDP_IDLE_TIMEOUT)
      if (typeof session.idleTimer.unref === 'function') {
        session.idleTimer.unref()
      }
    }

    session.close = () => {
      session.dead = true
      if (session.idleTimer) {
        clearTimeout(session.idleTimer)
      }
      this.udpSessions.delete(key)
      if (session.conn) {
        session.conn.close()
      }
    }

    session.ready = (async () => {
      const conn = await this.acquireDataConn(fp)
      const ctx = conn.ctx || {}
      let resolveReady = null
      let rejectReady = null
      const readyP = new Promise((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const timer = setTimeout(() => rejectReady(new Error('UDP 通道建立超时')), 5000)
      ctx.kind = 'udp'
      ctx.onData = (b) => {
        session.touch()
        if (session.onData) {
          session.onData(b)
        }
      }
      ctx.onReady = () => {
        clearTimeout(timer)
        resolveReady()
      }
      ctx.onError = (err) => {
        clearTimeout(timer)
        rejectReady(err)
      }
      conn.ctx = ctx
      conn.send({ t: 'udp-open', port })
      await readyP
      session.conn = conn
      session.touch()
      conn.on('close', () => {
        if (!session.dead) {
          session.dead = true
          this.udpSessions.delete(key)
        }
      })
      return conn
    })()
    session.ready.catch((err) => {
      session.dead = true
      this.udpSessions.delete(key)
      logger.info(`[Super Cat] udp session ${key} failed: ${err.message}`)
    })

    session.push = (bytes) => {
      if (session.dead) {
        return Promise.reject(new Error('UDP 会话已关闭'))
      }
      session.queue.push(bytes)
      session.drain = session.drain
        .then(async () => {
          if (session.dead) {
            throw new Error('UDP 会话已关闭')
          }
          const conn = await session.ready
          while (session.queue.length) {
            const b = session.queue.shift()
            conn.send({ t: 'udp-data' }, b)
          }
          session.touch()
        })
        .catch((err) => {
          session.dead = true
          this.udpSessions.delete(key)
          throw err
        })
      return session.drain
    }

    this.udpSessions.set(key, session)
    return session
  }

  /* -------------------------------------------------------- directory */

  publicMember (m) {
    return {
      fp: m.fp,
      name: m.name,
      pub: m.pub,
      h: m.h,
      p: m.p,
      vip: m.vip || null,
      observed: m.observed || null,
      openPorts: m.openPorts || [],
      online: !!m.online,
      reachable: m.reachable === undefined ? null : m.reachable
    }
  }

  /* ---- virtual loopback addresses (owner assigns, never reused) ---- */

  assignVip (fp) {
    if (!this.isOwner) {
      return this.vipOf(fp)
    }
    const map = { ...(this.cfg.get('vip-map') || {}) }
    if (map[fp]) {
      return map[fp]
    }
    const used = new Set(Object.values(map))
    for (let i = 2; i < 255; i++) {
      const vip = `${VIP_PREFIX}${i}`
      if (!used.has(vip)) {
        map[fp] = vip
        break
      }
    }
    this.cfg.set('vip-map', map)
    return map[fp] || null
  }

  vipOf (fp) {
    const map = this.cfg.get('vip-map') || {}
    if (map[fp]) {
      return map[fp]
    }
    const row = this.members.find((m) => m.fp === fp)
    return (row && row.vip) || null
  }

  /* ---- display names: assigned by the owner in join order, never reused ---- */

  nextMemberSeq () {
    const seq = Number(this.cfg.get('member-seq') || 0) + 1
    this.cfg.set('member-seq', seq)
    return seq
  }

  /**
   * 老版本的成员没有 seq（名字是自报的）。群主启动时按当前 members 顺序
   * 一次性补号并改名成 HL-n —— members 数组本身就是加入顺序，所以结果
   * 正好等于「按加入顺序分配」。已经补过的群直接跳过。
   */
  ensureMemberSeqs () {
    if (!this.isOwner) {
      return
    }
    const list = this.members
    if (!list.length || list.some((m) => m.seq)) {
      return
    }
    const next = list.map((m, index) => ({
      ...m,
      seq: index + 1,
      name: memberName(index + 1)
    }))
    this.members = next
    this.cfg.set('member-seq', Math.max(Number(this.cfg.get('member-seq') || 0), next.length))
    logger.info(`[Super Cat] p2p migrated member names to ${next.map((m) => m.name).join(', ')}`)
  }

  /** VipForwarder wants every OTHER member × their exposed ports. */
  forwardTargets () {
    if (!this.cfg.get('vip-forward') || !this.inGroup) {
      return []
    }
    const selfFp = this.identity ? this.identity.fingerprint : ''
    return this.members
      .filter((m) => m.fp !== selfFp && m.vip)
      .map((m) => ({ fp: m.fp, vip: m.vip, ports: (m.openPorts || []).slice() }))
  }

  sendDirectory (conn) {
    const ok = conn.send({
      t: 'directory',
      members: this.members.map((m) => this.publicMember(m))
    })
    logger.info(`[Super Cat] p2p sendDirectory members=${this.members.length} ok=${ok}`)
  }

  broadcastToMembers (msg, exceptFp = null) {
    this.controls.forEach((entry, fp) => {
      if (fp === exceptFp) {
        return
      }
      entry.conn.send(msg)
    })
  }

  /* --------------------------------------------------------- endpoint */

  async discoverEndpoint (force = false) {
    if (this.discoveryRunning && !force) {
      return this.endpoint
    }
    this.discoveryRunning = true
    try {
      const listenPort = this.cfg.get('listen-port')
      const ep = await this.endpointTool.discover({
        port: listenPort,
        manual: this.cfg.get('manual-endpoint'),
        allowUpnp: !!this.configManager.getUserConfig('enable-upnp')
      })
      const changed = !this.endpoint ||
        ep.h !== this.endpoint.h ||
        ep.p !== this.endpoint.p ||
        ep.mapped !== this.endpoint.mapped
      this.endpoint = ep
      this.cfg.set('last-endpoint', ep)
      if (changed && this.inGroup) {
        this.updateSelfMember()
        if (this.isOwner) {
          this.broadcastToMembers({
            t: 'code-rotated',
            sec: this.sec,
            ep: { h: ep.h, p: ep.p }
          })
        } else if (this.ownerConn) {
          this.ownerConn.conn.send({
            t: 'endpoint-update',
            h: ep.h,
            p: ep.p,
            openPorts: this.cfg.get('open-ports')
          })
        }
        this.pushState()
      }
      return ep
    } finally {
      this.discoveryRunning = false
    }
  }

  refreshEndpointBackground () {
    this.schedule(1500, () => this.discoverEndpoint(false))
  }

  updateSelfMember () {
    this.members = this.members.map((m) => (
      m.isSelf
        ? {
          ...m,
          // 名字是群主分的（HL-1 …），不能被本机值覆盖
          name: m.name || this.myName(),
          h: this.endpoint.h,
          p: this.cfg.get('listen-port'),
          openPorts: this.cfg.get('open-ports'),
          reachable: !!this.endpoint.mapped,
          online: true
        }
        : m
    ))
    this.cfg.set('members', this.members)
    if (!this.isOwner && this.ownerConn) {
      this.ownerConn.conn.send({
        t: 'endpoint-update',
        h: this.endpoint.h,
        p: this.endpoint.p,
        openPorts: this.cfg.get('open-ports')
      })
    } else if (this.isOwner) {
      this.broadcastToMembers({
        t: 'member-update',
        op: 'add',
        member: this.publicMember(this.members.find((m) => m.isSelf) || {})
      })
    }
  }

  selfMember () {
    // 只有群主建群时会构造自己这一行，此时 member-seq 已置 1
    const seq = Number(this.cfg.get('member-seq') || 0)
    return {
      fp: this.identity.fingerprint,
      seq: seq || null,
      name: seq ? memberName(seq) : this.selfName,
      pub: this.identity.pubB64,
      h: this.endpoint.h,
      p: this.cfg.get('listen-port'),
      vip: this.vipOf(this.identity.fingerprint),
      openPorts: this.cfg.get('open-ports'),
      online: true,
      reachable: !!this.endpoint.mapped,
      isSelf: true,
      lastSeen: Date.now()
    }
  }

  /* -------------------------------------------------------- settings */

  async updateSettings (patch = {}) {
    const prevOpenPorts = this.cfg.get('open-ports')
    let openPortsChanged = false

    if (Array.isArray(patch.openPorts)) {
      const clean = [...new Set(patch.openPorts.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536))]
      openPortsChanged = JSON.stringify(clean) !== JSON.stringify(prevOpenPorts)
      this.cfg.set('open-ports', clean)
    }
    if (typeof patch.receiveTaskPush === 'boolean') {
      this.cfg.set('receive-task-push', patch.receiveTaskPush)
    }
    if (typeof patch.vipForward === 'boolean') {
      this.cfg.set('vip-forward', patch.vipForward)
      this.vipForwarder.reconcile()
    }
    if (patch.manualEndpoint !== undefined) {
      this.cfg.set('manual-endpoint', patch.manualEndpoint && patch.manualEndpoint.h
        ? { h: patch.manualEndpoint.h }
        : null)
      await this.discoverEndpoint(true)
    }
    if (openPortsChanged) {
      this.updateSelfMember()
    }

    this.pushState()
    return this.getState()
  }

  /* ---------------------------------------------------------- state */

  getState () {
    const ownerPub = this.cfg.get('owner-pub')
    const selfFp = this.identity ? this.identity.fingerprint : ''
    const members = this.members.map((m) => ({
      fp: m.fp,
      name: m.name,
      online: m.fp === selfFp ? true : (ownerPub && m.pub === ownerPub && !this.isOwner ? !!this.ownerConn : !!m.online),
      reachable: m.reachable === undefined ? null : m.reachable,
      h: m.h,
      p: m.p,
      vip: m.vip || null,
      openPorts: m.openPorts || [],
      isSelf: m.fp === selfFp,
      isOwnerRow: this.isOwner ? m.fp === selfFp : m.pub === ownerPub
    }))
    return {
      status: this.status,
      role: this.role || '',
      enabled: !!this.cfg.get('enabled'),
      self: {
        fp: selfFp,
        name: this.myName(),
        vip: this.vipOf(selfFp)
      },
      group: {
        gid: this.gid || null,
        name: this.cfg.get('group-name') || '',
        code: this.isOwner ? this.currentCode() : null,
        codeText: this.isOwner ? formatCode(this.currentCode()) : null
      },
      endpoint: {
        h: this.endpoint.h,
        p: this.endpoint.p,
        source: this.endpoint.source,
        mapped: !!this.endpoint.mapped,
        lanOnly: !!this.endpoint.lanOnly,
        warning: this.endpoint.warning || null,
        listenPort: this.cfg.get('listen-port')
      },
      members,
      pending: this.pending.map((p) => ({
        fp: p.fp,
        name: p.name,
        since: p.since
      })),
      links: this.linksSnapshot(),
      speed: Object.fromEntries(this.speedResults),
      punch: { ...this.punch },
      forward: {
        enabled: !!this.cfg.get('vip-forward'),
        listeners: this.vipForwarder.count(),
        conflicts: this.vipForwarder.conflicts()
      },
      settings: {
        openPorts: this.cfg.get('open-ports') || [],
        receiveTaskPush: !!this.cfg.get('receive-task-push'),
        vipForward: !!this.cfg.get('vip-forward'),
        manualEndpoint: this.cfg.get('manual-endpoint') || null
      },
      lastError: this.lastError
    }
  }

  linksSnapshot () {
    const out = {}
    this.probeSamples.forEach((arr, fp) => {
      const rtts = arr.filter((s) => s.rtt !== null).map((s) => s.rtt)
      const lost = arr.length - rtts.length
      out[fp] = {
        rtt: rtts.length
          ? Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length)
          : null,
        loss: arr.length ? Math.round(lost / arr.length * 100) : 0,
        samples: arr.length
      }
    })
    return out
  }

  pushState () {
    if (this.statePushTimer) {
      return
    }
    this.statePushTimer = setTimeout(() => {
      this.statePushTimer = null
      const state = this.getState()
      this.lastState = state
      this.emit('state-change', state)
      // membership/openPorts drive the vip listeners; reconcile here so every
      // directory change converges without a dedicated event plumbing
      this.vipForwarder.reconcile()
    }, STATE_PUSH_DEBOUNCE)
  }

  resetError () {
    if (this.status === P2P_STATUS.REJECTED || this.status === P2P_STATUS.KICKED || this.status === P2P_STATUS.ERROR) {
      this.status = this.inGroup ? P2P_STATUS.JOINED : P2P_STATUS.IDLE
      this.lastError = null
      this.pushState()
    }
    return this.getState()
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** ::ffff:1.2.3.4 → 1.2.3.4, strip zone ids. */
function normalizeAddr (addr) {
  if (!addr) {
    return null
  }
  let out = String(addr)
  const zone = out.indexOf('%')
  if (zone > 0) {
    out = out.slice(0, zone)
  }
  if (out.startsWith('::ffff:')) {
    out = out.slice(7)
  }
  return out || null
}

function tcpConnect (host, port, timeout, localPort = null, localAddress = null) {
  return new Promise((resolve, reject) => {
    const options = { host, port }
    if (localPort) {
      options.localPort = localPort
    }
    if (localAddress) {
      options.localAddress = localAddress
    }
    const socket = netConnect(options)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`连接 ${host}:${port} 超时`))
    }, timeout)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function isLoopbackHost (h) {
  return h === '::1' || h === '127.0.0.1' || String(h).startsWith('127.')
}

function tcpProbe (host, port, timeout) {
  return tcpConnect(host, port, timeout)
    .then((socket) => {
      socket.destroy()
      return true
    })
    .catch(() => false)
}

function netSocketAsStream (socket) {
  const stream = new EventEmitter()
  stream.write = (buf) => {
    const ok = socket.write(buf)
    if (!ok) {
      socket.once('drain', () => stream.emit('drain'))
    }
    return ok
  }
  stream.end = () => socket.end()
  stream.destroy = () => socket.destroy()
  stream.pause = () => socket.pause()
  stream.resume = () => socket.resume()
  socket.on('data', (chunk) => stream.emit('data', chunk))
  socket.on('close', () => stream.emit('close'))
  socket.on('error', () => stream.emit('close'))
  return stream
}
