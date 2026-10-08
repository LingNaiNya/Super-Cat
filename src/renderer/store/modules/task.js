import api from '@/api'
import { EMPTY_STRING, TASK_STATUS, UPDATE_TASK_GID } from '@shared/constants'
import { checkTaskIsBT, intersection } from '@shared/utils'

/**
 * Build the synthetic row that mirrors the electron-updater download in the
 * active task list. Shaped like an aria2 task so TaskItem renders it with no
 * special cases; `isUpdateTask` only gates selection and action buttons.
 */
function buildUpdateTask (meta = {}, status = TASK_STATUS.ACTIVE) {
  const { version = '', fileName = '', totalBytes = 0 } = meta
  const name = fileName || (version ? `Super-Cat-Setup-${version}.exe` : EMPTY_STRING)
  return {
    gid: UPDATE_TASK_GID,
    isUpdateTask: true,
    status,
    totalLength: Number(totalBytes) || 0,
    completedLength: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    connections: 1,
    files: [{ path: name, uris: [] }]
  }
}

const state = {
  currentList: 'active',
  taskDetailVisible: false,
  currentTaskGid: EMPTY_STRING,
  enabledFetchPeers: false,
  currentTaskItem: null,
  currentTaskFiles: [],
  currentTaskPeers: [],
  seedingList: [],
  taskList: [],
  updateTask: null,
  selectedGidList: []
}

const getters = {
}

const mutations = {
  UPDATE_SEEDING_LIST (state, seedingList) {
    state.seedingList = seedingList
  },
  UPDATE_TASK_LIST (state, taskList) {
    state.taskList = taskList
  },
  UPDATE_SELECTED_GID_LIST (state, gidList) {
    state.selectedGidList = gidList
  },
  CHANGE_CURRENT_LIST (state, currentList) {
    state.currentList = currentList
  },
  CHANGE_TASK_DETAIL_VISIBLE (state, visible) {
    state.taskDetailVisible = visible
  },
  UPDATE_CURRENT_TASK_GID (state, gid) {
    state.currentTaskGid = gid
  },
  UPDATE_ENABLED_FETCH_PEERS (state, enabled) {
    state.enabledFetchPeers = enabled
  },
  UPDATE_CURRENT_TASK_ITEM (state, task) {
    state.currentTaskItem = task
  },
  UPDATE_CURRENT_TASK_FILES (state, files) {
    state.currentTaskFiles = files
  },
  UPDATE_CURRENT_TASK_PEERS (state, peers) {
    state.currentTaskPeers = peers
  },
  UPDATE_UPDATE_TASK (state, task) {
    state.updateTask = task
    // Keep the rendered row in sync immediately: waiting for the aria2 poll
    // (up to 6s idle interval) would freeze progress and leave a stale row
    // after finish/clear until the next fetchList
    if (state.currentList !== 'active') {
      return
    }
    const idx = state.taskList.findIndex((item) => item.gid === UPDATE_TASK_GID)
    if (!task) {
      if (idx !== -1) {
        state.taskList.splice(idx, 1)
      }
      return
    }
    if (idx === -1) {
      state.taskList.unshift(task)
    } else {
      state.taskList.splice(idx, 1, task)
    }
  }
}

