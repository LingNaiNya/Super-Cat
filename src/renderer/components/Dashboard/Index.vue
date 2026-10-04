<template>
  <el-container class="main panel dashboard" direction="vertical">
    <el-header class="dashboard-header" height="84">
      <div class="header-title">
        <h4>{{ $t('dashboard.title') }}</h4>
        <p>{{ $t('dashboard.subtitle') }}</p>
      </div>
      <div class="header-actions">
        <el-tooltip effect="dark" placement="bottom" :content="$t('task.new-task')">
          <button type="button" class="action-icon" @click="onAddTask">
            <mo-icon name="menu-add" width="14" height="14" />
          </button>
        </el-tooltip>
        <el-tooltip effect="dark" placement="bottom" :content="$t('task.resume-all-task')">
          <button type="button" class="action-icon" @click="onResumeAll">
            <mo-icon name="dashboard-play-all" width="14" height="14" />
          </button>
        </el-tooltip>
        <el-tooltip effect="dark" placement="bottom" :content="$t('task.pause-all-task')">
          <button type="button" class="action-icon" @click="onPauseAll">
            <mo-icon name="dashboard-pause-all" width="14" height="14" />
          </button>
        </el-tooltip>
        <el-tooltip effect="dark" placement="bottom" :content="$t('dashboard.open-download-dir')">
          <button type="button" class="action-icon" @click="onOpenDownloadDir">
            <mo-icon name="dashboard-folder" width="14" height="14" />
          </button>
        </el-tooltip>
        <el-tooltip effect="dark" placement="bottom" :content="$t('task.refresh-list')">
          <button
            type="button"
            class="action-icon"
            :class="{ spinning: refreshing }"
            @click="onRefresh"
          >
            <mo-icon name="refresh" width="14" height="14" />
          </button>
        </el-tooltip>
      </div>
    </el-header>

    <el-main
      class="panel-content dashboard-content"
      :class="{ 'gear-burst-all': burstGear === 'Super' }"
    >
      <div class="dashboard-grid">
        <!-- Live speed -->
        <section
          class="dash-card speed-card"
          :class="{ 'mo-stagger-item': staggered }"
          style="--mo-enter-delay: 0ms;"
        >
          <header class="card-header">
            <span class="card-icon">
              <mo-icon name="speedometer" width="16" height="16" />
            </span>
            <div class="card-titles">
              <h5>{{ $t('dashboard.realtime-speed') }}</h5>
              <small>{{ liveLabel }}</small>
            </div>
            <span class="live-dot" :class="{ active: numActive > 0 }"></span>
          </header>

          <div class="card-body speed-body">
            <mo-speed-gauge :speed="downloadSpeed" :max="gaugeMax" />

            <div class="speed-meters">
              <div class="meter download">
                <i><mo-icon name="dashboard-download" width="16" height="16" /></i>
                <div class="meter-body">
                  <span class="meter-label">{{ $t('dashboard.download') }}</span>
                  <strong><mo-animated-number :value="downloadSpeed" :formatter="formatBytes" /></strong>
                </div>
              </div>
              <div class="meter upload">
                <i><mo-icon name="dashboard-upload" width="16" height="16" /></i>
                <div class="meter-body">
                  <span class="meter-label">{{ $t('dashboard.upload') }}</span>
                  <strong><mo-animated-number :value="uploadSpeed" :formatter="formatBytes" /></strong>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Speed limit gear switcher -->
        <section
          :class="[
            'dash-card', 'limit-card',
            {
              'mo-stagger-item': staggered,
              'burst-super': burstGear === 'Super',
              'burst-high': burstGear === 'High'
            }
          ]"
          style="--mo-enter-delay: 60ms;"
        >
          <!-- Ignition light welling up inside the card -->
          <span
            v-if="burstGear"
            class="gear-flash"
            aria-hidden="true"
          ></span>

          <header class="card-header">
            <span class="card-icon">
              <mo-icon name="speedometer" width="16" height="16" />
            </span>
            <div class="card-titles">
              <h5>{{ $t('dashboard.limit-mode') }}</h5>
            </div>
            <button
              class="limit-settings"
              type="button"
              :title="$t('dashboard.limit-settings')"
              @click="openLimitSettings"
            >
              <mo-icon name="settings" width="14" height="14" />
            </button>
          </header>

          <div class="card-body limit-body">
            <!-- Dial arc behind the controls: one segment per gear, the active
                 segment draws itself in and lights up — this is what fills the
                 card face and gives each switch a beat. -->
            <svg class="gear-dial" viewBox="0 0 240 132" aria-hidden="true">
              <path class="dial-base" d="M20 120 A100 100 0 0 1 220 120" />
              <path
                class="dial-seg seg-super"
                pathLength="100"
                :class="{ on: engineGear === 'Super' }"
                d="M20 120 A100 100 0 0 1 70 33.4"
              />
              <path
                class="dial-seg seg-high"
                pathLength="100"
                :class="{ on: engineGear === 'High' }"
                d="M70 33.4 A100 100 0 0 1 170 33.4"
              />
              <path
                class="dial-seg seg-low"
                pathLength="100"
                :class="{ on: engineGear === 'Low' }"
                d="M170 33.4 A100 100 0 0 1 220 120"
              />
              <circle
                class="dial-tick tick-super"
                :class="{ on: engineGear === 'Super' }"
                cx="33.4"
                cy="70"
                r="3"
              />
              <circle
                class="dial-tick tick-high"
                :class="{ on: engineGear === 'High' }"
                cx="120"
                cy="20"
                r="3"
              />
              <circle
                class="dial-tick tick-low"
                :class="{ on: engineGear === 'Low' }"
                cx="206.6"
                cy="70"
                r="3"
              />
            </svg>

            <div class="gear-row" :style="gearRowStyle">
              <!-- One shared highlight slides between the buttons, the same
                   idea as the rail indicator in the sidebar, but horizontal
                   and frosted: a tinted glass capsule, not a solid paint chip. -->
              <span
                v-show="engineGear"
                class="gear-indicator"
                :style="gearIndicatorStyle"
              ></span>
              <button
                v-for="gear in gears"
                :key="gear.id"
                type="button"
                :class="['gear-btn', { active: engineGear === gear.id }]"
                :title="$t(gear.title)"
                @click="setGear(gear.id)"
              >
                <mo-icon
                  :key="`${gear.id}-${engineGear === gear.id}`"
                  :name="gear.icon"
                  width="24"
                  height="24"
                />
                <!-- Shockwave rings, detonating from this gear's button -->
                <span
                  v-if="burstGear && gear.id === burstGear"
                  class="shocks"
                  aria-hidden="true"
                >
                  <i></i><i></i><i></i>
                </span>
                <!-- Exhaust plume, Super ignition only -->
                <span
                  v-if="burstGear === 'Super' && gear.id === 'Super'"
                  class="flames"
                  aria-hidden="true"
                >
                  <i v-for="n in 8" :key="n"></i>
                </span>
              </button>
            </div>

            <!-- in-out (no mode): the new label enters the instant the gear
                 flips; the old one fades in place behind it. The grid slot
                 stacks both while they overlap so nothing reflows. -->
            <div class="caption-slot">
              <transition name="gear-flip">
                <div class="gear-caption" :key="currentGearLabel">
                  <div class="gear-name">{{ currentGearLabel }}</div>
                  <div class="gear-detail">{{ gearDetailLabel }}</div>
                </div>
              </transition>
            </div>
          </div>
        </section>

        <!-- Engine and network -->
        <section
          class="dash-card engine-card"
          :class="{ 'mo-stagger-item': staggered }"
          style="--mo-enter-delay: 120ms;"
        >
          <header class="card-header">
            <span class="card-icon">
              <mo-icon name="dashboard-engine" width="16" height="16" />
            </span>
            <div class="card-titles">
              <h5>{{ $t('dashboard.engine') }}</h5>
              <small>aria2 {{ engineInfo.version || '-' }}</small>
            </div>
          </header>

          <ul class="engine-list">
            <li>
              <span>{{ $t('dashboard.engine-mode') }}</span>
              <strong>{{ engineMode }}</strong>
            </li>
            <li>
              <span>{{ $t('dashboard.connections') }}</span>
              <strong>{{ aggregate.connections }}</strong>
            </li>
            <li>
              <span>{{ $t('dashboard.peers') }}</span>
              <strong>{{ aggregate.numSeeders }}</strong>
            </li>
            <li>
              <span>{{ $t('dashboard.listen-port') }}</span>
              <strong>{{ listenPort }}</strong>
            </li>
            <li>
              <span>{{ $t('dashboard.dht') }}</span>
              <strong>{{ dhtEnabled ? $t('dashboard.enabled') : $t('dashboard.disabled') }}</strong>
            </li>
          </ul>

          <div class="feature-tags">
            <span v-for="feature in topFeatures" :key="feature" class="feature-tag">{{ feature }}</span>
          </div>
        </section>

        <!-- Storage -->
        <section
          class="dash-card disk-card"
          :class="{ 'mo-stagger-item': staggered }"
          style="--mo-enter-delay: 180ms;"
        >
          <header class="card-header">
            <span class="card-icon">
              <mo-icon name="dashboard-disk" width="16" height="16" />
            </span>
            <div class="card-titles">
              <h5>{{ $t('dashboard.storage') }}</h5>
              <small :title="downloadDirectory">{{ downloadDirectoryLabel }}</small>
            </div>
          </header>

          <template v-if="disk">
            <div class="disk-usage">
              <div class="disk-bar">
                <span class="disk-used" :style="{ width: `${Math.min(100, disk.usedRatio * 100)}%` }"></span>
              </div>
              <div class="disk-legend">
                <span>{{ $t('dashboard.used') }} {{ formatBytes(disk.used) }}</span>
                <span>{{ $t('dashboard.free') }} {{ formatBytes(disk.available) }}</span>
              </div>
            </div>
            <div class="disk-numbers">
              <div class="summary-item">
                <span>{{ $t('dashboard.volume-total') }}</span>
                <strong>{{ formatBytes(disk.total) }}</strong>
              </div>
              <div class="summary-item">
                <span>{{ $t('dashboard.volume') }}</span>
                <strong>{{ disk.volume || '-' }}</strong>
              </div>
            </div>
          </template>

          <div v-else class="disk-unknown">
            {{ $t('dashboard.disk-unknown') }}
          </div>

          <div class="pending-size">
            <span>{{ $t('dashboard.pending-size') }}</span>
            <strong>{{ formatBytes(pendingSize) }}</strong>
          </div>
        </section>

        <!-- Task categories -->
        <section
          class="dash-card types-card"
          :class="{ 'mo-stagger-item': staggered }"
          style="--mo-enter-delay: 240ms;"
        >
          <header class="card-header">
            <span class="card-icon">
              <mo-icon name="dashboard-connection" width="16" height="16" />
            </span>
            <div class="card-titles">
              <h5>{{ $t('dashboard.task-types') }}</h5>
              <!-- taskTotalLabel, not a raw $t here: `count` is i18next's
                   reserved plural key and the string interpolates {total},
                   so passing { count } printed a literal "{total}". -->
              <small>{{ taskTotalLabel }}</small>
            </div>
          </header>

          <ul class="types-list">
            <li v-for="item in typeItems" :key="item.key">
              <div class="type-head">
                <i :style="{ backgroundColor: item.color }"></i>
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
              </div>
              <div class="type-bar">
                <span :style="{ width: `${item.percent}%`, backgroundColor: item.color }"></span>
              </div>
            </li>
          </ul>
        </section>

        <!-- Trend runs last in the DOM on purpose: it spans every column, and
             a full-width card placed before the compact rows would force the
             grid to leave holes where the packs don't fill a line. -->
        <section
          class="dash-card trend-card"
          :class="{ 'mo-stagger-item': staggered }"
          style="--mo-enter-delay: 300ms;"
        >
          <header class="card-header">
            <span class="card-icon">
              <mo-icon name="dashboard-clock" width="16" height="16" />
            </span>
            <div class="card-titles">
              <h5>{{ $t('dashboard.speed-trend') }}</h5>
              <small>{{ $t('dashboard.last-24h') }}</small>
            </div>
            <el-tooltip effect="dark" placement="bottom" :content="$t('dashboard.clear-history')">
              <button type="button" class="action-icon small" @click="onClearHistory">
                <mo-icon name="delete" width="12" height="12" />
              </button>
            </el-tooltip>
          </header>

          <div class="card-body trend-body">
            <mo-speed-history-chart :series="speedHistory" />
          </div>

          <div class="trend-summary">
            <div class="summary-item">
              <span>{{ $t('dashboard.session-downloaded') }}</span>
              <strong><mo-animated-number :value="historySummary.downloaded" :formatter="formatBytes" /></strong>
            </div>
            <div class="summary-item">
              <span>{{ $t('dashboard.peak-speed') }}</span>
              <strong>{{ formatSpeed(historySummary.peakDownloadSpeed) }}</strong>
            </div>
            <div class="summary-item">
              <span>{{ $t('dashboard.average-speed') }}</span>
              <strong>{{ formatSpeed(historySummary.averageDownloadSpeed) }}</strong>
            </div>
            <div class="summary-item">
              <span>{{ $t('dashboard.session-duration') }}</span>
              <strong>{{ sessionDuration }}</strong>
            </div>
          </div>
        </section>
      </div>

      <!-- Whole-window ignition veil: a red vignette sweeping the app on a
           Super switch (fixed, so it also washes the chrome around the grid;
           pointer-events none, z below modals). -->
      <span
        v-if="burstGear === 'Super'"
        class="burst-veil"
        aria-hidden="true"
      ></span>
    </el-main>
  </el-container>
