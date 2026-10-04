<template>
  <div class="mo-speed-history">
    <div class="history-chart">
      <div class="chart-grid">
        <span v-for="line in 3" :key="`line-${line}`" :style="{ bottom: `${line * 25}%` }"></span>
      </div>
      <div class="chart-bars">
        <div
          v-for="(sample, index) in series"
          :key="`slot-${sample.t}`"
          class="chart-bar"
          :class="{ current: sample.current, empty: !sample.downloadSpeed }"
          :style="barStyle(sample, index)"
        >
          <span class="bar-fill"></span>
          <span class="bar-tooltip">
            {{ sample.label }} · {{ formatSpeed(sample.downloadSpeed) }}
          </span>
        </div>
      </div>
      <div class="chart-labels">
        <span
          v-for="tick in labelTicks"
          :key="`label-${tick.index}`"
          :style="{ left: `${(tick.index / series.length) * 100}%` }"
        >{{ tick.label }}</span>
      </div>
    </div>
    <div class="history-legend">
      <span class="legend-item">
        <i class="legend-dot download"></i>
        {{ $t('dashboard.download') }} {{ formatSpeed(peak) }}
      </span>
      <span class="legend-item">
        <i class="legend-dot upload"></i>
        {{ $t('dashboard.upload') }} {{ formatSpeed(peakUpload) }}
      </span>
    </div>
  </div>
</template>

<script>
  import { bytesToSize } from '@shared/utils'

  export default {
    name: 'mo-speed-history-chart',
    props: {
      series: {
        type: Array,
        default: () => []
      }
    },
    computed: {
      peak () {
        return this.series.reduce((max, sample) => Math.max(max, sample.downloadSpeed), 0)
      },
      peakUpload () {
        return this.series.reduce((max, sample) => Math.max(max, sample.uploadSpeed), 0)
      },
      labelTicks () {
        const { series } = this
        if (series.length === 0) {
          return []
        }

        const step = 12
        const result = []
        for (let index = 0; index < series.length; index += step) {
          result.push({
            index,
            label: series[index].label
          })
        }
        return result
      }
    },
    methods: {
      formatSpeed (value) {
        return `${bytesToSize(value, 1)}/s`
      },
      barStyle (sample, index) {
        const peak = this.peak
        const ratio = peak > 0 ? sample.downloadSpeed / peak : 0
        // Keep a visible stub so an idle hour still reads as "no traffic"
        // instead of as missing data.
        const height = sample.downloadSpeed > 0 ? Math.max(4, ratio * 100) : 0
        return {
          height: `${height}%`,
          '--mo-enter-delay': `${Math.min(index * 6, 320)}ms`
        }
      }
    }
  }
</script>

<style lang="scss">
.mo-speed-history {
  .history-chart {
    position: relative;
    height: 196px;
    padding-bottom: 20px;
  }

  .chart-grid {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 20px;
    pointer-events: none;

    span {
      position: absolute;
      left: 0;
      right: 0;
      height: 1px;
      background-image: linear-gradient(
        90deg,
        var(--mo-glass-border),
        transparent
      );
      opacity: 0.6;
    }
  }

  .chart-bars {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 20px;
    display: flex;
    align-items: flex-end;
    gap: 1px;
  }

  .chart-bar {
    position: relative;
    flex: 1 1 0;
    min-width: 2px;
    display: flex;
    align-items: flex-end;
    border-radius: $mo-radius-xs $mo-radius-xs 0 0;
    transition: background-color $mo-duration-fast $mo-ease-standard;

    .bar-fill {
      width: 100%;
      height: 100%;
      border-radius: $mo-radius-xs $mo-radius-xs 0 0;
      background-image: linear-gradient(
        180deg,
        var(--mo-primary),
        rgba(var(--mo-primary-rgb), 0.35)
      );
      transform-origin: bottom center;
      animation: mo-grow-up $mo-duration-slow $mo-ease-emphasized both;
      animation-delay: var(--mo-enter-delay, 0ms);
    }

    &.current .bar-fill {
      background-image: linear-gradient(180deg, var(--mo-accent-cyan), var(--mo-primary));
      box-shadow: 0 0 12px rgba(var(--mo-primary-rgb), 0.5);
    }

    &.empty .bar-fill {
      background-image: none;
      background-color: var(--mo-glass-border);
      opacity: 0.7;
    }

    &:hover {
      background-color: rgba(var(--mo-primary-rgb), 0.08);

      .bar-tooltip {
        opacity: 1;
        transform: translate(-50%, 0);
      }
    }
  }

  .bar-tooltip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    z-index: 4;
    padding: 4px 8px;
    white-space: nowrap;
    font-size: 11px;
    line-height: 16px;
    border-radius: $mo-radius-xs;
    color: var(--mo-text-primary);
    background-color: var(--mo-glass-overlay-background);
    border: 1px solid var(--mo-glass-border-strong);
    box-shadow: var(--mo-glass-shadow);
    backdrop-filter: blur($mo-blur-sm);
    -webkit-backdrop-filter: blur($mo-blur-sm);
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, 4px);
    transition: opacity $mo-duration-fast $mo-ease-standard,
      transform $mo-duration-fast $mo-ease-standard;
  }

  .chart-labels {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 16px;

    span {
      position: absolute;
      top: 0;
      font-size: 10px;
      line-height: 16px;
      color: var(--mo-text-secondary);
      opacity: 0.75;
      transform: translateX(-50%);
    }

    span:first-child {
      transform: none;
    }
  }

  .history-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    margin-top: 12px;
    font-size: 12px;
    color: var(--mo-text-secondary);
  }

  .legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: $mo-radius-pill;

    &.download {
      background-image: linear-gradient(180deg, var(--mo-primary), rgba(var(--mo-primary-rgb), 0.4));
    }

    &.upload {
      background-image: linear-gradient(180deg, var(--mo-accent-cyan), rgba(34, 211, 238, 0.4));
    }
  }
}
</style>
