import { EventEmitter } from 'events'
import { connect as netConnect, createServer } from 'net'
import { createSocket as createDgram } from 'dgram'
import { createHash, randomBytes } from 'crypto'
import { promises as fsp } from 'fs'
import { basename, join } from 'path'
import { homedir, hostname, networkInterfaces } from 'os'

import logger from '../Logger'
import Connection, { clientHandshake, serverHandshake } from './Connection'
import Identity from './Identity'
import InviteCode, { formatCode, generateGroupId, sanitizeCode } from './InviteCode'
import Endpoint from './Endpoint'
import VipForwarder from './VipForwarder'
import { seal, unseal } from './Sealed'
import {
  SendSession,
  ReceiveSession,
  isFileFrame,
  isOurPartName,
  sanitizeFileName,
  OFFER_TTL
} from './FileTransfer'
import {
  ENGINE_RPC_PORT,
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
// Inbound hardening: the listener is on 0.0.0.0 and a pre-auth connection is
// cheap to open, so cap both the total and the per-address count.
const INBOUND_MAX = 64
const INBOUND_MAX_PER_IP = 24
// Parked join requests: each holds a live socket, so both the number and the
// time one may sit unanswered are bounded (the joiner waits 180s in total).
const PENDING_MAX = 8
const PENDING_TTL = 120000
// Abuse guards for hub-relayed work: a member may push tasks and ask for speed
// tests, neither of which should be freely repeatable.
const PUSH_TOKENS = 10
const PUSH_REFILL_MS = 60000
const PUSH_URLS_MAX = 32
const SPEED_ASK_TTL = 30000
const SPEED_ASK_COOLDOWN = 15000
// A peer's self-reported address is where dials come from, so both how often it
// may change and how many dial rounds we spend on one member are bounded — the
// hub used to dial whatever a member asked for, on demand.
const ENDPOINT_UPDATE_MAX = 3
const ENDPOINT_UPDATE_WINDOW = 5 * 60 * 1000
const DIAL_ROUNDS_PER_WINDOW = 20
const DIAL_BUDGET_WINDOW = 60000
// How long a freshly minted invite code stays usable. The code embeds the group
// secret and the owner's public address, so it should not be valid forever.
const INVITE_TTL_DAYS = 30

// Probe (RTT / loss between members; owner legs are direct, member-to-member
// legs relay through the owner and are labelled as such in the UI).
const PROBE_INTERVAL = 5000
const PROBE_WINDOW = 12
// Loss is swept only at the head of probeTick, so a probe cannot be judged
// before the next round: the effective threshold IS the send interval.
// Bound it explicitly — a literal below the interval changes nothing, one
// above it would starve the sweep and freeze the stats entirely.
const PROBE_LOSS_TIMEOUT = PROBE_INTERVAL

// Speed test over a pooled data connection (the same path VIP forwarding uses).
const SPEED_TOTAL = 24 * 1024 * 1024
const SPEED_CHUNK = 64 * 1024
const SPEED_PHASE_MS = 8000
const SPEED_STEP_TIMEOUT = 14000
// Frames the initiator still needs after the waiter that was expecting them has
// already resolved — they are parked on the connection instead of dropped.
const SPEED_FRAME_TYPES = new Set(['speed-data', 'speed-done', 'speed-error', 'speed-result'])

// aria2 options a remote member may attach to a pushed task. Where a download
// lands is the receiver's own business: `dir`/`out` (and every other unknown
// key) are dropped so a peer cannot write files into arbitrary paths. The
// Interconnect UI never sends options at all — this only hardens the inbound
// direction, so legitimate pushes keep working.
const PUSH_OPTION_ALLOWLIST = new Set([
  'split',
  'max-connection-per-server',
  'min-split-size',
  'file-allocation',
  'continue',
  'auto-save',
  'bt-max-peers',
  'seed-ratio',
  'seed-time'
])
const PUSH_OPTIONS_MAX = 16

// A member advertises which local ports peers may tunnel to; those listeners
// get bound on OUR machine, so the list is validated and capped (a peer could
// otherwise make us open thousands of VIP sockets).
const REMOTE_PORTS_MAX = 16
// Stale `.part` files (plus sidecars) are the only unbounded thing a peer can
// leave on our disk, so they age out; the totals below bound what may pile up.
const PART_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PARTS_QUOTA_BYTES = 20 * 1024 * 1024 * 1024
const DISK_RESERVE_BYTES = 256 * 1024 * 1024
const PARTS_SWEEP_INTERVAL = 10 * 60 * 1000
// Group size ceiling and the roster slice size (see sendDirectory).
const MAX_MEMBERS = 64
// Credit-window bridge for speed frames, and roster slice size (by encoded
// bytes: a row's size depends on the display name and port list, so counting
// rows is not a size bound).
const SPEED_INBOX_MAX = 64
const DIRECT_PROBE_TIMEOUT = 4000
// Last few transfer outcomes, kept for the UI: a finished transfer used to
// vanish from the card with no trace of whether it actually completed.
const RECENT_TRANSFERS_MAX = 5
const DIR_PART_BYTES = 24 * 1024
const NAME_MAX = 32
// Reachability sweeps run in slices: a tick checks at most this many members.
const REACH_BATCH = 32
// Same ceiling for the list we publish ourselves: keeps both the directory row
// and the number of listeners peers may ask us to open bounded.
const LOCAL_PORTS_MAX = 16

// Ban list handed to members with the directory. It only ever grows, so only
// the most recent entries travel (and the roster carries the rest on a resync).
const BANNED_MAX = 100

// Punch (classic TCP simultaneous-open; empirical limit on Windows: only one
// outbound socket may hold the listen port at a time → bursts are serial).
const PUNCH_DIAL_TIMEOUT = 1400
// Outer bound while following a burst to completion: a burst is serial, so its
// worst case is 2 phases × candidates × dial timeout. The old fixed 3.5s wait
// declared failure while the burst was still dialing, so a punch that actually
// worked was reported as broken.
const PUNCH_WAIT_MAX = 12000
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
    this.inboundByIp = new Map()
    // paths handed over by the native directory dialog this session
    this.pickedDirs = new Set()
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
    // every attached data conn; a stream takes its conn OUT of the pool, so the
    // pool alone cannot be used to tear live tunnels down (revokeFp/teardown)
    this.dataConns = new Set()
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

    // file transfer: one concurrent send + one concurrent receive,
    // plus unanswered offers awaiting the user's decision
    this.fileSend = null
    this.fileRecv = null
    this.fileOffers = new Map()
    this.recentTransfers = []
    // disk hygiene for resumable parts (cached: the offer path is synchronous)
    this.partsBytes = null
    this.partsFreeBytes = null
    this.partsSweepAt = 0
    // abuse guards
    this.pushBuckets = new Map()
    this.speedAsks = new Map()
    this.speedAskedAt = new Map()
    this.dirParts = new Map()
    this.probeRound = 0
    this.reachCursor = 0
    this.endpointUpdates = new Map()
    this.dialBudget = new Map()

    this.endpoint = this.cfg.get('last-endpoint') || { h: null, p: null, source: 'none', mapped: false }
    this.lastError = null
    // monotonic counter for state snapshots: the renderer drops anything older
    this.stateSeq = 0
    // memoised invite code (keyed by everything it is built from)
    this.codeCache = null
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
    this.migrateLegacyOpenPorts()
    this.ensureIdentity()
    this.ensureMemberSeqs()
    // age out stale resumable parts once per launch (and prime hasRoomFor)
    this.sweepParts(true).catch(() => {})
    if (this.cfg.get('enabled')) {
      this.start().catch((err) => {
        logger.warn('[Super Cat] p2p auto start failed:', err.message)
        this.lastError = { message: err.message }
        this.status = P2P_STATUS.ERROR
        this.pushState()
      })
    }
  }

  /**
   * Releases up to 1.0.6 defaulted `open-ports` to the aria2 RPC port, which
   * silently handed every group member password-free control of the download
   * engine. The default is now opt-in, so a stored value that still equals the
   * legacy default was never chosen deliberately by the user — drop it and let
   * the new default apply. Anyone who re-checks the box keeps it.
   */
  migrateLegacyOpenPorts () {
    if (!this.cfg.has || !this.cfg.has('open-ports')) {
      return
    }
    const stored = this.cfg.get('open-ports') || []
    const untouched = stored.length === 1 && Number(stored[0]) === ENGINE_RPC_PORT
    if (untouched) {
      this.cfg.delete('open-ports')
      logger.info('[Super Cat] p2p legacy aria2 port sharing reset (now opt-in)')
    }
  }

  ensureIdentity () {
    if (this.identity) {
      return this.identity
    }
    const saved = this.readIdentity()
    if (saved && saved.pub && saved.priv) {
      this.identity = new Identity(saved)
    } else {
      this.identity = Identity.generate()
      this.writeIdentity({ pub: this.identity.pubB64, priv: this.identity.privB64 })
    }
    return this.identity
  }

  /**
   * Sealed copy first; a plaintext one (pre-sealing install) is migrated as
   * soon as it can be verified. A blob this machine cannot open means the
   * profile travelled between OS users or machines — the old value is parked
   * under `identity-sealed-orphan` for manual recovery, and a fresh identity
   * takes over (the group sees a new device and the user re-joins).
   */
  readIdentity () {
    const blob = this.cfg.get('identity-sealed')
    if (blob) {
      const text = unseal(blob)
      if (text) {
        try {
          return JSON.parse(text)
        } catch (err) {
          logger.warn('[Super Cat] p2p sealed identity is corrupt')
          return null
        }
      }
      logger.warn('[Super Cat] p2p sealed identity cannot be opened on this machine')
      this.lastError = { message: '本机身份数据无法解密，已生成新身份，请重新入群' }
      this.cfg.set('identity-sealed-orphan', blob)
      this.cfg.set('identity-sealed', '')
      return null
    }
    const plain = this.cfg.get('identity')
    if (plain && plain.pub && plain.priv) {
      this.writeIdentity(plain)
    }
    return plain || null
  }

  /** Seal the identity; fall back to plaintext when that cannot be verified. */
  writeIdentity (value) {
    const text = JSON.stringify(value)
    const blob = seal(text)
    if (!blob || unseal(blob) !== text) {
      this.cfg.set('identity', value)
      this.cfg.set('identity-sealed', '')
      return false
    }
    this.cfg.set('identity-sealed', blob)
    this.cfg.set('identity', null)
    return true
  }

  /**
   * Adopt a (possibly reassembled) roster. `rev` is a content signature: an
   * identical payload is skipped, anything else replaces the roster wholesale —
   * the only path that repairs a member whose view drifted while it was offline.
   */
  applyDirectory (header) {
    if (header.rev && header.rev === this.cfg.get('dir-rev')) {
      return
    }
    this.members = (header.members || []).map((m) => this.sanitizeMemberRow(m))
    this.cfg.set('members', this.members)
    if (header.rev) {
      this.cfg.set('dir-rev', header.rev)
    }
    if (typeof header.name === 'string' && header.name) {
      this.cfg.set('group-name', header.name)
    }
    this.applyBanned(header.banned)
    this.pushState()
  }

  /** Same contract as the identity, for plain string secrets (the group sec). */
  readSecret (plainKey, sealedKey) {
    const blob = this.cfg.get(sealedKey)
    if (blob) {
      const text = unseal(blob)
      if (text !== null) {
        return text
      }
      logger.warn(`[Super Cat] p2p ${sealedKey} cannot be opened on this machine`)
      this.cfg.set(sealedKey, '')
      return ''
    }
    const plain = this.cfg.get(plainKey)
    if (typeof plain === 'string' && plain) {
      this.writeSecret(plainKey, sealedKey, plain)
      return plain
    }
    return typeof plain === 'string' ? plain : ''
  }

  writeSecret (plainKey, sealedKey, value) {
    const text = String(value || '')
    const blob = text ? seal(text) : null
    if (!blob || unseal(blob) !== text) {
      this.cfg.set(plainKey, text)
      this.cfg.set(sealedKey, '')
      return false
    }
    this.cfg.set(sealedKey, blob)
    this.cfg.set(plainKey, '')
    return true
  }

  get role () {
    return this.cfg.get('role')
  }

  get gid () {
    return this.cfg.get('gid')
  }

  get sec () {
    return this.readSecret('sec', 'sec-sealed')
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
    // the roster comes back on the next launch, but its links are new: do not
    // carry the previous session's RTT/loss/speed samples into it
    this.clearLinkStats()
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
    // pending approvals each hold a live socket — dropping the array alone
    // left them dangling until the requester's own 180s timeout
    this.pending.forEach((p) => {
      try {
        p.conn.close()
      } catch (err) {
        /* already gone */
      }
    })
    this.pending = []
  }

  teardownDataPlane () {
    // Every attached conn, not just the pooled ones: a stream holds its conn
    // outside the pool (dataPoolTake removes it), so sweeping the pool alone
    // left live tunnels running after a leave/quit.
    this.dataConns.forEach((conn) => conn.close())
    this.dataConns.clear()
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
    // file transfers: abort sessions (their conns die with the pool above)
    // and drop unanswered offers so no dialog can answer into a dead group
    this.fileOffers.forEach((o) => {
      clearTimeout(o.timer)
      try {
        o.conn.close()
      } catch (err) { /* already gone */ }
    })
    this.fileOffers.clear()
    this.speedAsks.forEach((ask) => clearTimeout(ask.timer))
    this.speedAsks.clear()
    if (this.fileSend) {
      this.fileSend.abort('conn-lost')
      this.fileSend = null
    }
    if (this.fileRecv) {
      this.fileRecv.abort('conn-lost')
      this.fileRecv = null
    }
  }

  /**
   * Drop everything data-plane for `fp`: pooled AND in-use connections, UDP
   * sessions, parked file offers, plus its link samples. Control links are the
   * caller's business (kick/leave close those separately).
   */
  revokeFp (fp, reason = '成员已离开') {
    this.rejectPoolWaiters(fp, new Error(reason))
    for (const conn of [...this.dataConns]) {
      const ctx = conn.ctx || {}
      if (ctx.fp === fp) {
        conn.close()
      }
    }
    for (const session of [...this.udpSessions.values()]) {
      if (session.fp === fp) {
        session.close()
      }
    }
    for (const [tid, offer] of [...this.fileOffers]) {
      if (offer.fp === fp) {
        this.fileOffers.delete(tid)
        clearTimeout(offer.timer)
        try {
          offer.conn.close()
        } catch (err) { /* already gone */ }
      }
    }
    this.dropLinkStats(fp)
    this.punching.delete(fp)
    // release the virtual address so it can be handed to the next member
    if (this.isOwner) {
      const map = { ...(this.cfg.get('vip-map') || {}) }
      if (map[fp]) {
        delete map[fp]
        this.cfg.set('vip-map', map)
      }
    }
    logger.info(`[Super Cat] data plane revoked for ${fp} (${reason})`)
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
    if (this.server) {
      return
    }
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
      server.maxConnections = INBOUND_MAX
      server.listen(port, '0.0.0.0')
    })
  }

  schedule (delay, fn, repeat = false) {
    let current = null
    const tick = async () => {
      if (current) {
        // this handle already fired; drop it so the Set does not grow
        this.timers.delete(current)
        current = null
      }
      if (this.stopping) {
        return
      }
      try {
        await fn()
      } catch (err) {
        logger.warn('[Super Cat] p2p scheduled task failed:', err.message)
      }
      if (repeat && !this.stopping) {
        current = setTimeout(tick, delay)
        this.timers.add(current)
      }
    }
    current = setTimeout(tick, delay)
    this.timers.add(current)
    return current
  }

  clearTimers () {
    this.timers.forEach((t) => clearTimeout(t))
    this.timers.clear()
    this.statePushTimer = null
  }

  /* ------------------------------------------------------------ group flows */

  async createGroup () {
    if (this.inGroup) {
      throw p2pError('already-in-group', '已经在一个群组中，请先退出')
    }
    this.stopping = false
    this.vipForwarder.resume()
    this.ensureIdentity()

    this.cfg.set('role', P2P_ROLE.OWNER)
    this.cfg.set('gid', generateGroupId())
    this.writeSecret('sec', 'sec-sealed', Identity.randomSecret())
    this.cfg.set('code-iat', Math.floor(Date.now() / 1000))
    this.cfg.set('group-name', 'Super Cat 互联')
    this.cfg.set('members', [])
    this.cfg.set('banned', [])
    this.cfg.set('dir-rev', '')
    this.cfg.set('vip-map', {})
    // 群主是第一个入群的，编号从 HL-1 起
    this.cfg.set('member-seq', 1)
    this.assignVip(this.identity.fingerprint)
    this.status = P2P_STATUS.STARTING
    this.pushState()

    try {
      if (!this.server) {
        await this.startServer()
      }
      await this.discoverEndpoint(true)
      if (!this.endpoint.h) {
        throw p2pError('no-endpoint', '无法获取本机网络地址（UPnP/STUN 均失败），无法生成邀请码')
      }
    } catch (err) {
      // leave no half-created group behind: clear the role we reserved and
      // surface the failure through the error bar (dismiss resets ERROR)
      this.cfg.set('role', '')
      this.cfg.set('gid', '')
      this.writeSecret('sec', 'sec-sealed', '')
      this.members = []
      this.status = P2P_STATUS.ERROR
      this.lastError = { message: err.message }
      this.pushState()
      throw err
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
    // The code's own issue time is pinned so every call renders the same code
    // (and the UI text does not churn while the user is reading it).
    let issuedAt = Number(this.cfg.get('code-iat'))
    if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
      issuedAt = Math.floor(Date.now() / 1000)
      this.cfg.set('code-iat', issuedAt)
    }
    // The code costs a deflate + an Ed25519 signature, and getState() runs on
    // every push (every 150ms while a transfer is live), so memoise it on
    // everything it is derived from.
    const cacheKey = `${this.gid}|${this.sec}|${eps.map((e) => `${e.h}:${e.p}`).join(',')}|${issuedAt}`
    if (this.codeCache && this.codeCache.key === cacheKey) {
      return this.codeCache.code
    }
    const code = InviteCode.encode({
      gid: this.gid,
      eps,
      sec: this.sec,
      iat: issuedAt,
      ttlDays: INVITE_TTL_DAYS
    }, this.identity)
    this.codeCache = { key: cacheKey, code }
    return code
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
      throw p2pError('already-in-group', '已经在一个群组中，请先退出')
    }
    this.stopping = false
    this.vipForwarder.resume()
    const invite = InviteCode.decode(sanitizeCode(code))
    this.ensureIdentity()

    this.status = P2P_STATUS.JOINING
    this.lastError = null
    this.pushState()

    let conn
    try {
      if (!this.server) {
        await this.startServer()
      }
      this.refreshEndpointBackground()

      // v2 codes carry every candidate endpoint; v1 falls back to eps[0].
      conn = await this.dialAnyControl(invite.eps, {
        gid: invite.gid,
        mode: 'join',
        expectPub: invite.pub,
        sec: invite.sec
      }, 2500)
    } catch (err) {
      // a bad/expired code or an offline owner used to leave status stuck
      // on 'joining' with no way back — record it like a rejection instead
      this.status = P2P_STATUS.ERROR
      this.lastError = { code: 'join-unreachable', message: err.message }
      this.pushState()
      throw err
    }

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
      this.lastError = {
        code: /timeout/i.test(err.message) ? 'approval-timeout' : 'approval-failed',
        message: err.message
      }
      this.pushState()
      throw err
    }

    logger.info(`[Super Cat] p2p join result: ${JSON.stringify(result)}`)
    if (!result.ok) {
      conn.close()
      this.status = P2P_STATUS.REJECTED
      this.lastError = {
        code: result.code === 'banned' ? 'banned' : 'rejected',
        message: result.reason || '群主拒绝了申请'
      }
      this.pushState()
      return { ok: false, reason: this.lastError.message, code: this.lastError.code }
    }

    // While approval was pending this node may have been created as an owner
    // (or joined elsewhere) — never clobber that with a late approval.
    if (this.inGroup) {
      conn.close()
      this.status = P2P_STATUS.ERROR
      this.lastError = { message: '已在群组中，无法同时采纳本次审批结果' }
      this.pushState()
      throw p2pError('already-in-group', '已经在一个群组中，请先退出')
    }

    // Adopt the group and keep this authenticated link as the control plane.
    this.cfg.set('role', P2P_ROLE.MEMBER)
    this.cfg.set('gid', invite.gid)
    this.writeSecret('sec', 'sec-sealed', invite.sec)
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
    // The farewell frame must reach the wire before the sockets die — and on
    // quit the whole process dies right after us. Register close promises up
    // front, let stop()'s graceful end() flush the writes, bound the wait so
    // a stuck link can never stall the quit path.
    const flushed = []
    if (this.isOwner) {
      // owner leaving dissolves the group for everyone
      this.broadcastToMembers({ t: 'group-dissolved' })
      this.controls.forEach((entry) => {
        if (!entry.conn.closed) {
          flushed.push(new Promise((resolve) => entry.conn.once('close', resolve)))
        }
      })
    } else if (this.ownerConn) {
      this.ownerConn.conn.send({ t: 'leave' })
      if (!this.ownerConn.conn.closed) {
        flushed.push(new Promise((resolve) => this.ownerConn.conn.once('close', resolve)))
      }
    }
    await this.stop()
    if (flushed.length) {
      await Promise.race([Promise.all(flushed), sleep(1000)])
    }
    this.cfg.set('role', '')
    this.cfg.set('gid', '')
    this.writeSecret('sec', 'sec-sealed', '')
    this.cfg.set('owner-pub', '')
    this.cfg.set('owner-ep', null)
    this.cfg.set('owner-eps', [])
    this.cfg.set('owner-observed', null)
    this.cfg.set('members', [])
    this.cfg.set('banned', [])
    this.cfg.set('dir-rev', '')
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
      throw p2pError('no-such-request', '待审批项不存在')
    }
    this.pending = this.pending.filter((p) => p.fp !== fp)
    clearTimeout(entry.timer)
    if (this.members.filter((m) => !m.isSelf).length >= MAX_MEMBERS) {
      throw p2pError('group-full', `群组人数已达上限（${MAX_MEMBERS}）`)
    }
    const seq = this.nextMemberSeq()
    const member = {
      fp: entry.fp,
      seq,
      name: memberName(seq),
      pub: entry.cpub,
      h: this.sanitizePeerHost(entry.endpoint ? entry.endpoint.h : null, entry.ip),
      p: entry.endpoint ? entry.endpoint.p : null,
      vip: this.assignVip(entry.fp),
      openPorts: cleanRemotePorts(entry.endpoint && entry.endpoint.openPorts),
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
      throw p2pError('no-such-request', '待审批项不存在')
    }
    this.pending = this.pending.filter((p) => p.fp !== fp)
    clearTimeout(entry.timer)
    entry.conn.send({ t: 'join-result', ok: false, reason: '群主拒绝了申请', code: 'rejected' })
    entry.conn.close()
    this.pushState()
    return { ok: true }
  }

  kickMember (fp) {
    if (!this.isOwner) {
      throw p2pError('owner-only', '只有群主可以移除成员')
    }
    const member = this.members.find((m) => m.fp === fp && m.fp !== this.identity.fingerprint)
    if (!member) {
      throw p2pError('no-such-member', '成员不存在')
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
    // Carry the ban to the remaining members and tear the data plane down.
    // Without the ban in the broadcast a kicked peer kept dialing everyone
    // else directly (members only ever trusted their own local list), and
    // without revoke its live tunnels/transfers survived the kick.
    this.broadcastToMembers({
      t: 'member-update',
      op: 'remove',
      member: { fp },
      banned: [...banned]
    }, fp)
    this.revokeFp(fp, '已被群主移除')
    this.pushState()
    return { ok: true }
  }

  async resetInviteCode () {
    if (!this.isOwner) {
      throw p2pError('owner-only', '只有群主可以重置邀请码')
    }
    this.writeSecret('sec', 'sec-sealed', Identity.randomSecret())
    this.cfg.set('code-iat', Math.floor(Date.now() / 1000))
    await this.discoverEndpoint(true)
    if (!this.endpoint.h) {
      throw p2pError('no-endpoint', '无法获取网络地址，邀请码未更新')
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
    const ip = normalizeAddr(socket.remoteAddress) || 'unknown'
    const open = this.inboundByIp.get(ip) || 0
    if (open >= INBOUND_MAX_PER_IP) {
      logger.warn(`[Super Cat] p2p inbound per-ip limit reached for ${ip} (${open}) — dropping`)
      socket.destroy()
      return
    }
    this.inboundByIp.set(ip, open + 1)
    socket.once('close', () => {
      const left = (this.inboundByIp.get(ip) || 1) - 1
      if (left > 0) {
        this.inboundByIp.set(ip, left)
      } else {
        this.inboundByIp.delete(ip)
      }
    })
    socket.setNoDelay(true)
    // long-lived tunnels/transfers must notice a peer that vanished silently
    socket.setKeepAlive(true, 15000)
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
        logger.warn('[Super Cat] p2p inbound handshake failed:', err.message)
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
        conn.send({ t: 'join-result', ok: false, reason: '无法加入该群组', code: 'banned' })
        conn.close()
        return
      }

      const existing = this.members.find((m) => m.fp === info.fp && m.pub === info.cpub)
      const stale = this.pending.find((p) => p.fp === info.fp)
      if (stale) {
        // a repeat request replaces the parked one — the old socket must go
        clearTimeout(stale.timer)
        try {
          stale.conn.close()
        } catch (err) { /* already gone */ }
      }
      if (!stale && this.pending.length >= PENDING_MAX) {
        conn.send({
          t: 'join-result',
          ok: false,
          reason: '群主当前无法处理更多申请',
          code: 'pending-full'
        })
        conn.close()
        return
      }
      if (this.members.filter((m) => !m.isSelf).length >= MAX_MEMBERS) {
        conn.send({ t: 'join-result', ok: false, reason: `群组已满（上限 ${MAX_MEMBERS} 人）`, code: 'group-full' })
        conn.close()
        return
      }
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
          name: this.sanitizeName(header.name) || info.fp,
          cpub: info.cpub,
          endpoint: header.endpoint || null,
          ip: normalizeAddr(conn.socket.remoteAddress),
          since: Date.now(),
          conn,
          timer: null
        }
      ]

      const entry = this.pending[this.pending.length - 1]
      entry.timer = setTimeout(() => {
        // Unanswered requests used to hold their socket until the requester
        // gave up; now the hub gives up first and says so.
        this.dropPending(conn, 'approval-timeout', '群主未及时处理，请重新申请')
      }, PENDING_TTL)
      conn.on('close', () => {
        this.dropPending(conn)
        this.pushState()
      })
      this.emit('notify', { type: 'info', key: 'join-request' })
      this.pushState()
    } catch (err) {
      logger.info('[Super Cat] join-request failed:', err.message)
      conn.close()
    }
  }

  /** Remove a parked join request (clearing its TTL timer) and answer it if asked. */
  dropPending (conn, code = null, reason = null) {
    const entry = this.pending.find((p) => p.conn === conn)
    if (!entry) {
      return null
    }
    this.pending = this.pending.filter((p) => p.conn !== conn)
    clearTimeout(entry.timer)
    if (code) {
      try {
        conn.send({ t: 'join-result', ok: false, reason, code })
      } catch (err) { /* already gone */ }
      conn.close()
    }
    return entry
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
        this.dropLinkStats(fp)
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
      if (!this.acceptEndpointUpdate(fp)) {
        logger.warn(`[Super Cat] p2p endpoint-update from ${fp} ignored (too frequent)`)
        break
      }
      const liveEntry = this.controls.get(fp)
      const observedHost = liveEntry ? normalizeAddr(liveEntry.conn.socket.remoteAddress) : null
      this.members = this.members.map((m) => (
        m.fp === fp
          ? {
            ...m,
            h: this.sanitizePeerHost(header.h, observedHost),
            p: header.p,
            openPorts: header.openPorts ? cleanRemotePorts(header.openPorts) : m.openPorts
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
    case 'directory-request': {
      // a member that just (re)connected asks for the roster; see
      // attachMemberControl. Old peers never send this and simply keep
      // relying on the broadcasts.
      const entry = this.controls.get(fp)
      if (entry) {
        this.sendDirectory(entry.conn)
      }
      break
    }
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
        const ownerFp = Identity.fingerprintOf(this.cfg.get('owner-pub'))
        if (ownerFp) {
          this.dropLinkStats(ownerFp)
        }
        // without this the owner row kept showing its pre-drop green RTT
        // until (and after) a reconnect flipped it straight back to online
        this.pushState()
        this.scheduleOwnerRetry()
      }
    })

    // Roster resync on every (re)connect: the hub answers with the current
    // directory, so a member that missed a broadcast while it was offline —
    // membership and bans included — converges instead of drifting forever.
    conn.send({ t: 'directory-request' })

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
      this.applyDirectory(header)
      break
    case 'directory-part': {
      // Rosters beyond the single-frame budget arrive sliced; assemble then
      // adopt through the same path as a whole one.
      const key = header.rev || 'norev'
      const acc = this.dirParts.get(key) || new Array(header.total)
      acc[header.index] = header.members || []
      this.dirParts.set(key, acc)
      if (acc.filter(Boolean).length === Number(header.total)) {
        this.dirParts.delete(key)
        this.applyDirectory({ ...header, members: [].concat(...acc) })
      }
      break
    }
    case 'member-update':
      if (header.op === 'add' && header.member) {
        this.members = [
          ...this.members.filter((m) => m.fp !== header.member.fp),
          this.sanitizeMemberRow(header.member)
        ]
      } else if (header.op === 'remove' && header.member) {
        this.members = this.members.filter((m) => m.fp !== header.member.fp)
        this.dropLinkStats(header.member.fp)
      }
      this.cfg.set('members', this.members)
      // a kick carries the updated ban list, so members enforce it immediately
      this.applyBanned(header.banned)
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
      this.bye(P2P_STATUS.KICKED, header.reason || '你已被群主移除', 'kicked')
      break
    case 'group-dissolved':
      this.bye(P2P_STATUS.DISSOLVED, '群主已解散群组', 'dissolved')
      break
    case 'code-rotated':
      this.writeSecret('sec', 'sec-sealed', header.sec)
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

  async bye (status, message, code = null) {
    // `code` is what the UI keys its outcome card on: "you were removed" and
    // "the group was dissolved" used to be the same state and read the same.
    this.lastError = { code, message }
    await this.stop()
    this.cfg.set('role', '')
    this.cfg.set('gid', '')
    this.writeSecret('sec', 'sec-sealed', '')
    this.cfg.set('owner-pub', '')
    this.cfg.set('owner-ep', null)
    this.cfg.set('owner-eps', [])
    this.cfg.set('owner-observed', null)
    this.cfg.set('members', [])
    this.cfg.set('vip-map', {})
    this.members = []
    this.status = status
    this.clearLinkStats()
    this.dirParts.clear()
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
      throw p2pError('peer-unreachable', '没有可用的连接地址')
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
    // Dial budget: past it we stop trusting self-reported addresses and only use
    // the one the peer's own traffic arrived from — a scanner needs targets it
    // chooses, and that address is not its choice.
    const budget = this.dialBudget.get(member.fp) || { ts: Date.now(), rounds: 0 }
    if (Date.now() - budget.ts > DIAL_BUDGET_WINDOW) {
      budget.ts = Date.now()
      budget.rounds = 0
    }
    budget.rounds += 1
    this.dialBudget.set(member.fp, budget)
    if (budget.rounds > DIAL_ROUNDS_PER_WINDOW && member.observed) {
      const obs = member.observed
      return list.filter((e) => e.h === obs.h && e.p === Number(obs.p))
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
      if (this.stopping) {
        // shutdown ran while we were dialling — do not resurrect a control
        conn.close()
        return
      }
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
      if (this.stopping || this.ownerConn) {
        // stopped meanwhile, or someone beat us to it (owner dialed in)
        conn.close()
        return
      }
      this.attachMemberControl(conn, { initiator: true, peerFp: Identity.fingerprintOf(ownerPub) })
    } catch (err) {
      logger.info(`[Super Cat] dial owner failed: ${err.message}`)
      // The hub refusing an established member means we are no longer in the
      // group: a kick whose frame never reached us (we were offline at the
      // time). Without this the node retried forever while still showing
      // itself as joined, and the hub could never tell it otherwise.
      if (err && err.code === 'not-member') {
        await this.bye(P2P_STATUS.KICKED, '你已被移出该群组', 'removed')
        return
      }
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
    this.probeRound = (this.probeRound || 0) + 1
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
      // Peer legs are probed directly (never relayed by the hub): no direct link this
      // round means "not measured", which is what the UI shows.
      this.members.forEach((m) => {
        // members persisted in cfg carry no `isSelf` — compare fingerprints
        if (this.probeRound % 6 === 0 &&
            m.fp !== this.identity.fingerprint && m.fp !== ownerFp && m.online) {
          this.sendDirectProbe(m.fp)
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

  /**
   * Peer-to-peer probe over a direct data link. The hub never sees these frames:
   * relaying them made the owner do ≈0.4·N² work at 100 members. No direct link
   * means this round is simply not measured (the UI shows "not measured" rather
   * than a number that cost the owner traffic).
   */
  sendDirectProbe (fp) {
    const conn = [...this.dataConns].find((c) => c.ctx && c.ctx.fp === fp && !c.closed)
    if (!conn) {
      return false
    }
    const ctx = conn.ctx
    if (ctx.probeSeq) {
      return false // one in flight per link is enough
    }
    const seq = ++this.probeSeq
    const ts = Date.now()
    ctx.probeSeq = seq
    if (!conn.send({ t: 'probe', seq, ts })) {
      ctx.probeSeq = null
      return false
    }
    const timer = setTimeout(() => {
      if (ctx.probeSeq === seq) {
        ctx.probeSeq = null
        this.recordProbe(fp, null)
      }
    }, DIRECT_PROBE_TIMEOUT)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    return true
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

  // A link that is gone must not keep its last-window RTT/loss alive in the
  // UI, and a re-join must not inherit the previous session's samples.
  dropLinkStats (fp) {
    this.probeSamples.delete(fp)
    for (const [seq, p] of this.probePending) {
      if (p.target === fp) {
        this.probePending.delete(seq)
      }
    }
    // speed results are per-link too — a removed member must not keep its
    // last measured throughput in the roster
    this.speedResults.delete(fp)
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
      throw p2pError('not-in-group', '未加入群组')
    }
    if (!targetFp || targetFp === this.identity.fingerprint) {
      throw p2pError('self-target', '不能与自己测速')
    }
    if (this.speedActive) {
      throw p2pError('speed-busy', '已有测速正在进行')
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
          // carry the peer's code through: the refusal text must be translatable
          throw p2pError(msg.header.code || 'speed-failed', msg.header.reason || '对方拒绝测速')
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
          await waitDrainOnce(conn.socket)
          if (conn.closed) {
            // a dead socket never emits 'drain' — leave via finally so
            // speedActive always resets
            throw p2pError('conn-lost', '测速连接已关闭')
          }
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
        throw p2pError(res.header.code || 'speed-failed', res.header.reason || '测速失败')
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

  /**
   * Inbound speed test request. A single `speed-req` frame used to make this
   * side flood 24 MiB at whoever asked, repeatable at will — now the user is
   * asked (native dialog) and one peer cannot re-ask within the cooldown.
   */
  askSpeedPermission (conn, header) {
    const ctx = conn.ctx || {}
    const fp = ctx.fp
    const now = Date.now()
    if (now - (this.speedAskedAt.get(fp) || 0) < SPEED_ASK_COOLDOWN) {
      conn.send({ t: 'speed-error', reason: '测速请求太频繁，请稍后再试', code: 'speed-rate-limited' })
      conn.close()
      return
    }
    this.speedAskedAt.set(fp, now)
    const member = this.members.find((m) => m.fp === fp)
    const ask = {
      fp,
      conn,
      header,
      from: member ? member.name : fp,
      bytes: Math.min(Number(header.bytes) || SPEED_TOTAL, SPEED_TOTAL),
      timer: null
    }
    ctx.claiming = true
    conn.ctx = ctx
    ask.timer = setTimeout(() => {
      this.respondSpeedRequest({ fp, accept: false, reason: 'timeout' })
    }, SPEED_ASK_TTL)
    this.speedAsks.set(fp, ask)
    this.emit('speed-request', { fp, from: ask.from, bytes: ask.bytes })
    this.pushState()
  }

  /** Renderer/main answer to a parked speed request: accept → serve, else refuse. */
  respondSpeedRequest (payload = {}) {
    const ask = this.speedAsks.get(payload.fp)
    if (!ask) {
      return null
    }
    this.speedAsks.delete(payload.fp)
    clearTimeout(ask.timer)
    if (payload.accept === true) {
      this.serveSpeed(ask.conn, ask.header)
      return { ok: true }
    }
    const timeout = payload.reason === 'timeout'
    ask.conn.send({
      t: 'speed-error',
      reason: timeout ? '对方未及时确认测速' : '对方拒绝了测速',
      code: timeout ? 'speed-timeout' : 'speed-refused'
    })
    ask.conn.close()
    this.pushState()
    return { ok: false }
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
          await waitDrainOnce(conn.socket)
          if (conn.closed) {
            break
          }
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
        conn.send({ t: 'speed-error', reason: err.message, code: 'speed-failed' })
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
    this.revokeFp(fp, reason)
    logger.info(`[Super Cat] member ${fp} removed: ${reason}`)
    this.pushState()
  }

  /* ------------------------------------------------------- reachability */

  async reachabilityTick () {
    if (!this.isOwner) {
      return
    }
    // Probe only what a probe can answer about: a peer must be online (an
    // offline probe proves nothing yet used to be reported as "无法入站"),
    // and a private h outside our own /24 is unreachable BY DEFINITION —
    // leave those at null ("入站未知") instead of burning a 3s timeout.
    const candidates = this.members.filter((m) =>
      !m.isSelf && m.h && m.online &&
      (!isPrivateAddr(m.h) || sameSubnet24(m.h, this.lanAddress))
    )
    // Rotate instead of sweeping: with a large group a full sweep of 3s probes
    // would outlast the 60s interval, so each tick takes a slice and continues
    // where the last one stopped.
    const slice = []
    for (let i = 0; i < candidates.length && slice.length < REACH_BATCH; i++) {
      const idx = (this.reachCursor + i) % candidates.length
      slice.push(candidates[idx])
    }
    this.reachCursor = candidates.length ? (this.reachCursor + slice.length) % candidates.length : 0
    const sliced = slice
    // small bounded concurrency: N black-holed hosts used to serialise 3s
    // each and stretch this tick far past its 60s interval
    const BATCH = 4
    for (let i = 0; i < sliced.length; i += BATCH) {
      const batch = sliced.slice(i, i + BATCH)
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(batch.map((m) => tcpProbe(m.h, m.p, 3000)))
      for (let j = 0; j < batch.length; j++) {
        if (this.stopping) {
          return
        }
        const member = batch[j]
        const reachable = results[j]
        if (member.reachable === reachable) {
          continue
        }
        this.members = this.members.map((m) => (
          m.fp === member.fp ? { ...m, reachable } : m
        ))
        this.pushState()
        const updated = this.members.find((m) => m.fp === member.fp)
        if (updated) {
          // mirror the verdict to the rest of the group — before this only
          // the owner ever saw a reachable value that was actually fresh
          this.broadcastToMembers(
            { t: 'member-update', op: 'add', member: this.publicMember(updated) },
            member.fp
          )
        }
      }
    }
  }

  /* --------------------------------------------------------- task push */

  /** Token bucket for hub-relayed pushes: 10 per minute per sender, refilled. */
  takePushToken (fp) {
    const now = Date.now()
    const bucket = this.pushBuckets.get(fp) || { tokens: PUSH_TOKENS, ts: now }
    const refill = Math.floor((now - bucket.ts) / PUSH_REFILL_MS)
    if (refill > 0) {
      bucket.tokens = Math.min(PUSH_TOKENS, bucket.tokens + refill)
      bucket.ts = now
    }
    if (bucket.tokens <= 0) {
      bucket.ts = bucket.ts || now
      this.pushBuckets.set(fp, bucket)
      return false
    }
    bucket.tokens -= 1
    this.pushBuckets.set(fp, bucket)
    return true
  }

  /** Answer the push sender on whatever link they reached us through. */
  replyPushError (fp, reason, code = null) {
    const msg = { t: 'task-push-error', reason, code }
    const entry = this.controls.get(fp)
    if (entry) {
      entry.conn.send(msg)
      return
    }
    const ownerFp = this.cfg.get('owner-pub') ? Identity.fingerprintOf(this.cfg.get('owner-pub')) : null
    if (ownerFp && fp === ownerFp && this.ownerConn) {
      this.ownerConn.conn.send(msg)
    }
  }

  handleIncomingTaskPush (fromFp, header) {
    const fromMember = this.members.find((m) => m.fp === fromFp)
    const fromName = fromMember ? fromMember.name : fromFp
    const urls = Array.isArray(header.urls) ? header.urls.filter(Boolean) : []
    if (!urls.length) {
      return
    }
    if (urls.length > PUSH_URLS_MAX) {
      this.replyPushError(fromFp, '一次推送的链接过多', 'push-too-many')
      return
    }
    if (!this.takePushToken(fromFp)) {
      this.replyPushError(fromFp, '推送太频繁，请稍后再试', 'push-rate-limited')
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
        const target = this.members.find((m) => m.fp === fp)
        this.replyPushError(fromFp, `${target ? target.name : fp} 不在线`, 'peer-offline')
      }
    })
  }

  async deliverTask ({ from, urls, options = {} }) {
    if (!this.cfg.get('receive-task-push')) {
      return false
    }
    try {
      await this.engineClient.call('addUri', urls, sanitizePushOptions(options))
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
      throw p2pError('push-empty', '请填写下载链接')
    }
    if (!this.inGroup) {
      throw p2pError('not-in-group', '尚未加入群组')
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
      throw p2pError('owner-offline', '群主不在线')
    }
    this.ownerConn.conn.send({ t: 'task-push', target, urls: list, options })
    return { ok: true, results: [{ fp: target, ok: true, queued: true }] }
  }

  /* --------------------------------------------------------- data plane */

  async openMemberStreamByFp (fp, targetPort) {
    const member = this.members.find((m) => m.fp === fp)
    if (!member) {
      throw p2pError('no-such-member', '群内没有这个成员')
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
      throw p2pError('port-not-open', '对方未开放该端口')
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
      throw p2pError('self-target', '不能与自己建立数据连接')
    }
    const eps = this.memberCandidates(member)
    if (!eps.length) {
      throw p2pError('peer-unreachable', '对方地址不可达')
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

    // Follow the burst instead of guessing: it reports its own failure through
    // rejectPoolWaiters (the moment the last dial fails) and wakes this waiter
    // the moment a conn lands, so this is only the outer bound for a peer whose
    // NAT never answers.
    const punchBudget = Math.min(PUNCH_WAIT_MAX, 2 * eps.length * PUNCH_DIAL_TIMEOUT + 2000)
    try {
      // eslint-disable-next-line no-await-in-loop
      return await this.waitForPoolConn(fp, punchBudget)
    } catch (err) {
      throw lastErr || err
    }
  }

  /** Claim a pooled/dialed conn for one TCP stream to `port` on the peer. */
  async claimTcpStream (conn, port) {
    if (!conn || conn.closed) {
      throw p2pError('conn-lost', '连接已断开')
    }
    // `claiming` matters as much as `kind`: the winner stamps kind='tcp' only
    // inside claimWrap, so in between a second claimer used to slip through,
    // send a second `dial` (silently dropped by the peer) and then close the
    // conn on its own 8s timeout — killing the first caller's live stream.
    if (conn.ctx && (conn.ctx.kind || conn.ctx.claiming || conn.ctx.speeding)) {
      throw p2pError('conn-busy', '连接已被占用')
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
        waitDrainOnce(conn.socket).then(() => stream.emit('drain'))
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
    this.dataConns.add(conn)
    conn.on('close', () => this.dataConns.delete(conn))
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

    // Exactly one waiter may own this conn. Waking them all handed the same
    // socket to several callers — and the conn stayed in the pool as well, so a
    // concurrent dataPoolTake could hand it out a third time.
    const waiters = this.poolWaiters.get(fp)
    if (waiters && waiters.length) {
      const waiter = waiters.shift()
      this.dataPoolRemove(fp, conn)
      clearTimeout(waiter.timer)
      waiter.resolve(conn)
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
    if (this.isOwner) {
      const m = this.members.find((x) => x.fp === fp)
      if (!m) {
        return
      }
      // tell the member to burst toward us too (their L-bound dial is what
      // opens THEIR NAT for our return traffic), then burst ourselves. The
      // in-flight flag is owned by runPunchBurst's try/finally, so unlike the
      // old timer-guessed flag it can never get stuck.
      const entry = this.controls.get(fp)
      if (entry) {
        entry.conn.send({ t: 'punch-signal', peer: this.selfPeerInfo() })
      }
      this.runPunchBurst({ fp, eps: this.memberCandidates(m) })
      return
    }
    if (this.ownerConn) {
      this.ownerConn.conn.send({ t: 'punch-request', target: fp })
    }
  }

  async runPunchBurst (peer) {
    const fp = peer && peer.fp
    if (!fp || this.stopping || !this.inGroup || fp === this.identity.fingerprint) {
      return
    }
    if (this.punching.has(fp)) {
      // repeated punch-signals must not stack two bursts on the same pair
      return
    }
    this.punching.add(fp)
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
      logger.warn(`[Super Cat] punch dial ${ep.h}:${ep.p} bind=${bind ? bind.localAddress : 'any'} failed: ${err.message}`)
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
        conn.send({ t: 'speed-error', reason: '对方正在测速中', code: 'speed-busy' })
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
        // bounded: this only exists to bridge a microtask gap, so a peer that
        // keeps answering must not grow it without limit
        if (ctx.speedInbox.length < SPEED_INBOX_MAX) {
          ctx.speedInbox.push({ header, body })
        }
      }
      return
    }
    if (!ctx.kind && !ctx.claiming) {
      if (header.t === 'speed-req') {
        // never serve a flood test blindly: the target is asked first
        this.askSpeedPermission(conn, header)
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
      if (header.t === 'probe') {
        // direct peer probe: answer on the same link. A peer that does not know
        // this frame type simply ignores it (see the fall-through below), so no
        // version handshake is needed.
        conn.send({ t: 'probe-ack', seq: header.seq, ts: header.ts })
        return
      }
      if (header.t === 'probe-ack') {
        if (ctx.probeSeq && ctx.probeSeq === header.seq) {
          ctx.probeSeq = null
          this.recordProbe(ctx.fp, Math.max(0, Date.now() - (Number(header.ts) || Date.now())))
        }
        return
      }
      if (header.t === 'file-offer') {
        // Claim the conn synchronously: the offer may sit in the user dialog
        // for a minute, and an unclaimed idle conn can be swept or dial-claimed
        // at any moment.
        ctx.claiming = true
        this.handleFileOffer(conn, header)
        return
      }
      return
    }
    if (header.t === 'speed-req') {
      logger.info(`[Super Cat] speed-req dropped: kind=${ctx.kind || 'none'} claiming=${!!ctx.claiming}`)
      conn.send({ t: 'speed-error', reason: `连接正忙（${ctx.kind || '占用'}）`, code: 'speed-busy' })
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
    if (ctx.kind === 'file') {
      if (ctx.fileSession && isFileFrame(header.t)) {
        ctx.fileSession.onFrame(header, body)
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
      // Same contract as the udp branch: the dispatcher calls ctx.onClose when
      // the tunnel dies, so the loopback socket must not outlive it.
      conn.ctx.onClose = () => {
        try {
          local.destroy()
        } catch (err) { /* already gone */ }
      }
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

  /* ---- file transfer ---- */

  receiveDir () {
    const saved = this.cfg.get('file-receive-dir')
    return (typeof saved === 'string' && saved) || join(homedir(), 'Downloads')
  }

  /** Remember a path the user chose natively; only those are accepted later. */
  notePickedDir (dir) {
    if (typeof dir === 'string' && dir) {
      this.pickedDirs.add(dir)
    }
  }

  fileMaxBytes () {
    const mb = Number(this.cfg.get('file-max-mb'))
    const clamped = Number.isFinite(mb) && mb > 0 ? Math.min(Math.round(mb), 102400) : 10240
    return clamped * 1024 * 1024
  }

  /**
   * Sweep aged-out `.part`/`.part.meta.json` pairs from the receive directory and
   * refresh the cached numbers hasRoomFor() uses. Best effort: any failure just
   * leaves the previous cache alone.
   */
  async sweepParts (force = false) {
    const now = Date.now()
    if (!force && now - this.partsSweepAt < PARTS_SWEEP_INTERVAL) {
      return
    }
    this.partsSweepAt = now
    const dir = this.receiveDir()
    let total = 0
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        // ours only (name pattern) AND only when our sidecar is next to it —
        // the receive dir is ~/Downloads by default, shared with other apps
        if (!entry.isFile() || !isOurPartName(entry.name)) {
          continue
        }
        const full = join(dir, entry.name)
        try {
          // eslint-disable-next-line no-await-in-loop
          const hasMeta = await fsp.stat(`${full}.meta.json`).then(() => true, () => false)
          if (!hasMeta) {
            logger.info(`[Super Cat] p2p left ${entry.name} alone (no sidecar)`)
            continue
          }
          // eslint-disable-next-line no-await-in-loop
          const st = await fsp.stat(full)
          if (now - st.mtimeMs > PART_TTL_MS) {
            // eslint-disable-next-line no-await-in-loop
            await fsp.unlink(full).catch(() => {})
            // eslint-disable-next-line no-await-in-loop
            await fsp.unlink(`${full}.meta.json`).catch(() => {})
            logger.info(`[Super Cat] p2p swept stale part ${entry.name}`)
            continue
          }
          total += st.size
        } catch (err) {
          /* vanished mid-scan */
        }
      }
      this.partsBytes = total
    } catch (err) {
      logger.warn(`[Super Cat] p2p part sweep failed: ${err.message}`)
      return
    }
    try {
      const fsStat = await fsp.statfs(dir)
      this.partsFreeBytes = Number(fsStat.bavail) * Number(fsStat.bsize)
    } catch (err) {
      this.partsFreeBytes = null
    }
  }

  /**
   * Room for an inbound offer: cached resumable-part total against the quota and
   * cached free space against the reserve. Unknown numbers fail open — a statfs
   * hiccup must never block honest transfers.
   */
  hasRoomFor (size) {
    this.sweepParts().catch(() => {})
    if (typeof this.partsBytes === 'number' && this.partsBytes + size > PARTS_QUOTA_BYTES) {
      return false
    }
    if (typeof this.partsFreeBytes === 'number' && this.partsFreeBytes - size < DISK_RESERVE_BYTES) {
      return false
    }
    return true
  }

  /** Narrow adapter the FileTransfer state machines talk through. */
  fileLink (conn) {
    return {
      send: (header, body) => conn.send(header, body),
      waitForDrain: () => waitDrainOnce(conn.socket),
      get closed () {
        return conn.closed
      }
    }
  }

  fileSnapshots () {
    return {
      sending: this.fileSend ? this.fileSend.snapshot() : null,
      receiving: this.fileRecv ? this.fileRecv.snapshot() : null,
      offers: [...this.fileOffers.values()].map((o) => ({
        tid: o.tid,
        from: o.from,
        name: o.name,
        size: o.size,
        since: o.since
      })),
      recent: this.recentTransfers,
      // what the resumable leftovers occupy — the UI shows this and can clear it
      parts: {
        bytes: this.partsBytes || 0,
        free: typeof this.partsFreeBytes === 'number' ? this.partsFreeBytes : null,
        busy: !!this.fileRecv
      }
    }
  }

  /**
   * Delete leftover `.part` files (the in-flight one, if any, is kept). They
   * only exist to resume a transfer, and nothing in the UI used to say they
   * were there — so a 40GB half-file could sit on the disk invisibly.
   */
  async clearParts () {
    const dir = this.receiveDir()
    const keepName = this.fileRecv && this.fileRecv.partPath ? basename(this.fileRecv.partPath) : null
    let removed = 0
    let freed = 0
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        // same guard as the sweep: our pattern + our sidecar, nothing else
        if (!entry.isFile() || !isOurPartName(entry.name)) {
          continue
        }
        if (keepName && entry.name === keepName) {
          continue
        }
        const full = join(dir, entry.name)
        try {
          // eslint-disable-next-line no-await-in-loop
          const hasMeta = await fsp.stat(`${full}.meta.json`).then(() => true, () => false)
          if (!hasMeta) {
            logger.info(`[Super Cat] p2p clearParts left ${entry.name} alone (no sidecar)`)
            continue
          }
          // eslint-disable-next-line no-await-in-loop
          const st = await fsp.stat(full)
          // eslint-disable-next-line no-await-in-loop
          await fsp.unlink(full).catch(() => {})
          // eslint-disable-next-line no-await-in-loop
          await fsp.unlink(`${full}.meta.json`).catch(() => {})
          removed += 1
          freed += st.size
        } catch (err) {
          /* vanished mid-scan */
        }
      }
    } catch (err) {
      logger.warn(`[Super Cat] clearParts failed: ${err.message}`)
    }
    await this.sweepParts(true).catch(() => {})
    this.pushState()
    logger.info(`[Super Cat] p2p cleared ${removed} part(s), freed ${freed} bytes`)
    return { removed, freed }
  }

  /** Remember how a transfer ended (newest first, capped). */
  noteTransfer (dirKind, res, peerFp) {
    const member = this.members.find((m) => m.fp === peerFp)
    this.recentTransfers = [{
      dir: dirKind,
      tid: res.tid || null,
      name: res.name || res.savedAs || '(file)',
      savedAs: res.savedAs || null,
      size: Number(res.size) || 0,
      peer: peerFp || null,
      peerName: member ? member.name : (peerFp || '?'),
      ok: res.ok !== false,
      reason: res.ok === false ? (res.reason || 'error') : null,
      ts: Date.now()
    }, ...this.recentTransfers].slice(0, RECENT_TRANSFERS_MAX)
  }

  /** Sender side: transfer owns its conn until it finishes. */
  async sendFile (fp, filePath) {
    if (!this.inGroup) {
      throw p2pError('not-in-group', '未加入群组')
    }
    if (this.fileSend) {
      throw p2pError('file-busy', '已有文件正在发送')
    }
    const member = this.members.find((m) => m.fp === fp && !m.isSelf)
    if (!member) {
      throw p2pError('no-such-member', '成员不存在')
    }
    const path = String(filePath || '')
    if (!path) {
      throw p2pError('file-missing', '未选择文件')
    }
    const st = await fsp.stat(path).catch(() => null)
    if (!st || !st.isFile()) {
      throw p2pError('file-missing', '文件不存在')
    }
    if (st.size <= 0) {
      throw p2pError('file-empty', '不能发送空文件')
    }
    if (st.size > this.fileMaxBytes()) {
      // check on the sending side too: hashing a 20GB file only to be refused
      // by the peer wastes minutes of both machines
      throw p2pError('too-large', `文件超过发送上限（${Math.round(this.fileMaxBytes() / 1048576)} MB）`)
    }

    const conn = await this.acquireDataConn(fp)
    if (this.fileSend) {
      // a second send won the race while we were dialing — release ours
      conn.close()
      throw p2pError('file-busy', '已有文件正在发送')
    }
    // Pull it out of the reuse pool for the whole transfer: the idle sweep
    // would otherwise retire this conn mid-stream after DATA_POOL_IDLE.
    this.dataPoolRemove(fp, conn)
    const ctx = conn.ctx || { fp }
    ctx.claiming = false
    ctx.kind = 'file'
    conn.ctx = ctx

    const sess = new SendSession({
      tid: randomBytes(8).toString('hex'),
      peer: fp,
      name: basename(path),
      size: st.size,
      fid: '',
      path,
      link: this.fileLink(conn),
      onUpdate: () => this.pushState(),
      onDone: (res) => this.finishFile('send', res, conn)
    })
    ctx.fileSession = sess
    ctx.onClose = () => sess.abort('conn-lost')
    this.fileSend = sess
    this.pushState()
    sess.run()
    return sess.snapshot()
  }

  /**
   * Receiver side, called straight from the dispatcher with ctx.claiming
   * already set. Policy rejects fire immediately; `ask` parks the offer in
   * fileOffers (UI confirms, auto-reject after OFFER_TTL).
   */
  handleFileOffer (conn, header) {
    const fp = conn.ctx ? conn.ctx.fp : null
    const member = this.members.find((m) => m.fp === fp)
    const from = member ? member.name : fp
    const reject = (reason) => {
      const ctx = conn.ctx || {}
      ctx.claiming = false
      conn.send({ t: 'file-reject', tid: header.tid, reason })
      conn.close()
      this.pushState()
    }
    const valid = typeof header.tid === 'string' && header.tid.length > 0 && header.tid.length <= 64 &&
      typeof header.fid === 'string' && /^[0-9a-f]{64}$/i.test(header.fid) &&
      Number.isInteger(header.size) && header.size > 0 &&
      typeof header.name === 'string' && header.name.length > 0 && header.name.length <= 255
    if (!valid) {
      reject('bad-offer')
      return
    }
    if (!this.cfg.get('file-receive-enabled')) {
      reject('receive-off')
      return
    }
    if (header.size > this.fileMaxBytes()) {
      reject('too-large')
      return
    }
    if (!this.hasRoomFor(header.size)) {
      // quota or free-space guard: refuse before any bytes move
      reject('no-space')
      return
    }
    if (this.fileRecv || this.fileOffers.size >= 4) {
      reject('busy')
      return
    }
    // ours now — out of the pool so nothing claims or sweeps it while we ask
    this.dataPoolRemove(fp, conn)
    const meta = {
      tid: header.tid,
      // The format check above is case-insensitive, but the transfer engine
      // compares the id byte-for-byte: an upper-case offer used to fail with a
      // bogus checksum mismatch, so normalise it once, here.
      fid: String(header.fid).toLowerCase(),
      name: sanitizeFileName(header.name),
      size: header.size,
      fp,
      from
    }
    if (this.cfg.get('file-receive-ask') === false) {
      this.beginReceive(conn, meta)
      return
    }
    const offer = { ...meta, conn, since: Date.now(), timer: null }
    offer.timer = setTimeout(() => {
      if (this.fileOffers.get(offer.tid) === offer) {
        this.fileOffers.delete(offer.tid)
        logger.info('[Super Cat] file offer unanswered — auto-rejected')
        reject('timeout')
      }
    }, OFFER_TTL)
    this.fileOffers.set(offer.tid, offer)
    this.emit('file-offer', { tid: offer.tid, from, name: offer.name, size: offer.size })
    this.pushState()
  }

  /** User (or the ask=false policy) accepted an offer: start receiving. */
  beginReceive (conn, meta) {
    const ctx = conn.ctx || { fp: meta.fp }
    const sess = new ReceiveSession({
      tid: meta.tid,
      peer: meta.fp,
      name: meta.name,
      size: meta.size,
      fid: meta.fid,
      dir: this.receiveDir(),
      link: this.fileLink(conn),
      onUpdate: () => this.pushState(),
      onDone: (res) => this.finishFile('recv', res, conn)
    })
    ctx.claiming = false
    ctx.kind = 'file'
    ctx.fileSession = sess
    ctx.onClose = () => sess.abort('conn-lost')
    conn.ctx = ctx
    this.fileRecv = sess
    if (conn.closed) {
      // the sender walked away while the user was deciding — say so now
      // instead of letting the session wait out BEGIN_WAIT
      sess.abort('conn-lost')
    }
    sess.start().catch((err) => {
      logger.warn('[Super Cat] file receive failed to start:', err.message)
    })
    this.pushState()
    return sess.snapshot()
  }

  /** Renderer answer to a parked offer: accept → begin, refuse → reject. */
  respondFileOffer (payload = {}) {
    const offer = this.fileOffers.get(payload.tid)
    if (!offer) {
      // already answered, auto-rejected, or the group went down
      return null
    }
    this.fileOffers.delete(offer.tid)
    clearTimeout(offer.timer)
    if (payload.accept !== true || this.fileRecv) {
      const ctx = offer.conn.ctx || {}
      ctx.claiming = false
      offer.conn.send({ t: 'file-reject', tid: offer.tid, reason: this.fileRecv ? 'busy' : 'user-rejected' })
      offer.conn.close()
      this.pushState()
      return null
    }
    return this.beginReceive(offer.conn, offer)
  }

  /** User cancel on an in-flight transfer (or a hard teardown). */
  cancelFileTransfer (payload = {}) {
    const sess = payload.dir === 'recv' ? this.fileRecv : this.fileSend
    if (sess && sess.tid === payload.tid) {
      sess.abort('cancelled')
      return sess.snapshot()
    }
    return null
  }

  finishFile (dirKind, res, conn) {
    const slot = dirKind === 'send' ? 'fileSend' : 'fileRecv'
    if (this[slot] && this[slot].tid === res.tid) {
      this[slot] = null
    }
    // both directions funnel through here, so this is where the history is kept
    this.noteTransfer(dirKind, res, res.peer || (conn.ctx && conn.ctx.fp))
    // transfers own their conn — release it either way
    try {
      conn.close()
    } catch (err) {
      /* already gone */
    }
    this.emit('file-event', { dir: dirKind, ...res })
    this.pushState()
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
      vip: this.sanitizeVip(m.vip),
      observed: m.observed || null,
      openPorts: m.openPorts || [],
      online: !!m.online,
      reachable: m.reachable === undefined ? null : m.reachable
    }
  }

  /**
   * Only loopback VIPs are legitimate: the forwarder binds `vip:port` on OUR
   * machine, so a hostile (or compromised) hub handing out `0.0.0.0` would
   * expose every member's tunnel ports to the whole network. Anything outside
   * the 127.87.0.2-254 range the hub is supposed to allocate is dropped.
   */
  sanitizeVip (vip) {
    const match = /^127\.87\.0\.(\d{1,3})$/.exec(String(vip || ''))
    if (!match) {
      return null
    }
    const last = Number(match[1])
    return last >= 2 && last <= 254 ? String(vip) : null
  }

  /** Member rows come from the hub: normalise what we refuse to trust. */
  sanitizeMemberRow (row) {
    if (!row || typeof row !== 'object') {
      return row
    }
    return {
      ...row,
      name: this.sanitizeName(row.name),
      vip: this.sanitizeVip(row.vip),
      // the hub already cleans these, but a member must not trust that
      openPorts: cleanRemotePorts(row.openPorts)
    }
  }

  /**
   * Display names are peer-supplied: cap them and drop control characters, or a
   * single member can inflate every roster frame (and the UI) on its own.
   */
  sanitizeName (name) {
    // eslint-disable-next-line no-control-regex
    const clean = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
    return clean.slice(0, NAME_MAX)
  }

  /**
   * A link's advertised address must be dialable in principle: no "any", no
   * broadcast/multicast, no link-local. Loopback stays allowed because two
   * instances on one machine are a legitimate setup (and the only observed
   * address there is loopback too).
   */
  sanitizePeerHost (host, observedHost = null) {
    const h = String(host || '').trim()
    if (!h) {
      return null
    }
    if (h === '0.0.0.0' || h === '::' || h === '255.255.255.255') {
      return null
    }
    if (h.startsWith('169.254.') || /^fe80:/i.test(h)) {
      return null
    }
    if (/^(22[4-9]|23\d)\./.test(h) || /^ff[0-9a-f]{2}:/i.test(h)) {
      return null
    }
    return h
  }

  /** At most ENDPOINT_UPDATE_MAX address changes per member per window. */
  acceptEndpointUpdate (fp) {
    const now = Date.now()
    const rec = this.endpointUpdates.get(fp) || { ts: now, count: 0 }
    if (now - rec.ts > ENDPOINT_UPDATE_WINDOW) {
      rec.ts = now
      rec.count = 0
    }
    rec.count += 1
    this.endpointUpdates.set(fp, rec)
    return rec.count <= ENDPOINT_UPDATE_MAX
  }

  /* ---- virtual loopback addresses (owner assigns, released on leave/kick) ---- */

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
    const rows = this.members.map((m) => this.publicMember(m))
    const name = this.cfg.get('group-name') || ''
    const rev = this.directoryRev()
    const banned = this.bannedList()
    // Slice by encoded size, not row count: a row carries the display name and
    // port list, so 256 rows can still blow the 64KB header limit (and a single
    // oversized frame used to throw and kill the link).
    const parts = []
    let current = []
    let bytes = 0
    rows.forEach((row) => {
      const size = JSON.stringify(row).length + 64
      if (current.length && bytes + size > DIR_PART_BYTES) {
        parts.push(current)
        current = []
        bytes = 0
      }
      current.push(row)
      bytes += size
    })
    if (current.length) {
      parts.push(current)
    }
    if (parts.length <= 1) {
      const ok = conn.send({ t: 'directory', name, rev, banned, members: parts[0] || [] })
      logger.info(`[Super Cat] p2p sendDirectory members=${rows.length} ok=${ok}`)
      return
    }
    for (let index = 0; index < parts.length; index++) {
      conn.send({
        t: 'directory-part',
        name,
        rev,
        banned,
        index,
        total: parts.length,
        members: parts[index]
      })
    }
    logger.info(`[Super Cat] p2p sendDirectory members=${rows.length} parts=${parts.length}`)
  }

  /**
   * Content signature of the roster: any membership / address / vip / port /
   * ban edit changes it, so a member can tell "I already hold exactly this"
   * from "I am behind" without a revision counter kept in sync by hand.
   */
  directoryRev () {
    const rows = this.members.map((m) => [
      m.fp,
      m.name,
      m.pub,
      m.h,
      m.p,
      m.vip || null,
      m.observed ? `${m.observed.h}:${m.observed.p}` : '',
      (m.openPorts || []).join(',')
    ])
    return createHash('sha256')
      .update(JSON.stringify([rows, this.bannedList()]))
      .digest('hex')
      .slice(0, 16)
  }

  /** Fingerprints every peer must refuse (the hub is the only authority). */
  bannedList () {
    return (this.cfg.get('banned') || []).slice(-BANNED_MAX)
  }

  /** Adopt the hub's ban list; ignored when a peer does not carry one. */
  applyBanned (raw) {
    if (!Array.isArray(raw)) {
      return
    }
    this.cfg.set('banned', raw.slice(-BANNED_MAX))
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
    // Audit trail: these come from the renderer, and two of them decide which
    // local sockets we open — a silent change must at least be findable in logs.
    const before = {
      openPorts: this.cfg.get('open-ports'),
      vipForward: this.cfg.get('vip-forward'),
      receiveTaskPush: this.cfg.get('receive-task-push'),
      fileReceive: this.cfg.get('file-receive-enabled'),
      fileAsk: this.cfg.get('file-receive-ask')
    }
    const prevOpenPorts = this.cfg.get('open-ports')
    let openPortsChanged = false

    if (Array.isArray(patch.openPorts)) {
      const clean = [...new Set(patch.openPorts.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536))]
        .slice(0, LOCAL_PORTS_MAX)
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
    if (typeof patch.fileReceiveEnabled === 'boolean') {
      this.cfg.set('file-receive-enabled', patch.fileReceiveEnabled)
    }
    if (typeof patch.fileReceiveAsk === 'boolean') {
      this.cfg.set('file-receive-ask', patch.fileReceiveAsk)
    }
    const changed = Object.keys(before).filter((key) => {
      const map = {
        openPorts: this.cfg.get('open-ports'),
        vipForward: this.cfg.get('vip-forward'),
        receiveTaskPush: this.cfg.get('receive-task-push'),
        fileReceive: this.cfg.get('file-receive-enabled'),
        fileAsk: this.cfg.get('file-receive-ask')
      }
      return JSON.stringify(map[key]) !== JSON.stringify(before[key])
    })
    if (changed.length) {
      logger.warn(`[Super Cat] p2p settings changed by renderer: ${changed.join(',')}`)
    }
    if (patch.fileReceiveDir !== undefined) {
      const dir = typeof patch.fileReceiveDir === 'string' && patch.fileReceiveDir ? patch.fileReceiveDir : null
      // Only a directory the user actually picked through the native dialog is
      // accepted: the receive folder decides where a remote peer's files land,
      // so the renderer must not be able to set it on its own.
      if (dir && !this.pickedDirs.has(dir)) {
        logger.warn('[Super Cat] p2p file-receive-dir not picked in this session — ignored')
      } else {
        this.cfg.set('file-receive-dir', dir)
      }
    }
    if (patch.fileMaxMb !== undefined) {
      const mb = Number(patch.fileMaxMb)
      this.cfg.set('file-max-mb', Number.isFinite(mb) && mb > 0 ? Math.min(Math.round(mb), 102400) : 10240)
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
    const inviteCode = this.isOwner ? this.currentCode() : null
    return {
      // snapshots carry a monotonic seq: the renderer accepts only newer ones
      seq: ++this.stateSeq,
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
        code: inviteCode,
        codeText: inviteCode ? formatCode(inviteCode) : null
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
      maxMembers: MAX_MEMBERS,
      pending: this.pending.map((p) => ({
        fp: p.fp,
        name: p.name,
        ip: p.ip || null,
        since: p.since
      })),
      links: this.linksSnapshot(),
      // main-process side of "someone is already doing this": the renderer's own
      // flags are per-window, these are the real ones
      busy: {
        speed: !!this.speedActive,
        send: !!this.fileSend,
        recv: !!this.fileRecv
      },
      // counters for support: enough to tell "stuck" from "broken" without a
      // debugger (and the same numbers a diagnostics dump would carry)
      health: {
        conns: this.controls.size,
        dataConns: this.dataConns.size,
        timers: this.timers.size,
        poolWaiters: [...this.poolWaiters.values()].reduce((n, list) => n + list.length, 0),
        pending: this.pending.length,
        probes: this.probePending.size,
        partsBytes: this.partsBytes,
        freeBytes: this.partsFreeBytes
      },
      speed: Object.fromEntries(this.speedResults),
      file: this.fileSnapshots(),
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
        fileReceiveEnabled: this.cfg.get('file-receive-enabled') !== false,
        fileReceiveAsk: this.cfg.get('file-receive-ask') !== false,
        fileReceiveDir: this.receiveDir(),
        fileMaxMb: Number(this.cfg.get('file-max-mb')) || 10240,
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
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.statePushTimer = null
      const state = this.getState()
      this.lastState = state
      this.emit('state-change', state)
      // membership/openPorts drive the vip listeners; reconcile here so every
      // directory change converges without a dedicated event plumbing
      this.vipForwarder.reconcile()
    }, STATE_PUSH_DEBOUNCE)
    // registered + unref'd like every other timer: it used to be the one handle
    // shutdown could not see, so a quit still emitted one last state-change
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    this.statePushTimer = timer
    this.timers.add(timer)
  }

  resetError () {
    if (this.status === P2P_STATUS.REJECTED || this.status === P2P_STATUS.KICKED ||
        this.status === P2P_STATUS.DISSOLVED || this.status === P2P_STATUS.ERROR) {
      this.status = this.inGroup ? P2P_STATUS.JOINED : P2P_STATUS.IDLE
      this.lastError = null
      this.pushState()
    }
    return this.getState()
  }
}

/**
 * Keep only whitelisted, primitive-valued options from a remote push.
 * Unknown keys, objects and arrays are ignored (a pushed task can never carry
 * a path or a file name), and the option count is capped.
 */
function sanitizePushOptions (raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') {
    return out
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!PUSH_OPTION_ALLOWLIST.has(key)) {
      continue
    }
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = String(value)
    }
    if (Object.keys(out).length >= PUSH_OPTIONS_MAX) {
      break
    }
  }
  return out
}

/** Normalise a peer-advertised port list: valid ports only, deduped, capped. */
function cleanRemotePorts (raw) {
  if (!Array.isArray(raw)) {
    return []
  }
  const out = []
  for (const n of raw) {
    const port = Number(n)
    if (Number.isInteger(port) && port > 0 && port < 65536 && !out.includes(port)) {
      out.push(port)
    }
    if (out.length >= REMOTE_PORTS_MAX) {
      break
    }
  }
  return out
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Errors the renderer translates. `code` picks the text (`p2p.err-<code>`), the
 * message stays as the fallback — the main process used to hand localised
 * Chinese straight to a UI that may well be showing English.
 */
function p2pError (code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/**
 * Resolve on the socket's `drain`, or right away when it closes. Both
 * listeners are removed once either fires: the inline version used to leave a
 * `close` handler (and its closure) behind on every drained write, and a large
 * transfer issues tens of thousands of those.
 */
function waitDrainOnce (socket) {
  return new Promise((resolve) => {
    const done = () => {
      socket.removeListener('drain', done)
      socket.removeListener('close', done)
      resolve()
    }
    socket.once('drain', done)
    socket.once('close', done)
  })
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
      socket.setKeepAlive(true, 15000)
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

function isPrivateAddr (h) {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd)/i.test(String(h || ''))
}

function sameSubnet24 (a, b) {
  if (!a || !b) {
    return false
  }
  return String(a).split('.').slice(0, 3).join('.') === String(b).split('.').slice(0, 3).join('.')
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
      waitDrainOnce(socket).then(() => stream.emit('drain'))
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
