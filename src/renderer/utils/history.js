/**
 * Speed history
 *
 * The dashboard wants a trend line, while the engine only ever reports the
 * current speed. This module samples the global statistics into fixed time
 * buckets and keeps the result in localStorage, so the chart survives
 * switching pages and restarting the app without asking the engine for
 * anything it cannot provide.
 *
 * Layout of the persisted payload:
 *   { version, savedAt, samples: [ { t, downloadSpeed, uploadSpeed, downloaded, uploaded, active } ] }
 *
 * `t` is the index of the 15 minute slot inside the day (0 - 95), which
 * makes the buckets self ordering and keeps the payload small.
 */

const STORAGE_KEY = 'mo-speed-history'
const STORAGE_VERSION = 1

export const SLOT_DURATION = 15 * 60 * 1000
export const SLOT_COUNT = (24 * 60) / 15
export const SAMPLE_INTERVAL = 10 * 1000

export function getSlotIndex (time = Date.now()) {
  const date = new Date(time)
  const minutes = date.getHours() * 60 + date.getMinutes()
  return Math.min(SLOT_COUNT - 1, Math.floor(minutes / 15))
}

export function getSlotTime (slot) {
  const minutes = slot * 15
  const date = new Date()
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return date.getTime()
}

export function formatSlotLabel (slot) {
  const minutes = slot * 15
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${`${hour}`.padStart(2, '0')}:${`${minute}`.padStart(2, '0')}`
}

const createEmptySamples = () => {
  return new Array(SLOT_COUNT).fill(null).map((item, slot) => ({
    t: slot,
    downloadSpeed: 0,
    uploadSpeed: 0,
    downloaded: 0,
    uploaded: 0,
    active: 0,
    hits: 0
  }))
}

export default class SessionHistory {
  constructor (options = {}) {
    const { interval = SAMPLE_INTERVAL } = options
    this.interval = interval
    this.samples = createEmptySamples()
    this.load()
  }

  load () {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        return
      }

      const payload = JSON.parse(raw)
      if (!payload || payload.version !== STORAGE_VERSION || !Array.isArray(payload.samples)) {
        return
      }

      const fresh = createEmptySamples()
      payload.samples.forEach((sample) => {
        const slot = Number(sample.t)
        if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
          return
        }
        fresh[slot] = {
          ...fresh[slot],
          ...sample,
          t: slot
        }
      })
      this.samples = fresh
    } catch (err) {
      console.warn('[Super Cat] load speed history fail:', err.message)
    }
  }

  save () {
    try {
      const payload = {
        version: STORAGE_VERSION,
        savedAt: Date.now(),
        samples: this.samples.filter((sample) => sample.hits > 0)
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch (err) {
      console.warn('[Super Cat] save speed history fail:', err.message)
    }
  }

  /**
   * Folds one statistic reading into the current bucket. Speeds are averaged
   * by hit count, transferred bytes are accumulated, which keeps the bucket
   * meaningful even when the sampling interval drifts.
   */
  record (stat = {}) {
    const slot = getSlotIndex()
    const sample = this.samples[slot]
    const downloadSpeed = Number(stat.downloadSpeed) || 0
    const uploadSpeed = Number(stat.uploadSpeed) || 0
    const hits = sample.hits + 1

    sample.downloadSpeed = (sample.downloadSpeed * sample.hits + downloadSpeed) / hits
    sample.uploadSpeed = (sample.uploadSpeed * sample.hits + uploadSpeed) / hits
    sample.downloaded += downloadSpeed * (this.interval / 1000)
    sample.uploaded += uploadSpeed * (this.interval / 1000)
    sample.active = Math.max(sample.active, Number(stat.numActive) || 0)
    sample.hits = hits
  }

  clear () {
    this.samples = createEmptySamples()
    this.save()
  }

  /**
   * Samples ordered so that the newest bucket is always the last element,
   * which is what a left to right time axis expects.
   */
  getSeries () {
    const nowSlot = getSlotIndex()
    const result = []
    for (let offset = 0; offset < SLOT_COUNT; offset += 1) {
      const slot = (nowSlot + 1 + offset) % SLOT_COUNT
      const sample = this.samples[slot]
      result.push({
        ...sample,
        label: formatSlotLabel(slot),
        time: getSlotTime(slot),
        current: slot === nowSlot
      })
    }
    return result
  }

  getSummary () {
    const active = this.samples.filter((sample) => sample.hits > 0)
    const total = active.reduce((result, sample) => {
      return {
        downloaded: result.downloaded + sample.downloaded,
        uploaded: result.uploaded + sample.uploaded,
        peakDownloadSpeed: Math.max(result.peakDownloadSpeed, sample.downloadSpeed),
        peakUploadSpeed: Math.max(result.peakUploadSpeed, sample.uploadSpeed)
      }
    }, {
      downloaded: 0,
      uploaded: 0,
      peakDownloadSpeed: 0,
      peakUploadSpeed: 0
    })

    const averageDownloadSpeed = active.length === 0
      ? 0
      : active.reduce((sum, sample) => sum + sample.downloadSpeed, 0) / active.length

    return {
      ...total,
      averageDownloadSpeed,
      activeSlots: active.length
    }
  }
}
