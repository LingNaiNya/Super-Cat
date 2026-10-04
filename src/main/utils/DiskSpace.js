import { statfs, existsSync } from 'fs'
import { basename, dirname, parse } from 'path'

/**
 * Reports the free / total capacity of the volume that holds `directory`.
 *
 * `fs.statfs` only exists on Node 18 and above, older Electron builds (this
 * project runs Electron 22 / Node 16) do not have it, so the lookup is done
 * defensively and resolves to `null` when the information is unavailable.
 * The renderer treats `null` as "unknown" and hides the numbers instead of
 * showing a wrong value.
 *
 * @param {String} directory
 * @returns {Promise<Object|null>}
 */
export function getDiskSpace (directory) {
  return new Promise((resolve) => {
    if (!directory || typeof statfs !== 'function') {
      resolve(null)
      return
    }

    let target = directory
    // Walk up until an existing directory is found: a task may point at a
    // folder the user has not created yet.
    let guard = 0
    while (target && !existsSync(target) && guard < 10) {
      const parent = dirname(target)
      if (parent === target) {
        break
      }
      target = parent
      guard += 1
    }

    statfs(target, (err, stats) => {
      if (err) {
        resolve(null)
        return
      }

      const blockSize = Number(stats.bsize)
      const total = Number(stats.blocks) * blockSize
      const free = Number(stats.bfree) * blockSize
      const available = Number(stats.bavail) * blockSize
      const used = total - free
      const { root } = parse(target)

      resolve({
        path: target,
        volume: basename(root) || root,
        total,
        free,
        available,
        used,
        usedRatio: total > 0 ? used / total : 0
      })
    })
  })
}

export default getDiskSpace
