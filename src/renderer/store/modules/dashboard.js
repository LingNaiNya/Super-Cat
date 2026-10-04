import { ipcRenderer } from 'electron'

import api from '@/api'
import { TASK_STATUS } from '@shared/constants'
import { checkTaskIsBT, checkTaskIsSeeder } from '@shared/utils'
import SessionHistory from '@/utils/history'

/* How many finished records are inspected for the lifetime traffic numbers.
   aria2 keeps every record until the session is purged, the dashboard only
   needs a representative slice and a small payload. */
const STOPPED_SAMPLE_SIZE = 500

/* The dashboard polls faster while something is downloading, slower when the
   engine is idle, so an idle dashboard costs almost nothing. */
const ACTIVE_REFRESH_INTERVAL = 1000
const IDLE_REFRESH_INTERVAL = 4000

const history = new SessionHistory()
let refreshTimer = null

const createTaskCount = () => ({
  active: 0,
  waiting: 0,
  paused: 0,
  stopped: 0,
  complete: 0,
  error: 0,
  removed: 0,
  seeding: 0
})

/**
 * The engine client is opened asynchronously while the app boots, a call
 * issued before that point rejects instead of returning data. The dashboard
 * is a passive reader, so a failing probe resolves to `null` and the caller
 * falls back to empty values.
 */
const safeCall = (promise) => {
  return Promise.resolve(promise).catch((err) => {
    console.warn('[Super Cat] dashboard request fail:', err.message)
    return null
  })
}

const state = {
  refreshing: false,
  lastUpdated: 0,
  taskCount: createTaskCount(),
  aggregate: {
    totalLength: 0,
    completedLength: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    connections: 0,
    numSeeders: 0,
    totalTasks: 0
  },
  taskTypes: {
    http: 0,
    bt: 0,
    magnet: 0,
    metalink: 0
  },
  disk: null,
  speedHistory: history.getSeries(),
  historySummary: history.getSummary()
}

const getters = {
  totalTaskCount: state => {
    const { active, waiting, paused } = state.taskCount
    return active + waiting + paused
  },
  overallProgress: state => {
    const { totalLength, completedLength } = state.aggregate
    if (totalLength <= 0) {
      return 0
    }
    return Math.min(1, completedLength / totalLength)
  }
}

const mutations = {
  UPDATE_REFRESHING (state, refreshing) {
    state.refreshing = refreshing
  },
  UPDATE_LAST_UPDATED (state, time) {
    state.lastUpdated = time
  },
  UPDATE_TASK_COUNT (state, taskCount) {
    state.taskCount = taskCount
  },
  UPDATE_AGGREGATE (state, aggregate) {
    state.aggregate = aggregate
  },
  UPDATE_TASK_TYPES (state, taskTypes) {
    state.taskTypes = taskTypes
  },
  UPDATE_DISK (state, disk) {
    state.disk = disk
  },
  UPDATE_SPEED_HISTORY (state, series) {
    state.speedHistory = series
  },
  UPDATE_HISTORY_SUMMARY (state, summary) {
    state.historySummary = summary
  }
}

const getTaskStatus = (task) => {
  const { status } = task
  if (status === TASK_STATUS.ACTIVE && checkTaskIsSeeder(task)) {
    return TASK_STATUS.SEEDING
  }
  return status
}

/**
 * Classifies a task by where it came from. A torrent task carries
 * `bittorrent.info`, a magnet task is still fetching that metadata, so the
 * original uri is the only reliable signal for the magnet case.
 */
const getTaskCategory = (task) => {
  if (checkTaskIsBT(task)) {
    const { files = [] } = task
    const { uris = [] } = files[0] || {}
    const uri = (uris[0] && uris[0].uri) || ''
    if (uri.startsWith('magnet:')) {
      return 'magnet'
    }
    return 'bt'
  }

  if (task.metalink) {
    return 'metalink'
  }

  return 'http'
}