</template>

<script>
  import { mapState, mapGetters } from 'vuex'
  import { shell } from '@electron/remote'

  import { ADD_TASK_TYPE, ENGINE_GEARS } from '@shared/constants'
  import { bytesToSize } from '@shared/utils'
  import AnimatedNumber from '@/components/Dashboard/AnimatedNumber'
  import SpeedGauge from '@/components/Dashboard/SpeedGauge'
  import SpeedHistoryChart from '@/components/Dashboard/SpeedHistoryChart'
  import '@/components/Icons/speedometer'
  import '@/components/Icons/menu-task'
  import '@/components/Icons/menu-add'
  import '@/components/Icons/delete'
  import '@/components/Icons/refresh'
  import '@/components/Icons/dashboard-download'
  import '@/components/Icons/dashboard-upload'
  import '@/components/Icons/dashboard-disk'
  import '@/components/Icons/dashboard-engine'
  import '@/components/Icons/dashboard-connection'
  import '@/components/Icons/dashboard-clock'
  import '@/components/Icons/dashboard-actions'
  import '@/components/Icons/rocket'
  import '@/components/Icons/car'
  import '@/components/Icons/turtle'
  import '@/components/Icons/settings'

  /* Keeps the dial readable: it never shrinks below 1 MB/s and grows with
     the fastest sample seen so far. */
  const MIN_GAUGE_MAX = 1024 * 1024
  const DISK_REFRESH_INTERVAL = 30 * 1000
  const FEATURE_LIMIT = 6

  export default {
    name: 'mo-content-dashboard',
    components: {
      [AnimatedNumber.name]: AnimatedNumber,
      [SpeedGauge.name]: SpeedGauge,
      [SpeedHistoryChart.name]: SpeedHistoryChart
    },
    data () {
      return {
        diskTimer: null,
        gaugeMax: MIN_GAUGE_MAX,
        /* Card entrance stagger. One-shot: the class is dropped once the
           last card has landed, so a later burst animation (which borrows
           the same `animation` property) can never un-pause the entrance
           and replay it across the whole dashboard. */
        staggered: true,
        staggerTimer: null,
        /* Which gear's ignition burst is on stage (Super / High / null).
           Driven by the store signal, cleared once the animations finish. */
        burstGear: null,
        burstTimer: null
      }
    },
    computed: {
      ...mapState('app', {
        stat: state => state.stat,
        engineInfo: state => state.engineInfo,
        engineOptions: state => state.engineOptions
      }),
      ...mapState('preference', {
        config: state => state.config,
        gearBurst: state => state.gearBurst
      }),
      ...mapGetters('preference', ['engineMode', 'engineGear']),
      ...mapState('dashboard', {
        refreshing: state => state.refreshing,
        lastUpdated: state => state.lastUpdated,
        taskCount: state => state.taskCount,
        aggregate: state => state.aggregate,
        taskTypes: state => state.taskTypes,
        disk: state => state.disk,
        speedHistory: state => state.speedHistory,
        historySummary: state => state.historySummary
      }),
      downloadSpeed () {
        return Number(this.stat.downloadSpeed) || 0
      },
      uploadSpeed () {
        return Number(this.stat.uploadSpeed) || 0
      },
      numActive () {
        return Number(this.stat.numActive) || 0
      },
      downloadDirectory () {
        return this.config.defaultDownloadDirectory || ''
      },
      downloadDirectoryLabel () {
        const directory = this.downloadDirectory
        if (!directory) {
          return '-'
        }
        const parts = directory.split(/[\\/]/).filter(Boolean)
        return parts.length > 2
          ? `.../${parts.slice(-2).join('/')}`
          : directory
      },
      pendingSize () {
        const { totalLength, completedLength } = this.aggregate
        return Math.max(0, totalLength - completedLength)
      },
      gears () {
        return ENGINE_GEARS
      },
      /* Big caption under the buttons: the current gear's name; a custom
         limit typed into preferences shows the raw value instead. */
      currentGearLabel () {
        const gear = ENGINE_GEARS.find((item) => item.id === this.engineGear)
        if (gear) {
          return this.$t(gear.title)
        }
        return String(this.config.maxOverallDownloadLimit || '')
      },
      /* Small header readout: what the gear actually lets through. */
      gearDetailLabel () {
        const gear = ENGINE_GEARS.find((item) => item.id === this.engineGear)
        if (gear) {
          return gear.detail || this.$t('preferences.transfer-speed-unlimited')
        }
        return String(this.config.maxOverallDownloadLimit || '')
      },
      gearIndex () {
        const index = ENGINE_GEARS.findIndex((item) => item.id === this.engineGear)
        return index < 0 ? 0 : index
      },
      /* The row carries one colour channel: the glass capsule, its glow and
         the active icon all read --mo-indicator-rgb, so a gear switch is a
         single variable swap on top of the slide. */
      gearRowStyle () {
        const gear = ENGINE_GEARS.find((item) => item.id === this.engineGear)
        return {
          '--mo-indicator-rgb': gear
            ? `var(--mo-gear-${gear.id.toLowerCase()}-rgb)`
            : '0, 0, 0'
        }
      },
      gearIndicatorStyle () {
        return {
          transform: `translateX(${this.gearIndex * 60}px)`
        }
      },
      typeItems () {
        const { taskTypes, aggregate } = this
        const total = aggregate.totalTasks || 0
        const definitions = [
          { key: 'http', label: this.$t('dashboard.type-http'), color: 'var(--mo-primary)' },
          { key: 'bt', label: this.$t('dashboard.type-bt'), color: 'var(--mo-accent-cyan)' },
          { key: 'magnet', label: this.$t('dashboard.type-magnet'), color: 'var(--mo-accent-violet)' },
          { key: 'metalink', label: this.$t('dashboard.type-metalink'), color: 'var(--mo-accent-amber)' }
        ]

        return definitions.map((definition) => {
          const value = Number(taskTypes[definition.key]) || 0
          return {
            ...definition,
            value,
            percent: total > 0 ? (value / total) * 100 : 0
          }
        })
      },
      listenPort () {
        const options = this.engineOptions || {}
        return options.listenPort || '-'
      },
      dhtEnabled () {
        const features = (this.engineInfo && this.engineInfo.enabledFeatures) || []
        return features.includes('BitTorrent')
      },
      topFeatures () {
        const features = (this.engineInfo && this.engineInfo.enabledFeatures) || []
        const result = features.filter((feature) => feature !== 'BitTorrent')
        return result.slice(0, FEATURE_LIMIT)
      },
      sessionDuration () {
        const samples = this.speedHistory.filter((sample) => sample.hits > 0)
        if (samples.length === 0) {
          return '-'
        }

        const first = samples[0].time
        const seconds = Math.max(0, Math.floor((Date.now() - first) / 1000))
        return this.formatDuration(seconds)
      },
      liveLabel () {
        if (this.numActive > 0) {
          return this.$t('dashboard.active-tasks', { total: this.numActive })
        }
        return this.$t('dashboard.idle')
      },
      /**
       * `count` is a reserved option in i18next: it selects a pluralised key and
       * is then dropped from the interpolation, which left a literal `{count}`
       * on screen. The number is folded in here instead.
       */
      taskTotalLabel () {
        const template = this.$t('dashboard.task-total', { total: this.aggregate.totalTasks })
        return String(template).replace('{total}', String(this.aggregate.totalTasks))
      }
    },
    watch: {
      downloadSpeed (value) {
        if (value > this.gaugeMax) {
          this.gaugeMax = value * 1.2
        }
      },
      downloadDirectory (value) {
        this.refreshDisk(value)
      },
      /* Ignition signal from the store: raise the burst classes for ~0.9s,
         long enough for launch, shockwaves, recoil, flames and the flash. */
      gearBurst (val) {
        if (!val || !val.gear) {
          return
        }
        this.burstGear = val.gear
        clearTimeout(this.burstTimer)
        this.burstTimer = setTimeout(() => {
          this.burstGear = null
          this.burstTimer = null
        }, 900)
      }
    },
    methods: {
      setGear (gearId) {
        if (this.engineGear === gearId) {
          return
        }
        this.$store.dispatch('preference/setEngineGear', gearId)
      },
      openLimitSettings () {
        this.$router.push('/preference/basic')
      },
      formatBytes (value) {
        return bytesToSize(Number(value) || 0, 1)
      },
      formatSpeed (value) {
        return `${bytesToSize(Number(value) || 0, 1)}/s`
      },
      formatDuration (seconds) {
        const hours = Math.floor(seconds / 3600)
        const minutes = Math.floor((seconds % 3600) / 60)
        if (hours > 0) {
          return `${hours}${this.$t('app.hour')}${minutes}${this.$t('app.minute')}`
        }
        return `${minutes}${this.$t('app.minute')}`
      },
      refreshDisk (directory = this.downloadDirectory) {
        this.$store.dispatch('dashboard/fetchDiskSpace', directory)
      },
      onRefresh () {
        this.$store.dispatch('dashboard/fetchDashboard')
        this.$store.dispatch('app/fetchGlobalStat')
        this.$store.dispatch('app/fetchEngineInfo')
        this.refreshDisk()
      },
      onAddTask () {
        this.$store.dispatch('app/showAddTaskDialog', ADD_TASK_TYPE.URI)
      },
      onResumeAll () {
        this.$store.dispatch('task/resumeAllTask')
          .then(() => {
            this.$msg.success(this.$t('task.resume-all-task-success'))
          })
          .catch(() => {
            this.$msg.error(this.$t('task.resume-all-task-fail'))
          })
      },
      onPauseAll () {
        this.$store.dispatch('task/pauseAllTask')
          .then(() => {
            this.$msg.success(this.$t('task.pause-all-task-success'))
          })
          .catch(() => {
            this.$msg.error(this.$t('task.pause-all-task-fail'))
          })
      },
      onOpenDownloadDir () {
        const directory = this.downloadDirectory
        if (directory) {
          shell.openPath(directory)
        }
      },
      onClearHistory () {
        this.$store.dispatch('dashboard/clearSpeedHistory')
        this.$msg.success(this.$t('dashboard.clear-history-success'))
      }
    },
    created () {
      this.$store.dispatch('app/fetchEngineInfo')
      this.$store.dispatch('app/fetchEngineOptions')
    },
    mounted () {
      this.$store.dispatch('dashboard/startRefresh')
      this.refreshDisk()
      this.diskTimer = setInterval(() => this.refreshDisk(), DISK_REFRESH_INTERVAL)
      /* 300ms last delay + 300ms duration + margin: the entrance is over */
      this.staggerTimer = setTimeout(() => {
        this.staggered = false
        this.staggerTimer = null
      }, 700)
    },
    destroyed () {
      this.$store.dispatch('dashboard/stopRefresh')
      clearInterval(this.diskTimer)
      this.diskTimer = null
      clearTimeout(this.burstTimer)
      this.burstTimer = null
      clearTimeout(this.staggerTimer)
      this.staggerTimer = null
    }
  }