const actions = {
  changeCurrentList ({ commit, dispatch }, currentList) {
    commit('CHANGE_CURRENT_LIST', currentList)
    commit('UPDATE_SELECTED_GID_LIST', [])
    dispatch('fetchList')
  },
  fetchList ({ commit, state }) {
    return api.fetchTaskList({ type: state.currentList })
      .then((data) => {
        // The update download is not an aria2 task; prepend its synthetic row
        // so the progress stays visible while the list polls for real tasks
        const list = (state.currentList === 'active' && state.updateTask)
          ? [state.updateTask, ...data]
          : data
        commit('UPDATE_TASK_LIST', list)

        const { selectedGidList } = state
        const gids = list.map((task) => task.gid)
        const selected = intersection(selectedGidList, gids)
        commit('UPDATE_SELECTED_GID_LIST', selected)
      })
  },
  selectTasks ({ commit }, list) {
    const gidList = list.filter((gid) => gid !== UPDATE_TASK_GID)
    commit('UPDATE_SELECTED_GID_LIST', gidList)
  },
  selectAllTask ({ commit, state }) {
    const gids = state.taskList
      .filter((task) => !task.isUpdateTask)
      .map((task) => task.gid)
    commit('UPDATE_SELECTED_GID_LIST', gids)
  },
  fetchItem ({ dispatch }, gid) {
    return api.fetchTaskItem({ gid })
      .then((data) => {
        dispatch('updateCurrentTaskItem', data)
      })
  },
  fetchItemWithPeers ({ dispatch }, gid) {
    return api.fetchTaskItemWithPeers({ gid })
      .then((data) => {
        console.log('fetchItemWithPeers===>', data)
        dispatch('updateCurrentTaskItem', data)
      })
  },
  showTaskDetail ({ commit, dispatch }, task) {
    dispatch('updateCurrentTaskItem', task)
    commit('UPDATE_CURRENT_TASK_GID', task.gid)
    commit('CHANGE_TASK_DETAIL_VISIBLE', true)
  },
  hideTaskDetail ({ commit }) {
    commit('CHANGE_TASK_DETAIL_VISIBLE', false)
  },
  toggleEnabledFetchPeers ({ commit }, enabled) {
    commit('UPDATE_ENABLED_FETCH_PEERS', enabled)
  },
  updateCurrentTaskItem ({ commit }, task) {
    commit('UPDATE_CURRENT_TASK_ITEM', task)
    if (task) {
      commit('UPDATE_CURRENT_TASK_FILES', task.files)
      commit('UPDATE_CURRENT_TASK_PEERS', task.peers)
    } else {
      commit('UPDATE_CURRENT_TASK_FILES', [])
      commit('UPDATE_CURRENT_TASK_PEERS', [])
    }
  },
  updateCurrentTaskGid ({ commit }, gid) {
    commit('UPDATE_CURRENT_TASK_GID', gid)
  },
  addUri ({ dispatch }, data) {
    const { uris, outs, options } = data
    return api.addUri({ uris, outs, options })
      .then(() => {
        dispatch('fetchList')
        dispatch('app/updateAddTaskOptions', {}, { root: true })
      })
  },
  addTorrent ({ dispatch }, data) {
    const { torrent, options } = data
    return api.addTorrent({ torrent, options })
      .then(() => {
        dispatch('fetchList')
        dispatch('app/updateAddTaskOptions', {}, { root: true })
      })
  },
  addMetalink ({ dispatch }, data) {
    const { metalink, options } = data
    return api.addMetalink({ metalink, options })
      .then(() => {
        dispatch('fetchList')
        dispatch('app/updateAddTaskOptions', {}, { root: true })
      })
  },
  getTaskOption (_, gid) {
    return new Promise((resolve) => {
      api.getOption({ gid })
        .then((data) => {
          resolve(data)
        })
    })
  },
  changeTaskOption (_, payload) {
    const { gid, options } = payload
    return api.changeOption({ gid, options })
  },
  removeTask ({ state, dispatch }, task) {
    const { gid } = task
    if (gid === state.currentTaskGid) {
      dispatch('hideTaskDetail')
    }

    return api.removeTask({ gid })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  forcePauseTask ({ dispatch }, task) {
    const { gid, status } = task
    if (status !== TASK_STATUS.ACTIVE) {
      return Promise.resolve(true)
    }

    return api.forcePauseTask({ gid })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  pauseTask ({ dispatch }, task) {
    const { gid } = task
    const isBT = checkTaskIsBT(task)
    const promise = isBT ? api.forcePauseTask({ gid }) : api.pauseTask({ gid })
    promise.finally(() => {
      dispatch('fetchList')
      dispatch('saveSession')
    })
    return promise
  },
  resumeTask ({ dispatch }, task) {
    const { gid } = task
    return api.resumeTask({ gid })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  pauseAllTask ({ dispatch }) {
    return api.pauseAllTask()
      .catch(() => {
        return api.forcePauseAllTask()
      })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  resumeAllTask ({ dispatch }) {
    return api.resumeAllTask()
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  },
  addToSeedingList ({ state, commit }, gid) {
    const { seedingList } = state
    if (seedingList.includes(gid)) {
      return
    }

    const list = [
      ...seedingList,
      gid
    ]
    commit('UPDATE_SEEDING_LIST', list)
  },
  removeFromSeedingList ({ state, commit }, gid) {
    const { seedingList } = state
    const idx = seedingList.indexOf(gid)
    if (idx === -1) {
      return
    }

    const list = [...seedingList.slice(0, idx), ...seedingList.slice(idx + 1)]
    commit('UPDATE_SEEDING_LIST', list)
  },
  stopSeeding ({ dispatch }, { gid }) {
    const options = {
      seedTime: 0
    }
    return dispatch('changeTaskOption', { gid, options })
  },
  removeTaskRecord ({ state, dispatch }, task) {
    const { gid, status } = task
    if (gid === state.currentTaskGid) {
      dispatch('hideTaskDetail')
    }

    const { ERROR, COMPLETE, REMOVED } = TASK_STATUS
    if ([ERROR, COMPLETE, REMOVED].indexOf(status) === -1) {
      return
    }
    return api.removeTaskRecord({ gid })
      .finally(() => dispatch('fetchList'))
  },
  saveSession () {
    api.saveSession()
  },
  purgeTaskRecord ({ dispatch }) {
    return api.purgeTaskRecord()
      .finally(() => dispatch('fetchList'))
  },
  startUpdateDownload ({ commit }, meta = {}) {
    commit('UPDATE_UPDATE_TASK', buildUpdateTask(meta))
  },
  updateUpdateDownload ({ state, commit }, payload = {}) {
    const { transferred = 0, total = 0, bytesPerSecond = 0, ...meta } = payload
    const current = state.updateTask
    if (current && current.status === TASK_STATUS.COMPLETE) {
      return
    }
    // Upsert: progress messages carry the meta, so the row still appears
    // even if the start message never reached this window
    const task = current || buildUpdateTask(meta)
    commit('UPDATE_UPDATE_TASK', {
      ...task,
      status: TASK_STATUS.ACTIVE,
      totalLength: Number(total) || task.totalLength,
      completedLength: Number(transferred) || task.completedLength,
      downloadSpeed: Number(bytesPerSecond) || 0
    })
  },
  finishUpdateDownload ({ state, commit }) {
    if (!state.updateTask) {
      return
    }
    const task = state.updateTask
    const total = Number(task.totalLength) || Number(task.completedLength) || 0
    commit('UPDATE_UPDATE_TASK', {
      ...task,
      status: TASK_STATUS.COMPLETE,
      totalLength: total,
      completedLength: total,
      downloadSpeed: 0
    })
  },
  clearUpdateDownload ({ commit }) {
    commit('UPDATE_UPDATE_TASK', null)
  },
  toggleTask ({ dispatch }, task) {
    const { status } = task
    const { ACTIVE, WAITING, PAUSED } = TASK_STATUS
    if (status === ACTIVE) {
      return dispatch('pauseTask', task)
    } else if (status === WAITING || status === PAUSED) {
      return dispatch('resumeTask', task)
    }
  },
  batchResumeSelectedTasks ({ state }) {
    const gids = state.selectedGidList
    if (gids.length === 0) {
      return
    }

    return api.batchResumeTask({ gids })
  },
  batchPauseSelectedTasks ({ state }) {
    const gids = state.selectedGidList
    if (gids.length === 0) {
      return
    }

    return api.batchPauseTask({ gids })
  },
  batchForcePauseTask (_, gids) {
    return api.batchForcePauseTask({ gids })
  },
  batchResumeTask (_, gids) {
    return api.batchResumeTask({ gids })
  },
  batchRemoveTask ({ dispatch }, gids) {
    return api.batchRemoveTask({ gids })
      .finally(() => {
        dispatch('fetchList')
        dispatch('saveSession')
      })
  }
}

export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions
}