const countTasks = (active = [], waiting = [], stopped = []) => {
  const taskCount = createTaskCount()
  const taskTypes = {
    http: 0,
    bt: 0,
    magnet: 0,
    metalink: 0
  }
  const aggregate = {
    totalLength: 0,
    completedLength: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    connections: 0,
    numSeeders: 0,
    totalTasks: 0
  }

  const all = [...active, ...waiting, ...stopped]

  all.forEach((task) => {
    const status = getTaskStatus(task)
    if (status in taskCount) {
      taskCount[status] += 1
    }

    const category = getTaskCategory(task)
    taskTypes[category] += 1

    const totalLength = Number(task.totalLength) || 0
    const completedLength = Number(task.completedLength) || 0
    aggregate.totalLength += totalLength
    // Finished records keep reporting their full length forever, mixing them
    // into the progress ratio would always read as 100 percent.
    if (status !== TASK_STATUS.COMPLETE && status !== TASK_STATUS.REMOVED) {
      aggregate.completedLength += completedLength
    }
    aggregate.totalTasks += 1
  })

  active.forEach((task) => {
    aggregate.downloadSpeed += Number(task.downloadSpeed) || 0
    aggregate.uploadSpeed += Number(task.uploadSpeed) || 0
    aggregate.connections += Number(task.connections) || 0
    aggregate.numSeeders += Number(task.numSeeders) || 0
  })

  aggregate.totalLength = Math.max(aggregate.totalLength, aggregate.completedLength)

  return { taskCount, taskTypes, aggregate }
}

const actions = {
  /**
   * Pulls everything the dashboard shows in one round trip. The engine is
   * queried through multicall where possible to keep the RPC traffic flat.
   */
  fetchDashboard ({ commit }) {
    commit('UPDATE_REFRESHING', true)
    const promises = [
      safeCall(api.getGlobalStat()),
      safeCall(api.fetchActiveTaskList()),
      safeCall(api.fetchWaitingTaskList({ offset: 0, num: 1000 })),
      safeCall(api.fetchStoppedTaskList({ offset: 0, num: STOPPED_SAMPLE_SIZE }))
    ]

    return Promise.allSettled(promises)
      .then((results) => {
        const [stat, active, waiting, stopped] = results.map((result) => {
          return result.status === 'fulfilled' ? result.value : null
        })

        const activeList = Array.isArray(active) ? active : []
        const waitingList = Array.isArray(waiting) ? waiting : []
        const stoppedList = Array.isArray(stopped) ? stopped : []
        const { taskCount, taskTypes, aggregate } = countTasks(activeList, waitingList, stoppedList)

        commit('UPDATE_TASK_COUNT', taskCount)
        commit('UPDATE_TASK_TYPES', taskTypes)
        commit('UPDATE_AGGREGATE', aggregate)
        commit('UPDATE_LAST_UPDATED', Date.now())

        if (stat && typeof stat === 'object') {
          history.record(stat)
        }

        return { taskCount, taskTypes, aggregate }
      })
      .finally(() => {
        commit('UPDATE_REFRESHING', false)
      })
  },
  fetchDiskSpace ({ commit }, directory) {
    if (!directory) {
      commit('UPDATE_DISK', null)
      return Promise.resolve(null)
    }

    return ipcRenderer.invoke('get-disk-space', directory)
      .then((disk) => {
        commit('UPDATE_DISK', disk)
        return disk
      })
      .catch((err) => {
        console.warn('[Super Cat] fetch disk space fail:', err.message)
        commit('UPDATE_DISK', null)
        return null
      })
  },
  recordSpeedSample ({ commit }, stat) {
    history.record(stat)
    commit('UPDATE_SPEED_HISTORY', history.getSeries())
    commit('UPDATE_HISTORY_SUMMARY', history.getSummary())
    history.save()
  },
  refreshSpeedHistory ({ commit }) {
    commit('UPDATE_SPEED_HISTORY', history.getSeries())
    commit('UPDATE_HISTORY_SUMMARY', history.getSummary())
  },
  clearSpeedHistory ({ commit }) {
    history.clear()
    commit('UPDATE_SPEED_HISTORY', history.getSeries())
    commit('UPDATE_HISTORY_SUMMARY', history.getSummary())
  },
  startRefresh ({ dispatch }) {
    const tick = () => {
      const { numActive } = this.state.app.stat
      const interval = numActive > 0 ? ACTIVE_REFRESH_INTERVAL : IDLE_REFRESH_INTERVAL

      dispatch('fetchDashboard')
        .then(() => dispatch('refreshSpeedHistory'))
        .finally(() => {
          refreshTimer = setTimeout(tick, interval)
        })
    }

    if (refreshTimer) {
      return
    }

    tick()
    dispatch('refreshSpeedHistory')
  },
  stopRefresh () {
    if (!refreshTimer) {
      return
    }
    clearTimeout(refreshTimer)
    refreshTimer = null
    history.save()
  }
}

export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions
}
