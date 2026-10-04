<template>
  <div class="mo-speed-gauge" :class="{ idle: currentSpeed <= 0 }">
    <svg class="gauge-svg" :viewBox="viewBox" role="presentation">
      <defs>
        <linearGradient :id="gradientId" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" :stop-color="startColor" />
          <stop offset="100%" :stop-color="endColor" />
        </linearGradient>
      </defs>

      <!-- Dial -->
      <g class="gauge-ticks">
        <line
          v-for="tick in ticks"
          :key="`tick-${tick.angle}`"
          :x1="tick.x1"
          :y1="tick.y1"
          :x2="tick.x2"
          :y2="tick.y2"
          :class="`tick-${tick.level}`"
        />
      </g>

      <!-- Track and progress arc -->
      <path class="gauge-track" :d="trackPath" :stroke-width="strokeWidth" />
      <path
        class="gauge-progress"
        :d="trackPath"
        :stroke="`url(#${gradientId})`"
        :stroke-width="strokeWidth"
        :style="progressStyle"
      />

      <!-- Needle -->
      <g class="gauge-needle" :style="needleStyle">
        <line
          :x1="hubX"
          :y1="hubY"
          :x2="hubX"
          :y2="tipY"
          :stroke="needleColor"
          stroke-width="2"
          stroke-linecap="round"
        />
        <circle :cx="hubX" :cy="hubY" r="4.6" :fill="needleColor" />
        <circle :cx="hubX" :cy="hubY" r="1.8" class="needle-core" />
      </g>

      <!-- Readout: plain SVG text below the dial, so it can never collide with
           the needle and never depends on the host layout. One unit is one
           pixel of the viewBox. -->
      <g class="gauge-readout" text-anchor="middle">
        <text class="gauge-value" :x="hubX" y="150">{{ valueText }}</text>
        <text class="gauge-unit" :x="hubX" y="159">bytes/s</text>
        <text class="gauge-scale" :x="hubX" y="167">0 - {{ scaleLabel }}</text>
      </g>
    </svg>
  </div>
</template>

