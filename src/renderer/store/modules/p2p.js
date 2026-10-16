import { ipcRenderer } from 'electron'

const state = {
  loaded: false,
  // snapshot version: older payloads must never overwrite newer state
  seq: 0,
  status: 'idle',
  role: '',
  enabled: false,
  self: { fp: '', name: '', vip: null },
  group: { gid: null, name: '', code: null, codeText: null },
  endpoint: { h: null, p: null, source: 'none', mapped: false, lanOnly: false, warning: null, listenPort: 0 },
  members: [],
  maxMembers: 0,
  pending: [],
  links: {},
  speed: {},
  settings: {
    openPorts: [],
    receiveTaskPush: true,
    vipForward: true,
    fileReceiveEnabled: true,
    fileReceiveAsk: true,
    fileReceiveDir: '',
    fileMaxMb: 10240,
    manualEndpoint: null
  },
  file: { sending: null, receiving: null, offers: [], recent: [] },
  // main-process "someone is already doing this" flags
  busy: { speed: false, send: false, recv: false },
  // counters for support (see P2PManager.getState)
  health: {},
  forward: { enabled: true, listeners: 0, conflicts: [] },
  punch: { last: null, target: null, ts: 0 },
  lastError: null
}

const mutations = {
  UPDATE_STATE (state, payload) {
    if (!payload) {
      return
    }
    // Two writers feed this (the 150ms push and every action's response). An
    // out-of-order older snapshot used to roll the UI back (a handled request
    // reappearing, a rotated code reverting), so drop anything not newer.
    if (typeof payload.seq === 'number' && payload.seq <= (state.seq || 0) && state.loaded) {
      return
    }
    Object.assign(state, payload)
    state.loaded = true
  }
}

/** Every p2p command resolves `{ok, result, error, state}` — state is always
 *  the fresh snapshot, so one commit keeps the UI in sync after any action. */
const call = (channel, payload) => ipcRenderer.invoke(channel, payload)

const actions = {
  updateState ({ commit }, payload) {
    commit('UPDATE_STATE', payload)
  },
  async fetchState ({ commit }) {
    try {
      const resp = await ipcRenderer.invoke('p2p:get-state')
      if (resp && resp.ok) {
        commit('UPDATE_STATE', resp.state)
        return resp
      }
      // never strand the page on the spinner: show the error bar instead
      commit('UPDATE_STATE', {
        loaded: true,
        lastError: { message: (resp && resp.error) || '无法读取互联状态' }
      })
      return resp
    } catch (err) {
      commit('UPDATE_STATE', {
        loaded: true,
        lastError: { message: err.message }
      })
    }
  },
  async createGroup ({ commit }, payload) {
    const resp = await call('p2p:create-group', payload)
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async joinGroup ({ commit }, payload) {
    const resp = await call('p2p:join-group', payload)
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async approve ({ commit }, fp) {
    const resp = await call('p2p:approve', { fp })
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async reject ({ commit }, fp) {
    const resp = await call('p2p:reject', { fp })
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async kick ({ commit }, fp) {
    const resp = await call('p2p:kick', { fp })
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async resetCode ({ commit }) {
    const resp = await call('p2p:reset-code')
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async leave ({ commit }) {
    const resp = await call('p2p:leave')
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async pushTask ({ commit }, payload) {
    const resp = await call('p2p:push-task', payload)
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async updateSettings ({ commit }, payload) {
    const resp = await call('p2p:update-settings', payload)
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async resetError ({ commit }) {
    const resp = await call('p2p:reset-error')
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async speedTest ({ commit }, payload) {
    const resp = await call('p2p:speed-test', payload)
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async sendFile ({ commit }, payload) {
    const resp = await call('p2p:send-file', payload)
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async cancelFile ({ commit }, payload) {
    const resp = await call('p2p:cancel-file', payload)
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async pickReceiveDir ({ commit }) {
    const resp = await call('p2p:pick-receive-dir')
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  },
  async clearParts ({ commit }) {
    const resp = await call('p2p:clear-parts')
    if (resp.state) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
  }
}

export default {
  namespaced: true,
  state,
  mutations,
  actions
}
