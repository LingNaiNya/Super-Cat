import NatAPI from '@motrix/nat-api'

import logger from './Logger'

let client = null
const mappingStatus = {}

export default class UPnPManager {
  constructor (options = {}) {
    this.options = {
      ...options
    }
  }

  init () {
    if (client) {
      return
    }

    client = new NatAPI({
      autoUpdate: true
    })
  }

  map (port) {
    this.init()

    return new Promise((resolve, reject) => {
      logger.info('[Super Cat] UPnPManager port mapping: ', port)
      if (!port) {
        reject(new Error('[Super Cat] port was not specified'))
        return
      }

      try {
        client.map(port, (err) => {
          if (err) {
            logger.warn(`[Super Cat] UPnPManager map ${port} failed, error: `, err.message)
            reject(err.message)
            return
          }

          mappingStatus[port] = true
          logger.info(`[Super Cat] UPnPManager port ${port} mapping succeeded`)
          resolve()
        })
      } catch (err) {
        reject(err.message)
      }
    })
  }

  unmap (port) {
    this.init()

    return new Promise((resolve, reject) => {
      logger.info('[Super Cat] UPnPManager port unmapping: ', port)
      if (!port) {
        reject(new Error('[Super Cat] port was not specified'))
        return
      }

      if (!mappingStatus[port]) {
        resolve()
        return
      }

      try {
        client.unmap(port, (err) => {
          if (err) {
            logger.warn(`[Super Cat] UPnPManager unmap ${port} failed, error: `, err)
            reject(err.message)
            return
          }

          logger.info(`[Super Cat] UPnPManager port ${port} unmapping succeeded`)
          mappingStatus[port] = false
          resolve()
        })
      } catch (err) {
        reject(err.message)
      }
    })
  }

  /**
   * The router's own view of our public address (IGD GetExternalIPAddress).
   * This is what lets a no-server invite code embed a reachable anchor.
   */
  externalIp () {
    this.init()

    return new Promise((resolve, reject) => {
      try {
        client.externalIp((err, ip) => {
          if (err || !ip) {
            reject(new Error(err ? err.message : 'no external ip'))
            return
          }
          resolve(ip)
        })
      } catch (err) {
        reject(err)
      }
    })
  }

  closeClient () {
    if (!client) {
      return
    }

    try {
      client.destroy(() => {
        client = null
      })
    } catch (err) {
      logger.warn('[Super Cat] close UPnP client fail', err)
    }
  }
}
