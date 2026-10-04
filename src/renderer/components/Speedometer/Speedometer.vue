<template>
  <div
    class="mo-speedometer"
    :class="[{ stopped: stat.numActive === 0 }, gearClass, burstClass]"
  >
    <div
      class="mode"
      @click="toggleEngineMode"
    >
      <i :class="{ live: stat.numActive > 0, fast: hasFlow }">
        <mo-icon name="speedometer" width="24" height="24" />
      </i>
      <!-- Fixed-width centred slot: Super / High / Low all share ONE
           horizontal centre, so the label never sidesteps when the gear
           changes (it used to be left-aligned at the icon: word widths
           differ, so the centre hopped a few px per switch). in-out
           transition: the new name appears the moment the switch happens,
           the old one fades in place behind it. -->
      <span class="mode-label">
        <transition name="gear-flip-sm">
          <em :key="engineMode">{{ engineMode }}</em>
        </transition>
      </span>
    </div>
    <div class="value" v-if="stat.numActive > 0">
      <em>
        <mo-icon name="arrow-up" width="10" height="10" />
        <mo-animated-number :value="Number(stat.uploadSpeed) || 0" :formatter="formatSpeed" />
      </em>
      <span>
        <mo-icon name="arrow-down" width="10" height="10" />
        <mo-animated-number :value="Number(stat.downloadSpeed) || 0" :formatter="formatSpeed" />
      </span>
    </div>
  </div>
</template>

<script>
  import { mapState, mapGetters, mapActions } from 'vuex'
  import { bytesToSize } from '@shared/utils'
  import AnimatedNumber from '@/components/Dashboard/AnimatedNumber'
  import '@/components/Icons/speedometer'
  import '@/components/Icons/arrow-up'
  import '@/components/Icons/arrow-down'

  export default {
    name: 'mo-speedometer',
    components: {
      [AnimatedNumber.name]: AnimatedNumber
    },
    data () {
      return {
        /* Local mirror of the store's ignition signal, cleared after the
           burst animations have had their run. */
        burst: null,
        burstTimer: null
      }
    },
    computed: {
      ...mapState('app', [
        'stat'
      ]),
      ...mapState('preference', [
        'gearBurst'
      ]),
      ...mapGetters('preference', [
        'engineMode'
      ]),
      /* Only the three known gears get a colour class; a custom limit
         keeps the default icon tint. */
      gearClass () {
        const known = ['Super', 'High', 'Low']
        return known.indexOf(this.engineMode) >= 0
          ? `gear-${this.engineMode}`
          : ''
      },
      burstClass () {
        return this.burst === 'Super' || this.burst === 'High'
          ? `burst-${this.burst}`
          : ''
      },
      /* Real bytes on the wire: the thrust/sheen speed feel runs only while
         data actually moves, not while a task merely sits active at 0 KB/s. */
      hasFlow () {
        return Number(this.stat.downloadSpeed) > 0 ||
          Number(this.stat.uploadSpeed) > 0
      }
    },
    watch: {
      gearBurst (val) {
        if (!val || !val.gear) {
          return
        }
        this.burst = val.gear
        clearTimeout(this.burstTimer)
        this.burstTimer = setTimeout(() => {
          this.burst = null
          this.burstTimer = null
        }, 900)
      }
    },
    filters: {
      bytesToSize
    },
    methods: {
      ...mapActions('preference', [
        'toggleEngineMode'
      ]),
      formatSpeed (value) {
        return `${bytesToSize(value, 1)}/s`
      }
    },
    destroyed () {
      clearTimeout(this.burstTimer)
      this.burstTimer = null
    }
  }
</script>

