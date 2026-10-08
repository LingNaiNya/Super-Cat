import { createSocket } from 'dgram'
import { networkInterfaces } from 'os'

import logger from '../Logger'

const STUN_SERVERS = [
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun1.l.google.com', port: 19302 }
]
const STUN_TIMEOUT = 3000

function stunBindingRequest () {
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0) // binding request
  buf.writeUInt16BE(0, 2) // length
  buf.writeUInt32BE(0x2112a442, 4)
  randomFill(buf, 8, 12)
  return buf
}

function randomFill (buf, start, end) {
  for (let i = start; i < end; i++) {
    buf[i] = Math.floor(Math.random() * 256)
  }
}

function parseStunResponse (msg) {
  if (msg.length < 20) {
    return null
  }
  const type = msg.readUInt16BE(0)
  if (type !== 0x0101) {
    return null
  }
  const magic = msg.readUInt32BE(4)
  if (magic !== 0x2112a442) {
    return null
  }
  let offset = 20
  while (offset + 4 <= msg.length) {
    const attrType = msg.readUInt16BE(offset)
    const attrLen = msg.readUInt16BE(offset + 2)
    const attrStart = offset + 4
    const attrEnd = attrStart + attrLen
    if (attrEnd > msg.length) {
      break
    }
    // XOR-MAPPED-ADDRESS
    if (attrType === 0x0020 && attrLen >= 8) {
      const family = msg[attrStart + 1]
      const xport = msg.readUInt16BE(attrStart + 2)
      const xaddr = msg.readUInt32BE(attrStart + 4)
      if (family === 1) {
        const port = xport ^ 0x2112
        const addr = xaddr ^ 0x2112a442
        const ip = [
          (addr >>> 24) & 0xff,
          (addr >>> 16) & 0xff,
          (addr >>> 8) & 0xff,
          addr & 0xff
        ].join('.')
        return { ip, port }
      }
    }
    // MAPPED-ADDRESS (fallback, no XOR)
    if (attrType === 0x0001 && attrLen >= 8) {
      const family = msg[attrStart + 1]
      const port = msg.readUInt16BE(attrStart + 2)
      const addr = msg.readUInt32BE(attrStart + 4)
      if (family === 1) {
        const ip = [
          (addr >>> 24) & 0xff,
          (addr >>> 16) & 0xff,
          (addr >>> 8) & 0xff,
          addr & 0xff
        ].join('.')
        return { ip, port }
      }
    }
    offset = attrEnd + ((4 - (attrLen % 4)) % 4)
  }
  return null
}

function stunQuery (server) {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    const req = stunBindingRequest()
    let done = false
    const finish = (result) => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch (err) {
        /* already closed */
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish(null), STUN_TIMEOUT)
    socket.on('error', () => finish(null))
    socket.on('message', (msg) => {
      finish(parseStunResponse(msg))
    })
    socket.send(req, server.port, server.host, (err) => {
      if (err) {
        finish(null)
      }
    })
  })
}

function getLanAddress () {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return null
}

/**
 * Figures out how the rest of the group can reach this machine, without any
 * rendezvous server of our own:
 *
 *  1. manual override from settings (user knows their public ip)
 *  2. router IGD external ip + UPnP port mapping  → inbound reachable
 *  3. public STUN ip (no mapping)                 → likely NOT inbound reachable
 *  4. LAN address                                 → same-LAN peers only
 *
 * `mapped` tells the UI whether others can actually dial in — the honest
 * difference between "you can join others" and "others can reach your
 * services".
 */
export default class Endpoint {
  constructor ({ upnpManager }) {
    this.upnpManager = upnpManager
  }

  async discover ({ port, manual = null, allowUpnp = true }) {
    if (manual && manual.h) {
      return {
        h: manual.h,
        p: Number(manual.p) || port,
        source: 'manual',
        mapped: true,
        lanOnly: false
      }
    }

    let mapped = false
    let upnpIp = null
    try {
      if (this.upnpManager && allowUpnp) {
        await this.upnpManager.map(port)
        mapped = true
        upnpIp = await this.upnpManager.externalIp()
      }
    } catch (err) {
      logger.warn('[Super Cat] p2p endpoint: upnP failed:', err && err.message)
    }

    if (upnpIp && isPublicIp(upnpIp)) {
      return { h: upnpIp, p: port, source: 'upnp', mapped: true, lanOnly: false }
    }

    for (const server of STUN_SERVERS) {
      const result = await stunQuery(server)
      if (result && result.ip && isPublicIp(result.ip)) {
        return {
          h: result.ip,
          p: port,
          source: 'stun',
          mapped: false,
          lanOnly: false,
          warning: mapped ? null : 'unmapped'
        }
      }
    }

    const lan = getLanAddress()
    if (lan) {
      return {
        h: lan,
        p: port,
        source: 'lan',
        mapped,
        lanOnly: true,
        warning: 'lan-only'
      }
    }

    return { h: null, p: port, source: 'none', mapped: false, lanOnly: false, warning: 'unreachable' }
  }
}

function isPublicIp (ip) {
  if (!ip) {
    return false
  }
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    // let ipv6 through — if the router hands us one we use it
    return ip.includes(':')
  }
  if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) {
    return false
  }
  if (parts[0] === 192 && parts[1] === 168) {
    return false
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return false
  }
  if (parts[0] === 169 && parts[1] === 254) {
    return false
  }
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) {
    return false // CGNAT 100.64/10
  }
  return true
}
