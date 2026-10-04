import { powerSaveBlocker } from 'electron'

import logger from './Logger'

let psbId
export default class EnergyManager {
  startPowerSaveBlocker () {
    logger.info('[Super Cat] EnergyManager.startPowerSaveBlocker', psbId)
    if (psbId && powerSaveBlocker.isStarted(psbId)) {
      return
    }

    psbId = powerSaveBlocker.start('prevent-app-suspension')
    logger.info('[Super Cat] start power save blocker:', psbId)
  }

  stopPowerSaveBlocker () {
    logger.info('[Super Cat] EnergyManager.stopPowerSaveBlocker', psbId)
    if (typeof psbId === 'undefined' || !powerSaveBlocker.isStarted(psbId)) {
      return
    }

    powerSaveBlocker.stop(psbId)
    logger.info('[Super Cat] stop power save blocker:', psbId)
    psbId = undefined
  }
}
