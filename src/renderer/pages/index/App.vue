<template>
  <div id="app" :class="platformClass">
    <mo-title-bar
      v-if="isRenderer"
      :showActions="showWindowActions"
    />
    <transition
      name="page"
      mode="out-in"
      appear
    >
      <!-- No `:key` here on purpose. Keying by route forced a full remount on
           every navigation, which discarded the page component and replayed its
           entrance animation, so switching tabs felt heavy. The router now
           reuses the component and only the route data changes. -->
      <router-view class="page-view" />
    </transition>
    <mo-engine-client
      :secret="rpcSecret"
    />
    <mo-ipc v-if="isRenderer" />
    <mo-dynamic-tray v-if="enableTraySpeedometer" />
  </div>
</template>

<script>
  import is from 'electron-is'
  import { mapGetters, mapState } from 'vuex'
  import { APP_RUN_MODE, APP_THEME } from '@shared/constants'
  import DynamicTray from '@/components/Native/DynamicTray'
  import EngineClient from '@/components/Native/EngineClient'
  import Ipc from '@/components/Native/Ipc'
  import TitleBar from '@/components/Native/TitleBar'

  export default {
    name: 'motrix-app',
    components: {
      [DynamicTray.name]: DynamicTray,
      [EngineClient.name]: EngineClient,
      [Ipc.name]: Ipc,
      [TitleBar.name]: TitleBar
    },
    computed: {
      isMac: () => is.macOS(),
      isRenderer: () => is.renderer(),
      platformClass () {
        const platform = is.macOS()
          ? 'macos'
          : (is.windows() ? 'windows' : 'linux')
        return [`app-platform-${platform}`]
      },
      ...mapState('app', {
        systemTheme: state => state.systemTheme
      }),
      ...mapState('preference', {
        showWindowActions: state => {
          return (is.windows() || is.linux()) && state.config.hideAppMenu
        },
        runMode: state => state.config.runMode,
        traySpeedometer: state => state.config.traySpeedometer,
        rpcSecret: state => state.config.rpcSecret
      }),
      ...mapGetters('preference', [
        'theme',
        'locale',
        'direction'
      ]),
      themeClass () {
        if (this.theme === APP_THEME.AUTO) {
          return `theme-${this.systemTheme}`
        } else {
          return `theme-${this.theme}`
        }
      },
      i18nClass () {
        return `i18n-${this.locale}`
      },
      directionClass () {
        return `dir-${this.direction}`
      },
      enableTraySpeedometer () {
        const { isMac, isRenderer, traySpeedometer, runMode } = this
        return isMac && isRenderer && traySpeedometer && runMode !== APP_RUN_MODE.HIDE_TRAY
      }
    },
    methods: {
      updateRootClassName () {
        const { themeClass = '', i18nClass = '', directionClass = '' } = this
        // platformClass is an array — coerce with join, not interpolation,
        // or it lands as one comma-joined token that no selector can match.
        const platform = [].concat(this.platformClass || []).filter(Boolean).join(' ')
        // Platform classes must live on <html> as well: theme rules like
        // `.app-platform-* body` are written as descendants of those classes
        // and never matched while the classes only sat on #app itself.
        const className = `${themeClass} ${i18nClass} ${directionClass} ${platform}`
        document.documentElement.className = className.trim().replace(/\s+/g, ' ')
      }
    },
    beforeMount () {
      this.updateRootClassName()
    },
    watch: {
      themeClass (val, oldVal) {
        this.updateRootClassName()
      },
      i18nClass (val, oldVal) {
        this.updateRootClassName()
      },
      directionClass (val, oldVal) {
        this.updateRootClassName()
      }
    }
  }
</script>
