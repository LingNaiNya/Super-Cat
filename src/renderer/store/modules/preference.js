import { isEmpty } from 'lodash'

import api from '@/api'
import {
  getLangDirection,
  pushItemToFixedLengthArray,
  removeArrayItem
} from '@shared/utils'
import { fetchBtTrackerFromSource } from '@shared/utils/tracker'
import { MAX_NUM_OF_DIRECTORIES, ENGINE_GEARS } from '@shared/constants'

const state = {
  config: {},
  /* Transient ignition signal: { gear, at }. Committed the moment a gear
     switch lands; the dashboard card and the speedometer watch it and run
     their burst animations for ~0.9s. */
  gearBurst: null
}

const getters = {
  theme: state => state.config.theme,
  locale: state => state.config.locale,
  direction: state => getLangDirection(state.config.locale),
  /* The active speed-limiter gear, derived from the saved download limit
     so the dashboard card, the speedometer and the engine can never
     disagree: 0/unset -> MAX, exact match -> that gear, anything else
     (a hand-typed value in preferences) -> null. */
  engineGear (state) {
    const raw = state.config.maxOverallDownloadLimit
    const limit = raw === undefined || raw === null || raw === '' ? 0 : raw
    const gear = ENGINE_GEARS.find((item) => String(item.limit) === String(limit))
    return gear ? gear.id : null
  },
  /* What the speedometer prints: the gear name, or the raw limit for a
     custom value. */
  engineMode (state, getters) {
    if (getters.engineGear) {
      return getters.engineGear
    }
    return String(state.config.maxOverallDownloadLimit || 'Super')
  }
}

const mutations = {
  UPDATE_PREFERENCE_DATA (state, config) {
    state.config = { ...state.config, ...config }
  },
  GEAR_BURST (state, gear) {
    state.gearBurst = { gear, at: Date.now() }
  }
}

const actions = {
  fetchPreference ({ dispatch }) {
    return new Promise((resolve) => {
      api.fetchPreference()
        .then((config) => {
          dispatch('updatePreference', config)
          resolve(config)
        })
    })
  },
  save ({ dispatch }, config) {
    dispatch('task/saveSession', null, { root: true })
    if (isEmpty(config)) {
      return
    }

    dispatch('updatePreference', config)
    return api.savePreference(config)
  },
  recordHistoryDirectory ({ state, dispatch }, directory) {
    const { historyDirectories = [], favoriteDirectories = [] } = state.config
    const all = new Set([...historyDirectories, ...favoriteDirectories])
    if (all.has(directory)) {
      return
    }

    dispatch('addHistoryDirectory', directory)
  },
  addHistoryDirectory ({ state, dispatch }, directory) {
    const { historyDirectories = [] } = state.config
    const history = pushItemToFixedLengthArray(
      historyDirectories,
      MAX_NUM_OF_DIRECTORIES,
      directory
    )

    dispatch('save', { historyDirectories: history })
  },
  favoriteDirectory ({ state, dispatch }, directory) {
    const { historyDirectories = [], favoriteDirectories = [] } = state.config
    if (favoriteDirectories.includes(directory) ||
      favoriteDirectories.length >= MAX_NUM_OF_DIRECTORIES
    ) {
      return
    }

    const favorite = pushItemToFixedLengthArray(
      favoriteDirectories,
      MAX_NUM_OF_DIRECTORIES,
      directory
    )
    const history = removeArrayItem(historyDirectories, directory)

    dispatch('save', {
      historyDirectories: history,
      favoriteDirectories: favorite
    })
  },
  cancelFavoriteDirectory ({ state, dispatch }, directory) {
    const { historyDirectories = [], favoriteDirectories = [] } = state.config
    if (historyDirectories.includes(directory)) {
      return
    }

    const favorite = removeArrayItem(favoriteDirectories, directory)

    const history = pushItemToFixedLengthArray(
      historyDirectories,
      MAX_NUM_OF_DIRECTORIES,
      directory
    )

    dispatch('save', {
      historyDirectories: history,
      favoriteDirectories: favorite
    })
  },
  removeDirectory ({ state, dispatch }, directory) {
    const { historyDirectories = [], favoriteDirectories = [] } = state.config

    const favorite = removeArrayItem(favoriteDirectories, directory)
    const history = removeArrayItem(historyDirectories, directory)

    dispatch('save', {
      historyDirectories: history,
      favoriteDirectories: favorite
    })
  },
  updateThemeConfig ({ dispatch }, theme) {
    dispatch('updatePreference', { theme })
  },
  updatePreference  ({ commit }, config) {
    commit('UPDATE_PREFERENCE_DATA', config)
  },
  fetchBtTracker (_, trackerSource = []) {
    return fetchBtTrackerFromSource(trackerSource)
  },
  /* Applies a gear by writing its limit through the normal preference
     save path — main process persists it and pushes it to aria2 as a
     global option. Re-selecting the current gear is a no-op (no save, no
     burst); a real switch commits the ignition signal first so every view
     (dashboard card, speedometer) can celebrate it together. */
  setEngineGear ({ getters, commit, dispatch }, gearId) {
    const gear = ENGINE_GEARS.find((item) => item.id === gearId)
    if (!gear || getters.engineGear === gear.id) {
      return Promise.resolve()
    }
    /* Low keeps the quiet treatment (slide + pop + dial draw); only the
       loud gears raise the ignition signal. */
    if (gear.id === 'Super' || gear.id === 'High') {
      commit('GEAR_BURST', gear.id)
    }
    return dispatch('save', { maxOverallDownloadLimit: gear.limit })
  },
  /* Speedometer click: cycle Super -> High -> Low -> Super. */
  toggleEngineMode ({ getters, dispatch }) {
    const ids = ENGINE_GEARS.map((item) => item.id)
    const next = ids[(ids.indexOf(getters.engineGear) + 1) % ids.length]
    return dispatch('setEngineGear', next)
  }
}

export default {
  namespaced: true,
  state,
  getters,
  mutations,
  actions
}