<script>
  import { bytesToSize } from '@shared/utils'

  /* Dial geometry, in viewBox units. The arc spans 240 degrees with the gap
     facing downwards, which is the classic speedometer silhouette. */
  const START_ANGLE = 150
  const END_ANGLE = 390
  const SWEEP = END_ANGLE - START_ANGLE

  const HUB_X = 100
  const HUB_Y = 80
  const ARC_RADIUS = 36
  const TICK_RADIUS = 41
  const NEEDLE_TIP_Y = 56

  const VIEW_BOX = '0 0 200 190'

  let uid = 0

  const polar = (cx, cy, radius, angle) => {
    const rad = (angle * Math.PI) / 180
    return {
      x: cx + radius * Math.sin(rad),
      y: cy - radius * Math.cos(rad)
    }
  }

  const arcPath = (cx, cy, radius, from, to) => {
    const start = polar(cx, cy, radius, from)
    const end = polar(cx, cy, radius, to)
    const largeArc = to - from > 180 ? 1 : 0
    return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`
  }

  export default {
    name: 'mo-speed-gauge',
    props: {
      speed: {
        type: Number,
        default: 0
      },
      /**
       * Largest value the dial currently represents. It expands automatically
       * when the speed exceeds it.
       */
      max: {
        type: Number,
        default: 10 * 1024 * 1024
      },
      accent: {
        type: String,
        default: 'var(--mo-primary)'
      }
    },
    data () {
      return {
        hubX: HUB_X,
        hubY: HUB_Y,
        viewBox: VIEW_BOX,
        arcRadius: ARC_RADIUS,
        strokeWidth: 4.2,
        tipY: NEEDLE_TIP_Y,
        internalMax: this.max,
        gradientId: `mo-gauge-gradient-${uid++}`
      }
    },
    computed: {
      currentSpeed () {
        return Number(this.speed) || 0
      },
      ratio () {
        // A square root scale keeps low speeds readable, otherwise anything
        // under a few megabytes per second collapses into the first ticks.
        const value = Math.sqrt(Math.min(this.currentSpeed, this.internalMax))
        const ceiling = Math.sqrt(this.internalMax)
        return ceiling > 0 ? Math.min(1, value / ceiling) : 0
      },
      needleAngle () {
        return START_ANGLE + SWEEP * this.ratio
      },
      needleStyle () {
        return {
          transform: `rotate(${this.needleAngle}deg)`,
          transformOrigin: `${HUB_X}px ${HUB_Y}px`
        }
      },
      needleColor () {
        return this.currentSpeed > 0 ? this.accent : 'var(--mo-text-secondary)'
      },
      startColor () {
        return 'var(--mo-accent-cyan)'
      },
      endColor () {
        return this.accent
      },
      trackPath () {
        return arcPath(HUB_X, HUB_Y, ARC_RADIUS, START_ANGLE, END_ANGLE)
      },
      /* The progress arc is the track revealed by a dash offset, which animates
         reliably instead of transitioning the `d` attribute. */
      arcLength () {
        return (Math.PI * 2 * ARC_RADIUS * SWEEP) / 360
      },
      progressStyle () {
        return {
          strokeDasharray: this.arcLength.toFixed(2),
          strokeDashoffset: (this.arcLength * (1 - this.ratio)).toFixed(2)
        }
      },
      ticks () {
        const result = []
        for (let index = 0; index <= 20; index += 1) {
          const angle = START_ANGLE + (SWEEP / 20) * index
          const level = index % 5 === 0 ? 'major' : (index % 2 === 0 ? 'medium' : 'minor')
          const outer = polar(HUB_X, HUB_Y, TICK_RADIUS, angle)
          const innerRadius = level === 'major' ? 35 : (level === 'medium' ? 37 : 38.5)
          const inner = polar(HUB_X, HUB_Y, innerRadius, angle)
          result.push({
            angle,
            level,
            x1: outer.x.toFixed(2),
            y1: outer.y.toFixed(2),
            x2: inner.x.toFixed(2),
            y2: inner.y.toFixed(2)
          })
        }
        return result
      },
      /**
       * `bytesToSize` scales by 1024 but names the units MB, so the caption
       * matches the number the rest of the app shows.
       */
      scaleLabel () {
        return bytesToSize(this.internalMax, 0)
      },
      valueText () {
        return bytesToSize(this.currentSpeed, 1).split(' ')[0]
      }
    },
    watch: {
      max (value) {
        this.internalMax = value
      },
      currentSpeed (value) {
        if (value > this.internalMax) {
          this.internalMax = value * 1.15
        }
      }
    }
  }
</script>

<style lang="scss">
.mo-speed-gauge {
  position: relative;
  width: 100%;
  max-width: 236px;
  /* The dial keeps its natural square shape, the readout lives in the extra
     strip underneath it. */
  aspect-ratio: 200 / 190;
  margin: 0 auto;

  .gauge-svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* The dial is drawn in text colours, not in the glass border colour: a
     translucent white hairline is invisible on a translucent white card. */
  .tick-major {
    stroke: var(--mo-text-secondary);
    stroke-width: 1.5;
    stroke-linecap: round;
  }

  .tick-medium {
    stroke: var(--mo-text-secondary);
    stroke-width: 1.1;
    stroke-linecap: round;
    opacity: 0.7;
  }

  .tick-minor {
    stroke: var(--mo-text-secondary);
    stroke-width: 0.8;
    stroke-linecap: round;
    opacity: 0.45;
  }

  .gauge-track {
    fill: none;
    stroke: var(--mo-text-secondary);
    stroke-linecap: round;
    opacity: 0.28;
  }

  .gauge-progress {
    fill: none;
    stroke-linecap: round;
    transition: stroke-dashoffset $mo-duration-base $mo-ease-emphasized;
    filter: drop-shadow(0 0 4px rgba(var(--mo-primary-rgb), 0.45));
  }

  .gauge-needle {
    transition: transform $mo-duration-slow $mo-ease-emphasized;
  }

  .needle-core {
    fill: var(--mo-glass-overlay-background);
  }

  .gauge-readout {
    pointer-events: none;
    font-variant-numeric: tabular-nums;
  }

  .gauge-value {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.4px;
    fill: var(--mo-text-primary);
    transition: fill $mo-duration-base $mo-ease-standard;
  }

  .gauge-unit {
    font-size: 6.4px;
    letter-spacing: 1.3px;
    text-transform: uppercase;
    fill: var(--mo-text-secondary);
    opacity: 0.75;
  }

  .gauge-scale {
    font-size: 6px;
    fill: var(--mo-text-secondary);
    opacity: 0.55;
  }

  &.idle .gauge-value {
    fill: var(--mo-text-secondary);
    opacity: 0.75;
  }
}
</style>