<style lang="scss">
  /* Label flip for the speedometer only, in-out to match the card: the new
     name enters immediately, the old one only fades. The plain .gear-flip
     translate would also replace this em's resting transform (scale(.5)
     around a width:0 box) and flash the label at full 2x size before
     matrix-interpolating back around its left edge — a sideways swim on
     every switch. scale(.5) stays pinned at both ends, so the label only
     ever travels vertically. */
  .gear-flip-sm-enter-active {
    transition: transform $mo-duration-base $mo-ease-emphasized,
      opacity $mo-duration-base $mo-ease-standard;
  }

  /* Same contract as the card: zero transition, and invisible from the
     frame Vue tags it, so the old word never shows under the new one. */
  .gear-flip-sm-leave-active {
    transition: none;
  }

  .gear-flip-sm-leave {
    opacity: 0;
  }

  /* Visible from frame one (0.35), so the swap never flashes empty. */
  .gear-flip-sm-enter {
    transform: translateY(7px) scale(0.5);
    opacity: 0.35;
  }

  /* Both resting ends spelled out so the interpolator only ever sees
     translateY+scale lists — never a matrix rebuild around x=0. */
  .gear-flip-sm-enter-to,
  .gear-flip-sm-leave-from {
    transform: translateY(0) scale(0.5);
  }

  .gear-flip-sm-leave-to {
    opacity: 0;
  }

  .mo-speedometer {
    font-size: 12px;
    position: relative;
    display: inline-block;
    box-sizing: border-box;
    width: 168px;
    height: 44px;
    padding: 6px 12px 6px 50px;
    border-radius: $mo-radius-pill;
    /* Only the width animates: the floating orb sits over the page content, and
       moving it under the cursor draws the eye away from the download itself. */
    transition: width $mo-duration-base $mo-ease-emphasized,
      background-color $mo-duration-fast $mo-ease-standard,
      border-color $mo-duration-fast $mo-ease-standard,
      box-shadow $mo-duration-fast $mo-ease-standard;
    border: 1px solid $--speedometer-border-color;
    background: $--speedometer-background;
    backdrop-filter: blur($mo-blur-md) saturate(var(--mo-glass-saturate));
    -webkit-backdrop-filter: blur($mo-blur-md) saturate(var(--mo-glass-saturate));
    box-shadow: var(--mo-glass-shadow);

    &:hover {
      border-color: $--speedometer-hover-border-color;
      box-shadow: var(--mo-glass-shadow-hover);
    }

    &:active {
      transform: scale(0.99);
    }

    &.stopped {
      width: 48px;
      height: 48px;
      padding: 0;

      .mode {
        top: 0;
        left: 0;
      }

      .mode i {
        color: $--speedometer-stopped-color;
        width: 46px;
        height: 46px;
        padding: 11px;
      }

      .mode em {
        display: none;
      }

      /* The label slot must not occupy width in the 48px collapsed ball:
         icon + slot would overflow and wrap the slot to a second line.
         (The em above is already hidden — the slot itself needs it too.) */
      .mode-label {
        display: none;
      }
    }

    em {
      font-style: normal;
    }

    .mode {
      font-size: 0;
      position: absolute;
      top: 7px;
      left: 7px;
      cursor: pointer;
      transition: $mo-transition-base;
    }

    .mode i {
      font-size: 20px;
      font-style: normal;
      line-height: 28px;
      display: inline-block;
      box-sizing: border-box;
      position: relative;
      /* No overflow clip: the burst halo lives on ::before and its outer
         shadow must spread past the icon (a child's overflowing shadow is
         clipped by the parent's overflow:hidden — the ring would vanish).
         Nothing else here needed the clip: the sheen stays inside its
         ::after box and the glyph fits its padding at every burst scale. */
      width: 28px;
      height: 28px;
      padding: 2px;
      text-align: center;
      vertical-align: top;
      border-radius: $mo-radius-pill;
      color: $--speedometer-primary-color;
      transition: $mo-transition-base;
      /* Own compositing layer from the start: a transform animation would
         otherwise promote/demote the icon at each burst boundary, and that
         layer migration re-snaps sub-pixel coordinates — the visible
         "slides out then slides back" hitch. Permanent layer = the burst
         scale runs entirely on the compositor with zero remapping.
         Origin sits on the glyph's ink centroid (canvas-measured: 1.06px
         above centre), so the icon grows in place instead of arcing around
         the frame centre. */
      transform: translateZ(0);
      transform-origin: 50% calc(50% - 1.06px);

      /* Halo host: empty at rest, carries mo-speedo-halo during a burst.
         ::after is taken by the Super flow streak, so the ring lives here. */
      &::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        pointer-events: none;
      }

      /* A soft halo while something is actually downloading. The pulse only
         breathes the shadow ring (see mo-pulse-ring); the icon itself stays
         still, and --mo-pulse-rgb tints the halo per gear. */
      &.live {
        --mo-pulse-rgb: var(--mo-primary-rgb);
        background-color: rgba(var(--mo-primary-rgb), 0.14);
        box-shadow: 0 0 0 0 rgba(var(--mo-primary-rgb), 0.35);
        animation: mo-pulse-ring 2.4s $mo-ease-standard infinite;
      }
    }

    /* Gear colours follow the active limiter gear. High simply keeps the
       default primary halo; Super burns red and gains the speed feel
       while downloading (thrust jitter + a sheen sweeping across). */
    &.gear-Super .mode i {
      color: var(--mo-gear-super);
    }

    &.gear-High .mode i {
      color: var(--mo-gear-high);
    }

    &.gear-Low .mode i {
      color: var(--mo-gear-low);
    }

    &.gear-Super .mode i.live {
      --mo-pulse-rgb: var(--mo-gear-super-rgb);
      background-color: rgba(var(--mo-gear-super-rgb), 0.16);
      box-shadow: 0 0 0 0 rgba(var(--mo-gear-super-rgb), 0.42);
    }

    /* Red tint stays on while Super is armed; the thrust pitch and the sheen
       sweep only join once bytes are actually flowing (.fast). */
    &.gear-Super .mode i.fast {
      svg {
        animation: mo-gear-thrust 0.9s $mo-ease-standard infinite;
      }

      &::after {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        bottom: 0;
        border-radius: inherit;
        pointer-events: none;
        background: linear-gradient(
          100deg,
          transparent 32%,
          rgba(255, 255, 255, 0.55) 50%,
          transparent 68%
        );
        background-size: 250% 100%;
        animation: mo-gear-sheen 1.2s linear infinite;
      }
    }

    &.gear-Low .mode i.live {
      --mo-pulse-rgb: var(--mo-gear-low-rgb);
      background-color: rgba(var(--mo-gear-low-rgb), 0.14);
      box-shadow: 0 0 0 0 rgba(var(--mo-gear-low-rgb), 0.35);
    }

    /* Shared centre for all three gear names. The em keeps a real width
       now (the old width:0 overflow hack left-aligned every word at the
       icon, so the centre hopped with the word length); a fixed-width
       slot anchors all three to one point — and with a real width,
       scale(.5) pivots on the word's own centre instead of its left edge.
       GRID, not flex: during the in-out overlap both labels are children,
       and flex would lay them side by side — the outgoing word got shoved
       left while the incoming one overflowed right (a visible split for
       ~130ms on every switch). One grid cell stacks them instead. */
    .mode-label {
      display: inline-grid;
      place-items: center;
      width: 22px;
      margin-left: 4px;
      vertical-align: top;
      /* Pin the column: a lone grid item sizes the track to its own text,
         so the centre would ride the word length again (spread measured
         6.2px before this line). Fixed track = fixed centre for all three. */
      grid-template-columns: 22px;

      > * {
        grid-area: 1 / 1;
      }
    }

    .mode em {
      display: inline-block;
      height: 8px;
      font-size: 16px;
      line-height: 15px;
      transform: scale(.5);
      vertical-align: top;
      color: $--speedometer-primary-color;
    }

    .mode.mode-auto em {
      color: $--speedometer-text-color;
    }

    .mode.mode-max em {
      color: $--speedometer-primary-color;
    }

    .value {
      font-size: 0;
      overflow: hidden;
      width: 100%;
      text-align: right;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    /* Child combinator only: a descendant `.value span` also matched the
       mo-animated-number root span *inside* each row, turning it into a
       block and stacking icon / number on two lines — 60px of content in a
       44px pill pushed the download row outside the capsule. */
    .value > em,
    .value > span {
      display: block;
      font-size: 12px;
      line-height: 15px;
      font-variant-numeric: tabular-nums;

      svg {
        margin-right: 3px;
        vertical-align: -1px;
      }
    }

    .value em {
      color: $--speedometer-text-color;
    }

    .value span {
      color: $--speedometer-primary-color;
    }

    .no-active {
      font-size: 14px;
      line-height: 28px;
      color: $--speedometer-primary-color;
    }

    /* Ignition burst (Super full show / High halo only). The resting live
       pulse sits on `.mode i.live`; these rules come later in the bundle so
       they win for the sub-second the burst lasts, then hand back. */
    &.burst-Super {
      --burst-rgb: var(--mo-gear-super-rgb);
    }

    &.burst-High {
      --burst-rgb: var(--mo-gear-high-rgb);
    }

    &.burst-Super .mode i,
    &.burst-High .mode i {
      /* Transform only on the body: pure compositor animation, the glyph
         texture is never re-rasterised (see mo-speedo-burst). The halo is
         split onto ::before so its paint churn cannot drag the icon into
         a main-thread re-raster — that re-raster was the 1px slide. */
      animation: mo-speedo-burst 0.85s $mo-ease-standard;

      &::before {
        animation: mo-speedo-halo 0.85s $mo-ease-standard;
      }
    }

    &.burst-Super .mode em,
    &.burst-High .mode em {
      animation: mo-speedo-text 0.8s $mo-ease-emphasized;
    }
  }
</style>
