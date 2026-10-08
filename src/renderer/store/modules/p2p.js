import { ipcRenderer } from 'electron'

const state = {
  loaded: false,
  status: 'idle',
  role: '',
  enabled: false,
  self: { fp: '', name: '', vip: null },
  group: { gid: null, name: '', code: null, codeText: null },
  endpoint: { h: null, p: null, source: 'none', mapped: false, lanOnly: false, warning: null, listenPort: 0 },
  members: [],
  pending: [],
  links: {},
  speed: {},
  settings: { openPorts: [], receiveTaskPush: true, vipForward: true, manualEndpoint: null },
  forward: { enabled: true, listeners: 0, conflicts: [] },
  punch: { last: null, target: null, ts: 0 },
  lastError: null
}

const mutations = {
  UPDATE_STATE (state, payload) {
    if (!payload) {
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
    const resp = await ipcRenderer.invoke('p2p:get-state')
    if (resp && resp.ok) {
      commit('UPDATE_STATE', resp.state)
    }
    return resp
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
  }
}

export default {
  namespaced: true,
  state,
  mutations,
  actions
}