</script>

<style lang="scss">
.dashboard {
  overflow: hidden;

  .dashboard-header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    height: auto;
    box-sizing: border-box;
    padding: 44px 20px 16px;
    user-select: none;
  }

  .header-title {
    h4 {
      margin: 0;
      /* The reference board leads with a large, confident title — the old
         16px regular weight read as a panel caption, not a page heading. */
      font-size: 20px;
      font-weight: 600;
      line-height: 28px;
      letter-spacing: 0.01em;
      color: var(--mo-text-primary);
    }

    p {
      margin: 4px 0 0;
      font-size: 12px;
      line-height: 16px;
      color: var(--mo-text-secondary);
    }
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .action-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    cursor: pointer;
    border-radius: $mo-radius-sm;
    border: 1px solid var(--mo-glass-border);
    background-color: var(--mo-glass-background);
    color: var(--mo-text-regular);
    transition: $mo-transition-base;

    &:hover {
      color: var(--mo-primary);
      border-color: rgba(var(--mo-primary-rgb), 0.4);
      box-shadow: var(--mo-glass-shadow);
    }

    &:active {
      transform: scale($mo-press-scale);
    }

    &.small {
      width: 24px;
      height: 24px;
    }

    &.spinning svg {
      animation: mo-spin 0.9s linear infinite;
      transform-origin: center;
    }
  }

  .dashboard-content {
    padding: 0 20px 56px;
    overflow-y: auto;
    /* The cards are a grid inside a padded scroll container; without this the
       track can end up a few pixels wider than the padding box and the board
       scrolls sideways. */
    overflow-x: hidden;
  }

  /* Reference-inspired mosaic
  --------------------------
     Three tracks: the speed card sits wide next to status, the three
     list-like cards share the middle row, and the trend chart runs the full
     width at the bottom. Mixed spans are what make the board read as a
     designed grid instead of six equal tiles. Spans live on the card classes
     so the template keeps ownership of which card is which.
     `minmax(0, 1fr)` rather than `1fr` on purpose: a grid track defaults to
     `min-content` and a wide child would otherwise push the row past the
     container. */
  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    grid-auto-rows: minmax(236px, auto);
    gap: 20px;
    align-items: stretch;

    .speed-card {
      grid-column: span 2;
    }

    .trend-card {
      grid-column: 1 / -1;
    }
  }

  .dash-card {
    @include mo-glass-surface();
    @include mo-glass-sheen();
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 18px 20px;
    transition: box-shadow $mo-duration-fast $mo-ease-standard;

    &:hover {
      box-shadow: var(--mo-glass-shadow-hover);
    }
  }

  /* The body of a card grows so short and tall cards share one baseline */
  .card-body {
    flex: 1;
    min-height: 0;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }

  .card-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    flex: 0 0 auto;
    border-radius: $mo-radius-sm;
    color: var(--mo-primary);
    background-color: rgba(var(--mo-primary-rgb), 0.12);
  }

  .card-titles {
    flex: 1;
    min-width: 0;

    h5 {
      margin: 0;
      font-size: 14px;
      font-weight: 500;
      line-height: 20px;
      color: var(--mo-text-primary);
    }

    small {
      display: block;
      font-size: 11px;
      line-height: 16px;
      color: var(--mo-text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .live-dot {
    width: 8px;
    height: 8px;
    flex: 0 0 auto;
    border-radius: $mo-radius-pill;
    background-color: var(--mo-text-secondary);
    opacity: 0.5;

    &.active {
      opacity: 1;
      background-color: var(--mo-accent-green);
      box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.6);
      animation: mo-pulse-ring 1.8s $mo-ease-standard infinite;
    }
  }

  /* Speed card: stacked (dial above readouts) in the single-column layout,
     side by side as soon as the card spans multiple tracks — a full-width
     card with a small dial floating in the middle wastes the row. */
  .speed-body {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 12px;
  }

  @media only screen and (min-width: 768px) {
    .speed-body {
      flex-direction: row;
      align-items: center;
      gap: 24px;
    }

    .speed-body .mo-speed-gauge {
      flex: 0 1 260px;
      min-width: 180px;
    }

    .speed-meters {
      flex: 1 1 auto;
      min-width: 0;
    }
  }

  .speed-meters {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
  }

  .meter {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 10px 12px;
    border-radius: $mo-radius-md;
    border: 1px solid var(--mo-glass-border);
    background-color: var(--mo-glass-chrome-background);

    i {
      display: inline-flex;
      color: var(--mo-primary);
    }

    &.upload i {
      color: var(--mo-accent-cyan);
    }
  }

  .meter-body {
    min-width: 0;

    .meter-label {
      display: block;
      font-size: 11px;
      line-height: 14px;
      color: var(--mo-text-secondary);
    }

    strong {
      display: block;
      font-size: 13px;
      font-weight: 600;
      line-height: 18px;
      color: var(--mo-text-primary);
    }
  }

  /* Speed limit card: a dial arc fills the face; the gear row and the
     current-gear caption float on top of it as one centred group. */
  .limit-card {
    position: relative;
    overflow: hidden;
  }

  .limit-body {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;

    /* Everything but the dial must paint above it */
    > *:not(.gear-dial) {
      position: relative;
    }
  }

  /* Decorative half dial: three segments, one per gear. The active segment
     draws itself in on switch, so the empty card still reads as a speed
     instrument and every gear change lands with a beat. */
  .gear-dial {
    position: absolute;
    left: 50%;
    top: 50%;
    z-index: 0;
    width: min(88%, 300px);
    height: auto;
    transform: translate(-50%, -50%);
    pointer-events: none;

    .dial-base {
      fill: none;
      stroke: var(--mo-text-secondary);
      stroke-width: 2;
      stroke-linecap: round;
      opacity: 0.3;
    }

    .dial-seg {
      --mo-dash-total: 100;
      --mo-dash-offset: 0;
      fill: none;
      stroke-width: 3;
      stroke-linecap: round;
      stroke-dasharray: 100;
      stroke-dashoffset: 100;
      opacity: 0;
      transition: opacity $mo-duration-fast $mo-ease-standard;

      &.on {
        opacity: 1;
        animation: mo-dash-in $mo-duration-base $mo-ease-emphasized forwards;
      }
    }

    .seg-super {
      stroke: var(--mo-gear-super);
    }

    .seg-high {
      stroke: var(--mo-gear-high);
    }

    .seg-low {
      stroke: var(--mo-gear-low);
    }

    .dial-tick {
      fill: var(--mo-text-secondary);
      opacity: 0.35;
      transition: opacity $mo-duration-fast $mo-ease-standard,
        fill $mo-duration-fast $mo-ease-standard;

      &.on {
        opacity: 1;
      }
    }

    .tick-super.on {
      fill: var(--mo-gear-super);
    }

    .tick-high.on {
      fill: var(--mo-gear-high);
    }

    .tick-low.on {
      fill: var(--mo-gear-low);
    }
  }

  .gear-row {
    position: relative;
    display: flex;
    gap: 12px;
    /* Inline from gearRowStyle; SCSS fallback keeps rgba() parseable */
    --mo-indicator-rgb: 0, 0, 0;
  }

  /* Shared highlight, rail-indicator style: slides horizontally between the
     buttons — but as frosted glass: a tinted, blurred capsule with a colour
     glow instead of a solid paint chip. */
  .gear-indicator {
    position: absolute;
    left: 0;
    top: 0;
    box-sizing: border-box;
    width: 48px;
    height: 48px;
    border: 1px solid rgba(var(--mo-indicator-rgb), 0.42);
    border-radius: $mo-radius-md;
    background-color: rgba(var(--mo-indicator-rgb), 0.16);
    backdrop-filter: blur($mo-blur-md) saturate(var(--mo-glass-saturate));
    -webkit-backdrop-filter: blur($mo-blur-md) saturate(var(--mo-glass-saturate));
    box-shadow: 0 6px 18px rgba(var(--mo-indicator-rgb), 0.3),
      inset 0 1px 0 rgba(255, 255, 255, 0.28);
    transition: transform $mo-duration-base $mo-ease-emphasized,
      background-color $mo-duration-base $mo-ease-standard,
      border-color $mo-duration-base $mo-ease-standard,
      box-shadow $mo-duration-base $mo-ease-standard;
  }

  .gear-btn {
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    padding: 0;
    box-sizing: border-box;
    border: none;
    border-radius: $mo-radius-md;
    background-color: transparent;
    color: var(--mo-text-secondary);
    cursor: pointer;
    transition: $mo-transition-base;

    &:hover {
      color: var(--mo-text-primary);
      transform: translateY(-1px);
    }

    &:active {
      transform: translateY(0) scale($mo-press-scale);
    }

    &.active {
      /* On the glass capsule the icon takes the gear's own colour rather
         than white — white only worked when the capsule was solid paint. */
      color: rgb(var(--mo-indicator-rgb));

      &:hover {
        color: rgb(var(--mo-indicator-rgb));
      }

      /* Re-mounting the icon via :key replays this pop on every switch. */
      svg {
        animation: mo-gear-pop $mo-duration-fast $mo-ease-overshoot;
      }
    }
  }

  /* Both captions share one grid cell during the in-out overlap, so the
     outgoing label fades in place without pushing the incoming one. */
  .caption-slot {
    display: grid;

    > * {
      grid-area: 1 / 1;
    }
  }

  .gear-caption {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .gear-name {
    font-size: 20px;
    font-weight: 600;
    line-height: 26px;
    color: var(--mo-text-primary);
  }

  .gear-detail {
    font-size: 12px;
    line-height: 16px;
    color: var(--mo-text-secondary);
  }

  /* ── Ignition burst ───────────────────────────────────────────────
     Raised for ~0.9s when the switch lands on Super (full show) or High
     (shockwave + flash). Colour channel --burst-rgb feeds every piece. */
  .limit-card {
    &.burst-super,
    &.burst-high {
      /* Lift above sibling cards so the shockwaves can sweep past the
         edge instead of being clipped or painted underneath them. */
      z-index: 5;
      overflow: visible;
    }

    &.burst-super {
      --burst-rgb: var(--mo-gear-super-rgb);
    }

    &.burst-high {
      --burst-rgb: var(--mo-gear-high-rgb);
    }
  }

  /* The limit card gets recoil AND the dashboard-wide flash in one
     animation list (same element, different properties — they must share
     one declaration or the higher-specificity rule would drop the flash).
     Out-specifies the plain .dash-card flash rule below. */
  .dashboard-content.gear-burst-all .limit-card.burst-super {
    animation: mo-gear-recoil 0.55s $mo-ease-emphasized,
      mo-gear-allflash 0.9s $mo-ease-standard;
  }

  /* Ignition light, painted under the controls (it is the first child, so
     same-z siblings still sit on top of it): a white-hot core inside a
     wide gear-coloured bloom. */
  .gear-flash {
    position: absolute;
    inset: 0;
    z-index: 0;
    opacity: 0;
    pointer-events: none;
    background:
      radial-gradient(
        circle at 50% 60%,
        rgba(255, 255, 255, 0.55),
        rgba(255, 255, 255, 0) 26%
      ),
      radial-gradient(
        circle at 50% 62%,
        rgba(var(--burst-rgb), 0.68),
        rgba(var(--burst-rgb), 0) 66%
      );
    animation: mo-gear-flash 0.8s $mo-ease-standard forwards;
  }

  /* Shockwave rings: three real elements mounted on the active button so
     every ignition re-mounts and replays them from scratch. */
  .shocks {
    position: absolute;
    inset: -6px;
    z-index: 3;
    pointer-events: none;

    i {
      position: absolute;
      inset: 0;
      opacity: 0;
      border: 3px solid rgb(var(--burst-rgb, 0, 0, 0));
      border-radius: $mo-radius-lg;
      animation: mo-gear-shock 0.7s $mo-ease-standard;

      &:nth-child(2) {
        animation-delay: 0.12s;
      }

      &:nth-child(3) {
        animation-delay: 0.24s;
      }
    }
  }

  /* Super only: the rocket charges and launches out of the button.
     Beats the plain active-pop rule (higher specificity). */
  .limit-card.burst-super .gear-btn.active svg {
    animation: mo-gear-launch 0.7s $mo-ease-emphasized;
  }

  /* Super only: exhaust plume under the rocket */
  .flames {
    position: absolute;
    left: 50%;
    bottom: 7px;
    width: 0;
    height: 0;
    z-index: 4;
    pointer-events: none;

    i {
      position: absolute;
      left: 0;
      top: 0;
      width: 8px;
      height: 12px;
      margin: -5px 0 0 -4px;
      border-radius: 50% 50% 50% 50% / 62% 62% 38% 38%;
      background: linear-gradient(180deg, #ffe08a, #ff5d57);
      opacity: 0;
      animation: mo-gear-flame 0.55s ease-out forwards;
    }

    i:nth-child(1) { --flame-x: -14px; animation-delay: 0s; }
    i:nth-child(2) { --flame-x: -7px; animation-delay: 0.07s; }
    i:nth-child(3) { --flame-x: 1px; animation-delay: 0.02s; }
    i:nth-child(4) { --flame-x: 8px; animation-delay: 0.11s; }
    i:nth-child(5) { --flame-x: 14px; animation-delay: 0.05s; }
    i:nth-child(6) { --flame-x: -3px; animation-delay: 0.15s; }
    i:nth-child(7) { --flame-x: 4px; animation-delay: 0.09s; }
    i:nth-child(8) { --flame-x: -10px; animation-delay: 0.18s; }
  }

  /* Super ignition: every card on the dashboard takes the red tint and
     throws an outer halo once. The limit card opts into this animation
     through its own combined declaration (above) so it keeps the recoil. */
  .dashboard-content.gear-burst-all .dash-card {
    animation: mo-gear-allflash 0.9s $mo-ease-standard;
  }

  /* Whole-window red vignette washing over the app once */
  .burst-veil {
    position: fixed;
    inset: 0;
    z-index: 40;
    pointer-events: none;
    background: radial-gradient(
      ellipse at 50% 45%,
      rgba(255, 93, 87, 0) 40%,
      rgba(255, 93, 87, 0.2) 76%,
      rgba(255, 93, 87, 0.36) 100%
    );
    animation: mo-gear-veil 0.9s $mo-ease-standard forwards;
  }

  /* Caption lands with a coloured echo of the new gear */
  .limit-card.burst-super .gear-name,
  .limit-card.burst-high .gear-name {
    animation: mo-gear-caption-glow 0.9s $mo-ease-standard;
  }

  .limit-settings {
    margin-left: auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    flex-shrink: 0;
    border: none;
    border-radius: $mo-radius-pill;
    background-color: transparent;
    color: var(--mo-text-secondary);
    cursor: pointer;
    transition: $mo-transition-fast;

    &:hover {
      color: var(--mo-primary);
      background-color: rgba(var(--mo-primary-rgb), 0.12);
    }
  }

  /* Storage card readouts keep the two column rhythm, the trend readouts are
     laid out with the rest of that card's rules. */
  .disk-numbers {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
    margin-top: 14px;
  }

  .summary-item {
    min-width: 0;
    padding: 8px 10px;
    border-radius: $mo-radius-sm;
    background-color: var(--mo-glass-chrome-background);

    span {
      display: block;
      font-size: 11px;
      line-height: 15px;
      color: var(--mo-text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    strong {
      display: block;
      margin-top: 2px;
      font-size: 13px;
      font-weight: 600;
      color: var(--mo-text-primary);
    }
  }

  /* Engine card */
  .engine-list {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 12px;

    li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px dashed var(--mo-glass-border);

      &:last-child {
        border-bottom: none;
      }

      span {
        color: var(--mo-text-secondary);
      }

      strong {
        color: var(--mo-text-primary);
        font-weight: 500;
      }
    }
  }

  .feature-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }

  .feature-tag {
    padding: 2px 8px;
    font-size: 11px;
    line-height: 16px;
    border-radius: $mo-radius-pill;
    color: var(--mo-primary);
    background-color: rgba(var(--mo-primary-rgb), 0.12);
  }

  /* Storage card */
  .disk-usage {
    .disk-bar {
      position: relative;
      height: 8px;
      border-radius: $mo-radius-pill;
      overflow: hidden;
      background-color: var(--mo-glass-border);
    }

    .disk-used {
      display: block;
      height: 100%;
      border-radius: $mo-radius-pill;
      background-image: linear-gradient(90deg, var(--mo-accent-cyan), var(--mo-primary));
      transition: width $mo-duration-slow $mo-ease-emphasized;
    }
  }

  .disk-legend {
    display: flex;
    justify-content: space-between;
    margin-top: 6px;
    font-size: 11px;
    color: var(--mo-text-secondary);
  }

  .disk-unknown {
    padding: 10px 12px;
    font-size: 12px;
    border-radius: $mo-radius-sm;
    color: var(--mo-text-secondary);
    background-color: var(--mo-glass-chrome-background);
  }

  .pending-size {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 12px;
    padding: 8px 10px;
    font-size: 12px;
    border-radius: $mo-radius-sm;
    background-color: var(--mo-glass-chrome-background);

    span {
      color: var(--mo-text-secondary);
    }

    strong {
      color: var(--mo-text-primary);
      font-weight: 600;
    }
  }

  /* Types card */
  .types-list {
    list-style: none;
    margin: 0;
    padding: 0;

    li {
      margin-bottom: 12px;

      &:last-child {
        margin-bottom: 0;
      }
    }
  }

  .type-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--mo-text-secondary);

    i {
      width: 8px;
      height: 8px;
      border-radius: $mo-radius-pill;
    }

    span {
      flex: 1;
    }

    strong {
      color: var(--mo-text-primary);
      font-weight: 500;
    }
  }

  .type-bar {
    position: relative;
    height: 6px;
    margin-top: 6px;
    border-radius: $mo-radius-pill;
    overflow: hidden;
    background-color: var(--mo-glass-border);

    span {
      display: block;
      height: 100%;
      border-radius: $mo-radius-pill;
      transition: width $mo-duration-slow $mo-ease-emphasized;
    }
  }

  /* Trend card: the chart fills the cell, the four readouts sit in a row under
     it. Two columns on a narrow card, four when there is room. */
  .trend-body {
    flex: 1;
    min-height: 0;
  }

  .trend-summary {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin-top: 12px;
  }

  /* The trend card always spans the grid now, so its four readouts can sit
     in one row from modest window widths up. */
  @media only screen and (min-width: 900px) {
    .trend-summary {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }
  }

  /* Three tracks need ~240px each to breathe; below that drop to two. The
     spans still tile without holes here: speed fills a row alone, status and
     engine pair up, disk and types pair up, trend stays full width. */
  @media only screen and (max-width: 1099px) {
    .dashboard-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  /* Single column: `span 2` / `1 / -1` would fight the lone track. */
  @media only screen and (max-width: 767px) {
    .dashboard-grid {
      grid-template-columns: minmax(0, 1fr);

      .speed-card,
      .trend-card {
        grid-column: auto;
      }
    }

    .speed-meters,
    .trend-summary {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  /* Page inset. The board sits well inside the window on both sides, and the
     left inset is deliberately the same measurement as the right one so the
     grid reads as centred between the rail and the window edge. It loosens
     further once the window is wide enough to afford it. */
  @media only screen and (min-width: 568px) {
    .dashboard-header {
      padding-left: 80px;
      padding-right: 80px;
    }

    .dashboard-content {
      padding-left: 80px;
      padding-right: 80px;
      padding-bottom: 64px;
    }
  }

  @media only screen and (min-width: 1280px) {
    .dashboard-header {
      padding-left: 96px;
      padding-right: 96px;
    }

    .dashboard-content {
      padding-left: 96px;
      padding-right: 96px;
    }
  }
}
</style>
